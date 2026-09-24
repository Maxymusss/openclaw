---
doc-schema-version: 1
summary: "OpenClaw release channels, version numbers, validation, and published assets"
title: "Release policy"
read_when:
  - Choosing a release channel
  - Understanding version numbers and release checks
  - Checking which packages and apps have been published
---

OpenClaw offers stable releases for everyday use, beta releases for testing,
and extended-stable releases for users who prefer an older Gateway maintenance
line. This page explains those choices and what a release has been checked for.
For switching channels, see [Release channels](/install/development-channels).

## Release channels

| Channel         | What you get                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| Stable          | The regular release promoted to npm `latest`.                                                             |
| Beta            | A candidate on npm `beta`. This may be a prerelease or a final version awaiting promotion.                |
| Extended-stable | A Gateway maintenance release from either of the two trailing completed months, on npm `extended-stable`. |
| Dev             | The moving head of `main`, for development.                                                               |

Extended-stable includes the Gateway, official npm plugins, and Docker images.
It does not include native apps or ClawHub publication, and it does not change
the regular stable channel. Its GitHub release is not marked Latest. A monthly
line retires when it falls outside the two supported completed months.

Alpha builds are a separate internal testing track, not a recommended user
channel.

## Version naming

| Release            | Version example                                                       |
| ------------------ | --------------------------------------------------------------------- |
| Regular final      | `2026.9.6`                                                            |
| Beta prerelease    | `2026.9.6-beta.1`                                                     |
| Regular correction | `2026.9.6-1`                                                          |
| Extended-stable    | `2026.8.33`, followed by `2026.8.34` for its next maintenance release |

Versions use `year.month.patch`, without zero-padding. The patch is a release
number within the month, not a day of the month. Regular releases use patches
below `33`; extended-stable starts at `33`. Git tags add `v`, as in `v2026.9.6`.

Published npm versions and release tags are never replaced. A fix receives a
new version. Alpha-only versions do not advance the regular release number.

## Release cadence

Releases normally go to beta first and move to stable after validation.
For core and every published official npm plugin, `beta` must be at least as
new as `latest`; an already newer beta stays unchanged. A prerelease is older
than the final version with the same base number.

A final version published to the beta channel still has to meet the stable
validation requirements below. The npm channel alone does not determine which
checks apply.

## Required validation

Final stable versions require **stable or full validation, release soak, and
blocking performance checks**. Soak adds longer-running release and upgrade
tests. Beta-profile results and soak waivers do not satisfy those requirements.

All selected checks must pass. They include source CI, Control UI, native apps,
Node/Gateway, plugins, packages, and selected Telegram, QA, and live-provider
checks. Gateway install and upgrade validation covers all three suites on all
three operating systems:

| Suite                   | Linux    | Windows  | macOS    |
| ----------------------- | -------- | -------- | -------- |
| Fresh package install   | Required | Required | Required |
| Fresh installer install | Required | Required | Required |
| Packaged upgrade        | Required | Required | Required |

Beta prereleases can defer some coverage under the documented beta profile.
Deferred checks are recorded as **not run**, never passed. A failed test is not
cleared merely because a later attempt passes; it must be investigated.

See [Full release validation](/reference/full-release-validation) for coverage
by profile and how to interpret the results.

## Packages and apps can become available at different times

A published Gateway release does not mean every native app is ready. Native
app tests are blocking when selected, but signing and publishing the apps can
finish separately from npm, Docker, and the GitHub release.

Check the release's assets and announcements for each platform. A pending app
build or an accepted publication request is not a completed app release.
Extended-stable is a Gateway distribution and does not publish native apps.

## Release notes and verification

The [release notes](/releases) describe user-facing changes. GitHub releases
also carry validation results, dependency reports, and checks of the published
packages. These records identify the tested version and the files that shipped.
Later documentation updates may improve the release notes without rebuilding
or replacing packages.

For dependency review and downstream packaging, see
[Dependency locking](/gateway/security/dependency-locking). Release dependency
archives include npm-format locks separately from the package tarballs. Use
only a lock for the exact package version and source commit, and reject entries
that report omitted workspace dependencies.

<a id="linux-companion-publication" />
<a id="release-changelog-artifacts" />
<a id="changelog-only-evidence-reuse" />
<a id="monthly-gateway-extended-stable-publication" />
<a id="prepare-and-stabilize-the-candidate" />
<a id="publish-the-release" />
<a id="verify-and-recover" />
<a id="regular-release-operator-checklist" />
<a id="fast-path-default" />
<a id="stable-release-process" />
<a id="full-checklist" />
<a id="release-priority" />
<a id="stable-main-closeout" />
<a id="post-release-documentation-publication" />
<a id="release-preflight" />
<a id="previous-updater-compatibility" />
<a id="design-proposal%3A-immutable-runtime-generations" />
<a id="required-checks" />
<a id="release-test-boxes" />
<a id="vitest" />
<a id="docker" />
<a id="qa-lab" />
<a id="package" />
<a id="regular-release-publish-automation" />
<a id="check-publication-gates" />
<a id="probe-the-bootstrap-token" />
<a id="prepare-once%2C-then-use-the-release-button" />
<a id="recover-a-failed-download" />
<a id="direct-publication-and-owner-recovery" />
<a id="npm-workflow-inputs" />
<a id="regular-beta%2Flatest-stable-release-sequence" />
<a id="public-references" />
<a id="related" />
<a id="design-proposal-immutable-runtime-generations" />
<a id="prepare-once-then-use-the-release-button" />
<a id="regular-beta/latest-stable-release-sequence" />

## Maintainer procedures

Release preparation, publishing commands, approvals, and recovery belong in the
repository's [release-maintainer skill](https://github.com/openclaw/openclaw/tree/main/.agents/skills/release-openclaw-maintainer),
not this user guide. Credential handling and emergency procedures remain in the
private maintainer runbook.
