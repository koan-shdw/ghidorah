"""Supplier catalog eligibility and account identity boundaries."""
import sys
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'backend'), str(ROOT / 'runtime/hermes')]
from api_providers import text_model, model_identity


class Catalog(unittest.TestCase):
    def test_alibaba_native_metadata(self):
        row = dict(model='future-chat', name='Future chat', features=['function-calling'], inference_metadata=dict(request_modality=['Text', 'Image'], response_modality=['Text']))
        self.assertTrue(text_model('alibaba', row)['vision'])
        self.assertEqual(model_identity(text_model('alibaba', row)['id']), ('alibaba', 'future-chat'))
        row['features'] = []
        self.assertIsNone(text_model('alibaba', row))
        row.update(features=['function-calling'], inference_metadata=dict(response_modality=['Video']))
        self.assertIsNone(text_model('alibaba', row))

    def test_openrouter_capabilities(self):
        row = dict(id='vendor/future-chat', architecture=dict(input_modalities=['text','image'], output_modalities=['text']), supported_parameters=['tools'])
        self.assertTrue(text_model('openrouter-api', row)['vision'])
        row['supported_parameters'] = []
        self.assertIsNone(text_model('openrouter-api', row))
        row.update(supported_parameters=['tools'], architecture=dict(output_modalities=['image']))
        self.assertIsNone(text_model('openrouter-api', row))

    def test_mistral_capabilities(self):
        # Supplier metadata controls eligibility even for unfamiliar model names.
        row = dict(id='future-model', capabilities=dict(completion_chat=True, function_calling=True, vision=True))
        self.assertTrue(text_model('mistral', row)['vision'])
        row['capabilities']['function_calling'] = False
        self.assertIsNone(text_model('mistral', row))
        row['capabilities'].update(function_calling=True, completion_chat=False)
        self.assertIsNone(text_model('mistral', row))

    def test_openai_media_excluded_and_subscription_distinct(self):
        for model in ['gpt-image-2', 'gpt-realtime', 'gpt-4o-transcribe', 'text-embedding-3-small', 'whisper-1', 'sora-2']:
            self.assertIsNone(text_model('openai-api', {'id': model}))
        self.assertEqual(model_identity('api:openai-api:gpt-6-astra'), ('openai-api', 'gpt-6-astra'))
        self.assertEqual(model_identity('gpt-6-astra'), ('openai-codex', 'gpt-6-astra'))

    def test_media_families_excluded_from_live_and_named_models(self):
        for provider, models in [
            ('xai', ['grok-imagine-video', 'grok-imagine-video-1.5', 'grok-imagine-video-1.5-lite']),
            ('xai-oauth', ['grok-imagine-video']),
            ('gemini', ['nano-banana-pro-preview', 'lyria-3-clip-preview', 'lyria-3-pro-preview', 'lyria-3.5']),
            ('vertex', ['google/lyria-3.5']),
            ('openrouter-api', ['google/nano-banana-pro-preview', 'x-ai/grok-imagine-video']),
        ]:
            for model in models:
                with self.subTest(provider=provider, model=model):
                    self.assertIsNone(text_model(provider, dict(id=model, name=model, supportedGenerationMethods=['generateContent'])))
        # Image/video input is still useful to a coding model; only generation families are excluded.
        self.assertIsNotNone(text_model('gemini', dict(name='models/gemini-3.8-flash', supportedGenerationMethods=['generateContent'])))
        self.assertIsNotNone(text_model('xai', dict(id='grok-4.6')))
        self.assertTrue(text_model('openrouter-api', dict(id='vendor/video-understanding-chat', architecture=dict(input_modalities=['text', 'image', 'video'], output_modalities=['text']), supported_parameters=['tools']))['vision'])


class Details(unittest.TestCase):
    def test_release_time_and_description(self):
        from api_providers import details
        self.assertEqual(details(dict(created=1790000000, description='  Best for   code ')), dict(created=1790000000000, description='Best for code'))
        self.assertEqual(details(dict(created_at='2026-09-01T00:00:00Z'))['created'], 1788220800000)
        self.assertEqual(details(dict(created=True, description='')), dict(created=None, description=None))
        self.assertEqual(details(dict(created='soon')), dict(created=None, description=None))
        self.assertEqual(text_model('mistral', dict(id='future-model', created=1790000000, description='Fast'))['created'], 1790000000000)


if __name__ == '__main__': unittest.main()
