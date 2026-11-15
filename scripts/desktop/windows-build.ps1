# Runs inside the win-devvm guest: builds the Windows installers and portable
# executables from ~/grimalkin-src.tgz into ~/grimalkin-out.
param([string]$Arches = 'arm64 x64', [string]$Version = '0.0.0')
$ErrorActionPreference = 'Stop'
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" } }

$work = Join-Path $HOME 'grimalkin-build'
$out = Join-Path $HOME 'grimalkin-out'
foreach ($d in $work, $out) {
    # rmdir copes with node_modules' long paths, which Remove-Item does not.
    if (Test-Path $d) { cmd /c rmdir /s /q "$d" }
    New-Item -ItemType Directory -Force $d | Out-Null
}
tar -xzf (Join-Path $HOME 'grimalkin-src.tgz') -C $work; Check 'unpack'
Set-Location $work
$env:CARGO_TARGET_DIR = Join-Path $HOME 'grimalkin-target'   # kept between runs
npm ci --no-fund --no-audit; Check 'npm ci'

foreach ($arch in $Arches.Split(' ', [StringSplitOptions]::RemoveEmptyEntries)) {
    $triple = if ($arch -eq 'arm64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
    rustup target add $triple; Check "rustup target add $triple"
    npx tauri build --target $triple --bundles nsis; Check "tauri build $triple"
    $rel = Join-Path $env:CARGO_TARGET_DIR "$triple\release"
    Copy-Item (Get-ChildItem "$rel\bundle\nsis\*-setup.exe" | Select-Object -First 1).FullName `
        (Join-Path $out "Grimalkin-1010_${Version}_windows-$arch-setup.exe")
    Copy-Item "$rel\grimalkin-1010.exe" (Join-Path $out "Grimalkin-1010_${Version}_windows-$arch-portable.exe")

    # Self-test (best effort: an SSH session has no interactive desktop).
    $report = Join-Path $out "selftest-windows-$arch.json"
    $env:GRIMALKIN_SELFTEST = $report
    $p = Start-Process "$rel\grimalkin-1010.exe" -PassThru
    if (-not $p.WaitForExit(60000)) { $p.Kill(); Write-Host "selftest ${arch}: timed out" }
    else { Write-Host "selftest ${arch}: exit $($p.ExitCode)" }
    Remove-Item Env:GRIMALKIN_SELFTEST
}
Get-ChildItem $out | Format-Table Name, Length
