"""Any dropped file gets into the chat (Koan, TRIS-TODO 1.2): types Tris cannot show inline are saved and named."""
import os
from pathlib import Path
import sys
import tempfile
import uuid

APP = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(APP / 'backend'), str(APP / 'runtime' / 'hermes')]
import attachments


def upload(root, data):
    folder = root / 'attachments' / str(uuid.uuid4())
    folder.mkdir(parents=True)
    (folder / 'source').write_bytes(data)
    return folder


def saved_file(result, folder, name, size):
    assert result['kind'] == 'file', result
    assert len(result['parts']) == 1 and result['parts'][0]['type'] == 'text'
    text = result['parts'][0]['text']
    assert name in text and f'{size:,} bytes' in text and 'upload:' + folder.name in text and 'copy_chat_file' in text, text


def check(root):
    os.environ['HERMES_HOME'] = str(root / 'hermes')
    # Koan's .ans art: CP437 bytes with ANSI escape codes. Refused before this change.
    art = b'\x1b[0;1;35m\xdb\xdb\xb0\xb1\xb2\x1b[0m SHDW\r\n' * 40
    folder = upload(root, art)
    saved_file(attachments.prepare(folder / 'source', 'optimize-image.classic.ans'), folder, 'optimize-image.classic.ans', len(art))
    # Previews keep the real error.
    try:
        attachments.prepare(folder / 'source', 'optimize-image.classic.ans', strict=True)
    except ValueError:
        pass
    else:
        raise AssertionError('a strict preview must keep its error')
    # Text over 1 MB is saved instead of refused.
    big = b'line\n' * 420_000
    folder = upload(root, big)
    saved_file(attachments.prepare(folder / 'source', 'log.txt'), folder, 'log.txt', len(big))
    # An animated image is saved instead of refused.
    from PIL import Image
    gif = root / 'anim.gif'
    frames = [Image.new('RGB', (8, 8), color) for color in ('red', 'blue')]
    frames[0].save(gif, save_all=True, append_images=frames[1:], duration=100, loop=0)
    folder = upload(root, gif.read_bytes())
    saved_file(attachments.prepare(folder / 'source', 'anim.gif'), folder, 'anim.gif', gif.stat().st_size)
    # Small UTF-8 text still goes inline, unchanged.
    folder = upload(root, b'hello')
    result = attachments.prepare(folder / 'source', 'note.txt')
    assert result['kind'] == 'file' and result['parts'][0]['text'].startswith('File contents (data):'), result
    # Size and location limits still refuse.
    for bad in (lambda: attachments.prepare(upload(root, b'x' * (25 * 1024 * 1024 + 1)) / 'source', 'huge.bin'),
                lambda: attachments.prepare(root / 'elsewhere', 'x.bin')):
        try:
            bad()
        except (ValueError, FileNotFoundError):
            pass
        else:
            raise AssertionError('limit not enforced')


def test_any_dropped_file_is_saved_and_named():
    with tempfile.TemporaryDirectory() as temporary:
        check(Path(temporary))


if __name__ == '__main__':
    test_any_dropped_file_is_saved_and_named()
    print('ok')
