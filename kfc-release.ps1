#requires -Version 5.1
<#
.SYNOPSIS
  Validate, package, and publish the product to KFC without performing git operations.
.PARAMETER Version
  Version string. It must exactly match the browser extension manifest version.
.PARAMETER Hub
  KFC Hub origin. Defaults to KFC_HUB or the production KFC Hub.
.PARAMETER Token
  KFC publishing token. Defaults to KFC_TOKEN inside the canonical publisher.
.PARAMETER DryRun
  Validate and resolve artifacts without uploading them.
#>
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Hub,
  [string]$Token,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$resolvedHub = if ($Hub) { $Hub } elseif ($env:KFC_HUB) { $env:KFC_HUB } else { "https://kfc-api.vanillacake.cn" }

$websiteManifest = "$PSScriptRoot\kfc.manifest.json"
$extensionManifest = "$PSScriptRoot\apps\browser-extension\kfc.manifest.json"
foreach ($manifest in @($websiteManifest, $extensionManifest)) {
  & node "$PSScriptRoot\validate-manifest.mjs" $manifest
  if ($LASTEXITCODE -ne 0) { throw "KFC manifest validation failed for '$manifest' with exit code $LASTEXITCODE." }
}

& "$PSScriptRoot\kfc-pack.ps1" -Version $Version

foreach ($manifest in @($extensionManifest, $websiteManifest)) {
  $publishArgs = @(
    "$PSScriptRoot\kfc-publish.mjs",
    "--version", $Version,
    "--hub", $resolvedHub,
    "--manifest", $manifest,
    "--dist", "$PSScriptRoot\dist-kfc"
  )
  if ($Token) { $publishArgs += @("--token", $Token) }
  if ($DryRun) { $publishArgs += "--dry-run" }

  & node @publishArgs
  if ($LASTEXITCODE -ne 0) { throw "KFC publish failed for '$manifest' with exit code $LASTEXITCODE." }
}
