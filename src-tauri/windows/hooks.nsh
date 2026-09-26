; Prism's additions to Tauri's NSIS installer (bundle.windows.nsis.installerHooks).

!macro NSIS_HOOK_POSTINSTALL
  ; Toasts reach Windows only through a Start-menu shortcut carrying the app's
  ; AppUserModelID. Tauri stamps it when it creates a shortcut, but on an
  ; update (/UPDATE, the in-app updater) or when it retargets an older
  ; shortcut it leaves the existing one alone — so installs from before the
  ; com.prism.app → com.rainacorp.prism rename kept the old ID, and every
  ; notification was dropped (Windows test run 2026-09-26, C1). Re-stamp
  ; whatever shortcuts exist; this runs in every install mode.
  ${If} ${FileExists} "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  ${EndIf}
  ${If} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}
  ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}

  ; 2.2.1 shipped yt-dlp as a one-file exe beside Prism. This build runs the
  ; onedir engine in ytdlp\ (engine.rs never looks for the old file), so once
  ; that is in place the old 17 MB exe is dead weight.
  ${If} ${FileExists} "$INSTDIR\ytdlp\yt-dlp.exe"
    Delete "$INSTDIR\yt-dlp.exe"
  ${EndIf}
!macroend
