"""The dictation speech worker (R4): drafts while audio arrives, a final text on Done, nothing after Cancel, and
finished segments settle once 20 s of audio are unsettled. A stand-in model keeps this fast; the real model runs in
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


class Model:
    """Each 4 s of audio is one segment saying the number its samples carry, as real speech carries its words."""
    def __init__(self):
        self.calls = []

    def transcribe(self, audio, **options):
        self.calls.append((len(audio), options['beam_size']))
        count = len(audio) // (speech_stream.RATE * 4)
        words = [round(float(audio[index * speech_stream.RATE * 4]) * 32768 / 1000) for index in range(count)]
        return iter([SimpleNamespace(text=' w%d' % word, start=index * 4, end=(index + 1) * 4, no_speech_prob=0.1, avg_logprob=-0.2)
                     for index, word in enumerate(words)]), None


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
    return base64.b64encode((np.ones(int(speech_stream.RATE * seconds), np.int16) * 1000 * word).tobytes()).decode()


def collect(steps):
    lines, out, model = Lines(), io.StringIO(), Model()
    real = sys.stdout
    sys.stdout = out
    worker = threading.Thread(target=speech_stream.run, args=(model, lines))
    worker.start()
    try:
        steps(lines)
        lines.close()
        worker.join(10)
    finally:
        sys.stdout = real
    return [json.loads(line) for line in out.getvalue().splitlines()], model


def test_drafts_then_final_and_cancel_leaves_nothing():
    def steps(lines):
        lines.put(op='start', id='a', language='en')
        lines.put(op='audio', id='a', pcm=pcm(4, 0))
        time.sleep(0.5)
        lines.put(op='audio', id='a', pcm=pcm(4, 1))
        time.sleep(0.5)
        lines.put(op='finish', id='a')
        lines.put(op='start', id='b', language='')
        lines.put(op='audio', id='b', pcm=pcm(4))
        lines.put(op='cancel', id='b')
        time.sleep(0.5)
    events, model = collect(steps)
    a = [event for event in events if event.get('id') == 'a']
    assert [event['type'] for event in a][-1] == 'final' and a[-1]['text'] == 'w0 w1'
    assert any(event['type'] == 'partial' and event['text'] == 'w0' for event in a)
    assert not any(event.get('id') == 'b' and event['type'] in ('partial', 'final') for event in events[a.index(a[-1]):])
    assert model.calls[-1][1] == 5 or any(beam == 5 for _, beam in model.calls), 'Done decodes with the full beam'


def test_long_dictation_settles_finished_segments():
    def steps(lines):
        lines.put(op='start', id='long', language='en')
        for word in range(6):
            lines.put(op='audio', id='long', pcm=pcm(4, word))
            time.sleep(0.3)
        lines.put(op='finish', id='long')
        time.sleep(0.5)
    events, model = collect(steps)
    final = [event for event in events if event['type'] == 'final'][-1]
    assert final['text'] == 'w0 w1 w2 w3 w4 w5', final
    assert max(length for length, _ in model.calls) <= speech_stream.SETTLE + speech_stream.RATE * 8, 'passes stay short'


def test_spacing():
    assert speech_stream.join('Hello', ' world') == 'Hello world'
    assert speech_stream.join('Hello', ', world') == 'Hello, world'
    assert speech_stream.join('', ' x ') == 'x'


if __name__ == '__main__':
    for name, check in list(globals().items()):
        if name.startswith('test_'):
            check()
            print('PASS', name)
