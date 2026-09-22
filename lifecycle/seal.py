"""Offline deterministic seal of the installed-state derivative; never publishes/runs it."""
import hashlib
import json
from pathlib import Path
import re
from compose import compose

p=Path(__file__).resolve().parent

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def save_json(path,value):path.write_text(json.dumps(value,sort_keys=True,indent=2)+'\n')
def replace_pin(path,pattern,replacement):
    text,count=re.subn(pattern,replacement,path.read_text())
    if count!=1:raise ValueError('expected one pin: '+str(path))
    path.write_text(text)

inputs=json.loads((p/'source-inputs.json').read_text())
if digest(p/'upstream.ps1')!=inputs['upstreamHarness']['sha256']:
    raise ValueError('upstream source changed')
(p/'diagnostic.ps1').write_text(compose((p/'upstream.ps1').read_text()))
b=json.loads((p/'bundle.json').read_text())
b['payload']={n:digest(p/n) for n in sorted(b['payload'])}
save_json(p/'bundle.json',b)
bundle=digest(p/'bundle.json')
for name in ('stage.ps1','hook.ps1'):
    replace_pin(p/name,r"\$bundleSha = '[0-9a-f]{64}'",lambda m:"$bundleSha = '"+bundle+"'")
stage=digest(p/'stage.ps1')
replace_pin(p/'hook.ps1',r"\$stageSha = '[0-9a-f]{64}'",lambda m:"$stageSha = '"+stage+"'")
hook=digest(p/'hook.ps1')
workflow=p.parent/'.github/workflows/windows-testbox-probe.yml'
replace_pin(workflow,r"(-cne ')[0-9a-f]{64}('.*Wrong reviewed installed-state hook)",lambda m:m[1]+hook+m[2])
c=json.loads((p/'COMMANDS.json').read_text())
old=c['bundleSha256']
c=json.loads(json.dumps(c).replace(old,bundle))
c.update(bundleSha256=bundle,stageSha256=stage,hookSha256=hook,workflowSha256=digest(workflow))
(p/'COMMANDS.json').write_text(json.dumps(c,indent=2)+'\n')
print(bundle)
