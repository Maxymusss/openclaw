# Source-only exact generated setup seam; synthetic callees, no product/native invocation.
param([string]$Diagnostic=(Join-Path $PSScriptRoot 'diagnostic.ps1'), [Parameter(Mandatory=$true)][string]$HandoffStore, [Parameter(Mandatory=$true)][string]$Python)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'qualification-isolation.ps1')
$HandoffStore=Assert-QualificationStore -Path $HandoffStore
$originalExitCode=$global:LASTEXITCODE
$script:ExpectedArchiveSha=(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-pin.json') -Raw|ConvertFrom-Json).archiveSha256
$source=[IO.File]::ReadAllText($Diagnostic)
$begin=$source.IndexOf('    $releasePin = ');$end=$source.IndexOf('    $driver = ', $begin)
if($begin -lt 0 -or $end -lt 0){throw 'Setup seam missing.'}
$body=[scriptblock]::Create($source.Substring($begin,$end-$begin))
function Join-Path {
    param([string]$Path,[string]$ChildPath)
    if($ChildPath -ceq 'python.exe'){return 'Invoke-FakePython'}
    Microsoft.PowerShell.Management\Join-Path $Path $ChildPath
}
function Get-FileHash {
    param([string]$Path,[string]$LiteralPath,[string]$Algorithm='SHA256')
    $target=if($LiteralPath){$LiteralPath}else{$Path}
    if([IO.Path]::GetFileName($target) -ceq 'openclaw-2026.9.5.tgz'){
        # Synthetic archive callee succeeds as the separately tested archive verifier.
        return [pscustomobject]@{Hash=$script:ExpectedArchiveSha}
    }
    Microsoft.PowerShell.Utility\Get-FileHash @PSBoundParameters
}
function Invoke-WebRequest {
    param($Uri,$OutFile,$TimeoutSec)
    [IO.File]::WriteAllText($OutFile,'synthetic archive; no package code')
}
function Invoke-ProofInstaller {
    param($Name,$Options)
    $script:events.Add('installer')
    $tag=[array]::IndexOf($Options,'-Tag')
    if($tag -lt 0 -or $Options[$tag+1] -cne (Microsoft.PowerShell.Management\Join-Path $EvidenceRoot 'openclaw-2026.9.5.tgz')){throw 'Installer did not receive verified archive.'}
    if($script:case -eq 'failed'){throw 'original installer failure'}
    if($script:case -eq 'unsettled'){throw 'original UNSETTLED custody'}
    $identity=@{pid=17;created100ns='100';exited100ns='0';executable='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe';imageError=0;processMachine=0;nativeMachine=34404}
    $terminal=@{pid=17;created100ns='100';exited100ns='200';executable=$null;imageError=31;processMachine=0;nativeMachine=34404}
    $record=@{name=$Name;status='TERMINAL';exitCode=0;error=$null;settlementError=$null;timedOut=$false;identity=$identity;terminalIdentity=$terminal;settlement='same-held-handle-times; terminal-image-absent-error31-retained'}
    switch($script:case){
        'wrong-command' {$record.name='other-installer'}
        'timed-out' {$record.timedOut=$true}
        'wrong-identity' {$terminal.pid=18}
        'wrong-settlement' {$record.settlement='unproved'}
        'command-error' {$record.error='original error'}
        'wrong-archive' {$script:proof.releaseArchiveSha256=('0'*64)}
    }
    $script:proof.commands=@($record)
    if($script:case -eq 'unsettled-flag'){$script:proof.unsettled=$true}
}
function Invoke-FakePython {
    $mode=$args[4];$script:events.Add($mode);$global:LASTEXITCODE=0
    if($mode -eq 'archive' -and $script:case -eq 'archive-failed'){$global:LASTEXITCODE=1}
    if($mode -eq 'installed'){
        $index=[array]::IndexOf($args,'--setup');$hashIndex=[array]::IndexOf($args,'--setup-sha')
        if($index -lt 0 -or $hashIndex -lt 0){throw 'Same-setup binding missing.'}
        $file=$args[$index+1];$hash=$args[$hashIndex+1]
        if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hash){throw 'Setup hash mismatch.'}
        $record=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json
        if($record.target -cne [IO.Path]::GetFullPath((Microsoft.PowerShell.Management\Join-Path $prefix 'node_modules/openclaw'))){throw 'Wrong installed target.'}
        if(-not $record.archiveVerified -or $record.unsettled -or $record.command.status -cne 'TERMINAL' -or $record.command.exitCode -ne 0){throw 'Setup receipt mismatch.'}
        $validation=& $Python '-B' (Microsoft.PowerShell.Management\Join-Path $PSScriptRoot 'qualification-receipt.py') '--setup' $file '--handoff-store' $HandoffStore
        if($LASTEXITCODE -ne 0){throw ('Production require_setup rejected generated receipt: '+($validation -join ''))}
        if($script:case -eq 'installed-failed'){$global:LASTEXITCODE=1}
    }
}
$results=@()
try {
foreach($script:case in @('success','archive-failed','failed','unsettled','unsettled-flag','installed-failed','wrong-command','timed-out','wrong-identity','wrong-settlement','command-error','wrong-archive')){
    $root=Microsoft.PowerShell.Management\Join-Path ([IO.Path]::GetDirectoryName($HandoffStore)) ('installed-state-control-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $root|Out-Null
    $prefix=$root;$EvidenceRoot=$root;$ObserverRuntime=$PSScriptRoot;$ObserverManifest='not-used';$ObserverManifestSha256=('0'*64)
    $script:proof=@{commands=@();unsettled=$false};$script:events=[Collections.Generic.List[string]]::new();$errorText=$null
    try { & $body; $script:events.Add('gateway-boundary') } catch {$errorText=$_.Exception.Message}
    try {
        if($case -eq 'success'){
            if($errorText -or ($events -join ',') -cne 'archive,installer,installed,gateway-boundary'){throw ('Success control failed: '+$errorText)}
        } else {
            if(-not $errorText -or $events.Contains('gateway-boundary')){throw 'Failure fell through to Gateway.'}
            if($case -eq 'archive-failed' -and $events.Contains('installer')){throw 'Archive failure reached installer.'}
            if($case -in @('failed','unsettled','unsettled-flag') -and $events.Contains('installed')){throw 'Failed installer reached verification.'}
            if($case -in @('wrong-command','timed-out','wrong-identity','wrong-settlement','command-error','wrong-archive') -and $errorText -notmatch 'Production require_setup rejected generated receipt:.*accepted'){throw ('Wrong failure gate: '+$errorText)}
            if($case -eq 'failed' -and $errorText -cne 'original installer failure'){throw 'Original error lost.'}
            if($case -eq 'unsettled' -and $errorText -cne 'original UNSETTLED custody'){throw 'Original unsettled error lost.'}
        }
        $results+=@{case=$case;events=@($events);error=$errorText;passed=$true}
    } finally {Remove-Item -LiteralPath $root -Recurse}
}
if([IO.File]::Exists($HandoffStore)){throw 'Synthetic setup unexpectedly created a handoff database.'}
$results|ConvertTo-Json -Depth 10
} finally { $global:LASTEXITCODE=$originalExitCode }
