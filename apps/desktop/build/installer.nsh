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
  Pop $0 ; discard the exit code nsExec::Exec pushes; nothing here depends on it
  DeleteRegValue HKCU "Environment" "TOKENOPS_HOME"
  !insertmacro TokenOpsRemoveStaleBinFromPath "main"
!macroend

; ---------------------------------------------------------------------------
; Remove-all substring replace, inlined via macro (adapted from the well-known
; NSIS "Replace Sub String" recipe). UNIQ must be unique across every
; expansion of this macro in the compiled script, since NSIS labels are
; plain text and not scoped to a macro instantiation.
;
; This is a raw, unanchored substring replace -- it has no notion of PATH
; entry boundaries. Do not call it directly on ";"-delimited PATH data; use
; TokenOpsRemovePathEntry below, which anchors the match first.
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

; ---------------------------------------------------------------------------
; Removes every occurrence of NEEDLE as a *whole* ";"-delimited PATH entry
; from PATHVAR -- never as a mere prefix of a longer entry.
;
; A naive unanchored substring replace of NEEDLE (with an adjacent ";" glued
; on to each side, tried as three separate passes) matches inside any entry
; that merely *starts with* NEEDLE: "...\TokenOps\bin\tools" would have its
; ";...\TokenOps\bin" prefix eaten, gluing "\tools" onto the *previous*
; entry and corrupting it. This machine's own PATH has trailing-backslash
; entries (e.g. "...\Python312\Scripts\"), so a "...\TokenOps\bin\" sibling
; is not a hypothetical case.
;
; Fix: wrap PATHVAR in an artificial leading/trailing ";" so every entry --
; including the first and last -- is delimiter-bounded on *both* sides, then
; do one anchored replace of ";NEEDLE;" -> ";". That can only match a
; complete entry, since neither side of "NEEDLE" is ";" unless NEEDLE really
; is the whole entry. Finally strip the artificial wrapping back off.
;
; (A single pass is sufficient here: nothing that writes this PATH entry --
; not the old install.ps1, via its `-notcontains` guard, nor this file --
; ever produces back-to-back duplicate entries for it to miss.)
; ---------------------------------------------------------------------------
!macro TokenOpsRemovePathEntry UNIQ PATHVAR NEEDLE
  Push $R8
  StrCpy $R8 ";${PATHVAR};"
  !insertmacro TokenOpsStrReplaceAll "${UNIQ}" $R8 ";${NEEDLE};" ";"
  StrCpy $R8 $R8 "" 1 ; drop the artificial leading ";"
  StrCpy $R8 $R8 -1   ; drop the artificial trailing ";"
  StrCpy "${PATHVAR}" $R8
  Pop $R8
!macroend

!macro TokenOpsRemoveStaleBinFromPath UNIQ
  Push $0 ; original PATH
  Push $1 ; working copy
  Push $2 ; expanded stale entry
  Push $3 ; literal-token stale entry

  ReadRegStr $0 HKCU "Environment" "Path"
  StrCpy $1 $0
  StrCpy $2 "$LOCALAPPDATA\TokenOps\bin"
  StrCpy $3 "%LOCALAPPDATA%\TokenOps\bin"

  !insertmacro TokenOpsRemovePathEntry "${UNIQ}rpe1" $1 $2
  !insertmacro TokenOpsRemovePathEntry "${UNIQ}rpe2" $1 $3

  StrCmp $1 $0 tokenops_path_unchanged_${UNIQ}
    WriteRegExpandStr HKCU "Environment" "Path" $1
    ; Broadcast WM_SETTINGCHANGE so newly opened shells pick up the change
    ; without requiring a logoff/logon.
    SendMessage 0xffff 0x001A 0 "STR:Environment" /TIMEOUT=5000
  tokenops_path_unchanged_${UNIQ}:

  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
