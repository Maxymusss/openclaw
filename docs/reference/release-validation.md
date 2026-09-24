---
doc-schema-version: 1
summary: "Prepare release checks and select focused validation workflows"
title: "Release validation reference"
read_when:
  - Prepare release checks and select focused validation workflows
---

Use this reference when you need to prepare release checks and select focused validation workflows. For the release sequence, start with [Release policy](/reference/RELEASING).

## Release preflight

### Previous updater compatibility

Before freezing the release, refresh `scripts/lib/update-compat-inventory.json`
from every release in the supported upgrade window. The current window includes
2026.9.1, 2026.9.2, and 2026.9.3. Download each npm tarball and verify it against
its published `dist.integrity` before extracting it. Pass each verified artifact
to the recorder with a repeatable `--release` argument:

```bash
pnpm update:compat:gen \
  --release '<unpacked-2026.9.1-directory>=<verified-npm-dist.integrity>' \
  --release '<unpacked-2026.9.2-directory>=<verified-npm-dist.integrity>' \
  --release '<unpacked-2026.9.3-directory>=<verified-npm-dist.integrity>'
```

The recorder writes releases in version order and replaces the recorded set.
Drop releases older than the supported upgrade window when regenerating it;
the inventory must not accumulate indefinitely. A release with no post-swap
imports still has an entry with an empty chunk list, so coverage is explicit.
Conflicting origins for the same chunk export across releases fail generation.

The recorder corrects one verified historical bundler annotation: the 2026.9.1,
2026.9.2, and 2026.9.3 registry-lifecycle chunks grouped the retirement function
under the cache module's source region. The correction requires the exact release
version, build identity, commit, npm integrity, chunk and export. It changes only
recorded source provenance; missing or ambiguous current exports still fail the
build. Remove each correction when its release leaves the supported upgrade
window. Regenerate the inventory from verified tarballs rather than editing its
origins by hand.

`pnpm update:compat:check` reads `npm view openclaw dist-tags --json` and requires
the versions tagged `latest` and `beta` to be present, even when both tags refer
to stable versions or the same version. A missing version fails with the exact
`pnpm update:compat:gen` command to run after verifying and unpacking the listed
artifacts. `pnpm release:prep`, version preparation, and prepared-release packing
run this check. Ordinary PR checks and source packing do not query npm for it.
To verify deterministic regeneration offline, run `pnpm update:compat:check`
with the same `--release` arguments used for generation.

The recorder scans emitted lazy imports in the updater, service, and CLI cleanup source
regions and records required export origins. The wizard entry is excluded
because it starts before replacement. `runtime-postbuild` generates hashed
compatibility files by re-exporting the candidate's corresponding symbols;
multiple exports of one declaration resolve to its own chunk, with sorted paths
and export names breaking alias ties. Missing mappings or distinct declaration
bindings for the same source origin fail the build. The isolated `config-doctor`
graph cannot supply updater bridges. Stable entrypoints are checked
without replacement. The package carries the inventory in
`dist/update-compat-inventory.json`, so negative and future fixtures remove that
candidate's bridges. Existing older compatibility aliases remain separately
owned by their original upgrade contracts.

The `update-first-hop-compat` selection expands into one Docker lane per
recorded release (`update-first-hop-compat-<version>`, from
`scripts/lib/update-compat-inventory.json`), so the hops run as parallel jobs
and the wall clock stays at one hop (~10 minutes) instead of one per release.
Each lane runs `scripts/e2e/update-first-hop-compat-docker.sh` with
`OPENCLAW_UPDATE_FIRST_HOP_SOURCE_VERSIONS=<version>` and writes
`.artifacts/update-first-hop-compat-<version>/`; a frozen target that records
fewer releases omits the lanes it does not list. Published updaters may correctly
skip a same-version tarball, so each lane stamps only test-artifact version metadata:
first hop `2026.9.99-first-hop.0` retains compatibility bridges; second hop
`2026.9.99-first-hop.1` removes them. The original candidate stays unchanged, and
transformation receipts bind package digests and every changed or removed member.
Both hops still require the exact installed build identity and a restarted service. The 2026.9.1 negative control demonstrates the
missing restart import; releases that already preload that helper record the
negative control as not applicable while retaining the positive first-hop and
bridge-free future-hop checks. An explicit source tarball still selects one
baseline. Run the published upgrade survivor lane from the oldest supported
release as well. Native Windows proof must invoke the old updater with
a registered Scheduled Task and verify its restart without a subsequent manual
`gateway start`. Import compatibility alone does not prove that old and new
modules share process-local state.

### Required checks

#### Source checks

- Run `pnpm check:test-types` before release preflight so test TypeScript stays covered outside the faster local `pnpm check` gate.
- Run `pnpm check:architecture` before release preflight so the broader import cycle and architecture boundary checks are green outside the faster local gate.
- Run `pnpm build && pnpm ui:build` before `pnpm release:check` so the expected `dist/*` release artifacts and Control UI bundle exist for the pack validation step.

Run `pnpm release:prep` after the root version bump and before tagging. It runs every deterministic release generator that commonly drifts after a version or config change: plugin versions, plugin inventory, base config schema, bundled channel config metadata, config docs baseline, plugin SDK exports, and Control UI locale bundles.

It also blocks until native app translations and platform-generated locale resources match the source inventory; if they lag, wait for or dispatch `Native App Locale Refresh` before freezing the Code SHA. `pnpm release:check` re-runs those guards plus transient npm package-lock validation in check mode (including the strict locale gates plus the plugin SDK surface budget) and reports every failure in one pass before running package release checks.

The npm preflight separately compares the exact release SHA with the prior published dist-tag and reports any Plugin SDK API changes.

#### Translation repair

For reviewed native translation repairs, configure the translation provider and run `pnpm native:i18n:sync --locale <code> --refresh-id <native-id>`. Find IDs in `apps/.i18n/native-source.json`; repeat the selector for up to 64 distinct IDs. Selected entries join ordinary pending work, including missing strings and glossary invalidation.

Requests include bounded nearby owner code and instructions to preserve printf argument roles; excerpts are request-only and do not enter the source inventory. Unknown IDs fail before provider work, and selected refresh cannot be combined with `--force`.

Then run `pnpm native:i18n:sync` to regenerate platform resources and `pnpm native:i18n:check` to validate them.

For reviewed Control UI translation repairs, run `pnpm ui:i18n:sync --locale <code> --refresh-key <key>`. Repeat the selector for up to 64 distinct catalog keys. It refreshes those keys alongside ordinary pending work while leaving still-valid unselected cached aliases reusable.

A configured provider is required even when ordinary synchronization allows optional authentication; unknown keys and combining selected refresh with `--force` are rejected.

#### Plugin API compatibility

Plugin version sync updates the publishable `@openclaw/ai` runtime package and official plugin package versions to the OpenClaw release version. It raises lower `openclaw.compat.pluginApi` floors to that version and preserves higher floors required by the plugin.

Treat that field as the plugin SDK/runtime API floor, not just a copy of the package version: for plugin-only releases that intentionally remain compatible with older OpenClaw hosts, keep the floor at the oldest supported host API and document that choice in the plugin release proof.

#### Full validation

Run the manual `Full Release Validation` workflow before release approval to select the pre-release test boxes from one entrypoint. It accepts a branch, tag, or full commit SHA and dispatches manual `CI`, plugin prerelease, and `OpenClaw Release Checks` for the selected profile.

Canonical beta `all` without soak uses the bounded `npm-beta-v1` policy described in [Full release validation](/reference/full-release-validation); install, package, Linux/Windows/macOS Gateway cross-OS, QA parity, runtime-pair/restart, and tool-coverage gates remain required.

The `stable` and `full` profiles always include exhaustive live/E2E and Docker release-path soak; stable publication requires one of those profiles, and `run_release_soak=true` requests an explicit beta soak. Package Acceptance provides package Telegram E2E when selected, avoiding a second concurrent live poller for an unpublished candidate.

Provide `release_package_spec` after publishing a beta to reuse the shipped npm package across release checks, Package Acceptance, and package Telegram E2E without rebuilding the release tarball. Provide `npm_telegram_package_spec` only when Telegram should use a different published package from the rest of release validation.

Provide `package_acceptance_package_spec` when Package Acceptance should use a different published package from the release package spec. Provide `evidence_package_spec` when the release evidence report should prove that validation matches a published npm package without forcing Telegram E2E.

```bash
TOOLING_SHA="<recorded-full-main-ancestor-sha>"
PUBLICATION_SELECTION='{"route":"normal","npmDistTag":"latest","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}'
pnpm ci:full-release \
  --sha <code-sha> \
  --target-ref release/YYYY.M.PATCH \
  --workflow-sha "$TOOLING_SHA" \
  -f validation_purpose=publish \
  -f publication_selection_json="$PUBLICATION_SELECTION"
```

These examples select stable publication to `latest`. For a beta release, use
a beta candidate version and set `npmDistTag` to `beta` in the selection.

#### Package acceptance

Run the manual `Package Acceptance` workflow when you want side-channel proof for a package candidate while release work continues. Use `source=npm` for `openclaw@beta`, `openclaw@latest`, or an exact release version; `source=ref` to pack a trusted `package_ref` branch/tag/SHA with the current `workflow_ref` harness; `source=url` for a public HTTPS tarball with a required SHA-256 and strict public URL policy; `source=trusted-url` for a named trusted-source policy using required `trusted_source_id` and SHA-256; or `source=artifact` for a tarball uploaded by another GitHub Actions run.

The workflow resolves the candidate to `package-under-test`, reuses the Docker E2E release scheduler against that tarball, and can run Telegram QA against the same tarball with `telegram_mode=mock-openai` or `telegram_mode=live-frontier`. When the selected Docker lanes include `published-upgrade-survivor`, the package artifact is the candidate and `published_upgrade_survivor_baseline` selects the published baseline.

`update-restart-auth` uses the candidate package as both the installed CLI and the package-under-test so it exercises the candidate update command's managed restart path.

Example:

```bash
gh workflow run package-acceptance.yml --ref main -f workflow_ref=main -f source=npm -f package_spec=openclaw@beta -f suite_profile=product -f telegram_mode=mock-openai
```

Common profiles:

- `smoke`: install/channel/agent, gateway network, and config reload lanes
- `package`: artifact-native package/update/restart/plugin lanes without OpenWebUI or live ClawHub
- `product`: package profile plus MCP channels, cron/subagent cleanup, OpenAI web search, and OpenWebUI
- `full`: Docker release-path chunks with OpenWebUI
- `custom`: exact `docker_lanes` selection for a focused rerun

#### Normal CI

Run the manual `CI` workflow directly when you only need deterministic normal CI coverage for the release candidate. Manual CI dispatches bypass changed scoping and force the Linux Node shards, bundled-plugin shards, plugin and channel contract shards, Node 24 minimum compatibility, `check-*`, `check-additional-*`, built-artifact smoke checks, docs checks, Python skills, Windows, macOS, and Control UI i18n lanes.

Standalone manual CI defaults to full coverage and runs Android only with `include_android=true`. Full Release Validation includes Android except under `npm-beta-v1`, which selects `release_scope=npm-beta` and defers native app CI while retaining macOS and Windows Node checks.

```bash
gh workflow run ci.yml --ref release/YYYY.M.PATCH -f include_android=true
```

#### Observability

Run `pnpm qa:otel:smoke` when validating release telemetry. It exercises QA-lab through a local OTLP/HTTP receiver and verifies trace, metric, and log export plus bounded trace attributes and content/identifier redaction without requiring Opik, Langfuse, or another external collector.

- Run `pnpm qa:otel:collector-smoke` when validating collector compatibility. It routes the same QA-lab OTLP export through a real OpenTelemetry Collector Docker container before the local receiver assertions.

Run `pnpm qa:prometheus:smoke` when validating protected Prometheus scraping. It exercises QA-lab, rejects unauthenticated scrapes, and verifies release-critical metric families stay free of prompt content, raw identifiers, auth tokens, and local paths.

- Run `pnpm qa:observability:smoke` for the source-checkout OpenTelemetry and Prometheus smoke lanes back to back.
- Run `pnpm release:check` before every tagged release.

#### Dependency release evidence

`OpenClaw NPM Preflight` packs the publishable tarball once, then generates dependency release evidence while qualifying those exact bytes. The npm advisory vulnerability gate is release-blocking. The transitive manifest risk, dependency ownership/install surface, dependency change, and npm package-lock mirror reports are release evidence only.

The npm mirrors include the root package and every publishable workspace package with runtime dependencies or optional dependencies, generated and verified against the source checkout’s `pnpm-lock.yaml`. They are never included in npm tarballs. The dependency change report compares the release candidate with the previous reachable release tag.

The preflight uploads dependency evidence as `openclaw-release-dependency-evidence-<tag>` and also embeds it under `dependency-evidence/` inside the prepared npm preflight artifact. The real publish path reuses that preflight artifact, then attaches the same evidence to the GitHub release as `openclaw-<version>-dependency-evidence.zip`.

#### Consume dependency evidence

**Downstream packagers:** Download `openclaw-<version>-dependency-evidence.zip` from the GitHub release and read `dependency-evidence/npm-package-locks.json` (`schemaVersion: 1`). Select the entry in `packages` matching the exact package `name` and `version` you pin.

Every entry has an `omittedWorkspaceDependencies` array; a nonempty array marks a partial lock, and consumers must reject that entry instead of installing it. Sibling workspace packages publish in the same release, so the generator omits their `workspace:` runtime references at preflight.

The top-level `packagesWithOmittedWorkspaceDependencies` counts these partial entries. Only for an entry with an empty omissions array, serialize `entry.lock` as `package-lock.json` (two-space JSON indentation plus a trailing newline reproduces `entry.lockSha256`).

This supports offline installation of lockless packages such as `@openclaw/acpx`; the report includes a `bundleRuntimeDependencies` flag and direct dependency counts. Before using a lock, verify that `dependency-evidence/dependency-evidence-manifest.json`’s `releaseSha` equals the report’s `sourceSha` and the OpenClaw commit you pin.

The report also records the source `pnpm-lock.yaml` SHA-256. The companion `npm-package-locks.md` provides counts and a package table. The locks encode this repository's `pnpm-workspace.yaml` overrides (for example a scoped `@openai/codex` pin for `codex-acp`), so nested dependency specs may not satisfy the locked versions by range alone: before running `npm ci`, either carry the same `overrides` in the consuming `package.json` or rewrite each entry's nested `dependencies`/`optionalDependencies` specs to the locked versions (nix-openclaw does the latter); a raw `npm ci` against an unmodified `package.json` otherwise fails its lock-sync check.

#### Publication handoff

Run `OpenClaw Release Publish` for the mutating publish sequence after the tag exists. Dispatch regular beta and stable publishes from the protected `release-publish/<tooling-sha12>-<epoch>` tag at the frozen Tooling SHA; the release tag still selects the exact target commit and may point into `release/YYYY.M.PATCH`.

Tideclaw alpha publishes remain on their matching alpha branch. Pass the successful OpenClaw npm `preflight_run_id`, successful `full_release_validation_run_id`, and exact `full_release_validation_run_attempt`, and keep the default plugin publish scope `all-publishable` unless you are deliberately running a focused repair.

The workflow dispatches plugin npm and ClawHub together, then starts core npm once plugin npm succeeds. Core npm does not wait for ClawHub authorization or bootstrap; the exact ClawHub receipt remains a required parent step. When the tagged Android pin matches the stable release train, Android qualification runs independently and dispatch follows successful core npm publication; a mismatched pin records an explicit skip.

Optional Windows promotion starts after GitHub finalization as a detached child. Android approval, build, and publication are monitored separately and do not hold core publication; the child can attach its verified assets after the GitHub release becomes public.

Publish reruns are resumable: an already-published core npm version skips the core dispatch after the workflow proves the registry tarball matches the tag's preflight artifact, and Windows/Android promotion is skipped when the release already carries the verified asset contract, so a retry only redoes the failed stages.

Focused plugin-only repairs require `plugin_publish_scope=selected` and a nonempty plugin list. Plugin-only `all-publishable` runs require complete immutable preflight and Full Release Validation evidence; partial evidence is rejected.

#### Windows promotion handoff

Stable `OpenClaw Release Publish` accepts optional `windows_node_tag` and `windows_node_installer_digests` inputs together. Omit both to skip Windows dispatch. When supplied, the parent finalizes the GitHub release on npm and Docker evidence, then dispatches `Windows Node Release` independently with the approved digest map unchanged.

The child validates the exact published, non-prerelease source release, downloads the signed x64/ARM64 installers, matches the pinned digests, verifies the expected OpenClaw Foundation Authenticode signer on Windows, and attaches the installers plus SHA-256 manifest to the published OpenClaw release.

It re-downloads the promoted assets to verify membership and hashes. Windows failures are reported in the child summary and evidence without failing the parent or reverting the public release to draft.

To attach Windows assets later or recover promotion, use the [manual recovery command](/reference/release-publication#regular-release-publish-automation) with exact target/source tags and the approved `expected_installer_digests` map. Recovery rejects unexpected `OpenClawCompanion-*` asset names before replacing the expected contract with the pinned source bytes.

Website download links should target exact OpenClaw release asset URLs for the current stable release, or `releases/latest/download/...` only after verifying GitHub's latest redirect points at that same release; do not link only to the companion repo release page.

#### Release-check coverage and dispatch

Release checks run in a separate manual workflow: `OpenClaw Release Checks`. The `all`, `qa-parity`, and direct `qa` groups select QA Lab parity, runtime-pair/restart proof, and runtime tool coverage. The Matrix catalog and Telegram QA-live lanes run for stable/full all-group validation, soak-enabled all-group validation, or an explicit `qa`/`qa-live` rerun group.

Bounded beta-publish `all` without soak defers those live lanes to postpublish-confidence. The live lanes use the `qa-live-shared` environment; Telegram also uses Convex CI credential leases.
Cross-OS install and upgrade runtime validation is part of public `OpenClaw Release Checks` and `Full Release Validation`, which call the reusable workflow `.github/workflows/openclaw-cross-os-release-checks-reusable.yml` directly. Linux, Windows, and macOS Gateway cross-OS install and upgrade lanes gate beta, stable, and full publication.

Their actual pass/fail conclusions remain in the manifest and summary; failures block npm publication.

- Secret-bearing release checks should be dispatched through `Full Release Validation` or from the `main`/release workflow ref so workflow logic and secrets stay controlled.
- `OpenClaw Release Checks` accepts a branch, tag, or full commit SHA as long as the resolved commit is reachable from an OpenClaw branch or release tag.

`OpenClaw NPM Release` validation-only preflight also accepts the current full 40-character workflow-branch commit SHA without requiring a pushed tag. The SHA dispatch stays read-only; later publication requires a real release tag at the same validated SHA.

In SHA mode the workflow synthesizes `v<package.json version>` only for the package metadata check; real publish still requires a real release tag.

- Both workflows keep the real publish and promotion path on GitHub-hosted runners, while the non-mutating validation path can use the larger Blacksmith Linux runners.
- That workflow runs `OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CACHE_TEST=1 pnpm test:live:cache` using both `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` workflow secrets.
- npm release preflight no longer waits on the separate release checks lane.

#### Pre-tag and registry checks

Before tagging a release candidate locally, run `RELEASE_TAG=vYYYY.M.PATCH-beta.N pnpm release:fast-pretag-check`. The helper runs the fast release guardrails, plugin npm/ClawHub release checks, build, UI build, and `release:openclaw:npm:check` in the order that catches common approval-blocking mistakes before the GitHub publish workflow starts.
Plugin `openclaw.release.requireLatestDependencies` declarations remain release metadata, but npm `latest` drift is advisory. Checks warn with the plugin, dependency, pinned version, and current latest version; a failed latest lookup also warns and does not establish that the pin is unusable.

Full Release Validation's Codex lanes validate the `@openclaw/codex` harness pin. Keep that frozen, tested pin when upstream publishes a newer version. Missing or malformed required runtime dependency metadata, package/install failures, and failed required validation lanes still block release.

- Run `RELEASE_TAG=vYYYY.M.PATCH node --import tsx scripts/openclaw-npm-release-check.ts` (or the matching prerelease/correction tag) before approval.

After npm publish, run `node --import tsx scripts/openclaw-npm-postpublish-verify.ts YYYY.M.PATCH` (or the matching beta/correction version) to verify the published registry install path in a fresh temp prefix. Run it from a checkout of the Release SHA, not the tooling checkout (a newer checkout reports main-only bundled plugin files as missing), with `OPENCLAW_NPM_EXPECTED_WORKFLOW_REF=refs/tags/release-publish/<sha12>-<epoch>` and `OPENCLAW_NPM_EXPECTED_WORKFLOW_SHA=<tooling-sha>` exported; without them it fails `SHA-pinned release-publish ref does not match`.

After a beta publish, run `OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC=openclaw@YYYY.M.PATCH-beta.N OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE=maintainer pnpm test:docker:npm-telegram-live` with `OPENCLAW_QA_CONVEX_SITE_URL` and `OPENCLAW_QA_CONVEX_SECRET_MAINTAINER` set.

This verifies installed-package onboarding, Telegram setup, and real Telegram E2E against the published npm package using the shared Test Server userbot pool. CI uses the `ci` role and `OPENCLAW_QA_CONVEX_SECRET_CI` instead.
To run the full post-publish beta smoke from a maintainer machine, use `pnpm release:beta-smoke -- --beta betaN`. The helper runs Parallels npm update/fresh-target validation, dispatches `NPM Telegram Beta E2E`, polls the exact workflow run, downloads the artifact, and prints the Telegram report.

- Maintainers can run the same post-publish check from GitHub Actions via the manual `NPM Telegram Beta E2E` workflow. It is intentionally manual-only and does not run on every merge.
- Maintainer release automation uses preflight-then-promote:
  - Real npm publish must pass a successful npm `preflight_run_id`.
  - Regular beta and stable publish orchestration and preflight use trusted `main` against the exact target tag. Tideclaw alpha publish and preflight use the matching alpha branch.
  - Stable npm releases default to `beta`; stable npm publish can target `latest` explicitly via workflow input.
  - Token-based npm dist-tag mutation lives in `openclaw/releases/.github/workflows/openclaw-npm-dist-tags.yml` because `npm dist-tag add` still needs `NPM_TOKEN` while the source repo keeps OIDC-only publish.
  - Public `macOS Release` is validation-only; when a tag lives only on a release branch but the workflow is dispatched from `main`, set `public_release_branch=release/YYYY.M.PATCH`.
  - Real macOS publish must pass successful macOS `preflight_run_id` and `validate_run_id` in `openclaw/releases`. These app gates run independently and never hold npm or GitHub release finalization.
  - Real publish paths promote prepared artifacts instead of rebuilding them again.
    For stable correction releases like `YYYY.M.PATCH-N`, the post-publish verifier also checks the same temp-prefix upgrade path from `YYYY.M.PATCH` to `YYYY.M.PATCH-N` so release corrections cannot silently leave older global installs on the base stable payload.
- npm release preflight fails closed unless the tarball includes both `dist/control-ui/index.html` and a non-empty `dist/control-ui/assets/` payload, so we do not ship an empty browser dashboard again.

Post-publish verification also checks that published plugin entrypoints and package metadata are present in the installed registry layout. A release that ships missing plugin runtime payloads fails the postpublish verifier and cannot be promoted to `latest`.

- `pnpm test:install:smoke` also enforces the npm pack `unpackedSize` budget on the candidate update tarball, so installer e2e catches accidental pack bloat before the release publish path.

If the release work touched CI planning, extension timing manifests, or extension test matrices, regenerate and review the planner-owned `plugin-prerelease-extension-shard` matrix outputs from `.github/workflows/plugin-prerelease.yml` before approval so release notes do not describe a stale CI layout.

Stable macOS release readiness also includes the updater surfaces: the GitHub release must end up with the packaged `.zip`, `.dmg`, and `.dSYM.zip`; `appcast.xml` on `main` must point at the new stable zip after publish (the macOS publish workflow commits it automatically, or opens an appcast PR when direct push is blocked); the packaged app must keep a non-debug bundle id, a non-empty Sparkle feed URL, and a `CFBundleVersion` at or above the canonical Sparkle build floor for that release version.

#### Recover macOS notarization

Signed macOS packaging retains `dist/macos-notarization-recovery/` before waiting for Apple. It contains the exact signed app archive, symbols, submission IDs, available DMG, and source-bound SHA-256 inventory. Keep the complete checkpoint if notarization fails; do not rebuild or replace its files.

Successful packaging marks it complete for artifact retention; the next ordinary package invocation verifies and retires that completed checkpoint automatically.
Resume with `scripts/package-mac-dist.sh --resume-notarization` from the same source commit and version, with the original signing/notary credentials available. Recovery verifies the checkpoint, restores the signed app, and waits on existing Apple submissions.

It creates a DMG only if that packaging step had not completed. Apple rejection, changed bytes, wrong source/version, or invalid signatures remain failures.

## Release priority

Release runs are always prioritized over PR-side work on GitHub-hosted runners.
The repo variable `OPENCLAW_RELEASE_PRIORITY_RUN` names the active Full Release
Validation parent run id:

- `pnpm ci:full-release` writes `.artifacts/frv-release-priority-<parent>.json`
  (the pause window) and then sets the variable once the parent dispatch is
  observed; it clears the variable when the operation ends, sealed or failed.
  `pnpm frv continue --failed` and `pnpm frv verify` clear it for the sealed
  parent as well. A failure to set or clear the variable is a warning, never a
  validation failure.
- While it is set, the root jobs of the hosted-runner workflows `CI`, `Auto
response`, `PR context and evidence`, `Labeler`, the `CodeQL` workflows,
  `Periphery Dead Code Comment`, `Workflow Sanity`, `ClawSweeper Dispatch`, and
  `Maintainer Command Reactions` skip through a job-level `if` (no runner is
  consumed) unless the run is a `workflow_dispatch` or targets a `release*/`
  branch. `Security Review` is never paused: it owns approval revocation for
  `openclaw/ci-gate`. A deferred `CI` run keeps its `openclaw/ci-gate` failing
  with `Deferred for release <run>` so the PR stays unmergeable until the rerun.
- `pnpm frv prioritize --run <parent>` records the pause window and the queued
  (not started) runs of those workflows on non-release branches, excluding
  `release/*`, `release-ci/*`, `release-publish/*`, and every
  `workflow_dispatch`; sets the variable; rechecks each run is still queued and
  cancels it; then records what was actually cancelled (`--out <file>`,
  `--dry-run`). Repeating the command keeps the original window and cancellations.
- `pnpm frv prioritize --restore <file>` first clears the variable when it still
  names that parent, then `gh run rerun`s the recorded cancelled runs plus every
  run the gate deferred since the window opened (skipped gated runs, and `CI`
  runs whose only executed jobs are `security-fast` and the failed gate),
  coalesced to the newest run per workflow and branch so an obsolete run never
  cancels validation of a newer head. Run it after the release seals; deferred
  PR work is never re-dispatched automatically. Not yet proven live: GitHub
  re-evaluating the `vars` gate on `gh run rerun`.
- Publish children run on hosted `ubuntu-latest`; Blacksmith testbox runs are
  a separate pool and do not compete. When the hosted pool is saturated, use
  `pnpm frv prioritize --run <parent>` and retain its record, then restore with
  `pnpm frv prioritize --restore <record>`.

## Release test boxes

`Full Release Validation` is how operators kick off the full product matrix from one entrypoint. Use the helper so every child workflow runs from a temporary branch fixed at one trusted `main` workflow SHA while the requested commit remains the candidate under test:

```bash
TOOLING_SHA="<recorded-full-main-ancestor-sha>"
PUBLICATION_SELECTION='{"route":"normal","npmDistTag":"latest","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}'
pnpm ci:full-release \
  --sha <code-sha> \
  --target-ref release/YYYY.M.PATCH \
  --workflow-sha "$TOOLING_SHA" \
  -f validation_purpose=publish \
  -f publication_selection_json="$PUBLICATION_SELECTION"
```

These examples select stable publication to `latest`. For a beta release, use
a beta candidate version and set `npmDistTag` to `beta` in the selection.

The helper verifies that the recorded Tooling SHA remains reachable from current
`origin/main`, pushes `release-ci/<workflow-sha>-...` at that exact commit,
accepts only the release branch's final package version or a matching beta
prerelease, infers `beta` for that beta path and `stable` for final versions, and
dispatches `Full Release Validation` with the Validation SHA as `expected_sha`.
Target resolution rejects a mismatch before child dispatch. Every child workflow
`headSha` must match the Tooling SHA. Pass `-f reuse_evidence=false` to force a
fresh run or `-f release_profile=full` for the broad provider sweep. Never
replace the recorded Tooling SHA with a fresh `main` lookup. The helper rejects
pinned tooling that lacks the current release-isolation contract or the
`expected_sha` dispatch input and never silently selects newer tooling. The
workflow itself never writes repository refs. Tideclaw alpha validation remains
on its matching alpha branch and exact alpha tag rather than a regular
`release/*` context.

That current-`main` lineage check authorizes the initial validation tooling
selection only. It is not permission to choose newer tooling after the
candidate SHA/ref and Tooling SHA/ref are frozen. Once publication binds the
Tooling SHA to the protected lightweight `release-publish/*` tag, the exact live
tag-to-SHA mapping and exact parent run tuple authorize the npm mutations
enforced by this foundation even if `main` has advanced. Other privileged
writers remain blocked until their dependent enforcement changes land.

If the fresh qualified commit already contains final notes, Code SHA and Release SHA are identical. Use that same successful parent/attempt and its exact prepared bytes for candidate and publication checks, including the final channel-specific SDK report and required acknowledgement. No second commit or FRV is required merely to name a Release SHA.

If notes change afterward, commit the selected release entry and any matching record/index updates, then optionally run the same helper with the new Release SHA:

```bash
TOOLING_SHA="<same-recorded-tooling-sha>"
PUBLICATION_SELECTION='{"route":"normal","npmDistTag":"latest","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}'
pnpm ci:full-release \
  --sha <release-sha> \
  --target-ref release/YYYY.M.PATCH \
  --workflow-sha "$TOOLING_SHA" \
  -f validation_purpose=publish \
  -f publication_selection_json="$PUBLICATION_SELECTION"
```

These examples select stable publication to `latest`. For a beta release, use
a beta candidate version and set `npmDistTag` to `beta` in the selection.

This optional second parent reuses product evidence only when GitHub proves the Release SHA descends from the Code SHA and its complete delta meets [changelog-only evidence reuse](/reference/release-changelogs#changelog-only-evidence-reuse). Current split-layout evidence records `split-changelog-release-v1` and dispatches no product children.

Npm preflight and package/install acceptance still run on the Release SHA because its tarball bytes changed.

For a fresh Code SHA, the workflow resolves the target, dispatches manual `CI`, then dispatches `OpenClaw Release Checks`. Beta-publish maps to `release_profile=beta` and `run_release_soak=false`. An `all` run for an actual beta package on its matching canonical release branch or beta tag records `coveragePolicy=npm-beta-v1`: Linux/macOS/Windows Node, Control UI, plugin, package, Linux/Windows/macOS Gateway cross-OS, and QA parity/runtime/restart/tool gates remain required; native apps, performance, and published-package Telegram confidence are deferred.

Beta `all` without soak also defers broad live/E2E, QA-live, and Package Acceptance Telegram. Postpublish-confidence uses the exact published package with soak or explicit focused groups. Stable-publish requires `release_profile=stable` or `full` with soak.

The final verifier summary includes slowest-job tables for each selected child run.

Deferred coverage is recorded as **not run**, never passed. It does not shorten
the terminal-evidence requirement for selected children. `main`, alpha, and
non-beta targets do not qualify for `npm-beta-v1`; stable, full, soak-enabled,
and focused runs retain their existing coverage. Native artifact publication
still requires its build, signing, notarization, and promotion gates.

Each dispatcher records the exact child run ID and attempt, then exits. Release
Decision reports a decisive blocker without waiting for unrelated diagnostic
tails; with `fail_fast=false`, Diagnostic Drain keeps the selected children
running to terminal. Diagnose `blocked_diagnostics_running` immediately, but do
not retry until the drain is terminal. Recover `orchestration_error` against
the same exact children and never redispatch tests merely to repair collection.
An immutable run-bound execution plan preserves the original attempt, titles,
coverage, gates, and child tuples across collector retries. The final verifier
consumes that plan and the exact attempt-bound Decision and Drain artifacts
instead of polling or reclassifying child results.

When selected, the product-performance child is artifact-only in this release
path. The umbrella dispatches it with `publish_reports=false`, and validation
is rejected unless its artifact-only guard proves that the Clawgrit report
publisher stayed skipped. `npm-beta-v1` defers this child to confidence work.
An early standalone beta performance run is optional signal, not another
mandatory prepublish wait; record available results and any observed regression.

See [Full release validation](/reference/full-release-validation) for the complete stage matrix, exact workflow job names, stable versus full profile differences, artifacts, and focused rerun handles.

Child workflows are dispatched from the SHA-pinned trusted ref that runs `Full Release Validation`. Every child run must use the exact parent workflow SHA. Do not use raw `--ref main -f ref=<sha>` dispatches for release proof; use `pnpm ci:full-release --sha <target-sha> --target-ref release/YYYY.M.PATCH --workflow-sha <tooling-sha> -f validation_purpose=publish -f publication_selection_json="$PUBLICATION_SELECTION"`.

Use `release_profile` to select live/provider breadth:

- `beta`: fastest release-critical OpenAI/core live and Docker path
- `stable`: beta plus stable provider/backend coverage for release approval
- `full`: stable plus broad provider/media coverage

The `stable` and `full` profiles always run the exhaustive live/E2E, Docker release-path, and bounded published upgrade-survivor sweep before stable publication or promotion. Use `run_release_soak=true` to request that same sweep for a beta. The sweep resolves the latest stable baseline once and runs the reported-issue upgrade fixtures against it.

Broader historical migration coverage remains available through the separate manual `Update Migration` workflow.

`OpenClaw Release Checks` uses the trusted workflow ref to resolve the target ref once as `release-package-under-test` and reuses that artifact in cross-OS, Package Acceptance, and release-path Docker checks when soak runs. This keeps all package-facing boxes on the same bytes and avoids repeated package builds.

After a beta is already on npm, set `release_package_spec=openclaw@YYYY.M.PATCH-beta.N` so release checks download the shipped package once, extract its build source SHA from `dist/build-info.json`, and reuse that artifact for cross-OS, Package Acceptance, release-path Docker, and package Telegram lanes.

The cross-OS OpenAI install smoke uses `OPENCLAW_CROSS_OS_OPENAI_MODEL` when the repo/org variable is set, otherwise `openai/gpt-5.6-luna`, because this lane is proving package install, onboarding, gateway startup, and one live agent turn rather than benchmarking the most capable model.

The broader live provider matrix remains the place for model-specific coverage.

Use these variants depending on release stage:

```bash
TOOLING_SHA="<recorded-full-main-ancestor-sha>"
PUBLICATION_SELECTION='{"route":"normal","npmDistTag":"beta","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}'

# Validate the product-complete Code SHA; final notes let this also be Release SHA.
pnpm ci:full-release \
  --sha <code-sha> \
  --target-ref release/YYYY.M.PATCH \
  --workflow-sha "$TOOLING_SHA" \
  -f validation_purpose=publish \
  -f publication_selection_json="$PUBLICATION_SELECTION"

# Optional: only after a later CHANGELOG-only edit, reuse the green Code proof.
pnpm ci:full-release \
  --sha <release-sha> \
  --target-ref release/YYYY.M.PATCH \
  --workflow-sha "$TOOLING_SHA" \
  -f validation_purpose=publish \
  -f publication_selection_json="$PUBLICATION_SELECTION"

# Run postpublish confidence against the exact published beta.
pnpm ci:full-release \
  --sha <release-sha> \
  --target-ref release/YYYY.M.PATCH \
  --workflow-sha "$TOOLING_SHA" \
  -f validation_purpose=postpublish-confidence \
  -f release_package_spec=openclaw@YYYY.M.PATCH-beta.N \
  -f evidence_package_spec=openclaw@YYYY.M.PATCH-beta.N \
  -f run_release_soak=true \
  -f npm_telegram_provider_mode=mock-openai
```

Do not use the full umbrella as the first rerun after a focused fix. Classify the failure as product, harness/tooling/provenance, infrastructure/credential, or wrapper. Only confirmed product failure changes the Code SHA. Diagnose and fix the owner before an explicit focused validation run; never rerun a failed test automatically.

A narrow green run is evidence, not publish authorization by itself; there is no standalone parent finalizer.

`rerun_group=all` may reuse a prior green umbrella run when the release profile,
coverage policy, effective soak setting, and validation inputs match and either the target SHA
is identical or the new target is a descendant whose complete delta meets
[changelog-only evidence reuse](/reference/release-changelogs#changelog-only-evidence-reuse). Exact-target reuse records
`exact-target-full-validation-v1`; a split-layout changelog-only descendant records
`split-changelog-release-v1`. Historical root-only evidence keeps its original
`changelog-only-release-v1` policy. Changelog-only reuse covers only product validation. Npm
preflight, package bytes, release-note provenance, and install/update acceptance
must still run against the Release SHA. Any version, source, generated,
dependency, package, or workflow-owned target change requires a new Code SHA
and fresh full validation. Concurrency is keyed by Validation SHA, Tooling SHA,
and rerun group and does not cancel prior runs. Parent cancellation leaves
adopted children running until the operator cancels the exact child. Pass
`reuse_evidence=false` only when a fresh full run is intentionally required.

For bounded recovery, pass `rerun_group` to the umbrella. Supported controller groups are `ci`, `plugin-prerelease`, `install-smoke`, `cross-os`, `live-e2e`, `package`, `qa-parity`, `qa-live`, `npm-telegram`, and `performance`; use `all` only for deliberate full validation.

The removed `release-checks` aggregate handle is invalid because it silently selected every release-check lane and its package/Docker setup. `qa` remains available only as a direct `OpenClaw Release Checks` manual aggregate, not as an umbrella/controller retry API.

Focused `npm-telegram` reruns require `release_package_spec` or `npm_telegram_package_spec`; all-group runs use Package Acceptance Telegram E2E except beta without soak, where it is deferred. Focused cross-OS reruns can add `cross_os_suite_filter=windows/packaged-upgrade` or another OS/suite filter.

Live and QA-live filters are valid only with their owning group. Cross-OS filters with `rerun_group=all` must retain `packaged-fresh`, `installer-fresh`, and `packaged-upgrade` on Linux (`ubuntu`), Windows, and macOS. All nine OS/suite pairs are required for `npm-stable-v1` and `npm-beta-v1`; filters that omit a required pair are rejected.

Mismatches fail before scheduling and never become an unfiltered broad run. QA release-check failures block normal release validation, including OpenClaw dynamic tool drift in the core runtime-pair lane. Selected QA, Telegram, and live-provider suites fail Release Checks on every profile, including beta and Tideclaw alpha.

Each live channel command runs once; a failed attempt cannot be replaced by a passing retry. When `live_suite_filter` explicitly requests a gated QA live lane such as Discord, WhatsApp, or Slack, the matching `OPENCLAW_RELEASE_QA_*_LIVE_CI_ENABLED` repo variable must be enabled; otherwise input capture fails instead of silently skipping the lane.

### Vitest

The Vitest box is the manual `CI` child workflow. Manual CI bypasses changed scoping and selects the normal test graph for the release candidate: Linux Node shards, bundled-plugin shards, plugin and channel contract shards, Node 24 minimum compatibility, `check-*`, `check-additional-*`, built-artifact smoke checks, docs checks, Python skills, Windows, macOS, and Control UI i18n.

Under `npm-beta-v1`, the umbrella passes `release_scope=npm-beta` and `include_android=false`: native Swift/OpenClawKit, iOS, Android, and native i18n CI lanes are deferred; macOS and Windows Node checks remain. Other Full Release Validation runs use full CI with Android.

Standalone manual CI defaults to full coverage and requires `include_android=true` for Android.

Use this box to answer "did the source tree pass the selected CI suite?" It is separate from release-path product validation. Evidence to keep:

- `Full Release Validation` summary showing the dispatched `CI` run URL
- `CI` run green on the exact target SHA
- recorded coverage policy and effective CI `release_scope`, including deferred native coverage
- failed or slow shard names from the CI jobs when investigating regressions
- Vitest timing artifacts such as `.artifacts/vitest-shard-timings.json` when a run needs performance analysis

Run manual CI directly only when the release needs deterministic normal CI but not the Docker, QA Lab, live, cross-OS, or package boxes. Use the first command for non-Android direct CI. Add `include_android=true` when direct release-candidate CI must cover Android:

```bash
gh workflow run ci.yml --ref main -f target_ref=release/YYYY.M.PATCH
gh workflow run ci.yml --ref main -f target_ref=release/YYYY.M.PATCH -f include_android=true
```

### Docker

The Docker box lives in `OpenClaw Release Checks` through `openclaw-live-and-e2e-checks-reusable.yml`, plus the release-mode `install-smoke` workflow. It validates the release candidate through packaged Docker environments instead of only source-level tests.

Release Docker coverage includes:

- full install smoke with the slow Bun global install smoke enabled
- root Dockerfile smoke image preparation/reuse by target SHA, with QR, root/gateway, and installer/Bun smoke jobs running as separate install-smoke shards
- repository E2E lanes
  release-path Docker chunks: `core`, `package-update-openai`, `package-update-onboarding`, `package-update-migrations`, `package-update-self-upgrade`, `plugins-runtime-plugins`, `plugins-runtime-services`, `plugins-runtime-install-a` through `plugins-runtime-install-h`, and `openwebui`
- OpenWebUI coverage on a dedicated large-disk runner when requested
- split bundled plugin install/uninstall lanes `bundled-plugin-install-uninstall-0` through `bundled-plugin-install-uninstall-23`
- live/E2E provider suites and Docker live model coverage when release checks include live suites

Use Docker artifacts before rerunning. The release-path scheduler uploads `.artifacts/docker-tests/` with lane logs, `summary.json`, `failures.json`, phase timings, scheduler plan JSON, and rerun commands. For focused recovery, use `docker_lanes=<lane[,lane]>` on the reusable live/E2E workflow instead of rerunning all release chunks.

Generated rerun commands include prior `package_artifact_run_id` and prepared Docker image inputs when available, so a failed lane can reuse the same tarball and GHCR images.

### QA Lab

The QA Lab box is also part of `OpenClaw Release Checks`. It is the agentic behavior and channel-level release gate, separate from Vitest and Docker package mechanics.

Release QA Lab coverage includes:

- mock parity lane comparing the OpenAI candidate lane against the `anthropic/claude-opus-4-8` baseline using the agentic parity pack
- Matrix live-adapter catalog lane using the `qa-live-shared` environment
- live Telegram QA lane using Convex CI credential leases
- `pnpm qa:otel:smoke`, `pnpm qa:otel:collector-smoke`, `pnpm qa:prometheus:smoke`, or `pnpm qa:observability:smoke` when release telemetry needs explicit local proof

Use this box to answer "does the release behave correctly in QA scenarios and live channel flows?" Keep the artifact URLs for parity, Matrix, and Telegram lanes when approving the release. Matrix runs use the same catalog-derived sharded selection in scheduled, manual, and release workflows.

### Package

The Package box is the installable-product gate. It is backed by `Package Acceptance` and the resolver `scripts/resolve-openclaw-package-candidate.mts`. The resolver normalizes a candidate into the `package-under-test` tarball consumed by Docker E2E, validates the package inventory, records the package version and SHA-256, and keeps the workflow harness ref separate from the package source ref.

Supported candidate sources:

- `source=npm`: `openclaw@beta`, `openclaw@latest`, or an exact OpenClaw release version
- `source=ref`: pack a trusted `package_ref` branch, tag, or full commit SHA with the selected `workflow_ref` harness
- `source=url`: download a public HTTPS `.tgz` with required `package_sha256`; URL credentials, non-default HTTPS ports, private/internal/special-use hostnames or resolved addresses, and unsafe redirects are rejected
- `source=trusted-url`: download an HTTPS `.tgz` with required `package_sha256` and `trusted_source_id` from a named policy in `.github/package-trusted-sources.json`; use this for maintainer-owned enterprise mirrors or private package repositories instead of adding an input-level private-network bypass to `source=url`
- `source=artifact`: reuse a `.tgz` uploaded by another GitHub Actions run

`OpenClaw Release Checks` runs Package Acceptance with `source=artifact`, the prepared release package artifact, `suite_profile=custom`, and `docker_lanes=release-typed-onboarding doctor-switch update-channel-switch skill-install update-corrupt-plugin upgrade-survivor published-upgrade-survivor root-managed-vps-upgrade update-restart-auth plugins-offline plugin-update plugin-binding-command-escape`.

This retains typed onboarding, migration, update, root-managed VPS upgrade, configured-auth update restart, live ClawHub skill install, stale plugin dependency cleanup, offline plugin fixtures, plugin update, and plugin command-binding escape hardening against the same resolved tarball.

Telegram uses `telegram_mode=none` for beta `all` without soak; explicit `package` and soak-enabled runs select `mock-openai` by default. Blocking release checks use the default latest published package baseline. Soak resolves the latest stable baseline once and adds the `reported-issues` scenarios; broad historical migration remains a separate manual workflow.

Use Package Acceptance with `source=npm` for an already shipped candidate, `source=ref` for a SHA-backed local npm tarball before publish, `source=trusted-url` for a maintainer-owned enterprise/private mirror, or `source=artifact` for a prepared tarball uploaded by another GitHub Actions run.

It is the GitHub-native replacement for most of the package/update coverage that previously required Parallels. Cross-OS release checks still matter for OS-specific onboarding, installer, and platform behavior, but package/update product validation should prefer Package Acceptance.

The canonical checklist for update and plugin validation is [Testing updates and plugins](/help/testing-updates-plugins). Use it when deciding which local, Docker, Package Acceptance, or release-check lane proves a plugin install/update, doctor cleanup, or published-package migration change.

Exhaustive published update migration from every stable `2026.6.1+` package is a separate manual `Update Migration` workflow, not part of Full Release CI.

Pre-June 2026 package-acceptance exceptions are retired. Current tooling requires complete package inventory, no local build metadata, service-wrapper support, and current update/plugin persistence contracts. Use matching historical `workflow_ref` tooling when reproducing acceptance results for old candidates.

Use broader Package Acceptance profiles when the release question is about an actual installable package:

```bash
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=npm \
  -f package_spec=openclaw@beta \
  -f suite_profile=product
```

Common package profiles:

- `smoke`: quick package install/channel/agent, gateway network, and config reload lanes
- `package`: install/update/restart/plugin package contracts plus live ClawHub skill install proof; this is the release-check default
- `product`: `package` plus MCP channels, cron/subagent cleanup, OpenAI web search, and OpenWebUI
- `full`: Docker release-path chunks with OpenWebUI
- `custom`: exact `docker_lanes` list for focused reruns

For package-candidate Telegram proof, enable `telegram_mode=mock-openai` or `telegram_mode=live-frontier` on Package Acceptance. The workflow passes the resolved `package-under-test` tarball into the Telegram lane; the standalone Telegram workflow still accepts a published npm spec for post-publish checks.
