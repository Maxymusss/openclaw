"""Read-only bounded terminal parser; original observer/identity bytes unchanged."""
import json,time
from pathlib import Path

def check_deadline(deadline):
    if deadline is not None and time.monotonic()>=deadline:
        raise ValueError('validation deadline exhausted')

def primary_records(path,max_bytes,deadline=None):
    check_deadline(deadline)
    if Path(path).stat().st_size>max_bytes:raise ValueError('primary output cap exceeded')
    rows=[];total=0;run=None
    with Path(path).open('rb') as stream:
        while True:
            check_deadline(deadline)
            raw=stream.readline(1024*1024+1)
            check_deadline(deadline)
            if not raw:break
            total+=len(raw)
            if len(raw)>1024*1024 or total>max_bytes or not raw.endswith(b'\n'):
                raise ValueError('oversized/truncated primary record; raw file retained')
            record=json.loads(raw.decode('ascii'))
            check_deadline(deadline)
            if (not isinstance(record,dict) or type(record.get('schema')) is not int or record['schema']!=1
                    or type(record.get('seq')) is not int or record['seq']!=len(rows) or not isinstance(record.get('kind'),str)):
                raise ValueError('invalid/reordered primary event')
            if not rows:
                if record['kind']!='start' or not isinstance(record.get('run'),str) or not record['run']:
                    raise ValueError('missing start/run identity')
                run=record['run']
            if record.get('run')!=run:raise ValueError('mixed run identity')
            rows.append(record)
    if not rows:raise ValueError('missing primary start')
    check_deadline(deadline)
    return rows
