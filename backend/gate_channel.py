"""The gate plugin's channel to the app (6b): set in memory by host.py's gateway operation, never in the
environment, on a command line or on disk, so no child process or log can carry it."""
import re

_settings = None


def configure(url, token, owner):
    global _settings
    if not (isinstance(url, str) and re.fullmatch(r'http://127\.0\.0\.1:\d{1,5}/?', url) and isinstance(token, str)
            and re.fullmatch(r'[0-9a-f]{64}', token) and isinstance(owner, str) and re.fullmatch(r'[1-9]\d{0,19}', owner)):
        raise ValueError('Invalid gate channel.')
    _settings = {'url': url.rstrip('/'), 'token': token, 'owner': owner}


def settings():
    return _settings
