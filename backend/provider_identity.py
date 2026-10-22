"""Associate in-memory bearer fingerprints with their credential provider."""
import hashlib

_providers = {}


def register(provider, token):
    if isinstance(token, str) and token:
        _providers.setdefault(hashlib.sha256(token.encode()).digest(), set()).add(provider)


def identify(authorization, candidates):
    if not authorization.startswith('Bearer '):
        raise PermissionError('Provider bearer identity is unavailable.')
    fingerprint = hashlib.sha256(authorization[7:].encode()).digest()
    matches = set(candidates) & _providers.get(fingerprint, set())
    if len(matches) != 1:
        raise PermissionError('Provider bearer identity is ambiguous or unavailable.')
    return matches.pop()
