---
doc-schema-version: 1
summary: "Publish and recover a monthly Gateway extended-stable release"
title: "Extended-stable releases"
read_when:
  - Publish and recover a monthly Gateway extended-stable release
---

Use this reference when you need to publish and recover a monthly Gateway extended-stable release. For the release sequence, start with [Release policy](/reference/RELEASING).

## Monthly Gateway extended-stable publication

For completed month `YYYY.M`, create `extended-stable/YYYY.M.33` and publish
`.33+` from that branch. Tag, branch, checkout, package version, preflight, and
validation must identify one commit. Before `.33`, protected `main` must contain
a final version below patch `33` one or two calendar months later, making the
release one of the two trailing completed months. Maintenance patches remain
eligible only while that holds; the older line retires when `main` advances a
third month.
The shared publisher checks live `main` before dispatching publication children;
each plugin checks it again immediately before npm publication, including
trusted-main recovery. Saved qualification does not authorize a retired line.
A missing or unreadable current-main version blocks publication.

### Prepare and stabilize the candidate

Audit the unaudited mainline range, reconcile private security work, approve a
bounded backport set, and land one coordinated PR. Do not push the canonical
branch directly.

On the canonical branch, set `YYYY.M.P`, run `pnpm release:prep`, and require
that version in every publishable official plugin. From the approved ledger,
generate and commit a complete `## YYYY.M.P` section in `CHANGELOG/YYYY.M.P.md` with `### Highlights`,
`### Changes`, and `### Fixes`, citing original merged `main` PRs for equivalent
backports. Preflight rejects a missing or empty section.

Carry the full current-main Docker release-channel unit: workflow, promoter,
policy, shared classifier, tests, and workflow validation. GitHub loads tag
workflows from the tagged commit; an incomplete copy can fail after building or
move regular aliases. Run focused checks.

Freeze the full branch-tip SHA and record the exact trusted-main Tooling SHA.
Before tagging, run Full Release Validation through its immutable workflow
transport; it also prepares and qualifies the exact npm and Docker bytes.
`pnpm ci:full-release` runs `scripts/full-release-validation-at-sha.mjs`; this
page uses the `pnpm` form throughout.

```bash
VALIDATION_SHA="<exact-candidate-sha>"
TOOLING_SHA="<recorded-full-main-ancestor-sha>"
CONTEXT_REF="extended-stable/YYYY.M.33"
pnpm ci:full-release \
  --sha "$VALIDATION_SHA" \
  --target-ref "$CONTEXT_REF" \
  --workflow-sha "$TOOLING_SHA" \
  -f validation_purpose=publish \
  -f publication_selection_json='{"route":"extended-stable","npmDistTag":"extended-stable","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}' \
  -f release_profile=stable \
  -f run_release_soak=true \
  -f fail_fast=false \
  -f rerun_group=all \
  -f reuse_evidence=false \
  -f dispatch_release_evidence=false
```

The helper dispatches from an immutable `release-ci/*` ref at the Tooling SHA,
passes the Validation SHA as `ref` and `expected_sha`, and records the canonical
branch as `target_context_ref`. GitHub workflow dispatch `--ref` must name a
branch or tag; it cannot be a raw SHA. Save the successful run ID and
`run_attempt`. When its manifest contains `publicationArtifacts.npmPreflight`,
use that same Full Release Validation run and attempt for both npm preflight and
full validation publication evidence.

Extended-stable also requires a separate npm preflight from trusted `main`:

```bash
gh workflow run openclaw-npm-release.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f tag="$VALIDATION_SHA" \
  -f preflight_only=true \
  -f npm_dist_tag=extended-stable \
  -f release_candidate_branch="$CONTEXT_REF"
```

This standalone run is a supplemental validation-only preflight. Do not pass
its run ID as publication `preflight_run_id`: its `main` workflow head is not
the canonical candidate branch/SHA identity required for standalone
publication evidence. Publication continues to use the integrated Full Release
Validation npm artifact and exact run attempt.

Classify failures before editing:

- Product: land another approved backport PR.
- Frozen-target tooling: backport only the smallest compatibility repair that
  tests the old product unchanged.
- Provider, approval, runner, or service: keep the candidate unchanged and use
  the bounded retry path.

Any branch change invalidates both gates. Once they pass, require the tip still
equals `VALIDATION_SHA`, then push signed `vYYYY.M.P`. Later changes need the next
patch; never move or delete the tag. Tagging fixes the immutable release
identity; it does not publish Docker images.

### Publish the release

Run the shared release orchestrator from a protected lightweight tooling tag
at the frozen trusted-main Tooling SHA, selecting the extended-stable npm track.
With publication/tag-push authority, create and push that tooling tag before
dispatch; keep it distinct from the immutable product release tag:

```bash
TOOLING_SHA="<recorded-full-main-ancestor-sha>"
PUBLISH_REF="release-publish/$(printf '%s' "$TOOLING_SHA" | cut -c1-12)-$(date +%s)"
git tag "$PUBLISH_REF" "$TOOLING_SHA"
git push origin "refs/tags/$PUBLISH_REF"
gh workflow run openclaw-release-publish.yml \
  --ref "$PUBLISH_REF" \
  -f tag=vYYYY.M.P \
  -f preflight_run_id=<npm-preflight-run-id> \
  -f full_release_validation_run_id=<full-validation-run-id> \
  -f full_release_validation_run_attempt=<full-validation-run-attempt> \
  -f npm_dist_tag=extended-stable \
  -f plugin_publish_scope=all-publishable \
  -f publish_openclaw_npm=true
```

The parent derives the canonical `extended-stable/YYYY.M.33` branch from the
tag and passes it to both npm children. It creates the draft GitHub Release,
publishes every `all-publishable` official plugin and core under the
`extended-stable` selector, verifies registry bytes, attaches dependency and
validation evidence, publishes Docker, then finalizes the release with
`latest=false`. ClawHub and native-app stages are disabled by the selected
track. Use the lower-level plugin/core workflows only for an approved recovery;
never republish an immutable version.

For non-production child-workflow rehearsal only, the lower-level npm workflow
has `bypass_extended_stable_guard=true`. The normal parent publish does not
expose that bypass. Never use it for production.

### Verify and recover

From a separate clean current-`main` checkout, not the frozen branch, run:

```bash
node --import tsx scripts/openclaw-npm-postpublish-verify.ts YYYY.M.P
npm view openclaw@YYYY.M.P version --userconfig "$(mktemp)"
npm view openclaw@extended-stable version --userconfig "$(mktemp)"
```

Require signatures and npm provenance for the canonical branch, plus publish,
preflight, and tarball-digest binding to the release SHA. Both commands must
return `YYYY.M.P`. Verify every prepared core package and `all-publishable`
official plugin at its exact version and selector.

If core npm published but the parent failed afterward, repeat the same
`OpenClaw Release Publish` command with
`-f openclaw_npm_resume_run_id=<successful-core-publish-run-id>`. The parent
must prove the live registry tarball is the preflight artifact before it resumes
release evidence, Docker, and the shared finalizer.

If npm publication and its selector are already complete but only Docker
publication needs recovery, use the narrower Docker-only path from current
`main`:

```bash
gh workflow run openclaw-release-publish.yml \
  --ref main \
  -f tag=vYYYY.M.P \
  -f preflight_run_id=<npm-preflight-run-id> \
  -f full_release_validation_run_id=<full-validation-run-id> \
  -f full_release_validation_run_attempt=<full-validation-run-attempt> \
  -f npm_dist_tag=extended-stable \
  -f publish_openclaw_npm=false \
  -f publish_docker_only=true
```

This path rechecks the exact npm version, `extended-stable` selector, preflight
tarball digest, and validation evidence before invoking `Docker Release`. It
does not run the shared GitHub Release finalizer; use the core-resume path when
the draft release also needs evidence attachment or publication.

To promote an already-published core version to `extended-stable`, use
**OpenClaw NPM Dist-Tag Operations** in
`openclaw/releases`, not the publish or resume path. Use its `promote_extended_stable` mode from that repository's `main`:

```bash
gh workflow run openclaw-npm-dist-tags.yml \
  --repo openclaw/releases --ref main \
  -f mode=promote_extended_stable \
  -f tag=vYYYY.M.PATCH
```

Replace `vYYYY.M.PATCH` with the exact approved final extended-stable release tag
(patch `33` or higher, without a suffix). Extended-stable fixes increment the
patch (`33`, `34`, `35`, and so on), never a correction suffix. Regular stable/beta
promotion and sync reject patch `33`
or higher, including the scheduled beta floor. Promotion can select a newer version or roll back to an older one. The action checks
that the public Git tag and exact npm version exist, permits older monthly lines
and historical unsuffixed final versions, and changes only core `openclaw`'s
`extended-stable` selector. It uses the release repository's `NPM_TOKEN`; no local
npm login or source-repository publish credentials are needed. It does not write
`latest`, `beta`, plugin or other prepared-core selectors, Docker aliases, Git
tags, or GitHub Releases, and does not republish packages.

Wait for the run to succeed and verify the intended target:

```bash
npm view openclaw dist-tags --json --prefer-online --registry=https://registry.npmjs.org/
```

The job summary records the previous and target versions. The action skips an
already-correct selector and retries registry readback, not the tag write. After
an unconfirmed write or exhausted readback, inspect the live selector before
retrying. Repair plugin or other prepared-core selectors separately through
approved credential-isolated tooling. A selector rollback neither repairs the
bad version's published bytes nor downgrades existing installations. Do not
resume publication of a rejected release as part of rollback.

Require `Docker Release` to verify exact default, slim, browser, and architecture
images in GHCR and Docker Hub, including attestations and platform versions. It
must advance only `extended-stable`, `extended-stable-slim`, and
`extended-stable-browser` by digest; regular aliases remain unchanged and
automatic rollback is rejected. Confirm the GitHub Release contains the shared
dependency, Full Release Validation, and postpublish evidence assets but no
native-app assets.

For alias repair, run approval-gated `Docker Channel Promotion` from current
`main` with the tag. It repeats digest, attestation, and platform checks, allows
an explicit rollback, and never rebuilds images. npm retagging does not invoke
this action; if Docker aliases must also move, dispatch it separately with an
existing extended-stable image tag and verify all three aliases on both
registries. Docker derives the channel from the target version,
so a historical regular-stable tag is not an extended-stable Docker rollback.

Slack, Discord, and Codex are the initial documented support surfaces, not a
release allowlist: every npm-publishable official plugin ships. The shared
pipeline attaches dependency, Full Release Validation, and postpublish evidence
to the extended-stable GitHub Release. The selected npm tag is
`extended-stable`, so npm `latest` remains unchanged. Do not publish ClawHub
packages, native apps, website artifacts, or private dist-tags from this Gateway
track.
