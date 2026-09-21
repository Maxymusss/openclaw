"""Finite dummy MEM_MAPPED owner; never loads a DLL or touches installed data."""
import argparse
import json
import mmap
import os
import time
from pathlib import Path
from identity import LEAVES
from windows_api import WinAPI


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root', required=True)
    args = p.parse_args()
    api = WinAPI()
    root = Path(args.root)
    root.mkdir(exist_ok=False)
    opened, maps = [], []
    try:
        files = {}
        for leaf in LEAVES:
            path = root / 'npm' / 'node_modules' / 'openclaw' / Path(leaf)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('xb') as out:
                out.write(b'PR125286 observer-only inert mapped-file fixture\n'.ljust(4096, b'\0'))
            f = path.open('rb'); opened.append(f)
            maps.append(mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ))
            files[leaf] = api.file(str(path))
        with api.handle(api.dll.OpenProcess(0x1000, False, os.getpid())) as h:
            process = dict(api.identity(h), pid=os.getpid())
        # stdout is retained verbatim by caller. A single newline is the ready handshake.
        print(json.dumps({'schema':1,'process':process,'baseline':files}), flush=True)
        time.sleep(15)
    finally:
        for m in maps: m.close()
        for f in opened: f.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
