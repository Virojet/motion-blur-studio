!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Motion Blur setup"
  !define MUI_WELCOMEPAGE_TEXT "Install the clip editor and connect Tekno's Blur engine.$\r$\n$\r$\nIf a complete engine is already installed, it is reused. Otherwise setup downloads the official Blur v2.45 installer (about 180 MB), verifies its SHA-256, and installs it for your Windows user.$\r$\n$\r$\nThe first engine installation needs an Internet connection. Rendering stays on this PC."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInstall
  DetailPrint "Checking and setting up the Blur engine…"
  ClearErrors
  ExecWait '"$INSTDIR\Motion Blur.exe" --install-engine --silent' $0
  ${If} ${Errors}
    StrCpy $0 1
  ${EndIf}
  ${If} $0 != 0
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "The editor was copied, but Blur engine setup failed. See %LOCALAPPDATA%\Motion Blur\setup\engine-setup.log. Check the Internet connection or install the official Blur package, then run setup again."
    SetErrorLevel 1
    Abort
  ${EndIf}
  DetailPrint "Blur engine is ready."
!macroend
