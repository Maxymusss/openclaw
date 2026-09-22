param([string]$SourceRoot)
$ErrorActionPreference='Stop'
$results=@()
foreach($name in @('diagnostic.ps1','hook.ps1','stage.ps1','test_installed_setup.ps1')){
 $file=Join-Path $SourceRoot $name;$tokens=$null;$errors=$null
 $ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
 if($errors.Count){throw ($errors|Out-String)}
 $results+=@{file=$name;parseErrors=0;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant();bodyExecuted=$false}
 if($name -eq 'diagnostic.ps1'){
  $binder=[scriptblock]::Create('[CmdletBinding()]'+"`n"+$ast.ParamBlock.Extent.Text+"`n"+'return $PSBoundParameters')
  $args=@{CandidateRoot='/not-created';ExpectedHead=('a'*40);EvidenceRoot='/not-created-evidence';ProofCase='published-driver';ObserverRuntime='/not-created-runtime';ObserverManifest='/not-created-manifest';ObserverManifestSha256=('b'*64);ObserverSmokeResult='/not-created-smoke';ObserverSmokeSha256=('c'*64)}
  $bound=& $binder @args
  foreach($key in $args.Keys){if($bound[$key] -cne $args[$key]){throw 'Binding mismatch.'}}
 }
}
$results|ConvertTo-Json -Depth 6
