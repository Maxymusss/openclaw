"""Unpublished SOURCE ONLY composition. Windows main is NOT executed by offline tests."""
import argparse
import json
import math
import os
import platform
import re
import subprocess
import sys
import time
from pathlib import Path
from control import armed, joins, same_process, sha, smoke_matches, terminal, terminal_rows
from identity import HEAD, LEAVES, canonical, file_key
from observe import DRIVER, validate_binding
from windows_api import WinAPI
from primary import primary_records
from host_contract import validate_host
from bounded_observe import verify_sidecar, smoke_capacity, POLICY

HERE = Path(__file__).resolve().parent
FINALIZATION_SECONDS = 60
OBSERVER_SETTLEMENT_SECONDS = 10

def sampling_coverage(rows):
    started=[r.get('sample') for r in rows if r.get('kind')=='sample']
    completed=[r.get('sample') for r in rows if r.get('kind')=='sample-end']
    full=started==list(range(60)) and completed==list(range(60))
    return {'sampleLimit':60,'intervalSeconds':60,'started':started,'completed':completed,
            'sampleLimitReached':full,'fullSampleCountGate':'PASS' if full else 'NOT_REACHED',
            'terminalReason':rows[-1].get('reason'),'exhaustiveCensus':False,
            'settlementIsNotFullCoverage':True}


def validation_capacity(seconds):
    projected=seconds*60 #60 samples /2 smoke samples, with2x throughput margin
    if not math.isfinite(seconds) or seconds<0 or projected>40:
        raise ValueError('same-job validation throughput cannot fit unchanged aggregate budget')
    return {'measuredSeconds':seconds,'projectedSeconds':projected,'reserveSeconds':FINALIZATION_SECONDS,
            'workloadMargin':2,'resultMarginSeconds':20,'notFutureWorkloadGuarantee':True}


def write(path, value):
    with Path(path).open('x', encoding='ascii', newline='\n') as f:
        f.write(json.dumps(value, sort_keys=True, ensure_ascii=True) + '\n')
        f.flush()


def process_identity(api, pid, handle=None):
    if handle is not None:
        return dict(api.identity(int(handle)), pid=pid)
    with api.handle(api.dll.OpenProcess(0x1000, False, pid)) as h:
        if not h:
            raise ValueError('cannot capture process incarnation')
        return dict(api.identity(h), pid=pid)


def require_native(api):
    me = process_identity(api, os.getpid())
    return validate_host(os.environ, os.name, sys.version_info, sys.getwindowsversion(), me, os.getpid())


def validate_manifest(path, digest):
    raw = Path(path).read_bytes()
    if sha(raw) != digest:
        raise ValueError('manifest digest mismatch')
    manifest = json.loads(raw)
    for name, expected in manifest['payload'].items():
        if '/' in name or '\\' in name or name in ('.','..'):
            raise ValueError('non-flat payload')
        if sha((HERE/name).read_bytes()) != expected:
            raise ValueError('sealed payload changed: ' + name)
    pin = json.loads((HERE/'python-pin.json').read_bytes())
    for name, expected in pin['members'].items():
        if sha((HERE/name).read_bytes()) != expected:
            raise ValueError('Python archive member changed: ' + name)
    if sha(Path(sys.executable).read_bytes()) != pin['exeSha256'] or Path(sys.executable).resolve().parent != HERE:
        raise ValueError('wrong Python executable')
    return manifest


def host():
    return {'node':platform.node(), 'version':platform.version(),
            'imageOS':os.environ.get('ImageOS'), 'imageVersion':os.environ.get('ImageVersion'),
            'run':os.environ.get('GITHUB_RUN_ID'), 'attempt':os.environ.get('GITHUB_RUN_ATTEMPT'),
            'workflowSha':os.environ.get('GITHUB_SHA'),
            'runnerName':os.environ.get('RUNNER_NAME'), 'runnerTemp':os.environ.get('RUNNER_TEMP'),
            'workspace':os.environ.get('GITHUB_WORKSPACE'), 'runtime':str(HERE),
            'pythonExecutable':str(Path(sys.executable).resolve())}


def held_handle_settlement(launch, terminal, pid, exit_code):
    """Bind exit to the same retained Popen handle without inventing an image path.

    Windows native35595738434 returned ERROR_GEN_FAILURE31 for the post-exit
    QueryFullProcessImageNameW call, while that handle still returned exact
    creation/exit times. The launch executable was queried while alive on THIS
    same handle. Preserve terminal raw errors; never substitute the cached path
    into terminalIdentity or accept a PID-reopened/changed incarnation.
    """
    result={'verified':False,'basis':'unproven'}
    if (type(pid) is not int or type(exit_code) is not int or launch.get('pid') != pid
            or terminal.get('pid') != pid or not same_process(launch,launch)
            or launch.get('exited100ns') != '0'
            or terminal.get('created100ns') != launch.get('created100ns')):
        return result
    try:
        created=int(launch['created100ns']); exited=int(terminal['exited100ns'])
    except (KeyError,TypeError,ValueError):
        return result
    if not 0 < created < exited:
        return result
    if any(v.get('nativeMachine') != 0x8664 or v.get('processMachine') != 0 for v in (launch,terminal)):
        return result
    if any(k.endswith('Error') or k == 'error' for k in launch):
        return result
    if any((k.endswith('Error') or k == 'error') and k != 'executableError' for k in terminal):
        return result
    if same_process(terminal,launch) and 'executableError' not in terminal:
        return {'verified':True,'basis':'same-retained-handle-and-terminal-image-query'}
    if (not terminal.get('executable') and terminal.get('executableError') ==
            {'api':'QueryFullProcessImageNameW','winerror':31}):
        return {'verified':True,'basis':'same-retained-handle-times-and-live-launch-image; post-exit-image-query31-retained'}
    return result


class Session:
    """One monotonic deadline, no kill/retry. Handles kept through identity capture."""
    def __init__(self, api, evidence, seconds):
        self.api, self.evidence = api, Path(evidence)
        self.evidence.mkdir(exist_ok=False)
        self.started = time.monotonic()
        self.deadline = self.started + seconds
        self.children = []
        self.result = {'schema':1,'host':host(),'deadlineSeconds':seconds,'commands':[],
                       'status':'UNSETTLED','holder':'UNKNOWN','historicalAttribution':False,
                       'nativeAcceptance':False}

    def launch(self, name, argv, cwd):
        if time.monotonic() >= self.deadline:
            raise ValueError('deadline before launch')
        record = {'name':name,'argv':argv,'cwd':str(cwd),'launch':'pending'}
        self.result['commands'].append(record)
        with (self.evidence/(name+'.stdout.log')).open('xb') as out, (self.evidence/(name+'.stderr.log')).open('xb') as err:
            try:
                child = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL,
                                         stdout=out, stderr=err, shell=False)
            except Exception as exc:
                record.update(launch='failed',error=repr(exc)); raise
        self.children.append((child,record))
        # Popen retains the Windows process handle, avoiding a PID reopen race.
        record.update(launch='started',pid=child.pid,
                      identity=process_identity(self.api,child.pid,child._handle))
        expected = {'pid':child.pid,'created100ns':record['identity'].get('created100ns'),
                    'executable':str(Path(argv[0]).resolve())}
        if not same_process(record['identity'], expected):
            raise ValueError('launched executable/identity mismatch')
        write(self.evidence/(name+'.launch.json'), record)
        return child, record['identity']

    def wait_for(self, read, child, max_seconds):
        until = min(self.deadline, time.monotonic()+max_seconds)
        error = None
        while time.monotonic() < until:
            if child.poll() is not None:
                raise ValueError('child exited before handshake')
            try:
                return read()
            except (ValueError, KeyError, OSError) as exc:
                error = exc
            time.sleep(min(.05, max(0, until-time.monotonic())))
        raise ValueError('handshake missing/bad before deadline: ' + str(error))

    def finish(self):
        # All children share the SAME deadline, including denial/launch-error paths.
        until=min(self.deadline,getattr(self,'work_deadline',self.deadline))
        while any(p.poll() is None for p,_ in self.children) and time.monotonic() < until:
            time.sleep(min(.05, max(0,until-time.monotonic())))
        for child, record in self.children:
            record.update(exitCode=child.poll(), exited=child.poll() is not None)
            try:
                record['terminalIdentity'] = process_identity(self.api,child.pid,child._handle)
            except Exception as exc:
                record['identityError'] = repr(exc)
            record['settlement'] = held_handle_settlement(record.get('identity',{}),
                record.get('terminalIdentity',{}), child.pid, child.poll())
        return all(p.poll() is not None and r['settlement']['verified'] for p,r in self.children)


def make_binding(session, package_parent, harness, run_id, smoke=False):
    origin = time.monotonic()
    reserve = 1 if smoke else FINALIZATION_SECONDS+OBSERVER_SETTLEMENT_SECONDS
    seconds = min(10 if smoke else 3600-reserve, math.floor(session.deadline-origin)-reserve)
    binding = dict(schema=1, run=run_id, candidateHead=HEAD, releasedDriver=DRIVER,
                   driverVersion='2026.9.5', packageParent=str(package_parent),
                   harnessPid=harness['pid'], harnessCreated100ns=harness['created100ns'],
                   harnessExecutable=harness['executable'], unchangedHarnessBudgetSeconds=3600,
                   seconds=seconds, interval=1 if smoke else 60,
                   samples=2 if smoke else 60, maxBytes=67108864, outputPolicy=POLICY)
    if not smoke:
        binding['observationStartMonotonic'] = origin
    return validate_binding(binding)


def observer_terminal(output,binding,digest,code,pid,deadline=None):
    rows=primary_records(output,binding['maxBytes'],deadline)
    rows=terminal_rows(rows,binding,digest,code,pid,deadline)
    verify_sidecar(output,rows,binding,deadline=deadline)
    return rows


def start_observer(session, binding):
    binding_file = session.evidence/'binding.json'
    output = session.evidence/'observer.jsonl'
    write(binding_file,binding)
    digest = sha(binding_file.read_bytes())
    parent = session.api.file(binding['packageParent'])
    if not file_key(parent): raise ValueError('parent unavailable before observer')
    child, ident = session.launch('observer',[sys.executable,'-E','-S','-B',str(HERE/'bounded_observe.py'),
                                  '--binding',str(binding_file),'--output',str(output)], HERE)
    def check():
        live = process_identity(session.api,child.pid,child._handle)
        if not same_process(live,ident) or live.get('exited100ns') != '0':
            raise ValueError('observer incarnation changed/exited')
        arm = armed(output.read_bytes(),binding,digest,ident,parent)
        # Recheck every baseline immediately before granting admission, not just names.
        for leaf in LEAVES:
            current = session.api.file(str(Path(binding['packageParent'])/'openclaw'/Path(leaf)))
            if file_key(current) != file_key(arm['baseline'][leaf]):
                raise ValueError('baseline replaced between arming and launch')
        return arm
    arm = session.wait_for(check,child,20)
    session.result['arming'] = {'bindingSha256':digest,'observerIdentity':ident,'arm':arm}
    write(session.evidence/'armed.json',session.result['arming'])
    return child, binding, digest, output


def smoke_run():
    return 'observer393-product-' + os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT'] + '-smoke'


def smoke(args, api, me, manifest):
    if args.run != smoke_run(): raise ValueError('wrong fresh smoke namespace')
    session = Session(api,args.evidence,25)
    obs = fixture = None
    try:
        fixture_root = session.evidence/'fixture'
        fixture, ident = session.launch('fixture',[sys.executable,'-E','-S','-B',str(HERE/'fixture.py'),
                                                    '--root',str(fixture_root)],HERE)
        def ready():
            raw = (session.evidence/'fixture.stdout.log').read_bytes()
            if not raw.endswith(b'\n'): raise ValueError('incomplete fixture ready')
            data = json.loads(raw)
            if not same_process(data['process'],ident): raise ValueError('fixture identity mismatch')
            return data
        ready_data = session.wait_for(ready,fixture,5)
        binding = make_binding(session,fixture_root/'npm'/'node_modules',me,args.run,True)
        obs = start_observer(session,binding)
        session.finish()
        rows = observer_terminal(obs[3],obs[1],obs[2],obs[0].poll(),obs[0].pid)
        if fixture.poll() != 0: raise ValueError('fixture failed/unsettled')
        matched = smoke_matches(rows,ident,ready_data['baseline'])
        session.result.update(status='SMOKE_PASSED',run=args.run,matched=matched,manifestSha256=args.manifest_sha,
                              observerSha256=manifest['payload']['observe.py'],
                              observerEntrySha256=manifest['payload']['bounded_observe.py'],
                              pythonSha256=sha(Path(sys.executable).read_bytes()))
    except Exception as exc:
        session.result['error'] = repr(exc)
    finally:
        settled = session.finish()
        if not settled: session.result['status']='UNSETTLED'
        session.result['allExited']=settled
        write(session.evidence/'result.json',session.result)
    return 0 if session.result['status']=='SMOKE_PASSED' else 2



def complete_diagnostic(session, rows, update, ident):
    if update.poll() is None: raise ValueError('update unsettled at unchanged deadline')
    commands=[r for r in session.result['commands'] if r['name']=='published-driver-update']
    if len(commands)!=1: raise ValueError('observation window missing update process record')
    end=commands[0].get('terminalIdentity',{})
    record=commands[0]
    # Object identity joins the record to THIS Popen, never a reopened PID or supplied boolean.
    if (not any(child is update and held is record for child,held in session.children)
            or record.get('identity') != ident):
        raise ValueError('observation window lost held update process')
    settlement=held_handle_settlement(ident,end,update.pid,update.poll())
    if not settlement['verified'] or record.get('settlement') != settlement:
        raise ValueError('observation window process settlement mismatch')
    session.result['updateSettlement']=settlement
    # FILETIME and utcNs are UTC epochs; preserve both originals in raw evidence.
    # This orders lifecycle boundaries only; it never certifies continuous coverage.
    try:
        arm_ns=int(next(r for r in rows if r['kind']=='armed')['utcNs'])
        settled_ns=int(rows[-1]['utcNs'])
        created_ns=(int(ident['created100ns'])-116444736000000000)*100
        exited_ns=(int(end['exited100ns'])-116444736000000000)*100
    except (KeyError,ValueError,TypeError,StopIteration) as exc:
        raise ValueError('observation window timing identity unavailable') from exc
    window={'armedUtcNs':str(arm_ns),'settledUtcNs':str(settled_ns),
            'updateCreatedUtcNs':str(created_ns),'updateExitedUtcNs':str(exited_ns),
            'within':0 < arm_ns <= created_ns < exited_ns <= settled_ns,
            'ordering':'UTC lifecycle boundaries; sampling/clock-adjustment gaps remain'}
    session.result['observationWindow']=window
    if not window['within']:
        raise ValueError('update outside observation window; unobserved tail or invalid timing')
    session.result['samplingCoverage']=sampling_coverage(rows)
    session.result.update(status='OBSERVATION_SETTLED', updateExitCode=update.returncode,
                          joinedMappingCount=len(joins(rows,ident)))


def validate_smoke(path, digest, bundle, manifest):
    """Recheck same-job raw proof before product setup and again before observation."""
    raw=Path(path).read_bytes()
    if not raw.endswith(b'\n') or sha(raw) != digest:
        raise ValueError('incomplete/changed smoke result')
    proof=json.loads(raw)
    if (proof.get('status') != 'SMOKE_PASSED' or proof.get('allExited') is not True
            or proof.get('manifestSha256') != bundle or proof.get('host') != host()
            or proof.get('host',{}).get('run') in ('35529432478','35596476995')
            or proof.get('matched') != sorted(LEAVES)
            or proof.get('observerSha256') != manifest['payload']['observe.py']
            or proof.get('observerEntrySha256') != manifest['payload']['bounded_observe.py']
            or proof.get('pythonSha256') != sha(Path(sys.executable).read_bytes())
            or proof.get('deadlineSeconds') != 25 or proof.get('run') != smoke_run()):
        raise ValueError('no exact-host/run/runtime/bundle positive smoke')
    commands=proof.get('commands',[])
    if len(commands)!=2 or sorted(r['name'] for r in commands)!=['fixture','observer']:
        raise ValueError('missing smoke child records')
    for record in commands:
        settle=held_handle_settlement(record.get('identity',{}),record.get('terminalIdentity',{}),record.get('pid'),record.get('exitCode'))
        if (record.get('launch')!='started' or record.get('exitCode')!=0 or record.get('exited') is not True
                or not settle['verified'] or record.get('settlement')!=settle):
            raise ValueError('incomplete smoke child settlement')
    fixture=next(r for r in commands if r['name']=='fixture')
    observer=next(r for r in commands if r['name']=='observer')
    root=Path(path).parent
    binding_raw=(root/'binding.json').read_bytes()
    binding=validate_binding(json.loads(binding_raw))
    if binding['run'] != smoke_run(): raise ValueError('smoke binding from another namespace')
    arming=proof['arming']
    if (arming['bindingSha256'] != sha(binding_raw)
            or not same_process(arming['observerIdentity'],observer['identity'])):
        raise ValueError('smoke arming changed')
    validation_start=time.monotonic()
    rows=observer_terminal(root/'observer.jsonl',binding,sha(binding_raw),observer['exitCode'],observer['pid'])
    smoke_capacity(root/'observer.jsonl',rows,binding)
    ready_raw=(root/'fixture.stdout.log').read_bytes()
    if not ready_raw.endswith(b'\n'):raise ValueError('truncated fixture readiness')
    ready=json.loads(ready_raw)
    if not same_process(ready['process'],fixture['identity']):raise ValueError('fixture PID reused')
    for leaf in LEAVES:
        if file_key(rows[5]['baseline'][leaf]) != file_key(ready['baseline'][leaf]):
            raise ValueError('fixture/observer baseline mismatch')
    if smoke_matches(rows,fixture['identity'],ready['baseline']) != proof['matched']:
        raise ValueError('positive smoke evidence changed')
    proof['validationCapacity']=validation_capacity(time.monotonic()-validation_start)
    return proof


def diagnostic(args, api, me, manifest):
    spec_raw = Path(args.spec).read_bytes()
    spec = json.loads(spec_raw)
    remaining = (int(spec['deadlineFiletime100ns']) - (time.time_ns()//100 + 116444736000000000))/10000000
    if not 0 < remaining <= 3600:
        raise ValueError('invalid/expired unchanged outer deadline')
    inherited_deadline = time.monotonic()+remaining
    # All gates precede observer launch, and product launch additionally requires arming.
    if spec['candidateHead'] != HEAD or spec['workflowSourceSha'] != host()['workflowSha'] or spec['candidateTree'] != 'd4bb6a0016a6aab695c9c6fe67b40c76f3d9ee6b' or spec['budgetSeconds'] != 3600:
        raise ValueError('exact393/deadline tuple changed')
    if sha(Path(spec['harnessSourcePath']).read_bytes()) != manifest['payload']['diagnostic.ps1']:
        raise ValueError('unsealed harness')
    if sha(Path(spec['node']).read_bytes()) != spec['nodeSha256']:
        raise ValueError('Node executable changed')
    release_raw=(HERE/'release-installed.json').read_bytes()
    if sha(release_raw) != manifest['releaseInstalledManifestSha256']:
        raise ValueError('released payload manifest changed')
    for relative, expected in json.loads(release_raw).items():
        if sha((Path(spec['packageParent'])/'openclaw'/relative).read_bytes()) != expected:
            raise ValueError('released installed source mismatch: '+relative)
    bound_smoke=validate_smoke(Path(spec['smokeResult']),spec['smokeSha256'],args.manifest_sha,manifest)
    harness = process_identity(api,spec['harness']['pid'])
    if not same_process(harness,spec['harness']) or harness.get('exited100ns') != '0':
        raise ValueError('PowerShell PID incarnation mismatch')
    remaining = inherited_deadline-time.monotonic()
    if remaining < FINALIZATION_SECONDS+3: raise ValueError('deadline exhausted before observation')
    session = Session(api,args.evidence,remaining)
    session.work_deadline=session.deadline-FINALIZATION_SECONDS
    session.result['validationCapacity']=bound_smoke['validationCapacity']
    session.result['aggregateBudgetSeconds']=3600
    session.result['finalizationReserveSeconds']=FINALIZATION_SECONDS
    obs = update = None
    try:
        session.result.update(specSha256=sha(spec_raw), manifestSha256=args.manifest_sha)
        binding = make_binding(session,spec['packageParent'],harness,args.run)
        obs = start_observer(session,binding)
        if obs[0].poll() is not None: raise ValueError('observer exited after arming')
        argv = [spec['node'],str(Path(spec['packageParent'])/'openclaw'/'openclaw.mjs'),
                'update','--channel','dev','--yes','--json','--no-restart','--timeout','1200']
        update, ident = session.launch('published-driver-update',argv,spec['proofRoot'])
        session.finish()
        rows = observer_terminal(obs[3],obs[1],obs[2],obs[0].poll(),obs[0].pid,deadline=inherited_deadline-2)
        complete_diagnostic(session, rows, update, ident)
    except Exception as exc:
        session.result['error']=repr(exc)
    finally:
        settled=session.finish()
        if not settled: session.result['status']='UNSETTLED'
        session.result['allExited']=settled
        session.result['proofRootRetained']=spec['proofRoot']
        write(session.evidence/'result.json',session.result)
    return 0 if session.result['status']=='OBSERVATION_SETTLED' else 2


def main():
    p=argparse.ArgumentParser()
    p.add_argument('mode',choices=('smoke','preflight','diagnostic'))
    for opt in ('manifest','manifest-sha','evidence','run'): p.add_argument('--'+opt,required=True)
    p.add_argument('--spec')
    p.add_argument('--smoke-result'); p.add_argument('--smoke-sha')
    args=p.parse_args()
    # Manifest verification before loading Windows APIs; no alternate runtime route.
    manifest=validate_manifest(args.manifest,args.manifest_sha)
    api=WinAPI(); me=require_native(api)
    if args.mode=='preflight':
        checked=validate_smoke(Path(args.smoke_result),args.smoke_sha,args.manifest_sha,manifest)
        write(Path(args.evidence)/('capacity-'+args.run+'.json'), {'host':host(),'bundleSha256':args.manifest_sha,'smokeSha256':args.smoke_sha,'validationCapacity':checked['validationCapacity']})
        return 0
    return smoke(args,api,me,manifest) if args.mode=='smoke' else diagnostic(args,api,me,manifest)


if __name__=='__main__':
    raise SystemExit(main())
