import importlib.util
import json
from pathlib import Path
import sys
import uuid
import pytest

APP=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(APP/'backend'))

@pytest.mark.windows_only
def test_codex_device_grant_stays_encrypted_in_root_and_shared_across_profiles(tmp_path,monkeypatch):
    import windows_credentials as vault
    from security import install_codec
    from codex_connection import login, disconnect, status
    from hermes_cli import auth,auth_codex,credential_codec
    from hermes_constants import set_hermes_home_override,reset_hermes_home_override
    from agent.redact import redact_registered_vault_values
    namespace='Trismegistus/Test/'+str(uuid.uuid4())
    monkeypatch.setenv('HERMES_HOME',str(tmp_path))
    monkeypatch.setattr(credential_codec,'_seal',None);monkeypatch.setattr(credential_codec,'_open',None)
    monkeypatch.setattr(auth_codex,'_codex_request_device_code',lambda *args:{'user_code':'USER-CODE','device_auth_id':'private-device-id','interval':3})
    monkeypatch.setattr(auth_codex,'_codex_poll_authorization_code',lambda *args,**kwargs:{'authorization_code':'private-code','code_verifier':'private-verifier'})
    monkeypatch.setattr(auth_codex,'_codex_exchange_authorization_code',lambda *args:{'access_token':'synthetic-codex-access','refresh_token':'synthetic-codex-refresh'})
    vault.put(namespace,b'x'*32)
    try:
        install_codec(namespace);events=[];login(events.append)
        assert [event['type'] for event in events]==['device','connected']
        assert 'private-device-id' not in json.dumps(events)
        assert 'synthetic-codex' not in (tmp_path/'auth.json').read_text()
        assert redact_registered_vault_values('synthetic-codex-access')!='synthetic-codex-access'
        profiles=[tmp_path/'profiles'/('p-'+str(uuid.uuid4())) for _ in range(2)]
        for profile in [*profiles,profiles[0]]:
            profile.mkdir(parents=True,exist_ok=True)
            context=set_hermes_home_override(str(profile))
            try:assert auth.resolve_codex_runtime_credentials(read_only=True)['api_key']=='synthetic-codex-access'
            finally:reset_hermes_home_override(context)
            assert not (profile/'auth.json').exists()
        # A legacy per-chat grant and independent pool entry must not revive A.
        context=set_hermes_home_override(str(profiles[0]))
        try:
            auth._save_auth_store({'providers':{'openai-codex':{'tokens':{'access_token':'old-profile','refresh_token':'old-refresh'}},'other':{'keep':True}},'credential_pool':{'openai-codex':[{'id':'old-pool','access_token':'old-pool-token'}],'other':[{'id':'keep'}]}})
        finally:reset_hermes_home_override(context)
        external=tmp_path.parent/(tmp_path.name+'-external-auth.json');external.write_text('external account stays')
        disconnect();disconnect()
        for profile in [tmp_path,*profiles]:
            context=set_hermes_home_override(str(profile))
            try:assert not status()['connected']
            finally:reset_hermes_home_override(context)
        context=set_hermes_home_override(str(profiles[0]))
        try:
            saved=auth._load_auth_store();assert saved['providers']['other']=={'keep':True};assert saved['credential_pool']['other']==[{'id':'keep'}]
        finally:reset_hermes_home_override(context)
        assert external.read_text()=='external account stays'
        monkeypatch.setattr(auth_codex,'_codex_exchange_authorization_code',lambda *args:{'access_token':'synthetic-account-b','refresh_token':'synthetic-refresh-b'})
        login(events.append)
        for profile in [tmp_path,*profiles]:
            context=set_hermes_home_override(str(profile))
            try:assert auth.resolve_codex_runtime_credentials(read_only=True)['api_key']=='synthetic-account-b'
            finally:reset_hermes_home_override(context)
    finally:vault.delete(namespace)

@pytest.mark.windows_only
def test_provider_vault_is_available_only_to_provider_resolution(tmp_path,monkeypatch):
    import windows_credentials as vault
    from provider_credentials import install
    from hermes_cli import auth
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from agent.secret_scope import build_profile_secret_scope, set_secret_scope, reset_secret_scope
    from hermes_cli.env_loader import secret_source_names
    from tools.mcp_tool_config import _build_safe_env
    name='Trismegistus/Test/'+str(uuid.uuid4())
    key='synthetic-profile-credential'
    monkeypatch.setattr(auth,'_host_provider_key_resolver',None)
    monkeypatch.delenv('DEEPSEEK_API_KEY',raising=False)
    vault.put(name+'/deepseek',key.encode())
    install(tmp_path,name)
    homes=[tmp_path/'profiles'/('p-'+str(uuid.uuid4())) for _ in range(2)]
    try:
        for home in [*homes,homes[0]]:
            home.mkdir(parents=True,exist_ok=True)
            token=set_hermes_home_override(str(home))
            scope=set_secret_scope(build_profile_secret_scope(home),profile_home=str(home))
            try:
                assert auth.resolve_api_key_provider_credentials('deepseek')['api_key']==key
                assert 'DEEPSEEK_API_KEY' not in secret_source_names()
                assert 'DEEPSEEK_API_KEY' not in build_profile_secret_scope(home)
                assert 'DEEPSEEK_API_KEY' not in _build_safe_env({})
                assert not (home/'.env').exists()
            finally:
                reset_secret_scope(scope);reset_hermes_home_override(token)
        token=set_hermes_home_override(str(tmp_path.parent/'foreign'))
        try:
            with pytest.raises(RuntimeError,match='outside this app'):
                auth.resolve_api_key_provider_credentials('deepseek')
        finally:reset_hermes_home_override(token)
        vault.delete(name+'/deepseek')
        token=set_hermes_home_override(str(homes[0]))
        try:assert auth.resolve_api_key_provider_credentials('deepseek')['api_key']==''
        finally:reset_hermes_home_override(token)
    finally:vault.delete(name+'/deepseek')

@pytest.mark.windows_only
def test_os_store_encryption_real_auth_and_mcp_paths(tmp_path,monkeypatch):
    import windows_credentials as vault
    from security import install_codec
    from hermes_cli import credential_codec, auth
    from tools.mcp_oauth import _write_json, _read_json
    name='Trismegistus/Test/'+str(uuid.uuid4())
    monkeypatch.setattr(credential_codec,'_seal',None)
    monkeypatch.setattr(credential_codec,'_open',None)
    monkeypatch.setenv('HERMES_HOME',str(tmp_path))
    value='synthetic-refresh-token-not-real'
    vault.put(name,b'x'*32)
    try:
        install_codec(name)
        auth._save_auth_store({'providers':{'test':{'refresh_token':value}}})
        file=tmp_path/'auth.json'
        assert value not in file.read_text()
        assert auth._load_auth_store()['providers']['test']['refresh_token']==value
        mcp=tmp_path/'mcp-tokens'/'sample.json'
        _write_json(mcp,{'access_token':value})
        assert value not in mcp.read_text()
        assert _read_json(mcp)['access_token']==value
        # A missing codec cannot turn encrypted data into an empty store.
        credential_codec._open=None
        with pytest.raises(credential_codec.CredentialDecryptionError):auth._load_auth_store()
        with pytest.raises(credential_codec.CredentialDecryptionError):_read_json(mcp)
    finally:vault.delete(name)

def test_active_redaction_has_no_eviction(monkeypatch,tmp_path):
    from agent.redact import register_vault_redaction_value,redact_registered_vault_values,clear_vault_redaction_values
    monkeypatch.setenv('HERMES_HOME',str(tmp_path))
    values=[f'opaque-value-{i:04}-active' for i in range(80)]
    try:
        for value in values:register_vault_redaction_value(value)
        output=redact_registered_vault_values(' '.join(values))
        assert not any(value in output for value in values)
    finally:clear_vault_redaction_values()


def test_provider_destination_is_checked_before_transport_and_each_request(monkeypatch):
    import asyncio
    import httpx
    from agent import process_bootstrap as transport
    from security import provider_guard
    monkeypatch.setattr(transport, '_provider_request_guard', provider_guard('https://api.deepseek.com/v1'))
    for url in ('http://api.deepseek.com/v1', 'https://api.deepseek.com.attacker.test/v1', 'https://user:pass@api.deepseek.com/v1'):
        with pytest.raises(PermissionError):transport.build_keepalive_http_client(url)
    sent=[]
    def reply(request):
        sent.append(str(request.url))
        return httpx.Response(302,headers={'location':'https://attacker.test/collect'})
    with transport.build_keepalive_http_client('https://api.deepseek.com/v1') as client:
        client._mounts={};client._transport=httpx.MockTransport(reply)
        with pytest.raises(PermissionError):client.get('https://api.deepseek.com/v1/test',follow_redirects=True)
    assert sent==['https://api.deepseek.com/v1/test']
    async def check_async():
        async with transport.build_keepalive_http_client('https://api.deepseek.com/v1',async_mode=True) as client:
            with pytest.raises(PermissionError):await client.get('https://attacker.test/collect')
    asyncio.run(check_async())
    def broken(_):raise RuntimeError('Guard unavailable')
    monkeypatch.setattr(transport, '_provider_request_guard', broken)
    with pytest.raises(RuntimeError):transport.build_keepalive_http_client('https://api.deepseek.com/v1')


def test_generic_json_writer_does_not_encrypt_external_cli_files(tmp_path,monkeypatch):
    from hermes_cli import auth, credential_codec
    monkeypatch.setattr(credential_codec,'_seal',lambda data: {'wrong':'encrypted'})
    file=tmp_path/'external-login.json'
    auth._save_private_json(file,{'access_token':'synthetic-external-token'})
    assert json.loads(file.read_text())=={'access_token':'synthetic-external-token'}


def test_plaintext_migration_removes_credentials_only_after_vault_write(tmp_path,monkeypatch):
    import windows_credentials
    from security import migrate_plaintext
    saved={}
    monkeypatch.setattr(windows_credentials,'put',lambda k,v:saved.update({k:v}))
    monkeypatch.setattr(windows_credentials,'get',lambda k:saved.get(k))
    (tmp_path/'.env').write_text('DEEPSEEK_API_KEY=synthetic-key\nNORMAL=keep\n')
    (tmp_path/'config.yaml').write_text('model:\n  default: deepseek-flash\n  api_key: synthetic-config-key\n')
    migrate_plaintext(tmp_path,'test')
    assert 'synthetic' not in (tmp_path/'.env').read_text()
    assert 'synthetic' not in (tmp_path/'config.yaml').read_text()
    assert 'NORMAL=keep' in (tmp_path/'.env').read_text()
    assert saved['test/deepseek']==b'synthetic-key'
    (tmp_path/'.env').write_text('DEEPSEEK_API_KEY=keep-on-vault-failure\n')
    def fail(*_):raise OSError('Vault locked')
    monkeypatch.setattr(windows_credentials,'put',fail)
    with pytest.raises(OSError):migrate_plaintext(tmp_path,'test')
    assert 'keep-on-vault-failure' in (tmp_path/'.env').read_text()


def test_command_authorization_is_exact_single_use_and_keeps_denials(monkeypatch):
    from tools import approval,approval_context
    from concurrent.futures import ThreadPoolExecutor
    with approval_context.authorized_command('python exact'):
        assert not approval_context.consume_authorized_command('python changed')
        with ThreadPoolExecutor() as pool:
            assert not pool.submit(approval_context.consume_authorized_command,'python exact').result()
        monkeypatch.setattr(approval,'_floor_block',lambda *a,**k:{'approved':False})
        assert not approval.check_all_command_guards('python exact','local')['approved']
        monkeypatch.setattr(approval,'_floor_block',lambda *a,**k:None)
        assert approval.check_all_command_guards('python exact','local')['approved']
        assert not approval_context.consume_authorized_command('python exact')
    assert not approval_context.consume_authorized_command('python exact')


def test_missing_required_permission_plugin_blocks_tools(monkeypatch):
    from hermes_cli import plugins
    monkeypatch.setattr(plugins,'_required_pre_tool_plugins',{'required-gate'})
    class Empty:
        def list_plugins(self):return []
    monkeypatch.setattr(plugins,'_ensure_plugins_discovered',lambda:Empty())
    assert plugins.resolve_pre_tool_block('write_file',{'path':'should-not-run'})

def test_permission_decisions_include_fixed_secret_rule(tmp_path):
    spec=importlib.util.spec_from_file_location('app_permissions',APP/'plugins'/'trismegistus-permissions'/'__init__.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    assert module.decide('write_file',{'path':'test.txt'},{'folder':None})['action']=='block'
    assert module.decide('terminal',{'command':'echo test'},{'folder':None})['action']=='block'
    policy={'mode':'manual','folder':str(tmp_path),'secrets_root':str(tmp_path/'private')}
    assert module.decide('write_file',{'path':'result.txt'},policy)['action']=='approve'
    for name,args in [('tool_search',{'queries':['MCP tools']}),('tool_describe',{'names':['connected_tools']}),('connected_tools',{})]:
        assert module.decide(name,args,{**policy,'folder':None}) is None
    assert module.decide('call_connected_tool',{'connection':'test','tool':'echo','arguments':{}},policy)['action']=='approve'
    assert module.decide('skill_view',{'name':'sample','file_path':'config.yaml'},policy) is None
    policy['mode']='plan'
    assert module.decide('write_file',{'path':'result.txt'},policy)['action']=='block'
    assert module.decide('read_file',{'path':'result.txt'},policy) is None
    policy['mode']='accept-edits'
    assert module.decide('write_file',{'path':'result.txt'},policy) is None
    # Starting an app makes one folder inside the working folder: an edit, never allowed in Plan.
    assert module.decide('create_app',{'name':'Shop'},policy) is None
    # Preview pages (FEATURE-SPECS 4): private publishing and reading never ask; deleting always asks, except in Bypass.
    for mode,publish,delete in [('manual',None,'approve'),('accept-edits',None,'approve'),('auto',None,'approve'),('plan','block','block'),('bypass',None,None)]:
        page_policy={**policy,'mode':mode}
        assert module.decide('preview_page',{'action':'list'},page_policy) is None
        result=module.decide('preview_page',{'action':'publish','path':'mock.html','title':'Mock'},page_policy)
        assert (result and result['action'])==publish,(mode,result)
        result=module.decide('preview_page',{'action':'delete','link':'https://s.dev/AbCdEfGhIjKlMnOpQrStUv/'},page_policy)
        assert (result and result['action'])==delete,(mode,result)
    assert module.decide('create_app',{'name':'Shop'},{**policy,'folder':None})['action']=='block'
    assert module.decide('create_app',{'name':'Shop'},{**policy,'mode':'plan'})['action']=='block'
    assert module.decide('create_app',{'name':'Shop'},{**policy,'mode':'manual'})['action']=='approve'
    for mode in ('manual','plan','accept-edits','bypass'):
        assert module.decide('link_app_chat',{'app':'Shop','linked':True},{**policy,'mode':mode,'folder':None}) is None
    registration={'name':'Shop','register_only':True}
    no_folder={**policy,'folder':None}
    assert module.decide('create_app',registration,no_folder) is None
    assert module.decide('create_app',{**registration,'repositories':[]},no_folder)['action']=='block'
    assert module.decide('create_app',{**registration,'icon_path':'icon.png'},no_folder)['action']=='block'
    assert module.decide('create_app',{**registration,'register_only':'true'},no_folder)['action']=='block'
    assert module.decide('update_app',{'id':'app','icon_path':'icon.png'},no_folder)['action']=='block'
    for name,args in [('create_app',registration),('update_app',{'id':'app','name':'New name'}),('add_app_todo',{'app':'Shop','title':'Task'}),('update_app_todo',{'app':'Shop','id':'task','remove':True})]:
        assert module.decide(name,args,{**no_folder,'mode':'manual'})['action']=='approve'
        assert module.decide(name,args,{**no_folder,'mode':'plan'})['action']=='block'
        assert module.decide(name,args,{**no_folder,'mode':'accept-edits'}) is None

    for mode in ('manual','plan','accept-edits','auto','bypass'):
        policy['mode']=mode
        # Cross-chat decisions belong to the main process, which requires an
        # action-bound approval in every mode and refuses sends in Plan.
        for tool in ('search_chats','read_other_chat','send_chat_message'):
            assert module.decide(tool,{},policy) is None
        for name,args in [('terminal',{'command':'cat ~/.claude/auth.json'}),('write_file',{'path':str(tmp_path/'private'/'hermes'/'cache'/'scratch'/'verify.py')})]:
            decision=module.decide(name,args,policy)
            assert decision is None if mode=='bypass' else decision['action']=='approve'
    policy['mode']='bypass'
    assert module.decide('write_file',{'path':str(tmp_path/'task'/'verify.py')},policy) is None
    for mode in ('bypass','accept-edits'):
        args={'path':'verify.js','content':'const temp = process.env.TEMP; // auth.json'}
        assert module.decide('write_file',args,{**policy,'mode':mode}) is None
    assert module.decide('write_file',args,{**policy,'mode':'manual'})['rule_key'].startswith('action:')
    assert module.decide('write_file',args,{**policy,'mode':'plan'})['action']=='block'


def test_codex_usage_preserves_actual_duration_and_whitelists_public_fields():
    from codex_connection import usage_fields
    from agent.account_usage import AccountUsageSnapshot,AccountUsageWindow
    from datetime import datetime,timezone
    now=datetime.now(timezone.utc)
    snapshot=AccountUsageSnapshot(provider='openai-codex',source='fixture',fetched_at=now,
        windows=(AccountUsageWindow(label='Weekly',used_percent=42,reset_at=now),),
        raw={'account_id':'private-not-for-renderer','rate_limit':{'primary_window':{'used_percent':42,'limit_window_seconds':604800}}})
    result=usage_fields(snapshot)
    assert result['windows'][0]['durationSeconds']==604800
    assert result['windows'][0]['usedPercent']==42
    assert result['checkedAt']==now.isoformat()
    assert 'private-not-for-renderer' not in json.dumps(result)
