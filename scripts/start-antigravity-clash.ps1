[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$ProxyPort = 7897,
    [string]$AntigravityPath = "$env:LOCALAPPDATA\Programs\antigravity\Antigravity.exe",
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

try {
    if (-not (Test-Path -LiteralPath $AntigravityPath -PathType Leaf)) {
        throw "Antigravity not found: $AntigravityPath. Set -AntigravityPath to its executable."
    }

    $proxy = "http://127.0.0.1:$ProxyPort"
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connection = $client.ConnectAsync('127.0.0.1', $ProxyPort)
        if (-not $connection.Wait(3000)) {
            throw 'Connection timed out.'
        }
        $null = $connection.GetAwaiter().GetResult()
    } catch {
        throw "Clash proxy is unavailable at $proxy. Start Clash or supply -ProxyPort."
    } finally {
        $client.Dispose()
    }

    $launchArguments = @(
        "--proxy-server=$proxy"
        '--proxy-bypass-list=localhost;127.0.0.1;[::1]'
        '--disable-quic'
    )
    # The agy-node sidecar reuses Antigravity.exe without opening the desktop app.
    # Ignore only this known helper; unknown processes still block a duplicate launch.
    $existing = @(Get-CimInstance Win32_Process -Filter "Name = 'Antigravity.exe'")
    $sidecars = @($existing | Where-Object {
        $_.CommandLine -match '(?i)--import=file://\S*[/\\]sidecar_sdk[/\\]register_loader\.js["'']?\s+main\.mjs(?:\s|$)'
    })
    $running = @($existing | Where-Object { $_.ProcessId -notin $sidecars.ProcessId })
    Write-Host "Application: $AntigravityPath"
    Write-Host "Proxy:       $proxy (TCP reachable)"
    Write-Host "Arguments:   $($launchArguments -join ' ')"

    if ($CheckOnly) {
        Write-Host "Check only: no application started. Desktop processes: $($running.Count); ignored sidecar helpers: $($sidecars.Count)."
        exit 0
    }
    if ($running.Count -gt 0) {
        throw 'Antigravity is already running. Save your work and fully exit it, then run this launcher again.'
    }

    # Process-only settings are inherited by the new application and its children.
    # Keep local callbacks direct and restore this launcher's environment afterwards.
    $proxyEnvironment = @{
        HTTP_PROXY = $proxy
        HTTPS_PROXY = $proxy
        ALL_PROXY = $proxy
        NO_PROXY = 'localhost,127.0.0.1,::1'
    }
    $previousEnvironment = @{}
    try {
        foreach ($name in $proxyEnvironment.Keys) {
            $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, $proxyEnvironment[$name], 'Process')
        }
        $process = Start-Process -FilePath $AntigravityPath -ArgumentList $launchArguments -PassThru
        Write-Host "Started Antigravity with Clash proxy (PID $($process.Id))."
    } finally {
        foreach ($name in $previousEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
        }
    }
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
