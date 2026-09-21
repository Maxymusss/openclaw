"""Pure fail-closed gates shared by the native runner and offline controls."""
import hashlib
import json
from identity import LEAVES, canonical, correlate, file_key, parse_events


def sha(data):
    return hashlib.sha256(data).hexdigest()


def same_process(actual, expected):
    return (type(actual.get('pid')) is int and actual['pid'] == expected.get('pid')
            and isinstance(actual.get('created100ns'), str)
            and actual['created100ns'].isdigit() and int(actual['created100ns']) > 0
            and actual['created100ns'] == expected.get('created100ns')
            and bool(actual.get('executable')) and bool(expected.get('executable'))
            and canonical(actual['executable']) == canonical(expected['executable']))


def records(raw, partial=False):
    if not isinstance(raw, bytes) or len(raw) > 67108864:
        raise ValueError('invalid/budget-exceeding evidence')
    if partial:
        # A live writer may have a partial tail; it cannot participate in admission.
        raw = raw[:raw.rfind(b'\n') + 1]
    return parse_events(raw.decode('ascii'))


def armed(raw, binding, binding_sha, observer, parent_file):
    rows = records(raw, partial=True)
    start = rows[0]
    if start.get('observerPid') != observer['pid']:
        raise ValueError('observer pid mismatch')
    expected = dict(binding, bindingSha256=binding_sha)
    if start.get('binding') != expected or any(r['run'] != binding['run'] for r in rows):
        raise ValueError('observer binding/run mismatch')
    arms = [i for i, r in enumerate(rows) if r['kind'] == 'armed']
    if len(arms) != 1:
        raise ValueError('missing/duplicate armed handshake')
    before = rows[:arms[0]]
    if [r['kind'] for r in before] != ['start','harness','package-parent','baseline','baseline']:
        raise ValueError('bad pre-arm sequence')
    ident = dict(before[1]['identity'], pid=binding['harnessPid'])
    if (not same_process(ident, {'pid':binding['harnessPid'], 'created100ns':binding['harnessCreated100ns'],
                                'executable':binding['harnessExecutable']})
            or ident.get('exited100ns') != '0' or ident.get('nativeMachine') != 0x8664):
        raise ValueError('harness identity mismatch')
    parent = before[2].get('file')
    if not file_key(parent) or file_key(parent) != file_key(parent_file):
        raise ValueError('package-parent identity mismatch')
    arm = rows[arms[0]]
    if canonical(arm['parentNt']) != canonical(parent_file['ntPath']):
        raise ValueError('package-parent path mismatch')
    base = arm.get('baseline', {})
    if set(base) != set(LEAVES):
        raise ValueError('missing leaf identity')
    for row, leaf in zip(before[3:], LEAVES):
        if row.get('leaf') != leaf or row.get('file') != base[leaf] or not file_key(base[leaf]):
            raise ValueError('baseline mismatch')
        match = correlate({'mappedPath':base[leaf]['ntPath']}, {}, arm['parentNt'])
        if match.get('leaf') != leaf or match.get('package') != 'openclaw':
            raise ValueError('baseline path escaped/rebound')
    if any(r['kind'] == 'settled' for r in rows):
        raise ValueError('observer already settled before update launch')
    return arm


def terminal(raw, binding, binding_sha, observer_exit, observer_pid):
    rows = records(raw)
    if rows[0].get('binding') != dict(binding, bindingSha256=binding_sha):
        raise ValueError('terminal binding mismatch')
    if any(r['run'] != binding['run'] for r in rows):
        raise ValueError('mixed run')
    endings = [i for i,r in enumerate(rows) if r['kind'] == 'settled']
    if endings != [len(rows)-1] or observer_exit != 0:
        raise ValueError('observer unsettled/failed')
    if type(observer_pid) is not int or observer_pid <= 0 or rows[0].get('observerPid') != observer_pid:
        raise ValueError('missing/wrong observer identity')
    arm_indices = [i for i,r in enumerate(rows) if r['kind']=='armed']
    if arm_indices != [5]:
        raise ValueError('missing/duplicate arming in final evidence')
    prefix = b''.join((json.dumps(r)+'\n').encode('ascii') for r in rows[:6])
    armed(prefix, binding, binding_sha, {'pid':observer_pid}, rows[2].get('file',{}))
    end = rows[-1]
    if end.get('armed') is not True or end.get('reason') not in ('wall-budget','sample-limit'):
        raise ValueError('observer unsuccessful terminal')
    return rows


def joins(rows, process):
    return [r for r in rows if r['kind'] == 'mapping' and same_process(
        dict(r.get('processIdentity',{}), pid=r.get('pid')), process)]


def smoke_matches(rows, process, baseline):
    found = set()
    for row in joins(rows, process):
        raw = row.get('raw', {})
        corr = row.get('correlation', {})
        leaf = corr.get('leaf')
        if (leaf in LEAVES and raw.get('type') == 0x40000
                and corr.get('scope') == 'exact-leaf-path'
                and corr.get('identity') == 'same-file-id-at-reopened-path'
                and file_key(raw.get('reopenedFile')) == file_key(baseline[leaf])):
            found.add(leaf)
    if found != set(LEAVES):
        raise ValueError('positive external mapped-file fixture not demonstrated')
    return sorted(found)
