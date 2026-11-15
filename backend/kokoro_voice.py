"""The local voice that speaks replies: Kokoro, kept loaded while it is in use (Koan 2026-11-15).

The model and its voices are pinned by size and SHA-256 in kokoro-voice.json and are downloaded only on the Voices
window's Install click, like the whisper models. Main sends JSON lines on stdin and reads JSON lines on stdout, the
way dictation does. A voice is one Kokoro voice, or two blended at any point, at a speed. Text arrives already cut
into short pieces so the first sound is quick; each piece goes back as 24 kHz mono 16-bit PCM in base64. The effects
(robot, whisper and the rest) are added by the window that plays the sound.
"""
import base64
import json
import sys
import threading
from pathlib import Path

SOURCE = Path(__file__).resolve().parent
MODEL = json.loads((SOURCE / 'kokoro-voice.json').read_text(encoding='utf-8'))
RATE = 24000
PIECES, PIECE = 400, 2000    # the most pieces in one request, and the longest piece in characters


def directory(root):
    folder = Path(root).resolve() / 'models' / 'kokoro' / MODEL['release']
    if folder.resolve() != folder:
        raise ValueError('Voice model folders must not be links.')
    return folder


def verified(root):
    from speech_models import _valid
    folder = directory(root)
    for file, spec in MODEL['files'].items():
        if not _valid(folder / file, spec):
            raise ValueError('The voice model is missing or changed. Install it again in Voices.')
    return folder


def install(root):
    from speech_models import fetch
    fetch(directory(root), MODEL['files'], lambda file: MODEL['source'] + file, lambda: directory(root))
    return str(verified(root))


def emit(**event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def load(folder):
    from kokoro_onnx import Kokoro
    return Kokoro(str(folder / 'kokoro-v1.0.onnx'), str(folder / 'voices-v1.0.bin'))


def english(kokoro):
    """The American and British voices; the app is English only."""
    return sorted(name for name in kokoro.get_voices() if name[:2] in ('af', 'am', 'bf', 'bm'))


def request(message, names):
    """A speak request checked against the voices this model has."""
    pieces, a, b = message.get('pieces'), message.get('a'), message.get('b') or ''
    balance, speed = message.get('balance', 0), message.get('speed', 1)
    if not isinstance(pieces, list) or not 1 <= len(pieces) <= PIECES or any(not isinstance(piece, str) or not piece.strip() or len(piece) > PIECE for piece in pieces):
        raise ValueError('Invalid text to speak.')
    if a not in names or (b and b not in names):
        raise ValueError('Choose a voice from the list.')
    if isinstance(balance, bool) or not isinstance(balance, (int, float)) or not 0 <= balance <= 100:
        raise ValueError('Invalid voice balance.')
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not 0.5 <= speed <= 2:
        raise ValueError('Invalid voice speed.')
    return {'pieces': list(pieces), 'a': a, 'b': b if b != a else '', 'balance': float(balance), 'speed': float(speed), 'next': 0}


def style(kokoro, a, b='', balance=0):
    """One voice, or two blended. balance is the second voice's share in percent."""
    first = kokoro.get_voice_style(a)
    if not b or balance <= 0:
        return first
    share = min(100.0, balance) / 100
    return first * (1 - share) + kokoro.get_voice_style(b) * share


def language(a, b='', balance=0):
    """British voices say British sounds; a blend follows the voice with the larger share."""
    return 'en-gb' if (b if b and balance > 50 else a).startswith('b') else 'en-us'


def speak(kokoro, piece, job):
    import numpy as np
    audio, _ = kokoro.create(piece, voice=style(kokoro, job['a'], job['b'], job['balance']), speed=job['speed'],
                             lang=language(job['a'], job['b'], job['balance']))
    return (np.clip(np.asarray(audio, np.float32), -1, 1) * 32767).astype('<i2').tobytes()


def run(kokoro, lines=sys.stdin):
    names = set(english(kokoro))
    jobs, wake, closed = {}, threading.Condition(), threading.Event()

    def read():
        for line in lines:
            key = ''
            try:
                message = json.loads(line)
                op, key = message.get('op'), str(message.get('id', ''))
                with wake:
                    if op == 'speak':
                        jobs[key] = request(message, names)
                    elif op == 'cancel':
                        jobs.pop(key, None)
                    wake.notify()
            except Exception as error:
                if key:
                    emit(id=key, type='error', text=str(error)[:300])
        closed.set()
        with wake:
            wake.notify()

    threading.Thread(target=read, daemon=True).start()
    while True:
        with wake:
            if not jobs:
                if closed.is_set():
                    return
                wake.wait(0.25)
                continue
            # One piece at a time, then the next job's turn: two windows speaking both keep moving.
            key = next(iter(jobs))
            job = jobs.pop(key)
            if job['next'] >= len(job['pieces']):
                emit(id=key, type='end')
                continue
            jobs[key] = job
            piece, index = job['pieces'][job['next']], job['next']
            job['next'] += 1
        try:
            try:
                pcm = speak(kokoro, piece, job)
            except ValueError:
                pcm = b''  # a piece with nothing sayable in it (only symbols) is passed over
            with wake:
                if jobs.get(key) is not job:
                    continue  # cancelled while the model ran
            if pcm:
                emit(id=key, type='audio', index=index, rate=RATE, pcm=base64.b64encode(pcm).decode('ascii'))
        except Exception as error:
            with wake:
                jobs.pop(key, None)
            emit(id=key, type='error', text=str(error)[:300])
