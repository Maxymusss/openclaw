import hashlib,json
from pathlib import Path
p=Path(__file__).resolve().parent
b=json.loads((p/'bundle.json').read_bytes())
for n in ('host_contract.py','host-pin.json','release.py','bounded_observe.py','lifecycle.ps1','test_lifecycle.ps1','node-pin.json','held-job.cs','primary.py'): b['payload'][n]=''
b['payload']={n:hashlib.sha256((p/n).read_bytes()).hexdigest() for n in sorted(b['payload'])}
(p/'bundle.json').write_text(json.dumps(b,sort_keys=True,indent=2)+'\n')
print(hashlib.sha256((p/'bundle.json').read_bytes()).hexdigest())
