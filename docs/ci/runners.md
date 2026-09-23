---
summary: "Trust-based runner routing, Blacksmith classes, and runner backend modes"
title: "CI runner classes"
read_when:
  - You need to know which runner a lane uses
  - You are choosing or changing a runner class
---

## Runners

Runner choice follows contributor trust, not whether a pull request came from a fork. Every `runs-on` expression admits Blacksmith only when `github.event.pull_request.author_association` is `OWNER`, `MEMBER`, `COLLABORATOR`, or `CONTRIBUTOR`, so a fork pull request from someone who has already landed a commit is routed exactly like a maintainer pull request. `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE`, and `MANNEQUIN` stay on GitHub-hosted runners, which are free for public repositories, so an unreviewed author cannot spend Blacksmith capacity. Maintainers report `CONTRIBUTOR` here because org membership is concealed; keep `CONTRIBUTOR` in that list or maintainer pull requests lose Blacksmith. Pushes and manual dispatches are unaffected. Cache trust is a separate, stricter boundary: exact dependency restores require a pull request from `openclaw/openclaw`, and ordinary CI never publishes the shared archives. The separate trusted warmer owns publication.

| Runner                           | Jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ubuntu-24.04`                   | `openclaw/ci-gate` in every mode, hybrid preflight retries, `check-docs` in every mode (its ClawHub mirror clone is unauthenticated by design), `security-fast` outside hybrid first attempts, manual CI dispatch and non-canonical repository fallbacks, CodeQL security and quality scans, workflow-sanity, labeler, auto-response, the standalone Docs workflow, the whole Install Smoke workflow, all configurable CI jobs in `github` mode, and the remaining light lanes plus rerun Blacksmith lanes in `hybrid` mode. The GitHub/hybrid planner profile expands the Node matrix, QA Smoke to six parts, core oxlint across five stripes (two jobs on ordinary non-frozen hybrid push/PR runs), and type checks across three jobs. Extension/scripts lint plus optional UI and format checks stay in `check-lint`; the last core type batch shares `check-test-types` with the extensions/root/scripts tail. |
| `blacksmith-4vcpu-ubuntu-2404`   | `preflight` when the backend is unset or `blacksmith`, hybrid first-attempt `security-fast`, `native-i18n`, `checks-fast-core` except QA Smoke CI, plugin/channel contract shards, most bundled/lower-weight Linux Node shards, `check-*` lanes except `check-lint`, selected `check-additional-*` shards, and `skills-python`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `blacksmith-8vcpu-ubuntu-2404`   | Retained heavy Linux Node suites and native compact rows previously requesting the 4-class, the `checks-ui-e2e` browser-extension row, boundary/extension-heavy `check-additional-*` shards except runtime topology architecture, and `android`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `blacksmith-16vcpu-ubuntu-2404`  | Trusted automatic hybrid first-attempt preflight, main CI build artifacts, automatic QA Smoke, Docker seed, Control UI E2E, lint, dependencies, test types, core test-type stripes, extension package boundaries, and runtime topology architecture                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `blacksmith-32vcpu-ubuntu-2404`  | Full CLI bins, memory-gated Node rows, two-child compact bins, Blacksmith tooling and agent-support bins, hybrid unified and SDK declaration compiler fixture bins, real-Gateway E2E, separate npm release preflight and reusable release/E2E workflows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `blacksmith-16vcpu-windows-2025` | `checks-windows`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `blacksmith-6vcpu-macos-15`      | `macos-node` on `openclaw/openclaw` when the backend is unset or `blacksmith`; hybrid and existing fallback routes use `macos-15`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `xcode-27`                       | All selected `macos-swift` and iOS build phases, both full-manual screenshot shards, and all four Periphery scans always use GitHub-hosted capacity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

The table lists default placement. On eligible hybrid first attempts, the [hosted budget](/ci/capacity#bounded-hybrid-hosted-offload) can move `security-fast`, all three `checks-ui` rows, and only the browser-extension E2E row to `ubuntu-24.04`; the default Blacksmith routes apply when optional admission is closed.

Healthy eligible main pushes and Windows-selected PRs can additionally offload five check rows under the [assignment guard](#hybrid-hosted-assignment-guard). Main alone can then offload lint and central test types. Each decision consumes remaining capacity within the same 45-row limit; the original runner remains the fallback. Artifact builds retain the 16-class: their hosted maximum reached 898 seconds before preflight and gate overhead. See the [routing measurements and qualification gaps](/ci/routing-costs).

Native Swift builds/tests, iOS build phases, screenshot shards, and Periphery scans use Xcode 27 on GitHub-hosted `xcode-27`, the preview macOS 27 image. This toolchain change preserves hosted placement, job counts, worker caps, coverage, and deadlines; it adds no Blacksmith registrations. The Swift source-language minimum remains 6.3. Native compatibility and complete job timings require proof on the new image.

The earlier hosted-routing validation used `macos-26`: repeated first attempts left the Blacksmith macOS jobs unassigned while other CI completed. In [run 33616182173](https://github.com/openclaw/openclaw/actions/runs/33616182173), the hosted retry assigned all three waiting Mac jobs within eight seconds; the Debug/simulator job passed in 15m31s. That historical result predates Xcode 27. Complete native evidence remains required for full manual qualification.

The Node test planner marks only shards that run the real native grep fixture.
Those Linux jobs install the `ripgrep` package when the selected runner image
does not provide it. Other Node shards do not pay that setup cost.

Current targets share one checkout/setup per fast contract family. The two weighted plugin selections still run as separate `test:contracts:plugins` processes; the two channel selections still run separate `test:contracts:channels` invocations, each retaining its four owning configs, four project slots and one worker per project. The envelopes run sequentially, and any nonzero exit stops the job before another envelope is admitted. Frozen targets keep their original matrix rows and execute one envelope per row. Runner routing, caches, worker budgets and aggregate-gate selection stay unchanged. In main run `33704083233`, the separate plugin bodies totaled 94 seconds and the channel bodies 145 seconds; those sums support consolidation but are not measured combined durations.

The dependency warmer publishes the completed pnpm store immediately after setup,
before unrelated SDK, build, or transform work can fail. All cache-enabled Node
setups use the same workspace-local store path, including store-only readers;
Actions includes that path in cache compatibility. Pnpm's side-effects cache
carries native postinstall outputs such as Matrix crypto's binary and version
marker, so a compatible warm install skips the download. Cold caches and changed
native build inputs still require the upstream asset.
Setup restores the configured store root before activating pnpm. The same
artifact contains the pinned pnpm wrapper and Linux native executable archives
under `toolchain/`, keyed by the complete `packageManager` pin. Bootstrap checks
their SHA-512 hashes in private staging before extraction; missing or invalid
archives fall back to the runner image, then the registry. Exact dependency
archives carry the same files, and dependency repair preserves them. Store v2
and exact-dependency v4 entries reseed once to include these bootstrap archives.
Cache publication still belongs to the existing warmer on each backend.
Node discovery scans only the toolcache's executable levels, avoiding bundled
npm dependency trees before selecting an already-installed runtime.

In hybrid mode, independent hosted dependency and code-warming jobs populate
GitHub's cache backend. Blacksmith and GitHub-hosted cache archives remain
separate. See [cache ownership and seed selection](/ci/scope-and-routing/node-test-lanes)
for the full Linux and bounded hosted profiles.

### Windows dependency-cache experiment

Normal Windows CI keeps dependency setup uncached. In the September 20
[benchmark](https://github.com/openclaw/openclaw/actions/runs/35547255790), median
complete setup took 45.295s cold versus 52.738s with a restored store (+16.4%),
despite reusing all 1,453 packages with zero downloads. Restoring the 763.8-MiB
archive took 23.601/25.978/26.980s; the first sample spent 20.966s extracting it.
Producer setup plus archive publication added 62.527s of job work.

All seven native jobs passed, but the workflow failed qualification: its reducer
rejected a 24-KiB difference in reported total RAM. These measurements use the
original receipts, with no assertion changes or reruns. The exactly RAM-matched
subset had a 47.369s cold median versus 52.738s warm (+11.3%); this descriptive
comparison does not replace the failed qualification. Revisit caching only when
complete setup improves after accounting for restore, extraction, frozen
reconciliation, and producer work.

### Blacksmith runner capacity

Npm preflight retains `blacksmith-32vcpu-ubuntu-2404`. Main CI previously used
the same class for test types, core type stripes, and runtime-topology checks
to compensate for smaller delivered machines.
In the [2026-09-01 capacity probe](https://github.com/openclaw/openclaw/actions/runs/33538827388),
that label was the first measured class meeting the eight-CPU/24-GiB threshold
used by OpenClaw's parallel-check policy:

| Requested x64 Ubuntu 24.04 label | Observed CPUs | Observed RAM |
| -------------------------------- | ------------: | -----------: |
| `blacksmith-2vcpu-ubuntu-2404`   |             2 |     7.66 GiB |
| `blacksmith-4vcpu-ubuntu-2404`   |             2 |     7.66 GiB |
| `blacksmith-8vcpu-ubuntu-2404`   |             2 |     7.66 GiB |
| `blacksmith-16vcpu-ubuntu-2404`  |             4 |    15.42 GiB |
| `blacksmith-32vcpu-ubuntu-2404`  |             8 |    30.95 GiB |

OS CPU count, affinity, Node, and CPU-time measurements agreed. Guest cgroup
quotas were unlimited. The provider-side reason for the mismatch is unresolved;
the table records observed capacity, not Blacksmith's advertised specifications
or a guaranteed allocation. The probe measured capacity, not whole-release
speedup or billing equivalence.

Compact Node jobs retain the planner's 32-class request for two-child bins and
Blacksmith tooling or agent-support owners. The 16-class delivered four CPUs and
15.42 GiB, forcing two-child plans to execute serially despite their unchanged
aggregate packing budget. The 32-class is the measured allocation that meets
the existing eight-CPU/24-GiB admission threshold. Packing, check names, timing
identities, budgets and worker limits remain unchanged; actual capacity still
gates overlap. This moves existing jobs between classes without adding runner
registrations or hosted rows. Real-Gateway E2E also retains its 32-class request;
other main CI placements retain the 16-class sizing.
Native CI must establish the resulting execution and queue times.

Compact groups with a memory-gated worker allowance also request the 32-class,
including standalone serial bins. The isolated Gateway groups already request
eight workers with a 28-GiB memory floor and a two-worker fallback. On main run
`35791016837`, two 8-class rows received two CPUs and 7.66 GiB: their isolated
children took 413 and 369 seconds, and the complete jobs took 678 and 685 seconds.
The 32-class meets that existing allowance. Promotion happens after packing;
file membership, child ordering, memory checks and fallback workers remain owned
by the same planner and executor. Hosted routing still uses the workflow's trust
and retry rules. This adds no jobs or runner registrations.

Native compact rows that would request the 4-class now request the 8-class after
packing. Both delivered two CPUs and 7.66 GiB in the capacity probe, while the
five-run September 21 sample showed a 125-second median assignment wait on the
4-class. Logical packing classes, child processes, worker limits, and hosted
fallbacks stay unchanged. This avoids that queue at a higher per-minute rate;
the combined packing and hosted-check changes must establish the net cost saving.

Current-target `build-artifacts` uses the existing 16-class. A [controlled Testbox proof](https://github.com/openclaw/openclaw/actions/runs/34669346942) at `3ccc3710bd6` completed all eight job compute steps in 229.3 seconds (252.8 seconds including payload setup) on four CPUs and 15.42 GiB RAM, with a 12.59 GiB cgroup peak and no recorded OOM events. The proof retained the complete parallel verifier wave and passed final source, worker-generation cleanup, and memory-event checks. The existing SDK memory gate keeps declarations serial below the capacity needed for both compiler heaps. Frozen targets and missing target classifications now request the same 16-class; hosted fallbacks, job counts, concurrency, and deadlines are unchanged. The recorded measurements establish compute fit for that tested current target, not historical targets or a guaranteed full Actions duration.

Existing recommendation-based promotions from the 8-class remain for `checks-node-compact-large-5` and `checks-node-compact-large-9`. Extension bundles follow the planner's runner metadata: the former bundle-16/bundle-25 overrides would attach old recommendations to different work after compaction. The former 32-to-16 overrides for `checks-node-compact-small-3`, `checks-node-compact-small-4`, and `checks-node-compact-small-10` are removed so these rows retain their planner-owned parallel or tooling capacity. Numbered bins can contain different work across profiles and revisions; the retained compact recommendations use a 24-hour window and still need ownership-based replacement when those bins change. A later recommendation identified CPU saturation for `build-artifacts` on the 16-class. Current complete-job duration and memory headroom still need measurement; the earlier controlled proof retains its original source scope.

Eligible `checks-ui-e2e-real-gateway` rows retain their planned 32-class. The
planner balances serial fixtures and audited parallel standalone files in the
first row; the second owns the remaining parallel files. The first row also owns
the desktop transport proof when selected by full manual/release validation or
a direct desktop-spec edit. Both rows retain their existing worker limits, build-before-test
ordering, hosted fallbacks, and test deadlines. Runtime-only preparation leaves
SDK declaration generation and validation with `build-artifacts`. The split adds
one job and possible registration when the lane is selected, while ordinary PRs
continue to omit it. Runner labels and backend routing are unchanged. Exact-head
CI measures complete row walls, including setup and transport proof.

The 32-class restores capacity for the unchanged 20-minute Blacksmith budget.
In [run 35120538555](https://github.com/openclaw/openclaw/actions/runs/35120538555/job/104877350907),
the 16-class delivered four CPUs and was canceled after 1,227 seconds while
real-Gateway files continued passing; the last file passed 13 seconds before
cancellation. Setup, artifact build and desktop proof consumed 6m31s before the
browser suite. Keep the complete job inside its existing budget by restoring
capacity, with the hosted routes and all test deadlines unchanged.

The real-Gateway job has a 40-minute budget when its existing routing selects
`ubuntu-24.04`, and 20 minutes on Blacksmith. In [run 34707873095, attempt 2](https://github.com/openclaw/openclaw/actions/runs/34707873095/attempts/2),
7m42s elapsed before the browser suite began; the 20-minute job limit then
canceled a progressing suite before its widget cases. The hosted budget covers
the complete setup, private artifact build, and test workload. Individual test
and subprocess deadlines, test inventory, workers, routing, and concurrency
limits apply unchanged on both routes. This adds no jobs or runner registrations
and makes no claim that execution is faster.

The full CLI compact bin requests the 32-class after packing and uses measured
workers with `fallbackMaxWorkers: 2`. Serial self-hosted execution can admit
eight workers on the observed eight-CPU/30.95-GiB allocation. Hosted, frozen,
constrained, and overlapping execution retain the fallback. Process-only CLI
bins, serial companion execution, packing, and job counts keep their existing
policies. See [Vitest worker sizing](/ci/capacity#vitest-worker-sizing).

The earlier 16-class placement had a controlled 2026-09-10 Linux Testbox
comparison at the same source, memory, starting caches, and case inventory:
12m20s–14m15s with two available CPUs versus 9m17s with four, both at two Vitest
workers. All 307 files and 7,977 cases were retained. Those measurements do not
describe the 32-class policy or include CI setup, queueing, or companion groups.
The later CLI timing weight of 595 seconds and complete CLI config remain
unchanged by the measured-worker cutover.

Backend routing still applies. Hybrid retries and untrusted pull requests retain
their hosted routes. Ordinary manual CI dispatches remain hosted in hybrid mode;
Full Release Validation's existing frozen-target lint exception remains separate.
Npm preflight uses the larger Blacksmith request by default and retains its
explicit `use_github_hosted_runners` option.

Ordinary iOS smoke CI builds the app and embedded Watch targets for the runner's
architecture, using the same iPhone simulator for compilation and voice-cleanup
tests. It omits compiler indexes, which CI does not consume, and finishes
simulator preparation before XCTest launch. Smoke retains complete test results
and logs but disables verbose system-diagnostic collection: Xcode 27 can spend
600 seconds collecting it after passing tests. Full manual validation retains
universal simulator compilation, verbose diagnostics, the Release device build,
and lifecycle/UI/Watch tests. Frozen targets keep their original build settings.

### Runner backend modes

The `macos-swift` lane builds Swift tests once and runs each test once per job. The ordinary suite retains default-profile behavior; rendered Quick Chat tests follow in a fresh default-profile process, then AppState isolation tests run in a named-profile process through the same resource-owning launcher. Historical targets retain their original two partitions. Each launch owns a private home and disposable, unlocked default Keychain until the test process group and output pipes close. HOME and profile markers do not isolate macOS services; all partitions run only on the disposable credentialless macOS worker. Current launcher-capable targets bound Swift Testing parallelism to the runner's logical CPU count, capped at 12, for automatic runs, manual dispatches, and rerun attempts. Only frozen targets that predate the resource owner use the serial fallback. A failing test fails the job without an in-job retry. See [native test safety](/platforms/mac/dev-setup#run-native-tests-safely).

The repository variable `OPENCLAW_CI_RUNNER_BACKEND` controls the runner backend for `ci.yml`:

| Value                 | Light lanes                                                                 | Heavy lanes                                                                   | Rerun behavior                                                                        |
| --------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| unset or `blacksmith` | Blacksmith-first, with the existing manual-dispatch and fork fallbacks      | Blacksmith-first, with the existing manual-dispatch and fork fallbacks        | Existing behavior is unchanged                                                        |
| `github`              | GitHub-hosted                                                               | GitHub-hosted                                                                 | Every configurable job remains hosted                                                 |
| `hybrid`              | Eligible preflight and other critical-path jobs use Blacksmith on attempt 1 | Blacksmith on attempt 1; GitHub-hosted on `github.run_attempt > 1`            | Rerunning a failed or stuck Blacksmith job automatically moves it to hosted capacity  |
| `runson`              | Hybrid baseline                                                             | Non-build 32-class Node rows, cron and Control UI E2E on diversified capacity | Automatic Spot-interruption retries disabled; other reruns retain the hybrid fallback |

Configurable heavy lanes are `build-artifacts` and `android`. The macOS Swift, iOS build, and screenshot jobs always use GitHub-hosted `xcode-27` with Xcode 27. The focused `macos-node` lane uses the existing GitHub-hosted `macos-15` image in hybrid mode, with the same test inventory and two-worker limit. `openclaw/ci-gate` always uses `ubuntu-24.04`: its Bash-only result aggregation needs no checkout or dependency setup. This removes one Blacksmith registration from previously eligible runs without adding jobs or changing the required check. Hosted runner assignment can still delay completion. Trusted automatic hybrid first-attempt `preflight` requests the existing 16-class after three nearby hosted preflights remained unassigned while their Blacksmith security jobs completed. Hybrid retries, manual dispatches, untrusted and noncanonical contexts, and the `github` override stay hosted. Unset or `blacksmith` keeps the existing 4-class route. Logical planner profile, cache trust, steps and the 20-minute deadline remain unchanged; actual assignment and completion still require CI proof. `security-fast` uses Blacksmith only on eligible hybrid first attempts when the [hosted budget](/ci/capacity#bounded-hybrid-hosted-offload) cannot admit optional work, and stays hosted outside `hybrid`. It waits for preflight to count the selected hosted rows, and still executes after a preflight failure unless the workflow is canceled. Security hooks use pinned installed packages and local hook definitions, so they no longer initialize remote Git repositories. Budget two control-job registrations per eligible hybrid first attempt when optional hosted admission is closed, one when admitted, and one per normal Blacksmith run; both jobs are already reserved in the conservative registration ceiling. The `github` override remains unchanged. Hybrid sends the compact Node matrix, up to 80 compact rows plus separately appended plugin fallback rows, thirteen-row `checks-ui-e2e` matrix for targets with the named-project contract, the `checks-ui-e2e-real-gateway` lane that shares its serial Chromium workload, four-row QA Smoke matrix on canonical automatic runs (six rows for manual dispatches), the two-part Windows matrix, `checks-ui`, `check-lint`, `check-test-types`, the five `check-test-types-core-*` rows, `check-dependencies`, `check-additional-extension-package-boundary`, `check-additional-runtime-topology-architecture`, and `report-plugin-sdk-api-diff` to Blacksmith on attempt 1. Eligible two-child ordinary compact rows request `blacksmith-32vcpu-ubuntu-2404`; bins containing the full `agentic-cli` group request `blacksmith-32vcpu-ubuntu-2404` after planning. Other compact-small rows retain `blacksmith-4vcpu-ubuntu-2404`, compact-large rows retain `blacksmith-8vcpu-ubuntu-2404`, and the planner's measured small queue-tail promotions retain their 8-vCPU labels. Within that set, `checks-ui` and only the browser-extension E2E row move to hosted Ubuntu when preflight admits at most five optional rows below the 45-row hosted limit. Every other configurable `ci.yml` lane stays hosted in hybrid, including the core-lint jobs, the remaining lint/check rows, docs, and Python skills. Separate Opengrep workflows remain GitHub-hosted.

### RunsOn qualification

The opt-in `runson` profile consumes hybrid's file selection, packing and worker
policies. Eligible non-build 32-class Node rows request 8–16 actual CPUs and
32–48 GiB, preserving the 24-GiB overlapping-child and 28-GiB isolated-Gateway
admission floors. Blacksmith's requested 32/16 classes delivered eight/four CPUs
in the native probes; advertised labels are not worker counts. Runtime builds,
dist rows and the measured update-CLI storage envelope retain Blacksmith.

Each request admits five exact instance types. Fast-family preference is best
effort: RunsOn's capacity-optimized-prioritized policy (`spot=cop`) chooses
capacity first. Older AMD alternatives require native workload qualification;
the family list does not establish equal single-thread performance.

| Pool                | CPU / GiB bounds | Spot preference order                                                       |
| ------------------- | ---------------- | --------------------------------------------------------------------------- |
| Node                | 8–16 / 32–48     | `m8azn.3xlarge`, `m8a.2xlarge`, `c8a.4xlarge`, `m7a.2xlarge`, `c7a.4xlarge` |
| Cron and Control UI | 4–8 / 16         | `m8azn.xlarge`, `m8a.xlarge`, `c8a.2xlarge`, `m7a.xlarge`, `c7a.2xlarge`    |

The `m8azn` family has no 2xlarge size; its 3xlarge supplies 12 CPUs and 48 GiB.
Resource ranges keep that alternative eligible. Direct on-demand requests put
`m8a` first, matching the measured CPU need at a lower reference price. All rows
use `ubuntu24-full-x64`, an 80 GB gp3 root and the pinned workflow Node version.
Blacksmith dependency archives remain disabled on AWS; portable caches remain.

Spot admission requires a known positive planner prediction plus 150 seconds
for launch, setup and cleanup to fit within 480 seconds. Saved successful
allocations measured at most 125 seconds outside the test envelope. The reserve
is only a conservative market decision: it does not change execution deadlines,
packing estimates or worker limits. Some existing predictions already include
setup; their conservative double counting is retained. Longer and unknown rows
use on-demand. UI lacks a complete per-row forecast and therefore uses
on-demand. Cron retains its two-worker ceiling; Control UI retains existing
project and job worker policies.

The GitHub-projects E2E spec remains on a separate Blacksmith row while its
previous AWS RPC timeout is unresolved. The UI inventory owner partitions the
selected file list into disjoint ordinary and retained groups; no test is
removed or tied to a numbered shard. Hybrid keeps its existing inventory.

Requests leave AZ selection unrestricted within the existing stack and specify
`region=us-east-1`. The installed v3.3.1 release's built-in topology provisions two subnet AZs;
native receipts show allocations in `us-east-1a` and `us-east-1b`. Live stack
parameters were not reread. The request permits every configured subnet,
without claiming that every possible regional AZ is configured. There is no
per-job AZ label and qualification does not provision another subnet or stack.
Allocation logs record the selected type, market, region, AZ, AZ ID, CPU count,
memory and launch time. Cost reports price those actual allocations.

```yaml
runs-on: runs-on=${{ github.run_id }}-${{ matrix.check_name }}/family=m8azn.3xlarge+m8a.2xlarge+c8a.4xlarge+m7a.2xlarge+c7a.4xlarge/cpu=8+16/ram=32+48/spot=cop/retry=false/image=ubuntu24-full-x64/volume=80gb/region=us-east-1
```

The GitHub App owns allocation. `spot=cop` retains native on-demand capacity
fallback; `spot=false` requests on-demand directly. `retry=false` disables
interruption reruns. An interrupted job fails rather than repeating side
effects. See the [provider label contract](https://runs-on.com/docs/runners/labels/)
and [measured costs and interruption limits](/ci/routing-costs#runson-remains-unqualified).

These routes require the first attempt of a canonical main push or trusted
same-repository PR. Frozen targets and subsequent attempts retain hosted
fallback. Qualification never changes `OPENCLAW_CI_RUNNER_BACKEND`.

For exact-head qualification, dispatch `ci.yml` from the PR's canonical branch
with `runner_backend=runson`, `release_gate=true`, `pull_request_number` and
`target_ref` equal to its full head SHA. Workflow source and checkout must both
match that head and existing maintainer admission must pass. Default shape uses
PR coverage and adds one identical Blacksmith cron comparator with pinned Node
and two workers. The comparator counts against the existing Node cap; ordinary
PRs omit it. Cron must be selected or preflight fails before comparison allocation.

Set `ci_shape=main` for push coverage and its 70-row Node cap; this omits PR
extension fallback and the cron comparator. Neither shape expands to full-manual
release-only work. Raw GitHub event/ref still own trust, concurrency, cache
publication and provenance. Qualification preflight remains hosted and counts
in raw workflow wall and hosted budgets. Untrusted, unrelated and ordinary
manual targets cannot use the override. Final acceptance requires two green
main-shaped and two green PR-shaped workflows at the same head, each within
900 seconds; failed or interrupted attempts remain in the report.
