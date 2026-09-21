"""Pure interpretation; never promote a path observation to absence or causation."""
import json
import ntpath
import re

HEAD = "393c80255dea6605a5665c6e0836d01fb6d18304"
LEAVES = (
    r"node_modules\@openclaw\fs-safe-win32-x64-msvc\fs-safe-native.node",
    r"node_modules\@koromix\koffi-win32-x64\win32_x64\koffi.node",
)
BACKUP = re.compile(r"\.openclaw\.package-backup-[0-9]+-[0-9]+", re.I)


def canonical(path):
    if not isinstance(path, str) or not path or "\0" in path:
        raise ValueError("missing/invalid path")
    return ntpath.normpath(path.replace("/", "\\")).casefold()


def classify(path, parent_nt):
    """Only exact suffixes inside the bound package parent, with a boundary."""
    path, parent = canonical(path), canonical(parent_nt)
    if not path.startswith(parent + "\\"):
        return None
    pieces = path[len(parent) + 1:].split("\\", 1)
    if len(pieces) != 2:
        return None
    package, relative = pieces
    if package != "openclaw" and not BACKUP.fullmatch(package):
        return None
    for leaf in LEAVES:
        if relative == canonical(leaf):
            return {"leaf": leaf, "package": package}
    return None


def file_key(info):
    if not isinstance(info, dict):
        return None
    volume, ident = info.get("volume"), info.get("fileId")
    if (not isinstance(volume, str) or not re.fullmatch(r"[0-9a-f]{16}", volume)
            or not isinstance(ident, str) or not re.fullmatch(r"[0-9a-f]{32}", ident)
            or int(ident, 16) == 0):
        return None
    return volume, ident


def correlate(mapping, baseline, parent_nt):
    """Reopened pathname identity is NOT the section object's identity."""
    matched = classify(mapping.get("mappedPath", ""), parent_nt)
    result = {"scope": "unrelated", "identity": "unresolved",
              "sectionIdentityProven": False, "causationProven": False}
    if not matched:
        return result
    result.update(scope="exact-leaf-path", **matched)
    old = baseline.get(matched["leaf"])
    now = mapping.get("reopenedFile")
    if file_key(old) and file_key(now):
        result["identity"] = ("same-file-id-at-reopened-path"
                              if file_key(old) == file_key(now)
                              else "different-file-id-at-reopened-path")
    result["gap"] = "mapping-to-path-reopen is non-atomic; rename/replacement/unmap may race"
    return result


def parse_events(text):
    if not isinstance(text, str) or not text.endswith("\n"):
        raise ValueError("incomplete NDJSON: final newline required")
    records = []
    for line in text.split("\n")[:-1]:
        if not line.strip():
            raise ValueError("empty NDJSON record")
        record = json.loads(line)
        if not isinstance(record, dict) or type(record.get("schema")) is not int or record.get("schema") != 1:
            raise ValueError("invalid event schema")
        if type(record.get("seq")) is not int or record.get("seq") != len(records) or not isinstance(record.get("kind"), str):
            raise ValueError("missing/reordered/duplicate event")
        records.append(record)
    if not records or records[0]["kind"] != "start":
        raise ValueError("missing start")
    run = records[0].get("run")
    if not isinstance(run, str) or not run or any(r.get("run") != run for r in records):
        raise ValueError("mixed/missing run identity")
    return records


def summarize(records):
    """Settlement is observer lifecycle only, never an acceptance decision."""
    terminal = [i for i, r in enumerate(records) if r["kind"] == "settled"]
    settled = terminal == [len(records) - 1]
    matches = sum(r["kind"] == "mapping" and
                  r.get("correlation", {}).get("scope") == "exact-leaf-path"
                  for r in records)
    return {"settled": settled, "mappedPathObservations": matches,
            "holderConclusion": "UNKNOWN",
            "absenceProven": False, "historicalAttribution": False,
            "nativeAcceptance": False,
            "gaps": [r for r in records if r["kind"] == "gap"]}
