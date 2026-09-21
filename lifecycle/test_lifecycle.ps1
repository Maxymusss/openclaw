param([string]$Lifecycle=(Join-Path $PSScriptRoot 'lifecycle.ps1'),[switch]$Original)
$ErrorActionPreference='Stop'
if ($Original) {
 $t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile($Lifecycle,[ref]$t,[ref]$e)
 if($e.Count){throw 'Original parse failure'}
 foreach($f in $a.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Invoke-ProofCommand','Stop-ProofGateway')},$true)) { . ([scriptblock]::Create($f.Extent.Text)) }
} else { . $Lifecycle }
$root=Join-Path ([IO.Path]::GetTempPath()) ('lifecycle-controls-'+[guid]::NewGuid().ToString('N'))
$profile=Join-Path $root 'profile';$EvidenceRoot=Join-Path $root 'evidence';$port=12345
New-Item -Type Directory -Path $root,$profile,$EvidenceRoot | Out-Null
$exe=Join-Path $root 'node.exe';[IO.File]::WriteAllText($exe,'inert bytes only')
$originalEnv=@{USERPROFILE=$env:USERPROFILE;OPENCLAW_HOME=$env:OPENCLAW_HOME}
$env:USERPROFILE=$profile;$env:OPENCLAW_HOME=$profile
$created=[DateTime]::UtcNow.AddMinutes(-1);$created=[DateTime]::FromFileTimeUtc($created.ToFileTimeUtc()-($created.ToFileTimeUtc()%10))
function Reset {
 $script:observationArmed=$false;$script:retainedProcesses=@();$script:proof=@{commands=@();unsettled=$false}
 $script:waits=[Collections.Generic.List[int]]::new();$script:kills=@();$script:disposed=$false;$script:terminal=$false;$script:timeout=$false;$script:readError=$false
 $script:gatewayHandle=[object]::new()
 $script:gateway=[pscustomobject]@{SafeHandle=$script:gatewayHandle;Id=42;ExitCode=0;HasExited=$false}
 $script:gateway|Add-Member ScriptMethod WaitForExit {param($Milliseconds) if($null -eq $Milliseconds){$script:waits.Add(-1)}else{$script:waits.Add($Milliseconds)};if($script:timeout){return $false};$script:terminal=$true;return $true}
 $script:gateway|Add-Member ScriptMethod Kill {param($Tree) $script:kills+=,[bool]$Tree;$script:terminal=$true;$this.HasExited=$true}
 $script:gateway|Add-Member ScriptMethod Dispose {$script:disposed=$true}
 $script:launch=@{pid=42;created100ns=$created.ToFileTimeUtc().ToString();exited100ns='0';executable=$exe;imageError=0;processMachine=0;nativeMachine=34404}
 $script:baselineRoot=$root;$script:baselineProfile=$profile;$script:baselineNonce='unit-owner'
 [IO.File]::WriteAllText((Join-Path $root 'fixture-owner'),$script:baselineNonce)
 $script:proof.baselineGateway=@{identity=$script:launch;executableSha256=(Get-FileHash $exe).Hash.ToLowerInvariant();healthyBeforeMaintenance=$true;action='NONE';status='READY';stoppedBeforeUpdate=$false}
 $script:foreign=$false;$script:descendant=$false;$script:censusError=$false;$script:everGrandchild=$false;$script:jobError=$false;$script:raceDescendant=$false
}
function Read-ProofJobCounts($Process) {
 if($script:jobError){throw 'Job accounting unavailable'}
 return @{TotalProcesses=$(if($script:everGrandchild -or ($script:terminal -and $script:raceDescendant)){2}else{1});ActiveProcesses=$(if($script:terminal){0}else{1});TerminatedProcesses=0}
}
function Read-ProofIdentity($Handle) {
 if($script:readError -and $script:terminal){throw 'original Windows query failed'}
 $r=$script:launch.Clone()
 if($script:foreign){$r.created100ns=([uint64]$r.created100ns+10).ToString()}
 if($script:terminal){$r.exited100ns=[DateTime]::UtcNow.ToFileTimeUtc().ToString();$r.executable=$null;$r.imageError=31}
 return $r
}
function Start-ProofOwnedProcess { return $script:gateway }
function Start-Process { return $script:gateway }
function Get-CimInstance {
 if($script:censusError){throw 'incomplete census'}
 [pscustomobject]@{ProcessId=42;ParentProcessId=$PID;CreationDate=$created;ExecutablePath=$exe}
 if($script:descendant){[pscustomobject]@{ProcessId=43;ParentProcessId=42;CreationDate=$created;ExecutablePath=$exe}}
}
function Get-NetTCPConnection { [pscustomobject]@{OwningProcess=42} }
function Assert($Condition,$Message){if(-not $Condition){throw $Message}}
$results=@()
function Check($Name,[scriptblock]$Body) {
 Reset
 try{& $Body;$script:results+=@{name=$Name;pass=$true}}catch{$script:results+=@{name=$Name;pass=$false;error=$_.Exception.Message}}
}
try {
 Check 'normal stop is root-only with bounded settlement and raw terminal error31' {
  Stop-ProofGateway
  Assert ($script:kills.Count -eq 1 -and $script:kills[0] -eq $false) 'tree termination invoked'
  Assert (-not $script:waits.Contains(-1)) 'unbounded join invoked'
  Assert ($proof.baselineGateway.status -eq 'TERMINAL' -and $proof.baselineGateway.stoppedBeforeUpdate) 'no terminal admission'
  Assert ($proof.baselineGateway.terminalIdentity.imageError -eq 31 -and -not $proof.baselineGateway.terminalIdentity.executable) 'raw error31 lost'
 }
 Check 'post-arm stop is refused without action' {
  $script:observationArmed=$true;$errorText=$null;try{Stop-ProofGateway}catch{$errorText=$_.Exception.Message}
  Assert ($errorText -and $script:kills.Count -eq 0) 'post-arm action allowed'
 }
 Check 'foreign creation identity is refused' {
  $script:foreign=$true;try{Stop-ProofGateway}catch{}
  Assert ($script:kills.Count -eq 0) 'stale identity action allowed'
 }
 Check 'foreign handle is refused' {
  $script:gateway.SafeHandle=[object]::new();try{Stop-ProofGateway}catch{}
  Assert ($script:kills.Count -eq 0) 'foreign handle action allowed'
 }
 Check 'foreign profile marker is refused' {
  [IO.File]::WriteAllText((Join-Path $root 'fixture-owner'),'foreign');try{Stop-ProofGateway}catch{}
  Assert ($script:kills.Count -eq 0) 'foreign root action allowed'
 }
 Check 'descendant custody blocks action' {
  $script:descendant=$true;try{Stop-ProofGateway}catch{}
  Assert ($script:kills.Count -eq 0) 'descendant action allowed'
 }
 Check 'census failure blocks action' {
  $script:censusError=$true;try{Stop-ProofGateway}catch{}
  Assert ($script:kills.Count -eq 0) 'uncertain custody action allowed'
 }
 Check 'installer timeout never terminates and preserves original error plus root' {
  $script:timeout=$true;$errorText=$null
  try{Invoke-ProofCommand -Name installer -File $exe -Arguments @('inert') -Seconds 1}catch{$errorText=$_.Exception.Message}
  Assert ($errorText -eq 'installer timed out.') 'original timeout lost'
  Assert ($script:kills.Count -eq 0 -and -not $script:waits.Contains(-1)) 'timeout kill or unbounded join'
  Assert ($proof.unsettled -and $proof.commands[0].status -eq 'UNSETTLED' -and -not $script:disposed) 'unsettled custody lost'
  Assert (Test-Path $root) 'root removed'
  $script:timeout=$false;try{Stop-ProofGateway}catch{}
  Assert ($script:kills.Count -eq 0) 'unsettled install fell through to baseline stop'
 }
 Check 'terminal commands have bounded joins' {
  Invoke-ProofCommand -Name installer -File $exe -Arguments @('inert') -Seconds 1
  Assert (-not $script:waits.Contains(-1)) 'unbounded successful join'
  Assert ($proof.commands[0].status -eq 'TERMINAL' -and $script:disposed) 'held terminal settlement absent'
 }
 Check 'nonzero error survives settlement query failure' {
  $script:gateway.ExitCode=19;$script:readError=$true;$errorText=$null
  try{Invoke-ProofCommand -Name installer -File $exe -Arguments @('inert') -Seconds 1}catch{$errorText=$_.Exception.Message}
  Assert ($errorText -eq 'installer returned unexpected exit code 19.') 'original exit error replaced'
  Assert ($proof.unsettled -and $proof.commands[0].settlementError) 'query failure erased'
 }
 Check 'stop timeout has no retry or tree fallback' {
  $script:timeout=$true;try{Stop-ProofGateway}catch{}
  Assert ($proof.unsettled -and $script:kills.Count -eq 1 -and $script:kills[0] -eq $false) 'missing unsettled stop'
  try{Stop-ProofGateway}catch{}
  Assert ($script:kills.Count -eq 1 -and -not $script:waits.Contains(-1)) 'stop retried or unbounded'
 }
 Check 'orphan grandchild job history blocks action even with empty parent census' {
  $script:everGrandchild=$true;try{Stop-ProofGateway}catch{}
  Assert ($script:kills.Count -eq 0) 'orphan grandchild omitted'
 }
 Check 'lost job accounting blocks action' {
  $script:jobError=$true;try{Stop-ProofGateway}catch{}
  Assert ($script:kills.Count -eq 0) 'job accounting failure admitted'
 }
 Check 'child racing preaction snapshot blocks subsequent arming' {
  $script:raceDescendant=$true;try{Stop-ProofGateway}catch{}
  Assert ($proof.unsettled -and -not $proof.baselineGateway.stoppedBeforeUpdate) 'racing descendant admitted observation'
 }
 Check 'other terminal image errors stay unqualified'  {
  $end=$script:launch.Clone();$end.exited100ns=[DateTime]::UtcNow.ToFileTimeUtc().ToString();$end.imageError=5;$end.executable=$null
  $err=$null;try{$null=Assert-ProofIdentity $script:launch $end -Terminal}catch{$err=$_}
  Assert ($null -ne $err) 'image error5 accepted'
 }
} finally {
 foreach($k in $originalEnv.Keys){[Environment]::SetEnvironmentVariable($k,$originalEnv[$k],'Process')}
 Remove-Item -LiteralPath $root -Recurse -Force
}
@{nativeWindowsProof=$false;controls=$results;passed=@($results|Where-Object pass).Count;failed=@($results|Where-Object {-not $_.pass}).Count}|ConvertTo-Json -Depth 8
if(@($results|Where-Object {-not $_.pass}).Count){exit 1}
