"""Measured disposable-host contract; never rewrites host environment."""
import re
from control import same_process
ENV = {'RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'Windows','RUNNER_ARCH':'X64',
       'ImageOS':'win25-vs2026','ImageVersion':'20260907.229.1','GITHUB_RUN_ATTEMPT':'1'}
PRELOAD = ('NODE_OPTIONS','NODE_PATH','PYTHONSTARTUP','COR_ENABLE_PROFILING','CORECLR_ENABLE_PROFILING')
HISTORICAL_RUNS = {'35529432478','35596476995'}


def validate_host(env, os_name, python_version, windows_version, identity, pid):
    if any(env.get(k) != v for k,v in ENV.items()):
        raise ValueError('not the measured hosted image/attempt')
    if (not re.fullmatch(r'[1-9][0-9]*',env.get('GITHUB_RUN_ID',''))
            or env['GITHUB_RUN_ID'] in HISTORICAL_RUNS
            or not re.fullmatch(r'[0-9a-f]{40}',env.get('GITHUB_SHA',''))
            or env.get('PROOF_WORKFLOW_SHA') != env['GITHUB_SHA']
            or not all(env.get(k) for k in ('RUNNER_NAME','RUNNER_TEMP','GITHUB_WORKSPACE'))):
        raise ValueError('missing/frozen run or workflow/path identity')
    if os_name != 'nt' or tuple(python_version[:3]) != (3,13,7) or tuple(windows_version[:3]) != (10,0,26100):
        raise ValueError('wrong native OS/ABI or Python')
    if (identity.get('nativeMachine') != 0x8664 or identity.get('processMachine') != 0
            or identity.get('pid') != pid or identity.get('exited100ns') != '0'
            or not same_process(identity,identity)):
        raise ValueError('invalid/non-native controller identity')
    if any(env.get(k) for k in PRELOAD):
        raise ValueError('unqualified preload/profiler environment')
    return identity
