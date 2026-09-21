// Accounting-only job for the newly launched baseline fixture. No kill-on-close,
// breakaway or other job limits are enabled. Never applied to an existing process.
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public sealed class ProofBaseline : IDisposable {
 [StructLayout(LayoutKind.Sequential)] struct SA { public int length;public IntPtr descriptor;[MarshalAs(UnmanagedType.Bool)]public bool inherit; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI {
  public int cb; public string reserved,desktop,title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags;public ushort show,reserved2;
  public IntPtr reservedPtr,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)] struct PI {public IntPtr process,thread;public uint pid,tid;}
 [StructLayout(LayoutKind.Sequential)] public struct Counts {public long user,kernel,periodUser,periodKernel;public uint faults,TotalProcesses,ActiveProcesses,TerminatedProcesses;}
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateJobObjectW(IntPtr attrs,string name);
 [DllImport("kernel32",SetLastError=true)] static extern bool AssignProcessToJobObject(SafeFileHandle job,SafeProcessHandle process);
 [DllImport("kernel32",SetLastError=true)] static extern bool QueryInformationJobObject(SafeFileHandle job,int cls,out Counts counts,uint length,IntPtr returned);
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string name,uint access,uint share,ref SA attrs,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr processAttrs,IntPtr threadAttrs,bool inherit,uint flags,IntPtr env,string cwd,ref SI startup,out PI process);
 [DllImport("kernel32",SetLastError=true)] static extern uint ResumeThread(SafeFileHandle thread);
 [DllImport("kernel32",SetLastError=true)] static extern uint WaitForSingleObject(SafeProcessHandle h,uint milliseconds);
 [DllImport("kernel32",SetLastError=true)] static extern bool GetExitCodeProcess(SafeProcessHandle h,out uint code);
 [DllImport("kernel32",SetLastError=true)] static extern bool TerminateProcess(SafeProcessHandle h,uint code);
 public SafeProcessHandle SafeHandle {get;private set;}
 SafeFileHandle job,thread;
 public uint Id {get;private set;}
 public string LaunchError {get;private set;}
 public bool AssignedBeforeResume {get;private set;}
 public bool Resumed {get;private set;}
 static string Quote(string s) {
  if(s.Contains("\"")||s.EndsWith("\\")) throw new ArgumentException("Unsupported fixture argument");
  return "\""+s+"\"";
 }
 static SafeFileHandle File(string name,uint access,uint creation) {
  var sa=new SA {length=Marshal.SizeOf<SA>(),inherit=true};
  var h=CreateFileW(name,access,3,ref sa,creation,128,IntPtr.Zero);
  if(h.IsInvalid) {int e=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(e);}
  return h;
 }
 public static ProofBaseline Start(string exe,string[] args,string cwd,string stdout,string stderr) {
  var result=new ProofBaseline();
  result.job=CreateJobObjectW(IntPtr.Zero,null);
  if(result.job.IsInvalid) {int e=Marshal.GetLastWin32Error();result.job.Dispose();throw new Win32Exception(e);}
  try {
   using(var input=File("NUL",0x80000000,3))
   using(var output=File(stdout,0x40000000,1))
   using(var error=File(stderr,0x40000000,1)) {
    var command=new StringBuilder(Quote(exe));foreach(var arg in args)command.Append(" ").Append(Quote(arg));
    var si=new SI {cb=Marshal.SizeOf<SI>(),flags=0x100,input=input.DangerousGetHandle(),output=output.DangerousGetHandle(),error=error.DangerousGetHandle()};
    PI pi;
    // CREATE_SUSPENDED closes the pre-assignment descendant race. No injection.
    if(!CreateProcessW(exe,command,IntPtr.Zero,IntPtr.Zero,true,0x4,IntPtr.Zero,cwd,ref si,out pi))throw new Win32Exception(Marshal.GetLastWin32Error());
    result.SafeHandle=new SafeProcessHandle(pi.process,true);result.thread=new SafeFileHandle(pi.thread,true);result.Id=pi.pid;
    if(!AssignProcessToJobObject(result.job,result.SafeHandle)) {
     result.LaunchError="AssignProcessToJobObject:"+Marshal.GetLastWin32Error();return result;
    }
    result.AssignedBeforeResume=true;
    var before=result.JobCounts();
    if(before.TotalProcesses!=1||before.ActiveProcesses!=1){result.LaunchError="Initial job ownership not singleton";return result;}
    uint previous=ResumeThread(result.thread);
    if(previous!=1){result.LaunchError="ResumeThread:"+previous+":"+Marshal.GetLastWin32Error();return result;}
    result.Resumed=true;return result;
   }
  } catch(Exception e) {
   if(result.SafeHandle!=null){result.LaunchError=e.GetType().Name+":"+e.Message;return result;}
   result.job.Dispose();throw;
  }
 }
 public Counts JobCounts() {
  Counts c;if(!QueryInformationJobObject(job,1,out c,(uint)Marshal.SizeOf<Counts>(),IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error());return c;
 }
 public bool WaitForExit(int milliseconds) {
  if(milliseconds<0)throw new ArgumentOutOfRangeException(nameof(milliseconds));
  uint status=WaitForSingleObject(SafeHandle,(uint)milliseconds);
  if(status==0)return true;if(status==258)return false;throw new Win32Exception(Marshal.GetLastWin32Error());
 }
 public uint ExitCode { get {uint code;if(!GetExitCodeProcess(SafeHandle,out code))throw new Win32Exception(Marshal.GetLastWin32Error());return code;} }
 public void Kill() {if(!TerminateProcess(SafeHandle,1))throw new Win32Exception(Marshal.GetLastWin32Error());}
 public void Dispose() {if(!WaitForExit(0)||JobCounts().ActiveProcesses!=0)throw new InvalidOperationException("Unsettled fixture handles retained");SafeHandle.Dispose();thread.Dispose();job.Dispose();}
}
