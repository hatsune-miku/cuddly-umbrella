$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$stage = Join-Path $PSScriptRoot 'stage'
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'apps/console/dist') -Destination (Join-Path $stage 'console') -Recurse
Copy-Item -LiteralPath (Join-Path $root 'apps/control-api/src/app.ts') -Destination (Join-Path $stage 'control-app.ts')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'console.Dockerfile') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'control.Dockerfile') -Destination $stage
& tar -czf (Join-Path $PSScriptRoot 'images.tar.gz') -C $stage .
if ($LASTEXITCODE) { throw 'Image payload packaging failed' }
$files = @(
  'pnpm-lock.yaml', 'kfc-pack.ps1',
  'apps/console/package.json', 'apps/console/scripts',
  'apps/console/src/App.tsx', 'apps/console/src/App.test.ts',
  'apps/console/src/AuthGate.tsx', 'apps/console/src/BranchPicker.tsx',
  'apps/console/src/ConfigurationGroupEditor.tsx', 'apps/console/src/ShareLanding.tsx',
  'apps/console/src/main.tsx', 'apps/console/src/styles.css',
  'apps/console/src/ui.tsx', 'apps/console/src/ui.test.tsx', 'apps/console/src/cake-layout.css',
  'apps/console/public/help', 'apps/console/public/pc-plugin', 'apps/console/public/ui',
  'apps/browser-extension/package.json', 'apps/browser-extension/manifest.json',
  'apps/browser-extension/popup.js', 'apps/browser-extension/popup.html',
  'apps/browser-extension/popup.css', 'apps/browser-extension/branch-picker.js',
  'apps/browser-extension/cake-layout.css', 'apps/browser-extension/cakeui.css',
  'apps/browser-extension/cakeui-theme.css', 'apps/browser-extension/cakeui-dom.js',
  'apps/browser-extension/cakeui-primitives.js',
  'apps/browser-extension/scripts/validate.mjs', 'apps/browser-extension/scripts/cakeui-dom.node.mjs',
  'apps/control-api/src/app.ts', 'packages/ui-theme',
  'docs/CAKEUI_INTEGRATION.md', 'docs/BIFROST_USER_GUIDE.md', 'docs/help/guide.css',
  'docs/scripts/build_help.mjs', 'docs/scripts/capture_help_screens.mjs'
)
& tar -czf (Join-Path $PSScriptRoot 'sources.tar.gz') -C $root @files
if ($LASTEXITCODE) { throw 'Source payload packaging failed' }
Get-FileHash -Algorithm SHA256 (Join-Path $PSScriptRoot 'images.tar.gz'), (Join-Path $PSScriptRoot 'sources.tar.gz')
