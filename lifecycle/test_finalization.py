import io,json,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch
import run
from bounded_observe import GapWriter,verify_sidecar,POLICY

class Finalization(unittest.TestCase):
    def test_observer_reserves_validation_without_changing_samples_or_caps(self):
        s=SimpleNamespace(deadline=3600)
        with patch.object(run.time,'monotonic',return_value=0),patch.object(run,'validate_binding',side_effect=lambda x:x):
            b=run.make_binding(s,'parent',{'pid':1,'created100ns':'2','executable':'shell'},'unit')
        self.assertLessEqual(b['seconds'],3540)
        self.assertEqual((b['samples'],b['interval'],b['maxBytes']),(60,60,67108864))
        self.assertEqual(b['unchangedHarnessBudgetSeconds'],3600)
    def test_unsettled_child_cannot_consume_validation_reserve(self):
        s=object.__new__(run.Session);s.deadline=3600;s.work_deadline=3540;s.api=None
        p=Mock();p.poll.return_value=None;p.pid=1;s.children=[(p,{})]
        with patch.object(run.time,'monotonic',return_value=3540),patch.object(run.time,'sleep',side_effect=AssertionError('consumed finalization reserve')),patch.object(run,'process_identity',return_value={}):
            self.assertFalse(s.finish())
        p.kill.assert_not_called();p.terminate.assert_not_called()
    def test_smoke_throughput_gate_is_fail_closed(self):
        self.assertEqual(run.validation_capacity(.1)['projectedSeconds'],6)
        for seconds in (1,float('inf'),float('nan'),-1):
            with self.assertRaises(ValueError):run.validation_capacity(seconds)
    def test_sidecar_validation_deadline_preserves_raw_bytes(self):
        b={'seconds':3600,'maxBytes':67108864,'run':'unit','outputPolicy':POLICY}
        out=io.StringIO();side=io.BytesIO();w=GapWriter(out,side,b)
        w.emit('gap',detail='unchanged');w.emit('settled',armed=True,reason='wall-budget')
        rows=[json.loads(x) for x in out.getvalue().splitlines()]
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'observer.jsonl';f=Path(str(output)+'.gaps.gz');f.write_bytes(side.getvalue())
            with patch('bounded_observe.time.monotonic',return_value=100):
                with self.assertRaisesRegex(ValueError,'validation deadline'):verify_sidecar(output,rows,b,deadline=99)
                verify_sidecar(output,rows,b,deadline=101)
            self.assertEqual(f.read_bytes(),side.getvalue())
