$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$version = '26.2.6'
$expected = 'F9877032FD908BEB9C0DDF06DF4AF5C2E85F419C42E14876C4CCE5AAE5FB2660'
$url = "https://download.documentfoundation.org/libreoffice/stable/$version/win/x86_64/LibreOffice_${version}_Win_x86-64.msi"
$cache = Join-Path $appRoot "work/LibreOffice_${version}_Win_x86-64.msi"
$target = Join-Path $appRoot 'runtime/office'
$manifest = Join-Path $appRoot 'runtime/office-manifest.json'
New-Item -ItemType Directory -Path (Join-Path $appRoot 'work') -Force | Out-Null
if (!(Test-Path -LiteralPath $cache)) { Invoke-WebRequest -Uri $url -OutFile $cache }
if ((Get-FileHash -LiteralPath $cache -Algorithm SHA256).Hash -ne $expected) { throw 'Office package hash does not match the pinned official release.' }
if ((Get-AuthenticodeSignature -LiteralPath $cache).Status -ne 'Valid') { throw 'Office package signature is invalid.' }
if (Test-Path -LiteralPath $target) {
  if (!(Test-Path -LiteralPath $manifest) -or (Get-Content -LiteralPath $manifest | ConvertFrom-Json).sha256 -ne $expected) { throw 'An unverified Office runtime already exists. Inspect it before replacing it.' }
} else {
  # Administrative image extraction does not register or launch an installed app.
  $staging = Join-Path $appRoot ('work/office-stage-' + [guid]::NewGuid())
  $log = Join-Path $appRoot 'work/office-stage.log'
  $process = Start-Process -FilePath msiexec.exe -ArgumentList @('/a',('"' + $cache + '"'),'/qn',('TARGETDIR="' + $staging + '"'),'/L*v',('"' + $log + '"')) -WindowStyle Hidden -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "Office extraction failed: $($process.ExitCode). See $log" }
  New-Item -ItemType Directory -Path $target | Out-Null
  Get-ChildItem -LiteralPath $staging | Where-Object { $_.Extension -ne '.msi' } | Copy-Item -Destination $target -Recurse
  @{version=$version; source=$url; sha256=$expected; license='office/LICENSE.html'; extraction='MSI administrative image; no global installation'} | ConvertTo-Json | Set-Content -LiteralPath $manifest
}
& (Join-Path $target 'program/soffice.com') --headless --version
if ($LASTEXITCODE) { throw 'The staged Office runtime did not start.' }
