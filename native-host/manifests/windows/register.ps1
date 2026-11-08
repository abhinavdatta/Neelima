<#
.SYNOPSIS
    Registers the Neelima Browser Bridge native messaging host for Chrome/Edge on Windows.

.DESCRIPTION
    This script creates the necessary registry keys for Chrome and Edge to discover
    the native messaging host. It must be run after building the native host binary
    and placing it in the correct location.

.NOTES
    Requires Administrator privileges for HKLM registration, or runs for current user (HKCU).
    The extension ID must be provided (from chrome://extensions after loading the extension).
#>

param(
    [switch]$AllUsers,
    [switch]$Unregister,
    [Parameter(Mandatory=$false)]
    [string]$ExtensionId
)

$hostName = "com.neelima.browser_bridge"
$manifestName = "$hostName.json"
$binaryName = "neelima_native_host.exe"

# Determine install directory
$installDir = Join-Path $env:LOCALAPPDATA "Neelima"
$binaryPath = Join-Path $installDir $binaryName
$manifestPath = Join-Path $installDir $manifestName

if ($Unregister) {
    Write-Host "Unregistering $hostName..." -ForegroundColor Yellow

    $regPaths = @(
        "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
        "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
    )

    if ($AllUsers) {
        $regPaths += @(
            "HKLM:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
            "HKLM:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
        )
    }

    foreach ($path in $regPaths) {
        if (Test-Path $path) {
            Remove-Item $path -Force
            Write-Host "Removed: $path" -ForegroundColor Green
        }
    }

    Write-Host "Unregistration complete." -ForegroundColor Green
    exit 0
}

# Verify binary exists
if (-not (Test-Path $binaryPath)) {
    Write-Error "Native host binary not found at: $binaryPath"
    Write-Host "Please build the native host first: cargo build --release -p neelima-native-host" -ForegroundColor Yellow
    exit 1
}

# Determine allowed origin
$allowedOrigin = if ($ExtensionId) {
    "chrome-extension://$ExtensionId/"
} else {
    Write-Host "No ExtensionId provided. Using placeholder - you MUST update the manifest after installing the extension." -ForegroundColor Yellow
    "chrome-extension://gcjjbofmdcdfdofapeefmdgkldpibokp/"
}

# Create manifest JSON
$manifest = @{
    name = $hostName
    description = "Neelima Browser Bridge Native Messaging Host"
    path = $binaryPath
    type = "stdio"
    allowed_origins = @($allowedOrigin)
} | ConvertTo-Json -Depth 3

# Write manifest to install directory
$manifest | Out-File -FilePath $manifestPath -Encoding utf8
Write-Host "Manifest written to: $manifestPath" -ForegroundColor Green

# Register for current user (HKCU)
$hkcuPaths = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
)

foreach ($path in $hkcuPaths) {
    $parent = Split-Path $path -Parent
    if (-not (Test-Path $parent)) {
        New-Item -Path $parent -ItemType Directory -Force | Out-Null
    }
    New-ItemProperty -Path $path -Name "(Default)" -Value $manifestPath -PropertyType String -Force | Out-Null
    Write-Host "Registered (HKCU): $path" -ForegroundColor Green
}

# Register for all users (HKLM) if requested
if ($AllUsers) {
    $hkLMPaths = @(
        "HKLM:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
        "HKLM:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
    )

    foreach ($path in $hkLMPaths) {
        $parent = Split-Path $path -Parent
        if (-not (Test-Path $parent)) {
            New-Item -Path $parent -ItemType Directory -Force | Out-Null
        }
        New-ItemProperty -Path $path -Name "(Default)" -Value $manifestPath -PropertyType String -Force | Out-Null
        Write-Host "Registered (HKLM): $path" -ForegroundColor Green
    }
}

Write-Host "`nRegistration complete!" -ForegroundColor Green
Write-Host "Binary: $binaryPath" -ForegroundColor Cyan
Write-Host "Manifest: $manifestPath" -ForegroundColor Cyan
if (-not $ExtensionId) {
    Write-Host "`nIMPORTANT: You must update the manifest with your actual extension ID:" -ForegroundColor Red
    Write-Host "  1. Install the extension in Chrome/Edge (load unpacked from browser-extension/)" -ForegroundColor Yellow
    Write-Host "  2. Go to chrome://extensions, enable Developer mode, find 'Neelima Browser Bridge'" -ForegroundColor Yellow
    Write-Host "  3. Copy the Extension ID (32 lowercase letters)" -ForegroundColor Yellow
    Write-Host "  4. Re-run this script: .\\register.ps1 -ExtensionId <YOUR_EXTENSION_ID>" -ForegroundColor Yellow
    Write-Host "  5. Reload the extension" -ForegroundColor Yellow
}