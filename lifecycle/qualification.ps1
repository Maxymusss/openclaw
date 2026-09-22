[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$CandidateRoot,[Parameter(Mandatory=$true)][string]$EvidenceRoot)
$ErrorActionPreference='Stop'
if($env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1){throw 'Fresh hosted Windows PowerShell 5.1 required.'}
. (Join-Path $PSScriptRoot 'qualification-isolation.ps1')
$root=Join-Path $env:RUNNER_TEMP ('qualification125286-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root|Out-Null
New-Item -ItemType Directory -Force -Path $EvidenceRoot|Out-Null
$savedStore=$env:OPENCLAW_QUALIFICATION_HANDOFF_DB
$savedTmp=$env:TMPDIR
$savedTemp=$env:TEMP
$savedTmpWin=$env:TMP
$result=@{result='failed';engine=$PSVersionTable.PSVersion.ToString();runId=$env:GITHUB_RUN_ID;workflow=$env:GITHUB_SHA;cleanup='pending'}
$failure=$null
try {
    $env:OPENCLAW_QUALIFICATION_HANDOFF_DB=Join-Path $root 'handoff.sqlite'
    $store=Assert-QualificationStore -Path $env:OPENCLAW_QUALIFICATION_HANDOFF_DB
    $env:TMPDIR=$root;$env:TEMP=$root;$env:TMP=$root
    $result.handoffStore=$store
    $result.handoffStoreUse='Reserved explicit path, no OpenClaw executor is invoked. Synthetic marker tests and real Node-only installer functions cannot open product handoff store.'
    $tokens=$null;$errors=$null
    foreach($file in @('diagnostic.ps1','test_installed_setup.ps1','prove-portable-node-recovery.ps1','qualification-isolation.ps1','qualification.ps1')){
        [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file),[ref]$tokens,[ref]$errors)|Out-Null
        if($errors.Count){throw ('PowerShell 5.1 parse failure: '+$file+': '+($errors -join ';'))}
    }
    $result.parse='passed'
    $python=(& py -3.13 -c 'import sys; print(sys.executable)').Trim()
    if($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $python)){throw 'Python 3.13 missing.'}
    $result.python=@{path=$python;sha256=(Get-FileHash -LiteralPath $python -Algorithm SHA256).Hash.ToLowerInvariant()}

    # Establish the actual broken encoding on 5.1, with the same behavioral helper.
    $beforeError=$null
    try { & (Join-Path $PSScriptRoot 'test_installed_setup.ps1') -Diagnostic (Join-Path $PSScriptRoot 'diagnostic-before-ps51.ps1') -HandoffStore $store -Python $python | Out-Null }
    catch {$beforeError=$_.Exception.Message}
    if(-not $beforeError -or $beforeError -notmatch 'utf8NoBOM'){throw ('Expected original 5.1 encoding failure, got: '+$beforeError)}
    $result.failFirst=$beforeError
    & (Join-Path $PSScriptRoot 'test_installed_setup.ps1') -HandoffStore $store -Python $python | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'setup.json') -Encoding UTF8
    $result.setup='passed'
    # Explicit child projection is read and resolved before unittest executes.
    & $python -B (Join-Path $PSScriptRoot 'qualification-tests.py') --handoff-store $store *> (Join-Path $EvidenceRoot 'python.log')
    if($LASTEXITCODE -ne 0){throw 'Affected Windows Python controls failed.'}
    $result.pythonControls='passed'
    & (Join-Path $PSScriptRoot 'prove-portable-node-recovery.ps1') -CandidateRoot $CandidateRoot -ExpectedHead '393c80255dea6605a5665c6e0836d01fb6d18304' -ExpectedEngine powershell -EvidencePath (Join-Path $EvidenceRoot 'portable.json') -HandoffStore $store
    $result.portable='passed'
    if(Test-Path -LiteralPath $store){throw 'Qualification unexpectedly created a handoff database.'}
    $result.result='passed'
} catch {$failure=$_;$result.error=$_.Exception.Message}
finally {
    $env:OPENCLAW_QUALIFICATION_HANDOFF_DB=$savedStore;$env:TMPDIR=$savedTmp;$env:TEMP=$savedTemp;$env:TMP=$savedTmpWin
    try {
        Remove-Item -LiteralPath $root -Recurse -Force
        if(Test-Path -LiteralPath $root){throw 'Owned qualification root survived cleanup.'}
        $result.cleanup='removed'
    } catch {$result.cleanup='failed';$result.cleanupError=$_.Exception.Message;$result.result='failed';if(-not $failure){$failure=$_}}
    $result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'result.json') -Encoding UTF8
}
if($failure){throw $failure}
