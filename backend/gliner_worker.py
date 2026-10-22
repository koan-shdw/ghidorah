"""Private stdio worker for GLiNER2.5-Decide; no project imports, network inference or provider credentials."""
from pathlib import Path
import contextlib
import json
import os
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gliner_runtime  # noqa: E402,F401  (points the shared installer at GLiNER's files)
from local_classifier_runtime import emit, parent_guard, valid  # noqa: E402
import local_classifier_runtime as runtime  # noqa: E402


def main():
    parent_guard()
    root = Path(sys.argv[1]).resolve()
    marker = json.loads((root / runtime.IDENTITY[:16] / 'ready.json').read_text(encoding='utf-8'))
    if marker.get('identity') != runtime.IDENTITY:
        raise ValueError('Install the pinned GLiNER runtime again.')
    model = root / 'models' / runtime.MANIFEST['revision']
    if not all(valid(model / name, spec) for name, spec in runtime.MANIFEST['files'].items()):
        raise ValueError('GLiNER model files changed. Install them again.')
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        from gliner2 import AutoExtractor
        torch.set_num_threads(min(8, os.cpu_count() or 1))
        extractor = AutoExtractor.from_pretrained(str(model))
    emit(dict(type='ready', device='cpu', revision=runtime.MANIFEST['revision']))
    while line := sys.stdin.buffer.readline(1024 * 1024 + 1):
        if len(line) > 1024 * 1024:
            raise ValueError('GLiNER input is too large.')
        request = json.loads(line)
        try:
            started = time.perf_counter()
            with contextlib.redirect_stdout(sys.stderr):
                # gliner2 2.0.0 README: classify_text(text, {task: labels}, include_confidence=True)
                # answers {task: {'label': ..., 'confidence': ...}}.
                answer = extractor.classify_text(request['text'], {'model': request['labels']}, include_confidence=True)
            emit(dict(id=request['id'], result=answer.get('model'), elapsedMs=round((time.perf_counter() - started) * 1000)))
        except Exception as error:
            emit(dict(id=request.get('id'), error=str(error)[:1000]))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit(dict(type='error', error=str(error)[:1500]))
        sys.exit(1)
