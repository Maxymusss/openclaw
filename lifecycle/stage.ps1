[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedWorkflowSha)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$bundleSha = 'bb847844486fe79442af78a3dce6cdd3a3624ed0828c645c28a4afd2acbaa94f'
$candidate = '393c80255dea6605a5665c6e0836d01fb6d18304'
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Save([string]$Path, $Value) {
    if (Test-Path -LiteralPath $Path) { throw 'Evidence path already exists.' }
    [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 30) + "`n"), [Text.UTF8Encoding]::new($false))
}
# Whitelisted read-only host inventory is retained in the job log even if admission fails.
# No environment dump, source mutation, runtime staging or product setup precedes the guard.
$inventory = [ordered]@{ schema=1; record='preflight-inventory';
    runnerEnvironment=$env:RUNNER_ENVIRONMENT; runnerOS=$env:RUNNER_OS; runnerArch=$env:RUNNER_ARCH;
    imageOS=$env:ImageOS; imageVersion=$env:ImageVersion; run=$env:GITHUB_RUN_ID; attempt=$env:GITHUB_RUN_ATTEMPT;
    workflowSha=$env:PROOF_WORKFLOW_SHA; githubSha=$env:GITHUB_SHA; workflowRef=$env:GITHUB_REF;
    powershellVersion=$PSVersionTable.PSVersion.ToString(); powershellMajor=$PSVersionTable.PSVersion.Major;
    processArchitecture=[Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString();
    osArchitecture=[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString();
    osVersion=[Environment]::OSVersion.VersionString; processId=$PID;
    created100ns=(Get-Process -Id $PID).StartTime.ToUniversalTime().ToFileTimeUtc().ToString();
    executable=(Get-Process -Id $PID).Path; runnerTemp=$env:RUNNER_TEMP; workspace=$env:GITHUB_WORKSPACE;
    bundleSha256=$bundleSha; candidate=$candidate; stageSha256=(Hash $PSCommandPath) }
$inventory.executableSha256=Hash $inventory.executable
Write-Output ('OBSERVER_PREFLIGHT ' + ($inventory | ConvertTo-Json -Depth 5 -Compress))
if ($env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ARCH -cne 'X64' -or
    $env:ImageOS -cne 'win25-vs2026' -or $env:ImageVersion -cne '20260907.229.1' -or $PSVersionTable.PSVersion.ToString() -cne '7.6.5' -or $inventory.executableSha256 -cne '362a356ce7f0940ec74f73a8fc2c990a2cc24a38a11c90bbd8eca947110ad139' -or $PSVersionTable.PSVersion.Major -ne 7 -or
    [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString() -cne 'X64') { throw 'Requires native-x64 hosted windows-2025 / PowerShell7.' }
if ($env:GITHUB_RUN_ID -cnotmatch '^[1-9][0-9]*$' -or $env:GITHUB_RUN_ATTEMPT -cne '1' -or
    $env:GITHUB_SHA -cnotmatch '^[0-9a-f]{40}$' -or $env:PROOF_WORKFLOW_SHA -cne $env:GITHUB_SHA -or
    $env:GITHUB_SHA -cne $ExpectedWorkflowSha -or $env:GITHUB_RUN_ID -in @('35529432478','35596476995')) { throw 'Requires fresh exact smoke-only workflow; no reruns.' }
foreach ($name in @('NODE_OPTIONS','NODE_PATH','PYTHONSTARTUP','COR_ENABLE_PROFILING','CORECLR_ENABLE_PROFILING')) {
    if ([Environment]::GetEnvironmentVariable($name, 'Process')) { throw 'Unqualified preload/profiler environment.' }
}
$sourceHead = $ExpectedWorkflowSha
$namespace = 'observer393-product-' + $env:GITHUB_RUN_ID + '-' + $env:GITHUB_RUN_ATTEMPT
$owned = Join-Path $env:RUNNER_TEMP $namespace
$runtime = Join-Path $owned 'runtime'
$evidence = Join-Path $owned 'evidence'
if ((Test-Path -LiteralPath $owned) -or (Test-Path -LiteralPath $evidence)) { throw 'Fresh namespace required.' }
# Actual fit for this small standalone fixture, not a fleet reserve threshold.
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($owned))
if ($drive.AvailableFreeSpace -lt 134217728) { throw 'Cannot fit 128MiB fixture/runtime/evidence estimate.' }
New-Item -ItemType Directory -Path $owned,$runtime,$evidence | Out-Null
$proof = [ordered]@{ schema=1; status='FAILED'; candidate=$candidate; bundleSha256=$bundleSha;
    namespace=$namespace; workflowSha=$sourceHead; workflowRef=$env:GITHUB_REF; run=$env:GITHUB_RUN_ID;
    attempt=$env:GITHUB_RUN_ATTEMPT; imageOS=$env:ImageOS; imageVersion=$env:ImageVersion;
    runnerName=$env:RUNNER_NAME; runnerTemp=$env:RUNNER_TEMP; workspace=$env:GITHUB_WORKSPACE;
    osVersion=[Environment]::OSVersion.VersionString; osArchitecture=[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString();
    pwshPath=(Get-Process -Id $PID).Path; pwshVersion=$PSVersionTable.PSVersion.ToString();
    stageSha256=(Hash $PSCommandPath); expectedWorkflowSha=$ExpectedWorkflowSha;
    freeBytesBefore=$drive.AvailableFreeSpace; smokeDeadlineSeconds=25; productInvocations=0;
    historicalHolder='UNKNOWN'; productAcceptance=$false; cleanup='pending' }
$proof.pwshSha256 = Hash $proof.pwshPath
$launched = $false; $safeCleanup = $true; $child = $null
try {
    $payload = $PSScriptRoot
    $manifestPath = Join-Path $payload 'bundle.json'
    if ((Hash $manifestPath) -cne $bundleSha) { throw 'Unreviewed bundle.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -AsHashtable
    foreach ($name in $manifest.payload.Keys) {
        if ($name -notmatch '^[A-Za-z0-9_.-]+$' -or $name -in @('.','..')) { throw 'Non-flat payload.' }
        if ((Hash (Join-Path $payload $name)) -cne $manifest.payload[$name]) { throw 'Payload mismatch.' }
        Copy-Item -LiteralPath (Join-Path $payload $name) -Destination (Join-Path $runtime $name)
    }
    Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $runtime 'bundle.json')
    $releaseManifest=Join-Path $payload 'release-installed.json'
    if ((Hash $releaseManifest) -cne $manifest.releaseInstalledManifestSha256) { throw 'Wrong installed release manifest.' }
    Copy-Item -LiteralPath $releaseManifest -Destination (Join-Path $runtime 'release-installed.json')
    $pin = Get-Content -LiteralPath (Join-Path $runtime 'python-pin.json') -Raw | ConvertFrom-Json -AsHashtable
    $archive = Join-Path $owned 'python.zip'
    Invoke-WebRequest -Uri $pin.url -OutFile $archive -TimeoutSec 60
    if ((Get-Item -LiteralPath $archive).Length -ne $pin.bytes -or (Hash $archive) -cne $pin.archiveSha256) { throw 'Python archive differs from pin.' }
    Expand-Archive -LiteralPath $archive -DestinationPath $runtime
    foreach ($name in $pin.members.Keys) {
        if ($name -notmatch '^[A-Za-z0-9_.-]+$' -or $name -in @('.','..')) { throw 'Non-flat Python member.' }
        if ((Hash (Join-Path $runtime $name)) -cne $pin.members[$name]) { throw 'Python member mismatch.' }
    }
    $python = Join-Path $runtime 'python.exe'
    $proof.pythonPath=$python; $proof.pythonSha256=Hash $python; $proof.pythonArchiveSha256=Hash $archive
    Remove-Item -LiteralPath $archive
    # Parse the sealed product diagnostic WITHOUT executing any statement in it.
    $tokens=$null; $parseErrors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $runtime 'diagnostic.ps1'), [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -ne 0 -or $null -eq $ast.ParamBlock) { throw 'Diagnostic PowerShell parse failed.' }
    # Exercise the actual parameter declarations only. Never GetScriptBlock() on the full AST.
    $binder=[scriptblock]::Create('[CmdletBinding()]' + "`n" + $ast.ParamBlock.Extent.Text + "`n" + 'return $PSBoundParameters')
    $arguments=@{ CandidateRoot=(Join-Path $owned 'uncreated candidate path'); ExpectedHead=$candidate;
        EvidenceRoot=(Join-Path $owned 'uncreated diagnostic path'); ProofCase='published-driver';
        ObserverRuntime=$runtime; ObserverManifest=(Join-Path $runtime 'bundle.json'); ObserverManifestSha256=$bundleSha;
        ObserverSmokeResult=(Join-Path $evidence 'smoke/result.json'); ObserverSmokeSha256=('0'*64) }
    $bound=& $binder @arguments
    foreach ($key in $arguments.Keys) { if ($bound[$key] -cne $arguments[$key]) { throw 'Parameter binding changed argument.' } }
    $badArguments=$arguments.Clone(); $badArguments.ExpectedHead='not-a-sha'; $rejected=$false
    try { $null=& $binder @badArguments } catch [Management.Automation.ParameterBindingException] { $rejected=$true }
    if (-not $rejected) { throw 'Invalid argument was accepted.' }
    Save (Join-Path $evidence 'powershell.json') @{ parseErrors=@(); diagnosticSha256=(Hash (Join-Path $runtime 'diagnostic.ps1')); bound=$bound; invalidHeadRejected=$rejected; bodyExecuted=$false; binderSource=$binder.ToString() }
    # Parse and compile the lifecycle helper, then exercise its mocked refusal/settlement controls.
    $lt=$null; $le=$null
    $null=[Management.Automation.Language.Parser]::ParseFile((Join-Path $runtime 'lifecycle.ps1'),[ref]$lt,[ref]$le)
    if ($le.Count) { throw 'Lifecycle PowerShell parse failed.' }
    . (Join-Path $runtime 'lifecycle.ps1')
    Initialize-ProofNative
    & $proof.pwshPath -NoLogo -NoProfile -File (Join-Path $runtime 'test_lifecycle.ps1') *> (Join-Path $evidence 'lifecycle-controls.json')
    if ($LASTEXITCODE -ne 0) { throw 'Lifecycle affected controls failed on native PowerShell.' }
    $proof.lifecycle=@{parsed=$true;compiled=$true;mockedControlsPassed=$true;actualBaselineExecuted=$false}
    $smokeRoot=Join-Path $evidence 'smoke'
    $argv=@('-E','-S','-B',(Join-Path $runtime 'run.py'),'smoke','--manifest',(Join-Path $runtime 'bundle.json'),'--manifest-sha',$bundleSha,'--evidence',$smokeRoot,'--run',($namespace + '-smoke'))
    $psi=[Diagnostics.ProcessStartInfo]::new()
    $psi.FileName=$python; $psi.WorkingDirectory=$runtime; $psi.UseShellExecute=$false
    $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true; $psi.RedirectStandardInput=$true
    foreach ($arg in $argv) { $psi.ArgumentList.Add($arg) }
    $proof.argv=@($python)+$argv
    Save (Join-Path $evidence 'launch-binding.json') $proof
    $child=[Diagnostics.Process]::new(); $child.StartInfo=$psi
    $timer=[Diagnostics.Stopwatch]::StartNew()
    if (-not $child.Start()) { throw 'Smoke controller failed to start.' }
    $launched=$true; $safeCleanup=$false; $child.StandardInput.Close()
    $proof.controller=@{ pid=$child.Id; created100ns=$child.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(); executable=$child.MainModule.FileName }
    $stdout=[IO.File]::Open((Join-Path $evidence 'controller.stdout.log'),[IO.FileMode]::CreateNew)
    $stderr=[IO.File]::Open((Join-Path $evidence 'controller.stderr.log'),[IO.FileMode]::CreateNew)
    $outTask=$child.StandardOutput.BaseStream.CopyToAsync($stdout); $errTask=$child.StandardError.BaseStream.CopyToAsync($stderr)
    if (-not $child.WaitForExit([math]::Max(0,25000-[int]$timer.ElapsedMilliseconds))) { throw 'Smoke controller unsettled at 25s; no kill or retry.' }
    foreach ($task in @($outTask,$errTask)) {
        if (-not $task.Wait([math]::Max(0,25000-[int]$timer.ElapsedMilliseconds))) { throw 'Smoke output pipe UNSETTLED at original deadline; no kill.' }
        $task.GetAwaiter().GetResult() # Already completed, never an unbounded join.
    }
    $stdout.Dispose(); $stderr.Dispose()
    $proof.controller.exitCode=$child.ExitCode; $proof.controller.exited100ns=$child.ExitTime.ToUniversalTime().ToFileTimeUtc().ToString()
    $proof.controller.elapsedMilliseconds=$timer.ElapsedMilliseconds
    $resultPath=Join-Path $smokeRoot 'result.json'
    $result=Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    $safeCleanup=($result.allExited -eq $true)
    $proof.resultSha256=Hash $resultPath
    if ($child.ExitCode -ne 0 -or $result.status -cne 'SMOKE_PASSED' -or -not $safeCleanup -or
        $result.manifestSha256 -cne $bundleSha -or $result.host.run -cne $env:GITHUB_RUN_ID -or
        $result.host.attempt -cne $env:GITHUB_RUN_ATTEMPT -or $result.host.imageVersion -cne $env:ImageVersion) { throw 'Positive inert smoke not qualified.' }
    # Preflight performs the SAME raw-proof admission used before diagnostic setup.
    & $python '-E' '-S' '-B' (Join-Path $runtime 'run.py') 'preflight' '--manifest' (Join-Path $runtime 'bundle.json') '--manifest-sha' $bundleSha '--evidence' $evidence '--run' ($namespace + '-preflight') '--smoke-result' $resultPath '--smoke-sha' $proof.resultSha256
    if ($LASTEXITCODE -ne 0) { throw 'Raw bound positive smoke preflight failed.' }
    $proof.status='INERT_SMOKE_QUALIFIED'
    $proof.next=@{ runtime=$runtime; manifest=(Join-Path $runtime 'bundle.json'); manifestSha256=$bundleSha; smokeResult=$resultPath; smokeSha256=$proof.resultSha256; diagnosticEvidence=(Join-Path $evidence 'diagnostic') }
    # No product fall-through: return staging tuple only. A separately admitted caller invokes diagnostic.ps1.
} catch {
    $proof.error=$_.Exception.Message
} finally {
    if ($safeCleanup) {
        $fixture=Join-Path $evidence 'smoke/fixture'
        if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
        if (Test-Path -LiteralPath $fixture) { throw 'Owned fixture cleanup incomplete.' }
        $proof.cleanup='fixture-removed-runtime-retained-for-same-job-admitted-diagnostic'
        $proof.retainedPath=$owned
    } else { $proof.cleanup='retained-unsettled-no-kill'; $proof.retainedPath=$owned }
    $proof.freeBytesAfter=$drive.AvailableFreeSpace
    Save (Join-Path $evidence 'hosted-result.json') $proof
}
if ($proof.status -cne 'INERT_SMOKE_QUALIFIED') { throw 'Staging or fresh inert observer qualification failed. No product was invoked; retain raw evidence and runtime for disposition.' }
