param(
    [string]$Python = "py",
    [string]$Venv = "",
    [string]$Wheelhouse = "",
    [switch]$Offline
)
$ErrorActionPreference = "Stop"
$setupArgs = @()
if ($Python -eq "py") { $setupArgs += "-3.12" }
$setupArgs += (Join-Path $PSScriptRoot "setup_python.py")
if ($Venv) { $setupArgs += @("--venv", $Venv) }
if ($Wheelhouse) { $setupArgs += @("--wheelhouse", $Wheelhouse) }
if ($Offline) { $setupArgs += "--offline" }
& $Python @setupArgs
if ($LASTEXITCODE -ne 0) { throw "Python setup failed ($LASTEXITCODE)" }
