import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
import run
from host_contract import validate_host

class ProductCompletion(unittest.TestCase):
    def setUp(self):
        epoch=116444736000000000
        self.start={'pid':17,'created100ns':str(epoch+100),'exited100ns':'0','executable':r'C:\node.exe','nativeMachine':34404,'processMachine':0}
        self.end=dict(self.start,exited100ns=str(epoch+200),executableError={'api':'QueryFullProcessImageNameW','winerror':31})
        self.end.pop('executable')
        self.child=Mock();self.child.pid=17;self.child.poll.return_value=0;self.child.returncode=0
        self.record={'name':'published-driver-update','identity':self.start}
        self.s=object.__new__(run.Session);self.s.api=None;self.s.deadline=0
        self.s.children=[(self.child,self.record)];self.s.result={'commands':[self.record]}
        self.rows=[{'kind':'armed','utcNs':'5000'},{'kind':'settled','utcNs':'30000'}]
    def complete(self):
        with patch.object(run,'process_identity',return_value=self.end) as identity:
            self.s.finish()
            identity.assert_called_once_with(None,17,self.child._handle)
        run.complete_diagnostic(self.s,self.rows,self.child,self.start)
    def test_actual_terminal_error31_preserved(self):
        self.complete()
        self.assertEqual(self.s.result['status'],'OBSERVATION_SETTLED')
        self.assertNotIn('executable',self.record['terminalIdentity'])
        self.assertEqual(self.record['terminalIdentity']['executableError']['winerror'],31)
        self.assertIn('same-retained-handle',self.s.result['updateSettlement']['basis'])
    def test_normal_image(self):
        self.end.pop('executableError');self.end['executable']=self.start['executable'];self.complete()
    def test_nonzero_exit_observation_is_not_product_success(self):
        self.child.poll.return_value=1;self.child.returncode=1;self.complete()
        self.assertEqual(self.s.result['updateExitCode'],1)
        self.assertNotIn('nativeAcceptance',self.s.result)
    def test_strict_failures(self):
        original=copy.deepcopy(self.end)
        for change in ({'pid':18},{'created100ns':str(int(self.start['created100ns'])+1)},
                       {'exited100ns':'0'},{'exited100ns':'bad'}, {'executable':r'C:\other.exe'},
                       {'executableError':{'api':'QueryFullProcessImageNameW','winerror':5}},
                       {'executableError':None},{'architectureError':{'winerror':5}},{'nativeMachine':0xaa64},{'processMachine':0x14c}):
            with self.subTest(change=change):
                self.end=dict(original,**change)
                with self.assertRaises(ValueError):self.complete()
    def test_lost_popen_object_or_record(self):
        with patch.object(run,'process_identity',return_value=self.end):self.s.finish()
        for pair in ((Mock(),self.record),(self.child,dict(self.record))):
            self.s.children=[pair]
            with self.assertRaises(ValueError):run.complete_diagnostic(self.s,self.rows,self.child,self.start)
    def test_boolean_settlement_cannot_override_error(self):
        self.record['settlement']={'verified':True,'basis':'invented'};self.record['terminalIdentity']=self.end
        with self.assertRaises(ValueError):run.complete_diagnostic(self.s,self.rows,self.child,self.start)
    def test_unsettled_and_late_exit(self):
        self.child.poll.return_value=None
        with self.assertRaises(ValueError):self.complete()
        self.child.poll.return_value=0;self.rows[-1]['utcNs']='15000'
        with self.assertRaises(ValueError):self.complete()

class Host(unittest.TestCase):
    def setUp(self):
        self.env=dict(run.os.environ,RUNNER_ENVIRONMENT='github-hosted',RUNNER_OS='Windows',RUNNER_ARCH='X64',
            ImageOS='win25-vs2026',ImageVersion='20260907.229.1',GITHUB_RUN_ID='99999999999',GITHUB_RUN_ATTEMPT='1',
            GITHUB_SHA='a'*40,PROOF_WORKFLOW_SHA='a'*40,RUNNER_NAME='runner1',RUNNER_TEMP=r'D:\temp',GITHUB_WORKSPACE=r'D:\a')
        for k in ('NODE_OPTIONS','NODE_PATH','PYTHONSTARTUP','COR_ENABLE_PROFILING','CORECLR_ENABLE_PROFILING'):self.env.pop(k,None)
        self.me={'pid':123,'created100ns':'123','exited100ns':'0','executable':r'D:\python.exe','nativeMachine':34404,'processMachine':0}
    def admit(self):return validate_host(self.env,'nt',(3,13,7),(10,0,26100),self.me,123)
    def test_actual_inventory(self):self.assertEqual(self.admit(),self.me)
    def test_image_run_workflow_paths_preload(self):
        for k,v in [('ImageOS','win25'),('ImageVersion','other'),('GITHUB_RUN_ID','35596476995'),('GITHUB_RUN_ID','35529432478'),
                    ('GITHUB_RUN_ATTEMPT','2'),('GITHUB_SHA',''),('PROOF_WORKFLOW_SHA','b'*40),('RUNNER_TEMP',''),('RUNNER_NAME',''),('NODE_OPTIONS','--require x')]:
            with self.subTest(k=k,v=v),patch.dict(self.env,{k:v}):
                with self.assertRaises(ValueError):self.admit()
    def test_native_version_and_identity(self):
        for os_name,py,win in [('posix',(3,13,7),(10,0,26100)),('nt',(3,13,6),(10,0,26100)),('nt',(3,13,7),(10,0,20348))]:
            with self.assertRaises(ValueError):validate_host(self.env,os_name,py,win,self.me,123)
        for k,v in [('created100ns','0'),('pid',124),('exited100ns','1'),('nativeMachine',0xaa64),('executable','')]:
            with patch.dict(self.me,{k:v}):
                with self.assertRaises(ValueError):self.admit()

class SmokeBinding(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.data=json.loads(Path('smoke-control-fixture.json').read_text())
        self.data['proof']['observerEntrySha256']='unit-entry'
        self.manifest={'payload':{'observe.py':self.data['proof']['observerSha256'],'bounded_observe.py':'unit-entry'}}
        self.data['binding']['outputPolicy']=run.POLICY
        self.host=self.data['proof']['host'];self.bundle=self.data['proof']['manifestSha256']
        self.stack=[]
        for context in (patch.object(run,'host',return_value=self.host),patch.object(run,'smoke_run',return_value=self.data['binding']['run']),
                        patch.object(run.sys,'executable',str(self.root/'python.exe'))):
            context.start();self.stack.append(context)
        (self.root/'python.exe').write_bytes(b'unit runtime pin')
        self.data['proof']['pythonSha256']=run.sha(b'unit runtime pin')
    def tearDown(self):
        for context in reversed(self.stack):context.stop()
        self.tmp.cleanup()
    def admit(self,truncate=None):
        binding=(json.dumps(self.data['binding'])+'\n').encode()
        digest=run.sha(binding)
        import gzip,hashlib
        compressed=gzip.compress(b'');(self.root/'observer.jsonl.gaps.gz').write_bytes(compressed)
        for row in self.data['rows']:
            if row['kind']=='settled':row['gapSidecar']={'policy':run.POLICY,'complete':True,'records':0,'logicalBytes':0,'compressedBytes':len(compressed),'sha256':hashlib.sha256(b'').hexdigest(),'compressedSha256':hashlib.sha256(compressed).hexdigest()}
        rows=self.data['rows'];rows[0]['binding']=dict(self.data['binding'],bindingSha256=digest)
        for i,r in enumerate(rows):r.update(seq=i,run=self.data['binding']['run'])
        self.data['proof']['arming']['bindingSha256']=digest
        raw=(json.dumps(self.data['proof'])+'\n').encode()
        files={'binding.json':binding,'observer.jsonl':b''.join((json.dumps(r)+'\n').encode() for r in rows),
               'fixture.stdout.log':(json.dumps(self.data['ready'])+'\n').encode(),'result.json':raw}
        if truncate:files[truncate]=files[truncate][:-1]
        for n,v in files.items():(self.root/n).write_bytes(v)
        return run.validate_smoke(self.root/'result.json',run.sha(files['result.json']),self.bundle,self.manifest)
    def test_positive_raw_two_leaf_evidence(self):self.assertEqual(self.admit()['status'],'SMOKE_PASSED')
    def test_other_host_run_attempt_bundle_runtime(self):
        original=copy.deepcopy(self.data['proof'])
        for field in ['node','run','attempt','imageVersion','workflowSha','runtime','pythonExecutable']:
            self.data['proof']=copy.deepcopy(original);self.data['proof']['host'][field]='different'
            with self.subTest(field=field),self.assertRaises(ValueError):self.admit()
        self.data['proof']=copy.deepcopy(original);self.data['proof']['manifestSha256']='different'
        with self.assertRaises(ValueError):self.admit()
    def test_disposed_host_is_not_current_proof(self):
        self.host['run']='35596476995';self.data['proof']['host']['run']='35596476995'
        with self.assertRaises(ValueError):self.admit()
    def test_truncated_raw_and_result(self):
        for name in ('result.json','observer.jsonl','fixture.stdout.log'):
            with self.subTest(name=name),self.assertRaises(ValueError):self.admit(name)
    def test_status_only_missing_mapping_arming_or_settlement(self):
        saved=copy.deepcopy(self.data)
        for change in ('mapping','armed','settled','child','reuse','file'):
            self.data=copy.deepcopy(saved)
            if change in ('mapping','armed','settled'):self.data['rows']=[r for r in self.data['rows'] if r['kind']!=change]
            if change=='child':self.data['proof']['commands'][0]['exitCode']=None
            if change=='reuse':self.data['ready']['process']['created100ns']='9'
            if change=='file':self.data['ready']['baseline'][run.LEAVES[0]]['fileId']='a'*32
            with self.subTest(change=change),self.assertRaises(ValueError):self.admit()

if __name__=='__main__':unittest.main()
