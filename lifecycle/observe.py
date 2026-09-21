"""Opt-in external Windows observer. No product invocation or process mutation."""
import argparse
import hashlib
import json
import ntpath
import os
import re
import time
from pathlib import Path

from identity import HEAD, LEAVES, BACKUP, canonical, correlate, file_key
from windows_api import WinAPI

DRIVER = "ec9c1a13db8938e5a3eaa51fca2e981cde2395a9"


class Limit(Exception):
    pass


def validate_binding(binding):
    if binding.get("schema") != 1 or binding.get("candidateHead") != HEAD:
        raise ValueError("binding must name exact reviewed393")
    if binding.get("releasedDriver") != DRIVER or binding.get("driverVersion") != "2026.9.5":
        raise ValueError("unchanged released driver binding required")
    if not isinstance(binding.get("run"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", binding["run"]):
        raise ValueError("run must be a bounded ASCII correlation ID")
    for key in ("run", "harnessPid", "harnessCreated100ns", "harnessExecutable"):
        if not binding.get(key):
            raise ValueError("missing " + key)
    p = binding.get("packageParent", "")
    drive, tail = ntpath.splitdrive(p)
    if not (len(drive) == 2 and drive[1] == ":" and drive[0].isalpha()
            and tail.startswith("\\") and canonical(p).endswith(r"\npm\node_modules")
            and ".." not in p.split("\\") and "\0" not in p):
        raise ValueError("requires absolute local proof npm/node_modules parent")
    for name, low, high in (("seconds", 1, 3600), ("interval", 1, 60),
                            ("samples", 1, 720), ("maxBytes", 65536, 64 * 1024 * 1024)):
        v = binding.get(name)
        if type(v) is not int or not low <= v <= high:
            raise ValueError("invalid finite bound: " + name)
    if binding["seconds"] > binding.get("unchangedHarnessBudgetSeconds", 0):
        raise ValueError("observer must not extend existing harness budget")
    return binding


class Writer:
    def __init__(self, stream, binding, clock=time.monotonic):
        self.stream, self.binding, self.clock = stream, binding, clock
        self.start = clock()
        self.seq = self.bytes = 0

    def check(self):
        if self.clock() - self.start >= self.binding["seconds"]:
            raise Limit("wall-budget")

    def emit(self, kind, **payload):
        event = dict(payload, schema=1, kind=kind, run=self.binding["run"],
                     seq=self.seq, monotonicSeconds=self.clock() - self.start,
                     utcNs=str(time.time_ns()))
        data = json.dumps(event, sort_keys=True, ensure_ascii=True) + "\n"
        # Reserve enough for the only permitted post-cap record: terminal settlement.
        ceiling = self.binding["maxBytes"] - (0 if kind == "settled" else 4096)
        if self.bytes + len(data) > ceiling:
            raise Limit("output-budget")
        self.stream.write(data)
        self.stream.flush()
        self.seq += 1
        self.bytes += len(data)


def observe(api, binding, writer, sleep=time.sleep):
    reason, armed = "sample-limit", False
    writer.emit("start", binding=binding, observerPid=os.getpid(),
                limitations=["sampling-not-continuous", "no-handle-enumeration",
                             "no-kernel/protected-process-coverage",
                             "reopened-path-not-section-object-identity",
                             "cannot-attribute-historical35529432478"])
    try:
        writer.check()
        with api.handle(api.dll.OpenProcess(0x1000, False, binding["harnessPid"])) as h:
            if not h:
                raise ValueError("cannot bind harness process")
            harness = api.identity(h)
            writer.emit("harness", identity=harness)
            if (harness.get("created100ns") != binding["harnessCreated100ns"]
                    or canonical(harness.get("executable", "")) != canonical(binding["harnessExecutable"])
                    or harness.get("exited100ns") != "0"):
                raise ValueError("harness process incarnation mismatch")
        if harness.get("nativeMachine") != 0x8664:
            raise ValueError("native x64 Windows host identity required before arming")
        parent = api.file(binding["packageParent"])
        writer.emit("package-parent", file=parent)
        parent_nt = parent.get("ntPath")
        if not parent_nt or not file_key(parent):
            raise ValueError("package-parent identity unavailable")
        baseline = {}
        for leaf in LEAVES:
            writer.check()
            info = api.file(ntpath.join(binding["packageParent"], "openclaw", leaf))
            baseline[leaf] = info
            writer.emit("baseline", leaf=leaf, file=info)
            if not file_key(info) or not info.get("ntPath"):
                raise ValueError("both baseline leaf file identities required")
            # Junction/out-of-parent identities are not exact bound leaf paths.
            matched = correlate({"mappedPath": info["ntPath"]}, {}, parent_nt)
            if matched.get("leaf") != leaf or matched.get("package") != "openclaw":
                raise ValueError("baseline leaf resolves outside its exact active-package leaf")
        writer.emit("armed", parentNt=parent_nt, baseline=baseline)
        armed = True
        for sample in range(binding["samples"]):
            writer.check()
            # Refresh namespace without retaining file/directory handles through rename.
            current_parent = api.file(binding["packageParent"])
            if file_key(current_parent) != file_key(parent):
                raise ValueError("bound package-parent replaced/unavailable")
            writer.emit("sample", sample=sample)
            with os.scandir(binding["packageParent"]) as entries:
                packages = []
                for entry in entries:
                    writer.check()
                    if entry.name.casefold() == "openclaw" or BACKUP.fullmatch(entry.name):
                        packages.append(entry.name)
                        if len(packages) >= 256:
                            raise Limit("package-alias-cap")
            for package in sorted(packages):
                for leaf in LEAVES:
                    writer.check()
                    info = api.file(ntpath.join(binding["packageParent"], package, leaf))
                    writer.emit("alias", sample=sample, package=package, leaf=leaf, file=info)
            rows, error = api.processes(writer.check)
            writer.emit("process-snapshot", sample=sample, rows=rows, error=error)
            if error:
                writer.emit("gap", sample=sample, detail=error)
            identities = {}
            for row in rows:
                writer.check()
                pid = row["pid"]
                # Pin the process object through its entire scan (not PID-only reopens).
                with api.handle(api.dll.OpenProcess(0x400, False, pid)) as h:
                    if not h:
                        writer.emit("gap", sample=sample, process=row,
                                    detail=api.error("OpenProcess(PROCESS_QUERY_INFORMATION)"))
                        continue
                    before = api.identity(h)
                    identities[pid] = before
                    writer.emit("process", sample=sample, process=row, identity=before)
                    if (before.get("nativeMachine") != 0x8664
                            or before.get("processMachine") not in (0, 0x14c)
                            or not before.get("executable") or before.get("exited100ns") != "0"):
                        writer.emit("gap", sample=sample, pid=pid,
                                    detail="unsupported architecture/incomplete identity/exited")
                        continue

                    def emit_mapping(raw):
                        writer.check()
                        if "error" in raw:
                            writer.emit("gap", sample=sample, pid=pid, detail=raw)
                            return
                        # Keep exact basename matches even outside the package root as
                        # raw unrelated observations; never deduce identity by basename.
                        if ntpath.basename(raw["mappedPath"]).casefold() not in ("fs-safe-native.node", "koffi.node"):
                            return
                        match = correlate(raw, baseline, parent_nt)
                        if match["scope"] == "exact-leaf-path":
                            raw["reopenedFile"] = api.file("\\\\?\\GLOBALROOT" + raw["mappedPath"])
                        writer.emit("mapping", sample=sample, pid=pid,
                                    processIdentity=before, raw=raw,
                                    correlation=correlate(raw, baseline, parent_nt))

                    coverage = api.mappings(h, writer.check, emit_mapping)
                    after = api.identity(h)
                    writer.emit("scan-end", sample=sample, pid=pid, coverage=coverage, identity=after)
                    # All scan boundaries remain evidence gaps, never whole-OS absence.
                    writer.emit("gap", sample=sample, pid=pid, detail=coverage)
                    if before != after:
                        writer.emit("gap", sample=sample, pid=pid, detail="process changed/exited during scan")
            for row in rows:
                writer.check()
                child, parent_identity = identities.get(row["pid"]), identities.get(row["parentPid"])
                writer.emit("parent-link", sample=sample, pid=row["pid"], parentPid=row["parentPid"],
                            child=child, parent=parent_identity,
                            relation="snapshot-ppid-only; exited/reused parent unresolved")
            writer.emit("sample-end", sample=sample)
            if sample + 1 < binding["samples"]:
                remaining = binding["seconds"] - (writer.clock() - writer.start)
                if remaining <= 0:
                    raise Limit("wall-budget")
                sleep(min(binding["interval"], remaining))
    except Limit as exc:
        reason = str(exc)
    except Exception as exc:
        # Exception class/message remains raw evidence; never yields a ready/absence result.
        reason = "error"
        try:
            writer.emit("gap", detail={"exception": type(exc).__name__, "message": str(exc)})
        except Limit:
            reason = "output-budget-with-error"
    writer.emit("settled", reason=reason, armed=armed, holderConclusion="UNKNOWN",
                absenceProven=False, nativeAcceptance=False,
                handleDisposition="owned context managers closed or emitted an error; inspect gaps")
    return 0 if armed and reason in ("sample-limit", "wall-budget") else 2


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binding", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    binding_bytes = Path(args.binding).read_bytes()
    binding = validate_binding(json.loads(binding_bytes))
    # Output must not be in the watched package tree, including junction aliases.
    out = Path(args.output).resolve()
    parent = Path(binding["packageParent"]).resolve()
    if out == parent or parent in out.parents:
        raise ValueError("evidence cannot be inside watched package tree")
    api = WinAPI()  # fails on non-Windows; offline controls never call main
    binding["bindingSha256"] = hashlib.sha256(binding_bytes).hexdigest()
    with out.open("x", encoding="ascii", newline="\n") as stream:
        return observe(api, binding, Writer(stream, binding))


if __name__ == "__main__":
    raise SystemExit(main())
