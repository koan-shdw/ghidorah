"""Prepare immutable uploads. Reuse Hermes image encoding and its Poppler PDF path."""
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

# Gemini's video MIME types. Hermes's Gemini adapter sends a data: URL in an image_url part as inline data of its own type.
VIDEO_TYPES = {'.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mpeg': 'video/mpeg', '.mpg': 'video/mpg', '.mov': 'video/mov', '.avi': 'video/avi',
               '.flv': 'video/x-flv', '.webm': 'video/webm', '.wmv': 'video/wmv', '.3gp': 'video/3gpp'}


def prepare(file, name, output=False, strict=False):
    root = (Path(os.environ['HERMES_HOME']).parent / ('outputs' if output else 'attachments')).resolve()
    source = Path(file).resolve(strict=True)
    if not source.is_relative_to(root) or source.name != 'source':
        raise ValueError('Invalid attachment location')
    data = source.read_bytes()
    if not 0 < len(data) <= 25 * 1024 * 1024:
        raise ValueError('Choose a file between 1 byte and 25 MB.')
    try:
        return typed(source, data, name)
    except (ValueError, OSError, SyntaxError):
        # Like Claude Code, any file gets in (Koan, TRIS-TODO 1.2): a type Tris cannot show inline is saved and
        # named; the model copies it out with copy_chat_file. Previews keep their errors.
        if output or strict:
            raise
        return {'kind': 'file', 'parts': [{'type': 'text', 'text': f'Attached file (not shown inline): {name}, {len(data):,} bytes. '
                                           f'Copy it into the working folder with copy_chat_file (ID upload:{source.parent.name}), then read it.'}]}


def typed(source, data, name):
    if data.startswith(b'%PDF-'):
        return pdf(source)
    if Path(name).suffix.lower() in ('.docx', '.xlsx', '.pptx'):
        from documents import inspect_office
        return inspect_office(source, name)
    video = VIDEO_TYPES.get(Path(name).suffix.lower())
    if video:
        # ponytail: sent inline, so the 25 MB prepared-attachment limit caps videos near 18 MB; Gemini's File API lifts that.
        if len(data) * 4 / 3 + 1024 > 25 * 1024 * 1024:
            raise ValueError('Videos are limited to 18 MB for now. Attach a shorter clip.')
        return {'kind': 'video', 'parts': [{'type': 'image_url', 'image_url': {'url': 'data:' + video + ';base64,' + base64.b64encode(data).decode('ascii')}}]}
    from PIL import Image, UnidentifiedImageError
    try:
        with Image.open(source) as image:
            if getattr(image, 'n_frames', 1) != 1:
                raise ValueError('Animated images are not supported yet. Attach a still image.')
            image.verify()
    except UnidentifiedImageError:
        try:
            text = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            raise ValueError('This file format is not supported yet. Attach an image, PDF or UTF-8 text/code file.') from None
        if '\0' in text or any(ord(char) < 32 and char not in '\r\n\t' for char in text):
            raise ValueError('This file format is not supported yet.')
        if len(data) > 1024 * 1024:
            raise ValueError('Text attachments are limited to 1 MB. Attach a smaller file.')
        return {'kind': 'file', 'parts': [{'type': 'text', 'text': 'File contents (data):\n' + json.dumps({'name': name, 'text': text}, ensure_ascii=False)}]}
    return {'kind': 'image', 'parts': images([source])}


def images(paths):
    from agent.image_routing import build_native_content_parts
    parts, skipped = build_native_content_parts('', [str(p) for p in paths])
    if skipped:
        raise ValueError('The image could not be decoded.')
    # Original names are supplied by main; internal app paths are never sent.
    return [part for part in parts if part['type'] == 'image_url']


def pdf(source):
    binary = Path(__file__).resolve().parents[1] / 'runtime' / 'poppler' / 'Library' / 'bin'
    def run(tool, args):
        return subprocess.run([str(binary / (tool + '.exe')), *args], check=True, capture_output=True,
                              timeout=25, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    try:
        info = run('pdfinfo', [str(source)]).stdout.decode('utf-8', errors='replace')
        match = re.search(r'^Pages:\s+(\d+)', info, re.M)
        if not match or re.search(r'^Encrypted:\s+yes', info, re.M):
            raise ValueError('Use an unlocked PDF.')
        pages = int(match[1])
        if not 1 <= pages <= 20:
            raise ValueError('PDF attachments support up to 20 pages. Split this document first.')
        with tempfile.TemporaryDirectory(prefix='pdf-', dir=source.parent) as temporary:
            prefix = Path(temporary) / 'page'
            run('pdftoppm', ['-png', '-r', '120', '-f', '1', '-l', str(pages), str(source), str(prefix)])
            paths = sorted(Path(temporary).glob('page-*.png'), key=lambda p: int(p.stem.split('-')[-1]))
            if len(paths) != pages:
                raise ValueError('Not every PDF page could be rendered.')
            parts = []
            for number, page in enumerate(paths, 1):
                parts.extend([{'type': 'text', 'text': f'PDF page {number} of {pages}'}, *images([page])])
            return {'kind': 'pdf', 'pages': pages, 'parts': parts}
    except (FileNotFoundError, subprocess.SubprocessError):
        raise ValueError('The PDF could not be rendered. Check the file and the bundled PDF renderer.') from None


def capabilities(models):
    from agent.image_routing import _lookup_supports_vision
    from api_providers import model_identity
    result = {}
    for model in models:
        if model.startswith('claude-code:'):
            result[model] = True
        else:
            provider, name = model_identity(model)
            result[model] = _lookup_supports_vision(provider, name, {}) is True
    return result
