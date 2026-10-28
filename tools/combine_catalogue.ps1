# Combines every PowerPoint in catalogue/ into one file, keeping each slide's own
# formatting (its source template is carried along, as with "Keep source formatting").
# Needs PowerPoint installed. Run from the project folder:
#   powershell -ExecutionPolicy Bypass -File tools\combine_catalogue.ps1
param(
    [string]$Source = "catalogue",
    [string]$Out = "combined\DTU_CONSTRUCT-MSE-Project_Catalogue-2026-2027 (all projects).pptx"
)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$srcDir = Join-Path $root $Source
$outPath = Join-Path $root $Out
New-Item -ItemType Directory -Force (Split-Path -Parent $outPath) | Out-Null

$files = @(Get-ChildItem $srcDir -Filter *.pptx | Where-Object { $_.Name -notlike '~$*' } | Sort-Object Name)
# catalogue/order.txt sets the order; files not listed there follow alphabetically.
$orderFile = Join-Path $srcDir "order.txt"
if (Test-Path $orderFile) {
    $order = @(Get-Content $orderFile -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") })
    $files = @($files | Sort-Object @{ Expression = { $i = [Array]::IndexOf(@($order | ForEach-Object { $_.ToLower() }), $_.Name.ToLower()); if ($i -lt 0) { $order.Count } else { $i } } }, Name)
}
if (-not $files) { throw "No .pptx files in $srcDir" }
# Front pages (cover, introduction) come first, in file-name order: 01-cover.pptx, 02-...
$front = Join-Path $root "front-pages"
if (Test-Path $front) {
    $files = @(Get-ChildItem $front -Filter *.pptx | Where-Object { $_.Name -notlike '~$*' } | Sort-Object Name) + $files
}

$ppt = New-Object -ComObject PowerPoint.Application
$msoFalse = 0; $msoTrue = -1
try {
    # Start from a copy of the first file so the page size and template match.
    Copy-Item $files[0].FullName $outPath -Force
    $dest = $ppt.Presentations.Open($outPath, $msoFalse, $msoFalse, $msoFalse)
    $report = @("{0,3} slides  {1}" -f $dest.Slides.Count, $files[0].Name)

    foreach ($f in $files | Select-Object -Skip 1) {
        $src = $ppt.Presentations.Open($f.FullName, $msoTrue, $msoFalse, $msoFalse)
        $n = $src.Slides.Count
        $src.Close()

        $start = $dest.Slides.Count + 1
        $before = $dest.Designs.Count
        $dest.Slides.InsertFromFile($f.FullName, $dest.Slides.Count, 1, $n) | Out-Null
        # Bring this file's own template in and put its slides back on it.
        $dest.Designs.Load($f.FullName, $dest.Designs.Count + 1) | Out-Null
        if ($dest.Designs.Count -gt $before) {
            $design = $dest.Designs.Item($dest.Designs.Count)
            for ($i = $start; $i -le $dest.Slides.Count; $i++) { $dest.Slides.Item($i).Design = $design }
        }
        $report += ("{0,3} slides  {1}" -f $n, $f.Name)
    }

    $dest.Save()
    $total = $dest.Slides.Count
    $dest.Close()
    $report
    "Total: $total slides -> $outPath"
} finally {
    # Leave PowerPoint running if the user has other presentations open.
    if ($ppt.Presentations.Count -eq 0) { $ppt.Quit() }
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null
}
