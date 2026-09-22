"""Validate the actual generated receipt through production's byte-only contract."""
import argparse
import json
import os
from pathlib import Path
import release

parser = argparse.ArgumentParser()
parser.add_argument('--setup', required=True)
parser.add_argument('--handoff-store', required=True)
args = parser.parse_args()
store = Path(args.handoff_store)
if (str(store.resolve()) != args.handoff_store
        or os.environ.get('OPENCLAW_QUALIFICATION_HANDOFF_DB') != str(store)
        or store.name != 'handoff.sqlite' or os.path.lexists(store)
        or not store.parent.name.startswith('qualification125286-')):
    raise ValueError('Explicit resolved private store projection missing')
receipt = json.loads(Path(args.setup).read_bytes())
members = json.loads((Path(__file__).parent/'release-installed.json').read_bytes())
try:
    release.require_setup(Path(receipt['target']), members, receipt)
except ValueError as error:
    print(json.dumps({'accepted': False, 'reason': str(error)}))
    raise SystemExit(1)
print(json.dumps({'accepted': True}))
if os.path.lexists(store):
    raise ValueError('Receipt validation unexpectedly created a handoff database')
