"""Validate region ownership and credential migration without supplier traffic."""
import sys
import unittest
import os
import tempfile
import uuid
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from alibaba_connection import configuration, encode, read, REGIONS, refusal


class Connection(unittest.TestCase):
    def test_native_classifier_preserves_model_scope(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime/hermes'))
        import httpx
        from openai import APIStatusError
        from provider_profiles import install
        from agent.error_classifier import classify_api_error
        install()
        for code, reason in [('AllocationQuota.FreeTierOnly', 'model_entitlement'), ('AccessDenied.Unpurchased', 'model_entitlement'), ('InvalidApiKey', 'auth')]:
            body = {'error': {'code': code, 'message': 'Refused'}}
            error = APIStatusError('Refused', response=httpx.Response(403, request=httpx.Request('POST', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions'), json=body), body=body)
            result = classify_api_error(error, provider='alibaba', model='qwen-plus')
            self.assertEqual(result.reason.value, reason)
    def test_documented_model_refusals(self):
        self.assertEqual(refusal({'code': 'AllocationQuota.FreeTierOnly'}, 'qwen-plus')['code'], 'model_quota_exhausted')
        self.assertEqual(refusal({'error': {'code': 'AccessDenied.Unpurchased'}}, 'qwen-plus')['code'], 'model_entitlement')
        for body in (None, [], {'error': 'unavailable'}, {'code': 'ServiceUnavailable'}):
            self.assertIsNone(refusal(body, 'qwen-plus'))
    def test_regions_and_workspaces(self):
        for region in REGIONS:
            self.assertEqual(configuration(region, 'workspace-123')['baseUrl'],
                             f'https://workspace-123.{region}.maas.aliyuncs.com/compatible-mode/v1')
        self.assertEqual(configuration()['baseUrl'], 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1')
        for region in ('ap-northeast-1', 'eu-central-1'):
            with self.assertRaises(ValueError): configuration(region)

    def test_reject_endpoint_injection(self):
        for workspace in ('evil.com', 'x/y', 'x@evil', '-x', 'x-', 'x\ny', 'x' * 64):
            with self.assertRaises(ValueError): configuration('ap-southeast-1', workspace)
        with self.assertRaises(ValueError): configuration('unknown', 'workspace')

    def test_atomic_credential_roundtrip_and_legacy(self):
        key, config = read(encode('synthetic-key', 'ap-northeast-1', 'workspace-123'))
        self.assertEqual(key, 'synthetic-key')
        self.assertEqual(config['region'], 'ap-northeast-1')
        self.assertEqual(config['workspaceId'], 'workspace-123')
        self.assertEqual(read(b'old-key'), ('old-key', configuration()))
        self.assertEqual(read(None), ('', configuration()))

    def test_native_resolver_uses_owned_region_and_key(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime/hermes'))
        import windows_credentials as vault
        from provider_credentials import install
        from hermes_cli.auth import resolve_api_key_provider_credentials
        from hermes_constants import set_hermes_home_override
        namespace = 'Trismegistus/Test/alibaba-region-' + str(uuid.uuid4())
        previous = os.environ.get('DASHSCOPE_BASE_URL')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            try:
                vault.put(namespace + '/alibaba', encode('synthetic-owned-key', 'eu-central-1', 'workspace-123'))
                os.environ['DASHSCOPE_BASE_URL'] = 'https://unrelated.invalid/v1'
                install(root, namespace)
                for home in [root, root / 'profiles' / ('p-' + str(uuid.uuid4())), root]:
                    home.mkdir(parents=True, exist_ok=True)
                    set_hermes_home_override(home)
                    result = resolve_api_key_provider_credentials('alibaba')
                    self.assertEqual(result['api_key'], 'synthetic-owned-key')
                    self.assertEqual(result['base_url'], 'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1')
            finally:
                vault.delete(namespace + '/alibaba')
                set_hermes_home_override(None)
                if previous is None: os.environ.pop('DASHSCOPE_BASE_URL', None)
                else: os.environ['DASHSCOPE_BASE_URL'] = previous


if __name__ == '__main__': unittest.main()
