!macro customInit
  ; Kill running Twitch Downloader / legacy Twitch VOD Manager process before installation
  nsExec::ExecToLog 'taskkill /F /IM "Twitch Downloader.exe"'
  nsExec::ExecToLog 'taskkill /F /IM "Twitch VOD Manager.exe"'
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
