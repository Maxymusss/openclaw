import hashlib, json, os, pathlib, shutil, subprocess, tempfile
root = pathlib.Path(__file__).resolve().parents[1]
helper = root / "scripts/ci-npm-lock-admission.mjs"
assert hashlib.sha256(helper.read_bytes()).hexdigest() == "568603fbe2d39505e625ebdceddbe6ea157e26da25613d1a291eb613c39d96ef"
contracts = ["scripts/generate-npm-package-lock.mjs", "scripts/generate-npm-package-lock.mts", "scripts/changed-lanes.mts", "scripts/lib/merge-head-diff-base.mjs"]
results = []
for case in ["irrelevant", "relevant", "unknown", "manual", "mismatch", "historical"]:
    with tempfile.TemporaryDirectory(prefix="npm-lock-proof-") as tmp:
        cwd = pathlib.Path(tmp)
        def git(*args):
            return subprocess.check_output(["git", *args], cwd=cwd, text=True, stderr=subprocess.DEVNULL).strip()
        def write(name, data):
            p = cwd / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(data)
        git("init", "-q")
        git("config", "user.name", "Synthetic fixture")
        git("config", "user.email", "fixture@example.invalid")
        for name in contracts:
            p = cwd / name; p.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(root / name, p)
        write("package.json", json.dumps({"scripts": {"deps:npm-lock:check:changed": "node scripts/generate-npm-package-lock.mjs --changed"}}))
        write("extensions/example/package.json", "{}")
        write("packages/.gitkeep", "")
        write("src/example.ts", "// base")
        git("add", ".")
        git("-c", "commit.gpgsign=false", "commit", "-qm", "synthetic base")
        base = git("rev-parse", "HEAD")
        git("update-ref", "refs/remotes/origin/ci-ratchet-base", base)
        write("src/example.ts", "// change")
        if case == "relevant": write("extensions/example/package.json", '{"private":true}')
        if case == "mismatch": write("scripts/changed-lanes.mts", "// unknown selector")
        git("add", ".")
        git("-c", "commit.gpgsign=false", "commit", "-qm", "synthetic change")
        env = os.environ.copy()
        env["CHECKOUT_BASE_SHA"] = "" if case == "manual" else "missing" if case == "unknown" else base
        env["HISTORICAL_TARGET"] = str(case == "historical").lower()
        output = subprocess.check_output(["node", str(helper)], cwd=cwd, env=env, text=True).strip()
        expected = "skip=true" if case == "irrelevant" else "skip=false"
        assert output == expected, (case, output, expected)
        assert not (cwd / "node_modules").exists()
        results.append({"case":case, "output":output})
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as f: f.write(case + "=" + output.split("=")[1] + "\n")
print(json.dumps({"helper_sha256":"568603fbe2d39505e625ebdceddbe6ea157e26da25613d1a291eb613c39d96ef", "results":results}))
