; Custom NSIS header — adds the version number to the installer window title.
; electron-builder includes this file and calls !insertmacro customHeader after
; common.nsh sets  Name "${PRODUCT_NAME}".  Calling Name again here overrides it
; (NSIS uses the last Name directive).  ${VERSION} is defined by electron-builder
; as the app version string (e.g. "1.0.53").
!macro customHeader
  !pragma warning disable 6029
  Name "${PRODUCT_NAME} v${VERSION}"
  !pragma warning enable 6029
  BrandingText "${PRODUCT_NAME} v${VERSION}"
!macroend

!macro customFinishPage
  Function LaunchApplicationWithStatus
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    Banner::show /NOUNLOAD "Launching ${PRODUCT_NAME}..." "Please wait while ${PRODUCT_NAME} starts."
    Sleep 800
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    Banner::destroy
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Launch ${PRODUCT_NAME} when setup finishes"
  !define MUI_FINISHPAGE_RUN_FUNCTION "LaunchApplicationWithStatus"
  !insertmacro MUI_PAGE_FINISH
!macroend

; ── Windows Firewall rule for the peer-attestation HTTP server ─────────────────
; The app listens on TCP port 39310 so other Wattcoin nodes on the local network
; can request and verify hardware probes (peer attestation).  Without an inbound
; rule, Windows Firewall blocks all incoming connections and every probe times out
; with "peer unreachable".  Registering the rule at install time means the app
; works out of the box without a "Windows Security Alert" dialog on first launch.
; The rule is removed cleanly on uninstall.
; ──────────────────────────────────────────────────────────────────────────────
!define WATTCOIN_FW_RULE_NAME "Wattcoin Miner Ledger Network (TCP 39310)"

!macro customInstall
  ; ── Ask user before adding the firewall rule ──────────────────────────────
  ; Skip the dialog during silent installs (autoInstallOnAppQuit / /S flag).
  IfSilent skip_fw_rule
  MessageBox MB_ICONINFORMATION|MB_OKCANCEL \
    "Wattcoin Miner — Network Access Required$\r$\n$\r$\n\
Wattcoin Miner participates in peer attestation: neighbouring nodes verify each$\r$\n\
other's mining hardware to keep the network honest.$\r$\n$\r$\n\
To enable this, the installer will add a Windows Firewall inbound rule:$\r$\n$\r$\n\
    Name:      ${WATTCOIN_FW_RULE_NAME}$\r$\n\
    Protocol:  TCP$\r$\n\
    Port:      39310 (internet / all networks)$\r$\n\
    Direction: Inbound$\r$\n$\r$\n\
The rule is removed automatically when you uninstall Wattcoin Miner.$\r$\n$\r$\n\
Click OK to allow this rule.$\r$\n\
Click Cancel to skip it — the app will still install, but peer attestation$\r$\n\
will not work and your trust score may be affected." \
    IDCANCEL skip_fw_rule

  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${WATTCOIN_FW_RULE_NAME}" dir=in'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${WATTCOIN_FW_RULE_NAME}" dir=in action=allow protocol=TCP localport=39310 description="Allows Wattcoin peer nodes to attest mining hardware over the peer-to-peer network (peer-to-peer proof verification)."'
  skip_fw_rule:
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${WATTCOIN_FW_RULE_NAME}" dir=in'
!macroend
