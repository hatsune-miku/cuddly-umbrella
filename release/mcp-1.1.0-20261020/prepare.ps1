param([switch]$Refresh)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$stage = Join-Path $PSScriptRoot 'stage'
if ((Test-Path -LiteralPath $stage) -and -not $Refresh) { throw 'Release stage already exists' }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'apps/control-api/dist/main.js') -Destination $stage
Copy-Item -LiteralPath (Join-Path $root 'docker/console.nginx.conf') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'control.Dockerfile') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'console.Dockerfile') -Destination $stage
& tar -czf (Join-Path $PSScriptRoot 'image.tar.gz') -C $stage .
if ($LASTEXITCODE) { throw 'Image packaging failed' }
$files = @(
  'apps/control-api/src/app.ts', 'apps/control-api/src/main.ts', 'apps/control-api/src/auth-routes.test.ts',
  'apps/control-api/src/mcp-provider.ts', 'apps/control-api/src/mcp-provider.test.ts',
  'apps/control-api/src/mcp-http.ts', 'apps/control-api/src/mcp-http.test.ts',
  'apps/control-api/src/mcp-auth.ts',
  'apps/control-api/package.json', 'apps/control-api/tsup.config.ts', 'apps/control-api/dist/main.js',
  'apps/mcp-server/src', 'apps/mcp-server/dist', 'apps/mcp-server/scripts',
  'apps/mcp-server/package.json', 'apps/mcp-server/client.http.example.json', 'apps/mcp-server/README.md',
  'docker/console.nginx.conf', 'docker/console.nginx.test.ts',
  'pnpm-lock.yaml', 'README.md'
)
& tar -czf (Join-Path $PSScriptRoot 'sources.tar.gz') -C $root @files
if ($LASTEXITCODE) { throw 'Source packaging failed' }
