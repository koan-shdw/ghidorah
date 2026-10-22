"""Real Hermes auxiliary paths against an isolated provider and desktop owner."""
import asyncio
import json
from pathlib import Path
import sys

app = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(app / 'backend'), str(app / 'runtime' / 'hermes')]
setup = json.loads(sys.stdin.readline())
from provider_access import install
install(setup['connection'], {'deepseek': setup['url']})
from agent.auxiliary_client import call_llm, async_call_llm
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from agent.memory_provider import spawn_context_thread

print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    home = Path(setup['root']) / request['profile']
    home.mkdir(exist_ok=True)
    (home / 'config.yaml').write_text(json.dumps({'auth': {'adopt_external_logins': False}, 'model': {'provider': 'deepseek', 'default': 'deepseek-flash', 'base_url': setup['url']}}))
    scope = set_hermes_home_override(home)
    try:
        kwargs = dict(task=request.get('task', 'title_generation'), provider='deepseek', model='deepseek-flash',
                      base_url=setup['url'], api_key='synthetic-deepseek-regression-credential',
                      messages=[{'role': 'user', 'content': request.get('text', 'A short title')}], timeout=8)
        result = {}
        def run():
            try:
                if request['kind'] == 'async':
                    value = asyncio.run(async_call_llm(**kwargs))
                else:
                    value = call_llm(**kwargs, stream=request['kind'] == 'stream')
                if request['kind'] == 'stream':
                    for _ in value:
                        pass
                result['ok'] = True
            except Exception as error:
                result['error'] = type(error).__name__
        if request['kind'] == 'background':
            worker = spawn_context_thread(target=run, name='availability-probe', daemon=True)
            worker.start()
            worker.join(45)
            if worker.is_alive():
                raise RuntimeError('Background probe did not finish')
        else:
            run()
        print(json.dumps(result), flush=True)
    finally:
        reset_hermes_home_override(scope)
