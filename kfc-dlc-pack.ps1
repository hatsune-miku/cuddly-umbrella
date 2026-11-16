param(
  [string]$HostDirectory = (Join-Path $PSScriptRoot '../kook-plugin-tools'),
  [string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist-kfc')
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$hostRoot = [IO.Path]::GetFullPath($HostDirectory)
$definition = Join-Path $root 'dlcs/bifrost'
$manifest = Get-Content -LiteralPath (Join-Path $definition 'dlc.json') -Encoding UTF8 -Raw | ConvertFrom-Json
& node (Join-Path $root 'validate-manifest.mjs') (Join-Path $definition 'kfc.manifest.json') --host (Join-Path $hostRoot 'kfc.manifest.json') --payload (Join-Path $definition 'dlc.json') --version $manifest.version
if ($LASTEXITCODE -ne 0) { throw 'Invalid Bifrost DLC manifest' }

$stage = Join-Path ([IO.Path]::GetTempPath()) ('bifrost-dlc-' + [Guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path (Join-Path $stage 'payload') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $definition 'dlc.json') -Destination $stage
  Copy-Item -LiteralPath (Join-Path $definition 'LICENSE') -Destination $stage
  foreach ($name in @('bifrost.js', 'bifrost-hot-module-bootstrap.js')) {
    $source = Join-Path $root ('apps/console/pc-plugin/' + $name)
    & node --check $source
    if ($LASTEXITCODE -ne 0) { throw "Invalid JavaScript: $name" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $stage 'payload')
  }
  & node (Join-Path $hostRoot 'scripts/validate-dlc-package.cjs') $stage
  if ($LASTEXITCODE -ne 0) { throw 'Host rejected Bifrost DLC' }
  $dist = [IO.Path]::GetFullPath($OutputDirectory)
  New-Item -ItemType Directory -Path $dist -Force | Out-Null
  $artifact = Join-Path $dist ("kook-plugin-tools-bifrost_{0}_windows-x64.zip" -f $manifest.version)
  # Never silently replace a release archive: published DLC bytes are immutable.
  if (Test-Path -LiteralPath $artifact) { throw "Artifact already exists: $artifact. Use a new version or a different output directory." }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory($stage, $artifact)
  Write-Host "Packed Bifrost DLC $($manifest.version): $artifact"
  $sha = [Security.Cryptography.SHA256]::Create()
  try { Write-Host ('SHA256 ' + [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($artifact))).Replace('-', '').ToLowerInvariant()) }
  finally { $sha.Dispose() }
} finally {
  $resolved = [IO.Path]::GetFullPath($stage)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notlike 'bifrost-dlc-*') {
    throw 'Refusing to remove staging outside TEMP'
  }
  if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
