import os, subprocess, pathlib, json, hashlib, time
repo=pathlib.Path(__file__).resolve().parents[1]
sha='fe9afc72544f0364bd7496b9fe05ac190843cc90'
expected_hashes={'.github/actions/git-owner/owner.py': 'ce36ed4a5bdb0b0a21958109271a2b25671fd97243a8ec15ab21a697a8cb1f08', '.github/actions/setup-node-env/action.yml': '6530ec94b0da54ee6fa89761004dbd185d45c46cab6a3b627a7f757271f3f7d1', 'scripts/ci-npm-lock-admission.mjs': '26248cc281cdd0bae248291604ec2822b80a8c6e03d18795d0016c98aafcda69', 'scripts/generate-npm-package-lock.mjs': '846954f3bb6f4d9825dfdf5959827f34a08ce46dc19bf245053d347949fa1d38', 'scripts/generate-npm-package-lock.mts': 'cd196c411058f9db624b70e58ee6955e0385ea97abe042b96ada789e2f9e8244', 'scripts/changed-lanes.mts': '38c8359309d4785f8a9943b4e047acd01d963bc3ebf3b9734b160b73b36ee09c', 'scripts/lib/merge-head-diff-base.mjs': '3789502fa71a64f3f427e8ecf23a43e7e0132886322037dd2174893f840d0e0b', '.github/workflows/ci.yml': '5e0f31c17d4a98aae886146ee25a3ce0b7cd56634021f73302059ec74377b76c'}
import tempfile
root=pathlib.Path(tempfile.mkdtemp(prefix='npm-owner-proof-')).resolve()
fixture=root/'fixture';fixture.mkdir()
config=fixture/'gitconfig';config.write_text('')
env={'PATH':os.environ['PATH'],'GIT_CONFIG_GLOBAL':str(config),'GIT_CONFIG_NOSYSTEM':'1','GIT_TERMINAL_PROMPT':'0','GIT_AUTHOR_NAME':'Fixture','GIT_AUTHOR_EMAIL':'fixture@example.invalid','GIT_COMMITTER_NAME':'Fixture','GIT_COMMITTER_EMAIL':'fixture@example.invalid'}
def call(args,cwd=fixture,extra=None):
 r=subprocess.run(args,cwd=cwd,env={**env,**(extra or {})},stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
 if r.returncode: raise RuntimeError(json.dumps({'args':args,'code':r.returncode,'stderr':r.stderr.decode()[-3000:]}))
 return r.stdout.decode().strip()
def git(*args,cwd=fixture): return call(['git',*args],cwd)
def source(file):
 data=(repo/file).read_bytes()
 assert hashlib.sha256(data).hexdigest()==expected_hashes[file],file
 return data
files=['.github/actions/git-owner/owner.py','.github/actions/setup-node-env/action.yml','scripts/ci-npm-lock-admission.mjs','scripts/generate-npm-package-lock.mjs','scripts/generate-npm-package-lock.mts','scripts/changed-lanes.mts','scripts/lib/merge-head-diff-base.mjs']
origin=fixture/'origin';origin.mkdir();git('init','-q',cwd=origin)
for file in files:
 p=origin/file;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(source(file))
for file,text in {'package.json':json.dumps({'scripts':{'deps:npm-lock:check:changed':'node scripts/generate-npm-package-lock.mjs --changed'}}),'extensions/example/package.json':'{}','packages/.keep':'','src/example.ts':'original\n'}.items():
 p=origin/file;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
def commit():
 git('add','.',cwd=origin);git('-c','commit.gpgsign=false','commit','-qm','fixture',cwd=origin);return git('rev-parse','HEAD',cwd=origin)
base=commit();(origin/'src/example.ts').write_text('changed\n');head=commit()
(origin/'extensions/example/package.json').write_text('{"private":true}');relevant=commit()
git('config','--file',str(config),f'url.{origin.as_uri()}.insteadOf','https://github.com/fixture/source.git')
git('config','--file',str(config),'protocol.file.allow','always')
owner=fixture/'owner.py';owner.write_bytes(source(files[0]))
workflow=source('.github/workflows/ci.yml').decode(); shard=workflow.split('  check-shard:')[1].split('\n  check-test-types-core:')[0]
body=shard.split('      - name: Run check shard')[1].split('        run: |\n')[1]
lines=[]
for line in body.splitlines():
 if line and not line.startswith('          '): break
 lines.append(line[10:] if line else '')
command=fixture/'actual-check-shard.sh';command.write_text('\n'.join(lines)+'\n')
results=[]
for name,target,wf,expected,historical in [('same-revision',head,head,True,False),('different-workflow-revision',head,base,True,False),('historical',head,head,False,True),('relevant-manifest',relevant,relevant,False,False)]:
 workspace=fixture/name
 e={'CHECKOUT_KIND':'linux-node','GITHUB_WORKSPACE':str(workspace),'CHECKOUT_REPO':'fixture/source','CHECKOUT_SHA':target,'WORKFLOW_SHA':wf,'CHECKOUT_BASE_SHA':base,'HISTORICAL_TARGET':str(historical).lower()}
 started=time.monotonic();out=call(['python3',str(owner)],extra=e)
 exported=workspace/'.ci-harness/scripts/ci-npm-lock-admission.mjs';assert exported.read_bytes()==source(files[2])
 for file in files[3:]:assert (workspace/'.ci-harness'/file).read_bytes()==source(file)
 status=git('status','--porcelain','--untracked-files=all',cwd=workspace);assert not status,status
 got=call(['node',str(exported)],cwd=workspace,extra=e);assert got==f'skip={str(expected).lower()}',got
 shallow=git('rev-parse','--is-shallow-repository',cwd=workspace);assert shallow=='true'
 checks=[]
 assert call(['node',str(exported)],cwd=workspace,extra={**e,'CHECKOUT_BASE_SHA':'missing'})=='skip=false'
 checks.append('invalid base retains execution')
 if expected:
  text=call(['/bin/bash',str(command)],cwd=workspace,extra={**e,'TASK':'npm-lock','SKIP_NPM_LOCK':'true'})
  assert text=='No npm-lock package changes detected; dependency setup skipped.',text
  checks.append('actual workflow check-shard body exited before package-script execution')
  # Exported harness has nested .github actions with manifests: exclusion must be narrow.
  (workspace/'.ci-harness/package.json').write_text('{}')
  assert call(['node',str(exported)],cwd=workspace,extra=e)=='skip=true'
  (workspace/'src/package.json').write_text('{}')
  assert call(['node',str(exported)],cwd=workspace,extra=e)=='skip=false'
  (workspace/'src/package.json').unlink()
  nested=workspace/'src/.ci-harness/package.json';nested.parent.mkdir();nested.write_text('{}')
  assert call(['node',str(exported)],cwd=workspace,extra=e)=='skip=false'
  checks.extend(['root harness manifest ignored','untracked source manifest retained','nested harness manifest retained'])
 results.append({'case':name,'production_checkout_skip':expected,'elapsed_seconds':round(time.monotonic()-started,3),'checks':checks,'exported_sha256':hashlib.sha256(exported.read_bytes()).hexdigest()})
receipt={'candidate':sha,'platform':os.uname().sysname,'fixture_base':base,'fixture_head':head,'node':call(['node','--version']),'git':call(['git','--version']),'source_sha256':{f:hashlib.sha256(source(f)).hexdigest() for f in files},'cases':results,'actual_workflow_body_sha256':hashlib.sha256(command.read_bytes()).hexdigest(),'limitations':['synthetic Git history contains exact candidate relevant source files, not full repository','no package installation, real cache operation, or savings measurement','exact committed candidate bytes; no diagnostic history fetch']}
(root/'receipt-repaired.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
