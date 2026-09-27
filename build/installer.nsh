; ════════════════════════════════════════════════════════════════════════════
;  Kitsune Browser — custom installer script (NSIS).
;
;  electron-builder already creates a desktop shortcut (createDesktopShortcut),
;  but here everything is explicit and extended with things it does not do:
;
;    1) desktop shortcut + Start Menu shortcuts (including the uninstall one);
;    2) browser registration in Windows: the app shows up in
;       "Settings -> Apps -> Default apps" and can be set as the default browser
;       (RegisteredApplications + Capabilities + ProgID KitsuneHTML);
;    3) clean removal of all of the above on uninstall.
;
;  IMPORTANT: this file must stay Latin-only (ASCII). makensis without a UTF-8
;  BOM reads the file as ANSI, so Cyrillic here turns into garbage. All user
;  facing strings come from electron-builder resources (messages.yml) and the
;  brand name is Latin anyway. The test suite enforces this rule.
;
;  customInstall / customUnInstall macros are picked up by the template
;  app-builder-lib/templates/nsis/installer.nsi.
; ════════════════════════════════════════════════════════════════════════════

!macro customInstall
  ; ── Shortcuts ─────────────────────────────────────────────────────────────
  ; $DESKTOP and $SMPROGRAMS are standard NSIS shell folder constants (per-user
  ; folders: the installer runs in per-user mode by default).
  CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" \
    "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" \
    "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0

  CreateDirectory "$SMPROGRAMS\${SHORTCUT_NAME}"
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}\${SHORTCUT_NAME}.lnk" \
    "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" \
    "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}\Uninstall ${SHORTCUT_NAME}.lnk" \
    "$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe"

  ; ── Browser registration ──────────────────────────────────────────────────
  ; ProgID + Capabilities: after this Kitsune appears in the Windows list of
  ; browsers ("Default apps") and can be set as the default one.
  WriteRegStr HKCU "Software\Classes\KitsuneHTML" "" "Kitsune Browser HTML Document"
  WriteRegStr HKCU "Software\Classes\KitsuneHTML" "FriendlyTypeName" "Kitsune Browser HTML Document"
  WriteRegStr HKCU "Software\Classes\KitsuneHTML\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\KitsuneHTML\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr HKCU "Software\Kitsune Browser\Capabilities" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Kitsune Browser\Capabilities" "ApplicationDescription" \
    "Fast browser with ad blocking and private DuckDuckGo search"
  WriteRegStr HKCU "Software\Kitsune Browser\Capabilities" "ApplicationIcon" \
    "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Kitsune Browser\Capabilities\FileAssociations" ".htm" "KitsuneHTML"
  WriteRegStr HKCU "Software\Kitsune Browser\Capabilities\FileAssociations" ".html" "KitsuneHTML"
  WriteRegStr HKCU "Software\Kitsune Browser\Capabilities\URLAssociations" "http" "KitsuneHTML"
  WriteRegStr HKCU "Software\Kitsune Browser\Capabilities\URLAssociations" "https" "KitsuneHTML"
  WriteRegStr HKCU "Software\RegisteredApplications" "${PRODUCT_NAME}" "Software\Kitsune Browser\Capabilities"
!macroend

!macro customUnInstall
  ; ── Shortcuts ─────────────────────────────────────────────────────────────
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}\Uninstall ${SHORTCUT_NAME}.lnk"
  RMDir "$SMPROGRAMS\${SHORTCUT_NAME}"

  ; ── Browser registration ──────────────────────────────────────────────────
  DeleteRegValue HKCU "Software\RegisteredApplications" "${PRODUCT_NAME}"
  DeleteRegKey HKCU "Software\Kitsune Browser"
  DeleteRegKey HKCU "Software\Classes\KitsuneHTML"
!macroend
