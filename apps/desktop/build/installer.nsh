; electron-builder includes this in the Windows installer (package.json's nsis.include).
;
; Uninstalling removes what Ponzu wrote for the person at launch, which the installer never
; knew about: see uninstall.ps1. Not on an update, which runs the old version's uninstaller
; too, before the new one installs.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\uninstall.ps1"`
    Pop $0
  ${endIf}
!macroend
