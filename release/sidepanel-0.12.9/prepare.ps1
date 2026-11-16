$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$stage = Join-Path $PSScriptRoot 'stage'
if (Test-Path -LiteralPath $stage) { throw 'Release stage already exists' }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'apps/console/dist') -Destination (Join-Path $stage 'console') -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'console.Dockerfile') -Destination $stage
& tar -czf (Join-Path $PSScriptRoot 'images.tar.gz') -C $stage .
if ($LASTEXITCODE) { throw 'Image payload packaging failed' }
$files = @(
  'apps/browser-extension', 'apps/console/pc-plugin', 'apps/console/scripts/sync-pc-plugin.mjs',
  'apps/console/public/help', 'apps/console/public/pc-plugin', 'apps/console/public/ui',
  'docs/CAKEUI_INTEGRATION.md', 'docs/BIFROST_USER_GUIDE.md',
  'docs/scripts/capture_help_screens.mjs', 'kfc-pack.ps1'
)
& tar --exclude=node_modules -czf (Join-Path $PSScriptRoot 'sources.tar.gz') -C $root @files
if ($LASTEXITCODE) { throw 'Source payload packaging failed' }
Get-FileHash -Algorithm SHA256 (Join-Path $PSScriptRoot 'images.tar.gz'), (Join-Path $PSScriptRoot 'sources.tar.gz')
