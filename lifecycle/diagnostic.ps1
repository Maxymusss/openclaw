# Exact-source end-to-end installer/update proof, only on a disposable hosted Windows VM.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CandidateRoot,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedHead,
    [Parameter(Mandatory = $true)][string]$EvidenceRoot,
    [ValidateSet('published-driver')][string]$ProofCase = 'published-driver',
    [Parameter(Mandatory = $true)][string]$ObserverRuntime,
    [Parameter(Mandatory = $true)][string]$ObserverManifest,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ObserverManifestSha256,
    [Parameter(Mandatory = $true)][string]$ObserverSmokeResult,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ObserverSmokeSha256
)
$ErrorActionPreference = 'Stop'
# Smoke and bundle gates precede EVERY product invocation, including install.
foreach ($name in @('NODE_OPTIONS','NODE_PATH','PYTHONSTARTUP','COR_ENABLE_PROFILING','CORECLR_ENABLE_PROFILING')) {
    if ([Environment]::GetEnvironmentVariable($name, 'Process')) { throw ('Unqualified preload/profiler environment: ' + $name) }
}
$ObserverRuntime = [IO.Path]::GetFullPath($ObserverRuntime)
if ((Get-FileHash $ObserverManifest -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ObserverManifestSha256) { throw 'Wrong observer manifest.' }
$manifest = Get-Content -LiteralPath $ObserverManifest -Raw | ConvertFrom-Json -AsHashtable
foreach ($name in $manifest.payload.Keys) {
    if ((Get-FileHash (Join-Path $ObserverRuntime $name) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifest.payload[$name]) { throw 'Observer payload changed.' }
}
if ((Get-FileHash $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifest.payload['diagnostic.ps1']) { throw 'Wrong composed harness.' }
if ((Get-FileHash $ObserverSmokeResult -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ObserverSmokeSha256) { throw 'Wrong smoke evidence.' }
# Exact measured shell/OS contract; no environment substitution.
$hp = Get-Content -LiteralPath (Join-Path $ObserverRuntime 'host-pin.json') -Raw | ConvertFrom-Json
if ($env:ImageOS -cne $hp.imageOS -or $env:ImageVersion -cne $hp.imageVersion -or
    $PSVersionTable.PSVersion.ToString() -cne $hp.powershellVersion -or
    ([Environment]::OSVersion.Version.ToString(3)) -cne $hp.windowsVersion -or
    [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString() -cne 'X64' -or
    [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -cne 'X64' -or
    (Get-FileHash (Get-Process -Id $PID).Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hp.powershellSha256) { throw 'Unqualified measured host/shell.' }
# Pure preflight revalidates pinned Python/payload, host/run/runtime and raw positive smoke.
# This precedes setup; neither a former VM result nor a status-only document admits product work.
& (Join-Path $ObserverRuntime 'python.exe') '-E' '-S' '-B' (Join-Path $ObserverRuntime 'run.py') 'preflight' `
    '--manifest' $ObserverManifest '--manifest-sha' $ObserverManifestSha256 `
    '--evidence' ([IO.Path]::GetDirectoryName($ObserverSmokeResult)) '--run' ('preflight-' + $env:GITHUB_RUN_ID) `
    '--smoke-result' $ObserverSmokeResult '--smoke-sha' $ObserverSmokeSha256
if ($LASTEXITCODE -ne 0) { throw 'Same-host/run/bundle raw positive smoke required before product setup.' }
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or $PSVersionTable.PSVersion.Major -lt 7) {
    throw 'Full installer proof requires PowerShell7 on a disposable GitHub-hosted Windows VM.'
}
$CandidateRoot = [IO.Path]::GetFullPath($CandidateRoot)
$EvidenceRoot = [IO.Path]::GetFullPath($EvidenceRoot)
$head = (& git -C $CandidateRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -cne $ExpectedHead -or $ExpectedHead -cne '393c80255dea6605a5665c6e0836d01fb6d18304' -or $env:PROOF_WORKFLOW_SHA -cne $env:GITHUB_SHA -or $env:GITHUB_SHA -cnotmatch '^[0-9a-f]{40}$') { throw 'Workflow and candidate must name the same published commit.' }
if ((& git -C $CandidateRoot rev-parse 'HEAD^{tree}').Trim() -cne 'd4bb6a0016a6aab695c9c6fe67b40c76f3d9ee6b' -or $LASTEXITCODE -ne 0) { throw 'Wrong candidate tree.' }
$dirty = @(& git -C $CandidateRoot status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0 -or $dirty.Count) { throw 'Candidate is not clean.' }
$installer = Join-Path $CandidateRoot 'scripts/install.ps1'
$nodePin=Get-Content -LiteralPath (Join-Path $ObserverRuntime 'node-pin.json') -Raw | ConvertFrom-Json
$node = Join-Path $env:RUNNER_TOOL_CACHE $nodePin.relativeToolCachePath
if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -cne $nodePin.exeSha256) { throw 'Pinned Node changed before setup.' }
if ((Get-Command node -CommandType Application | Select-Object -First 1).Source -ine $node) { throw 'Installer Node path differs from the admitted native runtime.' }
$engine = (Get-Process -Id $PID).Path
# Diagnostic source derivative: never an acceptance result; NEW external namespace only.
if (Test-Path -LiteralPath $EvidenceRoot) { throw 'Diagnostic evidence namespace already exists.' }
New-Item -ItemType Directory -Path $EvidenceRoot | Out-Null
$root = Join-Path $env:RUNNER_TEMP ('openclaw-git-install-proof-' + [guid]::NewGuid().ToString('N'))
$names = @('USERPROFILE', 'OPENCLAW_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_GIT_DIR', 'OPENCLAW_UPDATE_DEV_TARGET_REF', 'APPDATA', 'LOCALAPPDATA', 'NPM_CONFIG_PREFIX', 'npm_config_prefix', 'Path', 'TEMP', 'TMP')
$saved = @{}
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$gateway = $null
$proof = [ordered]@{
    result = 'failed'; sourceSha = $head; workflowSha = $env:PROOF_WORKFLOW_SHA
    installerSha256 = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT
    baseline = 'openclaw@2026.9.5'; selection = $ProofCase; cases = @(); commands = @(); cleanup = 'pending'
}
. (Join-Path $ObserverRuntime 'lifecycle.ps1')
Initialize-ProofNative
$script:observationArmed=$false
$script:retainedProcesses=@()
$proof.unsettled=$false
function Invoke-ProofInstaller {
    param([string]$Name, [string[]]$Options, [switch]$ExpectFailure)
    Invoke-ProofCommand -Name $Name -File $engine -Arguments (@('-NoLogo', '-NoProfile', '-File', $installer) + $Options + @('-NoOnboard')) -ExpectFailure:$ExpectFailure
}
function Assert-CandidateHead {
    $observed = (& git -C $CandidateRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $observed -cne $ExpectedHead) { throw 'Installer/updater moved away from the pinned candidate.' }
}
function Save-ProofUpdateLedger {
    $state = Join-Path $root 'profile/.openclaw'
    if (-not (Test-Path -LiteralPath $state -PathType Container)) { return }
    $capture = Join-Path $root 'capture-update-ledger.mjs'
    @'
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const database = path.join(process.argv[2], 'state', 'openclaw.sqlite');
const evidence = { database, exists: fs.existsSync(database), runs: [] };
if (evidence.exists) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    evidence.hasLedger = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='update_runs'").get());
    if (evidence.hasLedger) {
      evidence.runs = db.prepare('SELECT run_id, created_at_ms, updated_at_ms, phase, status, reason, steps_json, verification_json, finished_at_ms FROM update_runs ORDER BY created_at_ms DESC LIMIT 5').all();
    }
  } finally { db.close(); }
}
console.log(JSON.stringify(evidence, null, 2));
'@ | Set-Content -LiteralPath $capture
    Invoke-ProofCommand -Name 'failure-update-ledger' -File $node -Arguments @($capture, $state) -Seconds 30
}
$failure = $null
try {
    $profile = Join-Path $root 'profile'; $prefix = Join-Path $root 'npm'; $temp = Join-Path $root 'temp'
    if (Test-Path -LiteralPath $root) { throw 'Fresh proof root required.' }
    New-Item -ItemType Directory -Path @($root, $profile, $prefix, $temp) | Out-Null
    $env:USERPROFILE = $profile; $env:OPENCLAW_HOME = $profile
    $env:OPENCLAW_STATE_DIR = Join-Path $profile '.openclaw'
    $env:OPENCLAW_CONFIG_PATH = Join-Path $env:OPENCLAW_STATE_DIR 'openclaw.json'
    $env:APPDATA = Join-Path $profile 'AppData/Roaming'; $env:LOCALAPPDATA = Join-Path $profile 'AppData/Local'
    $env:NPM_CONFIG_PREFIX = $prefix; $env:TEMP = $temp; $env:TMP = $temp
    $env:OPENCLAW_GIT_DIR = $CandidateRoot; $env:OPENCLAW_UPDATE_DEV_TARGET_REF = $ExpectedHead
    $bin = Join-Path $profile '.local/bin'; $wrapper = Join-Path $bin 'openclaw.cmd'
    $env:Path = "$bin;$prefix;$($saved['Path'])"
    if ($ProofCase -eq 'all') {
        # This executes Main, actual pinned pnpm dependency installation/build, launcher publication and Doctor.
        Invoke-ProofInstaller -Name 'fresh-git-main' -Options @('-InstallMethod', 'git', '-GitDir', $CandidateRoot, '-NoGitUpdate')
        Assert-CandidateHead
        if (-not (Test-Path -LiteralPath $wrapper)) { throw 'Fresh installer did not publish the Git launcher.' }
        if ([IO.File]::ReadAllText($wrapper).IndexOf($CandidateRoot, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Fresh launcher targets another checkout.' }
        Invoke-ProofCommand -Name 'fresh-git-version' -File $engine -Arguments @('-NoProfile', '-Command', "& '$wrapper' --version") -Seconds 120
        $working = [Convert]::ToBase64String([IO.File]::ReadAllBytes($wrapper))
        $proof.cases += 'fresh Main/dependencies/build/Doctor/launcher passed'
        # A separate deliberately failing source fixture exercises real dependency/bootstrap and build failure.
        $fault = Join-Path $root 'failed-build'
        New-Item -ItemType Directory -Path $fault | Out-Null
        $pin = (Get-Content (Join-Path $CandidateRoot 'package.json') -Raw | ConvertFrom-Json).packageManager
        @{ name = 'openclaw'; version = '0.0.0'; private = $true; packageManager = $pin; scripts = @{ 'ui:build' = 'node -e process.exit(0)'; build = 'node -e process.exit(42)' } } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $fault 'package.json')
        & git -C $fault init --quiet
        if ($LASTEXITCODE -ne 0) { throw 'Fault fixture git init failed.' }
        & git -C $fault add package.json
        if ($LASTEXITCODE -ne 0) { throw 'Fault fixture staging failed.' }
        & git -C $fault -c user.name=InstallerProof -c user.email=installer@example.invalid -c commit.gpgsign=false commit --quiet -m 'Private build-failure fixture; never publish'
        if ($LASTEXITCODE -ne 0) { throw 'Fault fixture commit failed.' }
        Invoke-ProofInstaller -Name 'build-failure-main' -Options @('-InstallMethod', 'git', '-GitDir', $fault, '-NoGitUpdate') -ExpectFailure
        if ((Get-Content (Join-Path $EvidenceRoot 'build-failure-main.stdout.log') -Raw) -notmatch 'pnpm build failed for the Git checkout') { throw 'Fault case failed before reaching the real build; it does not prove rollback.' }
        if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($wrapper)) -cne $working) { throw 'Failed build changed the working launcher.' }
        Invoke-ProofCommand -Name 'post-failure-version' -File $engine -Arguments @('-NoProfile', '-Command', "& '$wrapper' --version") -Seconds 120
        $proof.cases += 'real failed-build Main preserved working launcher'
    }
    # Install the actual released driver, not a candidate CLI pretending to be the old version.
    # Supported installer local-tgz input; unchanged published2026.9.5 bytes.
    $releasePin = Get-Content -LiteralPath (Join-Path $ObserverRuntime 'release-pin.json') -Raw | ConvertFrom-Json
    $releaseArchive = Join-Path $root 'openclaw-2026.9.5.tgz'
    Invoke-WebRequest -Uri $releasePin.dist.tarball -OutFile $releaseArchive -TimeoutSec 120
    & (Join-Path $ObserverRuntime 'python.exe') '-E' '-S' '-B' (Join-Path $ObserverRuntime 'release.py') 'archive' '--target' $releaseArchive '--manifest' $ObserverManifest '--manifest-sha' $ObserverManifestSha256
    if ($LASTEXITCODE -ne 0) { throw 'Pinned release archive or member integrity failed before install.' }
    $proof.releaseArchiveSha256 = (Get-FileHash $releaseArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    Invoke-ProofInstaller -Name 'published-driver-install' -Options @('-InstallMethod', 'npm', '-Tag', $releaseArchive)
    & (Join-Path $ObserverRuntime 'python.exe') '-E' '-S' '-B' (Join-Path $ObserverRuntime 'release.py') 'installed' '--target' (Join-Path $prefix 'node_modules/openclaw') '--manifest' $ObserverManifest '--manifest-sha' $ObserverManifestSha256
    if ($LASTEXITCODE -ne 0) { throw 'Installed released bytes differ before gateway invocation.' }

    $driver = Join-Path $prefix 'node_modules/openclaw/openclaw.mjs'
    $driverPackage = Get-Content (Join-Path $prefix 'node_modules/openclaw/package.json') -Raw | ConvertFrom-Json
    if ($driverPackage.version -cne '2026.9.5') { throw 'Wrong published driver version.' }
    $proof.driverEntrySha256 = (Get-FileHash $driver -Algorithm SHA256).Hash.ToLowerInvariant()
    New-Item -ItemType Directory -Force -Path $env:OPENCLAW_STATE_DIR | Out-Null
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
    @{ gateway = @{ mode = 'local'; bind = 'loopback'; port = $port; auth = @{ mode = 'token'; token = [guid]::NewGuid().ToString('N') } }; plugins = @{ allow = @() } } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $env:OPENCLAW_CONFIG_PATH
    Start-ProofGateway -Entry $driver -Name 'published-gateway'
    # This Gateway is harness-owned, not a managed service. Stop and join it before
    # update/Doctor acquire exclusive lifecycle ownership; --no-restart does not
    # authorize concurrent repairs while an unmanaged Gateway owns the state.
    Stop-ProofGateway
    $proof.baselineGateway.stoppedBeforeUpdate = $true
    # CLI timeout is per step; this aggregate budget includes fetch, install, build,
    # Doctor and finalization, and remains below the workflow's 90-minute limit.
    if ($proof.unsettled -or -not $proof.baselineGateway.stoppedBeforeUpdate -or $proof.baselineGateway.status -cne 'TERMINAL') { throw 'Baseline must be settled before observer arming.' }
    $script:observationArmed=$true
    $observerRun = 'observer393-' + [guid]::NewGuid().ToString('N')
    $observerEvidence = Join-Path $EvidenceRoot $observerRun
    $observerSpec = Join-Path $EvidenceRoot 'observer-spec.json'
    $harnessProcess = Get-Process -Id $PID
    $spec = @{
        candidateHead = $ExpectedHead; candidateTree = 'd4bb6a0016a6aab695c9c6fe67b40c76f3d9ee6b'; workflowSourceSha = $env:PROOF_WORKFLOW_SHA; budgetSeconds = 3600
        harnessSourcePath = $PSCommandPath; proofRoot = $root; packageParent = (Join-Path $prefix 'node_modules')
        node = $node; nodeSha256 = (Get-FileHash $node -Algorithm SHA256).Hash.ToLowerInvariant()
        smokeResult = $ObserverSmokeResult; smokeSha256 = $ObserverSmokeSha256
        harness = @{ pid = $PID; created100ns = $harnessProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(); executable = $harnessProcess.Path }
    }
    $spec.deadlineFiletime100ns = [DateTime]::UtcNow.AddSeconds(3600).ToFileTimeUtc().ToString()
    $outerClock = [Diagnostics.Stopwatch]::StartNew()
    $spec | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $observerSpec -Encoding utf8NoBOM
    # ArgumentList preserves separate argv. Never invoke shell text or the killing wrapper.
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = Join-Path $ObserverRuntime 'python.exe'
    $psi.UseShellExecute = $false
    $psi.WorkingDirectory = $ObserverRuntime
    foreach ($arg in @('-E','-S','-B',(Join-Path $ObserverRuntime 'run.py'),'diagnostic',
        '--manifest',$ObserverManifest,'--manifest-sha',$ObserverManifestSha256,
        '--spec',$observerSpec,'--evidence',$observerEvidence,'--run',$observerRun)) { $psi.ArgumentList.Add($arg) }
    $diag = [Diagnostics.Process]::Start($psi)
    $proof.diagnostic = @{ namespace = $observerEvidence; pid = $diag.Id; created100ns = $diag.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(); executable = $psi.FileName; nativeAcceptance = $false }
    # The outer deadline also starts at launch; no unbounded WaitForExit/kill fallback.
    $joined = $diag.WaitForExit([Math]::Max(0, 3600000 - [int]$outerClock.ElapsedMilliseconds))
    $proof.diagnostic.exited = $joined
    $proof.diagnostic.exitCode = if ($joined) { $diag.ExitCode } else { $null }
    $proof.diagnostic.unsettled = -not $joined
    $diag.Dispose()
    $proof.result = 'diagnostic-only'
    if (-not $joined) { throw 'Observer composition UNSETTLED; preserve proof root and exact process identity.' }
    if ($proof.diagnostic.exitCode -ne 0) { throw 'Observer composition denied/failed; no replay.' }

} catch { $failure = $_; $proof.error = $_.Exception.Message } finally {
    $cleanupErrors = @()
    # No lifecycle action in finally, including before arm: retain on any uncertain setup.
    if ($script:gateway) { $proof.unsettled=$true; $proof.baselineRetained=$true }
    # The child is joined and the Gateway is stopped before read-only diagnostic capture.
    # Capture failure must never replace the original acceptance error or skip cleanup.
    # Do not launch ledger/product code after an unsettled update. Original on-disk ledger retained.
    $proof.updateLedgerCapture = 'not invoked; retained original proof root for read-only follow-up'
    try {
        [Environment]::SetEnvironmentVariable('Path', $userPath, 'User')
        if ([Environment]::GetEnvironmentVariable('Path', 'User') -cne $userPath) { throw 'User PATH restoration mismatch.' }
    } catch { $cleanupErrors += $_.Exception.Message }
    foreach ($name in $names) {
        try {
            if ($null -eq $saved[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue } else { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
            if ([Environment]::GetEnvironmentVariable($name, 'Process') -cne $saved[$name]) { throw "$name restoration mismatch." }
        } catch { $cleanupErrors += $_.Exception.Message }
    }
    # No deletion may race an unsettled observer/update. Canonical owns later custody cleanup.
    $proof.retainedProofRoot = $root
    $proof.cleanup = if ($cleanupErrors.Count) { 'failed-retained' } else { 'environment-restored-root-retained' }
    $proof.cleanupErrors = $cleanupErrors
    if ($cleanupErrors.Count) { $proof.result = 'failed' }
    $proof | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $EvidenceRoot 'result.json')
}
if ($failure) { throw $failure }
if ($proof.result -ne 'diagnostic-only') { throw 'Diagnostic composition failed.' }
