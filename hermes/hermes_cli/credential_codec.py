"""Credential persistence seam for an embedding host's OS-backed encrypted store.

The host installs the codec before starting Hermes. Encrypted files never fall
back to plaintext or an empty store when the codec/key is unavailable.
"""
from typing import Callable

_seal: Callable[[dict], dict] | None = None
_open: Callable[[dict], dict] | None = None


class CredentialDecryptionError(OSError):
    pass


def configure(*, seal: Callable[[dict], dict], open_envelope: Callable[[dict], dict]) -> None:
    global _seal, _open
    _seal, _open = seal, open_envelope


def encode(data):
    return _seal(data) if _seal is not None else data


def decode(data):
    if not isinstance(data, dict) or data.get('credential_envelope') != 1:
        return data
    if _open is None:
        raise CredentialDecryptionError('Encrypted credentials require the embedding host')
    try:
        return _open(data)
    except Exception as exc:
        raise CredentialDecryptionError('Credential decryption failed; stored data is unchanged') from exc
