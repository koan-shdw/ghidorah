"""The Windows parent lease must leave CRT stdin queries usable, then kill its process tree on EOF."""
from pathlib import Path
import json
import subprocess
import sys
import time
import ctypes
from ctypes import wintypes

APP=Path(__file__).resolve().parents[1]


def test_lease_does_not_lock_crt_and_ends_child_tree(tmp_path):
    record=tmp_path/'ready.json'
    code="""
import sys,os,json,time,subprocess
sys.path.insert(0,sys.argv[1])
from parent_lifetime import parent_guard
parent_guard()
time.sleep(.3)
# NumPy's native import checks CRT descriptors; a blocking os.read lease deadlocks here.
assert os.isatty(0) is False
child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],stdin=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)
from pathlib import Path
Path(sys.argv[2]).write_text(json.dumps({'child':child.pid}))
time.sleep(60)
"""
    process=subprocess.Popen([sys.executable,'-c',code,str(APP/'backend'),str(record)],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
    handle=None
    try:
        until=time.monotonic()+10
        while not record.exists() and time.monotonic()<until:time.sleep(.05)
        assert record.exists(),'The supervisor lease blocked a CRT stdin query'
        child=json.loads(record.read_text())['child']
        api=ctypes.WinDLL('kernel32',use_last_error=True)
        api.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];api.OpenProcess.restype=wintypes.HANDLE
        api.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD];api.CloseHandle.argtypes=[wintypes.HANDLE]
        handle=api.OpenProcess(0x00100000,False,child);assert handle
        process.stdin.close();process.wait(10)
        assert api.WaitForSingleObject(handle,10000)==0,'The child process survived its parent lease'
    finally:
        if process.poll() is None:subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'],creationflags=subprocess.CREATE_NO_WINDOW,capture_output=True)
        if handle:api.CloseHandle(handle)
