# Qualification-only reservation. This is NOT a product handoff resolver override.
# These helpers never start OpenClaw executors; Node SQLite probes use :memory:.
function Assert-QualificationStore {
    param([Parameter(Mandatory=$true)][string]$Path)
    $full=[IO.Path]::GetFullPath($Path)
    if($full -cne $Path -or $env:OPENCLAW_QUALIFICATION_HANDOFF_DB -cne $full){throw 'Explicit private handoff-store injection missing.'}
    $parent=Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($full)) -Force
    if($parent.Name -cnotmatch '^qualification125286-[0-9a-f]{32}$'){throw 'Not a task-owned qualification root.'}
    $current=$parent
    while($null -ne $current){
        if($current.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Private store ancestor is a reparse alias.'}
        $current=$current.Parent
    }
    if([IO.Path]::GetFileName($full) -cne 'handoff.sqlite' -or (Test-Path -LiteralPath $full)){throw 'Private store must be a fresh reserved path.'}
    return [IO.Path]::Combine($parent.FullName,'handoff.sqlite')
}
