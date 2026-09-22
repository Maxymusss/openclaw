"""Byte-only released dependency checks; never extracts or invokes package code."""
import argparse
import base64
import hashlib
import json
import os
import stat
import tarfile
from pathlib import Path, PurePosixPath
from control import sha


MARKER = '.openclaw-lifecycle-pending'
ARCHIVE_SHA256 = '1fb6ef4fae447af14f1e3b1028334f39146d181a66a4cce2848d4f741c636340'
LIFECYCLE_SOURCES = {
    'scripts/lib/package-lifecycle-marker.mjs': '32c50197ecc6f10b78f9f8ef588b868e7cdf428233e00fb912044dee5da46e1a',
    'scripts/postinstall-bundled-plugins.mjs': '7e1f81b571636d0f0102ff7120b5de54973a12e1ece8044fe6f608efaf49f061',
}


def require_setup(root, members, setup):
    # The composed caller emits this only AFTER archive checks and the supported
    # same-setup installer returns with exact held-handle terminal settlement.
    # Marker absence alone never establishes successful lifecycle completion.
    if (not isinstance(setup, dict) or setup.get('schema') != 1
            or setup.get('archiveVerified') is not True
            or setup.get('archiveSha256') != ARCHIVE_SHA256
            or setup.get('target') != str(root) or setup.get('unsettled') is not False
            or MARKER not in members
            or any(members.get(n) != h for n, h in LIFECYCLE_SOURCES.items())):
        raise ValueError('unqualified released install setup')
    c = setup.get('command', {})
    if (c.get('name') != 'published-driver-install' or c.get('status') != 'TERMINAL'
            or type(c.get('exitCode')) is not int or c['exitCode'] != 0
            or c.get('timedOut', False) is not False or c.get('error') is not None
            or c.get('settlementError') is not None):
        raise ValueError('successful settled installer required')
    launch, terminal = c.get('identity', {}), c.get('terminalIdentity', {})
    if (not isinstance(launch.get('pid'), int) or launch['pid'] <= 0
            or any(launch.get(k) is None or launch[k] != terminal.get(k)
                   for k in ('pid', 'created100ns', 'processMachine', 'nativeMachine'))
            or launch.get('processMachine') != 0 or launch.get('nativeMachine') != 34404
            or launch.get('exited100ns') != '0' or launch.get('imageError') != 0
            or not launch.get('executable') or int(launch['created100ns']) <= 0
            or int(terminal.get('exited100ns', '0')) <= int(launch['created100ns'])):
        raise ValueError('installer held identity/terminal settlement required')
    if terminal.get('imageError') == 31 and terminal.get('executable') is None:
        settlement = 'same-held-handle-times; terminal-image-absent-error31-retained'
    elif (terminal.get('imageError') == 0
          and str(terminal.get('executable')).casefold() == launch['executable'].casefold()):
        settlement = 'same-held-handle-and-image'
    else:
        raise ValueError('uncertain terminal executable identity')
    if c.get('settlement') != settlement:
        raise ValueError('installer settlement classification mismatch')


def safe_parts(name):
    parts = name.split('/')
    if (not name or any(not x or x in ('.', '..') or x[-1] in ' .'
            or any(c in x for c in '\\:<>"|?*')
            or any(ord(c) < 32 for c in x)
            or x.split('.')[0].upper() in {'CON','PRN','AUX','NUL',
                *(f'COM{i}' for i in range(1,10)), *(f'LPT{i}' for i in range(1,10))}
            for x in parts)):
        raise ValueError('unsupported installed member path: '+name)
    return parts


def plain(path, directory=False):
    info = path.lstat()  # never Path.exists(): errors/dangling links are not absence
    if (stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400
            or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))):
        raise ValueError('unsupported installed filesystem entry: '+str(path))
    return info


def marker_absent(root):
    plain(root, directory=True)
    try:
        (root/MARKER).lstat()
    except FileNotFoundError:
        # Prove the containing directory remains readable and has no marker entry;
        # access errors, reparse points and dangling links never satisfy absence.
        with os.scandir(root) as entries:
            if any(e.name.casefold() == MARKER.casefold() for e in entries):
                raise ValueError('ambiguous pending lifecycle marker')
        plain(root, directory=True)
        return
    raise ValueError('pending lifecycle marker still present; incomplete install')


def installed(root, members, setup=None):
    root = Path(root)
    require_setup(root, members, setup)
    parts_by_name = {name: safe_parts(name) for name in members}
    # Reject ancestor links/junctions as well as leaf substitutions. Do not resolve
    # links into another tree and then claim bytes at the requested installed path.
    for parent in reversed((root, *root.parents)):
        plain(parent, directory=True)
    marker_absent(root)
    for name, expected in members.items():
        if name == MARKER:  # the sole exact, source-bound installed-state transition
            continue
        path = root
        for part in parts_by_name[name][:-1]:
            path /= part
            plain(path, directory=True)
        path /= parts_by_name[name][-1]
        before = plain(path)
        with path.open('rb') as stream:
            opened = os.fstat(stream.fileno())
            if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
                raise ValueError('installed member changed during open')
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            after = os.fstat(stream.fileno())
        last = plain(path)
        if any((x.st_dev, x.st_ino, x.st_size, x.st_mtime_ns) !=
               (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
               for x in (opened, after, last)) or digest != expected:
            raise ValueError('released installed source mismatch: '+name)
    marker_absent(root)


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
    p.add_argument('--setup');p.add_argument('--setup-sha')
    args=p.parse_args()
    # Reuse exact Python/payload hash validation; importing WinAPI does not call it.
    from run import HERE, validate_manifest
    manifest=validate_manifest(args.manifest,args.manifest_sha)
    raw=(HERE/'release-installed.json').read_bytes()
    if sha(raw)!=manifest['releaseInstalledManifestSha256']:raise ValueError('wrong released member manifest')
    members=json.loads(raw)
    if args.mode=='archive':archive(args.target,json.loads((HERE/'release-pin.json').read_bytes()),members)
    else:
        if not args.setup or not args.setup_sha:raise ValueError('same-setup receipt required')
        setup_raw=Path(args.setup).read_bytes()
        if sha(setup_raw)!=args.setup_sha:raise ValueError('same-setup receipt changed')
        installed(args.target,members,json.loads(setup_raw))
    return 0


if __name__=='__main__':raise SystemExit(main())
