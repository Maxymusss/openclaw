"""Source-only controls; synthetic bytes only, never install or invoke a product."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import release

MARKER = '.openclaw-lifecycle-pending'

class InstalledState(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.root=Path(self.tmp.name).resolve()
        self.raw={MARKER:b'pending', 'package.json':b'{}', 'dist/main.js':b'unchanged'}
        # Exact released lifecycle source identities are policy, not executed code.
        self.members={n:hashlib.sha256(v).hexdigest() for n,v in self.raw.items()}
        self.members.update({
            'scripts/lib/package-lifecycle-marker.mjs':'32c50197ecc6f10b78f9f8ef588b868e7cdf428233e00fb912044dee5da46e1a',
            'scripts/postinstall-bundled-plugins.mjs':'7e1f81b571636d0f0102ff7120b5de54973a12e1ece8044fe6f608efaf49f061'})
        context=Path(__file__).resolve().parents[1]/'released-context'
        for n in list(self.members):
            raw=self.raw.get(n) if n in self.raw else (context/n).read_bytes()
            p=self.root/n;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw)
        (self.root/MARKER).unlink()
        ident={'pid':17,'created100ns':'100','exited100ns':'0','executable':'pwsh.exe','imageError':0,'processMachine':0,'nativeMachine':34404}
        terminal=dict(ident,exited100ns='200',executable=None,imageError=31)
        self.setup={'schema':1,'archiveVerified':True,'archiveSha256':'1fb6ef4fae447af14f1e3b1028334f39146d181a66a4cce2848d4f741c636340','target':str(self.root),'unsettled':False,
            'command':{'name':'published-driver-install','status':'TERMINAL','exitCode':0,'error':None,'settlementError':None,'identity':ident,'terminalIdentity':terminal,'settlement':'same-held-handle-times; terminal-image-absent-error31-retained'}}
    def tearDown(self):self.tmp.cleanup()
    def check(self):return release.installed(self.root,self.members,self.setup)
    def test_completed_postinstall_succeeds(self):self.check()
    def test_missing_setup_denied_before_filesystem_access(self):
        with patch.object(Path, 'lstat', side_effect=AssertionError('filesystem reached')):
            with self.assertRaisesRegex(ValueError, 'unqualified released install setup'):
                release.installed(self.root, self.members)

    def test_pending_marker_present_is_incomplete(self):
        (self.root/MARKER).write_bytes(b'pending')
        with self.assertRaises(ValueError):self.check()
    def test_other_member_missing(self):
        (self.root/'dist/main.js').unlink()
        with self.assertRaises((ValueError,OSError)):self.check()
    def test_other_member_changed(self):
        (self.root/'dist/main.js').write_bytes(b'changed')
        with self.assertRaises(ValueError):self.check()
    def test_marker_dangling_link_is_not_absence(self):
        (self.root/MARKER).symlink_to(self.root/'missing')
        with self.assertRaises(ValueError):self.check()
    def test_member_link_is_not_original(self):
        p=self.root/'package.json';p.unlink();p.symlink_to(self.root/'other');(self.root/'other').write_bytes(b'{}')
        with self.assertRaises(ValueError):self.check()
    def test_parent_link_is_unsupported(self):
        (self.root/'dist').rename(self.root/'real-dist');(self.root/'dist').symlink_to(self.root/'real-dist',target_is_directory=True)
        with self.assertRaises(ValueError):self.check()
    def test_marker_access_error_is_not_absence(self):
        original=Path.lstat
        def denied(p,*a,**k):
            if p.name==MARKER:raise PermissionError('synthetic denial')
            return original(p,*a,**k)
        with patch.object(Path,'lstat',denied):
            with self.assertRaises(PermissionError):self.check()
    def test_windows_reparse_marker_is_not_absence(self):
        from types import SimpleNamespace
        original=Path.lstat
        def reparse(p,*a,**k):
            if p.name==MARKER:return SimpleNamespace(st_mode=0o100644,st_file_attributes=0x400)
            return original(p,*a,**k)
        with patch.object(Path,'lstat',reparse):
            with self.assertRaises(ValueError):self.check()
    def test_failed_unsettled_or_timed_out_installer_denied_before_read(self):
        for field,value in [('exitCode',1),('status','UNSETTLED'),('timedOut',True),('error','original failure'),('settlementError','lost custody')]:
            with self.subTest(field=field):
                old=copy.deepcopy(self.setup);self.setup['command'][field]=value
                with patch.object(Path,'lstat',side_effect=AssertionError('filesystem reached')):
                    with self.assertRaises(ValueError):self.check()
                self.setup=old
    def test_uncertain_terminal_identity_denied(self):
        for field,value in [('pid',18),('created100ns','101'),('exited100ns','0'),('imageError',5)]:
            with self.subTest(field=field):
                old=copy.deepcopy(self.setup);self.setup['command']['terminalIdentity'][field]=value
                with self.assertRaises(ValueError):self.check()
                self.setup=old
    def test_archive_and_target_preconditions_required(self):
        for field,value in [('archiveVerified',False),('archiveSha256','0'*64),('target',str(self.root/'other')),('unsettled',True)]:
            with self.subTest(field=field):
                old=copy.deepcopy(self.setup);self.setup[field]=value
                with self.assertRaises(ValueError):self.check()
                self.setup=old
    def test_release_lifecycle_source_contract_required(self):
        for name in [MARKER,'scripts/lib/package-lifecycle-marker.mjs','scripts/postinstall-bundled-plugins.mjs']:
            with self.subTest(name=name):
                saved=self.members.pop(name)
                with self.assertRaises(ValueError):self.check()
                self.members[name]=saved
    def test_unsafe_member_paths_denied(self):
        for name in ['../escape','/absolute','dist/../escape','dist\\escape','dist/x:stream','dist/NUL','dist/trailing.']:
            with self.subTest(name=name):
                self.members[name]='0'*64
                with self.assertRaises(ValueError):self.check()
                del self.members[name]


class CompositionAgreement(unittest.TestCase):
    def test_active_generated_diagnostic_matches_generator(self):
        from compose import compose
        self.assertEqual(Path('diagnostic.ps1').read_text(),compose(Path('upstream.ps1').read_text()))
    def test_manifest_stage_hook_workflow_and_commands_agree(self):
        bundle=Path('bundle.json').read_bytes();digest=hashlib.sha256(bundle).hexdigest()
        manifest=json.loads(bundle);commands=json.loads(Path('COMMANDS.json').read_text())
        for name,expected in manifest['payload'].items():
            self.assertEqual(hashlib.sha256(Path(name).read_bytes()).hexdigest(),expected,name)
        self.assertEqual(commands['bundleSha256'],digest)
        stage=Path('stage.ps1').read_text();hook=Path('hook.ps1').read_text()
        workflow=Path('../.github/workflows/windows-testbox-probe.yml').read_text()
        self.assertIn("$bundleSha = '"+digest+"'",stage)
        self.assertIn("$bundleSha = '"+digest+"'",hook)
        self.assertEqual(commands['stageSha256'],hashlib.sha256(stage.encode()).hexdigest())
        self.assertEqual(commands['hookSha256'],hashlib.sha256(hook.encode()).hexdigest())
        self.assertIn(hashlib.sha256(hook.encode()).hexdigest(),workflow)
        self.assertIn(hashlib.sha256(stage.encode()).hexdigest(),hook)
        self.assertEqual(commands['workflowSha256'],hashlib.sha256(workflow.encode()).hexdigest())

class ArchiveMarker(unittest.TestCase):
    def test_marker_remains_required_preinstall_and_all_pins_unchanged(self):
        import base64, io, tarfile
        raw={MARKER:b'pending', 'openclaw.mjs':b'unchanged'}
        members={n:hashlib.sha256(b).hexdigest() for n,b in raw.items()}
        with tempfile.TemporaryDirectory() as d:
            target=Path(d)/'test.tgz'
            for mode in ['original','missing','changed']:
                with self.subTest(mode=mode):
                    with tarfile.open(target,'w:gz') as t:
                        for name,b in raw.items():
                            if name==MARKER and mode=='missing':continue
                            if name==MARKER and mode=='changed':b=b'changed'
                            info=tarfile.TarInfo('package/'+name);info.size=len(b);t.addfile(info,io.BytesIO(b))
                    data=target.read_bytes()
                    pin={'archiveBytes':len(data),'archiveSha256':hashlib.sha256(data).hexdigest(),'dist':{'integrity':'sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode()}}
                    if mode=='original':release.archive(target,pin,members)
                    else:
                        with self.assertRaises(ValueError):release.archive(target,pin,members)
        pinned=json.loads(Path('release-installed.json').read_bytes())
        self.assertEqual(len(pinned),11428);self.assertIn(MARKER,pinned)
        for n in pinned:release.safe_parts(n)
        self.assertEqual(hashlib.sha256(Path('release-installed.json').read_bytes()).hexdigest(),'7a96e2ff0d07ed0a04ad072f362db90edb20f41aa1b528d66d4858c6e3776fe8')
        self.assertEqual(hashlib.sha256(Path('release-pin.json').read_bytes()).hexdigest(),'27220eb8be612666e7123f5a7b125e408435e3036557c7db80dfef96d921a6b3')

if __name__=='__main__':unittest.main()
