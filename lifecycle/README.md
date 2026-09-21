# Product-capable observer harness derivative — SOURCE ONLY

Owner: PR125286 / ec13cd14-c294-406a-8c0c-97bdeb48b76d; canonical54bd coordinates.
This package does not authorize execution. No hosted job, smoke, product setup,
updater, Doctor, DLL load, CI rerun or publication occurred in this phase.

## Immutable lineage

- Candidate393c80255dea6605a5665c6e0836d01fb6d18304, tree d4bb6a0016a6aab695c9c6fe67b40c76f3d9ee6b.
- Observer tree24ab44502e61676a83f106e7b797116722150d6f: unchanged observer APIs/identity/scan source.
- Original bundle b1fc8cfd9a57205fe3af6ffcf14af32ff7657af2dac9f748fc7db369b0087fe0 remains in ../observer-harness.
- Inert-smoke derivative96c2e3e1631866ac8ebf82eeb22a4b33e33f360c0160aa7feffe28b1491ecdcc remains in ../hosted-smoke-source/payload.
- HOSTED-SMOKE-PARENT-RETURN.json SHA f2a5449b870ed5df3fd854c18d773e1a2c34f70426dd7a37b300e7116e11d567 is mechanism evidence only, not current-job proof.

## Demonstrated findings integrated here

Original product CLI admitted ImageOS=win25, not actual win25-vs2026.
Both Python product CLI and PowerShell pre-setup gates now require the actual
measured host, Windows10.0.26100, native AMD64, CPython3.13.7, PowerShell7.6.5
and its measured executable hash. ImageVersion is exactly20260907.229.1.
Image labels float; another version fails closed and requires inventory plus
reviewed pins, never an environment rewrite. `host-pin.json` records the shell pin.

The smoke-native handle experiment returned QueryFullProcessImageNameW error31
AFTER exit while retained GetProcessTimes supplied creation and positive exit.
`Session.finish` keeps the original terminal record with no invented executable.
`complete_diagnostic` now requires that exact update Popen and record to remain
in the Session and recomputes settlement from raw launch/terminal identities.
It distinguishes normal terminal image success from same-held-handle time/launch
image evidence with terminal-image absence/error31. PID reuse, changed image,
architecture drift, other errors, missing launch image, nonpositive/missing exit
and unsettled processes fail. It still enforces update creation/exit within the
armed-to-settled UTC window; no continuous census is claimed.
A nonzero update exit can settle observation but never establishes product success.

## Staging and product setup separation

`COMMANDS.json` binds bundle, stage script, exact Python archive/executable/member
hashes, external namespace and argv. `stage.ps1` is a new source-qualified
external hook, not an installed workflow. It stages pins, captures actual host,
run/attempt1, paths and shell identity, parses diagnostic.ps1 and exercises ONLY
its parameter AST, then performs this job's own25s smoke via `run.py smoke`.
It cannot fall through to product execution. Success returns a retained runtime
and raw smoke tuple. The inert4096-byte fixture is removed after verified exits;
raw evidence remains. The admitted caller owns later runtime/proof cleanup after
settlement and custody checks; unsettled resources are retained without kill.

A future separately admitted supported workflow must wire this exact stage hook
and capture its actual commit as GITHUB_SHA/PROOF_WORKFLOW_SHA/ExpectedWorkflowSha.
These three must match; they are not falsely rewritten to393. The separately
checked candidate HEAD/tree stays393. The actual workflow commit/hook integration
is intentionally still missing, because no workflow publication is authorized.

`diagnostic.ps1` verifies its own hash/payload and shell contract and calls
`run.py preflight` BEFORE any product setup. Preflight verifies Python members,
exact host/run/attempt/runtime/bundle, current smoke namespace, both raw positive
MEM_MAPPED leaf records with baseline IDs, actual arming/terminal output, and both
settled zero-exit children. Truncated or status-only proof cannot pass. Historical
35529432478 and disposed35596476995 are explicitly rejected. After installed-driver
setup, the same raw gate runs again before observer launch. The official published2026.9.5 archive is downloaded after smoke, checked for exact
size/SHA256/SHA512 and all11428 member hashes WITHOUT extraction or execution,
then passed as a local.tgz to the unchanged installer's supported -Tag input
(RELEASE-INSTALL-SUPPORT.json). No registry tag is re-resolved for the root
package. Installed bytes are checked again before Gateway launch and again
before diagnostic launch. Its bytes remain original2026.9.5; no driver patch. Arming/identity recheck
still precedes unchanged update argv. Original stdout/stderr and exit records
are retained. Product diagnostic native behavior is NOT verified by offline tests.

Update argv remains node openclaw.mjs update --channel dev --yes --json
--no-restart --timeout1200. The shared update observation deadline remains3600s.
No new kill/unload/preload/injection or timeout increase. The original supported
setup/Stop-ProofGateway behavior is inherited, not executed or newly qualified;
the observed update bypasses the setup wrapper's killing timeout path. No Doctor
or candidate Gateway acceptance runs after the diagnostic. Evidence/proof roots
remain for custody-safe disposition. Native NEEDS WORK and full-chain/LAND holds
are unchanged.

## Source verification

Offline controls: python3.13 -B -m unittest -v test_harness test_smoke_settlement test_product test_release test_budget.
`smoke-control-fixture.json` is a reduced synthetic projection of native positive
records with a fictional fresh job identity, used only with mocked host/API. It
is NOT admissible native proof. The original two fail-first controls and native
failure artifacts remain outside this derivative.
`compose.py` regenerates diagnostic.ps1 from exact upstream.ps1 SHA
0cae76a93c08eddea25e4bdcee70c63b2920c2267a9954c4a869ad013641d815.
`seal.py` hashes payload files only; changed bundle hashes must also update
stage.ps1 and COMMANDS.json before a new source seal/review. Never alter a frozen
review snapshot. `source-inputs.json` is immutable lineage, not a current-host claim.

## Unfixed installed-source dependency

See INSTALLED-GAP.json for exact release-source hashes, symbols and line anchors.
Installed2026.9.5's captured transaction.complete closure directly awaits its own
discardPackageUpdateBackup. Candidate-only cleanup policy cannot replace that
closure or transfer rollback ownership. A compatible installed-parent retirement/
rollback handoff preserving rollback until verified activation remains an
unimplemented and unqualified source dependency. This observer repair does not
fix it. No peer125299/147621 edits. Holder35529432478 remains UNKNOWN; future positive
observations apply only to their own window. No-loss/rollback/full-chain/LAND/F1/
L8/c064 holds remain. Same owner continues after genuine gates; admission has zero
active credit.

## Resolved independent review P1

The first review found that the original version-tag install/Gateway invocation
preceded the installed-file check. The fail-first ordering control reproduced
this. `release.py` now enforces the previously recorded archive+member pins
before the supported local-tgz install path, and rechecks installed bytes before
Gateway invocation. No package extraction, lifecycle script, download, install
or product invocation was performed in this source-only phase. Dependencies
still use the supported installer/package-manager behavior, not a new package
manager or patched released driver. Actual native installation from the pinned
archive remains a runtime prerequisite, not an already-passed criterion.

## Resolved full-window output-budget P1

The retained two-sample native trace is10,400,088 bytes. An offline event replay
of the original360-sample configuration hit64MiB. A separate bounded_observe.py
entry calls the UNCHANGED observer24ab observe function and Windows APIs, with a
GapWriter adapter. Every gap payload (including raw API errors/addresses) is
losslessly retained with sequence/time/run identity in observer.jsonl.gaps.gz;
primary output retains gap-count/hash references, every positive mapping, process
identity and all other original payloads. No gap becomes absence or disappears.
Each stream has its own64MiB physical cap; the sidecar has a512MiB logical ceiling
and is validated streaming, not expanded to a giant retained file. Worst retained
observer evidence is128MiB, within the unchanged512MiB task growth claim; actual
product-job fit remains a separate runtime prerequisite. Missing/truncated/changed
sidecars, sequence/count/hash mismatch or any cap stop deny settlement. Raw
post-exit error31 is separate Session process evidence and remains unchanged.

Product sampling is now60 samples, interval60s, same inherited3600s aggregate
deadline and --timeout1200; original Writer64MiB primary cap remains. The binding
names outputPolicy=lossless-gaps-v1 and the smoke result pins the adapter hash.
A future job's own smoke uses this same adapter and must pass raw sidecar integrity
and a2x physical-output budget projection for60 samples BEFORE product setup.
The projection is evidence of fit on that smoke, not a guarantee against changing
future workload; runtime caps remain fail-closed. Offline replay preserved727860
gap payloads and120 mappings across60 synthetic samples in12.1MB primary +19.0MB
compressed, and verified the complete sidecar before deleting temporary replay
output. No Windows/native observation or repeated inert smoke occurred.

The final budget-admission P2 control requires sample starts AND ends0/1 plus
terminal reason sample-limit. A wall-budget stop during either smoke scan cannot
supply a full-scan volume estimate, even with both positive leaf observations.
Product observation may still end at wall-budget under the inherited deadline;
that is distinct from eligibility of the prerequisite budget smoke.
