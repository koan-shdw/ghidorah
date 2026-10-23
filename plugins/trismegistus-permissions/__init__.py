"""Project modes use Hermes's existing fail-closed human approval transport."""
import hashlib
import json
import os
from pathlib import Path
import re

READS = {'link_app_chat','image_options','document_tools','list_chat_files','save_chat_output','search_web','read_web_page','query_chat_history','read_chat_history','list_apps', 'goal_status', 'read_file', 'search_files', 'session_search', 'todo_list', 'clarify', 'connected_tools', 'tool_search', 'tool_describe', 'skills_list', 'skill_view', 'parallel_work', 'inspect_action'}
EDITS = {'write_file', 'patch', 'edit_file'}
PROTECTED = ('.claude', '.codex', 'mcp-tokens', 'state-snapshots', 'auth.json', 'browser-profile',
             'cmdkey', 'credread', 'credentialmanager', 'credential_manager',
             'find-generic-password', 'windows_credentials', 'trismegistus-policy.json',
             'signal-cli', '.env', 'config.yaml', 'trismegistus-permissions')


def secrets_mention(serialized, root):
    # The data folder counts when its path ends there or goes on into it; a sibling whose name starts the same
    # (Trismegistus2, Trismegistus-old) is the user's own folder.
    root = root.lower().replace('\\', '/').rstrip('/')
    return re.search(re.escape(root) + r'(?![^/"\'`\s;&|<>),\]}])', serialized) is not None


def decide(tool_name, args, policy, *, inspection=False):
    if tool_name == 'session_search' and args.get('profile') and args['profile'] != policy.get('profile'):
        return {'action':'block','message':"Session search is limited to this project's history."}
    # Main owns the mandatory, action-bound cross-chat approvals in every mode.
    if tool_name in {'search_chats', 'read_other_chat', 'send_chat_message'}:
        return None
    process_read = tool_name == 'process_manage' and args.get('action') in {'list','poll','log','wait'} or tool_name == 'background_process' and args.get('action') == 'list'
    register_only = (tool_name == 'create_app' and args.get('register_only') is True and 'repositories' not in args and 'icon_path' not in args
                     or tool_name == 'update_app' and 'icon_path' not in args)
    if not policy.get('folder') and not register_only and not process_read and tool_name not in {'image_options','search_web','read_web_page','query_chat_history','read_chat_history','document_tools','list_chat_files','list_apps','add_app_todo','update_app_todo','link_app_chat','goal_status','memory','session_search','todo_list','clarify','connected_tools','tool_search','tool_describe','skills_list','skill_view','parallel_work','inspect_action'}:
        return {'action':'block','message':'Choose a working folder in the project before using file or command tools.'}
    # Preview pages (FEATURE-SPECS 4), like Claude Code's artifacts: reading needs no question, nor does publishing a
    # page only the user can open; plan mode changes nothing; deleting always asks, except in Bypass.
    if tool_name == 'preview_page':
        action, page_mode = args.get('action'), policy.get('mode')
        if action in ('list', 'read', 'guide') or page_mode == 'bypass' or action == 'publish' and page_mode != 'plan':
            return None
        if page_mode == 'plan':
            return {'action':'block','message':'Plan mode permits inspection and proposals only.'}
        return {'action':'approve','message':'Delete a preview page: '+str(args.get('link') or ''),
                'rule_key':'action:'+hashlib.sha256(json.dumps([tool_name,args],sort_keys=True).encode()).hexdigest()}
    # These tools enforce skill-name and relative-file boundaries themselves.
    # A skill's reference named config.yaml is not the app's private configuration.
    if tool_name in {'skills_list', 'skill_view'}:
        return None
    mode = policy['mode']
    if mode not in ('manual','accept-edits','plan','auto','bypass'):
        return {'action':'block','message':'Unknown project permission mode.'}
    if mode == 'bypass':
        return None
    # File contents are data, not credential access (e.g. process.env in a test).
    inspected = args
    if tool_name in EDITS or tool_name == 'read_file':
        paths = [args[key] for key in ('path','file_path') if args.get(key)]
        if tool_name == 'patch' and args.get('mode') == 'patch':
            from tools.patch_parser import parse_v4a_patch
            operations, error = parse_v4a_patch(args.get('patch') or '')
            if error:
                return {'action':'block','message':error}
            paths = [p for op in operations for p in (op.file_path,op.new_path) if p]
        inspected = [str((Path(policy['folder']) / p).resolve()) for p in paths]
    serialized = json.dumps(inspected, ensure_ascii=False).lower().replace('\\\\', '/')
    if any(word in serialized for word in PROTECTED) or secrets_mention(serialized, policy['secrets_root']):
        return {'action':'approve', 'message':'Access to private app data or credentials requires your approval. Use skills_list and skill_view for installed skills.',
                'rule_key':'secret:'+hashlib.sha256(serialized.encode()).hexdigest()}
    if tool_name in READS or process_read:
        return None
    if tool_name == 'memory' and args.get('action') in ('read','view','list'):
        return None
    if mode == 'plan':
        if tool_name == 'terminal' and inspection:
            return None
        return {'action':'block','message':'Plan mode permits inspection and proposals only.'}
    inside = False
    if tool_name in EDITS or tool_name in {'generate_image','copy_chat_file','render_document','recalculate_spreadsheet'}:
        root=Path(policy['folder']).resolve()
        target=Path(args.get('destination') or args.get('path') or args.get('file_path') or '')
        target=(root / target).resolve() if not target.is_absolute() else target.resolve()
        inside=target.is_relative_to(root)
    # App metadata stays in the store; new development folders stay inside the working folder.
    inside = inside or tool_name in {'create_app', 'update_app', 'add_app_todo','update_app_todo', 'link_app_chat'}
    if inside and mode in ('accept-edits','auto'):
        return None
    if mode == 'auto':
        from tools.approval_smart import _smart_approve
        verdict=_smart_approve(json.dumps({'tool':tool_name,'arguments':args}), 'Project action')
        if verdict == 'approve':
            return None
        if verdict == 'deny':
            return {'action':'block','message':'Auto declined this action.'}
    digest=hashlib.sha256(json.dumps([tool_name,args],sort_keys=True).encode()).hexdigest()
    return {'action':'approve','message':f'{tool_name}: {json.dumps(args, ensure_ascii=False)}',
            'rule_key':'action:'+digest}


def before_tool(tool_name='', args=None, **_):
    from hermes_constants import get_hermes_home
    from .work import checked, refused
    try:
        from gateway.session_context import get_session_env, session_context_engaged
        # Standalone commands call handle_function_call directly in their own
        # supervised CLI worker. Desktop agent calls must pass the shared owner.
        if session_context_engaged() and get_session_env('HERMES_SESSION_SOURCE') == 'desktop' and not checked():
            refused()
            return {'action':'block','message':'The shared action guard did not run.'}
        policy=json.loads((get_hermes_home() / 'trismegistus-policy.json').read_text())
        from .inspection import prepared
        grant = prepared.get()
        inspection = tool_name == 'terminal' and grant is not None and args == grant[1]
        # Fixed credential rules see the submitted arguments, never our internal
        # environment/config switches. The exact rewritten call stays bound here.
        decision=decide(tool_name,grant[0] if inspection else args or {},policy,inspection=inspection)
        if decision and decision.get('action')=='block':
            refused()
        return decision
    except Exception:
        refused()
        return {'action':'block','message':'Project permission policy is unavailable.'}


def scrub(result=None, output=None, text=None, **_):
    from agent.redact import redact_registered_vault_values
    value=result if result is not None else output if output is not None else text
    return redact_registered_vault_values(value) if isinstance(value,str) else value


def execute(tool_name='', args=None, next_call=None, tool_call_id='', **_):
    # Hermes runs the mandatory pre-tool hook inside next_call, before invoking
    # any command guard. Denial/failed hooks never reach terminal execution.
    from .work import execute as coordinate
    def run(arguments):
        if tool_name == 'terminal':
            from hermes_constants import get_hermes_home
            from .inspection import prepare, prepared, commands
            from .work import refused
            from tools.approval_context import authorized_command
            token = None
            try:
                policy=json.loads((get_hermes_home() / 'trismegistus-policy.json').read_text())
                if policy.get('mode') == 'plan':
                    if not policy.get('folder'):
                        raise ValueError('Choose a working folder before using command tools.')
                    protected=decide(tool_name,arguments,policy,inspection=True)
                    if protected and protected.get('action') == 'approve' and any(words[0]=='git' for words,_ in commands(arguments.get('command'))):
                        raise ValueError('Use file tools to request access to protected files. Plan Git configuration inspection is unavailable for this path.')
                    rewritten=prepare(arguments,policy['folder'])
                    token=prepared.set((arguments,rewritten))
                    arguments=rewritten
            except Exception as error:
                refused()
                return json.dumps({'error':str(error)})
            try:
                with authorized_command((arguments or {}).get('command')):
                    return next_call(arguments)
            finally:
                if token is not None:
                    prepared.reset(token)
        return next_call(arguments)
    return coordinate(tool_name,args or {},run,tool_call_id=tool_call_id)


def register(ctx):
    from .work import register as register_work
    register_work(ctx)
    from .mcp import register as register_mcp
    register_mcp(ctx)
    from agent.redact import register_vault_redaction_value
    # Register only the one provider credential this slice receives.
    key=os.environ.get('DEEPSEEK_API_KEY')
    if key:
        register_vault_redaction_value(key)
    ctx.register_hook('pre_tool_call',before_tool)
    ctx.register_hook('transform_tool_result',scrub)
    ctx.register_hook('transform_terminal_output',scrub)
    ctx.register_middleware('tool_execution',execute)
