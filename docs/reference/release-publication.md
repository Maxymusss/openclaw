---
doc-schema-version: 1
summary: "Prepare publication, inspect workflow inputs, and recover failed publishers"
title: "Release publication reference"
read_when:
  - Prepare publication, inspect workflow inputs, and recover failed publishers
---

Use this reference when you need to prepare publication, inspect workflow inputs, and recover failed publishers. For the release sequence, start with [Release policy](/reference/RELEASING).

## Regular release publish automation

### Check publication gates

Run the read-only publish preflight before regular beta or stable publication
through the protected `OpenClaw Release Publish` route, including after a failed
attempt. Alpha uses its matching Tideclaw workflow branch; extended-stable uses
the shared publisher with its dedicated track inputs but is not admitted by
this regular-release preflight command. Use the same
tag, validation run and attempt, channel, plugin selection, and frozen
publication tooling ref as the intended dispatch:

```bash
pnpm release:publish-preflight \
  --tag vYYYY.M.PATCH \
  --full-release-validation-run-id <full-validation-run-id> \
  --full-release-validation-run-attempt <successful-run-attempt> \
  --preflight-run-id <qualified-preflight-or-full-validation-run-id> \
  --npm-dist-tag latest \
  --plugin-publish-scope all-publishable \
  --workflow-ref release-publish/<tooling-sha12>-<epoch>
```

For a selected plugin repair, also pass
`--publish-openclaw-npm false --plugin-publish-scope selected --plugins @openclaw/name`.
The preflight downloads the selected validation manifest once, checks publication
and stable closeout prerequisites, and prints a `PASS`/`FAIL`/`WARN` table with
remediation and the exact dispatch command. `FAIL` exits nonzero. `WARN` identifies
an unresolved prerequisite or a check that requires an owner action; it is not
publication approval. Final publisher checks still run at each mutation boundary.

The report includes per-package npm state, first-publication bootstrap
eligibility, any matching draft or published GitHub release, and active plugin
or ClawHub runs that can hold publication concurrency groups. Verify the exact
parent and child identities before cancelling an orphan; the tool does not
cancel runs. If core npm is already published, use the verified original
`openclaw_npm_resume_run_id` reported by preflight instead of dispatching a new
immutable-version publish. An ambiguous or missing original run needs manual
evidence reconciliation.

Already-published plugin versions still need the correct npm selectors. A
reported dist-tag repair belongs to credential-isolated release tooling; the
plugin publisher does not repair those selectors when reusing existing bytes.
The report also checks frozen release-note rendering and any supplied Telegram
evidence before publication begins.

Main version/changelog reconciliation and final release-asset checks belong to
postpublication closeout. Their `WARN` rows record pending work; they do not
require moving closeout ahead of publication. Policy failures such as missing
soak, missing blocking performance, or an expired rollback drill remain failures.

#### Probe the bootstrap token

For never-published npm packages, the local preflight cannot read the repository's
`NPM_TOKEN` secret. A secret's presence or update time does not prove it works.
Run this read-only step in an approved GitHub Actions job with access to that
exact repository secret, before starting package bootstrap:

```yaml
- name: Check bootstrap npm token
  shell: bash
  env:
    NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
  run: |
    set +x
    set -euo pipefail
    test -n "${NPM_TOKEN// }"
    umask 077
    probe_dir="$(mktemp -d)"
    trap 'rm -rf "$probe_dir"' EXIT
    printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$probe_dir/npmrc"
    unset NPM_TOKEN NODE_AUTH_TOKEN NODE_OPTIONS
    cd "$probe_dir"
    env -i HOME="$probe_dir" PATH="$PATH" npm whoami \
      --registry=https://registry.npmjs.org \
      --userconfig="$probe_dir/npmrc" --globalconfig=/dev/null >/dev/null
    echo 'PASS: repository bootstrap token authenticated'
```

Keep the probe run URL with release evidence. `npm whoami` checks authentication;
it does not prove package scope permissions or authorize publication. A failure
requires the credential owner to repair the secret and repeat this probe. Never
substitute a local npm login for proof of the repository secret, and never print
the token or upload its temporary npmrc.

### Prepare once, then use the release button

For a complete regular beta or stable release, use `OpenClaw Release Prepare`
before publication and `OpenClaw Release Button` when ready to publish. Both run
from the same frozen `release-publish/<sha12>-<id>` tooling tag. The existing
release tag, successful npm preflight, exact Full Release Validation attempt,
reviewed SDK acknowledgement when required, and stable Windows source evidence
must already be available. This does not create a version or release tag.

Run `pnpm release:candidate` with `--publish-workflow-ref` set to that protected
tag. Its evidence bundle and terminal output include a **prepare once** command
for complete regular releases. After creating the frozen release tag, run that
command. It dispatches the existing npm and ClawHub preflight workflows in
parallel, builds and qualifies their final package bytes, and seals a readiness
receipt only after every package can be downloaded and verified. Preparation
does not publish packages or change public selectors.

Every ClawHub package must already have the normal trusted-publisher binding.
Preparation refuses to issue a readiness receipt for packages needing bootstrap
or publisher repair; use the existing ClawHub owner workflow to finish that setup
first. The button rechecks this prerequisite before starting any plugin writer.

When preparation succeeds, copy its summary's `prepared_artifact` JSON into
**OpenClaw Release Button**, selecting the same protected tooling tag. This is
the only input needed for a new publication: the receipt contains the release tag,
channel, validation references, complete package inventories, and exact artifact
IDs, digests, producer runs and attempts. The button invokes the existing
protected publisher; existing environment approvals and registry authority
checks remain in force. The receipt seals plugin readiness; the existing parent
revalidates the core npm, Full Release Validation, and Windows evidence before
dispatching publication.

#### Verify prepared package bytes

The publisher verifies the complete prepared npm and ClawHub package set before
starting any plugin writer. Plugin jobs restore and upload those exact bytes;
they do not install source dependencies, rebuild, or repack them. Packages that
are already present must match the prepared integrity and canonical public
tarball before they can be adopted. Core npm and Docker retain their existing
prepared-artifact and release-evidence checks. Because ClawHub's publication
authorization depends on terminal parent success, the outer button waits for
the publisher and then verifies ClawHub's canonical public downloads. Only then
does it make the GitHub draft release visible.

#### Platform scope

Optional stable Windows promotion starts after that outer activation, using the
same sealed source tag, installer digests, and protected tooling. The ordinary
unprepared publisher retains its own post-finalization Windows job; the two
routes do not both dispatch. Missing Windows selection skips promotion, an
incomplete selection fails visibly, and alpha/beta never dispatch it. Windows
failure does not undo npm or GitHub publication. Inspect the attempt-bound
Windows dispatch artifact and linked child before an explicit manual retry;
neither publisher waits for native completion.

This button covers core and plugin npm, ClawHub, the existing Docker/Windows
contracts, and GitHub release visibility. It does **not** claim that independent
macOS signing/feed promotion, Android completion, app-store submission, or
website publication is ready. Those owners retain their existing release steps.
Alpha, selected-plugin repairs, and historical releases without a readiness
receipt continue to use their existing owner workflows. Extended-stable uses
the shared direct publisher with its dedicated track inputs, not this button.

### Recover a failed download

Transient network failures, interrupted responses, HTTP 408/429, and retryable server
errors receive bounded retries with backoff and `Retry-After` handling. Each
retry requests the original artifact ID again, obtaining a fresh signed URL.
Transfers have a shared deadline; permanent authentication/not-found failures,
identity drift, and digest/size mismatches stop instead of selecting another
artifact. Complete verified ZIPs can be reused within the same runner, but only
after fresh producer checks and a fresh local hash. An interrupted file restarts;
this does not assume GitHub supports byte-range resumption. A new runner may
download the same immutable bytes again.

#### Recover preparation dispatch

Preparation retains `request.json` before its first dispatch and after each
acknowledgement. A `null` child ID means **unconfirmed**, not that no run exists.
After inspecting Actions, fill both `npmRunId` and `clawhubRunId` with the exact
positive numeric child IDs. Start a new **OpenClaw Release Prepare** run on the
same protected tooling tag with the same `publish_inputs` and this JSON as
`preparation_request`. It adopts those runs without dispatching any workflow;
the seal still verifies their source, tooling, complete rosters, and package bytes.
If a child never existed, start only that missing owner: **Plugin NPM Release**
with `preflight_only=true` and `trusted_publisher_preflight=false`, or **Plugin
ClawHub Release** with `dry_run=true`. Use the same protected tooling tag, exact
source SHA as `ref`, and `publish_scope=all-publishable`, then supply both IDs.
Never repeat an uncertain dispatch. This JSON is an explicit selection of runs
to qualify, not cryptographic proof of original dispatch lineage.

#### Reconcile an uncertain publication dispatch

Publication similarly creates `dispatch.json` before its single POST. It records
the initiating button run/attempt, complete effective inputs (including any core
resume override), frozen source/tooling, and exact readiness descriptor.
`state: "unknown"` has no confirmed publisher. `state: "unverified"` retains a
returned publisher ID but no observed attempt; `expectedReleaseRunAttempt: 1`
is only an expectation. Only `state: "acknowledged"` records a freshly checked
publisher identity and observed attempt. The record is retained before summaries
or job outputs; an interrupted atomic update can also leave `dispatch.next.json`.
Inspect both files without treating the latter as automatic publication authority.

The `release-button-dispatch-<button-run>-<attempt>` artifact retains these named
files for **30 days**. Download and preserve the original artifact for recovery.
Upload/download failure or expiration means missing evidence, not permission to
create a replacement publisher. The CLI reports the request path, initiating
attempt, and known publisher ID. For an acknowledged request, verification is
read-only and can be repeated with the same protected tooling:

```bash
node scripts/openclaw-release-ready.mjs verify --request /path/to/dispatch.json
```

Unknown, unverified, unsupported, or inconsistent requests stop before verification
or activation: **unknown; do not redispatch**. Manually reconcile the original
button and publisher outcomes. Do not discover or adopt a latest run/attempt, edit
an uncertain record into a success receipt, or rerun the dispatch job. Even a
missing record cannot prove that publication did not happen.

| Failure                                                                   | Recovery                                                                                                                                                                                      |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outer readiness seal/download fails after both child preparations succeed | On **OpenClaw Release Prepare**, rerun **Verify and seal prepared publication**. It reuses the child run IDs, resolves their current attempts once, and does not dispatch another build.      |
| A linked non-publishing npm or ClawHub preparation fails                  | Choose **Re-run all jobs** on that child, including resolution and every pack/preflight job. After the complete attempt succeeds, rerun only the outer seal.                                  |
| Preparation dispatch stops partway through or loses a response            | Inspect Actions and recover with `preparation_request` as described above. A missing acknowledgement is not permission to repeat the dispatch.                                                |
| Publisher download fails before writes                                    | Start an explicit new **OpenClaw Release Button** run with the same `prepared_artifact`. No version bump or repack is needed.                                                                 |
| The button's final ClawHub readback fails after an upload                 | Treat publication as possibly visible and verification as pending. Rerun the button's failed verification job; its successful dispatch job is not repeated.                                   |
| A publisher itself partially fails                                        | Inspect the original publisher and its core child. Recover through a new button run; the publisher automatically resolves the original successful npm run when core npm is already published. |
| Artifact expired/deleted or integrity differs                             | Stop and reconcile any publication attempt before explicitly preparing a new receipt. Missing evidence never authorizes a replacement publisher; never silently use a newer successful run.   |
| Publication dispatch response is lost                                     | Preserve `dispatch.json` and any `dispatch.next.json`, inspect the initiating button and original publisher outcomes, and stop for manual reconciliation. Never automatically redispatch.     |

Use **Re-run failed jobs**, not **Re-run all jobs**, after the button has
dispatched publication. Its dispatch job refuses a second attempt; verification
and final visibility can be retried independently without another registry
upload. Separate button runs are still separate operator publication requests,
not a global exactly-once transaction across registries.

#### Resume published npm bytes

A parent workflow attempt and its child receipts are one authorization unit.
The button never substitutes a newer parent attempt for its recorded dispatch.
For prepared publication recovery, start a **new button run** with the same
`prepared_artifact` and protected tooling tag. If core npm is already published,
the publisher recovers its **successful original OpenClaw NPM Release child**
from the npm provenance receipt for the exact version and preflight tarball bytes.
It verifies the original protected tooling tag, workflow SHA, attempt, and
successful publish job, even when the recovery parent uses newer tooling.
Later reruns of that child do not replace the signed publisher attempt. Recovery
and final verification read that exact historical attempt and retain it in the
release evidence, whether a later rerun succeeds or fails.
The optional `openclaw_npm_resume_run_id` must match that recorded publisher;
missing or ambiguous provenance fails closed. Final registry and Sigstore
verification still run, and release evidence retains the original publisher.
If npm contains the core version but that child
failed, stop and preserve the original run and artifact evidence. The existing
core owner rejects republishing an existing version and requires a successful
child for resume; this case needs maintainer reconciliation/core-owner repair,
not a button retry. All other frozen inputs and prepared artifacts remain unchanged.
Direct publisher runs include a copy-pasteable resume command in the run summary,
preserving every original input and the protected tooling ref. Prepared button
recovery still uses a new button run so its receipts remain bound to that request.
The new button records its new recovery parent, waits for that exact attempt to
succeed, verifies canonical ClawHub downloads, and then activates the GitHub
release. Do not adopt a replacement parent into the original button or bypass
this path with a manual finalizer.

A rerun child preparation must seal the complete package set from successful
pack/preflight jobs in that same attempt. Reusing previous-attempt jobs or
rerunning only the child's seal is rejected; rerun all jobs in that
non-publishing child, then rerun only the outer seal.

### Direct publication and owner recovery

For beta, `latest`, plugin, GitHub Release, and platform publication,
`OpenClaw Release Publish` remains the protected mutating owner. The monthly
`.33+` Gateway extended-stable path uses this same publisher with its own
track inputs, non-Latest GitHub release, and no ClawHub or native publication.
The workflow orchestrates the trusted publishers for the selected track. Linux,
Windows, and macOS Gateway cross-OS install and upgrade validation is required
for beta, stable, and full publication; failures block the saved validation
evidence. macOS app signing, notarization, appcast updates, and Windows Hub asset
promotion can run in parallel with or after npm publication and never delay
npm. Their artifact contracts still govern platform readiness and GitHub
release closeout. Full Release Validation and qualified package artifacts must already be green; no app artifact is a prerequisite:

1. Check out the release tag and resolve its commit SHA.
2. Verify the tag is reachable from `main` or `release/*`, a Tideclaw alpha branch for alpha prereleases, or the canonical `extended-stable/YYYY.M.33` branch for extended-stable.
3. Run `pnpm plugins:sync:check`.
4. Dispatch `Plugin NPM Release` with `publish_scope=all-publishable` and `ref=<release-sha>`.
5. Dispatch `Plugin ClawHub Release` with the same scope and SHA, except for extended-stable.
6. After plugin npm succeeds, dispatch `OpenClaw NPM Release` with the release tag, npm dist-tag, and saved `preflight_run_id` after verifying the saved `full_release_validation_run_id` and exact run attempt. ClawHub proceeds in parallel.
7. Verify the published npm package and selector readback, then call reusable `Docker Release` with the immutable tag and SHA. By default, finalize the draft GitHub release after npm and Docker evidence succeeds. The explicitly requested `finalize_release_before_docker=true` fast path activates after npm verification and evidence uploads, then publishes Docker; Docker remains part of the Gateway distribution. Extended-stable finalization uses the shared finalizer with `latest=false` and skips native stages.
8. For regular stable, optionally dispatch `Windows Node Release` after finalization with both `windows_node_tag` and candidate-approved `windows_node_installer_digests`. It attaches signed installers and checksums to the public release as a detached child. Omit both inputs to skip Windows dispatch. When the tagged `apps/android/version.json` matches the release train, qualify and dispatch `Android Release` independently for its exact-tag signed APK, checksum, and provenance; run macOS validation/preflight/publish through `openclaw/releases` in parallel or afterward. No app workflow delays npm or GitHub release finalization. Track app failures through their summaries and evidence, then recover only the failed platform.

#### Android qualification and recovery

The Android train is pinned independently. If its tagged version differs from
the stable tag's base version, the parent skips both native qualification and
APK publication and records the pin, expected train, and remedy in its summary
and release proof. Before the next tag, prepare the shared mobile release with
`node --import tsx scripts/mobile-release-version.ts --prepare --version YYYY.M.PATCH --write`.
When preparing the core and mobile release together, use
`pnpm release:prepare --version YYYY.M.PATCH --android --write`; its Android
selection uses the same shared mobile preparation and reads pending notes from
`apps/ios/CHANGELOG.md`. The generated Android notes must fit
[Google Play's 500 Unicode character limit](https://support.google.com/googleplay/android-developer/answer/9859348),
including the final newline. iOS App Store finalization remains a separate step.
A matching pin still requires successful native qualification; a failed run is
never recorded as a pin mismatch skip.

Android approval binds the release tag and target SHA to the approving parent's
run ID, exact attempt, full ref, and workflow SHA. npm-stable publication adds the
native CI run, exact attempt, and tooling ref in a v3 receipt; full validation
retains the historical v2 receipt. The child verifies the attested receipt and
the live parent identity, including the protected tooling tag or main ancestry.
Normal Android admission accepts an active or successfully completed
parent and the exact stable target release, whether draft or public. Failed or
cancelled parents remain rejected; explicit recovery can separately admit a
completed failed parent. Before provenance publication and each asset upload,
Android rechecks the live release tag target and stable classification, protected
tooling identity, native CI qualification when present, and exact parent attempt/state.
The parent also rechecks native qualification immediately before dispatch.
These are fresh boundary checks,
not an atomic GitHub validation-and-write transaction. A dispatched run link is
pending publication evidence, not an APK download claim. Monitor and approve the
linked Android run separately;
if dispatch cannot be confirmed, inspect existing runs before retrying.
For explicit Android recovery, pass `release_publish_run_attempt`,
`release_publish_full_ref`, and `release_publish_workflow_sha` from that same
parent alongside its run ID and ref; a rerun requires its own matching receipt.
Older immutable release tags retain their original Android workflow contract.
Tags without the v3 consumer, including `v2026.8.2` and its same-source corrections,
require `release_profile=full` and their matching frozen release tooling;
npm-only qualification is rejected before core publication for those targets.

#### Freeze publication tooling

For real core npm, plugin npm, or ClawHub publication, run the parent from a
protected lightweight `release-publish/<sha12>-<epoch>` tag at the frozen Tooling
SHA. Parent and child provenance must carry that same full ref. Create and push
the tooling tag before running the publish command:

```bash
TOOLING_SHA="<recorded-full-tooling-sha>"
PUBLISH_REF="release-publish/$(printf '%s' "$TOOLING_SHA" | cut -c1-12)-$(date +%s)"
git tag "$PUBLISH_REF" "$TOOLING_SHA"
git push origin "refs/tags/$PUBLISH_REF"
# the push may warn "Cannot create ref due to creations being restricted" while the tag still exists
gh api "repos/openclaw/openclaw/git/ref/tags/$PUBLISH_REF" \
  || gh api -X POST repos/openclaw/openclaw/git/refs -f "ref=refs/tags/$PUBLISH_REF" -f "sha=$TOOLING_SHA"
```

Pass `--ref "$PUBLISH_REF"` to `gh workflow run`; real child publication from
`main` is rejected before work starts. Docker-only recovery may use `main`;
the matching Tideclaw alpha branch route is unchanged.

#### Publish a beta

Beta publish example (using the tooling tag above):

```bash
gh workflow run openclaw-release-publish.yml \
  --ref "$PUBLISH_REF" \
  -f tag=vYYYY.M.PATCH-beta.N \
  -f preflight_run_id=<successful-openclaw-npm-preflight-run-id> \
  -f full_release_validation_run_id=<successful-full-release-validation-run-id> \
  -f full_release_validation_run_attempt=<successful-full-release-validation-run-attempt> \
  -f plugin_sdk_api_acknowledgement=<reviewed-8-character-digest> \
  -f npm_dist_tag=beta
```

Include `plugin_sdk_api_acknowledgement` only when the npm preflight's Plugin SDK API report contains changes.

#### Resume a public release

An already-public GitHub release can be resumed with the same frozen inputs.
The publisher verifies its canonical notes and any recorded release SHA, leaves
the public page visible, and completes missing evidence assets after registry
verification. Existing immutable evidence must match; changed notes, conflicting
assets, or a body already handed to the post-docs publisher stop the initial
publisher. Finalization preserves the requested `make_latest` behavior and never
moves latest back from a newer release.

#### Activate before Docker when explicitly requested

When the operator explicitly wants the release page visible before Docker,
add `-f finalize_release_before_docker=true` to the direct publication command.
The default is `false`. This path still requires successful npm publication,
registry verification, evidence uploads, and one activation environment approval;
it activates the page before starting Docker. Docker remains required for the
parent to finish successfully. If Docker then fails, the page stays public and
the Docker-only recovery command below completes the missing distribution.
This input requires `publish_openclaw_npm=true` and cannot be combined with
`prepared_plugins`; prepared releases retain the button's final visibility owner.

#### Recover Docker publication

If a beta or regular stable package is already published but its container images are missing,
do not rerun npm or plugin publication. Reuse the immutable release tag plus its
successful npm preflight and Full Release Validation evidence through the
Docker-only recovery path. The workflow rechecks the exact npm version, the
selected npm dist-tag, and the published tarball digest before building containers:

```bash
gh workflow run openclaw-release-publish.yml \
  --ref main \
  -f tag=vYYYY.M.PATCH-beta.N \
  -f preflight_run_id=<successful-openclaw-npm-preflight-run-id> \
  -f full_release_validation_run_id=<successful-full-release-validation-run-id> \
  -f full_release_validation_run_attempt=<successful-full-release-validation-run-attempt> \
  -f npm_dist_tag=beta \
  -f publish_openclaw_npm=false \
  -f publish_docker_only=true
```

For regular stable recovery, use the same command with `tag=vYYYY.M.PATCH` and
`npm_dist_tag=latest`. Only regular stable tags (patches 1–32, including correction
suffixes) are accepted for `latest`; extended-stable recovery retains its own
selector. Recovery builds the canonical versioned images without republishing
npm packages or plugins, dispatching native releases, or finalizing the GitHub
release. Existing approval and provenance checks still apply.

#### Publish a stable release

Stable publication requires Full Release Validation with a `stable` or `full` profile, `runReleaseSoak=true`, and successful blocking performance evidence. Beta-profile evidence and operator reasons cannot waive these requirements. First-time plugin npm bootstrap for stable publication also requires stable/full validation.

Selected normal CI lanes, including Windows Node, macOS Swift, and Control UI, remain blocking. Linux, Windows, and macOS Gateway cross-OS install and upgrade release-check lanes also block beta, stable, and full publication.

```bash
gh workflow run openclaw-release-publish.yml \
  --ref "$PUBLISH_REF" \
  -f tag=vYYYY.M.PATCH \
  -f preflight_run_id=<successful-openclaw-npm-preflight-run-id> \
  -f full_release_validation_run_id=<successful-full-release-validation-run-id> \
  -f full_release_validation_run_attempt=<successful-full-release-validation-run-attempt> \
  -f plugin_sdk_api_acknowledgement=<reviewed-8-character-digest> \
  -f npm_dist_tag=beta
```

#### Recover Windows and macOS assets

Both Windows inputs are optional. To schedule detached promotion after GitHub publication, add `windows_node_tag` and `windows_node_installer_digests` together; the candidate helper records the digest map when given `--windows-node-tag`.

To attach Windows assets later or retry a failed promotion, use the exact OpenClaw tag, exact published Windows source tag, and approved installer digests:

```bash
gh workflow run windows-node-release.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f tag=vYYYY.M.PATCH \
  -f windows_node_tag=vX.Y.Z \
  -f expected_installer_digests='{"OpenClawCompanion-Setup-x64.exe":"sha256:<approved-x64-sha256>","OpenClawCompanion-Setup-arm64.exe":"sha256:<approved-arm64-sha256>"}'
```

Never substitute `latest` for either tag. Monitor the Windows run and its verification evidence separately; an unsuccessful promotion leaves the npm package and GitHub release published. macOS recovery uses `openclaw/releases/.github/workflows/openclaw-macos-validate.yml` and `openclaw-macos-publish.yml`, preserving the successful macOS preflight and validation run IDs when promoting prepared assets.

#### Promote stable to latest

Stable promotion directly to `latest` is explicit:

```bash
gh workflow run openclaw-release-publish.yml \
  --ref "$PUBLISH_REF" \
  -f tag=vYYYY.M.PATCH \
  -f preflight_run_id=<successful-openclaw-npm-preflight-run-id> \
  -f full_release_validation_run_id=<successful-full-release-validation-run-id> \
  -f full_release_validation_run_attempt=<successful-full-release-validation-run-attempt> \
  -f plugin_sdk_api_acknowledgement=<reviewed-8-character-digest> \
  -f npm_dist_tag=latest
```

#### Repair selected plugins

For a selected plugin repair, use `OpenClaw Release Publish` with `publish_openclaw_npm=false`, `plugin_publish_scope=selected`, and `plugins=@openclaw/name`. The parent rejects selected scope when `publish_openclaw_npm=true` so the core package cannot ship without every publishable official plugin, including `@openclaw/diffs-language-pack`.

`Plugin NPM Release` also supports direct focused repair dispatch.

Plugin npm artifact preflight checks out only the trusted scripts and workflows
it needs. Preflight and publication fetch the selected source manifest on demand
at the exact release SHA. Each verifier still independently checks that manifest
against the artifact's recorded source hash, together with the tarball hashes
and producer identity.

After a successful plugin npm publish, a full release child can report
"published, visibility pending" when registry metadata or tarball reads remain
unavailable, or the selector is missing or behind the published version.
The parent's final registry verification remains required for
release completion; do not republish the package. The parent enables the internal
`defer_registry_verification` input only when `publish_openclaw_npm=true`.
Standalone and plugin-only repairs keep strict readback. Conflicting package
identity or bytes, malformed selectors, and selectors ahead of the published
version always fail rather than becoming pending visibility.

#### Verify plugin qualification and registry bytes

Each publisher uploads the exact qualification tuple it consumed, including any
retained producer attempt. The full release parent binds those receipts to the
successful publisher jobs, revalidates the original immutable artifacts against
the frozen source and tooling, and downloads each published tarball to compare
its exact bytes and selectors before recording release success. Missing required
receipts fail closed. The standalone release health verifier retains metadata
checks and does not claim qualified-artifact verification. The child also uploads its resolved publication plan, including
the complete selected roster and already-published packages. The parent requires
a successful publisher for every planned candidate. Already-published packages
still require a successful tarball download with matching registry integrity,
archive package identity, version, and selectors; a fresh parent cannot bypass
pending visibility from an earlier publication. These checks do not invent an
earlier qualification receipt. Failed-job retries can retain the original
successful planning attempt.

When a newer plan skips a package after an older publisher failed, the parent
still verifies that publisher's original qualified bytes. Its receipt is usable
only when the exact receipt-upload step completed successfully in that earlier
attempt; a later job failure cannot turn a byte conflict into an accepted skip.

#### ClawHub authorization and recovery

ClawHub OIDC publication requires the executing release parent to authorize the exact child run, attempt, and package inventories. A direct `Plugin ClawHub Release` dry run can prepare packages without publication authority, but a standalone publish cannot replace the parent.

Bot-dispatched children stay on the automated route and are terminal once their exact parent attempt completes without success.

A direct human `Plugin ClawHub Release` dispatch with `release_publish_run_id` always takes ClawHub's explicit-recovery route. The `approve_plugins_clawhub_release` environment job uploads the version 2 `openclaw-clawhub-recovery-approval-<run-id>-<run-attempt>` receipt, which names the original child attempt (`authorizedChildRunId`/`authorizedChildRunAttempt`) whose parent receipt `openclaw-clawhub-parent-authorization-v2-<parent-run-id>-<parent-run-attempt>-<child-run-id>-<child-run-attempt>` the completed parent already uploaded; a completed parent cannot mint a new one.

ClawHub resolves that parent receipt through the authorized child and requires the recovery child to run the same workflow ref and SHA, candidate SHA, tooling, parent attempt, and exact package inventory, so dispatch recovery from the parent's tooling ref with the parent's inputs.

Pass `recovered_clawhub_run_id` and `recovered_clawhub_run_attempt` to name the original child explicitly; when omitted, the approval job discovers it from the parent run's single matching receipt and fails with the candidate list when zero or several exist.

Version 1 recovery receipts are rejected. Do not retry publication with copied receipts or treat staging as completed publication.

```bash
gh workflow run plugin-clawhub-release.yml \
  --ref <parent-tooling-ref> \
  -f publish_scope=all-publishable \
  -f ref=<full-40-character-release-sha> \
  -f release_tag=vYYYY.M.PATCH \
  -f release_publish_run_id=<parent-run-id> \
  -f release_publish_run_attempt=<parent-run-attempt> \
  -f release_publish_branch=<parent-tooling-ref> \
  -f release_publish_full_ref=<parent-tooling-full-ref> \
  -f release_publish_workflow_sha=<parent-tooling-sha> \
  -f recovered_clawhub_run_id=<original-child-run-id> \
  -f recovered_clawhub_run_attempt=<original-child-run-attempt>
```

Before dispatching either ClawHub publisher, the parent checks waiting children
for the same release tag across tooling refs. It cancels a superseded child at
its pending gates only after verifying its failed parent attempt and confirming no
job is running, then waits for the child to finish before dispatching. Target
concurrency stays unchanged, so publication remains serialized. Each dispatch
is recorded immediately; a later parent failure or cancellation cleans up its
own unfinished ClawHub children, including a partially dispatched batch.
Successful detached children and active publishers are preserved. Identified
validation runs and other release tags remain independent, even on the same
tooling ref. The normal publisher also blocks unidentified legacy runs on the
same tooling ref; bootstrap preserves its existing independent slots on `main`.
For a blocking manual or older child without the parent identity in its run
title, follow the reported run URL: wait for publication, or reject the stale pending deployment through
GitHub's [pending-deployments API](https://docs.github.com/en/rest/actions/workflow-runs#review-pending-deployments-for-a-workflow-run)
with `state=rejected` before retrying.

If a later Docker failure cancels unfinished ClawHub children, Docker-only
recovery restores the container distribution only. Inspect both ClawHub child
outcomes; resume the full parent or use the explicit ClawHub recovery flow for
any canceled publication. A public GitHub release does not prove ClawHub completed.

#### Validate ClawHub bootstrap before tagging

For pre-tag ClawHub bootstrap validation, dispatch `Plugin ClawHub New` from
trusted `main` and pass the full target release SHA through `ref`. Tagged
bootstrap is dispatched by the approved parent from its protected tooling tag;
Tideclaw alpha uses separately approved `main` tooling. Never dispatch bootstrap
from the product release tag or a release branch:

```bash
gh workflow run plugin-clawhub-new.yml \
  --ref main \
  -f plugins=@openclaw/name \
  -f ref=<full-40-character-release-sha> \
  -f pretag_validation=true \
  -f dry_run=true
```

Pre-tag validation requires `dry_run=true`, rejects release-tag and parent-run
inputs, and accepts only an exact target reachable from `main` or `release/*`.
It does not load ClawHub credentials, publish package bytes, or change trusted
publisher configuration. The workflow still resolves the live registry plan,
checks out and packs the target only in a secretless job, materializes the
locked ClawHub toolchain, and validates the immutable artifact and package
slug/identity before the release tag exists. Approve the
`clawhub-plugin-bootstrap` environment only after the secretless pack jobs
finish; this protected validation job has no credentials or mutation commands.

An approved dry run or real bootstrap after tagging must include the exact
release tag plus the parent `OpenClaw Release Publish` run id, attempt, and
ref. The parent attests the bootstrap workflow ref and exact SHA, using its
protected tooling tag for regular publication or separately approved `main`
tooling for Tideclaw alpha; the child run and every protected environment
approval must match that approved child SHA. The release tag is
rechecked before every publish attempt and trusted-publisher mutation.

The pack job
uploads one immutable artifact whose name, Actions artifact ID/digest,
producer run/attempt, target SHA, and per-package tarball SHA-256/size are
carried into the validation and protected jobs. The protected job checks out the parent-approved trusted
tooling, validates the artifact tuple through the GitHub API, downloads
by exact artifact ID, rehashes every tarball, and validates local TAR paths and
package identity with the pinned CLI's USTAR canonicalization rules. Every
candidate then passes the pinned CLI publish dry-run, which returns before
registry lookup or auth. The credential-job prefilter caps compressed ClawPacks
at 120 MiB, total file payload at 50 MiB, expanded TAR data at 64 MiB, and
TAR entry count at 10,000. Existing-package trusted-publisher repair remains
configure-only, but it still packs the target and requires the requested tag
plus exact registry byte and metadata equality before changing trusted-publisher
configuration. Post-publish verification downloads the ClawHub artifact and
requires the same SHA-256 and size. A rerun-failed recovery may reuse an earlier
attempt's package artifact only when the exact producer job completed
successfully. Final evidence also binds the locked ClawHub version, lock
SHA-256, and npm integrity. A mismatch requires a new package version.

## Prepared artifacts and publication evidence

### SDK comparison receipts

Regular beta/latest SDK reports pool identical comparisons by their full diff digest.
The diff artifact (`openclaw.plugin-sdk-api-diff-set/v1`) maps each selector to
its complete entry in `diffs`. Evidence sets use `openclaw.plugin-sdk-api-release-evidence-set/v2`;
each selector retains its own predecessor, release, and tooling identity, with
`diff` referencing that same pool. The validator expands the selected receipt
and verifies the unchanged logical digest and acknowledgement. Historical v1
receipts remain readable; artifact hashes cover the new stored bytes. This
representation does not qualify or replace an earlier failed artifact.

### Prepared packing and changelog size

Prepared packing reuses the exact preflight build while retaining package smoke checks, inventory generation, docs and changelog preparation, and source restoration. It also runs `pnpm update:compat:check` against npm's current `latest` and `beta` tags before packing. Ordinary source packing still performs a clean package build without that registry freshness check.

Packaging resolves the selected release through the shared owner and temporarily replaces the root index with that release's notes. If initial notes exceed 500 KiB, it keeps every editorial note and replaces only the complete contribution record with a link to the exact release tag's `CHANGELOG/records/YYYY.M.PATCH.md`; historical monolithic tags retain their `CHANGELOG.md` record link. Initial editorial notes must still satisfy the release-note minimum. If the compact result still exceeds the cap, local packing fails; GitHub Actions records a size-budget warning under the shared limits policy.

Later docs mirrors remain complete in the package while they fit the same cap. An oversized mirror produces a small page linking the complete changelog and its Raw view, the separate contribution record, and the release documentation. Those changelog links follow the maintained files on `main`, so they also work for historical releases whose tags predate the split layout. Packaging never truncates mirrored prose. Postpack restores the exact source index, leaving the full release entry, docs sources, and credits unchanged. The archive is not included in the npm package.

### Frozen tooling and release-note rendering

The release checkout remains the product/data root, while planning and final verification execute from the exact trusted workflow-source checkout so an older release commit cannot silently use obsolete release tooling.

Once publication binds the frozen Tooling SHA to an exact protected lightweight `release-publish/<12sha>-<provenance-run>` tag, that live tag-to-SHA mapping remains authoritative when `main` advances; the suffix records tag-creation provenance, not the current parent run id. Core and plugin npm publishers re-read that exact tag and revalidate the exact parent run tuple immediately before each npm publish or dist-tag mutation, failing closed on a missing, moved, annotated, or wrong-SHA tag, parent mismatch, or disallowed parent state.

Other privileged writers require their dependent enforcement changes before the protected-tag publication route is globally complete.

Before any publish child starts, it renders and caches the exact GitHub release body.

When the complete selected `CHANGELOG/YYYY.M.PATCH.md` section fits GitHub's 125,000-character limit and the renderer's matching 125,000-byte safety ceiling, the page contains that exact `## YYYY.M.PATCH` section including its heading.

When the source section does not fit, the page keeps the exact grouped editorial notes and replaces the oversized contribution record with a stable link to the full record in the tag-pinned `CHANGELOG/records/YYYY.M.PATCH.md` (historical monolithic tags retain their original record link); partial records and truncated bullets are never published.

The workflow chooses that full or compact body before adding `### Release verification`; if the proof tail would exceed the limit, it keeps the canonical body and relies on the immutable attached evidence instead.

### ClawHub staging and completion

Core npm dispatch and environment approval start as soon as plugin npm succeeds. Once the exact `npm-release` approval succeeds, the parent proceeds without waiting for core runner allocation. ClawHub inventory authorization and optional bootstrap completion can overlap the running core publish. A failed ClawHub authorization still fails the parent and leaves the GitHub release as a draft; the parent collects any already-started core result and records its evidence.

Normal ClawHub publication uses a v2 child identity and a parent-owned immutable authorization receipt. The child seals the exact packed package inventory; the parent validates the live child attempt, approved package set, candidate SHA, and tooling identity before uploading the receipt. The child submits staged packages without waiting for public visibility. After the parent succeeds, `Plugin ClawHub Postpublish` verifies the exact parent and child attempts, immutable receipt and tarballs, and canonical registry bytes. That detached verification must succeed before announcing plugin publication complete. An explicit no-publication dispatch record distinguishes Docker-only or empty plugin scope from missing evidence. Failed-parent recovery still requires a separately valid parent receipt bound to the recovery child; an old child-bound receipt cannot authorize a new run.

New npm preflight manifests record the producer's original qualified workflow ref, SHA, run ID, and attempt. Consumers compare that immutable tuple with the admitted producer; legacy manifests retain `legacy-unrecorded` provenance instead of inventing a full ref. ClawHub artifact readback proves package bytes and current registry metadata only: `publicationAuthentication: not-verified` does not attest how the historical publish authenticated.

## NPM workflow inputs

### OpenClaw NPM Release

`OpenClaw NPM Release` accepts these operator-controlled inputs:

- `tag`: required release tag such as `v2026.4.2`, `v2026.4.2-1`, `v2026.4.2-beta.1`, or `v2026.4.2-alpha.1`; when `preflight_only=true`, it may also be the current full 40-character workflow-branch commit SHA for validation-only preflight
- `preflight_only`: `true` for validation/build/package only, `false` for the real publish path
- `preflight_run_id`: existing successful preflight run id, required on the real publish path so the workflow reuses the prepared tarball instead of rebuilding it
- `full_release_validation_run_id`: successful `Full Release Validation` run id for this tag/SHA, required for real publish. Direct core publishes whose tag contains `-beta.` and whose npm dist-tag is `beta` may proceed on preflight alone with a warning. This exception does not apply to the full parent publisher or stable/`latest` promotion.
- `full_release_validation_run_attempt`: exact positive run attempt paired with `full_release_validation_run_id`; required whenever the run id is provided so reruns cannot change the authorization evidence during publish.
- `release_publish_run_id`: approved `OpenClaw Release Publish` run id; required when this workflow is dispatched by that parent (bot-actor real-publish calls)
- `plugin_npm_run_id`: successful exact-candidate `Plugin NPM Release` run id; required for a real `extended-stable` core publish. Trusted-main core recovery also accepts a trusted-main plugin recovery run bound to that same candidate.
- `npm_dist_tag`: npm target tag for the publish path; accepts `alpha`, `beta`, `latest`, or `extended-stable` and defaults to `beta`. Final patch `33` and later must use `extended-stable`; by default, `extended-stable` rejects earlier patches, and it always rejects non-final tags.
- `bypass_extended_stable_guard`: testing-only boolean, default `false`; with `npm_dist_tag=extended-stable`, bypasses monthly extended-stable eligibility, including the trailing-completed-month rule, while preserving release identity, artifact, approval, and readback checks.

`Plugin NPM Release` accepts `npm_dist_tag=default` for existing release
behavior or `npm_dist_tag=extended-stable` for the guarded monthly path. The
extended-stable option requires `publish_scope=all-publishable`, an empty
`plugins` input, a final patch at or above `33`, and the canonical
`extended-stable/YYYY.M.33` branch at its exact tip, or the same immutable
target dispatched by `OpenClaw Release Publish` from its protected
`release-publish/<sha12>-<epoch>` tooling tag with that canonical branch named
in `release_candidate_branch`. The direct workflow may also run from trusted
`main` for approved workflow-only recovery. It never moves plugin
`latest` or `beta`. New package versions receive `extended-stable` atomically
through OIDC trusted publication (`npm publish --tag extended-stable`); this
source workflow does not use token-authenticated `npm dist-tag add`. Retries
skip exact versions already present in npm, then fail closed unless complete
readback confirms that every exact package and `extended-stable` tag converged.

### OpenClaw Release Publish

`OpenClaw Release Publish` accepts these operator-controlled inputs:

- `tag`: required release tag; must already exist
- `preflight_run_id`: successful `OpenClaw NPM Release` preflight run id; required when `publish_openclaw_npm=true` or `plugin_publish_scope=all-publishable`
- `full_release_validation_run_id`: successful `Full Release Validation` run id; required when `publish_openclaw_npm=true` or `plugin_publish_scope=all-publishable`
- `full_release_validation_run_attempt`: exact positive attempt paired with `full_release_validation_run_id`; required whenever the run id is provided
- `windows_node_tag`: optional exact non-prerelease `openclaw/openclaw-windows-node` release tag for detached Windows promotion after stable GitHub publication; omit both Windows inputs to skip dispatch
- `windows_node_installer_digests`: candidate-approved compact JSON map of the current Windows installer names to pinned `sha256:` digests; required only when `windows_node_tag` is supplied
- `npm_telegram_run_id`: optional successful `NPM Telegram Beta E2E` run id to include in final release evidence
- `openclaw_npm_resume_run_id`: successful original core publish run ID; verifies the registry tarball against preflight before resuming release evidence, Docker, and finalization without republishing core
- `npm_dist_tag`: npm target tag for the OpenClaw package, one of `alpha`, `beta`, `latest`, or `extended-stable`
- `finalize_release_before_docker`: explicit direct-publication fast path; default `false`. Activates the verified GitHub release before Docker, preserving the same environment approval and latest policy. Requires `publish_openclaw_npm=true` and no `prepared_plugins`. Docker failure leaves the release public for Docker-only recovery.
- `publish_docker_only`: beta, regular stable (`latest`), or extended-stable recovery/closeout path. It requires `publish_openclaw_npm=false`, complete preflight and Full Release Validation evidence, then verifies the exact npm package, selected dist-tag, and tarball digest before invoking Docker publication.
- `plugin_publish_scope`: defaults to `all-publishable`; use `selected` only for focused plugin-only repair work with `publish_openclaw_npm=false`
- `plugins`: comma-separated `@openclaw/*` package names when `plugin_publish_scope=selected`
- `publish_openclaw_npm`: defaults to `true`; set `false` only when using the workflow as a plugin-only repair orchestrator
- `release_profile`: release coverage profile used for release evidence summaries; defaults to `from-validation`, which reads it from the validation manifest, or override with `beta`, `stable`, or `full`
- `wait_for_clawhub`: defaults to `false`; set `true` when parent workflow completion must include ClawHub completion. Core npm starts after plugin npm succeeds under either setting.

### OpenClaw Release Checks

`OpenClaw Release Checks` accepts these operator-controlled inputs:

- `ref`: branch, tag, or full commit SHA to validate. Secret-bearing checks require the resolved commit to be reachable from an OpenClaw branch or release tag.
- `run_release_soak`: opt into exhaustive live/E2E, Docker release-path, and reported-issue upgrade-survivor soak for beta release checks. It is forced on by `release_profile=stable` and `release_profile=full`.

### Version and evidence rules

- Regular final and correction versions below patch `33` may publish to either `beta` or `latest`. Final versions at patch `33` or above must publish to `extended-stable`, and correction-suffix versions at that boundary are rejected.
- Beta prerelease tags may publish only to `beta`; alpha prerelease tags may publish only to `alpha`
- For `OpenClaw NPM Release`, full commit SHA input is allowed only when `preflight_only=true`
- `OpenClaw Release Checks` and `Full Release Validation` are always validation-only
- The real publish path must use the same `npm_dist_tag` used during preflight; the workflow verifies that metadata before publish continues
