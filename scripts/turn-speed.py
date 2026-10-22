"""Per-turn speed and token numbers for Tris's Opus chats, read from Claude's own session transcript.

Usage: python scripts/turn-speed.py [transcript.jsonl] [--last N]
Default transcript: the newest file in ~/.claude/projects/I--DEV.
A turn starts at each "[Ghidorah turn" prompt ("[Trismegistus turn" before the 2026-10-16 rename). Active = prompt to last assistant message.
"""
import datetime as dt, glob, json, os, sys

last = int(sys.argv[sys.argv.index('--last') + 1]) if '--last' in sys.argv else 10
args = [a for i, a in enumerate(sys.argv[1:], 1) if not a.startswith('--') and sys.argv[i - 1] != '--last']
path = args[0] if args else max(glob.glob(os.path.expanduser('~/.claude/projects/I--DEV/*.jsonl')), key=os.path.getmtime)
when = lambda ts: dt.datetime.fromisoformat(ts.replace('Z', '+00:00'))

# Tris marks each turn; a plain Claude Code session has no marker, so its own typed prompts start turns.
def opens_tris(line):
    try: c = (json.loads(line).get('message') or {}).get('content')
    except ValueError: return False
    return isinstance(c, list) and any(isinstance(b, dict) and b.get('type') == 'text' and b.get('text', '').startswith(('[Ghidorah turn', '[Trismegistus turn')) for b in c)
tris = any(opens_tris(line) for line in open(path, encoding='utf8'))
turns, cur = [], None
for line in open(path, encoding='utf8'):
    try: row = json.loads(line)
    except ValueError: continue
    msg = row.get('message') or {}
    content = msg.get('content')
    blocks = content if isinstance(content, list) else []
    typed = isinstance(content, str) or any(b.get('type') == 'text' for b in blocks) and not any(b.get('type') == 'tool_result' for b in blocks)
    if row.get('type') == 'user' and not row.get('isMeta') and (any(b.get('type') == 'text' and ('[Ghidorah turn' in b.get('text', '') or '[Trismegistus turn' in b.get('text', '')) for b in blocks) if tris else typed):
        cur = {'start': when(row['timestamp']), 'end': when(row['timestamp']), 'preamble': sum(len(b.get('text', '')) for b in blocks if b.get('type') == 'text'),
               'ids': set(), 'calls': {}, 'tool_s': 0.0, 'tools': 0, 'checks': 0, 'blocked': 0, 'read': 0, 'new': 0, 'out': 0, 'first': None}
        turns.append(cur); continue
    if not cur: continue
    if row.get('type') == 'assistant':
        cur['end'] = when(row['timestamp'])
        if msg.get('id') not in cur['ids']:
            cur['ids'].add(msg.get('id')); u = msg.get('usage') or {}
            cur['read'] += u.get('cache_read_input_tokens', 0); cur['new'] += u.get('cache_creation_input_tokens', 0) + u.get('input_tokens', 0); cur['out'] += u.get('output_tokens', 0)
            if cur['first'] is None: cur['first'] = u.get('cache_read_input_tokens', 0) + u.get('cache_creation_input_tokens', 0) + u.get('input_tokens', 0)
        for b in blocks:
            if b.get('type') == 'tool_use':
                cur['tools'] += 1; cur['checks'] += b['name'].endswith('inspect_action'); cur['calls'][b['id']] = when(row['timestamp'])
    if row.get('type') == 'user':
        for b in blocks:
            if b.get('type') == 'tool_result':
                text = str(b.get('content'))
                if 'hook error' in text or 'Blocked' in text or 'tool_use_error' in text: cur['blocked'] += 1
                if b.get('tool_use_id') in cur['calls']: cur['tool_s'] += (when(row['timestamp']) - cur['calls'][b['tool_use_id']]).total_seconds()

print(os.path.basename(path))
print(f"{'turn':>5} {'active':>7} {'cmds':>6} {'model':>6} {'calls':>5} {'tools':>5} {'checks':>6} {'blocked':>7} {'ctx/call':>8} {'tokens in':>10} {'out':>6}")
for t in turns[-last:]:
    active = (t['end'] - t['start']).total_seconds(); calls = max(len(t['ids']), 1)
    print(f"{t['start'].astimezone():%H:%M} {active:6.0f}s {t['tool_s']:5.0f}s {active - t['tool_s']:5.0f}s {len(t['ids']):5} {t['tools']:5} {t['checks']:6} {t['blocked']:7} {(t['read'] + t['new']) // calls:8} {t['read'] + t['new']:10} {t['out']:6}")
