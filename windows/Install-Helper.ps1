param(
    [ValidatePattern('^[a-p]{32}$')]
    [string] $ExtensionId
)

$ErrorActionPreference = 'Stop'
$name = 'com.toolbar_minimiser.position'
$root = Split-Path -Parent $PSScriptRoot
if (!$ExtensionId) {
    # For unpacked Windows extensions Chrome hashes the absolute UTF-16LE path.
    $digest = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $digest.ComputeHash([Text.Encoding]::Unicode.GetBytes($root))
    } finally {
        $digest.Dispose()
    }
    $alphabet = 'abcdefghijklmnop'
    $ExtensionId = -join ($hash[0..15] | ForEach-Object {
        $alphabet[$_ -shr 4]
        $alphabet[$_ -band 15]
    })
}

$destination = Join-Path $env:LOCALAPPDATA 'ChromeToolbarMinimiser'
$source = Join-Path $PSScriptRoot 'PositionHost.cs'
$build = (Get-FileHash -LiteralPath $source).Hash.Substring(0, 12)
$exe = Join-Path $destination "PositionHost-$build.exe"
$manifest = Join-Path $destination 'native-host.json'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
if (!(Test-Path -LiteralPath $exe)) {
    & $compiler /nologo /target:winexe /r:System.Web.Extensions.dll "/out:$exe" $source
    if ($LASTEXITCODE -ne 0) { throw 'Could not compile the Windows positioning helper.' }
}

$configuration = @{
    name = $name
    description = 'Keeps the Chrome window bottom edge fixed when hiding the toolbar.'
    path = $exe
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
[IO.File]::WriteAllText($manifest, $configuration)

$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Software\Google\Chrome\NativeMessagingHosts\$name")
try {
    $key.SetValue('', $manifest)
} finally {
    $key.Dispose()
}
Write-Host "Windows helper installed for Chrome extension $ExtensionId."
