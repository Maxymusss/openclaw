# Fixture-only lifecycle. Dot-source after bundle verification. No product-source mutation.
function Initialize-ProofNative {
    if ('ProofHeldProcess' -as [type]) {
        if (-not ('ProofBaseline' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'held-job.cs') }
        return
    }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
public static class ProofHeldProcess {
 [StructLayout(LayoutKind.Sequential)] public struct FT { public uint lo,hi; public ulong Value => ((ulong)hi<<32)|lo; }
 [DllImport("kernel32",SetLastError=true)] static extern uint GetProcessId(SafeProcessHandle h);
 [DllImport("kernel32",SetLastError=true)] static extern bool GetProcessTimes(SafeProcessHandle h,out FT c,out FT e,out FT k,out FT u);
 [DllImport("kernel32",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(SafeProcessHandle h,uint f,System.Text.StringBuilder b,ref uint n);
 [DllImport("kernel32",SetLastError=true)] static extern bool IsWow64Process2(SafeProcessHandle h,out ushort p,out ushort n);
 public static object[] Read(SafeProcessHandle h) {
  if(h.IsClosed||h.IsInvalid) throw new InvalidOperationException("Lost retained process handle");
  uint pid=GetProcessId(h); if(pid==0) throw new Win32Exception(Marshal.GetLastWin32Error());
  FT c,e,k,u; if(!GetProcessTimes(h,out c,out e,out k,out u)) throw new Win32Exception(Marshal.GetLastWin32Error());
  ushort p,n; if(!IsWow64Process2(h,out p,out n)) throw new Win32Exception(Marshal.GetLastWin32Error());
  var b=new System.Text.StringBuilder(32768);uint len=32768;int error=0;
  if(!QueryFullProcessImageNameW(h,0,b,ref len)) error=Marshal.GetLastWin32Error();
  return new object[]{pid,c.Value.ToString(),e.Value.ToString(),error==0?b.ToString():null,error,p,n};
 }
}
'@
    Add-Type -Path (Join-Path $PSScriptRoot 'held-job.cs')
}
function Read-ProofJobCounts($Process) { $Process.JobCounts() }
function Read-ProofIdentity($Handle) {
    $v=[ProofHeldProcess]::Read($Handle)
    return @{ pid=$v[0]; created100ns=$v[1]; exited100ns=$v[2]; executable=$v[3]; imageError=$v[4]; processMachine=$v[5]; nativeMachine=$v[6] }
}
function Assert-ProofIdentity($Launch,$Current,[switch]$Terminal) {
    foreach ($k in @('pid','created100ns','processMachine','nativeMachine')) {
        if ($null -eq $Launch[$k] -or $Launch[$k] -cne $Current[$k]) { throw "Held identity changed: $k" }
    }
    if ([uint64]$Launch.created100ns -eq 0 -or $Launch.exited100ns -cne '0' -or
        $Launch.imageError -ne 0 -or -not $Launch.executable -or $Launch.nativeMachine -ne 34404 -or $Launch.processMachine -ne 0) { throw 'Unqualified launch identity.' }
    if ($Terminal) {
        if ([uint64]$Current.exited100ns -le [uint64]$Launch.created100ns) { throw 'Positive terminal time required.' }
        if ($Current.imageError -eq 31 -and -not $Current.executable) { return 'same-held-handle-times; terminal-image-absent-error31-retained' }
    } elseif ($Current.exited100ns -cne '0') { throw 'Process already exited before action.' }
    if ($Current.imageError -ne 0 -or $Launch.executable -ine $Current.executable) { throw 'Executable identity unavailable or changed.' }
    return 'same-held-handle-and-image'
}
function Start-ProofOwnedProcess([string]$Name,[string]$File,[string[]]$Arguments) {
    $quoted=foreach($value in $Arguments) {
        if($value.Contains('"') -or $value.EndsWith('\')) { throw 'Unsupported proof argument.' }
        '"'+$value+'"'
    }
    Start-Process -FilePath $File -ArgumentList ($quoted -join ' ') -WorkingDirectory $root -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $EvidenceRoot "$Name.stdout.log") -RedirectStandardError (Join-Path $EvidenceRoot "$Name.stderr.log")
}
function Invoke-ProofCommand {
    param([string]$Name,[string]$File,[string[]]$Arguments,[int]$Seconds=1200,[switch]$ExpectFailure)
    $record=@{name=$Name;argv=@($File)+$Arguments;status='NOT_STARTED';timeoutSeconds=$Seconds;error=$null}
    $script:proof.commands+=,$record
    $child=$null;$held=$null;$original=$null
    try {
        $child=Start-ProofOwnedProcess $Name $File $Arguments
        $held=$child.SafeHandle
        $record.identity=Read-ProofIdentity $held
        $null=Assert-ProofIdentity $record.identity $record.identity
        $record.executableSha256=(Get-FileHash -LiteralPath $record.identity.executable -Algorithm SHA256).Hash.ToLowerInvariant()
        $record.status='RUNNING'
        if (-not $child.WaitForExit($Seconds*1000)) {
            $record.timedOut=$true
            throw "$Name timed out."
        }
        $record.exitCode=$child.ExitCode
        if (($ExpectFailure -and $child.ExitCode -eq 0) -or (-not $ExpectFailure -and $child.ExitCode -ne 0)) { throw "$Name returned unexpected exit code $($child.ExitCode)." }
    } catch { $original=$_; $record.error=$_.Exception.Message } finally {
        # Zero wait is bounded and does not wait for pipe readers or descendants.
        $record.status='UNSETTLED';$record.settlementError=$null
        if ($child -and $held) {
            try {
                $record.terminalIdentity=Read-ProofIdentity $held
                if ($child.WaitForExit(0)) {
                    $record.exitCode=$child.ExitCode
                    $record.settlement=Assert-ProofIdentity $record.identity $record.terminalIdentity -Terminal
                    $record.status='TERMINAL'
                }
            } catch { $record.settlementError=$_.Exception.Message }
        }
        if ($record.status -ne 'TERMINAL') {
            $script:proof.unsettled=$true
            # Retain object/handle for this controller lifetime; root remains on disk.
            $script:retainedProcesses+=,@{process=$child;handle=$held;record=$record}
        } elseif ($child) { $child.Dispose() }
    }
    if ($original) { throw $original }
    if ($record.status -ne 'TERMINAL') { throw "$Name UNSETTLED; retain root and process custody." }
}
function Assert-ProofBaselineOwner($Process,$Handle,$Launch) {
    if ($script:observationArmed -or $script:proof.unsettled -or
        -not [object]::ReferenceEquals($Process,$script:gateway) -or
        -not [object]::ReferenceEquals($Handle,$script:gatewayHandle) -or
        -not [object]::ReferenceEquals($Handle,$Process.SafeHandle)) { throw 'Not the pre-arm owned baseline handle.' }
    if ($root -cne $script:baselineRoot -or $profile -cne $script:baselineProfile -or
        $env:OPENCLAW_HOME -cne $profile -or $env:USERPROFILE -cne $profile -or
        [IO.File]::ReadAllText((Join-Path $root 'fixture-owner')) -cne $script:baselineNonce) { throw 'Fresh profile/root ownership mismatch.' }
    $current=Read-ProofIdentity $Handle
    $null=Assert-ProofIdentity $Launch $current
    if ((Get-FileHash -LiteralPath $current.executable -Algorithm SHA256).Hash.ToLowerInvariant() -cne $script:proof.baselineGateway.executableSha256) { throw 'Baseline executable changed.' }
    # Job accounting includes descendants even after every intermediate parent exits.
    $counts=Read-ProofJobCounts $Process
    $script:proof.baselineGateway.jobBefore=$counts
    if ($counts.TotalProcesses -ne 1 -or $counts.ActiveProcesses -ne 1) { throw 'Baseline job is not singleton; descendants/uncertain custody retained.' }
    # Enumerations supplement the held handle and job, never authorize a PID-only action.
    $rows=@(Get-CimInstance -ClassName Win32_Process -OperationTimeoutSec 5 -ErrorAction Stop)
    $descendants=@($rows | Where-Object { $_.ParentProcessId -eq $Launch.pid })
    $script:proof.baselineGateway.descendantsBefore=@($descendants | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath)
    if ($descendants.Count) { throw 'Baseline descendants present; no tree action permitted.' }
    $self=@($rows | Where-Object { $_.ProcessId -eq $Launch.pid })
    if ($self.Count -ne 1 -or $self[0].ParentProcessId -ne $PID -or
        [math]::Abs([decimal]$self[0].CreationDate.ToUniversalTime().ToFileTimeUtc()-[decimal]$Launch.created100ns) -ge 10 -or
        $self[0].ExecutablePath -ine $Launch.executable) { throw 'Baseline ownership census uncertain.' }
    $listeners=@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop)
    if (-not $listeners.Count -or @($listeners | Where-Object { $_.OwningProcess -ne $Launch.pid }).Count) { throw 'Baseline listener is not the retained root.' }
    return $current
}
function Start-ProofGateway {
    param([string]$Entry,[string]$Name)
    if($script:observationArmed -or $script:proof.unsettled -or $script:gateway) { throw 'Baseline launch not admitted.' }
    $script:baselineRoot=$root;$script:baselineProfile=$profile;$script:baselineNonce=[guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText((Join-Path $root 'fixture-owner'),$script:baselineNonce)
    $script:proof.baselineGateway=@{status='STARTING';root=$root;profile=$profile;healthyBeforeMaintenance=$false;stoppedBeforeUpdate=$false;action='NONE';fixtureOnly=$true;gracefulServiceAcceptance=$false}
    # This is the release's own Windows startup flag, supplied up front to keep the held foreground root.
    $script:gateway=[ProofBaseline]::Start($node,@('--stack-size=8192',$Entry,'gateway','run','--allow-unconfigured'),$root,(Join-Path $EvidenceRoot "$Name.stdout.log"),(Join-Path $EvidenceRoot "$Name.stderr.log"))
    $script:gatewayHandle=$script:gateway.SafeHandle
    $launch=Read-ProofIdentity $script:gatewayHandle
    $script:proof.baselineGateway.identity=$launch
    $script:proof.baselineGateway.jobAssignedBeforeResume=$script:gateway.AssignedBeforeResume
    $script:proof.baselineGateway.resumed=$script:gateway.Resumed
    $script:proof.baselineGateway.launchError=$script:gateway.LaunchError
    if ($script:gateway.LaunchError -or -not $script:gateway.AssignedBeforeResume -or -not $script:gateway.Resumed) { throw 'Baseline launch/assignment unsettled; retain original suspended process, no cleanup kill.' }
    $null=Assert-ProofIdentity $launch $launch
    $script:proof.baselineGateway.executableSha256=(Get-FileHash -LiteralPath $launch.executable -Algorithm SHA256).Hash.ToLowerInvariant()
    $clock=[Diagnostics.Stopwatch]::StartNew()
    do {
        if($script:gateway.WaitForExit(0)) { throw 'Baseline exited before readiness.' }
        try { $response=Invoke-WebRequest -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 3 } catch { $response=$null }
        if ($response -and $response.StatusCode -eq 200) {
            $script:proof.baselineGateway.preReadyIdentity=Assert-ProofBaselineOwner $script:gateway $script:gatewayHandle $launch
            $script:proof.baselineGateway.healthyBeforeMaintenance=$true
            $script:proof.baselineGateway.status='READY'
            return
        }
        Start-Sleep -Milliseconds 500
    } while ($clock.ElapsedMilliseconds -lt 180000)
    throw 'Baseline never became ready; retained with no fallback termination.'
}
function Stop-ProofGateway {
    # Only call on the successful normal setup path. Never called in finally.
    $record=$script:proof.baselineGateway
    if (-not $record.healthyBeforeMaintenance -or $record.action -cne 'NONE') { throw 'Baseline stop not admitted or already attempted.' }
    $record.preActionIdentity=Assert-ProofBaselineOwner $script:gateway $script:gatewayHandle $record.identity
    $record.action='ROOT_ONLY_TERMINATION';$record.actionUtc=[DateTime]::UtcNow.ToString('o')
    try {
        # This fixture object's Kill() uses TerminateProcess on its ORIGINAL CreateProcess handle, root only.
        # Released CLI stop uses service/PID lookup; no fixture-scoped cooperative external command exists.
        $script:gateway.Kill()
        $record.actionReturned=$true
        if (-not $script:gateway.WaitForExit(10000)) { throw 'Baseline UNSETTLED after bounded root stop.' }
        $record.terminalIdentity=Read-ProofIdentity $script:gatewayHandle
        $record.exitCode=$script:gateway.ExitCode
        $record.settlement=Assert-ProofIdentity $record.identity $record.terminalIdentity -Terminal
        $rows=@(Get-CimInstance -ClassName Win32_Process -OperationTimeoutSec 5 -ErrorAction Stop)
        $record.descendantsAfter=@($rows | Where-Object { $_.ParentProcessId -eq $record.identity.pid } | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath)
        if ($record.descendantsAfter.Count) { throw 'Descendant custody remains; no observer/update admission.' }
        $record.jobAfter=Read-ProofJobCounts $script:gateway
        if ($record.jobAfter.TotalProcesses -ne 1 -or $record.jobAfter.ActiveProcesses -ne 0) { throw 'Baseline job descendants or uncertain settlement; no observer/update admission.' }
        $record.status='TERMINAL';$record.stoppedBeforeUpdate=$true
        $script:gateway.Dispose();$script:gateway=$null;$script:gatewayHandle=$null
    } catch { $record.error=$_.Exception.Message;$record.status='UNSETTLED';$script:proof.unsettled=$true;throw }
}
