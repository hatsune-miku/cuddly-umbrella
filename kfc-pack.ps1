#requires -Version 5.1
<#
.SYNOPSIS
  Package the loadable browser extension for KFC.
.PARAMETER Version
  Version string. It must exactly match apps/browser-extension/manifest.json.
#>
param([Parameter(Mandatory = $true)][string]$Version)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$extensionRoot = Join-Path $root "apps\browser-extension"
$dist = Join-Path $root "dist-kfc"
$stage = Join-Path $dist ".stage-extension-$PID"
$zip = Join-Path $dist "cuddly-browser-extension_${Version}.zip"
$resolvedDist = [System.IO.Path]::GetFullPath($dist)
$resolvedStage = [System.IO.Path]::GetFullPath($stage)
if (-not $resolvedStage.StartsWith($resolvedDist + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Extension staging directory must stay within dist-kfc."
}
$runtimeFiles = @(
  "cakeui.css",
  "cakeui-theme.css",
  "cakeui-dom.js",
  "cakeui-primitives.js",
  "cake-layout.css",
  "auth-session.js",
  "binding-selection.js",
  "branch-picker.js",
  "build-queue.js",
  "build-history.js",
  "config-share.js",
  "configuration-groups.js",
  "environment-selection.js",
  "extension-protocol.js",
  "in-place-url-rules.js",
  "in-place-hot-module-bridge.js",
  "in-place-hot-module-main.js",
  "manifest.json",
  "popup-state.js",
  "popup-tabs.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "sidepanel.html",
  "sidepanel.js",
  "preview-routing.js",
  "service-worker.js"
)

& pnpm --filter "@cuddly/browser-extension" build
if ($LASTEXITCODE -ne 0) {
  throw "Browser extension validation failed with exit code $LASTEXITCODE."
}

$extensionManifestPath = Join-Path $extensionRoot "manifest.json"
$extensionManifest = Get-Content -Raw $extensionManifestPath | ConvertFrom-Json
if ([string]$extensionManifest.version -ne $Version) {
  throw "KFC version '$Version' must exactly match browser extension version '$($extensionManifest.version)'."
}

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

try {
  foreach ($file in $runtimeFiles) {
    $source = Join-Path $extensionRoot $file
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "Required extension runtime file is missing: $file"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $stage $file)
  }

  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
  try {
    $entries = @($archive.Entries | Where-Object { $_.Name } | ForEach-Object { $_.FullName.Replace("\", "/") })
  } finally {
    $archive.Dispose()
  }

  $missing = @($runtimeFiles | Where-Object { $_ -notin $entries })
  $unexpected = @($entries | Where-Object { $_ -notin $runtimeFiles })
  $nested = @($entries | Where-Object { $_.Contains("/") })
  if ($missing.Count -gt 0 -or $unexpected.Count -gt 0 -or $nested.Count -gt 0) {
    throw "Invalid extension archive contents. Missing=[$($missing -join ', ')] Unexpected=[$($unexpected -join ', ')] Nested=[$($nested -join ', ')]"
  }
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}

Write-Host "packed browser extension ($($extensionManifest.name)) -> $zip"
Write-Host "verified $($runtimeFiles.Count) loadable files at the archive root"
