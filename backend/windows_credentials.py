"""Windows Credential Manager; values cross only private stdin/stdout pipes."""
import ctypes
from ctypes import wintypes as w


class Credential(ctypes.Structure):
    _fields_ = [('Flags', w.DWORD), ('Type', w.DWORD), ('TargetName', w.LPWSTR),
                ('Comment', w.LPWSTR), ('LastWritten', w.FILETIME),
                ('CredentialBlobSize', w.DWORD), ('CredentialBlob', ctypes.POINTER(w.BYTE)),
                ('Persist', w.DWORD), ('AttributeCount', w.DWORD), ('Attributes', ctypes.c_void_p),
                ('TargetAlias', w.LPWSTR), ('UserName', w.LPWSTR)]


def _api():
    api = ctypes.WinDLL('Advapi32', use_last_error=True)
    api.CredReadW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.POINTER(ctypes.POINTER(Credential))]
    api.CredReadW.restype = w.BOOL
    api.CredWriteW.argtypes = [ctypes.POINTER(Credential), w.DWORD]
    api.CredWriteW.restype = w.BOOL
    api.CredDeleteW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD]
    api.CredFree.argtypes = [ctypes.c_void_p]
    return api


def get(name: str) -> bytes | None:
    api = _api()
    pointer = ctypes.POINTER(Credential)()
    if not api.CredReadW(name, 1, 0, ctypes.byref(pointer)):
        error = ctypes.get_last_error()
        if error == 1168:
            return None
        raise ctypes.WinError(error)
    try:
        return ctypes.string_at(pointer.contents.CredentialBlob, pointer.contents.CredentialBlobSize)
    finally:
        api.CredFree(pointer)


def put(name: str, value: bytes) -> None:
    if len(value) > 2560:
        raise ValueError('Credential exceeds Windows storage limit')
    blob = (w.BYTE * len(value)).from_buffer_copy(value)
    entry = Credential(Type=1, TargetName=name, CredentialBlobSize=len(value),
                       CredentialBlob=blob, Persist=2, UserName='Trismegistus')
    if not _api().CredWriteW(ctypes.byref(entry), 0):
        raise ctypes.WinError(ctypes.get_last_error())


def delete(name: str) -> None:
    if not _api().CredDeleteW(name, 1, 0) and ctypes.get_last_error() != 1168:
        raise ctypes.WinError(ctypes.get_last_error())
