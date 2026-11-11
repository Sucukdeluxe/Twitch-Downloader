!macro customCheckAppRunning
  Push $R0
  Push $R1
  Push $R2
  StrCpy $R2 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $R2 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  InitPluginsDir
  File /oname=$PLUGINSDIR\close-installed-app.ps1 "${BUILD_RESOURCES_DIR}\close-installed-app.ps1"
  nsExec::ExecToStack '"$R2" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\close-installed-app.ps1" -InstallDirectory "$INSTDIR" -Mode Check'
  Pop $R0
  Pop $R1
  ${if} $R0 == 10
    ${ifNot} ${Silent}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDCANCEL IDOK closeInstalledApp
      SetErrorLevel 2
      Quit
    ${endIf}
    closeInstalledApp:
      nsExec::ExecToStack '"$R2" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\close-installed-app.ps1" -InstallDirectory "$INSTDIR" -Mode Close'
      Pop $R0
      Pop $R1
      ${if} $R0 != 0
        DetailPrint "$R1"
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY closeInstalledApp
        SetErrorLevel 2
        Quit
      ${endIf}
  ${elseIf} $R0 != 0
    DetailPrint "$R1"
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(appCannotBeClosed)"
    SetErrorLevel 2
    Quit
  ${endIf}
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro removeOrphanedRegistration ROOT
  ReadRegStr $0 ${ROOT} "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $0 == ""
  ${orIfNot} ${FileExists} "$0\${APP_EXECUTABLE_FILENAME}"
    ClearErrors
    DeleteRegKey ${ROOT} "${INSTALL_REGISTRY_KEY}"
    DeleteRegKey ${ROOT} "${UNINSTALL_REGISTRY_KEY}"
    ClearErrors
  ${endIf}
!macroend

!macro preInit
  !ifndef BUILD_UNINSTALLER
    !insertmacro check64BitAndSetRegView
    !insertmacro removeOrphanedRegistration HKCU
    !insertmacro removeOrphanedRegistration HKLM
  !endif
!macroend

!macro customInstall
  StrCpy $0 "$INSTDIR\resources\app-icons\icon-${VERSION}.ico"
  Delete "$SMPROGRAMS\Twitch Downloader v*.lnk"
  Delete "$SMPROGRAMS\Twitch VOD Manager*.lnk"
  Delete "$DESKTOP\Twitch Downloader v*.lnk"
  Delete "$DESKTOP\Twitch VOD Manager*.lnk"
  ${if} ${FileExists} "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endIf}
  CreateShortCut "$newStartMenuLink" "$appExe" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  System::Call 'shell32::SHChangeNotify(i 0x00001000, i 0x0005, w "$SMPROGRAMS", p 0)'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)'
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\Twitch Downloader\Shortcut Icons"
    RMDir /r "$LOCALAPPDATA\Twitch VOD Manager\Shortcut Icons"
  ${endIf}
!macroend
