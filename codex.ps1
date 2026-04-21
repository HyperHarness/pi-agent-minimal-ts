<#
Codex Windows toolchain entry point.

Read this file first. Another Codex instance should be able to configure and validate
the environment from this script alone.

Stop rule for Codex
- If any required path, project directory, or environment-variable value is unknown, stop immediately and ask the user.
- Do not search the filesystem, PATH, registry, shell profiles, repository files, or package managers to guess Python or Node locations.
- Do not assume common defaults such as `C:\Program Files\nodejs` or an Anaconda path unless the user has already provided them in the conversation or system environment variables are already set.
- If `CODEX_CONDA_ROOT`, `CODEX_CONDA_ENV`, or `CODEX_NODEJS_ROOT` is missing, ask the user to provide the missing value or confirm that the system environment variable has been set.
- If `PythonProjectDir` or `NodeProjectDir` is needed for `lint`, `test`, or `all` and is not provided by argument or environment variable, ask the user for the project directory.
- The correct behavior when information is missing is to ask, not to search.

Purpose
- Run Python and Node validation, lint, and test commands on Windows 11.
- Avoid machine-local hard-coded paths in repository logic.
- Avoid `conda activate` and shell-dependent PATH resolution.

Required system environment variables
- CODEX_CONDA_ROOT: Anaconda installation root
- CODEX_CONDA_ENV: Conda environment name
- CODEX_NODEJS_ROOT: Node.js installation root

Optional environment variables
- CODEX_PYTHON_PROJECT_DIR: default Python project directory
- CODEX_NODE_PROJECT_DIR: default Node project directory

Derived executables
- Python:  %CODEX_CONDA_ROOT%\envs\%CODEX_CONDA_ENV%\python.exe
- Node:    %CODEX_NODEJS_ROOT%\node.exe
- npm:     %CODEX_NODEJS_ROOT%\npm.cmd
- npx:     %CODEX_NODEJS_ROOT%\npx.cmd

Execution rules
- Call the Conda environment's python.exe directly. Do not require `conda activate`.
- Call Node package tools as `npm.cmd` and `npx.cmd`.
- Fail fast when required environment variables or paths are missing.
- Keep normal lint/test runs separate from dependency installation.
- When required inputs are missing, ask the user before taking any discovery action.

Actions
- validate: verify environment variables, resolve executables, print versions
- lint:     run configured lint commands
- test:     run configured test commands
- all:      run validate, then lint, then test

Targets
- py:   Python only
- node: Node.js only
- all:  both stacks

Examples
- powershell -ExecutionPolicy Bypass -File scripts/codex.ps1 validate
- powershell -ExecutionPolicy Bypass -File scripts/codex.ps1 lint -Target py -PythonProjectDir D:\repo\backend
- powershell -ExecutionPolicy Bypass -File scripts/codex.ps1 test -Target node -NodeProjectDir D:\repo\frontend
- powershell -ExecutionPolicy Bypass -File scripts/codex.ps1 all -Target all -PythonProjectDir D:\repo\backend -NodeProjectDir D:\repo\frontend

Validation checklist
1. Set the required system environment variables.
2. Restart terminals and Codex so child processes can see them.
3. Run `scripts/codex.ps1 validate`.
4. Confirm Python, Node, and npm versions print successfully.
5. Only then run `lint`, `test`, or `all`.

Question template for Codex
- "Please provide or confirm `CODEX_CONDA_ROOT`."
- "Please provide or confirm `CODEX_CONDA_ENV`."
- "Please provide or confirm `CODEX_NODEJS_ROOT`."
- "Please provide the Python project directory."
- "Please provide the Node.js project directory."
#>

param(
  [ValidateSet("validate", "lint", "test", "all")]
  [string]$Action = "validate",

  [ValidateSet("py", "node", "all")]
  [string]$Target = "all",

  [string]$PythonProjectDir = $env:CODEX_PYTHON_PROJECT_DIR,
  [string]$NodeProjectDir = $env:CODEX_NODE_PROJECT_DIR,

  [string]$PythonLintModule = "scripts.python_lint",
  [string[]]$PythonLintArgs = @("."),
  [string]$PythonTestModule = "pytest",
  [string[]]$PythonTestArgs = @("-p", "no:cacheprovider", "tests/python"),
  [string]$NodeLintScript = "lint",
  [string]$NodeTestScript = "test"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Require-EnvVar {
  param([string]$Name)

  $Value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "Missing required environment variable: $Name"
  }

  return $Value
}

function Get-ToolchainPaths {
  $Paths = [ordered]@{}

  if (Use-Target -Selected "py") {
    $CondaRoot = Require-EnvVar "CODEX_CONDA_ROOT"
    $CondaEnv = Require-EnvVar "CODEX_CONDA_ENV"

    $Paths.CondaRoot = $CondaRoot
    $Paths.CondaEnv = $CondaEnv
    $Paths.PythonExe = Join-Path $CondaRoot "envs\$CondaEnv\python.exe"
    $Paths.CondaBat = Join-Path $CondaRoot "condabin\conda.bat"
  }

  if (Use-Target -Selected "node") {
    $NodeRoot = Require-EnvVar "CODEX_NODEJS_ROOT"

    $Paths.NodeRoot = $NodeRoot
    $Paths.NodeExe = Join-Path $NodeRoot "node.exe"
    $Paths.NpmCmd = Join-Path $NodeRoot "npm.cmd"
    $Paths.NpxCmd = Join-Path $NodeRoot "npx.cmd"
  }

  return [PSCustomObject]$Paths
}

function Assert-FileExists {
  param(
    [string]$Path,
    [string]$Label
  )

  if (-not (Test-Path $Path -PathType Leaf)) {
    throw "$Label not found: $Path"
  }
}

function Assert-DirectoryExists {
  param(
    [string]$Path,
    [string]$Label
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw "$Label is required"
  }

  if (-not (Test-Path $Path -PathType Container)) {
    throw "$Label not found: $Path"
  }
}

function Invoke-Checked {
  param(
    [string]$Executable,
    [string[]]$Arguments,
    [string]$Description
  )

  Write-Host ">> $Description"
  & $Executable @Arguments
  $ExitCode = $LASTEXITCODE
  if ($ExitCode -ne 0) {
    throw "$Description failed with exit code $ExitCode"
  }
}

function Use-Target {
  param([string]$Selected)

  return $Target -eq "all" -or $Target -eq $Selected
}

function Invoke-InDirectory {
  param(
    [string]$Path,
    [scriptblock]$Script
  )

  Push-Location $Path
  try {
    & $Script
  }
  finally {
    Pop-Location
  }
}

function Invoke-Validate {
  param([pscustomobject]$Paths)

  if (Use-Target -Selected "py") {
    Assert-FileExists -Path $Paths.PythonExe -Label "Python executable"
    Write-Host "PythonExe=$($Paths.PythonExe)"
    Invoke-Checked -Executable $Paths.PythonExe -Arguments @("--version") -Description "Validate Python"
  }

  if (Use-Target -Selected "node") {
    Assert-FileExists -Path $Paths.NodeExe -Label "Node executable"
    Assert-FileExists -Path $Paths.NpmCmd -Label "npm executable"
    Write-Host "NodeExe=$($Paths.NodeExe)"
    Write-Host "NpmCmd=$($Paths.NpmCmd)"
    Invoke-Checked -Executable $Paths.NodeExe -Arguments @("--version") -Description "Validate Node.js"
    Invoke-Checked -Executable $Paths.NpmCmd -Arguments @("--version") -Description "Validate npm"
  }
}

function Invoke-PythonLint {
  param([pscustomobject]$Paths)

  Assert-DirectoryExists -Path $PythonProjectDir -Label "PythonProjectDir"
  Invoke-InDirectory -Path $PythonProjectDir -Script {
    Invoke-Checked -Executable $Paths.PythonExe -Arguments (@("-m", $PythonLintModule) + $PythonLintArgs) -Description "Python lint"
  }
}

function Invoke-PythonTest {
  param([pscustomobject]$Paths)

  Assert-DirectoryExists -Path $PythonProjectDir -Label "PythonProjectDir"
  Invoke-InDirectory -Path $PythonProjectDir -Script {
    Invoke-Checked -Executable $Paths.PythonExe -Arguments (@("-m", $PythonTestModule) + $PythonTestArgs) -Description "Python test"
  }
}

function Invoke-NodeLint {
  param([pscustomobject]$Paths)

  Assert-DirectoryExists -Path $NodeProjectDir -Label "NodeProjectDir"
  Invoke-InDirectory -Path $NodeProjectDir -Script {
    Invoke-Checked -Executable $Paths.NpmCmd -Arguments @("run", $NodeLintScript) -Description "Node lint"
  }
}

function Invoke-NodeTest {
  param([pscustomobject]$Paths)

  Assert-DirectoryExists -Path $NodeProjectDir -Label "NodeProjectDir"
  Invoke-InDirectory -Path $NodeProjectDir -Script {
    Invoke-Checked -Executable $Paths.NpmCmd -Arguments @("run", $NodeTestScript) -Description "Node test"
  }
}

switch ($Action) {
  "validate" {
    $Paths = Get-ToolchainPaths
    Invoke-Validate -Paths $Paths
  }
  "lint" {
    $Paths = Get-ToolchainPaths
    if (Use-Target -Selected "py") { Invoke-PythonLint -Paths $Paths }
    if (Use-Target -Selected "node") { Invoke-NodeLint -Paths $Paths }
  }
  "test" {
    $Paths = Get-ToolchainPaths
    if (Use-Target -Selected "py") { Invoke-PythonTest -Paths $Paths }
    if (Use-Target -Selected "node") { Invoke-NodeTest -Paths $Paths }
  }
  "all" {
    $Paths = Get-ToolchainPaths
    Invoke-Validate -Paths $Paths
    if (Use-Target -Selected "py") { Invoke-PythonLint -Paths $Paths }
    if (Use-Target -Selected "node") { Invoke-NodeLint -Paths $Paths }
    if (Use-Target -Selected "py") { Invoke-PythonTest -Paths $Paths }
    if (Use-Target -Selected "node") { Invoke-NodeTest -Paths $Paths }
  }
}
