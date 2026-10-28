"""Dictation (R4): one Whisper model kept loaded, writing text while the owner speaks.

Main sends JSON lines on stdin and reads JSON lines on stdout. Audio arrives as 16 kHz mono 16-bit PCM in base64, the
format Claude's dictation streams. A session's text is redrafted about once a second from the audio not yet settled;
after 20 s the finished segments settle so each pass stays short. Silence never reaches the model (Whisper's own
voice filter), so quiet rooms do not turn into invented words.
"""
import base64
import json
import os
import sys
import threading

import numpy as np

RATE = 16000
STEP = int(RATE * 0.8)       # new audio needed before the next draft
SETTLE = RATE * 20           # unsettled audio kept before the finished segments settle
NO_SPACE_BEFORE = set('.,!?;:)]}%\'"…、。，！？')


def join(left, right):
    left, right = left.strip(), right.strip()
    if not left or not right:
        return left or right
    if right[0] in NO_SPACE_BEFORE or left[-1] in '([{':
        return left + right
    return left + ' ' + right


def emit(**event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + '\n')
    sys.stdout.flush()


class Session:
    def __init__(self, language):
        self.language = language or None
        self.audio = np.zeros(0, np.float32)
        self.settled, self.offset, self.drafted, self.shown = '', 0, 0, ''
        self.finishing = False


def load(folder, device='cpu'):
    from faster_whisper import WhisperModel
    threads = max(4, (os.cpu_count() or 8) // 2)
    return WhisperModel(str(folder), device=device, compute_type='int8' if device == 'cpu' else 'int8_float16', cpu_threads=threads)


def warm(model):
    # The first pass compiles the graphics card's kernels (about 9 s on an RTX 5080); pay it before the owner speaks.
    noise = (np.random.default_rng(0).standard_normal(RATE) * 0.01).astype(np.float32)
    for _ in model.transcribe(noise, language='en', beam_size=1, vad_filter=False)[0]:
        pass


def open_model(folder, runtime=None):
    """The model on the NVIDIA card when the speech-gpu libraries are installed and a card answers, else the CPU."""
    from pathlib import Path
    import ctranslate2
    libraries = sorted(Path(runtime, 'nvidia').glob('*/bin')) if runtime else []
    for library in libraries:
        os.add_dll_directory(str(library))
        os.environ['PATH'] = str(library) + os.pathsep + os.environ.get('PATH', '')
    try:
        cards = ctranslate2.get_cuda_device_count()
    except Exception:
        cards = 0
    problem = ''
    if libraries and cards:
        try:
            model = load(folder, 'cuda')
            warm(model)
            return model, 'cuda', cards, problem
        except Exception as error:
            problem = str(error)[:200]
    model = load(folder, 'cpu')
    warm(model)
    return model, 'cpu', cards, problem


def transcribe(model, audio, language, final):
    segments, _ = model.transcribe(
        audio, language=language, beam_size=5 if final else 1, temperature=0.0, vad_filter=True,
        vad_parameters={'min_silence_duration_ms': 500}, condition_on_previous_text=False)
    return [segment for segment in segments if segment.no_speech_prob < 0.6 and segment.avg_logprob > -1.0]


def run(model, lines=sys.stdin):
    sessions, wake, closed = {}, threading.Condition(), threading.Event()

    def read():
        for line in lines:
            try:
                message = json.loads(line)
                op, key = message.get('op'), str(message.get('id', ''))
                with wake:
                    if op == 'start':
                        sessions[key] = Session(message.get('language'))
                    elif op == 'audio' and key in sessions:
                        pcm = np.frombuffer(base64.b64decode(message['pcm']), np.int16).astype(np.float32) / 32768
                        sessions[key].audio = np.concatenate((sessions[key].audio, pcm))
                    elif op == 'finish' and key in sessions:
                        sessions[key].finishing = True
                    elif op == 'cancel':
                        sessions.pop(key, None)
                    wake.notify()
            except Exception:
                continue
        closed.set()
        with wake:
            wake.notify()

    threading.Thread(target=read, daemon=True).start()
    while True:
        with wake:
            due = [(key, s) for key, s in sessions.items() if s.finishing or len(s.audio) - s.drafted >= STEP]
            if not due:
                if closed.is_set():
                    return
                wake.wait(0.25)
                continue
            # Finishing first: the owner is waiting on Done, not on a draft.
            key, session = sorted(due, key=lambda item: not item[1].finishing)[0]
            audio, finishing = session.audio.copy(), session.finishing
        try:
            tail = audio[session.offset:]
            segments = transcribe(model, tail, session.language, finishing) if len(tail) >= RATE // 4 else []
            text = ''.join(segment.text for segment in segments)
            with wake:
                if sessions.get(key) is not session:
                    continue  # cancelled while the model ran
                if finishing:
                    emit(id=key, type='final', text=join(session.settled, text))
                    sessions.pop(key, None)
                    continue
                session.drafted = len(audio)
                if len(tail) > SETTLE and len(segments) > 1:
                    session.settled = join(session.settled, ''.join(segment.text for segment in segments[:-1]))
                    session.offset += int(segments[-2].end * RATE)
                    text = segments[-1].text
                shown = join(session.settled, text)
                if shown != session.shown:
                    session.shown = shown
                    emit(id=key, type='partial', text=shown)
        except Exception as error:
            with wake:
                sessions.pop(key, None)
            emit(id=key, type='error', text=str(error)[:300])
