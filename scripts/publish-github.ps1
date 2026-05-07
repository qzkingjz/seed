param(
  [Parameter(Mandatory = $true)]
  [string]$RemoteUrl,

  [string]$Branch = "main",
  [string]$Message = "Initial commit"
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Text)
  Write-Host ""
  Write-Host "==> $Text" -ForegroundColor Cyan
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git is not installed or is not available in PATH."
}

function Invoke-Git {
  & git -c "safe.directory=*" @args
  if ($LASTEXITCODE -ne 0) {
    throw "Git command failed: git $($args -join ' ')"
  }
}

Write-Step "Initializing repository"
if (-not (Test-Path ".git")) {
  git init
}

Invoke-Git branch -M $Branch

Write-Step "Checking ignored secrets"
$ignoredEnv = & git -c "safe.directory=*" check-ignore .env 2>$null
if (-not $ignoredEnv) {
  throw ".env is not ignored. Refusing to publish because it contains secrets."
}

Write-Step "Staging files"
Invoke-Git add .

$envStaged = & git -c "safe.directory=*" diff --cached --name-only | Where-Object { $_ -eq ".env" }
if ($envStaged) {
  throw ".env was staged. Refusing to commit secrets."
}

Write-Step "Creating commit if needed"
$staged = & git -c "safe.directory=*" diff --cached --name-only
if ($staged) {
  Invoke-Git commit -m $Message
} else {
  Write-Host "No staged changes to commit."
}

Write-Step "Configuring remote"
$remoteNames = & git -c "safe.directory=*" remote
if ($remoteNames -contains "origin") {
  Invoke-Git remote set-url origin $RemoteUrl
} else {
  Invoke-Git remote add origin $RemoteUrl
}

Write-Step "Pushing to GitHub"
Invoke-Git push -u origin $Branch

Write-Host ""
Write-Host "Published successfully." -ForegroundColor Green
