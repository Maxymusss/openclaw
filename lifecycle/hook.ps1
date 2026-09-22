[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedWorkflowSha,
      [Parameter(Mandatory=$true)][string]$CandidateRoot)
$ErrorActionPreference='Stop'
# Source-only derivative: future execution requires a separate canonical decision.
$bundleSha = '1df534a9cfa40ab9f98184e37913b5087e46ea85427d31f36bfe1c03438e4ca4'
$stageSha = '9de10bfd6e8cc9c498e9d8f54eec36f4e8aa3a9836f77f98054b6d11e1c0e461'
if ((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'stage.ps1') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $stageSha) { throw 'Wrong installed-state stage source.' }
Set-StrictMode -Version Latest
$owned=Join-Path $env:RUNNER_TEMP ('observer393-product-'+$env:GITHUB_RUN_ID+'-'+$env:GITHUB_RUN_ATTEMPT)
$evidence=Join-Path $owned 'evidence'
$receipt=[ordered]@{schema=1;status='NOT_STARTED';workflowSha=$ExpectedWorkflowSha;run=$env:GITHUB_RUN_ID;attempt=$env:GITHUB_RUN_ATTEMPT;productAttempted=$false;historicalHolder='UNKNOWN';nativeAcceptance=$false;runnerDisposal='not process settlement proof'}
$failure=$null
try {
    # stage throws on every failed host/payload/parse/control/same-job-smoke gate.
    & (Join-Path $PSScriptRoot 'stage.ps1') -ExpectedWorkflowSha $ExpectedWorkflowSha
    $stage=Get-Content -LiteralPath (Join-Path $evidence 'hosted-result.json') -Raw | ConvertFrom-Json
    if ($stage.status -cne 'INERT_SMOKE_QUALIFIED' -or $stage.workflowSha -cne $ExpectedWorkflowSha -or $stage.bundleSha256 -cne $bundleSha) { throw 'Unqualified same-job stage.' }
    $receipt.stage='PASSED'
    $pin=Get-Content -LiteralPath (Join-Path $stage.next.runtime 'node-pin.json') -Raw | ConvertFrom-Json
    $node=Join-Path $env:RUNNER_TOOL_CACHE $pin.relativeToolCachePath
    if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.exeSha256) { throw 'Wrong native Node executable; no substitution.' }
    # Executing pinned Node for its own runtime inventory is not a product invocation.
    $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$node;$psi.UseShellExecute=$false;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
    $psi.ArgumentList.Add('-p');$psi.ArgumentList.Add('JSON.stringify({version:process.version,arch:process.arch,platform:process.platform,abi:process.versions.modules,exe:process.execPath})')
    $n=[Diagnostics.Process]::Start($psi);$clock=[Diagnostics.Stopwatch]::StartNew()
    $nt=$n.StandardOutput.ReadToEndAsync();$et=$n.StandardError.ReadToEndAsync()
    $receipt.node=@{pid=$n.Id;created100ns=$n.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();executable=$node;sha256=$pin.exeSha256}
    if (-not $n.WaitForExit(5000)) { throw 'Node inventory UNSETTLED; no kill or product fall-through.' }
    foreach($task in @($nt,$et)) { if(-not $task.Wait([math]::Max(0,5000-[int]$clock.ElapsedMilliseconds))){throw 'Node inventory pipe UNSETTLED.'} }
    $receipt.node.stdout=$nt.Result;$receipt.node.stderr=$et.Result;$receipt.node.exitCode=$n.ExitCode;$receipt.node.exited100ns=$n.ExitTime.ToUniversalTime().ToFileTimeUtc().ToString()
    if ($n.ExitCode -ne 0) { throw 'Node inventory failed.' }
    $v=$nt.Result|ConvertFrom-Json
    if($v.version -cne $pin.version -or $v.abi -cne $pin.abi -or $v.platform -cne $pin.platform -or $v.arch -cne $pin.arch -or $v.exe -ine $node){throw 'Node version/native ABI/path mismatch.'}
    $n.Dispose()
    $CandidateRoot=[IO.Path]::GetFullPath($CandidateRoot)
    $head=(& git -C $CandidateRoot rev-parse HEAD).Trim()
    if($LASTEXITCODE -ne 0 -or $head -cne '393c80255dea6605a5665c6e0836d01fb6d18304'){throw 'Wrong candidate.'}
    $tree=(& git -C $CandidateRoot rev-parse 'HEAD^{tree}').Trim()
    if($LASTEXITCODE -ne 0 -or $tree -cne 'd4bb6a0016a6aab695c9c6fe67b40c76f3d9ee6b'){throw 'Wrong candidate tree.'}
    $dirty=@(& git -C $CandidateRoot status --porcelain=v1 --untracked-files=all)
    if($LASTEXITCODE -ne 0 -or $dirty.Count){throw 'Candidate not clean.'}
    $receipt.candidate=@{root=$CandidateRoot;head=$head;tree=$tree}
    $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($owned))
    # Same-volume host job fit: up to8GiB dependency/build growth, release+runtime+outputs <2GiB,
    # plus2GiB observed setup variation. Not a local fleet reserve or observer output cap.
    $receipt.capacity=@{freeBytes=$drive.AvailableFreeSpace;estimatedAdditionalBytes=12884901888;logicalObserverCapBytes=536870912;localClaimBytes=536870912}
    if($drive.AvailableFreeSpace -lt $receipt.capacity.estimatedAdditionalBytes){throw 'Insufficient actual disposable-host fit.'}
    $env:PATH=([IO.Path]::GetDirectoryName($node))+[IO.Path]::PathSeparator+$env:PATH
    $receipt.productAttempted=$true;$receipt.status='PRODUCT_DIAGNOSTIC_STARTED'
    $receipt | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $evidence 'product-admission.json')
    & (Join-Path $stage.next.runtime 'diagnostic.ps1') -CandidateRoot $CandidateRoot -ExpectedHead $head -EvidenceRoot $stage.next.diagnosticEvidence -ProofCase 'published-driver' -ObserverRuntime $stage.next.runtime -ObserverManifest $stage.next.manifest -ObserverManifestSha256 $stage.next.manifestSha256 -ObserverSmokeResult $stage.next.smokeResult -ObserverSmokeSha256 $stage.next.smokeSha256
    $receipt.status='DIAGNOSTIC_RETURNED';$receipt.productAcceptance=$false
} catch {$failure=$_;$receipt.status='FAILED';$receipt.error=$_.Exception.Message} finally {
    # Never delete proof roots or terminate unsettled processes here. Upload precedes custody disposition.
    if(Test-Path -LiteralPath $evidence){$receipt|ConvertTo-Json -Depth 15|Set-Content -LiteralPath (Join-Path $evidence 'hook-result.json')}
    Write-Output ('PASSIVE_DIAGNOSTIC_RESULT '+($receipt|ConvertTo-Json -Depth 15 -Compress))
}
if($failure){throw $failure}
