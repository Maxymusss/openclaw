"""Byte-only released dependency checks; never extracts or invokes package code."""
import argparse
import base64
import hashlib
import json
import tarfile
from pathlib import Path, PurePosixPath
from control import sha


def installed(root, members):
    for name, expected in members.items():
        if sha((Path(root)/name).read_bytes()) != expected:
            raise ValueError('released installed source mismatch: '+name)


def archive(path, pin, members):
    # Hash before parsing. There is no registry resolution after this check: the
    # supported installer receives this exact local .tgz, not a version/tag.
    if Path(path).stat().st_size != pin['archiveBytes']:
        raise ValueError('release archive size mismatch')
    h256=hashlib.sha256();h512=hashlib.sha512()
    with Path(path).open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):
            h256.update(block);h512.update(block)
    if (h256.hexdigest()!=pin['archiveSha256'] or
            'sha512-'+base64.b64encode(h512.digest()).decode()!=pin['dist']['integrity']):
        raise ValueError('release archive integrity mismatch')
    seen=set()
    with tarfile.open(path,'r:gz') as bundle:
        for item in bundle:
            if item.isdir():continue
            parts=PurePosixPath(item.name).parts
            if (not item.isreg() or len(parts)<2 or parts[0]!='package'
                    or '..' in parts or '\\' in item.name):
                raise ValueError('unsupported release member')
            name='/'.join(parts[1:])
            if name in seen or name not in members:
                raise ValueError('unexpected/duplicate release member')
            stream=bundle.extractfile(item)
            with stream:
                digest=hashlib.file_digest(stream,'sha256').hexdigest()
            if digest!=members[name]:raise ValueError('release member hash mismatch: '+name)
            seen.add(name)
    if seen!=set(members):raise ValueError('missing release member')


def main():
    p=argparse.ArgumentParser();p.add_argument('mode',choices=('archive','installed'))
    p.add_argument('--target',required=True);p.add_argument('--manifest',required=True);p.add_argument('--manifest-sha',required=True)
    args=p.parse_args()
    # Reuse exact Python/payload hash validation; importing WinAPI does not call it.
    from run import HERE, validate_manifest
    manifest=validate_manifest(args.manifest,args.manifest_sha)
    raw=(HERE/'release-installed.json').read_bytes()
    if sha(raw)!=manifest['releaseInstalledManifestSha256']:raise ValueError('wrong released member manifest')
    members=json.loads(raw)
    if args.mode=='archive':archive(args.target,json.loads((HERE/'release-pin.json').read_bytes()),members)
    else:installed(args.target,members)
    return 0


if __name__=='__main__':raise SystemExit(main())
