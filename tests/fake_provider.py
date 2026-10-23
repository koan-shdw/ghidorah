import json
import sys
import os
import re
import time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'hermes'))
from tests.fakes.fake_llm_provider import FakeLLMServer,Text,ToolCall,Error

def health_value(value=None):
    file=os.environ.get('FIXTURE_HEALTH_FILE')
    if not file:return 'ready'
    data=json.loads(Path(file).read_text())
    if value is not None:
        data['deepseek']=value;Path(file).write_text(json.dumps(data))
    return data.get('deepseek','ready')

goal_rounds = {}
sequence_rounds = {}
# The tool sequence still running: a request restated after compaction (with a steer in it) carries on with it.
active_sequence = {}

# A message typed mid-turn reaches the model as a steer row (Hermes busy mode steer). A real model carries on with its
# task and answers both; the scripted steps here keep counting from the message that started them.
def is_steer(message):
    content=message.get('content','')
    text='\n'.join(part.get('text','') for part in content if isinstance(part,dict)) if isinstance(content,list) else str(content)
    return message.get('role')=='user' and text.lstrip().startswith('[OUT-OF-BAND USER MESSAGE')


def user_start(messages):
    return max(i for i,m in enumerate(messages) if m.get('role')=='user' and not is_steer(m))


def response(body):
    body=body.get('body',body)
    if os.environ.get('FIXTURE_RECORDS'):
        with open(os.environ['FIXTURE_RECORDS'],'a',encoding='utf8') as output:output.write(json.dumps(body)+'\n')
    messages=body.get('messages',[])
    last=next((m.get('content','') for m in reversed(messages) if m.get('role')=='user' and not is_steer(m)),'')
    if isinstance(last,list):last='\n'.join(part.get('text','') for part in last if part.get('type')=='text')
    else:last=str(last)
    # A request restated after compaction embeds the steered text; the script follows the request itself.
    last=re.sub(r'\[OUT-OF-BAND USER MESSAGE.*?\[/OUT-OF-BAND USER MESSAGE\]','',last,flags=re.S)
    last=last.rsplit('Current user message:',1)[-1].strip()
    if last.startswith('[STILL IN PROGRESS') and active_sequence.get('steps'):last='TOOL_SEQUENCE_FIXTURE '+json.dumps(active_sequence['steps'])
    if 'READ_POINT_FIXTURE ' in last:
        spec=json.JSONDecoder().raw_decode(last.rsplit('READ_POINT_FIXTURE ',1)[-1])[0]
        count=sum(m.get('role')=='tool' for m in messages[user_start(messages)+1:])
        if count<2:return ToolCall('terminal',{'command':spec['commands'][count],'timeout':120},text=['Before reading.\n\n','After reading.\n\n'][count])
        return Text('Final answer.')
    if 'BYPASS_SKILLS_FIXTURE' in last:
        start=user_start(messages)
        outputs=[m for m in messages[start+1:] if m.get('role')=='tool']
        steps=[('skills_list',{}),('skill_view',{'name':'shared-fixture'}),
               ('skill_view',{'name':'shared-fixture','file_path':'config.yaml'}),
               ('write_file',{'path':'bypass-result.txt','content':'Bypass edit completed.'}),
               ('terminal',{'command':'printf bypass-command'})]
        if len(outputs)<len(steps):return ToolCall(*steps[len(outputs)])
        return Text('BYPASS_SKILLS_DONE '+json.dumps([m.get('content') for m in outputs]))
    if 'PRIVATE_READ_FIXTURE ' in last:
        start=user_start(messages)
        if any(m.get('role')=='tool' for m in messages[start+1:]):return Text('Private read decision received.')
        spec=json.JSONDecoder().raw_decode(last.rsplit('PRIVATE_READ_FIXTURE ',1)[-1])[0]
        return ToolCall('read_file',{'path':spec['path']})
    # Review requests embed earlier messages as evidence. Their old fixture
    # commands must not become fresh tool calls in this protocol stand-in.
    if 'Review the current branch and working changes in the selected repository.' in last:
        instructions = last.rsplit('Additional review instructions from the user:', 1)[-1]
        if '\nUser focus:\n' not in instructions:
            return Text('Fixture review completed without edits.')
        last = instructions.split('\nUser focus:\n', 1)[-1]
    if 'GOAL_FIXTURE ' in last:
        spec=json.JSONDecoder().raw_decode(last.rsplit('GOAL_FIXTURE ',1)[-1])[0]
        start=user_start(messages)
        outputs=[m for m in messages[start+1:] if m.get('role')=='tool']
        if spec.get('write') and not outputs:
            return ToolCall('write_file',{'path':spec['write'],'content':'Verified goal fixture output.'})
        if len(outputs)==(1 if spec.get('write') else 0):
            key=spec['key'];goal_rounds[key]=goal_rounds.get(key,0)+1
            status=spec.get('status') or ('complete' if goal_rounds[key]>=spec.get('steps',2) else 'continue')
            return ToolCall('goal_status',{'status':status,'summary':'Completed fixture phase '+str(goal_rounds[key]),'evidence':'Local protocol fixture phase '+str(goal_rounds[key])+' reached its expected output.'})
        return Text('Goal phase result. '*(100 if spec.get('slow') else 1),chunk_chars=4,delay_per_chunk=.05 if spec.get('slow') else .001)
    if 'RECOVERY_FIXTURE ' in last:
        spec=json.JSONDecoder().raw_decode(last.rsplit('RECOVERY_FIXTURE ',1)[-1])[0]
        start=user_start(messages)
        outputs=[m for m in messages[start+1:] if m.get('role')=='tool']
        if not outputs:return ToolCall('terminal',{'command':spec['command']})
        if len(outputs)==1:return ToolCall('write_file',{'path':spec['path'],'content':'Hermes continued after the command failed.'})
        return Text('Recovery completed.')
    if 'STALE_WRITE_FIXTURE ' in last:
        spec=json.JSONDecoder().raw_decode(last.rsplit('STALE_WRITE_FIXTURE ',1)[-1])[0]
        start=user_start(messages)
        outputs=[m for m in messages[start+1:] if m.get('role')=='tool']
        steps=[('read_file',{'path':spec['file'],'offset':1,'limit':1}),
               ('write_file',{'path':spec['file'],'content':'Unsafe replacement'}),
               ('create_app',{'name':'After refused overwrite','register_only':True}),
               ('write_file',{'path':spec['report'],'content':'Continued after a refused overwrite.'})]
        if len(outputs)<len(steps):return ToolCall(*steps[len(outputs)])
        return Text('Stale write fixture completed.')
    if 'REGISTER_APP_FIXTURE ' in last:
        spec=json.JSONDecoder().raw_decode(last.rsplit('REGISTER_APP_FIXTURE ',1)[-1])[0]
        start=user_start(messages)
        outputs=[m for m in messages[start+1:] if m.get('role')=='tool']
        steps=[('create_app',{'name':'Invalid repository','register_only':True,'repositories':[spec['missing']]}),
               ('create_app',{'name':'External app','register_only':True,'repositories':[spec['repository']],'icon_path':spec['icon']}),
               ('write_file',{'path':spec['report'],'content':'Audit report saved after registration.'})]
        if len(outputs)<len(steps):return ToolCall(*steps[len(outputs)])
        return Text('Registration flow completed.')
    if 'CREATE_APP_FIXTURE' in last:
        start=user_start(messages)
        if not any(m.get('role')=='tool' for m in messages[start+1:]):
            return ToolCall('create_app',{'name':'Plush Shop','description':'A fixture shop app'})
        return Text('App started.')
    if 'PLUGIN_FIXTURE' in last:return Text('Plugin fixture finished.')
    if 'PLAN_BATCH_FIXTURE' in last:
        start=user_start(messages)
        results=[str(m.get('content','')) for m in messages[start+1:] if m.get('role')=='tool']
        if results:return Text('\n'.join(results))
        return ToolCall('terminal',{'command':'git diff'},parallel=[('terminal',{'command':'git status --short'})])
    if 'BACKGROUND_FIXTURE ' in last:
        spec=json.JSONDecoder().raw_decode(last.rsplit('BACKGROUND_FIXTURE ',1)[-1])[0]
        start=user_start(messages)
        count=sum(m.get('role')=='tool' for m in messages[start+1:])
        args={'command':spec['command'],'background':True}
        if count==0:return ToolCall('read_file',{'path':spec['script']})
        if count==1:return ToolCall('tool_call',{'calls':[{'name':'inspect_action','arguments':{'tool':'terminal','arguments':args,'summary':spec['summary'],'evidence':[spec['script']],'resources':spec['resources']}}]})
        if count==2:return ToolCall('terminal',args)
        return Text(str(messages[-1].get('content','')))
    if 'PARALLEL_BOARD_FIXTURE' in last:
        if messages[-1].get('role')=='tool':
            content=str(messages[-1].get('content',''))
            try:failed=bool(json.loads(content).get('error'))
            except (ValueError,AttributeError):failed=False
            if not failed:return Text(content)
            return ToolCall('tool_call',{'calls':[{'name':'parallel_work','arguments':{'operation':'note','text':'DeepSeek board finding'}}]})
        return ToolCall('tool_call',{'calls':[{'name':'parallel_work','arguments':{}}]})
    if 'TOOL_SEQUENCE_FIXTURE ' in last:
        steps=json.JSONDecoder().raw_decode(last.rsplit('TOOL_SEQUENCE_FIXTURE ',1)[-1])[0]
        start=user_start(messages)
        count=sum(m.get('role')=='tool' for m in messages[start+1:])
        if os.environ.get('FIXTURE_MEASURE_CONTEXT'):
            # Compaction can archive early tool messages. Fixture progress must
            # survive that boundary instead of replaying already-issued reads.
            key=json.dumps(steps,sort_keys=True)
            count=sequence_rounds.get(key,0)
            sequence_rounds[key]=count+1
            active_sequence['steps']=steps if count<len(steps) else None
        if count<len(steps):return ToolCall(steps[count]['name'],steps[count]['arguments'])
        return Text(str(messages[-1].get('content','')))
    if 'MCP_FIXTURE ' in last:
        if messages[-1].get('role')=='tool':return Text(str(messages[-1].get('content','')))
        spec=json.JSONDecoder().raw_decode(last.rsplit('MCP_FIXTURE ',1)[-1])[0]
        name=spec['name']
        if name not in {item.get('function',{}).get('name') for item in body.get('tools',[])}:
            if name not in json.dumps(body.get('tools',[])):return Error(status=400,message='MCP plugin tool was not exposed')
            return ToolCall('tool_call',{'calls':[{'name':name,'arguments':spec['arguments']}]})
        return ToolCall(name,spec['arguments'])
    if 'HEALTH_EFFECT' in last:
        if messages[-1].get('role')!='tool':return ToolCall('write_file',{'path':'before-limit.txt','content':'Write completed before the account limit.'})
        health_value('exhausted');return Error(status=402,message='Insufficient Balance')
    if 'EXHAUST_FIXTURE' in last:
        if 'SLOW_EXHAUST_FIXTURE' in last:time.sleep(2)
        health_value('exhausted');return Error(status=402,message='Insufficient Balance')
    if messages[-1].get('role')=='tool':return Text('The tool finished. Result saved.',chunk_chars=4,delay_per_chunk=.01)
    if 'RLM_HISTORY_FIXTURE ' in last:
        args=json.JSONDecoder().raw_decode(last.rsplit('RLM_HISTORY_FIXTURE ',1)[-1])[0]
        return ToolCall('query_chat_history',args)
    if 'HISTORY_FIXTURE ' in last:
        args=json.JSONDecoder().raw_decode(last.rsplit('HISTORY_FIXTURE ',1)[-1])[0]
        return ToolCall('read_chat_history',args)
    if 'COORDINATION_COMMAND ' in last:return ToolCall('terminal',json.JSONDecoder().raw_decode(last.split('COORDINATION_COMMAND ',1)[1])[0])
    match=re.search(r'MODE_EDIT_(\w+)',last)
    if match:return ToolCall('write_file',{'path':f'mode-{match[1]}.txt','content':match[1]})
    if 'BYPASS_COMMAND' in last:return ToolCall('terminal',{'command':'''python -c "print('bypass-fixture')"'''})
    if 'AUTO_COMMAND' in last:return ToolCall('terminal',{'command':'''python -c "print('auto-fixture')"'''})
    if 'COORDINATION_WRITE_SHARED' in last:return ToolCall('write_file',{'path':'shared-result.txt','content':'DeepSeek shared write.'})
    if 'WRITE_FIXTURE' in last:return ToolCall('write_file',{'path':'slice-result.txt','content':'Written through Hermes tools.'})
    if 'DENY_FIXTURE' in last:return ToolCall('write_file',{'path':'must-not-exist.txt','content':'Do not permit this write.'})
    if 'SECRET_FIXTURE' in last:return ToolCall('read_file',{'path':'.codex/auth.json'})
    # A command no reader list knows (two-chats.e2e): before 2026-10-10 it locked every chat.
    if 'UNKNOWN_COMMAND_FIXTURE' in last:return ToolCall('terminal',{'command':'python -c "print(42)"'})
    if 'COMMAND_FIXTURE' in last:return ToolCall('terminal',{'command':'echo command-through-hermes'})
    if 'BACKGROUND_NOTICE_FIXTURE' in last:return ToolCall('terminal',{'command':'''python -c "import time; time.sleep(3); print('notice-fixture-done')"''','background':True,'notify_on_complete':True})
    if 'MEMORY_FIXTURE' in last:return ToolCall('memory',{'action':'add','target':'memory','content':'ALPHA_MEMORY_PRIVATE_VALUE'})
    if 'CLARIFY_FIXTURE' in last:return ToolCall('clarify',{'question':'Choose a fixture color','choices':['Blue','Green']})
    if 'SLOW_FIXTURE' in last:return Text('Streaming cancellation fixture. '*100,chunk_chars=8,delay_per_chunk=.05)
    if 'PROCESS_FIXTURE' in last:return ToolCall('terminal',{'command':'''python -c "import os,time; open('process.pid','w').write(str(os.getpid())); time.sleep(60); open('cancelled-effect.txt','w').write('bad')"''','timeout':90})
    return Text('Scripted reply: '+last,reasoning='Checking the request.',chunk_chars=4,delay_per_chunk=.01)

def auxiliary(body):
    # Side answers (FEATURE-SPECS 2): the sorter sends every message to the main model unless it carries SIDE_FIXTURE.
    if 'Koan sent this message while' in json.dumps(body) or 'Koan asked a quick question' in json.dumps(body):
        task = json.loads(body.get('body', body)['messages'][-1]['content'])
        if 'Koan asked a quick question' in json.dumps(body):
            return Text('Side fixture: ' + task['live']['status'])
        return Text('Side fixture (sorted): ' + task['live']['status'] if 'SIDE_FIXTURE' in task['question'] else 'MAIN')
    if "Write a short plain-text page that a client" in json.dumps(body):
        task = json.loads(body.get('body', body)['messages'][-1]['content'])
        return Text('WHAT THIS PROJECT IS\nFixture project ' + task['project'] + ', version ' + str(task['version']) + '.\nTHE BRIEF\nA landing page.')
    if 'rlm-history' in json.dumps(body):
        task = json.loads(body.get('body', body)['messages'][-1]['content'])
        sources = task.get('sources')
        evidence = [{'id': sources[0]['id'], 'quote': sources[0]['text'][:80]}] if sources else task['findings'][0]['evidence']
        return Text(json.dumps({'answer': 'Saved decision retrieved.', 'evidence': evidence}))
    if 'Write a compact continuation summary for a coding chat.' in json.dumps(body):
        task = json.loads(body.get('body', body)['messages'][-1]['content'])
        source = task.get('previousSummary', '') + '\n' + '\n'.join(row['text'] for row in task['records'])
        if 'SLOW_CONTEXT_FIXTURE' in source:
            time.sleep(6)
        anchors = sorted(set(re.findall(r'ANCHOR_[A-Za-z0-9_-]+', source)))
        return Text('Reviewed fixture decisions: ' + ', '.join(anchors) + '. Keep recorded outcomes and inspect current files before editing.')
    if os.environ.get('FIXTURE_AUX_RECORDS'):
        with open(os.environ['FIXTURE_AUX_RECORDS'],'a',encoding='utf8') as output:output.write(json.dumps(body)+'\n')
    if 'You are the voice helper for the selected chat.' in json.dumps(body):
        task = json.loads(body.get('body', body)['messages'][-1]['content'])
        return Text(json.dumps({'reply':'I have prepared that message.', 'draft':'Explain this project.', 'chatId':None, 'readPage':None}))
    if 'Suggest sources an update watcher should read for one app.' in json.dumps(body):
        return Text(json.dumps({'topics': 'must be ignored', 'sources': 'Two Minute Papers news'}))
    if 'Plan web searches that find the latest advancements' in json.dumps(body):
        return Text(json.dumps({'queries': [json.loads(body.get('body', body)['messages'][-1]['content'])['brief']]}))
    if 'Review recent items for one app' in json.dumps(body):
        items = json.loads(body.get('body', body)['messages'][-1]['content'])['items']
        return Text(json.dumps({'ideas': [
            {'title': 'Try ' + items[0]['title'], 'summary': 'A fixture model was released.', 'why': 'Faster renders.', 'change': 'Add it as a render backend.', 'effort': 'small', 'sources': [items[0]['id']]},
            {'title': 'Invented update', 'summary': 'No source.', 'change': 'Nothing.', 'sources': ['missing']}]}))
    if 'Write a short dashboard title for each to-do.' in json.dumps(body):
        context = json.loads(body.get('body', body)['messages'][-1]['content'])
        return Text(json.dumps({'items':[{'id':todo['id'],'text':' '.join(todo['notes'].split()[:7])} for todo in context['todos']]}))
    if 'Build an app overview from linked conversation records' in json.dumps(body):
        context = json.loads(body.get('body', body)['messages'][-1]['content'])
        sources = context['sources']
        content = json.dumps(sources)
        if 'SUMMARY_TIMEOUT' in content:
            time.sleep(25)
        if 'SUMMARY_SLOW' in content:
            time.sleep(8)
        if 'SUMMARY_INVALID' in content:
            return Text(json.dumps({'items':[{'kind':'question','text':'Invented','evidence':[{'sourceId':'missing','quote':'Not real'}]}]}))
        items = context['previous'][:]
        for source in sources:
            for prefix, kind in [('Current work:', 'current'), ('Idea:', 'idea'), ('Open question:', 'question'), ('Planned:', 'planned'), ('Delivery:', 'delivery')]:
                for line in source['text'].splitlines():
                    if line.startswith(prefix):
                        text=line[len(prefix):].strip()
                        items=[item for item in items if item['text']!=text]
                        items.append({'kind':kind,'text':text,'evidence':[{'sourceId':source['id'],'quote':line}]})
            if 'Hosting question resolved.' in source['text']:
                items=[item for item in items if item['kind']!='question']
        return Text(json.dumps({'items':items}))
    if 'You are on select duty' in json.dumps(body):
        # A slow pick, so messages typed while it runs wait behind it.
        if 'SLOW_SELECT_FIXTURE' in json.dumps(body):time.sleep(3)
        task = json.loads(body.get('body', body)['messages'][-1]['content'])
        state, questions = task['state'], task['questions']
        chosen = next(model['id'] for model in state['models'] if model['available'])
        answers = {}
        for name, question in questions.items():
            keys = list(question['criteria'])
            choice = chosen if name == 'primary' else 'single' if name == 'execution' else 'ask' if 'ask' in keys else keys[0]
            answers[name] = {'choice': choice, 'confidence': 0.93}
        return Text('Selector fixture: ' + json.dumps({'answers': answers}))
    if 'Summarize what a Hermes Agent release changes' in json.dumps(body):
        return Text(json.dumps({'facts': ['Fixture fact from the notes.'], 'recommendation': 'Fixture recommendation.'}))
    if 'You review AI model catalogue changes' in json.dumps(body):
        # The new-model check: describe each new model from the first page it was given, add an idea and a field the app must ignore.
        prompt = body.get('body', body)['messages'][-1]['content']
        listed = json.loads(prompt.split('<list>', 1)[1].split('</list>', 1)[0])
        sources = dict(re.findall(r'<page provider="([^"]+)" url="([^"]+)"', prompt))
        url = sources.get('deepseek') or next(iter(sources.values()))
        current_pages = prompt.split('</list>', 1)[1]
        if 'INVALID_DISCOVERY_FIXTURE' in current_pages:
            return Text(json.dumps({'models': [], 'changes': [], 'suggestions': []}))
        changed = 'CAPABILITY_CHANGED_FIXTURE' in current_pages and not listed['new'] and 'CAPABILITY_CHANGED_FIXTURE' not in listed.get('previousPages', {}).get('deepseek', '')
        return Text(json.dumps({'models': [{'provider': row['provider'], 'id': row['id'], 'description': 'Fixture description of ' + row['id'] + '.', 'abilities': ['text'], 'source': sources[row['provider']]} for row in listed['new']],
                                'changes': [{'provider': 'deepseek', 'id': 'deepseek-flash', 'description': 'Fixture capability changed with the same model ID.', 'abilities': ['text', 'images'], 'source': url}] if changed else [], 'suggestions': [{'title': 'Fixture idea', 'detail': 'An idea the new models allow.', 'sources': [url], 'status': 'new'}], 'grant': {'tools': 'all'}}))
    if 'Summarize the conversation and current request' in json.dumps(body):
        context = json.loads(body.get('body', body)['messages'][-1]['content'])
        reaction = 'correction' if 'WRONG_FIXTURE' in context['message'] else 'praise' if 'THANKS_FIXTURE' in context['message'] else ''
        return Text('Routing summary: ' + context['message'].splitlines()[0][:100] + ('\nTask kind: coding\nPrevious reply: ' + reaction if reaction or 'LEARN_FIXTURE' in context['message'] else ''))
    if 'EXHAUST_SIDE_FIXTURE' in json.dumps(body):
        health_value('exhausted');return Error(status=402,message='Insufficient Balance')
    return Text('APPROVE')

with FakeLLMServer(response,aux=auxiliary,api_key='synthetic-deepseek-regression-credential',
                   prompt_tokens_fn=(lambda body: len(json.dumps(body)) // 4) if os.environ.get('FIXTURE_MEASURE_CONTEXT') else None) as server:
    original_get=server._server.RequestHandlerClass.do_GET
    def balance(handler):
        if handler.path=='/models' and os.environ.get('FIXTURE_DEEPSEEK_MODELS'):
            data=json.dumps({'data':[{'id':model} for model in json.loads(os.environ['FIXTURE_DEEPSEEK_MODELS'])]}).encode()
            handler.send_response(200);handler.send_header('Content-Type','application/json');handler.send_header('Content-Length',str(len(data)));handler.end_headers();handler.wfile.write(data);return
        if handler.path!='/user/balance':return original_get(handler)
        value=health_value()
        if value in ('auth','unknown'):handler.send_error(401 if value=='auth' else 503);return
        data=json.dumps({'is_available':value!='exhausted','balance_infos':[]}).encode()
        handler.send_response(200);handler.send_header('Content-Type','application/json');handler.send_header('Content-Length',str(len(data)));handler.end_headers();handler.wfile.write(data)
    server._server.RequestHandlerClass.do_GET=balance
    original=server._server.handle_error
    def expected_disconnect(request,address):
        if not isinstance(sys.exc_info()[1],ConnectionError):original(request,address)
    server._server.handle_error=expected_disconnect
    print(json.dumps({'url':server.base_url}),flush=True)
    sys.stdin.readline()
