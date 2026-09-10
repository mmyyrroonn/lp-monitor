param([Parameter(Mandatory=$true)][string]$Stage, [Parameter(Mandatory=$true)][int]$MaxMinutes)
$ErrorActionPreference = 'Stop'
if ($Stage -notin @('smoke','soak')) { throw 'Invalid stage' }
if ($MaxMinutes -lt 1 -or $MaxMinutes -gt 160) { throw 'Invalid observation bound' }
$p6Root = 'E:\lp-monitor'
$p6Output = Join-Path $p6Root "artifacts\p6\$Stage-resources.jsonl"
if (Test-Path -LiteralPath $p6Output) { throw 'Resource output already exists' }
$p6Candidates = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*dist/cli.js follow*' -and $_.CommandLine -like '*data/p6.sqlite*' })
if ($p6Candidates.Count -ne 1) { throw 'Expected exactly one P6 follow process' }
$p6ProcessId = $p6Candidates[0].ProcessId
$p6Deadline = [DateTime]::UtcNow.AddMinutes($MaxMinutes)
$p6Utf8 = New-Object System.Text.UTF8Encoding($false)
while ([DateTime]::UtcNow -lt $p6Deadline) {
  $p6Process = Get-Process -Id $p6ProcessId -ErrorAction SilentlyContinue
  if (-not $p6Process) { break }
  $p6Health = $null
  try { $p6Health = Get-Content -LiteralPath (Join-Path $p6Root 'data\p6.sqlite.health.json') -Raw | ConvertFrom-Json } catch { }
  $p6Sample = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); pid = $p6ProcessId; cpuSeconds = $p6Process.CPU; rssBytes = $p6Process.WorkingSet64; privateBytes = $p6Process.PrivateMemorySize64; state = $p6Health.runtimeState; sampledAtMs = $p6Health.sampledAtMs; head = $p6Health.head.blockNumber; scanned = $p6Health.scanned.blockNumber; gapBlocks = $p6Health.headGapBlocks; dbBytes = $p6Health.dbBytes; walBytes = $p6Health.walBytes; pending = $p6Health.outboxPending; processingMs = $p6Health.processingLatencyMs }
  $p6Line = $p6Sample | ConvertTo-Json -Compress
  [System.IO.File]::AppendAllText($p6Output, $p6Line + [Environment]::NewLine, $p6Utf8)
  Write-Output $p6Line
  Start-Sleep -Seconds 30
}
Write-Output ('Resource observation ended: ' + $Stage)
