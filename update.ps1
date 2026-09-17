# GradFill — update to the latest version.
# Right-click this file and choose "Run with PowerShell", or run:
#   powershell -ExecutionPolicy Bypass -File update.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "GradFill updater" -ForegroundColor Cyan
Write-Host "----------------"

if (-not (Test-Path ".git")) {
    Write-Host "This folder isn't a git repo yet." -ForegroundColor Yellow
    Write-Host "Set it up once with:"
    Write-Host "    git init"
    Write-Host "    git remote add origin <your repo url>"
    Write-Host "    git fetch origin && git reset --hard origin/main"
    Write-Host ""
    Write-Host "After that, this script keeps you current."
    exit 1
}

# Your saved details live in Chrome, not in this folder, so a hard reset
# is safe. Local edits to rules.js would be lost, though — stash them.
$dirty = git status --porcelain
if ($dirty) {
    Write-Host "You have local changes. Stashing them first." -ForegroundColor Yellow
    git stash push -m "gradfill-local-$(Get-Date -Format yyyyMMdd-HHmmss)" | Out-Null
    Write-Host "Recover them later with: git stash pop"
}

$before = (Get-Content manifest.json | ConvertFrom-Json).version

git fetch origin | Out-Null
git reset --hard origin/main | Out-Null

$after = (Get-Content manifest.json | ConvertFrom-Json).version

Write-Host ""
if ($before -eq $after) {
    Write-Host "Already on v$after. Nothing to do." -ForegroundColor Green
} else {
    Write-Host "Updated: v$before -> v$after" -ForegroundColor Green
    if (Test-Path "CHANGELOG.md") {
        Write-Host ""
        Get-Content CHANGELOG.md -TotalCount 20
    }
    Write-Host ""
    Write-Host "One step left:" -ForegroundColor Cyan
    Write-Host "  Open chrome://extensions and click the reload arrow on GradFill."
    Write-Host "  Your saved details carry over untouched."
}
Write-Host ""
