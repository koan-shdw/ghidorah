$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$forkRoot = Join-Path $appRoot 'hermes'
Push-Location -LiteralPath $appRoot
try {
  & uv python install 3.12.10 --install-dir runtime/python --no-bin --no-registry
  if ($LASTEXITCODE) { throw 'Python download failed' }
  New-Item -ItemType Directory -Path work -Force | Out-Null
  & uv export --project $forkRoot --frozen --no-dev --extra mcp --extra vertex --extra anthropic --no-emit-project --format requirements-txt --output-file work/runtime-requirements.txt | Out-Null
  if ($LASTEXITCODE) { throw 'Lockfile export failed' }
  # This interpreter belongs exclusively to the app; no system Python is modified.
  & uv pip install --python runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe --break-system-packages --require-hashes -r work/runtime-requirements.txt
  if ($LASTEXITCODE) { throw 'Runtime dependency installation failed' }
  & uv pip install --python runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe --break-system-packages --require-hashes --no-build -r backend/document-requirements.txt
  if ($LASTEXITCODE) { throw 'Document dependency installation failed' }
  & "$PSScriptRoot/stage-office.ps1"
  & node scripts/stage-runtime.mjs
  if ($LASTEXITCODE) { throw 'Hermes staging failed' }
} finally { Pop-Location }
