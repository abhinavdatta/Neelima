# Measures Neelima's resource budget (acceptance criteria from the spec).
# Usage: powershell -NoProfile -File scripts\measure.ps1 -ExePath target\release\neelima.exe
param(
    [string]$ExePath = "target\release\neelima.exe"
)
$ErrorActionPreference = "Continue"

function Get-DescendantIds([int]$RootPid) {
    $map = @{}
    Get-CimInstance Win32_Process | ForEach-Object {
        $pp = [int]$_.ParentProcessId
        if (-not $map.ContainsKey($pp)) { $map[$pp] = New-Object System.Collections.ArrayList }
        [void]$map[$pp].Add([int]$_.ProcessId)
    }
    $out = New-Object System.Collections.ArrayList
    $stack = New-Object System.Collections.ArrayList
    [void]$stack.Add($RootPid)
    while ($stack.Count -gt 0) {
        $cur = $stack[$stack.Count - 1]
        $stack.RemoveAt($stack.Count - 1)
        if ($map.ContainsKey($cur)) {
            foreach ($c in $map[$cur]) {
                [void]$out.Add($c)
                [void]$stack.Add($c)
            }
        }
    }
    return ,$out
}

# Scenario A: idle with the main UI only (no provider webview mounted).
$p = Start-Process -FilePath $ExePath -PassThru
Start-Sleep -Seconds 8
$app = Get-Process -Id $p.Id
if (-not $app) { Write-Output "APP FAILED TO LAUNCH"; exit 1 }
$cpu0 = $app.TotalProcessorTime
Start-Sleep -Seconds 20
$app.Refresh()
$cpuPct = [math]::Round(($app.TotalProcessorTime - $cpu0).TotalSeconds / 20 * 100, 2)

$ids = Get-DescendantIds $p.Id
$tree = Get-Process | Where-Object { $ids -contains $_.Id }
$treeSum = 0
foreach ($t in $tree) { $treeSum += $t.WorkingSet64 }
$wvCount = ($tree | Where-Object { $_.Name -like "msedgewebview2*" }).Count

Write-Output "=== Neelima resource measurement $(Get-Date -Format 'yyyy-MM-dd HH:mm') ==="
Write-Output ("A. idle, main UI only:")
Write-Output ("   neelima.exe working set: {0} MB (private {1} MB)" -f [math]::Round($app.WorkingSet64/1MB,1), [math]::Round($app.PrivateMemorySize64/1MB,1))
Write-Output ("   child tree: {0} processes ({1} msedgewebview2), tree WS total: {2} MB" -f $tree.Count, $wvCount, [math]::Round(($treeSum + $app.WorkingSet64)/1MB,1))
Write-Output ("   idle CPU over 20s: {0}%" -f $cpuPct)
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Write-Output "=== done ==="
