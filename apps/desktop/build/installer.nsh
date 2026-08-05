; An existing Inno install leaves a TokenOpsAgent logon task behind. If it runs
; alongside this app, the loser fails to bind 127.0.0.1:8787 and its proxy dies
; quietly while everything else looks healthy. Remove it before first run.
;
; ~/.tokenops/config.toml and machine.json are deliberately left alone: keeping
; machine.json is what keeps this machine's existing history attached to it.
;
; The Inno installer also prepended %LOCALAPPDATA%\TokenOps\bin (or its
; expanded form, e.g. C:\Users\<user>\AppData\Local\TokenOps\bin -- installers
; write either) to the user PATH so its "tokenops" shim shadowed anything else
; on PATH. That shim is gone once this installer removes the old install dir,
; so a stale PATH entry would leave `tokenops` on the command line resolving
; to nothing. EnVar-style plugins aren't guaranteed to ship in every
; electron-builder NSIS bundle, so this does its own read-modify-write against
; HKCU\Environment using only core NSIS instructions, inlined via macros (not
; Functions/Call) so nothing here can be pruned as "unreferenced" dead code.

!macro customInstall
  nsExec::Exec 'schtasks /Delete /TN "TokenOpsAgent" /F'
  DeleteRegValue HKCU "Environment" "TOKENOPS_HOME"
  !insertmacro TokenOpsRemoveStaleBinFromPath
!macroend

; ---------------------------------------------------------------------------
; Remove-all substring replace, inlined via macro (adapted from the well-known
; NSIS "Replace Sub String" recipe). UNIQ must be unique across every
; expansion of this macro in the compiled script, since NSIS labels are
; plain text and not scoped to a macro instantiation.
; ---------------------------------------------------------------------------
!macro TokenOpsStrReplaceAll UNIQ STR NEEDLE REPL
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  StrCpy $R1 "${STR}"
  StrCpy $R3 "${NEEDLE}"
  StrCpy $R4 "${REPL}"
  StrCpy $R2 ""
  StrLen $R5 $R3
  StrLen $R6 $R1
  tokenops_srloop_${UNIQ}:
    StrCpy $R7 $R1 $R5
    StrCmp $R7 $R3 tokenops_srfound_${UNIQ}
    StrCpy $R7 $R1 1
    StrCpy $R2 "$R2$R7"
    StrCpy $R1 $R1 $R6 1
    StrCmp $R1 "" tokenops_srdone_${UNIQ} tokenops_srloop_${UNIQ}
  tokenops_srfound_${UNIQ}:
    StrCpy $R2 "$R2$R4"
    StrCpy $R1 $R1 $R6 $R5
    StrCmp $R1 "" tokenops_srdone_${UNIQ} tokenops_srloop_${UNIQ}
  tokenops_srdone_${UNIQ}:
  StrCpy "${STR}" $R2
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
!macroend

; Strips one stale PATH entry, however it is joined to its neighbours.
!macro TokenOpsRemoveOneOccurrence UNIQ PATHVAR NEEDLE
  !insertmacro TokenOpsStrReplaceAll "${UNIQ}A" "${PATHVAR}" ";${NEEDLE}" ""
  !insertmacro TokenOpsStrReplaceAll "${UNIQ}B" "${PATHVAR}" "${NEEDLE};" ""
  !insertmacro TokenOpsStrReplaceAll "${UNIQ}C" "${PATHVAR}" "${NEEDLE}" ""
!macroend

!macro TokenOpsRemoveStaleBinFromPath
  Push $0 ; original PATH
  Push $1 ; working copy
  Push $2 ; expanded stale entry
  Push $3 ; literal-token stale entry

  ReadRegStr $0 HKCU "Environment" "Path"
  StrCpy $1 $0
  StrCpy $2 "$LOCALAPPDATA\TokenOps\bin"
  StrCpy $3 "%LOCALAPPDATA%\TokenOps\bin"

  !insertmacro TokenOpsRemoveOneOccurrence "tobin1" $1 $2
  !insertmacro TokenOpsRemoveOneOccurrence "tobin2" $1 $3

  StrCmp $1 $0 tokenops_path_unchanged
    WriteRegExpandStr HKCU "Environment" "Path" $1
    ; Broadcast WM_SETTINGCHANGE so newly opened shells pick up the change
    ; without requiring a logoff/logon.
    SendMessage 0xffff 0x001A 0 "STR:Environment" /TIMEOUT=5000
  tokenops_path_unchanged:

  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
