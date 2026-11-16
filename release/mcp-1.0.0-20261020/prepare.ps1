$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$stage = Join-Path $PSScriptRoot 'stage'
if (Test-Path -LiteralPath $stage) { throw 'Release stage already exists' }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'apps/control-api/dist/main.js') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'control.Dockerfile') -Destination $stage
& tar -czf (Join-Path $PSScriptRoot 'image.tar.gz') -C $stage .
if ($LASTEXITCODE) { throw 'Image packaging failed' }
$files = @(
  'apps/control-api/src/app.ts', 'apps/control-api/src/auth-routes.test.ts',
  'apps/control-api/src/mcp-auth.ts', 'apps/control-api/src/mcp-auth.test.ts',
  'apps/control-api/package.json', 'apps/control-api/dist/main.js',
  'apps/mcp-server/src', 'apps/mcp-server/scripts', 'apps/mcp-server/dist',
  'apps/mcp-server/package.json', 'apps/mcp-server/tsconfig.json', 'apps/mcp-server/tsup.config.ts',
  'apps/mcp-server/prettier.config.mjs', 'apps/mcp-server/client.example.json', 'apps/mcp-server/README.md',
  'package.json', 'pnpm-lock.yaml', 'README.md'
)
& tar -czf (Join-Path $PSScriptRoot 'sources.tar.gz') -C $root @files
if ($LASTEXITCODE) { throw 'Source packaging failed' }
