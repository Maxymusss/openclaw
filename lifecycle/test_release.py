"""Byte-only archive behavior, never extracts or executes a package."""
import unittest
from pathlib import Path
import base64,hashlib,io,tarfile,tempfile
from release import archive

class ReleaseBytes(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.members={'package.json':b'{"name":"openclaw","version":"2026.9.5","scripts":{"postinstall":"DO_NOT_EXECUTE"}}','openclaw.mjs':b'throw new Error("DO_NOT_EXECUTE")'}
    def tearDown(self):self.tmp.cleanup()
    def make(self,extra=None):
        target=self.root/'release.tgz'
        with tarfile.open(target,'w:gz') as tar:
            for name,raw in list(self.members.items())+([] if extra is None else [extra]):
                info=tarfile.TarInfo('package/'+name);info.size=len(raw);tar.addfile(info,io.BytesIO(raw))
        raw=target.read_bytes()
        pin={'archiveBytes':len(raw),'archiveSha256':hashlib.sha256(raw).hexdigest(),'dist':{'integrity':'sha512-'+base64.b64encode(hashlib.sha512(raw).digest()).decode()}}
        members={n:hashlib.sha256(v).hexdigest() for n,v in self.members.items()}
        return target,pin,members
    def test_hashes_and_members_checked_without_extraction(self):
        target,pin,members=self.make();archive(target,pin,members)
        self.assertEqual(list(self.root.iterdir()),[target])
    def test_archive_change_and_wrong_integrity(self):
        target,pin,members=self.make();raw=target.read_bytes();target.write_bytes(raw[:-1]+bytes([raw[-1]^1]))
        with self.assertRaises(ValueError):archive(target,pin,members)
        target.write_bytes(raw);pin['dist']['integrity']='sha512-wrong'
        with self.assertRaises(ValueError):archive(target,pin,members)
    def test_wrong_missing_extra_or_duplicate_member(self):
        for name,raw in [('extra.js',b'extra'),('package.json',b'duplicate'),('../escape',b'escape')]:
            target,pin,members=self.make((name,raw))
            with self.assertRaises(ValueError):archive(target,pin,members)
        target,pin,members=self.make();members['missing.js']='0'*64
        with self.assertRaises(ValueError):archive(target,pin,members)
        members.pop('missing.js');members['package.json']='0'*64
        with self.assertRaises(ValueError):archive(target,pin,members)

if __name__ == "__main__":
    unittest.main()
