# Authenticate exact accepted setup evidence before reusing any prior qualification.
function Assert-AcceptedSetupEvidence {
    param([Parameter(Mandatory=$true)][string]$EvidencePath,[Parameter(Mandatory=$true)][string]$RawReceiptPath,[Parameter(Mandatory=$true)][string]$SourceRoot)
    if((Get-FileHash -LiteralPath $EvidencePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne '4ffda3d485752dafa172f3c1be98519f47bbf295202b86c5455e69cf598c381f'){throw 'Accepted evidence bytes changed.'}
    $accepted=Get-Content -LiteralPath $EvidencePath -Raw|ConvertFrom-Json
    try {$rawBytes=[Convert]::FromBase64String([IO.File]::ReadAllText($RawReceiptPath))}
    catch {throw 'Accepted raw setup receipt changed.'}
    $hasher=[Security.Cryptography.SHA256]::Create()
    try {$rawHash=[BitConverter]::ToString($hasher.ComputeHash($rawBytes)).Replace('-','').ToLowerInvariant()}
    finally {$hasher.Dispose()}
    if($rawHash -cne $accepted.setupReceiptSha256){throw 'Accepted raw setup receipt changed.'}
    $raw=([Text.Encoding]::UTF8.GetString($rawBytes).TrimStart([char]0xfeff))|ConvertFrom-Json
    if(($raw|ConvertTo-Json -Depth 10 -Compress) -cne ($accepted.setupCases|ConvertTo-Json -Depth 10 -Compress)){throw 'Accepted setup cases do not match raw receipt.'}
    $cases='success,archive-failed,failed,unsettled,unsettled-flag,installed-failed,wrong-command,timed-out,wrong-identity,wrong-settlement,command-error,wrong-archive'
    $sources=@('test_installed_setup.ps1','diagnostic.ps1','compose.py','qualification-receipt.py','qualification-isolation.ps1','release.py','release-pin.json','release-installed.json')
    if($accepted.run -ne 35703751482 -or $accepted.job -ne 106667632638 -or $accepted.workflow -cne 'd6dceac8e9c290e1e365035edeab4f04424dffbd' -or $accepted.engine -cne '5.1.26100.33296' -or $accepted.parse -cne 'passed' -or $accepted.cleanup -cne 'removed' -or (($accepted.setupCases|ForEach-Object{$_.case}) -join ',') -cne $cases -or @($accepted.setupCases|Where-Object{$_.passed -isnot [bool] -or -not $_.passed}).Count){throw 'Incomplete accepted setup evidence.'}
    if((@($accepted.sourceBindings.PSObject.Properties.Name|Sort-Object) -join ',') -cne (@($sources|Sort-Object) -join ',')){throw 'Wrong accepted source binding set.'}
    foreach($name in $sources){
        if((Get-FileHash -LiteralPath (Join-Path $SourceRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $accepted.sourceBindings.$name){throw ('Accepted setup source changed: '+$name)}
    }
    return $accepted
}
