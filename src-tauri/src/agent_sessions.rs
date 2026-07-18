use crate::agent_files::{session_transcript_was_interrupted, stop_session_file_watcher};
use crate::agent_focus::{
    frontmost_matches_host_terminal, get_active_ghostty_terminal_id, get_frontmost_app_name,
    is_codex_frontmost_app, is_codex_host_terminal, is_cursor_frontmost_app,
};
use crate::agent_monitor::{is_codex_internal_utility_session, ClaudeSession, ClaudeState};
use std::collections::HashSet;

fn is_pid_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        match handle {
            Ok(h) => {
                let mut exit_code = 0u32;
                let active = GetExitCodeProcess(h, &mut exit_code).is_ok()
                    && exit_code == STILL_ACTIVE.0 as u32;
                let _ = CloseHandle(h);
                active
            }
            Err(_) => false,
        }
    }
}
#[tauri::command]
pub async fn get_claude_sessions(
    state: tauri::State<'_, ClaudeState>,
) -> Result<Vec<ClaudeSession>, String> {
    // Clear sessions that missed a terminal Stop event. Claude Code can use PID
    // liveness; Cursor/Codex/desktop-hosted sessions rely on a 120s event timeout.
    {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let permission_sessions: HashSet<String> = state
            .pending_permissions
            .lock()
            .map_err(|e| e.to_string())?
            .keys()
            .cloned()
            .collect();
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        for session in sessions.values_mut() {
            let dominated = matches!(
                session.status.as_str(),
                "waiting" | "processing" | "tool_running" | "compacting"
            );
            if !dominated {
                continue;
            }
            if permission_sessions.contains(&session.session_id) {
                continue;
            }

            if session_transcript_was_interrupted(&session.session_id, &session.cwd) {
                log::info!(
                    "[get_claude_sessions] interrupted transcript detected for {}",
                    session.session_id
                );
                session.status = "stopped".to_string();
                session.pending_agents = 0;
                session.last_response = None;
                session.tool = None;
                session.tool_input = None;
                session.task_duration_ms = session
                    .task_started_at
                    .map(|started_at| now_ms.saturating_sub(started_at));
                if let Some(waiting_started_at) = session.waiting_started_at.take() {
                    session.waiting_duration_ms = session
                        .waiting_duration_ms
                        .saturating_add(now_ms.saturating_sub(waiting_started_at));
                }
                stop_session_file_watcher(&session.session_id);
                continue;
            }

            let is_desktop_hosted = session.host_terminal.as_deref() == Some("Claude Desktop");
            if session.source == "cursor" || session.source == "codex" || is_desktop_hosted {
                let age_ms = now_ms.saturating_sub(session.updated_at);
                if age_ms > 120_000 {
                    log::info!(
                        "[get_claude_sessions] {} session {} stale ({}ms since last event), clearing {}",
                        session.source,
                        session.session_id,
                        age_ms,
                        session.status
                    );
                    session.status = "stopped".to_string();
                    session.task_duration_ms = session
                        .task_started_at
                        .map(|started_at| now_ms.saturating_sub(started_at));
                    if let Some(waiting_started_at) = session.waiting_started_at.take() {
                        session.waiting_duration_ms = session
                            .waiting_duration_ms
                            .saturating_add(now_ms.saturating_sub(waiting_started_at));
                    }
                    session.pending_agents = 0;
                }
            } else {
                if let Some(pid) = session.pid {
                    if !is_pid_alive(pid) {
                        log::info!(
                            "[get_claude_sessions] CC pid {} dead, clearing {} for {}",
                            pid,
                            session.status,
                            session.session_id
                        );
                        session.status = "stopped".to_string();
                        session.pending_agents = 0;
                    }
                } else {
                    let age_ms = now_ms.saturating_sub(session.updated_at);
                    if age_ms > 120_000 {
                        log::info!(
                            "[get_claude_sessions] CC session {} has no pid and is stale, clearing {}",
                            session.session_id,
                            session.status
                        );
                        session.status = "stopped".to_string();
                        session.pending_agents = 0;
                        session.task_duration_ms = session
                            .task_started_at
                            .map(|started_at| now_ms.saturating_sub(started_at));
                    }
                }
            }
        }
    }

    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let active_tid = get_active_ghostty_terminal_id();
    let mut list: Vec<ClaudeSession> = sessions
        .values()
        .filter(|s| !s.cwd.is_empty())
        .filter(|s| !is_codex_internal_utility_session(s))
        .cloned()
        .collect();
    let frontmost = get_frontmost_app_name();
    let cursor_is_active = is_cursor_frontmost_app(&frontmost);
    let codex_is_active = is_codex_frontmost_app(&frontmost);
    let is_ghostty = |s: &ClaudeSession| -> bool {
        matches!(s.host_terminal.as_deref(), Some("Ghostty" | "ghostty"))
    };
    if let Some(ref tid) = active_tid {
        for s in &mut list {
            if s.source != "cursor" && is_ghostty(s) {
                s.is_active_tab = s.terminal_id.as_deref() == Some(tid.as_str());
            }
        }
    }
    for s in &mut list {
        if s.source == "cursor" {
            continue;
        }
        if s.is_active_tab {
            continue;
        }
        if s.source == "codex" {
            s.is_active_tab = codex_is_active;
        } else if let Some(ht) = s.host_terminal.as_deref() {
            if ht == "Cursor" {
                s.is_active_tab = cursor_is_active;
            } else if is_codex_host_terminal(ht) {
                s.is_active_tab = codex_is_active;
            } else if !is_ghostty(s) {
                s.is_active_tab = frontmost_matches_host_terminal(&frontmost, ht);
            }
        }
    }
    list.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    Ok(list)
}

#[tauri::command]
pub async fn remove_claude_session(
    session_id: String,
    state: tauri::State<'_, ClaudeState>,
) -> Result<(), String> {
    stop_session_file_watcher(&session_id);
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.remove(&session_id);
    Ok(())
}

#[tauri::command]
pub async fn resolve_claude_permission(
    session_id: String,
    decision: String,
    state: tauri::State<'_, ClaudeState>,
) -> Result<(), String> {
    let (tool_name, source) = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        let s = sessions.get(&session_id);
        (
            s.and_then(|s| s.tool.clone()),
            s.map(|s| s.source.clone())
                .unwrap_or_else(|| "cc".to_string()),
        )
    };

    let response_json = permission_response_json(&decision, &source, tool_name.as_deref())?;

    let tx = {
        let mut map = state
            .pending_permissions
            .lock()
            .map_err(|e| e.to_string())?;
        map.remove(&session_id)
    };

    if let Some(tx) = tx {
        if cfg!(debug_assertions) {
            log::info!(
                "[resolve_permission] sending decision='{}' tool={:?} session={} response_json={}",
                decision,
                tool_name,
                &session_id[..session_id.len().min(8)],
                response_json,
            );
        } else {
            log::info!(
                "[resolve_permission] sent '{}' tool={:?} for session={}",
                decision,
                tool_name,
                &session_id[..session_id.len().min(8)],
            );
        }
        tx.send(response_json)
            .map_err(|_| "Failed to send permission response".to_string())?;
    } else {
        log::warn!(
            "[resolve_permission] no pending permission for session={}",
            &session_id[..session_id.len().min(8)]
        );
    }

    Ok(())
}

fn permission_response_json(
    decision: &str,
    source: &str,
    tool_name: Option<&str>,
) -> Result<String, String> {
    if source == "codex" {
        return match decision {
            "deny" => Ok(serde_json::json!({
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": {
                        "behavior": "deny",
                        "message": "Denied from Stackling."
                    }
                }
            })
            .to_string()),
            "allow_once" => Ok(serde_json::json!({
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": { "behavior": "allow" }
                }
            })
            .to_string()),
            "allow_all" | "auto_approve" => Err(
                "Codex hooks do not support persistent permission updates; use allow once"
                    .to_string(),
            ),
            _ => Err(format!("Unknown decision: {decision}")),
        };
    }

    let response = match decision {
        "deny" => serde_json::json!({
            "continue": true,
            "suppressOutput": true,
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": { "behavior": "deny" }
            }
        })
        .to_string(),
        "allow_once" => serde_json::json!({
            "continue": true,
            "suppressOutput": true,
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": { "behavior": "allow" }
            }
        })
        .to_string(),
        "allow_all" => {
            let rules = if let Some(name) = tool_name {
                serde_json::json!([{ "toolName": name }])
            } else {
                serde_json::json!([])
            };
            serde_json::json!({
                "continue": true,
                "suppressOutput": true,
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": {
                        "behavior": "allow",
                        "updatedPermissions": [{
                            "type": "addRules",
                            "destination": "session",
                            "rules": rules,
                            "behavior": "allow"
                        }]
                    }
                }
            })
            .to_string()
        }
        "auto_approve" => serde_json::json!({
            "continue": true,
            "suppressOutput": true,
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {
                    "behavior": "allow",
                    "updatedPermissions": [{
                        "type": "setMode",
                        "destination": "session",
                        "mode": "bypassPermissions"
                    }]
                }
            }
        })
        .to_string(),
        _ => return Err(format!("Unknown decision: {decision}")),
    };
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::permission_response_json;

    #[test]
    fn codex_permission_responses_use_only_supported_fields() {
        let allow: serde_json::Value = serde_json::from_str(
            &permission_response_json("allow_once", "codex", Some("Bash")).unwrap(),
        )
        .unwrap();
        assert_eq!(allow["hookSpecificOutput"]["decision"]["behavior"], "allow");
        assert!(allow.get("continue").is_none());
        assert!(allow["hookSpecificOutput"]["decision"]
            .get("updatedPermissions")
            .is_none());

        let deny: serde_json::Value =
            serde_json::from_str(&permission_response_json("deny", "codex", Some("Bash")).unwrap())
                .unwrap();
        assert_eq!(deny["hookSpecificOutput"]["decision"]["behavior"], "deny");
    }

    #[test]
    fn codex_rejects_unsupported_persistent_permission_updates() {
        assert!(permission_response_json("allow_all", "codex", Some("Bash")).is_err());
        assert!(permission_response_json("auto_approve", "codex", Some("Bash")).is_err());
    }
}
