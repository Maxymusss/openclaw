"""Documented query-only Win32 primitives. Loading this module does not call Windows."""
import ctypes as C
import os
from contextlib import contextmanager

U32, U64, U16 = C.c_uint32, C.c_uint64, C.c_uint16
PTR, BOOL = C.c_void_p, C.c_int32
INVALID = C.c_void_p(-1).value


class FILETIME(C.Structure):
    _fields_ = [("low", U32), ("high", U32)]


class PROCESSENTRY(C.Structure):
    _fields_ = [("size", U32), ("usage", U32), ("pid", U32),
                ("heap", C.c_size_t), ("module", U32), ("threads", U32),
                ("parent", U32), ("priority", C.c_int32), ("flags", U32),
                ("exe", U16 * 260)]


class MEMORY(C.Structure):
    _fields_ = [("base", PTR), ("allocation", PTR), ("allocationProtect", U32),
                ("partition", U16), ("size", C.c_size_t), ("state", U32),
                ("protect", U32), ("type", U32)]


class FILEID(C.Structure):
    _fields_ = [("volume", U64), ("id", C.c_ubyte * 16)]


class FILEINFO(C.Structure):
    _fields_ = [("attributes", U32), ("created", FILETIME), ("accessed", FILETIME),
                ("written", FILETIME), ("volume", U32), ("sizeHigh", U32),
                ("sizeLow", U32), ("links", U32), ("indexHigh", U32), ("indexLow", U32)]


def ticks(ft):
    return (ft.high << 32) | ft.low


class WinAPI:
    def __init__(self):
        if os.name != "nt" or C.sizeof(PTR) != 8:
            raise RuntimeError("requires native 64-bit Windows Python; no fallback")
        self.dll = C.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "CreateToolhelp32Snapshot": (PTR, [U32, U32]),
            "Process32FirstW": (BOOL, [PTR, C.POINTER(PROCESSENTRY)]),
            "Process32NextW": (BOOL, [PTR, C.POINTER(PROCESSENTRY)]),
            "OpenProcess": (PTR, [U32, BOOL, U32]),
            "CloseHandle": (BOOL, [PTR]),
            "GetProcessTimes": (BOOL, [PTR] + [C.POINTER(FILETIME)] * 4),
            "QueryFullProcessImageNameW": (BOOL, [PTR, U32, C.c_wchar_p, C.POINTER(U32)]),
            "IsWow64Process2": (BOOL, [PTR, C.POINTER(U16), C.POINTER(U16)]),
            "VirtualQueryEx": (C.c_size_t, [PTR, PTR, C.POINTER(MEMORY), C.c_size_t]),
            "K32GetMappedFileNameW": (U32, [PTR, PTR, C.c_wchar_p, U32]),
            "CreateFileW": (PTR, [C.c_wchar_p, U32, U32, PTR, U32, U32, PTR]),
            "GetFileInformationByHandleEx": (BOOL, [PTR, C.c_int32, PTR, U32]),
            "GetFileInformationByHandle": (BOOL, [PTR, C.POINTER(FILEINFO)]),
            "GetFinalPathNameByHandleW": (U32, [PTR, C.c_wchar_p, U32, U32]),
        }
        for name, (restype, argtypes) in signatures.items():
            f = getattr(self.dll, name)
            f.restype, f.argtypes = restype, argtypes

    def error(self, api):
        return {"api": api, "winerror": C.get_last_error()}

    @contextmanager
    def handle(self, value):
        try:
            yield value
        finally:
            if value and value != INVALID:
                if not self.dll.CloseHandle(value):
                    raise OSError(C.get_last_error(), "CloseHandle failed")

    def processes(self, check):
        """Retain raw snapshot rows. Access/process churn errors are not absence."""
        h = self.dll.CreateToolhelp32Snapshot(2, 0)  # TH32CS_SNAPPROCESS
        if h == INVALID:
            return [], self.error("CreateToolhelp32Snapshot")
        rows = []
        with self.handle(h):
            entry = PROCESSENTRY()
            entry.size = C.sizeof(entry)
            ok = self.dll.Process32FirstW(h, C.byref(entry))
            while ok:
                check()
                rows.append({"pid": entry.pid, "parentPid": entry.parent,
                             "snapshotExe": bytes(entry.exe).decode("utf-16-le").split("\0")[0]})
                if len(rows) >= 4096:
                    return rows, {"api": "process-snapshot", "gap": "4096-process cap"}
                ok = self.dll.Process32NextW(h, C.byref(entry))
            if C.get_last_error() != 18:  # ERROR_NO_MORE_FILES
                return rows, self.error("Process32NextW")
        return rows, None

    def identity(self, h):
        created, exited, kernel, user = (FILETIME() for _ in range(4))
        if not self.dll.GetProcessTimes(h, C.byref(created), C.byref(exited),
                                       C.byref(kernel), C.byref(user)):
            return {"error": self.error("GetProcessTimes")}
        out = {"created100ns": str(ticks(created)), "exited100ns": str(ticks(exited))}
        buf, size = C.create_unicode_buffer(32768), U32(32768)
        if self.dll.QueryFullProcessImageNameW(h, 0, buf, C.byref(size)):
            out["executable"] = buf.value
        else:
            out["executableError"] = self.error("QueryFullProcessImageNameW")
        machine, native = U16(), U16()
        if self.dll.IsWow64Process2(h, C.byref(machine), C.byref(native)):
            out["processMachine"], out["nativeMachine"] = machine.value, native.value
        else:
            out["architectureError"] = self.error("IsWow64Process2")
        return out

    def file(self, path):
        # Access 0, OPEN_EXISTING, share READ|WRITE|DELETE. Never retain over a sample.
        # BACKUP_SEMANTICS allows the package-parent directory binding too.
        h = self.dll.CreateFileW(path, 0, 7, None, 3, 0x02000000, None)
        if h == INVALID:
            return {"path": path, "error": self.error("CreateFileW")}
        with self.handle(h):
            ident, info = FILEID(), FILEINFO()
            out = {"path": path}
            if self.dll.GetFileInformationByHandleEx(h, 18, C.byref(ident), C.sizeof(ident)):
                out.update(volume=f"{ident.volume:016x}", fileId=bytes(ident.id).hex())
            else:
                out["idError"] = self.error("GetFileInformationByHandleEx(FileIdInfo)")
            if self.dll.GetFileInformationByHandle(h, C.byref(info)):
                out.update(size=(info.sizeHigh << 32) | info.sizeLow,
                           created100ns=str(ticks(info.created)),
                           written100ns=str(ticks(info.written)), attributes=info.attributes)
            else:
                out["statError"] = self.error("GetFileInformationByHandle")
            buf = C.create_unicode_buffer(32768)
            n = self.dll.GetFinalPathNameByHandleW(h, buf, len(buf), 2)  # VOLUME_NAME_NT
            if 0 < n < len(buf):
                out["ntPath"] = buf.value
            else:
                out["pathError"] = self.error("GetFinalPathNameByHandleW")
            return out

    def mappings(self, h, check, emit):
        address = 0
        for count in range(65536):
            check()
            memory = MEMORY()
            n = self.dll.VirtualQueryEx(h, address, C.byref(memory), C.sizeof(memory))
            if not n:
                # ERROR_INVALID_PARAMETER can be end-of-space OR a race/error.
                # Preserve it; it is deliberately not a complete-census proof.
                return {"queries": count, "endAddress": hex(address),
                        "stop": self.error("VirtualQueryEx")}
            if n != C.sizeof(memory) or memory.size == 0 or (memory.base or 0) + memory.size <= address:
                return {"queries": count, "gap": "short/nonprogressing VirtualQueryEx result"}
            if memory.state == 0x1000 and memory.type in (0x1000000, 0x40000):  # COMMIT IMAGE/MAPPED
                buf = C.create_unicode_buffer(32768)
                length = self.dll.K32GetMappedFileNameW(h, memory.base, buf, len(buf))
                raw = {"address": hex(memory.base or 0), "allocation": hex(memory.allocation or 0),
                       "regionBytes": memory.size, "type": memory.type,
                       "state": memory.state, "protect": memory.protect,
                       "pathChars": length}
                if 0 < length < len(buf):
                    raw["mappedPath"] = buf.value
                    emit(raw)
                else:
                    emit(dict(raw, error=self.error("K32GetMappedFileNameW")))
            address = (memory.base or 0) + memory.size
        return {"queries": 65536, "gap": "per-process region cap"}
