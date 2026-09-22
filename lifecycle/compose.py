"""Offline exact-source transformer. Does not invoke PowerShell or Windows."""
import argparse
import hashlib
import json
from pathlib import Path


def one(text, old, new):
    if text.count(old) != 1: raise ValueError('supported source seam changed')
    return text.replace(old,new,1)


def compose(source):
    text=source
    text=one(text,"    [ValidateSet('all', 'published-driver')][string]$ProofCase = 'all'",
'''    [ValidateSet('published-driver')][string]$ProofCase = 'published-driver',
    [Parameter(Mandatory = $true)][string]$ObserverRuntime,
    [Parameter(Mandatory = $true)][string]$ObserverManifest,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ObserverManifestSha256,
    [Parameter(Mandatory = $true)][string]$ObserverSmokeResult,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ObserverSmokeSha256''')
    text=one(text,"$ErrorActionPreference = 'Stop'",'''$ErrorActionPreference = 'Stop'
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
if ($LASTEXITCODE -ne 0) { throw 'Same-host/run/bundle raw positive smoke required before product setup.' }''')
    text=one(text,"$head -cne $ExpectedHead -or $env:PROOF_WORKFLOW_SHA -cne $ExpectedHead",
        "$head -cne $ExpectedHead -or $ExpectedHead -cne '393c80255dea6605a5665c6e0836d01fb6d18304' -or $env:PROOF_WORKFLOW_SHA -cne $env:GITHUB_SHA -or $env:GITHUB_SHA -cnotmatch '^[0-9a-f]{40}$'")
    text=one(text,"$dirty = @(& git -C $CandidateRoot status", "if ((& git -C $CandidateRoot rev-parse 'HEAD^{tree}').Trim() -cne 'd4bb6a0016a6aab695c9c6fe67b40c76f3d9ee6b' -or $LASTEXITCODE -ne 0) { throw 'Wrong candidate tree.' }\n$dirty = @(& git -C $CandidateRoot status")
    text=one(text,"New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null",'''# Diagnostic source derivative: never an acceptance result; NEW external namespace only.
if (Test-Path -LiteralPath $EvidenceRoot) { throw 'Diagnostic evidence namespace already exists.' }
New-Item -ItemType Directory -Path $EvidenceRoot | Out-Null''')
    text=one(text,"    Invoke-ProofInstaller -Name 'published-driver-install' -Options @('-InstallMethod', 'npm', '-Tag', '2026.9.5')",
'''    # Supported installer local-tgz input; unchanged published2026.9.5 bytes.
    $releasePin = Get-Content -LiteralPath (Join-Path $ObserverRuntime 'release-pin.json') -Raw | ConvertFrom-Json
    $releaseArchive = Join-Path $root 'openclaw-2026.9.5.tgz'
    Invoke-WebRequest -Uri $releasePin.dist.tarball -OutFile $releaseArchive -TimeoutSec 120
    & (Join-Path $ObserverRuntime 'python.exe') '-E' '-S' '-B' (Join-Path $ObserverRuntime 'release.py') 'archive' '--target' $releaseArchive '--manifest' $ObserverManifest '--manifest-sha' $ObserverManifestSha256
    if ($LASTEXITCODE -ne 0) { throw 'Pinned release archive or member integrity failed before install.' }
    $proof.releaseArchiveSha256 = (Get-FileHash $releaseArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    Invoke-ProofInstaller -Name 'published-driver-install' -Options @('-InstallMethod', 'npm', '-Tag', $releaseArchive)
    # This gate is in the same setup, not inferred from marker absence or exit alone.
    if ($proof.unsettled -or $proof.commands.Count -ne 1) { throw 'Single settled installer required before installed-state verification.' }
    $installedRoot=[IO.Path]::GetFullPath((Join-Path $prefix 'node_modules/openclaw'))
    $installSetup=Join-Path $EvidenceRoot 'release-install-setup.json'
    if (Test-Path -LiteralPath $installSetup) { throw 'Fresh install setup receipt required.' }
    @{ schema=1; archiveVerified=$true; archiveSha256=$proof.releaseArchiveSha256; target=$installedRoot;
       unsettled=$proof.unsettled; command=$proof.commands[0] } | ConvertTo-Json -Depth 15 | ForEach-Object {
        [IO.File]::WriteAllText($installSetup, $_, [Text.UTF8Encoding]::new($false))
    }
    $installSetupSha=(Get-FileHash -LiteralPath $installSetup -Algorithm SHA256).Hash.ToLowerInvariant()
    & (Join-Path $ObserverRuntime 'python.exe') '-E' '-S' '-B' (Join-Path $ObserverRuntime 'release.py') 'installed' '--target' $installedRoot '--manifest' $ObserverManifest '--manifest-sha' $ObserverManifestSha256 '--setup' $installSetup '--setup-sha' $installSetupSha
    if ($LASTEXITCODE -ne 0) { throw 'Released installed-state contract failed before gateway invocation.' }
    $proof.installedState=@{ setup=$installSetup; setupSha256=$installSetupSha; pendingMarker='ABSENT'; unchangedPinnedMembers=11427; nativeAcceptance=$false }
''')
    seam="    Invoke-ProofCommand -Name 'published-driver-update' -File $node -Arguments @($driver, 'update', '--channel', 'dev', '--yes', '--json', '--no-restart', '--timeout', '1200') -Seconds 3600"
    hook='''    $observerRun = 'observer393-' + [guid]::NewGuid().ToString('N')
    $observerEvidence = Join-Path $EvidenceRoot $observerRun
    $observerSpec = Join-Path $EvidenceRoot 'observer-spec.json'
    $harnessProcess = Get-Process -Id $PID
    $spec = @{
        candidateHead = $ExpectedHead; candidateTree = 'd4bb6a0016a6aab695c9c6fe67b40c76f3d9ee6b'; workflowSourceSha = $env:PROOF_WORKFLOW_SHA; budgetSeconds = 3600
        harnessSourcePath = $PSCommandPath; proofRoot = $root; packageParent = (Join-Path $prefix 'node_modules')
        node = $node; nodeSha256 = (Get-FileHash $node -Algorithm SHA256).Hash.ToLowerInvariant()
        smokeResult = $ObserverSmokeResult; smokeSha256 = $ObserverSmokeSha256
        installedSetupPath = $installSetup; installedSetupSha256 = $installSetupSha
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
'''
    text=one(text,seam,hook)
    # Diagnostic stops here. No candidate Doctor/Gateway probes or acceptance claim.
    start=text.index('    Assert-CandidateHead',text.index(hook)+len(hook))
    end=text.index("} catch { $failure",start)
    text=text[:start]+text[end:]
    text=one(text,"    if ($failure) {\n        try { Save-ProofUpdateLedger } catch { $proof.updateLedgerCaptureError = $_.Exception.Message }\n    }",
'''    # Do not launch ledger/product code after an unsettled update. Original on-disk ledger retained.
    $proof.updateLedgerCapture = 'not invoked; retained original proof root for read-only follow-up' ''')
    text=one(text,"    try { Remove-Item -LiteralPath $root -Recurse -Force; if (Test-Path -LiteralPath $root) { throw 'Owned proof root survived cleanup.' } } catch { $cleanupErrors += $_.Exception.Message }",
'''    # No deletion may race an unsettled observer/update. Canonical owns later custody cleanup.
    $proof.retainedProofRoot = $root''')
    text=one(text,"$proof.cleanup = if ($cleanupErrors.Count) { 'failed' } else { 'restored-and-removed' }",
                  "$proof.cleanup = if ($cleanupErrors.Count) { 'failed-retained' } else { 'environment-restored-root-retained' }")
    text=one(text,"if ($proof.result -ne 'passed') { throw 'Installer proof cleanup failed.' }",
                  "if ($proof.result -ne 'diagnostic-only') { throw 'Diagnostic composition failed.' }")
    # Lifecycle-only derivative. Original upstream and prior bundle stay immutable.
    begin=text.index('function Invoke-ProofCommand {')
    end=text.index('function Invoke-ProofInstaller {',begin)
    text=text[:begin]+". (Join-Path $ObserverRuntime 'lifecycle.ps1')\nInitialize-ProofNative\n$script:observationArmed=$false\n$script:retainedProcesses=@()\n$proof.unsettled=$false\n"+text[end:]
    begin=text.index('function Start-ProofGateway {')
    end=text.index('function Save-ProofUpdateLedger {',begin)
    text=text[:begin]+text[end:]
    text=one(text,"    $proof.baselineGateway = @{ pid = $gateway.Id; healthyBeforeMaintenance = $true }\n",'')
    text=one(text,"    $observerRun = 'observer393-'", "    if ($proof.unsettled -or -not $proof.baselineGateway.stoppedBeforeUpdate -or $proof.baselineGateway.status -cne 'TERMINAL') { throw 'Baseline must be settled before observer arming.' }\n    $script:observationArmed=$true\n    $observerRun = 'observer393-'")
    text=one(text,"    try { Stop-ProofGateway } catch { $cleanupErrors += $_.Exception.Message }", "    # No lifecycle action in finally, including before arm: retain on any uncertain setup.\n    if ($script:gateway) { $proof.unsettled=$true; $proof.baselineRetained=$true }")
    text=one(text,"    New-Item -ItemType Directory -Path @($root, $profile, $prefix, $temp) -Force | Out-Null", "    if (Test-Path -LiteralPath $root) { throw 'Fresh proof root required.' }\n    New-Item -ItemType Directory -Path @($root, $profile, $prefix, $temp) | Out-Null")
    text=one(text,"$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source", """$nodePin=Get-Content -LiteralPath (Join-Path $ObserverRuntime 'node-pin.json') -Raw | ConvertFrom-Json
$node = Join-Path $env:RUNNER_TOOL_CACHE $nodePin.relativeToolCachePath
if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -cne $nodePin.exeSha256) { throw 'Pinned Node changed before setup.' }
if ((Get-Command node -CommandType Application | Select-Object -First 1).Source -ine $node) { throw 'Installer Node path differs from the admitted native runtime.' }""")
    return '\n'.join(line.rstrip() for line in text.splitlines())+'\n'


def main():
    p=argparse.ArgumentParser(); p.add_argument('--source',required=True); p.add_argument('--sha256',required=True); p.add_argument('--output',required=True)
    a=p.parse_args(); raw=Path(a.source).read_bytes()
    if hashlib.sha256(raw).hexdigest()!=a.sha256: raise ValueError('unsealed upstream harness')
    with Path(a.output).open('x',encoding='utf-8',newline='\n') as f: f.write(compose(raw.decode()))


if __name__=='__main__': main()
