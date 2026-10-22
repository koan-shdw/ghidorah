"""Test stand-in for backend/gliner_worker.py: the same stdio lines, no model. It picks the GPT label when offered."""
import json
from pathlib import Path
import sys

print(json.dumps({'type': 'ready', 'device': 'cpu', 'revision': 'fixture'}), flush=True)
records = Path(sys.argv[1]).parent / 'gliner.jsonl'
for line in sys.stdin:
    request = json.loads(line)
    with records.open('a', encoding='utf-8') as out:
        out.write(json.dumps(request) + '\n')
    label = next((label for label in request['labels'] if label.lower().startswith('gpt')), request['labels'][0])
    print(json.dumps({'id': request['id'], 'result': {'label': label, 'confidence': 0.91}, 'elapsedMs': 3}), flush=True)
