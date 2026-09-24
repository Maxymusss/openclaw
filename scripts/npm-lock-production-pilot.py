import os,pathlib,subprocess,hashlib,json,shutil
root=pathlib.Path.cwd()
tmp=pathlib.Path(os.environ['RUNNER_TEMP'])
hashes={'.github/actions/git-owner/owner.py': 'ce36ed4a5bdb0b0a21958109271a2b25671fd97243a8ec15ab21a697a8cb1f08', '.github/workflows/ci.yml': '5e0f31c17d4a98aae886146ee25a3ce0b7cd56634021f73302059ec74377b76c', 'scripts/ci-npm-lock-admission.mjs': '26248cc281cdd0bae248291604ec2822b80a8c6e03d18795d0016c98aafcda69', '.github/actions/setup-node-env/action.yml': '6530ec94b0da54ee6fa89761004dbd185d45c46cab6a3b627a7f757271f3f7d1'}
for f,h in hashes.items():assert hashlib.sha256((root/f).read_bytes()).hexdigest()==h,f
owner=tmp/'pilot-owner.py';shutil.copyfile(root/'.github/actions/git-owner/owner.py',owner)
text=(root/'.github/workflows/ci.yml').read_text().split('  check-shard:')[1].split('\n  check-test-types-core:')[0]
body=text.split('      - name: Run check shard')[1].split('        run: |\n')[1];lines=[]
for line in body.splitlines():
 if line and not line.startswith('          '):break
 lines.append(line[10:] if line else '')
(tmp/'pilot-check.sh').write_text('\n'.join(lines)+'\n')
subprocess.run(['python3','-I','-S',str(owner)],check=True)
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==os.environ['CHECKOUT_SHA']
assert subprocess.check_output(['git','rev-parse','refs/remotes/origin/ci-ratchet-base'],text=True).strip()==os.environ['CHECKOUT_BASE_SHA']
for f in ['scripts/ci-npm-lock-admission.mjs','.github/actions/setup-node-env/action.yml']:
 assert hashlib.sha256((root/'.ci-harness'/f).read_bytes()).hexdigest()==hashes[f]
if os.environ['PILOT_CASE']=='relevant':
 f=root/'extensions/arcee/package.json';j=json.loads(f.read_text());assert j['openclaw']['release']['publishToNpm'] is True
 j['description']=j.get('description','')+' (CI admission experiment)';f.write_text(json.dumps(j,indent=2)+'\n')
 subprocess.run(['git','add','extensions/arcee/package.json'],check=True)
 subprocess.run(['git','-c','user.name=CI fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','Synthetic description-only relevant manifest'],check=True)
 changed=subprocess.check_output(['git','diff','--name-only',os.environ['CHECKOUT_SHA'],'HEAD'],text=True).strip();assert changed=='extensions/arcee/package.json'
print(json.dumps({'pilot_identity':{'case':os.environ['PILOT_CASE'],'target':os.environ['CHECKOUT_SHA'],'base':os.environ['CHECKOUT_BASE_SHA'],'workflow_source':os.environ['WORKFLOW_SHA'],'actual_head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'helper_sha256':hashes['scripts/ci-npm-lock-admission.mjs'],'shell_sha256':hashlib.sha256((tmp/'pilot-check.sh').read_bytes()).hexdigest()}}))
