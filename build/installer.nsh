!macro customInstall
  ; Electron 45+ sandboxed child processes require ALL APPLICATION PACKAGES (S-1-15-2-1)
  ; read/execute access on the install directory when parent folders carry an AppContainer SID.
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR" /grant *S-1-15-2-1:(OI)(CI)(RX)'
  Pop $0
!macroend
