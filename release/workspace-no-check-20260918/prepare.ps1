$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$stage = Join-Path $PSScriptRoot 'stage'
if (Test-Path -LiteralPath $stage) { throw 'Release stage already exists' }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'apps/runner-agent/dist/main.js') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runner.Dockerfile') -Destination $stage
& tar -czf (Join-Path $PSScriptRoot 'image.tar.gz') -C $stage .
if ($LASTEXITCODE) { throw 'Image packaging failed' }
$files = @(
  'apps/runner-agent/src/runner.ts', 'apps/runner-agent/src/runner.test.ts',
  'apps/runner-agent/src/typescript-build.ts', 'apps/runner-agent/src/typescript-build.test.ts',
  'apps/runner-agent/scripts/verify-unchecked-types.ts',
  'apps/runner-agent/package.json', 'pnpm-lock.yaml', 'apps/runner-agent/dist/main.js'
)
& tar -czf (Join-Path $PSScriptRoot 'sources.tar.gz') -C $root @files
if ($LASTEXITCODE) { throw 'Source packaging failed' }
