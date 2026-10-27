# Converts one image to a web format, scaled to at most MaxWidth pixels wide.
# Used by build_catalogue.py on Windows for TIFF/EMF figures and very large photos.
param(
    [Parameter(Mandatory = $true)][string]$In,
    [Parameter(Mandatory = $true)][string]$OutBase,
    [int]$MaxWidth = 1800
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile($In)
try {
    $isVector = $src -is [System.Drawing.Imaging.Metafile]
    $w = $src.Width; $h = $src.Height
    if ($isVector -or $w -gt $MaxWidth) {
        $scale = $MaxWidth / [double]$w
        $w = $MaxWidth; $h = [int][math]::Round($src.Height * $scale)
    }
    $hasAlpha = $isVector -or ([System.Drawing.Image]::IsAlphaPixelFormat($src.PixelFormat))
    $fmt = if ($hasAlpha) { [System.Drawing.Imaging.PixelFormat]::Format32bppArgb } else { [System.Drawing.Imaging.PixelFormat]::Format24bppRgb }
    $bmp = New-Object System.Drawing.Bitmap($w, $h, $fmt)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    if (-not $hasAlpha) { $g.Clear([System.Drawing.Color]::White) }
    $g.DrawImage($src, 0, 0, $w, $h)
    $g.Dispose()
} finally {
    $src.Dispose()
}

if ($hasAlpha) {
    $out = "$OutBase.png"
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
} else {
    $out = "$OutBase.jpg"
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
    $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]84)
    $bmp.Save($out, $codec, $params)
}
$bmp.Dispose()
Write-Output $out
