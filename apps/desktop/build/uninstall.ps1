# Run by Ponzu's uninstaller (installer.nsh), as the person, before it removes the app: what
# Ponzu wrote for them at launch. Their designs and ~\.ponzu stay.

# design.json under Open with, and the Ponzu Design type it opens as (apps/desktop/src/designs.ts).
$classes = 'HKCU:\Software\Classes'
Remove-Item -LiteralPath "$classes\Ponzu.Design" -Recurse -Force -ErrorAction SilentlyContinue
Remove-ItemProperty -LiteralPath "$classes\.json\OpenWithProgids" -Name 'Ponzu.Design' -ErrorAction SilentlyContinue

# The ponzu command's folder on their PATH (apps/cli/src/command.ts), read and written as the
# registry holds it, so entries like %USERPROFILE%\bin stay unexpanded.
$ponzuHome = if ($env:PONZU_HOME) { $env:PONZU_HOME } else { Join-Path $env:USERPROFILE '.ponzu' }
$bin = Join-Path $ponzuHome 'bin'
$norm = { param($p) [Environment]::ExpandEnvironmentVariables($p.Trim()).TrimEnd('\', '/') }
$key = Get-Item -LiteralPath 'HKCU:\Environment'
if ($key.GetValueNames() -contains 'Path') {
  $entries = @(([string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')) -split ';' | Where-Object { $_.Trim() })
  $kept = @($entries | Where-Object { (& $norm $_) -ine (& $norm $bin) })
  if ($kept.Count -ne $entries.Count) {
    Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value ($kept -join ';') -Type $key.GetValueKind('Path')
    # Tells running programs the environment changed, as the CLI does when it adds the folder.
    [Environment]::SetEnvironmentVariable('PONZU_PATH_CHANGED', '1', 'User')
    [Environment]::SetEnvironmentVariable('PONZU_PATH_CHANGED', $null, 'User')
  }
}

# The CLI remembers it added the folder and never adds it again, so a reinstall would go without
# it: forget that too.
$state = Join-Path $ponzuHome 'command.json'
try {
  $linked = (Get-Content -LiteralPath $state -Raw | ConvertFrom-Json).linked
  if ($linked -and ((& $norm $linked) -ieq (& $norm $bin))) { Remove-Item -LiteralPath $state -Force }
} catch {}
