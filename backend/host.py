"""Hidden Python entry point for the pinned fork; no user shell or token arguments."""
import json
import os
from pathlib import Path
import sys
from parent_lifetime import parent_guard

APP = Path(__file__).resolve().parents[1]
FORK = APP / 'runtime' / 'hermes'
if not FORK.is_dir():
    FORK = APP / 'hermes'
sys.path.insert(0, str(FORK))


# Names stored as Trismegistus/<name> in Credential Manager. Every value is also registered with the scrubber.
KEY_NAMES = ('deepseek', 'typesafe', 'alibaba', 'openrouter-api', 'minimax', 'minimax-cn', 'mistral', 'openai-api', 'gemini', 'gemini-voice-free', 'xai', 'kimi-coding', 'zai', 'fastino', 'notdiamond', 'telegram', 'remote-code')

def main():
    request = json.loads(sys.stdin.buffer.readline())
    import windows_credentials as vault
    target = request['credential_namespace']
    operation = request['operation']
    if operation in ('plugin_review', 'plugin_convert', 'skills_browse', 'skill_review', 'plugin_runtime_prepare', 'speech_model_install', 'speech_check', 'transcribe', 'voice_speech', 'voice_helper', 'wake_model_install', 'web_research', 'app_watch', 'workspace_git_action', 'document_render', 'document_preview', 'image_generate','chat_export'):
        parent_guard()
    codex_test=os.environ.get('TRISMEGISTUS_TEST_CODEX_URL')
    if codex_test:
        from urllib.parse import urlsplit
        parsed=urlsplit(codex_test)
        if not target.startswith('Trismegistus/Test/') or parsed.scheme!='http' or parsed.hostname!='127.0.0.1':
            raise RuntimeError('Invalid isolated test endpoint')
        os.environ['HERMES_CODEX_BASE_URL']=codex_test
        from hermes_cli.auth import PROVIDER_REGISTRY
        PROVIDER_REGISTRY['openai-codex'].inference_base_url=codex_test
        from hermes_cli import auth
        auth.DEFAULT_CODEX_BASE_URL=codex_test
        from agent import model_metadata
        model_metadata.CODEX_MODELS_CATALOG_URLS=(codex_test+'/models',)
    from provider_profiles import install as install_profiles
    install_profiles()
    from api_providers import test_endpoints
    test_endpoints(target)
    from grok_connection import test_endpoint
    test_endpoint(target)
    from minimax_connection import test_endpoint as minimax_test_endpoint
    minimax_test_endpoint(target)
    from nous_connection import test_endpoint as nous_test_endpoint
    nous_test_endpoint(target)
    if operation == 'chat_export':
        from chat_export import package
        print(json.dumps(package(request['staging'], request.get('contents', '.'))))
    elif operation in ('image_info', 'image_generate'):
        from images import information, generate
        print(json.dumps(information(target) if operation == 'image_info' else generate(request, target)))
    elif operation in ('document_info', 'document_render', 'document_preview'):
        from documents import information, render_request, preview
        try:
            value = information() if operation == 'document_info' else render_request(request) if operation == 'document_render' else preview(request['file'], request['name'], request.get('output') is True)
            print(json.dumps(value))
        except Exception as error:
            sys.exit(str(error))
    elif operation == 'web_research':
        from web_research import research
        print(json.dumps(research(request, target)))
    elif operation == 'api_status':
        from api_providers import status
        print(json.dumps(status(request['provider'], target, request.get('check', False))))
    elif operation == 'api_model':
        from api_providers import text_model, PROVIDERS
        provider = request['provider']
        if provider not in (*PROVIDERS, 'nous', 'xai-oauth', 'minimax-oauth', 'vertex'):
            raise ValueError('Unsupported supplier.')
        model = text_model(provider, dict(id=request['model'], name=request['model'], supportedGenerationMethods=['generateContent']))
        if not model:
            raise ValueError('Enter a supported chat model ID.')
        print(json.dumps(model))
    elif operation == 'model_prices':
        from api_providers import prices
        print(json.dumps(prices(request['models'], request.get('urls') or {})))
    elif operation == 'workspace_git_action':
        from workspace_git_actions import execute
        try:
            print(json.dumps(execute(request)))
        except (OSError, ValueError) as error:
            sys.exit(str(error))
    elif operation in ('workspace_changes', 'workspace_status'):
        from workspace_git import changes, status
        try:
            result = status(request['directory']) if operation == 'workspace_status' else changes(request['directory'], request.get('file'), request.get('staged', False))
            print(json.dumps(result))
        except ValueError as error:
            sys.exit(str(error))
    elif operation == 'worktree':
        from workspace_git import worktree
        try:
            print(json.dumps(worktree(request)))
        except (OSError, ValueError) as error:
            sys.exit(str(error))
    elif operation == 'review_context':
        from agent.review_engine import build_review_task, snapshot_recent_messages
        goal, context = build_review_task(snapshot_recent_messages(request.get('messages', [])), request['focus'])
        print(json.dumps({'goal': goal, 'context': context}))
    elif operation == 'attachment_prepare':
        from attachments import prepare
        try:
            print(json.dumps(prepare(request['file'], request['name'], output=request.get('output') is True, strict=request.get('strict') is True)))
        except Exception as error:
            sys.exit(str(error))
    elif operation == 'attachment_capabilities':
        from attachments import capabilities
        print(json.dumps(capabilities(request['models'])))
    elif operation == 'plugin_review':
        from plugin_packages import review_repository
        if target.startswith('Trismegistus/Test/') and request['repository'] == 'fixture/plugin':
            from plugin_packages import describe_plugin
            result = describe_plugin(Path(os.environ['HERMES_HOME']).parent / 'fixture-plugin', 'fixture/plugin', 'a' * 40)
        else:
            result = review_repository(os.environ['HERMES_HOME'], request['repository'], request.get('commit', ''))
        print(json.dumps(result))
    elif operation == 'plugin_convert':
        from plugin_conversion import convert_claude
        print(json.dumps(convert_claude(os.environ['HERMES_HOME'], request['source'], request['repository'], request['commit'])))
    elif operation == 'skills_browse':
        from plugin_conversion import skills_browse
        print(json.dumps(skills_browse(request.get('query', ''), request.get('page', 1))))
    elif operation == 'skill_review':
        from plugin_conversion import review_skill
        print(json.dumps(review_skill(os.environ['HERMES_HOME'], request['identifier'])))
    elif operation in ('plugin_configuration_save', 'plugin_configuration_values'):
        from security import install_codec
        install_codec(target + '/encryption')
        from plugin_setup import save_configuration, configuration_values, configuration_redactions
        if operation == 'plugin_configuration_save':
            print(json.dumps(save_configuration(os.environ['HERMES_HOME'], request['source'], request['values'], request.get('previous'))))
        else:
            configuration_values(os.environ['HERMES_HOME'], request['revisions'])
            print(json.dumps(configuration_redactions(os.environ['HERMES_HOME'], request['revisions'])))
    elif operation in ('plugin_runtime_prepare', 'plugin_runtime_check'):
        from plugin_setup import prepare_runtime, check_runtime
        if operation == 'plugin_runtime_prepare':
            print(json.dumps(prepare_runtime(os.environ['HERMES_HOME'], request['sources'], request.get('features', []))))
        else:
            check_runtime(os.environ['HERMES_HOME'], request.get('runtime'))
            print('{}')
    elif operation == 'plugin_dependencies_check':
        from plugin_setup import validate_plugins
        validate_plugins(request['plugins'])
        print('{}')
    elif operation == 'project_memory':
        from project_memory import project_memory
        print(json.dumps(project_memory(os.environ['HERMES_HOME'], request['profile'], request['name'], request.get('arguments', {}), request.get('review'))))
    elif operation == 'initialize':
        if vault.get(target + '/encryption') is None:
            vault.put(target + '/encryption', os.urandom(32))
        from security import migrate_plaintext
        migrate_plaintext(Path(os.environ['HERMES_HOME']),target)
        print(json.dumps({'connected': vault.get(target + '/deepseek') is not None}))
    elif operation == 'app_watch':
        from app_watch import watch
        print(json.dumps(watch(request, target)))
    elif operation == 'app_summary':
        from app_summary import summarize
        print(json.dumps(summarize(request, target)))
    elif operation == 'routing_summary':
        from routing_summary import summarize
        print(json.dumps(summarize(request, target)))
    elif operation == 'context_summary':
        from routing_summary import compact
        print(json.dumps(compact(request, target)))
    elif operation == 'model_discovery':
        from routing_summary import discover
        print(json.dumps(discover(request, target)))
    elif operation in ('wake_model_install', 'wake_model_check'):
        from wake_model import install, verified
        root = Path(os.environ['HERMES_HOME']).parent
        print(json.dumps({'directory': str(install(root) if operation == 'wake_model_install' else verified(root))}))
    elif operation in ('voice_helper', 'voice_speech'):
        from voice_helper import answer, speech
        print(json.dumps(answer(request, target) if operation == 'voice_helper' else speech(request, os.environ['HERMES_HOME'])))
    elif operation == 'routing_select':
        from routing_summary import select
        print(json.dumps(select(request, target)))
    elif operation == 'save_key':
        key = request['key'].strip()
        if not key or any(c.isspace() for c in key):
            raise ValueError('Enter a valid API key')
        provider = request.get('provider', 'deepseek')
        if provider not in KEY_NAMES:
            raise ValueError('Unsupported credential provider')
        if provider == 'alibaba':
            from alibaba_connection import encode
            value = encode(key, request.get('region', 'ap-southeast-1'), request.get('workspaceId', ''))
        else:
            value = key.encode()
        vault.put(target + '/' + provider, value)
        print('{}')
    elif operation == 'read_key':
        provider = request.get('provider', 'deepseek')
        if provider not in KEY_NAMES:
            raise ValueError('Unsupported credential provider')
        value = vault.get(target + '/' + provider)
        if provider == 'alibaba':
            from alibaba_connection import read
            value = read(value)[0].encode()
        print(json.dumps({'key': value.decode() if value else None}))
    elif operation == 'delete_key':
        provider = request.get('provider', 'deepseek')
        if provider not in KEY_NAMES:
            raise ValueError('Unsupported credential provider')
        vault.delete(target + '/' + provider)
        print('{}')
    elif operation in ('vertex_save', 'vertex_status', 'vertex_disconnect', 'vertex_redactions'):
        from security import install_codec
        install_codec(target + '/encryption')
        import vertex_connection as vertex
        root = Path(os.environ['HERMES_HOME'])
        if operation == 'vertex_save':
            vertex.save(root, request['file'], request['projectId'], request['region'])
            print('{}')
        elif operation == 'vertex_disconnect':
            vertex.disconnect(root)
            print('{}')
        elif operation == 'vertex_redactions':
            value = vertex.read(root) or {}
            print(json.dumps([v for k,v in value.get('info', {}).items() if k in ('private_key','refresh_token','client_secret')]))
        else:
            print(json.dumps(vertex.status(root, target, request.get('check', False))))
    elif operation in ('nous_login','nous_status','nous_disconnect','openrouter_login','codex_login','codex_status','codex_disconnect','grok_login','grok_status','grok_disconnect','minimax_login','minimax_status','minimax_disconnect'):
        from security import install_codec
        install_codec(target + '/encryption')
        if operation.startswith('nous_'):
            from nous_connection import login, status, disconnect
        elif operation == 'openrouter_login':
            from openrouter_connection import login
        elif operation.startswith('minimax_'):
            from minimax_connection import login, status, disconnect
        elif operation.startswith('grok_'):
            from grok_connection import login, status, disconnect
        else:
            from codex_connection import login, status, disconnect
        if operation.endswith('_disconnect'):
            disconnect()
            print('{}')
        elif operation.endswith('_status'):
            print(json.dumps(status(request.get('check',False))))
        else:
            parent_guard()
            def emit(value):
                print(json.dumps(value),flush=True)
            try:
                if operation == 'openrouter_login': login(emit, target)
                elif operation == 'minimax_login': login(emit, request.get('region','global'))
                elif operation == 'codex_login' and codex_test:
                    from hermes_cli import auth_codex
                    issuer = codex_test.split('/backend-api/')[0]
                    auth_codex.CODEX_OAUTH_TOKEN_URL = issuer + '/oauth/token'
                    login(emit, issuer)
                else: login(emit)
            except Exception as error:
                emit({'type':'error','message':str(error)})
    elif operation == 'serve':
        # The private control pipe is also the supervisor lease. Parent death closes it.
        parent_guard()
        from security import install_codec, migrate, provider_guard
        install_codec(target + '/encryption')
        migrate(Path(os.environ['HERMES_HOME']))
        from plugin_setup import check_runtime, install_secret_source
        runtime = check_runtime(os.environ['HERMES_HOME'], request.get('runtime'))
        if runtime:
            from tools.lazy_deps import _activate_target_on_syspath
            _activate_target_on_syspath(runtime)
        install_secret_source(os.environ['HERMES_HOME'], request.get('configurations', []))
        from tools.mcp_oauth import configure_token_storage_root
        configure_token_storage_root(Path(os.environ['HERMES_HOME']))
        import mcp_contract  # App wire contract; core transport stays unchanged.
        from provider_credentials import install as install_provider_credentials
        install_provider_credentials(Path(os.environ['HERMES_HOME']), target)
        from agent.process_bootstrap import set_provider_request_guard
        if request.get('provider_access'):
            from provider_access import install as install_provider_access
            install_provider_access(request['provider_access'], request['provider_urls'])
        else:
            set_provider_request_guard(provider_guard(list(request['provider_urls'].values())))
        from hermes_cli.plugins import discover_plugins, has_hook, get_plugin_manager, require_pre_tool_plugin
        require_pre_tool_plugin('trismegistus-permissions')
        discover_plugins()
        required = [p for p in get_plugin_manager().list_plugins()
                    if p['name'] == 'trismegistus-permissions' and p['enabled'] and not p['error'] and p['hooks'] >= 3]
        if not required or not has_hook('pre_tool_call'):
            raise RuntimeError('Required permissions plugin did not load')
        loaded = {plugin['key']: plugin for plugin in get_plugin_manager().list_plugins()}
        for key in request.get('plugins', []):
            plugin = loaded.get(key)
            if not plugin or not plugin['enabled'] or plugin['error']:
                raise RuntimeError('Reviewed plugin could not load: ' + (plugin['name'] + ': ' + str(plugin['error']) if plugin else key))
        from hermes_cli.main import main as hermes_main
        sys.argv = ['hermes', 'serve', '--host', '127.0.0.1', '--port', '0']
        hermes_main()
    elif operation == 'speech_model_install':
        # Dictation and the local voice (R4, 8): the chosen whisper model, pinned and hash-checked, on Install only.
        from speech_models import install
        print(json.dumps({'directory': install(Path(os.environ['HERMES_HOME']).parent, request['model'])}))
    elif operation in ('transcribe', 'speech_check'):
        # Dictation (R4): Hermes's own local transcription, with the runtime folder on the path as serve has it.
        from plugin_setup import check_runtime
        runtime = check_runtime(os.environ['HERMES_HOME'], request.get('runtime'))
        if runtime:
            from tools.lazy_deps import _activate_target_on_syspath
            _activate_target_on_syspath(runtime)
        import faster_whisper  # Fail closed if the reviewed runtime cannot import; never lazy-install.
        if operation == 'speech_check':
            import io
            import wave
            audio = io.BytesIO()
            with wave.open(audio, 'wb') as clip:
                clip.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
                clip.writeframes(b'\0\0' * 1600)
            audio.seek(0)
            from faster_whisper.audio import decode_audio
            if len(decode_audio(audio)) != 1600:
                raise ValueError('The local speech decoder check failed.')
            print('{}')
            return
        from speech_models import verified
        folder = verified(Path(os.environ['HERMES_HOME']).parent, request['model'])
        from tools import transcription_tools as transcription
        transcription._load_stt_config = lambda: {'local': {'device': 'cpu', 'compute_type': 'int8'}}
        result = transcription._transcribe_local(request['file'], str(folder), language='en')
        if not result.get('success'):
            sys.exit(str(result.get('error') or 'Transcription failed.')[:300])
        print(json.dumps({'text': result.get('transcript', '')}))
    elif operation == 'cron_next':
        # Routines (6e): the first time a cron line fires after a moment, in local time, read by the bundled
        # croniter. The app keeps the schedule; Hermes's own cron is not used.
        from datetime import datetime
        from croniter import croniter
        line = ' '.join(str(request.get('line', '')).split())
        if len(line) > 120 or len(line.split(' ')) != 5:
            sys.exit('A cron line has five fields: minute, hour, day of month, month, day of week.')
        try:
            after = datetime.fromtimestamp(float(request['after']) / 1000)
            print(json.dumps({'next': int(croniter(line, after).get_next(datetime).timestamp() * 1000)}))
        except (ValueError, KeyError, TypeError, OverflowError) as error:
            sys.exit('That cron line cannot be read: ' + str(error)[:200])
    elif operation == 'gateway':
        # Remote (6a): the app's own Telegram gateway, a hidden child of main in its own Hermes home
        # (hermes-gateway), sharing no sessions, memory or model keys with the serving backend. Same parent-death
        # lease as serve: main's end of stdin closing ends this process tree.
        parent_guard()
        from plugin_setup import check_runtime
        runtime = check_runtime(os.environ['HERMES_HOME'], request.get('runtime'))
        if runtime:
            from tools.lazy_deps import _activate_target_on_syspath
            _activate_target_on_syspath(runtime)
        owner = str(request['owner'])
        import gate_channel
        gate_channel.configure(request['channel']['url'], request['channel']['token'], owner)
        token = vault.get(target + '/telegram')
        if not token:
            raise ValueError('Add the Telegram bot token in Settings, Remote.')
        # The token reaches Hermes in this process only, never on a command line.
        os.environ['TELEGRAM_BOT_TOKEN'] = token.decode()
        os.environ['TELEGRAM_ALLOWED_USERS'] = owner
        import gateway.run_inbound as inbound
        if not hasattr(inbound, 'APP_OWNED_INBOUND'):
            raise RuntimeError('This Hermes build cannot keep the gateway from running its own agent')
        inbound.APP_OWNED_INBOUND = True
        from hermes_cli.plugins import discover_plugins, get_plugin_manager
        discover_plugins()
        if not any(p['name'] == 'trismegistus-gate' and p['enabled'] and not p['error'] for p in get_plugin_manager().list_plugins()):
            raise RuntimeError('The Remote gate did not load')
        from hermes_cli.main import main as hermes_main
        sys.argv = ['hermes', 'gateway', 'run', '--replace']
        hermes_main()
    else:
        raise ValueError('Unsupported host operation')


if __name__ == '__main__':
    main()
