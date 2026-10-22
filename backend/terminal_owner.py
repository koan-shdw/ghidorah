"""Own an idle Electron terminal worker before it can launch a shell."""
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import sys
import threading
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime' / 'hermes'))
import psutil
from hermes_cli.local_runtime.processes import _WindowsJob


def main():
    request = json.loads(sys.stdin.buffer.readline())
    api = ctypes.WinDLL('kernel32', use_last_error=True)
    api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    api.OpenProcess.restype = wintypes.HANDLE
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    api.WaitForSingleObject.restype = wintypes.DWORD
    # Hold the actual process handle throughout identity validation and assignment.
    handle = api.OpenProcess(0x0100 | 0x0001 | 0x1000 | 0x00100000, False, request['pid'])
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    job = None
    watcher = None
    stopped = threading.Event()
    try:
        owner = psutil.Process()
        target = psutil.Process(request['pid'])
        parent = owner.parent()
        if (parent is None or parent.pid != request['parent'] or target.ppid() != parent.pid
                or Path(target.exe()) != Path(parent.exe()) or target.create_time() < owner.create_time()):
            raise ValueError('Terminal worker ownership could not be verified.')
        job = _WindowsJob()
        job.assign(SimpleNamespace(_handle=handle))
        parent_handle = api.OpenProcess(0x00100000, False, parent.pid)
        if not parent_handle:
            raise ctypes.WinError(ctypes.get_last_error())
        def watch_parent():
            try:
                while not stopped.is_set():
                    if api.WaitForSingleObject(parent_handle, 250) != 258:
                        job.close()
                        return
            finally:
                api.CloseHandle(parent_handle)
        watcher = threading.Thread(target=watch_parent, daemon=True)
        watcher.start()
        print(json.dumps({'ready': True}), flush=True)
        # EOF is the app lifetime lease. A crash closes the pipe and kills the job.
        sys.stdin.buffer.read()
    finally:
        stopped.set()
        if job is not None:
            job.close()
        if watcher is not None:
            watcher.join(1)
        api.CloseHandle(handle)


if __name__ == '__main__':
    main()
