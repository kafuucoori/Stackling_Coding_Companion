!macro NSIS_HOOK_PREUNINSTALL
  ; Updates reuse the uninstaller internally. Keep integrations registered so
  ; an upgrade does not require launching the app again to restore its hooks.
  ${If} $UpdateMode <> 1
    DetailPrint "正在移除 Stackling 的 Agent 集成..."
    nsExec::ExecToLog '"$INSTDIR\${MAINBINARYNAME}.exe" --uninstall-cleanup'
    Pop $0
    ${If} $0 <> 0
      DetailPrint "部分 Agent 集成未能自动清理（退出码：$0）"
    ${EndIf}
  ${EndIf}
!macroend
