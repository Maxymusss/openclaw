---
doc-schema-version: 1
summary: "Choose a release track, validate a candidate, publish it, and finish closeout"
title: "Release policy"
read_when:
  - Preparing or publishing an OpenClaw release
  - Looking for release channels, version naming, and required validation
  - Finishing a stable release or recovering a failed publication
---

Use this guide to take an approved OpenClaw candidate from a release branch to a
verified publication. It covers the normal release sequence and links to the
more detailed commands for recovery and platform publishing.

**Final stable versions require stable or full validation, release soak, and
blocking performance checks.** This also applies when a final version is first
published to npm's `beta` tag. Beta-profile evidence and soak waivers cannot
qualify a final stable release.

## Before you begin

You need release approval, access to the repository's protected release
workflows, and a trusted checkout with the repository's supported Node and pnpm
versions. Signing credentials, environment approvals, emergency rollback, and
credential repair follow the maintainer release runbook.

Record the candidate commit, trusted tooling commit, intended version, npm
channel, and publication scope before dispatching validation. Keep those choices
fixed through publication. Never delete, move, or reuse a published release tag
or npm version.

## Choose a release track

| Track           | What it publishes                                                              | npm tag                              | Validation                                             |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------ |
| Stable          | A regular final release                                                        | `latest`, or `beta` before promotion | `stable` or `full`, with soak and blocking performance |
| Beta            | A prerelease for testing the next regular release                              | `beta`                               | `beta`; selected checks remain blocking                |
| Extended-stable | A Gateway maintenance release from either of the two trailing completed months | `extended-stable`                    | Follow the monthly release procedure                   |
| Dev             | The moving head of `main`                                                      | Not a regular npm release            | Development CI                                         |

Tideclaw alpha builds use a separate internal prerelease track and npm's `alpha`
tag. See the [workflow inputs](/reference/release-publication#npm-workflow-inputs)
for its publication rules.

### Version naming

| Release            | Version                              | Git tag                 |
| ------------------ | ------------------------------------ | ----------------------- |
| Regular final      | `YYYY.M.PATCH`, patch below `33`     | `vYYYY.M.PATCH`         |
| Regular correction | `YYYY.M.PATCH-N`                     | `vYYYY.M.PATCH-N`       |
| Beta               | `YYYY.M.PATCH-beta.N`                | `vYYYY.M.PATCH-beta.N`  |
| Alpha              | `YYYY.M.PATCH-alpha.N`               | `vYYYY.M.PATCH-alpha.N` |
| Extended-stable    | `YYYY.M.PATCH`, patch `33` or higher | `vYYYY.M.PATCH`         |

Do not zero-pad the month or patch. The patch is a sequential release number
within the month, not a calendar day. Extended-stable fixes increment the patch
rather than adding a correction suffix.

Alpha builds use the next unreleased train and increment `alpha.N`. Once that
train has a beta, new alpha builds move to the following train. Ignore older
alpha-only tags when choosing the next regular or beta patch number.

### Release cadence

Releases normally move beta-first. Validate the latest candidate before promoting
it to stable. Regular final and correction versions default to npm `beta`; choose
`latest` explicitly for direct stable publication.

For core and every published official plugin, `beta` must be at least as new as
`latest`. A prerelease on the same train is older than its final version. Repair
that floor immediately after publishing or promoting to `latest`, preserving any
newer beta. The scheduled repair is only a backstop.

<a id="regular-release-operator-checklist" />
<a id="fast-path-default" />
<a id="full-checklist" />
<a id="regular-beta-latest-stable-release-sequence" />
<a id="regular-beta%2Flatest-stable-release-sequence" />
<a id="regular-beta/latest-stable-release-sequence" />

## Stable release process

### 1. Prepare one release branch

Create `release/YYYY.M.PATCH` from the selected current `main` commit. Check the
base's CI and apply only the approved backports from merged `main` PRs. Complete
version updates, release fixes, release notes, and the contribution record before
freezing the candidate where possible.

Run `pnpm release:prep` after changing the root version. Review compatibility
changes and the [release preflight checks](/reference/release-validation#release-preflight),
including upgrade compatibility, generated files, translations, and package
checks. Do not use the full remote validation suite as a substitute for preparing
a consistent source tree.

Keep three identities clear:

| Name used by the tooling | Meaning                                                       |
| ------------------------ | ------------------------------------------------------------- |
| Code SHA                 | The commit containing the complete product candidate          |
| Release SHA              | The commit whose packages and notes will ship                 |
| Tooling SHA              | The trusted commit running validation and publication tooling |

Code SHA and Release SHA can be the same commit. Do not create another commit or
validation run just to give them different names. If only the release notes
change later, the [changelog-only reuse rules](/reference/release-changelogs#changelog-only-evidence-reuse)
allow limited reuse of product results; the new package and image bytes still
need qualification.

### 2. Run validation for the exact candidate

Use the SHA-pinned helper so the candidate and the tooling cannot drift with
`main`. Replace the example values with the recorded release identities:

```bash
CANDIDATE_SHA="<full-candidate-commit-sha>"
TOOLING_SHA="<full-trusted-tooling-commit-sha>"
RELEASE_BRANCH="release/YYYY.M.PATCH"
PUBLICATION_SELECTION='{"route":"normal","npmDistTag":"beta","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}'

pnpm ci:full-release \
  --sha "$CANDIDATE_SHA" \
  --target-ref "$RELEASE_BRANCH" \
  --workflow-sha "$TOOLING_SHA" \
  -f validation_purpose=publish \
  -f publication_selection_json="$PUBLICATION_SELECTION" \
  -f release_profile=stable \
  -f run_release_soak=true \
  -f rerun_group=all
```

This example validates a final version for the normal beta-first publication.
For an explicitly approved direct stable publication, change `npmDistTag` to
`latest`. A final version requires stable/full validation with either channel.

Use `release_profile=full` when the release calls for broader provider and media
coverage. For a beta **prerelease**, select `npmDistTag=beta`, the `beta` profile,
and its documented soak policy. For prepared publication through the release
button, select `route=prepared` from the start and keep that selection throughout.

All selected CI, Control UI, native-app, Node/Gateway, Telegram, QA, and live
checks must pass. Full qualification includes fresh package install, fresh
installer install, and packaged upgrade on Linux, Windows, and macOS. A beta's
explicitly deferred coverage is recorded as **not run**, never passed; those
beta deferrals do not apply to a final stable version.

Save the successful Full Release Validation run ID and exact attempt. The
integrated npm preflight qualifies the package bytes that publication will use;
retain that run as the publication preflight reference too. Review the Plugin
SDK API diff and record its eight-character acknowledgement only when changes
are reported.

For the stage matrix, artifacts, and focused recovery commands, see
[Full release validation](/reference/full-release-validation) and the
[validation reference](/reference/release-validation).

### 3. Check the candidate before tagging

Create the protected publication tooling tag at the recorded Tooling SHA using
the [publication commands](/reference/release-publication#direct-publication-and-owner-recovery).
Run the candidate helper against the untagged Release SHA:

```bash
pnpm release:candidate -- \
  --tag vYYYY.M.PATCH \
  --target-sha <release-sha> \
  --full-release-run <successful-validation-run-id> \
  --publish-workflow-ref release-publish/<tooling-sha12>-<epoch> \
  --release-profile stable \
  --npm-dist-tag beta \
  --skip-dispatch
```

Keep `--npm-dist-tag` and `--release-profile` identical to the validation
selection: use `latest` for direct stable publication and `full` if that was the
validated profile.

Add `--plugin-sdk-api-acknowledgement <reviewed-digest>` when the SDK report
requires it. Use `--publication-route prepared` if that was the selected route.
Optional `--windows-node-tag <exact-source-tag>` records the approved Windows
installer digests; Windows assets are not a prerequisite for npm publication.

The helper verifies the candidate, package evidence, plugin plan, and publication
preflight, then prints the next command. Stable candidate Telegram and Parallels
checks run before publication by default. A failed gate leaves the checklist
incomplete. After it passes, create and push the signed release tag at that same
Release SHA, then use the printed publication command.

### 4. Publish the qualified packages

Use the protected publisher with the same version, channel, package selection,
validation run and attempt, and tooling identity. It publishes plugin npm
packages before core npm and runs ClawHub work alongside them. It reuses qualified
artifacts rather than rebuilding a version during publication.

For the normal direct route, GitHub release finalization follows npm and Docker
verification. The prepared release button also verifies its ClawHub downloads
before making the release public. Follow the selected workflow's finalization
step; do not manually make a draft public to bypass a failed gate.

Native app publication is tracked separately. Passing native CI is still required
when selected; app signing, notarization, installer promotion, and asset attachment
can finish independently. See [platform publication](/reference/release-platforms).

See the [publication reference](/reference/release-publication) for prepared
publication, exact workflow inputs, approvals, and recovery. Its explicit
before-Docker option changes publication order only; it does not waive stable
validation.

### 5. Verify publication and finish stable closeout

Confirm the exact npm version and selected dist-tag, plugin publication results,
Docker images, and public GitHub release. Use the postpublish verifier and retain
the workflow evidence. A successful request or staged ClawHub upload does not
prove that packages or native assets are publicly available.

For promotion and beta-floor repair, use the release ledger's **OpenClaw NPM
Dist-Tag Operations** workflow in `openclaw/releases`. Recheck core and every
selected official plugin. If the ledger does not cover a listed package, use the
approved credential-isolated repair procedure and rerun verification.

Announce only the surfaces that have completed verification. Then finish
[Stable main closeout](/reference/RELEASING#stable-main-closeout); record pending
apps explicitly and verify them before announcing those platforms complete.

## When a release fails

| What failed                               | What to do                                                                                                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A product test                            | Preserve the first failure, diagnose the defect, fix its owner, and run focused validation. A confirmed product change needs a new candidate commit and fresh qualification. |
| Tooling, credentials, or a runner         | Keep the product candidate fixed. Repair the failing owner and use the documented recovery path.                                                                             |
| A validation collector                    | Recover collection against the exact existing children; do not dispatch another test suite just to repair reporting.                                                         |
| Publication after some packages succeeded | Reconcile the original run and registry evidence, then resume the incomplete stages. Never republish an immutable version.                                                   |
| A lost dispatch response                  | Treat the outcome as unknown. Find and verify the original run before another dispatch.                                                                                      |
| A native app publisher                    | Recover that platform independently and keep its pending status visible.                                                                                                     |

Automatic retries and a later passing replay do not establish that a failed test
was fixed. Inspect the failure before running another attempt. A focused green
run alone is not authorization to publish.

If the agreed release budget is exceeded, report the blocker and the next
decision. Do not start another full run merely to obtain a green result. Recovery
commands and evidence requirements are in the
[publication reference](/reference/release-publication#recover-a-failed-download).

### Release priority

Use the existing controller when release work needs priority over queued PR CI:

```bash
pnpm frv prioritize --run <validation-parent-run-id>
# After the release settles, use the record produced by the command:
pnpm frv prioritize --restore <record-file>
```

The controller records what it pauses and cancels. Restore deferred PR work when
the release settles. Do not cancel release children or pause Security Review.
See [priority behavior](/reference/release-validation#release-priority) for the
workflow selection and recovery details.

## Stable main closeout

A stable release is complete when `main` reflects the shipped version and notes,
required fixes have been forward-ported, and closeout verification succeeds.

1. Compare the release branch with fresh `main` and forward-port missing product
   fixes. Do not blindly merge release-only adapters.
2. Reconcile the shipped version, release notes, and contribution record. Do not
   downgrade `main` if a later stable train has already started, or introduce a
   future version without an explicit release decision.
3. Run the generated release and lock checks. Include the appcast once the macOS
   release is published; otherwise record it as pending.
4. Verify the closeout workflow and its attached manifest and checksum. Keep the
   rollback-drill record current.

Closeout requires stable/full validation, release soak, and blocking performance.
**Recorded soak waivers are not accepted.** Older waived releases are not granted
an exception for delayed closeout or replay.

Pending native apps do not block closeout, but a published macOS release requires
a valid appcast. For exact checks, partial evidence, failed-parent recovery, and
correction tags, see [closeout reference](/reference/release-platforms#stable-main-closeout).

<a id="prepare-and-stabilize-the-candidate" />
<a id="publish-the-release" />
<a id="verify-and-recover" />

## Monthly Gateway extended-stable publication

Use the [extended-stable procedure](/reference/release-extended-stable) for
`.33+` releases. It publishes the Gateway, every npm-publishable official plugin,
and Docker images at one version without moving regular `latest` or `beta`.
Its GitHub release is never marked Latest; this track excludes ClawHub and native
app publication. The regular candidate helper is not the entry point for a new
monthly release.

## Reference details

The detailed contracts are grouped by the task they support:

| Task                                    | Reference                                                       |
| --------------------------------------- | --------------------------------------------------------------- |
| Prepare and inspect checks              | [Release validation reference](/reference/release-validation)   |
| Publish or recover packages             | [Release publication reference](/reference/release-publication) |
| Publish a monthly maintenance release   | [Extended-stable releases](/reference/release-extended-stable)  |
| Verify native apps and stable closeout  | [Release platforms and closeout](/reference/release-platforms)  |
| Generate notes or publish approved docs | [Release changelogs](/reference/release-changelogs)             |

<a id="design-proposal%3A-immutable-runtime-generations" />
<a id="previous-updater-compatibility" />
<a id="design-proposal-immutable-runtime-generations" />
<a id="required-checks" />

### Release preflight

For upgrade compatibility, source checks, translations, and dependency evidence,
use the [preflight reference](/reference/release-validation#release-preflight).

<a id="vitest" />
<a id="docker" />
<a id="qa-lab" />
<a id="package" />

### Release test boxes

For the CI, Docker, QA Lab, and package workflows, use the
[test-box reference](/reference/release-validation#release-test-boxes).

<a id="check-publication-gates" />
<a id="probe-the-bootstrap-token" />
<a id="prepare-once%2C-then-use-the-release-button" />
<a id="prepare-once-then-use-the-release-button" />
<a id="recover-a-failed-download" />
<a id="direct-publication-and-owner-recovery" />
<a id="npm-workflow-inputs" />

### Regular release publish automation

Start with [publication preflight](/reference/release-publication#check-publication-gates),
then follow the selected direct or prepared publication route. Exact inputs and
recovery commands are in the [publication reference](/reference/release-publication).

### Linux companion publication

Linux bundles publish independently after regular stable GitHub activation.
Verify the signed assets and updater manifest; a dispatch acknowledgement is not
completion. See [Linux publication](/reference/release-platforms#linux-companion-publication).

<a id="changelog-only-evidence-reuse" />

### Release changelog artifacts

Use the shared changelog tools to prepare the release entry, preserve contributor
credit, and keep the generated index consistent. See
[changelog preparation](/reference/release-changelogs#release-changelog-artifacts).

### Post-release documentation publication

Approved release docs may replace the initial prose after publication without
republishing packages. See [documentation publication](/reference/release-changelogs#post-release-documentation-publication)
for source mirroring, approval, and preservation of release verification.

## Public references

The [Full Release Validation workflow](https://github.com/openclaw/openclaw/blob/main/.github/workflows/full-release-validation.yml),
[release publisher](https://github.com/openclaw/openclaw/blob/main/.github/workflows/openclaw-release-publish.yml),
and [stable closeout workflow](https://github.com/openclaw/openclaw/blob/main/.github/workflows/openclaw-stable-main-closeout.yml)
implement the release checks. Maintainers use the
[private release runbook](https://github.com/openclaw/maintainers/blob/main/release/README.md)
for credential and emergency procedures.

## Related

- [Release channels](/install/development-channels)
- [Full release validation](/reference/full-release-validation)
- [Update and plugin tests](/help/testing-updates-plugins)
