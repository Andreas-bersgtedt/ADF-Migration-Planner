param(
    [string]$RepoUrl,
    [string]$Branch = "main",
    [switch]$UseCurrentRepo,
    [switch]$BootstrapOnly,
    [switch]$SkipInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Require-Command {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found on PATH."
    }
}

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message,
        [Parameter(Mandatory = $true)]
        [scriptblock]$Action
    )

    Write-Host "==> $Message" -ForegroundColor Cyan
    & $Action
}

function Stop-BackendProcess {
    param(
        [System.Diagnostics.Process]$Process
    )

    if (-not $Process) {
        return
    }

    try {
        if (-not $Process.HasExited) {
            Write-Host "Stopping backend API process (PID $($Process.Id))..." -ForegroundColor Yellow
            & taskkill /PID $Process.Id /T | Out-Null

            if (-not $Process.HasExited) {
                Stop-Process -Id $Process.Id -Force
            }
        }
    } catch {
        Write-Warning "Failed to stop backend process PID $($Process.Id): $($_.Exception.Message)"
    }
}

function Stop-RepoNodeProcesses {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $normalizedRepoRoot = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd('\\')
    $stoppedAny = $false

    try {
        $nodeProcesses = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"
    } catch {
        Write-Warning "Could not query running node.exe processes: $($_.Exception.Message)"
        return
    }

    foreach ($nodeProcess in $nodeProcesses) {
        $commandLine = [string]$nodeProcess.CommandLine
        if ([string]::IsNullOrWhiteSpace($commandLine)) {
            continue
        }

        if ($commandLine.IndexOf($normalizedRepoRoot, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            continue
        }

        try {
            Write-Host "Stopping repo node process (PID $($nodeProcess.ProcessId))..." -ForegroundColor Yellow
            Stop-Process -Id $nodeProcess.ProcessId -Force -ErrorAction Stop
            $stoppedAny = $true
        } catch {
            Write-Warning "Failed to stop node process PID $($nodeProcess.ProcessId): $($_.Exception.Message)"
        }
    }

    if ($stoppedAny) {
        Start-Sleep -Milliseconds 400
    }
}

function Remove-DirectoryWithRetry {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [int]$Attempts = 3
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
        if (-not (Test-Path $Path)) {
            return
        }

        try {
            Remove-Item -Path $Path -Recurse -Force -ErrorAction Stop
            return
        } catch {
            if ($attempt -lt $Attempts) {
                Start-Sleep -Milliseconds (400 * $attempt)
            } else {
                throw
            }
        }
    }
}

Require-Command -Name "npm"

$repoRoot = $PSScriptRoot
Write-Host "Using repository folder at $repoRoot" -ForegroundColor Yellow

$useGit = -not [string]::IsNullOrWhiteSpace($RepoUrl)
if ($useGit) {
    Require-Command -Name "git"
    $gitFolder = Join-Path $repoRoot ".git"

    if (Test-Path $gitFolder) {
        Invoke-Step -Message "Updating repository in current folder" -Action {
            $originUrl = git -C $repoRoot remote get-url origin 2>$null
            if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($originUrl)) {
                git -C $repoRoot remote add origin $RepoUrl
            } elseif ($originUrl.Trim() -ne $RepoUrl.Trim()) {
                git -C $repoRoot remote set-url origin $RepoUrl
            }

            git -C $repoRoot fetch origin $Branch
            git -C $repoRoot checkout -B $Branch
            git -C $repoRoot reset --hard "origin/$Branch"
        }
    } else {
        Invoke-Step -Message "Initializing and syncing repository in current folder" -Action {
            Push-Location $repoRoot
            try {
                git init
                git remote add origin $RepoUrl
                git fetch origin $Branch
                git checkout -B $Branch
                git reset --hard "origin/$Branch"
            } finally {
                Pop-Location
            }
        }
    }
} else {
    Write-Host "No repository URL provided. Skipping git sync." -ForegroundColor Yellow
}

$packageJsonPath = Join-Path $repoRoot "package.json"
if (-not (Test-Path $packageJsonPath)) {
    throw "package.json was not found at $repoRoot. The repository does not look like the SPA project root."
}

if (-not $SkipInstall) {
    Invoke-Step -Message "Stopping repo Node.js processes that may lock dependencies" -Action {
        Stop-RepoNodeProcesses -RepoRoot $repoRoot
    }

    Invoke-Step -Message "Clearing local node_modules folders" -Action {
        $localNodeModulesPaths = @(
            (Join-Path $repoRoot "node_modules"),
            (Join-Path $repoRoot "server\node_modules")
        )

        foreach ($nodeModulesPath in $localNodeModulesPaths) {
            if (Test-Path $nodeModulesPath) {
                Write-Host "Removing $nodeModulesPath" -ForegroundColor Yellow
                try {
                    Remove-DirectoryWithRetry -Path $nodeModulesPath
                } catch {
                    throw "Failed to remove $nodeModulesPath. Close processes using files in this folder and rerun. Root cause: $($_.Exception.Message)"
                }
            }
        }
    }

    Invoke-Step -Message "Clearing npm cache" -Action {
        npm cache clean --force
    }

    Invoke-Step -Message "Installing npm dependencies" -Action {
        Push-Location $repoRoot
        try {
            npm install
        } finally {
            Pop-Location
        }
    }
}

$envFile = Join-Path $repoRoot ".env.local"
if (-not (Test-Path $envFile)) {
    Write-Warning ".env.local was not found. The SPA can start, but Azure sign-in will need valid VITE_AZURE_* settings."
}

if ($BootstrapOnly) {
    Write-Host "Bootstrap complete. Repository is ready at $repoRoot" -ForegroundColor Green
    return
}

$serverPackageJsonPath = Join-Path $repoRoot "server\package.json"
$backendShellProcess = $null

if (Test-Path $serverPackageJsonPath) {
    Invoke-Step -Message "Starting backend API dev server in this terminal" -Action {
        $npmCommand = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
        if (-not $npmCommand) {
            $npmCommand = Get-Command "npm" -ErrorAction Stop
        }

        $backendShellProcess = Start-Process -FilePath $npmCommand.Source -ArgumentList @("--prefix", "server", "run", "dev") -WorkingDirectory $repoRoot -NoNewWindow -PassThru
        Write-Host "Backend API started in this terminal with PID $($backendShellProcess.Id)." -ForegroundColor Green
    }
} else {
    Write-Warning "server/package.json was not found. Starting frontend only."
}

try {
    Invoke-Step -Message "Starting Vite dev server in this window" -Action {
        Push-Location $repoRoot
        try {
            npm run dev
        } finally {
            Pop-Location
        }
    }
} finally {
    Stop-BackendProcess -Process $backendShellProcess
}