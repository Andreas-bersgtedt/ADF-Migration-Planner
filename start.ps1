param(
    [string]$RepoUrl,
    [string]$DestinationRoot = (Join-Path $PSScriptRoot ".bootstrap"),
    [string]$RepoName = "ADFMigrationPlanner",
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
            Stop-Process -Id $Process.Id -Force
        }
    } catch {
        Write-Warning "Failed to stop backend process PID $($Process.Id): $($_.Exception.Message)"
    }
}

Require-Command -Name "npm"

$useGit = $false
if (-not $UseCurrentRepo) {
    if ([string]::IsNullOrWhiteSpace($RepoUrl)) {
        $RepoUrl = Read-Host "Enter the git repository URL to clone (leave blank to use the current folder)"
    }

    if (-not [string]::IsNullOrWhiteSpace($RepoUrl)) {
        $useGit = $true
    }
}

$repoRoot = if ($useGit) {
    Join-Path $DestinationRoot $RepoName
} else {
    $PSScriptRoot
}

if (-not $useGit) {
    if ($UseCurrentRepo) {
        Write-Host "Using current repository at $repoRoot" -ForegroundColor Yellow
    } else {
        Write-Host "No repository URL provided. Skipping git and using current folder at $repoRoot" -ForegroundColor Yellow
    }
} else {
    Require-Command -Name "git"

    Invoke-Step -Message "Preparing clone directory" -Action {
        if (-not (Test-Path $DestinationRoot)) {
            New-Item -Path $DestinationRoot -ItemType Directory | Out-Null
        }
    }

    if (Test-Path $repoRoot) {
        Invoke-Step -Message "Updating existing clone" -Action {
            git -C $repoRoot fetch origin $Branch
            git -C $repoRoot checkout $Branch
            git -C $repoRoot pull --ff-only origin $Branch
        }
    } else {
        Invoke-Step -Message "Cloning repository" -Action {
            git clone --branch $Branch $RepoUrl $repoRoot
        }
    }
}

$packageJsonPath = Join-Path $repoRoot "package.json"
if (-not (Test-Path $packageJsonPath)) {
    throw "package.json was not found at $repoRoot. The repository does not look like the SPA project root."
}

if (-not $SkipInstall) {
    Invoke-Step -Message "Clearing local node_modules folders" -Action {
        $localNodeModulesPaths = @(
            (Join-Path $repoRoot "node_modules"),
            (Join-Path $repoRoot "server\node_modules")
        )

        foreach ($nodeModulesPath in $localNodeModulesPaths) {
            if (Test-Path $nodeModulesPath) {
                Write-Host "Removing $nodeModulesPath" -ForegroundColor Yellow
                Remove-Item -Path $nodeModulesPath -Recurse -Force
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
    Invoke-Step -Message "Starting backend API dev server in a new PowerShell window" -Action {
        $repoRootEscaped = $repoRoot.Replace("'", "''")
        $command = "Set-Location '$repoRootEscaped'; npm run api:dev"
        $backendShellProcess = Start-Process -FilePath "powershell" -ArgumentList @("-NoExit", "-Command", $command) -PassThru
        Write-Host "Backend API started with PID $($backendShellProcess.Id)." -ForegroundColor Green
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