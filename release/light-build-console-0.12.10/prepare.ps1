$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$stage = Join-Path $PSScriptRoot 'stage'
if (Test-Path -LiteralPath $stage) { throw 'Release stage already exists' }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'apps/console/dist') -Destination (Join-Path $stage 'console') -Recurse
Copy-Item -LiteralPath (Join-Path $root 'apps/runner-agent/dist/main.js') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'console.Dockerfile'), (Join-Path $PSScriptRoot 'runner.Dockerfile') -Destination $stage
& tar -czf (Join-Path $PSScriptRoot 'images.tar.gz') -C $stage .
if ($LASTEXITCODE) { throw 'Image packaging failed' }
$files = @(
  'apps/console/src/cake-layout.css', 'apps/browser-extension/cake-layout.css',
  'apps/browser-extension/manifest.json', 'apps/browser-extension/scripts/validate.mjs',
  'apps/console/public/help', 'apps/console/public/pc-plugin',
  'apps/runner-agent/src/runner.ts', 'apps/runner-agent/src/runner.test.ts', 'apps/runner-agent/dist/main.js',
  'docs/scripts/capture_help_screens.mjs', 'docs/BIFROST_USER_GUIDE.md', 'docs/CAKEUI_INTEGRATION.md'
)
& tar -czf (Join-Path $PSScriptRoot 'sources.tar.gz') -C $root @files
if ($LASTEXITCODE) { throw 'Source packaging failed' }
