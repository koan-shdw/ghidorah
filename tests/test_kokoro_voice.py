"""The voice that speaks replies (Kokoro): its files are taken only when their size and hash match the pinned record,
a request is checked against the voices the model has, two voices blend by their shares, and the worker speaks piece
by piece, a piece per job in turn, with nothing after a cancel. A stand-in model keeps this fast and needs no packages;
the real model needs the Voices install."""
import base64
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import kokoro_voice
import speech_models


class Kokoro:
    """Voices are single numbers so a blend can be read off; speech is the piece's own text."""
    def __init__(self):
        self.styles = {'af_heart': 1.0, 'am_onyx': 3.0, 'bf_emma': 5.0, 'zf_xiaobei': 9.0}

    def get_voices(self):
        return list(self.styles)

    def get_voice_style(self, name):
        return self.styles[name]


def lines(*messages):
    return io.StringIO(''.join(json.dumps(message) + '\n' for message in messages))


class Files(unittest.TestCase):
    def test_pinned_record(self):
        files = kokoro_voice.MODEL['files']
        self.assertEqual(set(files), {'kokoro-v1.0.onnx', 'voices-v1.0.bin'})
        self.assertEqual(sum(spec['size'] for spec in files.values()), 353746785)
        self.assertTrue(all(len(spec['sha256']) == 64 for spec in files.values()))
        self.assertTrue(kokoro_voice.MODEL['source'].startswith('https://github.com/thewh1teagle/kokoro-onnx/releases/download/'))

    def test_files_are_taken_only_when_they_match(self):
        record = {'release': 'r1', 'source': 'https://example.invalid/', 'files': {'model.onnx': {'size': 3, 'sha256': hashlib.sha256(b'abc').hexdigest()}}}
        saved, opened = kokoro_voice.MODEL, speech_models.urllib.request.urlopen
        kokoro_voice.MODEL = record
        try:
            with tempfile.TemporaryDirectory() as root:
                folder = kokoro_voice.directory(root)
                self.assertEqual(folder, Path(root).resolve() / 'models' / 'kokoro' / 'r1')
                with self.assertRaises(ValueError):
                    kokoro_voice.verified(root)
                asked = []
                for body in (b'abd', b'abcTOO-LONG'):
                    speech_models.urllib.request.urlopen = lambda url, **options: (asked.append(url), io.BytesIO(body))[1]
                    with self.assertRaises(ValueError):
                        kokoro_voice.install(root)
                    self.assertEqual(list(folder.iterdir()), [], 'a file that does not match is deleted, never used')
                speech_models.urllib.request.urlopen = lambda url, **options: io.BytesIO(b'abc')
                self.assertEqual(Path(kokoro_voice.install(root)), folder)
                self.assertEqual(asked[0], 'https://example.invalid/model.onnx')
                self.assertEqual(kokoro_voice.verified(root), folder)
                self.assertFalse((folder.parent / 'progress.json').exists())
                speech_models.urllib.request.urlopen = lambda url, **options: self.fail('a file already there and right is not fetched again')
                kokoro_voice.install(root)
                (folder / 'model.onnx').write_bytes(b'abd')
                with self.assertRaises(ValueError):
                    kokoro_voice.verified(root)
        finally:
            kokoro_voice.MODEL, speech_models.urllib.request.urlopen = saved, opened


class Voices(unittest.TestCase):
    def test_english_voices_only(self):
        self.assertEqual(kokoro_voice.english(Kokoro()), ['af_heart', 'am_onyx', 'bf_emma'])

    def test_a_request_is_checked(self):
        names = {'af_heart', 'am_onyx', 'bf_emma'}
        good = {'pieces': ['Hello.'], 'a': 'am_onyx', 'b': 'bf_emma', 'balance': 37, 'speed': 1.3}
        self.assertEqual(kokoro_voice.request(good, names), {**good, 'balance': 37.0, 'next': 0})
        self.assertEqual(kokoro_voice.request({**good, 'b': 'am_onyx'}, names)['b'], '', 'a voice is not blended with itself')
        self.assertEqual(kokoro_voice.request({'pieces': ['Hi.'], 'a': 'af_heart'}, names), {'pieces': ['Hi.'], 'a': 'af_heart', 'b': '', 'balance': 0.0, 'speed': 1.0, 'next': 0})
        for patch in ({'pieces': []}, {'pieces': ['']}, {'pieces': 'Hello.'}, {'pieces': ['x' * 2001]}, {'pieces': ['a'] * 401}, {'a': 'zf_xiaobei'}, {'b': 'nobody'},
                      {'balance': 101}, {'balance': True}, {'speed': 0.4}, {'speed': 2.1}, {'speed': '1'}):
            with self.assertRaises(ValueError, msg=str(patch)):
                kokoro_voice.request({**good, **patch}, names)

    def test_two_voices_blend_by_their_shares(self):
        kokoro = Kokoro()
        self.assertEqual(kokoro_voice.style(kokoro, 'af_heart'), 1.0)
        self.assertEqual(kokoro_voice.style(kokoro, 'af_heart', 'bf_emma', 0), 1.0)
        self.assertEqual(kokoro_voice.style(kokoro, 'af_heart', 'bf_emma', 25), 2.0)
        self.assertEqual(kokoro_voice.style(kokoro, 'af_heart', 'bf_emma', 100), 5.0)
        self.assertEqual(kokoro_voice.language('af_heart'), 'en-us')
        self.assertEqual(kokoro_voice.language('bf_emma'), 'en-gb')
        self.assertEqual(kokoro_voice.language('af_heart', 'bf_emma', 50), 'en-us', 'an even blend keeps the first voice\'s sounds')
        self.assertEqual(kokoro_voice.language('af_heart', 'bf_emma', 51), 'en-gb')


class Worker(unittest.TestCase):
    def run_worker(self, stream, speak=None):
        events, saved_emit, saved_speak = [], kokoro_voice.emit, kokoro_voice.speak
        kokoro_voice.emit = lambda **event: events.append(event)
        kokoro_voice.speak = speak or (lambda kokoro, piece, job: piece.encode())
        try:
            kokoro_voice.run(Kokoro(), stream)
        finally:
            kokoro_voice.emit, kokoro_voice.speak = saved_emit, saved_speak
        return events

    def test_pieces_in_order_then_the_end_and_two_jobs_take_turns(self):
        events = self.run_worker(lines({'op': 'speak', 'id': 'a', 'pieces': ['one', 'two', 'three'], 'a': 'af_heart'},
                                       {'op': 'speak', 'id': 'b', 'pieces': ['uno', 'dos'], 'a': 'am_onyx'}))
        said = lambda key: [base64.b64decode(event['pcm']).decode() for event in events if event['id'] == key and event['type'] == 'audio']
        self.assertEqual(said('a'), ['one', 'two', 'three'])
        self.assertEqual(said('b'), ['uno', 'dos'])
        self.assertEqual([event['index'] for event in events if event['id'] == 'a' and event['type'] == 'audio'], [0, 1, 2])
        self.assertTrue(all(event['rate'] == 24000 for event in events if event['type'] == 'audio'))
        order = [event['id'] for event in events if event['type'] == 'audio']
        if order[0] == 'a' and order[1] == 'b':   # both were asked before the first piece was made: they alternate
            self.assertEqual(order, ['a', 'b', 'a', 'b', 'a'])
        self.assertEqual(sorted(event['id'] for event in events if event['type'] == 'end'), ['a', 'b'])
        self.assertEqual(events[-1]['type'], 'end')

    def test_a_bad_request_is_told_and_a_piece_with_nothing_to_say_is_passed_over(self):
        def speak(kokoro, piece, job):
            if piece == '***':
                raise ValueError('Nothing to synthesize')
            return piece.encode()
        events = self.run_worker(lines({'op': 'speak', 'id': 'bad', 'pieces': ['Hi.'], 'a': 'zf_xiaobei'},
                                       {'op': 'speak', 'id': 'ok', 'pieces': ['one', '***', 'two'], 'a': 'af_heart'}, 'not json at all'), speak)
        self.assertIn({'id': 'bad', 'type': 'error', 'text': 'Choose a voice from the list.'}, events)
        self.assertEqual([base64.b64decode(event['pcm']).decode() for event in events if event['id'] == 'ok' and event['type'] == 'audio'], ['one', 'two'])
        self.assertEqual(events[-1], {'id': 'ok', 'type': 'end'})

    def test_nothing_after_a_cancel_and_a_failure_ends_only_its_job(self):
        reader, writer = None, None
        import os
        read_end, write_end = os.pipe()
        reader, writer = os.fdopen(read_end, 'r', encoding='utf-8'), os.fdopen(write_end, 'w', encoding='utf-8')
        spoken = threading.Event()

        def speak(kokoro, piece, job):
            if piece == 'boom':
                raise RuntimeError('The model fell over.')
            if piece == 'first':
                # The cancel arrives while the model is making the first piece.
                writer.write(json.dumps({'op': 'cancel', 'id': 'stopped'}) + '\n')
                writer.write(json.dumps({'op': 'speak', 'id': 'broken', 'pieces': ['boom', 'never'], 'a': 'af_heart'}) + '\n')
                writer.write(json.dumps({'op': 'speak', 'id': 'after', 'pieces': ['still here'], 'a': 'af_heart'}) + '\n')
                writer.flush()
                spoken.wait(0.3)
                writer.close()
            return piece.encode()
        writer.write(json.dumps({'op': 'speak', 'id': 'stopped', 'pieces': ['first', 'second', 'third'], 'a': 'af_heart'}) + '\n')
        writer.flush()
        events = self.run_worker(reader, speak)
        reader.close()
        self.assertEqual([event for event in events if event['id'] == 'stopped'], [], 'nothing of a cancelled job, not even the piece being made')
        self.assertEqual([event for event in events if event['id'] == 'broken'], [{'id': 'broken', 'type': 'error', 'text': 'The model fell over.'}])
        self.assertEqual([event['type'] for event in events if event['id'] == 'after'], ['audio', 'end'])


if __name__ == '__main__':
    unittest.main()
