$pipes = [System.IO.Directory]::GetFiles("\\.\pipe\")
$matches_ = $pipes | Where-Object { $_ -like "*neelima*" }
if ($matches_) { $matches_ | ForEach-Object { Write-Output $_ } } else { Write-Output "NO-NEELIMA-PIPES" }
