import json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from test_harness import fixture,lines
import run
class Primary(unittest.TestCase):
    def test_terminal_does_not_whole_file_read_primary(self):
        rows,binding,observer,parent=fixture();binding['maxBytes']=67108864
        rows[0]['binding']=dict(binding,bindingSha256='abc')
        rows.append({'kind':'settled','armed':True,'reason':'wall-budget'})
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'observer.jsonl';p.write_bytes(lines(rows))
            with patch.object(Path,'read_bytes',side_effect=AssertionError('whole-primary read bypasses deadline')),patch.object(run,'verify_sidecar'):
                result=run.observer_terminal(p,binding,'abc',0,99,deadline=10**20)
            self.assertEqual(len(result),7)

    def test_streamed_schema_matches_original_and_refuses_mixed_truncated_records(self):
        from primary import primary_records
        from identity import parse_events
        rows=[{'kind':'start','schema':1,'seq':0,'run':'unit'},{'kind':'settled','schema':1,'seq':1,'run':'unit'}]
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'raw';data=''.join(json.dumps(r)+'\n' for r in rows);p.write_text(data)
            self.assertEqual(primary_records(p,67108864),parse_events(data))
            for bad in (data[:-1],data.replace('"seq": 1','"seq": 0'),data.replace('"schema": 1','"schema": true'),json.dumps(rows[0])+'\n'+json.dumps(dict(rows[1],run='other'))+'\n'):
                p.write_text(bad)
                with self.assertRaises(ValueError):primary_records(p,67108864)
    def test_deadline_interrupts_between_primary_records(self):
        from primary import primary_records
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'raw';p.write_text('{"schema":1,"seq":0,"kind":"start","run":"unit"}\n'*5)
            with patch('primary.time.monotonic',side_effect=[0,0,0,2]):
                with self.assertRaisesRegex(ValueError,'validation deadline'):primary_records(p,67108864,deadline=1)
    def test_oversized_record_rejected_without_modifying_raw(self):
        from primary import primary_records
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'raw';data=b'x'*(1024*1024+2)+b'\n';p.write_bytes(data)
            with self.assertRaises(ValueError):primary_records(p,67108864)
            self.assertEqual(p.read_bytes(),data)
