
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$InputVideo,

    [Parameter(Mandatory = $false)]
    [string]$OutputDir,

    [Parameter(Mandatory = $false)]
    [ValidateRange(1, [int]::MaxValue)]
    [int]$Nth = 5,

    [Parameter(Mandatory = $false)]
    [ValidateSet('png', 'jpg')]
    [string]$ImageFormat = 'png'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Error 'ffmpeg not found on PATH. Install FFmpeg and ensure ffmpeg.exe is discoverable.'
    exit 127
}

if (-not (Test-Path -LiteralPath $InputVideo)) {
    Write-Error "Input video not found: $InputVideo"
    exit 2
}

$resolvedVideo = (Get-Item -LiteralPath $InputVideo).FullName
$stem = [System.IO.Path]::GetFileNameWithoutExtension($resolvedVideo)
$parent = [System.IO.Path]::GetDirectoryName($resolvedVideo)

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $parent "${stem}_frames"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$outputPattern = Join-Path $OutputDir ("frame_%06d.{0}" -f $ImageFormat)

$vfFilter = "select='eq(mod(n\,${Nth})\,0)',setpts=N/FRAME_RATE/TB"

$ffmpegArgs = @(
    '-hide_banner',
    '-y',
    '-i', $resolvedVideo,
    '-vf', $vfFilter,
    '-vsync', 'vfr',
    $outputPattern
)

& ffmpeg @ffmpegArgs
exit $LASTEXITCODE
