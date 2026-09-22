"""Task-private, 15-second native Windows child census. No command lines or environment."""
import ctypes
from ctypes import wintypes
import json
import os
import pathlib
import sys
import time

parent, ready, stop, output = int(sys.argv[1]), *map(pathlib.Path, sys.argv[2:])
result = {"supported": sys.platform == "win32", "parent": parent, "samples": []}
if sys.platform != "win32":
    ready.touch()
    output.write_text(json.dumps(result))
    sys.exit(0)

kernel = ctypes.WinDLL("kernel32", use_last_error=True)
ULONG_PTR = ctypes.c_size_t

class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ULONG_PTR),
        ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", wintypes.LONG),
        ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260),
    ]

kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel.OpenProcess.restype = wintypes.HANDLE
kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
kernel.GetProcessHandleCount.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
invalid = ctypes.c_void_p(-1).value
started = time.monotonic()
ready.touch()
try:
    while not stop.exists() and time.monotonic() - started < 15:
        snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
        if snapshot == invalid:
            result["snapshotError"] = ctypes.get_last_error()
            break
        try:
            entry = PROCESSENTRY32W()
            entry.dwSize = ctypes.sizeof(entry)
            more = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
            while more:
                if entry.th32ParentProcessID == parent and entry.szExeFile.lower() == "powershell.exe":
                    sample = {"elapsedMs": round((time.monotonic() - started) * 1000),
                              "pid": entry.th32ProcessID, "threads": entry.cntThreads}
                    handle = kernel.OpenProcess(0x1000, False, entry.th32ProcessID)
                    if handle:
                        try:
                            times = [wintypes.FILETIME() for _ in range(4)]
                            if kernel.GetProcessTimes(handle, *[ctypes.byref(t) for t in times]):
                                values = [(t.dwHighDateTime << 32) + t.dwLowDateTime for t in times]
                                sample.update(created100ns=values[0], kernel100ns=values[2], user100ns=values[3])
                            handles = wintypes.DWORD()
                            if kernel.GetProcessHandleCount(handle, ctypes.byref(handles)):
                                sample["handles"] = handles.value
                        finally:
                            kernel.CloseHandle(handle)
                    else:
                        sample["openError"] = ctypes.get_last_error()
                    result["samples"].append(sample)
                more = kernel.Process32NextW(snapshot, ctypes.byref(entry))
        finally:
            kernel.CloseHandle(snapshot)
        time.sleep(0.25)
finally:
    result["elapsedMs"] = round((time.monotonic() - started) * 1000)
    output.write_text(json.dumps(result))
