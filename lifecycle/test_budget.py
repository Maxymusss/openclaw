import gzip,io,json,tempfile,unittest
from pathlib import Path
from bounded_observe import GapWriter,verify_sidecar,POLICY
from observe import Writer,Limit

class Budget(unittest.TestCase):
    def setUp(self):self.binding={'seconds':3600,'maxBytes':67108864,'run':'budget','outputPolicy':POLICY}
    def test_lossless_gap_payload_and_positive_mapping(self):
        out=io.StringIO();side=io.BytesIO();w=GapWriter(out,side,self.binding)
        payload={'sample':0,'pid':9,'detail':{'error':{'api':'K32GetMappedFileNameW','winerror':5},'address':'0x123'}}
        w.emit('start');w.emit('gap',**payload);w.emit('mapping',positive=True);w.emit('sample-end');w.emit('settled',armed=True,reason='sample-limit')
        rows=[json.loads(x) for x in out.getvalue().splitlines()];raw=json.loads(gzip.decompress(side.getvalue()))
        for k,v in payload.items():self.assertEqual(raw[k],v)
        self.assertTrue(next(r for r in rows if r['kind']=='mapping')['positive'])
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'observer.jsonl';Path(str(p)+'.gaps.gz').write_bytes(side.getvalue());verify_sidecar(p,rows,self.binding)
            Path(str(p)+'.gaps.gz').write_bytes(side.getvalue()[:-1])
            with self.assertRaises(ValueError):verify_sidecar(p,rows,self.binding)
    def test_sequence_and_count_fail_closed(self):
        out=io.StringIO();side=io.BytesIO();w=GapWriter(out,side,self.binding)
        w.emit('gap',detail='raw');w.emit('settled',armed=True,reason='wall-budget')
        rows=[json.loads(x) for x in out.getvalue().splitlines()]
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'observer.jsonl';Path(str(p)+'.gaps.gz').write_bytes(side.getvalue())
            rows[-1]['gapSidecar']['records']=2
            with self.assertRaises(ValueError):verify_sidecar(p,rows,self.binding)
    def test_compressed_cap_is_not_extended(self):
        w=GapWriter(io.StringIO(),io.BytesIO(),dict(self.binding,maxBytes=65536))
        with self.assertRaises(Limit):w.put(b'x'*65536)
    def test_original_observer_source_unchanged(self):
        import hashlib
        self.assertEqual(hashlib.sha256(Path('observe.py').read_bytes()).hexdigest(),'2d15b778cad88e5b26b4c0b60b2ccd2c1af65120e5eee297dc5f5473a066d206')

if __name__=='__main__':unittest.main()

class SameRunCapacity(unittest.TestCase):
    def test_refuse_excessive_current_smoke_before_setup(self):
        from bounded_observe import smoke_capacity
        binding={'samples':2,'maxBytes':67108864}
        rows=[{'kind':'sample','sample':0},{'kind':'sample-end','sample':0},
              {'kind':'sample','sample':1},{'kind':'sample-end','sample':1},
              {'kind':'settled','reason':'sample-limit','gapSidecar':{'compressedBytes':400000,'logicalBytes':9000000}}]
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'observer.jsonl';p.write_bytes(b'x'*400000)
            self.assertEqual(smoke_capacity(p,rows,binding)['physicalMargin'],2)
            rows[-1]['gapSidecar']['compressedBytes']=2000000
            with self.assertRaises(ValueError):smoke_capacity(p,rows,binding)
    def test_missing_sample_not_positive_budget_evidence(self):
        from bounded_observe import smoke_capacity
        with self.assertRaises(ValueError):smoke_capacity('unused',[],{'samples':2})

class CompleteSmokeSamples(unittest.TestCase):
    def test_partial_second_sample_cannot_admit_product_budget(self):
        from bounded_observe import smoke_capacity
        rows=[{'kind':'sample','sample':0},{'kind':'sample-end','sample':0},
              {'kind':'sample','sample':1},{'kind':'settled','reason':'wall-budget',
               'gapSidecar':{'compressedBytes':200,'logicalBytes':1000}}]
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'observer.jsonl';p.write_bytes(b'unit')
            with self.assertRaises(ValueError):smoke_capacity(p,rows,{'samples':2,'maxBytes':67108864})
