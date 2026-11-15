"""The dictation speech worker (R4), Claude's way: quick guesses for the phrase being said, a careful pass at a pause,
text that is locked once the owner pauses for a second or goes on, a final text on Done from what is not locked yet,
and nothing after Cancel. A stand-in model and voice filter keep this fast; the real model runs in
tests/finish-dictation.e2e.ts."""
import base64
import io
import json
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import numpy as np
import speech_stream

RATE = speech_stream.RATE


def stretches(audio):
    """Runs of one spoken word: (start, end, word) in samples. Silence is zero; a word is its number held steady."""
    values = np.round(np.asarray(audio, np.float32) * 32768 / 1000).astype(int)
    edges = [0, *(np.flatnonzero(np.diff(values)) + 1).tolist(), len(values)]
    return [(start, end, int(values[start])) for start, end in zip(edges, edges[1:]) if end > start and values[start]]


def spans(audio):
    """The stand-in voice filter: speech wherever a word is held, stretches closer than PAUSE joined."""
    out = []
    for start, end, _ in stretches(audio):
        if out and start - out[-1][1] < speech_stream.PAUSE:
            out[-1] = (out[-1][0], end)
        else:
            out.append((start, end))
    return out


class Model:
    """Each word held in the audio is one segment saying its number, as real speech carries its words."""
    def __init__(self, unsure=()):
        self.calls, self.options, self.unsure = [], [], dict(unsure)

    def transcribe(self, audio, **options):
        self.calls.append((len(audio), options['beam_size']))
        self.options.append(options)
        # unsure: a word's (no_speech_prob, avg_logprob), as the real model scores a stretch it doubts.
        return iter([SimpleNamespace(text=' w%d' % word, start=start / RATE, end=end / RATE,
                                     no_speech_prob=self.unsure.get(word, (0.1, -0.2))[0], avg_logprob=self.unsure.get(word, (0.1, -0.2))[1])
                     for start, end, word in stretches(audio)]), None


class Lines:
    def __init__(self):
        self.queue, self.closed, self.wake = [], False, threading.Condition()

    def put(self, **message):
        with self.wake:
            self.queue.append(json.dumps(message) + '\n')
            self.wake.notify()

    def close(self):
        with self.wake:
            self.closed = True
            self.wake.notify()

    def __iter__(self):
        while True:
            with self.wake:
                while not self.queue and not self.closed:
                    self.wake.wait()
                if not self.queue:
                    return
                line = self.queue.pop(0)
            yield line


def pcm(seconds, word=0):
    """seconds of one word, or of silence when the word is 0."""
    return base64.b64encode((np.ones(int(RATE * seconds), np.int16) * 1000 * word).tobytes()).decode()


def collect(steps, unsure=()):
    lines, out, model = Lines(), io.StringIO(), Model(unsure)
    real, filter_ = sys.stdout, speech_stream.speech_spans
    sys.stdout, speech_stream.speech_spans = out, spans
    worker = threading.Thread(target=speech_stream.run, args=(model, lines, 'cpu'))
    worker.start()
    try:
        steps(lines)
        lines.close()
        worker.join(10)
    finally:
        sys.stdout, speech_stream.speech_spans = real, filter_
    return [json.loads(line) for line in out.getvalue().splitlines()], model


def say(lines, key, *parts, wait=0.25):
    for seconds, word in parts:
        lines.put(op='audio', id=key, pcm=pcm(seconds, word))
        time.sleep(wait)


def test_drafts_then_final_and_cancel_leaves_nothing():
    def steps(lines):
        lines.put(op='start', id='a', language='en')
        say(lines, 'a', (2, 1), (2, 2))
        lines.put(op='finish', id='a')
        lines.put(op='start', id='b', language='')
        lines.put(op='audio', id='b', pcm=pcm(2, 5))
        lines.put(op='cancel', id='b')
        time.sleep(0.5)
    events, model = collect(steps)
    a = [event for event in events if event.get('id') == 'a']
    assert [event['type'] for event in a][-1] == 'final' and a[-1]['text'] == 'w1 w2', a
    assert any(event['type'] == 'partial' and event['text'] == 'w1' for event in a), 'words appear while the owner talks'
    assert not any(event.get('id') == 'b' and event['type'] in ('partial', 'final') for event in events[events.index(a[-1]):])
    assert model.calls[-1] == (RATE * 4, 5), 'Done reads what is not locked with the full beam'
    assert all(beam == 1 for _, beam in model.calls[:-1]), 'no pause yet: every look is a quick guess'


# Koan 2026-11-15: the text shows as it is said, as Claude's dictation does. A finished phrase stays put.
def test_a_phrase_is_locked_after_a_second_of_quiet_and_never_read_again():
    def steps(lines):
        lines.put(op='start', id='p', language='en')
        say(lines, 'p', (2, 1), (1.2, 0), (2, 2), (2, 3))
        lines.put(op='finish', id='p')
        time.sleep(0.5)
    events, model = collect(steps)
    texts = [event['text'] for event in events if event['id'] == 'p']
    assert texts[-1] == 'w1 w2 w3', texts
    locked = texts.index('w1 w2') if 'w1 w2' in texts else len(texts)
    assert all(text.startswith('w1') for text in texts[texts.index('w1'):]), 'what was shown for the locked phrase never changes'
    assert locked < len(texts), 'the next phrase appears after the locked one'
    assert model.calls[-1][1] == 5 and model.calls[-1][0] <= RATE * 4.8, 'Done reads only what follows the lock (4.7 s), not the whole 7.2 s'
    careful = [length for length, beam in model.calls if beam == 5]
    assert careful[0] <= RATE * 3.2 and len(careful) == 2, 'the first phrase gets one careful pass at its pause, then Done one'
    assert max(length for length, _ in model.calls) <= RATE * 4.8, 'the locked phrase is never given to the model again'


def test_a_short_pause_gives_a_careful_pass_and_locks_only_what_the_owner_went_on_from():
    def steps(lines):
        lines.put(op='start', id='s', language='en')
        say(lines, 's', (1.5, 1), (0.5, 0))                      # one stretch, a 0.5 s pause: read carefully, not locked
        say(lines, 's', (1.5, 2), (0.5, 0))                      # the owner went on and paused again
        say(lines, 's', (1.5, 3))
        lines.put(op='finish', id='s')
        time.sleep(0.5)
    events, model = collect(steps)
    texts = [event['text'] for event in events if event['id'] == 's']
    assert texts[-1] == 'w1 w2 w3', texts
    assert texts[0] == 'w1' and 'w1 w2' in texts, texts
    first_careful = next(index for index, (_, beam) in enumerate(model.calls) if beam == 5)
    assert model.calls[first_careful][0] <= RATE * 2, 'the pause gives the first stretch its careful pass'
    # After the second pause w1 is locked (the owner went on to w2); Done then reads from w2 on, not from w1.
    assert model.calls[-1][1] == 5 and model.calls[-1][0] < RATE * 5.5, model.calls[-1]


def test_a_long_stretch_without_a_pause_is_locked_in_pieces_so_passes_stay_short():
    def steps(lines):
        lines.put(op='start', id='long', language='en')
        say(lines, 'long', *[(4, word) for word in range(1, 9)], wait=0.3)
        lines.put(op='finish', id='long')
        time.sleep(0.5)
    events, model = collect(steps)
    final = [event for event in events if event['type'] == 'final'][-1]
    assert final['text'] == ' '.join('w%d' % word for word in range(1, 9)), final
    assert max(length for length, _ in model.calls) <= speech_stream.LONGEST + RATE * 8, 'no pass reads the whole 32 s'


def test_a_stretch_is_left_out_only_when_it_is_both_no_speech_and_unsure():
    # w2: the model doubts the words. w3: it doubts there is speech. Each alone used to drop real words. w4: both.
    def steps(lines):
        lines.put(op='start', id='u', language='en')
        say(lines, 'u', *[(2, word) for word in range(1, 6)])
        lines.put(op='finish', id='u')
        time.sleep(0.5)
    events, _ = collect(steps, unsure={2: (0.1, -1.4), 3: (0.8, -0.3), 4: (0.8, -1.4)})
    final = [event for event in events if event['type'] == 'final'][-1]
    assert final['text'] == 'w1 w2 w3 w5', final


def test_the_owners_names_reach_the_model_as_hints():
    def steps(lines):
        lines.put(op='start', id='h', language='en', hints=['Ghidorah', 'KOAN.live', 'ghidorah', ''])
        say(lines, 'h', (2, 1), (2, 2))
        lines.put(op='finish', id='h')
        time.sleep(0.5)
    _, model = collect(steps)
    assert all(options['hotwords'] == 'Ghidorah, KOAN.live' for options in model.options), model.options[-1]
    assert model.options[-1]['vad_parameters']['speech_pad_ms'] > model.options[0]['vad_parameters']['speech_pad_ms'], 'a careful pass keeps more sound around speech'
    assert speech_stream.hint_text(['x' * 400] * 5) == 'x' * 60 and speech_stream.hint_text(None) == '' and len(speech_stream.hint_text(['name %d' % index for index in range(500)])) <= speech_stream.HINTS

    def bare(lines):
        lines.put(op='start', id='bare', language='en')
        lines.put(op='audio', id='bare', pcm=pcm(2, 7))
        lines.put(op='finish', id='bare')
        time.sleep(0.5)
    _, model = collect(bare)
    assert model.options[-1]['hotwords'] is None, 'no names, no hint'


def test_pauses_and_spacing():
    second = RATE
    assert speech_stream.lock_point([(0, second)], second + speech_stream.PAUSE - 1) is None, 'under 0.3 s is not a pause'
    assert speech_stream.lock_point([(0, second)], second * 2) == (second + second // 2, second, True)
    assert speech_stream.lock_point([(0, second), (second * 2, second * 3)], second * 3 + 10) == (second + second // 2, second, False), 'the owner went on'
    assert speech_stream.lock_point([(0, second), (second * 2, second * 3)], second * 5) == (second * 3 + second // 2, second * 2, True), 'the last pause counts'
    assert speech_stream.lock_point([], second) is None
    assert speech_stream.join('Hello', ' world') == 'Hello world'
    assert speech_stream.join('Hello', ', world') == 'Hello, world'
    assert speech_stream.join('', ' x ') == 'x'


if __name__ == '__main__':
    for name, check in list(globals().items()):
        if name.startswith('test_'):
            check()
            print('PASS', name)
