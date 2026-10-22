"""Bounded image requests using the app's existing Hermes provider credentials."""
import base64
import io
import json
import os
from pathlib import Path
import warnings

LIMIT = 25 * 1024 * 1024
CATALOG = {
    'openai-api': {'label': 'OpenAI API', 'models': ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'], 'references': 4, 'transparency': True},
    'gemini': {'label': 'Google · Gemini', 'models': ['gemini-3.1-flash-image', 'gemini-3-pro-image'], 'references': 4, 'transparency': False},
    'xai': {'label': 'xAI · Grok', 'models': ['grok-imagine-image-2.0'], 'references': 4, 'transparency': False},
}


def credentials(provider, namespace):
    from provider_credentials import install
    from security import install_codec
    install_codec(namespace + '/encryption')
    install(Path(os.environ['HERMES_HOME']), namespace)
    from hermes_cli.auth import resolve_api_key_provider_credentials
    return resolve_api_key_provider_credentials(provider)


def information(namespace):
    rows = []
    for provider, spec in CATALOG.items():
        try:
            connected = bool(credentials(provider, namespace).get('api_key'))
        except Exception:
            connected = False
        rows.append({'id': provider, **spec, 'connected': connected})
    return {'providers': rows, 'billing': 'Uses the selected API account. ChatGPT and Claude subscriptions are separate. Access and credit are checked by the supplier when an image is requested.',
            'workflow': 'Choose a provider and model in Settings > Images first. generate_image creates one PNG in a fresh destination and saves it in Chat files. For edits, supply reference paths in the working folder or owned Chat files IDs. Originals are preserved. Inspect the output before claiming visual verification.',
            'limits': 'Up to 4 PNG/JPEG/WebP references, 25 MB total and 16 million pixels each. Cancellation stops local work; the supplier may finish and charge an already submitted request. Requests are never automatically retried.'}


def image_bytes(encoded, output=False):
    from PIL import Image
    if not isinstance(encoded, str) or not encoded or len(encoded) > (LIMIT * 4 // 3 + 4):
        raise ValueError('Image data must be between 1 byte and 25 MB.')
    try:
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > LIMIT:
            raise ValueError('Image exceeds 25 MB.')
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as img:
                if img.format not in ('PNG', 'JPEG', 'WEBP') or img.width * img.height > 16_000_000 or getattr(img, 'n_frames', 1) != 1:
                    raise ValueError('Use a still PNG, JPEG or WebP image up to 16 million pixels.')
                mime = Image.MIME[img.format]
                img.load()
                size = [img.width, img.height]
                if output and img.format != 'PNG':
                    buffer = io.BytesIO()
                    img.save(buffer, format='PNG')
                    raw = buffer.getvalue()
                    if len(raw) > LIMIT:
                        raise ValueError('PNG result exceeds 25 MB.')
        return raw, mime, size
    except ValueError:
        raise
    except Exception:
        raise ValueError('The image could not be decoded.') from None


def generate(request, namespace):
    attempted = False
    try:
        provider, model = request.get('provider'), request.get('model')
        spec = CATALOG.get(provider)
        if not spec or model not in spec['models']:
            raise ValueError('Choose an available image provider and model in Settings > Images.')
        prompt = request.get('prompt')
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 16000:
            raise ValueError('Enter an image prompt between 1 and 16,000 characters.')
        aspect = request.get('aspect', 'square')
        if aspect not in ('square', 'landscape', 'portrait'):
            raise ValueError('Choose square, landscape or portrait.')
        transparent = request.get('transparent', False)
        if not isinstance(transparent, bool) or transparent and not spec['transparency']:
            raise ValueError('Transparent backgrounds require the OpenAI API image connection.')
        sources = request.get('sources', [])
        if not isinstance(sources, list) or len(sources) > spec['references']:
            raise ValueError('Use up to four reference images.')
        images = [image_bytes(item) for item in sources]
        if sum(len(item[0]) for item in images) > LIMIT:
            raise ValueError('Reference images together must be at most 25 MB.')
        auth = credentials(provider, namespace)
        key = auth.get('api_key')
        if not key:
            raise ValueError('Connect ' + spec['label'] + ' in Settings > Connections.')
        base = {'openai-api': 'https://api.openai.com/v1', 'gemini': 'https://generativelanguage.googleapis.com/v1beta', 'xai': 'https://api.x.ai/v1'}[provider]
        # host.py has already validated that each fixture URL is loopback and test-only.
        if namespace.startswith('Trismegistus/Test/'):
            base = json.loads(os.environ.get('TRISMEGISTUS_TEST_API_URLS', '{}')).get(provider, base).rstrip('/')
        headers = {'x-goog-api-key': key} if provider == 'gemini' else {'Authorization': 'Bearer ' + key}
        ratio = {'square': '1:1', 'landscape': '3:2', 'portrait': '2:3'}[aspect]
        encoded = [base64.b64encode(raw).decode() for raw, _, _ in images]
        files = None
        if provider == 'gemini':
            endpoint = '/models/' + model + ':generateContent'
            body = {'contents': [{'role': 'user', 'parts': [{'text': prompt}] + [{'inlineData': {'mimeType': image[1], 'data': data}} for image, data in zip(images, encoded)]}],
                    'generationConfig': {'responseModalities': ['TEXT', 'IMAGE'], 'imageConfig': {'aspectRatio': ratio}}}
        else:
            endpoint = '/images/edits' if images else '/images/generations'
            body = {'model': model, 'prompt': prompt, 'n': 1}
            if provider == 'xai':
                body.update(response_format='b64_json', aspect_ratio=ratio)
                refs = [{'url': 'data:' + image[1] + ';base64,' + data, 'type': 'image_url'} for image, data in zip(images, encoded)]
                if len(refs) == 1:
                    body['image'] = refs[0]
                elif refs:
                    body['images'] = refs
            else:
                from plugins.image_gen._common import size_for
                body.update(size=size_for(aspect), quality='auto', output_format='png', background='transparent' if transparent else 'auto')
                if images:
                    files = [('image[]', ('reference-' + str(i) + '.png', raw, mime)) for i, (raw, mime, _) in enumerate(images)]
        import httpx
        with httpx.Client(timeout=httpx.Timeout(300, connect=20), follow_redirects=False) as client:
            attempted = True
            # No SDK retry or provider fallback: an ambiguous response could already be billed.
            with client.stream('POST', base + endpoint, headers=headers, **({'data': body, 'files': files} if files else {'json': body})) as response:
                if response.status_code != 200:
                    status = response.status_code
                    definite = 400 <= status < 500 and status not in (408, 409)
                    hints = {401: 'Check the API key in Connections.', 403: 'Check image-model access or account verification.', 402: 'Check the API account balance.', 429: 'Check account credit and rate limits.'}
                    return {'error': f'{spec["label"]} returned HTTP {status}. ' + hints.get(status, 'Check the supplier status before trying again.'), 'attempted': True, 'outcome': 'refused' if definite else 'unknown'}
                chunks, total = [], 0
                for chunk in response.iter_bytes():
                    total += len(chunk)
                    if total > 40 * 1024 * 1024:
                        raise ValueError('The image response exceeds the supported size.')
                    chunks.append(chunk)
                payload = json.loads(b''.join(chunks))
                request_id = response.headers.get('x-request-id') or response.headers.get('x-goog-request-id')
        if provider == 'gemini':
            parts = (payload.get('candidates') or [{}])[0].get('content', {}).get('parts', [])
            results = [part['inlineData']['data'] for part in parts if not part.get('thought') and part.get('inlineData', {}).get('mimeType', '').startswith('image/')]
            usage = payload.get('usageMetadata')
        else:
            results = [item['b64_json'] for item in payload.get('data', []) if item.get('b64_json') and item.get('respect_moderation') is not False]
            usage = payload.get('usage')
        if len(results) != 1:
            return {'error': 'The supplier returned no single usable image. Its safety or access rules may have declined this request. Check the prompt before trying again.', 'attempted': True, 'outcome': 'finished'}
        raw, _, size = image_bytes(results[0], output=True)
        return {'image': base64.b64encode(raw).decode(), 'provider': provider, 'model': model, 'size': size, 'usage': usage, 'requestId': request_id, 'attempted': True}
    except Exception as error:
        # Never include HTTP exception bodies, URLs, headers or credentials in model/UI errors.
        return {'error': str(error) if not attempted and isinstance(error, ValueError) else 'Image request did not finish. Check the supplier before retrying; it may have completed and charged this request.', 'attempted': attempted, 'outcome': 'unknown' if attempted else 'refused'}
