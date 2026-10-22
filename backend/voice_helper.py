"""The desktop voice helper has conversation context and no acting tools."""
import asyncio
import base64
from pathlib import Path
import tempfile

EDGE_VOICES = ('en-US-AriaNeural', 'en-US-GuyNeural', 'en-GB-SoniaNeural', 'en-GB-RyanNeural', 'en-AU-NatashaNeural', 'en-AU-WilliamNeural')


def answer(request, namespace):
    from routing_summary import summary_completion, reported_usage
    system, prompt = request.get('system'), request.get('prompt')
    if not isinstance(system, str) or not system or len(system) > 6000 or not isinstance(prompt, str) or not prompt or len(prompt) > 60000:
        raise ValueError('Voice context is too large.')
    response = summary_completion(request, namespace, [
        {'role': 'system', 'content': system}, {'role': 'user', 'content': prompt}], max_tokens=4000, timeout=60)
    text = response.choices[0].message.content
    if not isinstance(text, str) or not text.strip() or len(text) > 80000:
        raise ValueError('The voice helper returned no usable answer.')
    return {'text': text, 'usage': reported_usage(getattr(response, 'usage', None))}


def speech(request, root):
    text, voice = request.get('text'), request.get('voice')
    if not isinstance(text, str) or not text.strip() or len(text) > 66000 or voice not in EDGE_VOICES:
        raise ValueError('Invalid spoken text or voice.')
    from plugin_setup import check_runtime
    runtime = check_runtime(root, request.get('runtime'))
    if not runtime:
        raise ValueError('Install speech on the Voice page first.')
    from tools.lazy_deps import _activate_target_on_syspath
    _activate_target_on_syspath(runtime)
    import edge_tts  # Reviewed speech install only; this operation never installs packages.
    from tools import tts_tool
    tts_tool._import_edge_tts = lambda: edge_tts
    folder = Path(root).parent / 'voice-audio'
    folder.mkdir(parents=True, exist_ok=True)
    if folder.resolve() != folder.absolute():
        raise ValueError('The voice audio folder must not be linked.')
    with tempfile.TemporaryDirectory(prefix='speak-', dir=folder) as temporary:
        output = Path(temporary) / 'speech.mp3'
        asyncio.run(tts_tool._generate_edge_tts(text, str(output), {'edge': {'voice': voice}}))
        if not output.is_file() or not 1 <= output.stat().st_size <= 16 * 1024 * 1024:
            raise ValueError('Speech returned empty or oversized audio.')
        return {'audio': base64.b64encode(output.read_bytes()).decode('ascii'), 'mime': 'audio/mpeg'}
