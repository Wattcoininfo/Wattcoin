!include "MUI2.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
Var FirewallAccepted
!endif

!macro customPageAfterChangeDir
  Page custom createFirewallPage leaveFirewallPage

  Function createFirewallPage
    !insertmacro MUI_HEADER_TEXT "Network Access Required" "Firewall rule for peer attestation"

    StrCpy $FirewallAccepted "0"

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 5u 100% 15u \
      "Wattcoin Miner participates in peer attestation: neighbouring nodes verify each other's mining hardware to keep the network honest."
    Pop $0

    ${NSD_CreateLabel} 0 25u 100% 40u \
      "To enable this, the installer adds a Windows Firewall inbound rule:$\r$\n$\r$\n\
       Name:  Wattcoin Miner Ledger Network (TCP 39310)$\r$\n\
       Protocol:  TCP$\r$\n\
       Port:  39310 (local network only)$\r$\n\
       Direction:  Inbound"
    Pop $0

    ${NSD_CreateLabel} 0 70u 100% 15u \
      "The rule is removed automatically when you uninstall Wattcoin Miner."
    Pop $0

    ${NSD_CreateLabel} 0 85u 100% 15u \
      "Click Next to allow this rule.  Click Cancel to skip it — the app will still install, but peer attestation will not work and your trust score may be affected."
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function leaveFirewallPage
    StrCpy $FirewallAccepted "1"
  FunctionEnd
!macroend

!macro customInstall
  ${If} ${Silent}
    StrCpy $FirewallAccepted "1"
  ${EndIf}

  ${If} $FirewallAccepted == "1"
    DetailPrint "Adding Windows Firewall inbound rule for TCP 39310..."
    nsExec::Exec 'netsh advfirewall firewall add rule name="Wattcoin Miner Ledger Network (TCP 39310)" protocol=TCP dir=in localport=39310 action=allow profile=private,domain'
    Pop $0
    ${If} $0 == 0
      DetailPrint "Firewall rule added successfully."
    ${Else}
      DetailPrint "Warning: Could not add firewall rule (error $0). You may need to add it manually."
    ${EndIf}
  ${Else}
    DetailPrint "Firewall rule skipped (user declined)."
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removing Windows Firewall inbound rule..."
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Wattcoin Miner Ledger Network (TCP 39310)"'
  Pop $0
  ${If} $0 == 0
    DetailPrint "Firewall rule removed."
  ${Else}
    DetailPrint "Firewall rule removal skipped (not found or insufficient privileges)."
  ${EndIf}
!macroend
