# Watches one update install from outside Ghidorah. The app starts it just before it quits to install, with the watch
# file it wrote (UpdateWatch in app/updates.ts). The new version counts as working once its window has loaded: it sets
# "opened" in the watch file. After Restart to update this script starts the new version (hidden if Ghidorah was hidden);
# after an install on quit it starts it once with --update-check, which loads the window out of sight and exits. If
# "opened" is not set 60 s after the installer has finished, the version before is downloaded from the releases page and
# installed into the same folder, and after Restart to update it is started; its update window then says so.
# Every step goes into update-watch.log beside the watch file.
param([Parameter(Mandatory = $true)][string]$Watch)
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$log = [IO.Path]::ChangeExtension($Watch, '.log')
function Log($text) { Add-Content $log ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $text) }
try {
  $w = Get-Content $Watch -Raw | ConvertFrom-Json
  function Opened { try { (Get-Content $Watch -Raw | ConvertFrom-Json).opened -eq $true } catch { $false } }
  function Until($test, $seconds) { $end = (Get-Date).AddSeconds($seconds); while ((Get-Date) -lt $end) { if (& $test) { return $true }; Start-Sleep -Milliseconds 500 }; $false }
  function Installing { @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -eq $w.installer }).Count -gt 0 }
  function InFolder { @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($w.dir + '\', 'OrdinalIgnoreCase') }) }
  function Open { if ($w.hidden) { Start-Process $w.exe '--hidden' } else { Start-Process $w.exe } }
  Log "watching $($w.from) to $($w.to) in $($w.dir), restart $($w.restart)"

  # Ghidorah quits, then the installer runs and finishes.
  Log ('Ghidorah closed: ' + (Until { -not (Get-Process -Id $w.pid -ErrorAction SilentlyContinue) } 300))
  Log ('installer seen: ' + (Until { Installing } 60))
  Log ('installer finished: ' + (Until { -not (Installing) } 1800))
  $check = if ($w.restart) { Open } else { Start-Process $w.exe '--update-check' -PassThru }
  $ok = Until { Opened } 60
  Log "new version opened: $ok"
  if ($check) { if (-not $check.WaitForExit(15000)) { Stop-Process -Id $check.Id -Force -ErrorAction SilentlyContinue } }
  if ($ok) { Remove-Item $Watch -Force; return }

  # The new version did not open: the version before comes back from the releases page.
  InFolder | Stop-Process -Force -ErrorAction SilentlyContinue
  $setup = Join-Path ([IO.Path]::GetTempPath()) "Ghidorah-$($w.from)-Setup.exe"
  Log "downloading $($w.previous)"
  Invoke-WebRequest $w.previous -OutFile $setup -UseBasicParsing
  Start-Process $setup -ArgumentList '/S', "/D=$($w.dir)" -Wait
  Remove-Item $setup -Force -ErrorAction SilentlyContinue
  $w | Add-Member rolledBack $true -Force
  $w | ConvertTo-Json | Set-Content $Watch -Encoding UTF8
  Log "$($w.from) is back"
  if ($w.restart) { Open }
} catch { Log ('failed: ' + $_.Exception.Message); throw }
