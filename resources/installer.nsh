; KPOSS NSIS hooks (electron-builder `nsis.include`), D39.
; The Host machine serves paired Clients over HTTPS on the shop LAN (default port 3000, D34).
; Allow KPOSS.exe through Windows Firewall for the local subnet only, on every network profile
; (shop Wi-Fi is often classified "Public"), so nobody has to answer a firewall prompt at the till.
; The rule is tied to the program, not to a port, and removed again by the uninstaller.

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="KPOSS (LAN)"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="KPOSS (LAN)" dir=in action=allow program="$INSTDIR\KPOSS.exe" enable=yes profile=any remoteip=localsubnet protocol=TCP'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="KPOSS (LAN)"'
!macroend
