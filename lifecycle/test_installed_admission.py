import json
from pathlib import Path
import unittest
from unittest.mock import patch
import run
import test_installed_state as fixtures

class DownstreamAdmission(unittest.TestCase):
    setUp=fixtures.InstalledState.setUp
    tearDown=fixtures.InstalledState.tearDown
    def reach_smoke(self, mutate=None):
        from types import SimpleNamespace
        before=list(self.root.iterdir())
        package=self.root/'prefix/openclaw';package.mkdir(parents=True)
        for p in before:p.rename(package/p.name)
        self.setup['target']=str(package)
        if mutate:mutate(package,self.setup)
        manifest_raw=json.dumps(self.members).encode();(self.root/'release-installed.json').write_bytes(manifest_raw)
        harness=self.root/'diagnostic.ps1';harness.write_bytes(b'sealed inert source')
        node=self.root/'node.exe';node.write_bytes(b'never executed')
        setup_path=self.root/'setup.json';setup_path.write_text(json.dumps(self.setup));setup_sha=run.sha(setup_path.read_bytes())
        spec={'deadlineFiletime100ns':str(116444736000000000+35900000000),
          'candidateHead':run.HEAD,'workflowSourceSha':'a'*40,'candidateTree':'d4bb6a0016a6aab695c9c6fe67b40c76f3d9ee6b','budgetSeconds':3600,
          'harnessSourcePath':str(harness),'node':str(node),'nodeSha256':run.sha(node.read_bytes()),'packageParent':str(package.parent),
          'smokeResult':str(self.root/'never-read'),'smokeSha256':'b'*64,'installedSetupPath':str(setup_path),'installedSetupSha256':setup_sha}
        self.alter_spec(spec,setup_path)
        spec_path=self.root/'spec.json';spec_path.write_text(json.dumps(spec))
        manifest={'payload':{'diagnostic.ps1':run.sha(harness.read_bytes())},'releaseInstalledManifestSha256':run.sha(manifest_raw)}
        with patch.object(run.time,'time_ns',return_value=0),patch.object(run,'HERE',self.root),patch.object(run,'host',return_value={'workflowSha':'a'*40}),patch.object(run,'validate_smoke',side_effect=RuntimeError('SYNTHETIC_SMOKE_BOUNDARY')) as smoke,patch.object(run,'start_observer',side_effect=AssertionError('observer must never run')):
            try:run.diagnostic(SimpleNamespace(spec=str(spec_path),manifest_sha='c'*64),None,None,manifest)
            finally:self.smoke_called=smoke.called
    def alter_spec(self,spec,setup_path):pass
    def test_successful_postinstall_reaches_smoke_gate_without_running_it(self):
        with self.assertRaisesRegex(RuntimeError,'SYNTHETIC_SMOKE_BOUNDARY'):self.reach_smoke()
        self.assertTrue(self.smoke_called)
    def test_pending_marker_stops_before_observer_admission(self):
        with self.assertRaises(ValueError):self.reach_smoke(lambda p,s:(p/'.openclaw-lifecycle-pending').write_bytes(b'pending'))
        self.assertFalse(self.smoke_called)
    def test_receipt_digest_mismatch_stops_before_admission(self):
        self.alter_spec=lambda spec,p:spec.update(installedSetupSha256='0'*64)
        with patch('release.installed',side_effect=AssertionError('verifier reached before receipt check')):
            with self.assertRaises(ValueError):self.reach_smoke()
        self.assertFalse(self.smoke_called)
    def test_unsettled_installer_stops_before_admission(self):
        with self.assertRaises(ValueError):self.reach_smoke(lambda p,s:s.update(unsettled=True))
        self.assertFalse(self.smoke_called)

if __name__=='__main__':unittest.main()
