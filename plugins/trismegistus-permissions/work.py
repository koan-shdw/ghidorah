"""Shared action ownership through the authenticated desktop request path."""
import contextvars
import json
import os
from uuid import uuid4

_checked = contextvars.ContextVar('trismegistus_work_checked', default=False)
_refused = contextvars.ContextVar('trismegistus_work_refused', default=None)


def refused():
    """Record a trusted pre-execution refusal for this invocation."""
    # Hermes runs bounded hooks in a copied context on a helper thread. Share
    # this invocation's marker; rebinding a ContextVar there is not visible here.
    marker = _refused.get()
    if marker is not None:
        marker['refused'] = True


def exchange(operation, **values):
    from gateway.session_context import get_session_env, session_context_engaged
    if not session_context_engaged() or get_session_env('HERMES_SESSION_SOURCE') != 'desktop':
        return {'enabled': False}
    from tui_gateway import server_requests
    from tools.interrupt import is_interrupted
    sid = get_session_env('HERMES_UI_SESSION_ID')
    if not sid or operation != 'finish' and is_interrupted():
        raise RuntimeError('This work has stopped.')
    result = server_requests.send('trismegistus.work', sid, {'operation': operation, **values}, timeout=310)
    if result is None or result.get('error'):
        raise RuntimeError((result or {}).get('error') or 'Action coordination ended. Check any uncertain outcome before retrying.')
    return result


def _completion(lease, result, uncertain, refused=False):
    # Save the receipt before reporting it. A closed desktop must not erase a
    # completed tool result or make Hermes execute the tool a second time.
    from hermes_constants import get_hermes_home
    from gateway.session_context import get_session_env
    from uuid import UUID
    lease = str(UUID(lease))
    folder = get_hermes_home() / 'desktop' / 'work-results'
    folder.mkdir(parents=True, exist_ok=True)
    receipt = folder / (lease + '.json')
    temporary = folder / (lease + '.' + str(uuid4()) + '.tmp')
    payload = {'lease': lease, 'session_id': get_session_env('HERMES_UI_SESSION_ID'),
               'result': result, 'uncertain': uncertain, 'refused': refused}
    try:
        with temporary.open('x', encoding='utf-8') as stream:
            json.dump(payload, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, receipt)
    finally:
        temporary.unlink(missing_ok=True)
    exchange('finish', lease=lease, result=result, uncertain=uncertain, refused=refused)
    receipt.unlink(missing_ok=True)


def _process_scope(args):
    """Desktop process handles belong to a chat, including retained results."""
    from gateway.session_context import get_session_env, session_context_engaged
    if not session_context_engaged() or get_session_env('HERMES_SESSION_SOURCE') != 'desktop':
        return args, None
    from tools.approval_context import get_current_session_key
    from tools.process_registry import process_registry
    key = get_current_session_key(default='')
    if not key:
        raise RuntimeError('This chat has no process owner.')
    if args.get('action') == 'list':
        return args, key
    process = process_registry.get(args.get('session_id'))
    if process is None or process.session_key != key:
        # Do not reveal whether a guessed handle exists or who owns it.
        raise RuntimeError('Process unavailable in this chat. List this chat\'s processes first.')
    # Bind a unique prefix once, before dispatch; never resolve it again against
    # a registry that may have acquired another matching process meanwhile.
    return {**args, 'session_id': process.id}, key


def execute(name, args, run, *, tool_call_id=''):
    # Hermes may unwrap a deferred tool inside the already guarded invocation.
    # Its nested dispatch still runs the mandatory permission hooks; it belongs
    # to the outer action lease rather than waiting on that same lease again.
    coordinated_name, coordinated_args = name, args
    if name == 'tool_call':
        from tools.tool_search import resolve_underlying_call
        coordinated_name, coordinated_args, error = resolve_underlying_call(args)
        if error:
            return json.dumps({'error': error})
    process_scope = None
    if coordinated_name == 'process_manage':
        try:
            coordinated_args, process_scope = _process_scope(coordinated_args)
        except Exception as error:
            return json.dumps({'error': str(error)})
        if name == coordinated_name:
            args = coordinated_args

    def invoke():
        result = run(args)
        if process_scope and coordinated_args.get('action') == 'list':
            try:
                from tools.process_registry import process_registry
                body = json.loads(result) if isinstance(result, str) else result
                if not isinstance(body, dict) or not isinstance(body.get('processes'), list):
                    raise ValueError('Invalid process listing')
                body['processes'] = [row for row in body['processes']
                    if (process := process_registry.get(row.get('session_id'))) is not None
                    and process.session_key == process_scope]
                return json.dumps(body) if isinstance(result, str) else body
            except Exception:
                # A raised middleware error falls through in Hermes. Return an
                # error here so an unverifiable listing never reaches the model.
                return json.dumps({'error': 'This chat\'s process list could not be verified.'})
        return result

    # Nested deferred dispatch shares the action lease, but still checks process
    # ownership. A checked outer call is not permission to use a foreign handle.
    if _checked.get():
        return invoke()
    lease = None
    token = None
    refusal_token = None
    try:
        patch_paths = None
        if coordinated_name == 'patch' and coordinated_args.get('mode') == 'patch':
            from tools.patch_parser import parse_v4a_patch
            operations, error = parse_v4a_patch(coordinated_args.get('patch') or '')
            if error or not operations:
                return json.dumps({'error': error or 'Patch contains no file operations.'})
            patch_paths = list(dict.fromkeys(path for op in operations for path in [op.file_path, op.new_path] if path))
        response = exchange('begin', name=coordinated_name, arguments=coordinated_args, request_id=tool_call_id or str(uuid4()),
                            **({'patch_paths': patch_paths} if patch_paths is not None else {}))
        lease = response.get('lease')
        token = _checked.set(True)
        refusal_token = _refused.set({'refused': False})
    except Exception as error:
        # Middleware errors normally fall through in Hermes. A tool error without
        # next_call keeps a missing owner from authorizing an action.
        return json.dumps({'error': str(error)})
    try:
        try:
            result = invoke()
        except Exception as error:
            result = json.dumps({'error': str(error), 'uncertain': True})
            if lease:
                try:
                    _completion(lease, result, True)
                except Exception:
                    pass
            # Raising out of middleware lets Hermes fall through to execution.
            # This invocation already ran; its exception must not run it again.
            return result
        if lease:
            uncertain = False
            try:
                body = json.loads(result) if isinstance(result, str) else result
                uncertain = isinstance(body, dict) and bool(body.get('error') or body.get('isError'))
            except (ValueError, TypeError):
                pass
            try:
                _completion(lease, result, uncertain, _refused.get()['refused'])
            except Exception:
                # Keep the original result, including a failed tool's details.
                # The durable receipt is reconciled by the desktop after restart.
                pass
        return result
    finally:
        if refusal_token is not None:
            _refused.reset(refusal_token)
        if token is not None:
            _checked.reset(token)


def checked():
    return _checked.get()


def after_tool(status='', error_type='', **_):
    # The dispatcher emits this before entering the tool when approval expires
    # or is denied. A tool's own error text cannot establish non-execution.
    if status == 'blocked' and error_type == 'plugin_block':
        refused()


def register(ctx):
    ctx.register_hook('post_tool_call', after_tool)
    def inspect(args, **_):
        try:
            result = exchange('inspect', arguments=args)
            return json.dumps(result.get('value') if result.get('enabled') else {'error': 'Action inspection requires the desktop owner.'}, ensure_ascii=False)
        except Exception as error:
            return json.dumps({'error': str(error)})
    ctx.register_tool(name='inspect_action', toolset='trismegistus_mcp', description='Inspect affected resources before overlapping actions',
        schema={'name': 'inspect_action', 'description': 'Inspect the exact command, scripts/config and tool schema before overlapping an unfamiliar action. Record its exact tool name/arguments, findings and every affected file/directory or stable service/resource identity (including external writes). Local ports use kind port and value tcp:3000 or udp:3000, covering all interfaces. Read script/config files first and include their paths in evidence; they must still match when execution begins. Use observe only for a watcher/read designed to tolerate concurrent changes. Empty resources asserts no shared effects. If effects cannot be established, leave the action unscoped. This records your assessment; it does not execute or grant permission.',
                'parameters': {'type': 'object', 'properties': {'tool': {'type': 'string'}, 'arguments': {'type': 'object'}, 'summary': {'type': 'string'}, 'evidence': {'type': 'array', 'description': 'Exact paths of files read with Read/read_file in this turn. One path per entry; no annotations or comma-separated lists. Put explanations in summary and directories in resources.', 'items': {'type': 'string'}}, 'resources': {'type': 'array', 'items': {'type': 'object', 'properties': {'kind': {'type': 'string', 'enum': ['path', 'service', 'port']}, 'value': {'type': 'string'}, 'access': {'type': 'string', 'enum': ['read', 'write', 'observe']}}, 'required': ['kind', 'value', 'access'], 'additionalProperties': False}}}, 'required': ['tool', 'arguments', 'summary', 'evidence', 'resources'], 'additionalProperties': False}}, handler=inspect)
    def handle(args, **_):
        try:
            result = exchange('board', arguments=args)
            return json.dumps(result.get('value') if result.get('enabled') else {'error': 'This tool requires an active parallel job.'}, ensure_ascii=False)
        except Exception as error:
            return json.dumps({'error': str(error)})
    ctx.register_tool(name='parallel_work', toolset='trismegistus_mcp', description='Coordinate parallel work',
        schema={'name': 'parallel_work', 'description': 'Read group status before choosing work. Claim a distinct task or exact file/directory path, publish findings with note, and release ownership when another job may take over. This tool does not execute actions or grant permission.',
                'parameters': {'type': 'object', 'properties': {'operation': {'type': 'string', 'enum': ['status', 'claim', 'note', 'release']}, 'task': {'type': 'string'}, 'path': {'type': 'string'}, 'claim': {'type': 'string'}, 'text': {'type': 'string'}}, 'required': ['operation'], 'additionalProperties': False}}, handler=handle)
