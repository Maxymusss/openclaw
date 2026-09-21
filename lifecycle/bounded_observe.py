"""Lossless gap sidecar around unchanged observer24ab; no product instrumentation."""
import argparse
import gzip
import hashlib
import json
import math
import os
import time
import zlib
from pathlib import Path
from observe import Writer, Limit, observe, validate_binding
from windows_api import WinAPI

POLICY='lossless-gaps-v1'
LOGICAL_LIMIT=512*1024*1024


class GapWriter(Writer):
    def __init__(self, stream, sidecar, binding, clock=time.monotonic):
        super().__init__(stream,binding,clock)
        if 'observationStartMonotonic' in binding:
            origin=binding['observationStartMonotonic']
            if type(origin) not in (int,float) or not math.isfinite(origin) or not 0<=origin<=self.start:
                raise ValueError('invalid absolute observer clock origin')
            # Pinned Python3.13 Windows monotonic uses the same QPC clock for all processes.
            # Binding I/O, process launch and startup count against observation, not finalization.
            self.start=origin
        self.sidecar=sidecar
        self.compressor=zlib.compressobj(wbits=31)
        self.gap_count=self.logical=self.compressed=0
        self.digest=hashlib.sha256();self.compressed_digest=hashlib.sha256()
        self.pending=0;self.closed=False

    def put(self,data,final=False):
        # Reserve trailer room. Reaching either cap is a denied observation.
        if self.compressed+len(data)>self.binding['maxBytes']-(0 if final else 4096):
            raise Limit('gap-sidecar-budget')
        self.sidecar.write(data);self.sidecar.flush()
        self.compressed+=len(data);self.compressed_digest.update(data)

    def emit(self,kind,**payload):
        if kind=='gap':
            raw=(json.dumps(dict(payload,schema=1,kind='gap',run=self.binding['run'],
                 gapSeq=self.gap_count,monotonicSeconds=self.clock()-self.start,
                 utcNs=str(time.time_ns())),sort_keys=True,ensure_ascii=True)+'\n').encode('ascii')
            if self.logical+len(raw)>LOGICAL_LIMIT:raise Limit('gap-logical-budget')
            self.put(self.compressor.compress(raw)+self.compressor.flush(zlib.Z_SYNC_FLUSH))
            self.logical+=len(raw);self.digest.update(raw);self.gap_count+=1;self.pending+=1
            return
        if kind in ('sample-end','settled') and self.pending:
            try:
                super().emit('gap',detail={'sidecar':POLICY,'count':self.pending,
                    'throughGapSeq':self.gap_count-1,'absenceProven':False})
                self.pending=0
            except Limit:
                if kind!='settled':raise
                payload['reason']='output-budget'
        if kind=='settled':
            try:
                self.put(self.compressor.flush(zlib.Z_FINISH),final=True);self.closed=True
            except Limit:
                payload['reason']='gap-sidecar-budget'
            payload['gapSidecar']={'policy':POLICY,'complete':self.closed,'records':self.gap_count,
                'logicalBytes':self.logical,'compressedBytes':self.compressed,
                'sha256':self.digest.hexdigest(),'compressedSha256':self.compressed_digest.hexdigest()}
        if kind=='start':
            payload['limitations']=list(payload.get('limitations',[]))+['all gap payloads retained in lossless bounded sidecar; never absence evidence']
        super().emit(kind,**payload)


def verify_sidecar(output, rows, binding, deadline=None):
    def check():
        if deadline is not None and time.monotonic()>=deadline:raise ValueError('validation deadline exhausted')
    check()
    end=rows[-1].get('gapSidecar',{})
    if binding.get('outputPolicy')!=POLICY or end.get('policy')!=POLICY or end.get('complete') is not True:
        raise ValueError('missing complete lossless gap sidecar')
    path=Path(str(output)+'.gaps.gz')
    size=path.stat().st_size
    if not 0<size<=binding['maxBytes'] or end.get('compressedBytes')!=size:
        raise ValueError('gap sidecar size/budget mismatch')
    with path.open('rb') as f:
        compressed_digest=hashlib.sha256()
        while chunk:=f.read(1024*1024):
            check();compressed_digest.update(chunk)
        if compressed_digest.hexdigest()!=end.get('compressedSha256'):
            raise ValueError('gap sidecar changed')
    count=logical=0;digest=hashlib.sha256()
    with gzip.open(path,'rb') as f:
        while raw:=f.readline(1024*1024+1):
            check()
            logical+=len(raw)
            if len(raw)>1024*1024 or not raw.endswith(b'\n') or logical>LOGICAL_LIMIT:
                raise ValueError('truncated/excessive gap payload')
            row=json.loads(raw)
            if row.get('run')!=binding['run'] or row.get('kind')!='gap' or row.get('gapSeq')!=count:
                raise ValueError('gap sidecar identity/sequence mismatch')
            digest.update(raw);count+=1
    if (count!=end.get('records') or logical!=end.get('logicalBytes') or digest.hexdigest()!=end.get('sha256')):
        raise ValueError('incomplete gap sidecar')
    if sum(r.get('detail',{}).get('count',0) for r in rows if r.get('kind')=='gap' and isinstance(r.get('detail'),dict) and r['detail'].get('sidecar')==POLICY)!=count:
        raise ValueError('gap primary/sidecar coverage mismatch')
    check()
    return end


def smoke_capacity(output, rows, binding):
    if (binding.get('samples')!=2 or [r.get('sample') for r in rows if r['kind']=='sample']!=[0,1]
            or [r.get('sample') for r in rows if r['kind']=='sample-end']!=[0,1]
            or rows[-1].get('reason')!='sample-limit'):
        raise ValueError('two complete smoke samples required for budget projection')
    primary=Path(output).stat().st_size
    side=rows[-1]['gapSidecar']
    # 60 product samples; 2x physical-output margin, no deadline/cap extension.
    if (primary*60>binding['maxBytes'] or side['compressedBytes']*60>binding['maxBytes']
            or side['logicalBytes']*30>LOGICAL_LIMIT):
        raise ValueError('same-run smoke volume cannot fit full diagnostic budget')
    return {'samples':60,'physicalMargin':2,'primaryProjectedBytes':primary*60,
            'sidecarProjectedBytes':side['compressedBytes']*60,
            'logicalProjectedBytes':side['logicalBytes']*30,
            'notFutureWorkloadGuarantee':True}


def main():
    p=argparse.ArgumentParser();p.add_argument('--binding',required=True);p.add_argument('--output',required=True)
    args=p.parse_args();raw=Path(args.binding).read_bytes();binding=validate_binding(json.loads(raw))
    if binding.get('outputPolicy')!=POLICY:raise ValueError('wrong observer output policy')
    output=Path(args.output).resolve();parent=Path(binding['packageParent']).resolve()
    if output==parent or parent in output.parents:raise ValueError('evidence inside watched tree')
    binding['bindingSha256']=hashlib.sha256(raw).hexdigest()
    with output.open('x',encoding='ascii',newline='\n') as stream, Path(str(output)+'.gaps.gz').open('xb') as side:
        return observe(WinAPI(),binding,GapWriter(stream,side,binding))


if __name__=='__main__':raise SystemExit(main())
