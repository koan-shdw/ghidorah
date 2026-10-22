"""Private app operation: profile identity comes from main, never tool arguments."""
import json
from pathlib import Path
import re


def project_memory(root, profile, name, arguments, review=None):
    if not isinstance(profile, str) or not re.fullmatch(r'p-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', profile):
        raise ValueError('Invalid project identity')
    root = Path(root).resolve(strict=True)
    home = root / 'profiles' / profile
    if not home.is_dir() or home.resolve() != home:
        raise ValueError('Project memory is unavailable')
    memories = home / 'memories'
    # Reject links/junctions into another profile before Hermes opens any file.
    for item in [home / 'config.yaml', memories, *memories.glob('*')]:
        if item.resolve() != item or item.is_symlink() or item.is_junction():
            raise ValueError('Linked project memory is unavailable')
    if not isinstance(arguments, dict):
        raise ValueError('Invalid memory arguments')
    if name == 'read_project_memory':
        allowed = set()
    elif name in ('update_project_memory', 'prepare_project_memory'):
        allowed = {'action', 'target', 'content', 'old_text', 'operations'}
    else:
        raise ValueError('Unknown project memory tool')
    if set(arguments) - allowed:
        raise ValueError('Memory tools cannot select a profile or path')
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    token = set_hermes_home_override(home)
    try:
        from tools.memory_tool import load_on_disk_store, memory_tool, apply_memory_pending
        store = load_on_disk_store()
        if name == 'read_project_memory':
            return {target: (store.format_for_system_prompt(target) or '') if store.target_enabled(target) else ''
                    for target in ('memory', 'user')}
        if name == 'prepare_project_memory':
            target = arguments.get('target') or 'memory'
            if target not in ('memory', 'user') or not store.target_enabled(target):
                return {'success': False, 'error': 'Memory target is unavailable'}
            payload = {**arguments, 'target': target}
            if arguments.get('operations'):
                resolved = store.resolve_batch_entries(target, arguments['operations'])
                if not resolved.get('success'): return resolved
                payload.update(action='batch', operations=[{**op, **({'matched_entry': entry} if entry is not None else {})}
                    for op, entry in zip(arguments['operations'], resolved['matched_entries'])])
            elif arguments.get('action') in ('replace', 'remove'):
                resolved = store.resolve_entry(target, arguments.get('old_text') or '', arguments['action'])
                if not resolved.get('success'): return resolved
                payload['matched_entry'] = resolved['matched_entry']
            return {'success': True, 'payload': payload}
        if review is not None:
            # Main supplies the reviewed payload, never the model. Hermes checks
            # the pinned full entry under its lock before replacing/removing it.
            return apply_memory_pending(review, store)
        return json.loads(memory_tool(store=store, **arguments))
    finally:
        reset_hermes_home_override(token)
