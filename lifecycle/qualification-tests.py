"""Run affected byte-only tests after verifying explicit private child projection."""
import argparse
import os
from pathlib import Path
import tempfile
import unittest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--handoff-store', required=True)
    args = parser.parse_args()
    supplied = Path(args.handoff_store)
    resolved = supplied.resolve(strict=False)
    if (str(resolved) != args.handoff_store
            or os.environ.get('OPENCLAW_QUALIFICATION_HANDOFF_DB') != str(resolved)
            or not resolved.parent.name.startswith('qualification125286-')
            or resolved.name != 'handoff.sqlite' or os.path.lexists(resolved)):
        raise ValueError('Explicit fresh task-private store projection required')
    if Path(tempfile.gettempdir()).resolve() != resolved.parent:
        raise ValueError('Fixture temporary root differs from task-private root')
    print('Verified child store reservation:', resolved, flush=True)
    print('No product executor loaded or handoff database opened.', flush=True)
    os.chdir(Path(__file__).resolve().parent)
    suite = unittest.defaultTestLoader.loadTestsFromNames([
        'test_installed_state', 'test_installed_admission', 'test_release'])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if os.path.lexists(resolved):
        raise ValueError('Byte-only tests unexpectedly created a handoff database')
    if list(resolved.parent.iterdir()):
        raise ValueError('Synthetic fixtures left owned output behind')
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    raise SystemExit(main())
