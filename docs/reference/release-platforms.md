---
doc-schema-version: 1
summary: "Verify native app publication and finish stable main closeout"
title: "Release platforms and closeout"
read_when:
  - Verify native app publication and finish stable main closeout
---

Use this page to check which apps have published and finish the stable release
on `main`. Start with [Release policy](/reference/RELEASING) for the complete
release sequence.

## Check each platform separately

A public Gateway release does not mean every app is ready. Selected native-app
CI must pass before publication, but app signing and publication finish
independently. Record pending platforms and verify each before announcing it.

| Platform | Evidence of completed publication                                                               | Further guidance                                                                            |
| -------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Android  | Signed APK, checksum, and provenance for the exact release tag.                                 | [Android publication](/reference/release-publication#direct-publication-and-owner-recovery) |
| Linux    | Versioned AppImage and Debian package, signatures, checksums, and verified updater manifest.    | [Linux publication](#linux-companion-publication)                                           |
| macOS    | Signed and notarized zip, DMG, and dSYM assets, plus the matching stable appcast entry.         | [macOS release checks](/reference/release-validation#required-checks)                       |
| Windows  | Approved signed x64 and ARM64 installers and matching SHA-256 evidence attached to the release. | [Windows publication](/reference/release-publication#direct-publication-and-owner-recovery) |

The iOS App Store release is a separate publication step. It is not one of the
three app platforms recorded by stable closeout.

## Linux companion publication

Regular stable publication requests Linux bundles automatically after GitHub
activation. A successful request is not completed Linux publication. Verify the
versioned AppImage, Debian package, signatures, and checksums independently;
pending Linux work does not block npm, Docker, GitHub finalization, or stable
main closeout.

Resuming core publication reuses an in-progress or successful same-tag
`Linux App Release Request` from `main`, including a manually dispatched request.
The summary and retained `linux-dispatch.json` identify that request. A successful
request remains reusable if its independent `Linux App Release` builder later
fails: inspect and recover that Linux run explicitly instead of retrying core
publication to start another build. Failed or canceled requests can be replaced.

The Linux publisher writes immutable `OpenClaw-<version>-linux.json` evidence
beside the bundles. It binds the source tag/SHA, original release ID, trusted
tooling SHA, updater key, and exact asset identities. Complete public bundles
are verified and reused rather than rebuilt. Asset completeness is separate
from unfinished channel publication.

One post-build publisher advances the fixed `linux-stable` control release's
`latest.json` only forward, then mirrors those exact bytes onto the latest
Gateway release. An authorized Linux publication creates the control release
as prerelease/non-latest when absent; ordinary PR validation never creates it.
Bootstrap uses the existing release-owner GitHub App with contents and workflows
write access: GitHub requires workflows permission when the control tag targets
release-branch workflow changes, and `GITHUB_TOKEN` cannot provide it.
Conflicting state, or missing canonical metadata on an existing channel, fails
closed; it never grants permission to overwrite arbitrary metadata.

Before activating a new Gateway release, the existing carry step preserves the
previous usable Linux manifest's original version, signature, and download URL.
After finalization and readback, a bounded detached mirror-only request catches
up that legacy endpoint without keeping the core release waiting for the
metadata queue. Dispatch acceptance is not mirror success. Cancellation, queue
overflow, timeout, and readback failures are visible degraded outcomes requiring
reconciliation, not reasons to roll back core publication.

Every asset or release-note mutation revalidates the live executing writer and
its original validated publication request after preparatory reads. A canceled
or superseded attempt stops before its next write, including between deletion
and replacement. Partial state remains available for investigation.

An interrupted deletion of canonical `latest.json` requires explicit
release-owner reconciliation; normal publication refuses to guess a version
floor. Retain the last verified canonical manifest and all intervening
publication evidence. Under exclusive metadata-writer ownership, reread the
channel release ID, tag/SHA, inventory, and canonical absence, then prove that
the selected immutable manifest is not older than any intervening valid
publication. Verify its source and asset identities, restore those exact bytes,
and read back both canonical and legacy endpoints. Stop on ambiguity; a supplied
version/hash or current Gateway `latest` alone is not Linux forward-order proof.

This tooling does not activate a new shipped endpoint or download link.
Existing clients retain `releases/latest/download/latest.json`. A later
`linux-stable` client cutover requires separate release approval, qualified
signed artifacts, and an installed-old-client migration proof. An old client
cannot acquire a corrected version comparator before its current comparator
offers the update; verify the chosen version is newer under that shipped
comparator. Local tests, unsigned packaging, and metadata readback do not prove
that migration.

### Update the website downloads

After Linux assets publish, rebuild `openclaw.ai` through its website deployment
owner. Desktop download data is resolved at build time, so uploading release
assets alone does not update the website. Verify the deployed Apps card's version
and both Linux download URLs before calling the website handoff complete.

## Stable main closeout

Stable publication is not complete until `main` carries the shipped release
state and the closeout evidence is attached to the GitHub release.

### Reconcile main with the shipped release

1. Start from fresh latest `main`. Audit `release/YYYY.M.PATCH` against it and forward-port real fixes absent from `main`. Do not blindly merge release-only compatibility, test, or validation adapters into newer `main`.
2. For the normal path, set `main` to the shipped stable version. A late closeout may use `main` after it has advanced to a later stable OpenClaw CalVer; do not downgrade an already-started release train solely to close the prior release. The validator still requires the exact shipped changelog section and records the actual `main` version and SHA. It requires the matching appcast entry once the macOS release has published; until then it records `appcast: pending`. Run `pnpm release:prep` after any root version change.
3. Resolve the shipped release through the shared changelog owner. Its initial-format `CHANGELOG/YYYY.M.PATCH.md` section on `main` must exactly match the tagged release, with the matching contribution record retained separately. If `main` already has an approved docs mirror, preserve that prose and require its frozen contribution record to match the shipped accounting instead. Keep the generated root index current. Include the stable `appcast.xml` update when the mac release published one.
4. Do not add `YYYY.M.PATCH+1`, a beta version, or an empty future changelog section to `main` until the operator explicitly starts that release train.
5. Run `pnpm release:generated:check`, `pnpm deps:npm-lock:check`, and `OPENCLAW_TESTBOX=1 pnpm check:changed`. Push, then verify `origin/main` contains the shipped version and changelog before calling the stable release done.
6. Keep the repository variables `RELEASE_ROLLBACK_DRILL_ID` and `RELEASE_ROLLBACK_DRILL_DATE` current after each private rollback drill.

### Verify the closeout result

`OpenClaw Stable Main Closeout` starts from the `main` push carrying the shipped
version and changelog after stable publication. Apps may still be pending;
include the appcast once macOS publishes.

The workflow uses immutable postpublish evidence to connect the shipped tag to
its Full Release Validation and Publish runs. It verifies the release and
`main` state, successful stable/full validation, required soak, and blocking
performance evidence. Historical soak waivers do not satisfy these requirements.

A completed closeout attaches both an immutable manifest and its matching
checksum to the GitHub release. Check the workflow result and both assets;
a skipped run is not a completed closeout. Automatic runs skip releases that
predate immutable postpublish evidence. They also skip when rollback-drill
repository variables are missing. Manual closeout still requires a drill record
no more than 90 days old.

### Record pending apps and later attachments

The manifest records Android, macOS, and Windows separately in `appPlatforms`,
each as `pending` or `attached`. The combined `apps` status becomes `attached`
only when every required platform asset has a lowercase `sha256:<64hex>` digest.

At the first closeout, `appcast` remains `pending` until the complete macOS zip,
DMG, and dSYM asset set is attached with canonical digests. Once those assets
are complete, appcast verification is required and the status becomes
`verified`.

Replaying closeout preserves the original app snapshot. Previously recorded
asset names and digests must match exactly; later canonical app attachments
are allowed, but changed or deleted recorded assets and unrelated additions
remain errors. Recorded app, recovery, and asset fields stay byte-identical
while authoritative release fields are recomputed. If macOS attaches later,
replay checks its entry in the current `main` appcast while preserving any
appcast verification already recorded at the first closeout.

### Repair an incomplete closeout

Use manual dispatch only to repair or replay an evidence-backed stable closeout.
Private recovery commands remain in the maintainer-only runbook.

When the manifest exists but its checksum is missing, replay uses the recorded
`main` SHA and rollback drill to regenerate identical bytes and attach the
checksum. An invalid pair, or a checksum without its manifest, blocks closeout.

### Recover after a failed publication parent

If the Release Publish parent failed after immutable npm/plugin evidence was
attached, first repair and verify npm, Docker, and GitHub publication. A
maintainer may then manually dispatch closeout with
`allow_failed_publish_recovery=true`. This mode accepts only a completed failed
parent and retains all publication evidence checks. Automatic closeout never
enables it. Apps may remain pending, but a published macOS release still requires
a valid appcast.

When core npm succeeded but the original parent failed during postpublish
readback, a separately successful Docker-only publisher can provide Docker
proof. The checksummed postpublish evidence must identify both runs:

- `operatorRecovery.npmPublishRunId`: the npm publication run.
- `operatorRecovery.dockerPromotionRunId`: the Docker promotion run.

These fields select runs; they do not prove publication. Closeout verifies
exact Actions attempts, successful publication jobs, immutable dispatch
artifacts, protected tooling, qualified source, and Full Release Validation
bindings. It also verifies npm registry signatures, tarball hashes, and Sigstore
provenance, plus Docker image and attestation descriptors against the qualified
OCI manifest.

For historical publishers with incomplete receipts, missing bindings must come
from the unique Actions-generated input group of each named successful step.
Supported legacy whole-job logs additionally require the frozen publisher
shell-body hash, exact step number, and successful API step time window.
Arbitrary command output is never evidence.

This recovery applies only to the exact requested tag. Correction tags cannot
borrow another tag's recovery proof because they share a commit. Missing,
expired, ambiguous, or mismatched evidence blocks recovery. Closeout records
the failed original parent and both successful publication attempts; replay
must independently verify that same immutable recovery record.

### Prepare a correction release

A legacy fallback correction tag may reuse base-package evidence only when the correction tag resolves to the same source commit as the base stable tag. Its Android release reuses the base tag's verified APK and adds provenance for the correction tag. A correction with different source must publish and verify its own package evidence and use a higher Android `versionCode`.

For correction artifact preparation, validate the immutable SHA with `--target-ref release/YYYY.M.PATCH-N` before tagging, or the exact `vYYYY.M.PATCH-N` context after tagging. The existing `target_context_ref` workflow input carries the same context. This preserves the intended correction tag in both npm and Docker artifacts; a base-version package is accepted only when `vYYYY.M.PATCH` resolves to that same SHA. The package bytes keep their original version, and publishers still require artifacts sealed for the exact final tag. A base-context Full Release Validation run does not authorize reusing its base-tag publication artifacts for a correction.
