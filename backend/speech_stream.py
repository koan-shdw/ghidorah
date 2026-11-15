"""Dictation (R4): one Whisper model kept loaded, writing text while the owner speaks.

Main sends JSON lines on stdin and reads JSON lines on stdout. Audio arrives as 16 kHz mono 16-bit PCM in base64, the
format Claude's dictation streams. Silence never reaches the model (Whisper's own voice filter), so quiet rooms do
not turn into invented words.

Claude's way (Koan 2026-11-15): words appear as the owner talks, and what has
been finished stays put. The phrase being said gets quick guesses about twice a second. A pause of PAUSE (0.3 s, the
pause Claude's service ends a phrase on) gives everything not yet locked one careful pass with the full beam. That
text is locked, never to change again, once the owner pauses for BREAK (1 s) or goes on to another stretch: Whisper
ends whatever it is given with a full stop, so a stretch locked at every short pause would be cut into false
sentences, and a stretch is locked with its punctuation only when the model has heard what follows it. Done gives
the last unlocked stretch its careful pass, so it never waits on the whole recording.

A stretch is left out only when the model says both that it is not speech and that it is unsure of the words
(Whisper's own rule); either alone used to drop real words. The owner's own names (apps, models) reach the model as
hints, the way Claude's dictation sends key terms.
"""
import base64
import json
import os
import sys
import threading

import numpy as np

RATE = 16000
STEP = int(RATE * 0.5)       # new audio needed before the next look
PAUSE = int(RATE * 0.3)      # quiet that ends a phrase: what is not locked gets its careful pass
BREAK = RATE                 # quiet after which that text is locked whatever follows
LONGEST = RATE * 15          # unlocked audio is locked at this length, so every pass stays short
HINTS = 600                  # characters of the owner's names given to the model
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


def hint_text(names):
    """The owner's names as one line for the model: each once, in order, cut to HINTS characters."""
    seen, out = set(), []
    for name in names if isinstance(names, list) else []:
        name = ' '.join(str(name).split())[:60]
        if name and name.lower() not in seen and len(', '.join(out + [name])) <= HINTS:
            seen.add(name.lower())
            out.append(name)
    return ', '.join(out)


class Session:
    def __init__(self, language, hints=None):
        self.language = language or None
        self.hints = hint_text(hints)
        self.audio = np.zeros(0, np.float32)
        # locked: text that no longer changes. offset: the audio it covers. phrase: the careful pass of the audio up
        # to the last pause, as (where that pause is, its segments), kept so a pause is read carefully once.
        self.locked, self.offset, self.drafted, self.shown, self.phrase = '', 0, 0, '', None
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


def transcribe(model, audio, language, final, hints=''):
    # A careful pass keeps more sound around each stretch of speech, so a soft first or last word is not cut off.
    segments, _ = model.transcribe(
        audio, language=language, beam_size=5 if final else 1, temperature=0.0, vad_filter=True,
        vad_parameters={'min_silence_duration_ms': 500, 'speech_pad_ms': 600 if final else 400},
        condition_on_previous_text=False, hotwords=hints or None)
    return [segment for segment in segments if not (segment.no_speech_prob >= 0.6 and segment.avg_logprob <= -1.0)]


def speech_spans(audio):
    """The stretches of speech in the audio as (start, end) in samples, by Whisper's own voice filter. Two stretches
    are never closer than PAUSE."""
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    return [(span['start'], span['end']) for span in get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=PAUSE * 1000 // RATE, speech_pad_ms=0))]


def lock_point(spans, length):
    """The last pause in the audio: (the middle of it, how long it is, whether nothing was said after it). None while
    the owner has not paused."""
    point = None
    for index, (_, end) in enumerate(spans):
        last = index + 1 == len(spans)
        quiet = (length if last else spans[index + 1][0]) - end
        if quiet >= PAUSE:
            point = (end + min(quiet, RATE) // 2, quiet, last)
    return point


def text_of(segments):
    return ''.join(segment.text for segment in segments)


def draft(model, session, tail):
    """What to show for the audio not yet locked. Locks what can be locked on the way."""
    spans = speech_spans(tail) if len(tail) >= RATE // 4 else []
    point = lock_point(spans, len(tail))
    if not point:
        if len(tail) < LONGEST:
            guess = transcribe(model, tail, session.language, False, session.hints) if spans else []
            return join(session.locked, text_of(guess))
        # No pause in a long stretch: the finished segments of a quick pass are locked, so passes stay short.
        segments = transcribe(model, tail, session.language, False, session.hints)
        if len(segments) > 1:
            session.locked, session.offset, session.phrase = join(session.locked, text_of(segments[:-1])), session.offset + int(segments[-2].end * RATE), None
            segments = segments[-1:]
        return join(session.locked, text_of(segments))
    cut, quiet, last = point
    if session.phrase is None or abs(session.phrase[0] - cut) > RATE // 4:
        session.phrase = (cut, transcribe(model, tail[:cut], session.language, True, session.hints))
    segments, held = session.phrase[1], ''
    if quiet >= BREAK or len(tail) >= LONGEST or not segments:
        session.locked, session.offset, session.phrase = join(session.locked, text_of(segments)), session.offset + cut, None
    elif len(segments) > 1:
        # The owner went on after these: they are locked with the punctuation the model gave them in context.
        moved = min(cut, int(segments[-2].end * RATE))
        session.locked, session.offset, session.phrase = join(session.locked, text_of(segments[:-1])), session.offset + moved, (cut - moved, segments[-1:])
        held = segments[-1].text
    else:
        held = text_of(segments)
    rest = tail[cut:]
    guess = transcribe(model, rest, session.language, False, session.hints) if not last and len(rest) >= RATE // 4 else []
    return join(join(session.locked, held), text_of(guess))


def run(model, lines=sys.stdin, device='cpu'):
    sessions, wake, closed = {}, threading.Condition(), threading.Event()

    def read():
        for line in lines:
            try:
                message = json.loads(line)
                op, key = message.get('op'), str(message.get('id', ''))
                with wake:
                    if op == 'start':
                        sessions[key] = Session(message.get('language'), message.get('hints'))
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
            if finishing:
                # Done: only what is not locked yet is read, carefully.
                last = text_of(transcribe(model, tail, session.language, True, session.hints)) if len(tail) >= RATE // 4 else ''
                with wake:
                    if sessions.get(key) is session:
                        emit(id=key, type='final', text=join(session.locked, last))
                        sessions.pop(key, None)
                continue
            shown = draft(model, session, tail)
            with wake:
                if sessions.get(key) is not session:
                    continue  # cancelled while the model ran
                session.drafted = len(audio)
                if shown != session.shown:
                    session.shown = shown
                    emit(id=key, type='partial', text=shown)
        except Exception as error:
            with wake:
                sessions.pop(key, None)
            emit(id=key, type='error', text=str(error)[:300])
