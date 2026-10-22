param([Parameter(Mandatory = $true)][string]$Python)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$forkRoot = Join-Path $appRoot 'hermes'
$previousPython = $env:HERMES_PYTHON
$env:HERMES_PYTHON = (Resolve-Path -LiteralPath $Python).Path.Replace('\','/')
$sliceTests = (Join-Path $appRoot 'tests/test_backend_security.py').Replace('\','/')
Push-Location -LiteralPath $forkRoot
try {
  & 'C:\Program Files\Git\bin\bash.exe' scripts/run_tests.sh -j 2 --file-timeout 150 --file-retries 0 $sliceTests tests/agent/test_shared_http_transport.py tests/agent/test_create_openai_client_reuse.py -- -q --tb=short
  if ($LASTEXITCODE -ne 0) { throw "Backend checks failed: $LASTEXITCODE" }
} finally { Pop-Location; $env:HERMES_PYTHON = $previousPython }
