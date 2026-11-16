$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$stage = Join-Path $PSScriptRoot 'stage'
if (Test-Path -LiteralPath $stage) { throw 'Release stage already exists' }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'apps/control-api/dist/main.js') -Destination (Join-Path $stage 'control-main.js')
Copy-Item -LiteralPath (Join-Path $root 'apps/runner-agent/dist/main.js') -Destination (Join-Path $stage 'runner-main.js')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'control.Dockerfile') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runner.Dockerfile') -Destination $stage
& tar -czf (Join-Path $PSScriptRoot 'image.tar.gz') -C $stage .
if ($LASTEXITCODE) { throw 'Image packaging failed' }
$files = @(
  'packages/contracts/src/index.ts', 'packages/contracts/src/index.test.ts',
  'packages/db/src/project-templates.ts', 'packages/db/src/project-templates.test.ts',
  'packages/db/src/memory-store.test.ts',
  'apps/runner-agent/src/runner.ts', 'apps/runner-agent/src/runner.test.ts',
  'apps/runner-agent/dist/main.js', 'apps/control-api/dist/main.js', 'README.md'
)
& tar -czf (Join-Path $PSScriptRoot 'sources.tar.gz') -C $root @files
if ($LASTEXITCODE) { throw 'Source packaging failed' }
