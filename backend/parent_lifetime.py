"""Watch the private supervisor pipe without locking the Windows CRT during native imports."""
import os
import subprocess
import sys
import threading
import time


def parent_guard():
    import ctypes
    from ctypes import wintypes
    import msvcrt
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    peek = kernel.PeekNamedPipe
    peek.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                     ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    peek.restype = wintypes.BOOL
    handle = msvcrt.get_osfhandle(sys.stdin.fileno())
    def watch():
        # A blocking background CRT read can deadlock native DLL initialization
        # on Windows. Observe pipe liveness without consuming or locking stdin.
        while peek(handle, None, 0, None, None, None):
            time.sleep(0.2)
        subprocess.run(['taskkill', '/PID', str(os.getpid()), '/T', '/F'],
                       creationflags=subprocess.CREATE_NO_WINDOW, stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    threading.Thread(target=watch, daemon=True).start()

