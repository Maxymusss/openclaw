# Task-owned runtime only. Never erase unresolved product/backup/holder custody.
$ErrorActionPreference='Stop'
$owned=Join-Path $env:RUNNER_TEMP ('observer393-product-'+$env:GITHUB_RUN_ID+'-'+$env:GITHUB_RUN_ATTEMPT)
$evidence=Join-Path $owned 'evidence'
if (-not (Test-Path -LiteralPath $evidence)) { Write-Output 'No runtime namespace created.';exit 0 }
$receipt=@{owner='same125286/ec13';runtimeDisposition='RETAINED_UNKNOWN';productRootDisposition='RETAINED_FOR_INSTALLED_PARENT_HOLDER_INVESTIGATION';runnerDisposal='not observed here; never process settlement proof';reviewByUtc=[DateTime]::UtcNow.AddDays(1).ToString('o');releaseCondition='Canonical consumes raw evidence, then settles exact custody or closes named investigation'}
$stageFile=Join-Path $evidence 'hosted-result.json';$settled=$false
if(Test-Path -LiteralPath $stageFile){
 $s=Get-Content -LiteralPath $stageFile -Raw|ConvertFrom-Json
 if($s.run -cne $env:GITHUB_RUN_ID -or $s.attempt -cne $env:GITHUB_RUN_ATTEMPT -or $s.workflowSha -cne $env:GITHUB_SHA){throw 'Cleanup run binding mismatch.'}
 $smoke=Join-Path $evidence 'smoke/result.json'
 if(Test-Path -LiteralPath $smoke){$sm=Get-Content -LiteralPath $smoke -Raw|ConvertFrom-Json;$settled=($sm.allExited -eq $true -and $s.controller.exitCode -eq 0)}
 $admission=Join-Path $evidence 'product-admission.json'
 if(Test-Path -LiteralPath $admission){
  $settled=$false
  $product=Join-Path $evidence 'diagnostic/result.json'
  if(Test-Path -LiteralPath $product){
   $p=Get-Content -LiteralPath $product -Raw|ConvertFrom-Json
   if($p.diagnostic -and $p.diagnostic.exited -eq $true){
    $observation=Join-Path $p.diagnostic.namespace 'result.json'
    if(Test-Path -LiteralPath $observation){$o=Get-Content -LiteralPath $observation -Raw|ConvertFrom-Json;$settled=($o.allExited -eq $true)}
   }
  }
 }
}
if($settled){
 foreach($name in @('runtime','python.zip')){
  $path=Join-Path $owned $name
  if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path -Recurse -Force}
  if(Test-Path -LiteralPath $path){throw 'Owned runtime cleanup failed.'}
 }
 $receipt.runtimeDisposition='REMOVED_AFTER_RECORDED_CONTROLLER_FIXTURE_OBSERVER_SETTLEMENT'
}
$receipt|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $evidence 'cleanup.json')
