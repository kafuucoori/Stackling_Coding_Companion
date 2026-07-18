// Agent session state, event parsing, and window-focus commands.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::agent_files::{
    resolve_session_jsonl_path, start_session_file_watcher, stop_event_was_interrupted,
    stop_session_file_watcher,
};
use crate::agent_focus::{
    find_host_app_for_pid_win, frontmost_matches_host_terminal, get_active_ghostty_terminal_id,
    get_frontmost_app_name, is_codex_frontmost_app, is_cursor_frontmost_app, normalize_cursor_path,
    try_recover_cursor_mojibake,
};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClaudeSession {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub cwd: String,
    pub status: String,
    pub tool: Option<String>,
    #[serde(rename = "toolInput")]
    pub tool_input: Option<String>,
    #[serde(rename = "userPrompt")]
    pub user_prompt: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: u64,
    #[serde(rename = "taskStartedAt", skip_serializing_if = "Option::is_none")]
    pub task_started_at: Option<u64>,
    #[serde(rename = "taskDurationMs", skip_serializing_if = "Option::is_none")]
    pub task_duration_ms: Option<u64>,
    #[serde(rename = "waitingDurationMs")]
    pub waiting_duration_ms: u64,
    #[serde(skip)]
    pub waiting_started_at: Option<u64>,
    /// Stable process id used to clear stale Claude Code sessions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// Outstanding sub-agents; completion sound waits until this reaches zero.
    #[serde(skip)]
    pub pending_agents: u32,
    /// Truncated final response shown in the completion reminder.
    #[serde(rename = "lastResponse", skip_serializing_if = "Option::is_none")]
    pub last_response: Option<String>,
    #[serde(skip)]
    pub is_active_tab: bool,
    /// Session source: "cc", "codex", or "cursor".
    pub source: String,
    /// Ghostty tab id for precise terminal focusing.
    #[serde(skip)]
    pub terminal_id: Option<String>,
    /// Host app/terminal used for focus and stale-session heuristics.
    #[serde(skip)]
    pub host_terminal: Option<String>,
}

pub type PendingPermissions = Arc<Mutex<HashMap<String, std::sync::mpsc::Sender<String>>>>;

pub struct ClaudeState {
    pub sessions: Arc<Mutex<HashMap<String, ClaudeSession>>>,
    pub pending_permissions: PendingPermissions,
}

fn codex_requires_escalation(event: &serde_json::Value) -> bool {
    fn read_bool(v: &serde_json::Value, keys: &[&str]) -> bool {
        keys.iter()
            .filter_map(|k| v.get(k))
            .any(|x| x.as_bool().unwrap_or(false))
    }

    fn read_string<'a>(v: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
        keys.iter().find_map(|k| v.get(k).and_then(|x| x.as_str()))
    }

    fn has_explicit_escalation_markers(v: &serde_json::Value) -> bool {
        let sandbox_mode =
            read_string(v, &["sandbox_permissions", "sandboxPermissions"]).unwrap_or("");
        if sandbox_mode.eq_ignore_ascii_case("require_escalated")
            || sandbox_mode.eq_ignore_ascii_case("escalated")
        {
            return true;
        }
        if read_bool(
            v,
            &[
                "with_escalated_permissions",
                "withEscalatedPermissions",
                "requires_approval",
                "requiresApproval",
                "approval_required",
                "approvalRequired",
            ],
        ) {
            return true;
        }
        let justification = read_string(v, &["justification"]).unwrap_or("").trim();
        !justification.is_empty()
    }

    fn parse_tool_input(event: &serde_json::Value) -> Option<serde_json::Value> {
        let tool_input = event.get("tool_input").or_else(|| event.get("toolInput"))?;
        if tool_input.is_object() {
            return Some(tool_input.clone());
        }
        if let Some(raw) = tool_input.as_str() {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw) {
                return Some(parsed);
            }
        }
        None
    }

    // Hard guard: this helper exists only for Codex events. CC's
    // PreToolUse payload may carry overlapping field names (e.g. a future
    // CC release adding a `justification` field), and previous iterations
    // of the looser checks below already mis-classified CC's Bash calls
    // as needing approval. Bail out immediately for anything that isn't
    // unambiguously a Codex event so the function name and behaviour
    // stay aligned, no matter what gets added inside it later.
    let is_codex_event = event.get("turn_id").is_some()
        || read_string(event, &["source"])
            .unwrap_or("")
            .eq_ignore_ascii_case("codex");
    if !is_codex_event {
        return false;
    }

    // Only trust explicit approval/escalation fields that Codex itself sets
    // on the event or inside tool_input. Anything beyond that is a guess.
    //
    // The previous fallback inspected the bash command string and flagged
    // anything containing `/Users/`, `$HOME/`, `Desktop/` or a redirect
    // operator as needing approval. That heuristic was meant to catch
    // out-of-workspace writes in `default` permission mode, but on macOS
    // virtually every read command (`sed -n '/Users/...'`, `ls /Users/...`,
    // `cat /Users/...`) tripped it. Skills like hatch-pet that live under
    // `~/.codex/skills/` would fire `is_wait_event` on every Bash tool call
    // and play the waiting sound dozens of times per task.
    //
    // Codex already owns the real permission flow: when approval is
    // actually required it fires a separate `PermissionRequest` hook event,
    // which `is_wait_event` picks up via its `hook_event == "PermissionRequest"`
    // branch. We don't need to second-guess based on command shape.
    if has_explicit_escalation_markers(event) {
        return true;
    }
    if let Some(tool_input) = parse_tool_input(event) {
        if has_explicit_escalation_markers(&tool_input) {
            return true;
        }
    }
    false
}

fn is_codex_internal_utility_event(event: &serde_json::Value) -> bool {
    let permission_mode = event
        .get("permission_mode")
        .or_else(|| event.get("permissionMode"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if permission_mode != "bypassPermissions" {
        return false;
    }

    let prompt = event
        .get("prompt")
        .or_else(|| event.get("userPrompt"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if prompt.starts_with("You are a helpful assistant. You will be presented with a user prompt") {
        return true;
    }

    let transcript_is_null = event
        .get("transcript_path")
        .map(|v| v.is_null())
        .unwrap_or(false);
    let source = event.get("source").and_then(|v| v.as_str()).unwrap_or("");
    let model = event.get("model").and_then(|v| v.as_str()).unwrap_or("");
    if transcript_is_null && (source == "startup" || model == "gpt-5.4-mini") {
        return true;
    }

    let last_message = event
        .get("last_assistant_message")
        .or_else(|| event.get("codex_last_assistant_message"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim_start();
    if last_message.starts_with("{\"title\":") {
        return true;
    }

    false
}

pub(crate) fn is_codex_internal_utility_session(session: &ClaudeSession) -> bool {
    if session.source != "codex" {
        return false;
    }

    let prompt = session.user_prompt.as_deref().unwrap_or("");
    if prompt.starts_with("You are a helpful assistant. You will be presented with a user prompt") {
        return true;
    }

    let last = session.last_response.as_deref().unwrap_or("").trim_start();
    last.starts_with("{\"title\":")
}

/// Process a hook event from Claude Code, Codex, or Cursor.
/// Returns Some((session_id, hook_event)) if the event needs further handling
/// (e.g. PermissionRequest requires blocking the connection for a response).
pub(crate) fn process_claude_event(
    buf: &str,
    state: &Arc<Mutex<HashMap<String, ClaudeSession>>>,
    app: &tauri::AppHandle,
    source_override: Option<&str>,
) -> Option<(String, String)> {
    log::debug!("[claude_event] received payload bytes={}", buf.len());
    // Defensive: strip a leading UTF-8 BOM (U+FEFF) plus any whitespace.
    // Cursor on Windows emits hook stdin with a BOM and the hook script may
    // forward it raw; serde_json refuses BOM with "expected value at column 1".
    let buf_trimmed = buf.trim_start_matches('\u{feff}').trim_start();

    // Cursor on CJK Windows emits hook payloads where CJK characters have been
    // mojibake'd through a GBK→UTF-8 round-trip upstream. Reverse it before
    // parsing so the prompt/text fields contain the original Chinese text.
    // Only applies to cursor source on Windows; CC/codex paths are untouched.
    let buf_owned: String = if source_override == Some("cursor") {
        try_recover_cursor_mojibake(buf_trimmed).unwrap_or_else(|| buf_trimmed.to_string())
    } else {
        buf_trimmed.to_string()
    };
    let buf_for_parse: &str = &buf_owned;

    if let Ok(event) = serde_json::from_str::<serde_json::Value>(buf_for_parse) {
        let session_id = event
            .get("session_id")
            .or_else(|| event.get("conversation_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if session_id.is_empty() {
            log::warn!("[claude_event] empty sessionId, ignoring");
            return None;
        }

        let raw_hook_event = event
            .get("hook_event_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        // Normalize Cursor's camelCase event names to the internal event names
        // shared with Claude Code. Current Cursor releases expose generic tool,
        // subagent, session, compaction, response, and stop lifecycle hooks.
        let hook_event = match raw_hook_event.as_str() {
            "beforeSubmitPrompt" => "UserPromptSubmit".to_string(),
            "sessionStart" => "SessionStart".to_string(),
            "sessionEnd" => "SessionEnd".to_string(),
            "preToolUse" => "PreToolUse".to_string(),
            "postToolUse" | "postToolUseFailure" => "PostToolUse".to_string(),
            "subagentStart" => "SubagentStart".to_string(),
            "subagentStop" => "SubagentStop".to_string(),
            "preCompact" => "PreCompact".to_string(),
            "afterAgentResponse" => "PostToolUse".to_string(),
            "stop" => "Stop".to_string(),
            other => other.to_string(),
        };

        // Codex desktop may emit internal utility sessions (for example title
        // generation). These should not appear in the session list or trigger
        // completion notifications.
        if is_codex_internal_utility_event(&event) {
            if let Ok(mut sessions) = state.lock() {
                sessions.remove(&session_id);
            }
            stop_session_file_watcher(&session_id);
            log::info!(
                "[claude_event] ignore internal codex utility session={} event={}",
                session_id,
                hook_event
            );
            return None;
        }

        let claude_status = event
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let reported_processing = claude_status != "waiting_for_input";

        let user_prompt = event.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
        let is_local_slash = if user_prompt.starts_with('/') {
            let cmd = user_prompt.split_whitespace().next().unwrap_or("");
            matches!(
                cmd,
                "/clear"
                    | "/compact"
                    | "/help"
                    | "/cost"
                    | "/status"
                    | "/vim"
                    | "/fast"
                    | "/model"
                    | "/login"
                    | "/logout"
            )
        } else {
            false
        };

        let pretool_needs_waiting = hook_event == "PreToolUse" && codex_requires_escalation(&event);
        let notification_type = event
            .get("notification_type")
            .or_else(|| event.get("notificationType"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let mut status = match hook_event.as_str() {
            "UserPromptSubmit" | "UserPromptExpansion" => {
                if is_local_slash {
                    "stopped".to_string()
                } else {
                    "processing".to_string()
                }
            }
            "PreCompact" => "compacting".to_string(),
            "PreToolUse" => {
                let tool = event
                    .get("tool")
                    .or_else(|| event.get("tool_name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                // Different clients may report interactive choice tools with
                // slightly different names. Treat both as waiting states so
                // the selection popup can be shown consistently.
                if tool == "AskUserQuestion" || tool == "AskQuestion" || pretool_needs_waiting {
                    "waiting".to_string()
                } else {
                    "tool_running".to_string()
                }
            }
            "PostToolUse" | "PostToolUseFailure" | "PostToolBatch" | "PermissionDenied"
            | "TaskCreated" | "TaskCompleted" | "TeammateIdle" | "CwdChanged" | "PostCompact"
            | "ElicitationResult" => "processing".to_string(),
            "Stop" | "StopFailure" => "stopped".to_string(),
            "SubagentStart" | "SubagentStop" => "processing".to_string(),
            "SessionEnd" => "ended".to_string(),
            "PermissionRequest" | "Elicitation" => "waiting".to_string(),
            "Notification" => match notification_type {
                "permission_prompt" | "elicitation_dialog" | "agent_needs_input" => {
                    "waiting".to_string()
                }
                "elicitation_complete" | "elicitation_response" | "agent_completed" => {
                    "processing".to_string()
                }
                "idle_prompt" | "auth_success" => "stopped".to_string(),
                _ => "stopped".to_string(),
            },
            "SessionStart" => "stopped".to_string(),
            _ => {
                if !reported_processing {
                    "stopped".to_string()
                } else {
                    claude_status.clone()
                }
            }
        };

        // Guard: if CC's own status is "waiting_for_input" but our event-derived
        // status says "processing"/"tool_running", something is out of sync.
        // Override to "stopped" — EXCEPT for UserPromptSubmit, where CC's status
        // field may still say "waiting_for_input" because the hook fires before
        // CC's internal state transitions. A new prompt always means processing.
        if !reported_processing
            && matches!(status.as_str(), "processing" | "tool_running")
            && hook_event != "UserPromptSubmit"
        {
            log::info!(
                "[claude_event] guard override: {} → stopped (reported_processing=false)",
                status
            );
            status = "stopped".to_string();
        }
        log::info!("[claude_event] session={} event={} claude_status={} reported_processing={} → final_status={}",
            &session_id[..session_id.len().min(8)], hook_event, claude_status, reported_processing, status);

        let was_processing;
        let was_compacting;
        let pending_agents;
        let session_source: String;
        let stop_was_interrupted;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        {
            let mut sessions = state.lock().unwrap();
            let prev_status = sessions
                .get(&session_id)
                .map(|s| s.status.clone())
                .unwrap_or_default();
            was_processing = matches!(
                prev_status.as_str(),
                "processing" | "tool_running" | "compacting"
            );
            was_compacting = prev_status == "compacting";

            if hook_event == "SessionEnd" {
                let prev = sessions.get(&session_id);
                session_source = prev
                    .map(|s| s.source.clone())
                    .unwrap_or_else(|| "cc".to_string());
                sessions.remove(&session_id);
                pending_agents = 0;
                stop_was_interrupted = false;
            } else {
                // Determine source from the socket, payload, or default to Claude Code.
                let source = source_override
                    .map(|s| s.to_string())
                    .or_else(|| {
                        event
                            .get("source")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_else(|| "cc".to_string());
                let session = sessions
                    .entry(session_id.clone())
                    .or_insert_with(|| ClaudeSession {
                        session_id: session_id.clone(),
                        cwd: String::new(),
                        status: "idle".to_string(),
                        tool: None,
                        tool_input: None,
                        user_prompt: None,
                        updated_at: 0,
                        task_started_at: None,
                        task_duration_ms: None,
                        waiting_duration_ms: 0,
                        waiting_started_at: None,
                        pid: None,
                        pending_agents: 0,
                        last_response: None,
                        is_active_tab: false,
                        source: source.clone(),
                        terminal_id: None,
                        host_terminal: None,
                    });
                // Only upgrade source, never downgrade:
                // cc < codex < cursor.
                // Once a session is identified as codex/cursor, later generic
                // CC events (source=cc) for the same sessionId must not
                // overwrite it, otherwise active-tab/staleness logic regresses.
                let source_rank = |s: &str| -> u8 {
                    match s {
                        "cc" => 1,
                        "codex" => 2,
                        "cursor" => 3,
                        _ => 0,
                    }
                };
                if source_rank(&source) >= source_rank(&session.source) {
                    session.source = source.clone();
                }

                // Track pending sub-agents:
                // - PreToolUse with tool=Agent → a sub-agent is being launched
                // - SubagentStop → a sub-agent has completed
                // Sound only plays on Stop when pending_agents == 0 (all agents done).
                let tool_name = event
                    .get("tool_name")
                    .and_then(|v| v.as_str())
                    .filter(|name| !name.is_empty())
                    .unwrap_or(match raw_hook_event.as_str() {
                        "Elicitation" => "Elicitation",
                        "Notification" => match notification_type {
                            "permission_prompt" => "PermissionNotice",
                            "elicitation_dialog" => "Elicitation",
                            "agent_needs_input" => "AgentInput",
                            _ => "",
                        },
                        _ => "",
                    });
                if hook_event == "UserPromptSubmit" {
                    // New user prompt = fresh start. Reset counter in case previous
                    // agents were killed or SubagentStop was never delivered.
                    session.pending_agents = 0;
                } else if (hook_event == "PreToolUse" && tool_name == "Agent")
                    || hook_event == "SubagentStart"
                {
                    session.pending_agents += 1;
                    log::info!(
                        "[claude_event] session={} Agent launched, pending_agents={}",
                        &session_id[..session_id.len().min(8)],
                        session.pending_agents
                    );
                } else if hook_event == "SubagentStop" {
                    session.pending_agents = session.pending_agents.saturating_sub(1);
                    log::info!(
                        "[claude_event] session={} SubagentStop, pending_agents={}",
                        &session_id[..session_id.len().min(8)],
                        session.pending_agents
                    );
                }

                if session.status == "waiting" && status != "waiting" {
                    if let Some(waiting_started_at) = session.waiting_started_at.take() {
                        session.waiting_duration_ms = session
                            .waiting_duration_ms
                            .saturating_add(now_ms.saturating_sub(waiting_started_at));
                    }
                }
                if hook_event == "UserPromptSubmit" && !is_local_slash {
                    session.task_started_at = Some(now_ms);
                    session.task_duration_ms = None;
                    session.waiting_duration_ms = 0;
                    session.waiting_started_at = None;
                }
                if status == "waiting" && session.waiting_started_at.is_none() {
                    session.waiting_started_at = Some(now_ms);
                }
                if matches!(hook_event.as_str(), "Stop" | "StopFailure") {
                    session.task_duration_ms = session
                        .task_started_at
                        .map(|started_at| now_ms.saturating_sub(started_at));
                }
                session.status = status.clone();
                let mut incoming_cwd = event
                    .get("new_cwd")
                    .or_else(|| event.get("cwd"))
                    .or_else(|| event.get("workdir"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                // Cursor's hook payload omits `cwd` entirely on Windows; it
                // exposes the workspace as URI-style `/g:/Desktop/code` under
                // `workspace_roots`. Derive cwd from there so the session list
                // can still identify and display the project.
                if incoming_cwd.is_empty() && session.source == "cursor" {
                    if let Some(roots) = event.get("workspace_roots").and_then(|v| v.as_array()) {
                        if let Some(first) = roots.first().and_then(|v| v.as_str()) {
                            incoming_cwd = normalize_cursor_path(first);
                        }
                    }
                }
                if !incoming_cwd.is_empty() || session.cwd.is_empty() {
                    session.cwd = incoming_cwd;
                }
                session.updated_at = now_ms;

                if !tool_name.is_empty() {
                    session.tool = Some(tool_name.to_string());
                }
                if let Some(tool_input_val) = event.get("tool_input") {
                    let tool_input_text = tool_input_val
                        .as_str()
                        .map(|s| s.to_string())
                        .or_else(|| serde_json::to_string(tool_input_val).ok());
                    if let Some(t) = tool_input_text {
                        if !t.is_empty() {
                            session.tool_input = Some(t);
                        }
                    }
                } else {
                    let tool_input_text = match raw_hook_event.as_str() {
                        "Elicitation" => event.get("message").and_then(|v| v.as_str()),
                        _ => None,
                    };
                    if let Some(text) = tool_input_text.filter(|text| !text.is_empty()) {
                        session.tool_input = Some(text.to_string());
                    }
                }
                if let Some(t) = event.get("prompt").and_then(|v| v.as_str()) {
                    if !t.is_empty() {
                        session.user_prompt = Some(t.to_string());
                    }
                }
                // Store CC process PID from hook event for stale-session detection
                if let Some(p) = event.get("pid").and_then(|v| v.as_u64()) {
                    let pid_u32 = p as u32;
                    session.pid = Some(pid_u32);
                    if session.host_terminal.is_none() && session.source != "cursor" {
                        session.host_terminal = find_host_app_for_pid_win(pid_u32);
                        log::info!(
                            "[claude_event] session={} host_terminal={:?}",
                            &session_id[..session_id.len().min(8)],
                            session.host_terminal
                        );
                    }
                }

                // Read "host" field injected by the hook script (e.g. "claude_desktop")
                if session.host_terminal.is_none() {
                    if let Some(host) = event.get("host").and_then(|v| v.as_str()) {
                        let ht = match host {
                            "claude_desktop" => "Claude Desktop",
                            "codex_cli" | "codex_app" => "Codex",
                            _ => host,
                        };
                        session.host_terminal = Some(ht.to_string());
                        log::info!(
                            "[claude_event] session={} host_terminal={:?} (from hook host field)",
                            &session_id[..session_id.len().min(8)],
                            session.host_terminal
                        );
                    }
                }

                // Store Ghostty terminal ID from hook event for precise tab jumping.
                // The hook captures this from inside the CC terminal, so it's
                // always the correct tab — even for pre-existing sessions.
                if session.terminal_id.is_none() {
                    if let Some(tid) = event.get("terminalId").and_then(|v| v.as_str()) {
                        if !tid.is_empty() {
                            log::info!(
                                "[claude_event] session={} stored terminal_id={}",
                                &session_id[..session_id.len().min(8)],
                                tid
                            );
                            session.terminal_id = Some(tid.to_string());
                        }
                    }
                }

                if matches!(
                    hook_event.as_str(),
                    "PostToolUse"
                        | "PostToolUseFailure"
                        | "PostToolBatch"
                        | "PermissionDenied"
                        | "ElicitationResult"
                        | "Stop"
                        | "StopFailure"
                        | "SubagentStop"
                ) {
                    session.tool = None;
                    session.tool_input = None;
                }

                // Store AI's last response for the completion reminder popup.
                // Clear on new prompt so stale responses don't linger.
                //
                // For Cursor: afterAgentResponse fires before stop and carries
                // the actual response text. We stash it here so the Stop handler
                // can use it instead of a placeholder.
                if raw_hook_event == "afterAgentResponse" {
                    if let Some(resp) = event
                        .get("text")
                        .or_else(|| event.get("lastResponse"))
                        .and_then(|v| v.as_str())
                    {
                        if !resp.is_empty() {
                            session.last_response = Some(resp.to_string());
                        }
                    }
                }

                // Check at Stop time (real-time, not polling) whether the user
                // is already looking at this terminal tab. If so, skip setting
                // last_response so the completion popup never triggers.
                if hook_event == "Stop" {
                    let interrupted =
                        stop_event_was_interrupted(&event, &session.source, &claude_status);
                    // CC: check if the user is looking at this session's Ghostty tab
                    // Cursor: check if Cursor (or Stackling) is the frontmost app.
                    // If a terminal ID is unavailable, use host-terminal checks.
                    let frontmost = get_frontmost_app_name();
                    let is_ghostty_session = matches!(
                        session.host_terminal.as_deref(),
                        Some("Ghostty" | "ghostty")
                    );
                    let is_tab_active = if session.source == "cursor" {
                        is_cursor_frontmost_app(&frontmost)
                    } else if session.source == "codex" {
                        let ghostty_match = is_ghostty_session
                            && session
                                .terminal_id
                                .as_ref()
                                .and_then(|tid| get_active_ghostty_terminal_id().map(|a| a == *tid))
                                .unwrap_or(false);
                        ghostty_match || is_codex_frontmost_app(&frontmost)
                    } else if is_ghostty_session {
                        session
                            .terminal_id
                            .as_ref()
                            .and_then(|tid| get_active_ghostty_terminal_id().map(|a| a == *tid))
                            .unwrap_or(false)
                    } else if let Some(ht) = session.host_terminal.as_deref() {
                        frontmost_matches_host_terminal(&frontmost, ht)
                    } else {
                        false
                    };
                    if is_tab_active || interrupted {
                        session.last_response = None;
                    } else {
                        // Prefer lastResponse from the event itself (CC's Stop has it),
                        // then fall back to any value pre-stored by afterAgentResponse,
                        // then use a placeholder for Cursor/Codex so the popup
                        // still triggers when stop payload omits assistant text.
                        let resp_from_event = event
                            .get("lastResponse")
                            .or_else(|| event.get("last_assistant_message"))
                            .or_else(|| event.get("codex_last_assistant_message"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        if resp_from_event.is_some() {
                            session.last_response = resp_from_event;
                        } else if session.last_response.is_none()
                            && (session.source == "cursor" || session.source == "codex")
                        {
                            session.last_response = Some("✓".to_string());
                        }
                        // else: keep existing last_response from afterAgentResponse
                    }
                    stop_was_interrupted = interrupted;
                } else if hook_event == "StopFailure" {
                    session.last_response = event
                        .get("last_assistant_message")
                        .or_else(|| event.get("error_details"))
                        .or_else(|| event.get("error"))
                        .and_then(|value| value.as_str())
                        .map(str::to_string);
                    stop_was_interrupted = false;
                } else if matches!(
                    hook_event.as_str(),
                    "UserPromptSubmit" | "UserPromptExpansion"
                ) {
                    session.last_response = None;
                    stop_was_interrupted = false;
                } else {
                    stop_was_interrupted = false;
                }

                pending_agents = session.pending_agents;
                session_source = session.source.clone();
            }
        }

        let _ = app.emit("claude-session-update", &session_id);

        // Only emit completion sound on explicit Stop or PermissionRequest events.
        // Previously we checked status transitions, but guard overrides on PostToolUse
        // could falsely trigger "stopped" mid-task when CC's status field lags behind.
        // Also suppress sound while sub-agents are still running (pending_agents > 0).
        // Each PreToolUse(Agent) increments the counter, each SubagentStop decrements it.
        // Sound only plays when all sub-agents have completed.
        let is_wait_event = matches!(hook_event.as_str(), "PermissionRequest" | "Elicitation")
            || (hook_event == "Notification" && notification_type == "agent_needs_input")
            || (hook_event == "PreToolUse" && status == "waiting");
        let is_completion_stop =
            hook_event == "Stop" && pending_agents == 0 && !stop_was_interrupted;
        if was_processing && !was_compacting && (is_completion_stop || is_wait_event) {
            let is_waiting = is_wait_event;
            if cfg!(debug_assertions) {
                log::info!(
                    "[claude_event] emit claude-task-complete session={} waiting={} source={}",
                    &session_id[..session_id.len().min(8)],
                    is_waiting,
                    session_source,
                );
            }
            let _ = app.emit(
                "claude-task-complete",
                serde_json::json!({
                    "sessionId": session_id,
                    "waiting": is_waiting,
                    "source": session_source,
                }),
            );
        }

        let cwd_str = event
            .get("cwd")
            .or_else(|| event.get("workdir"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        log::info!(
            "[claude_event] session={} event={} status={} cwd={}",
            session_id,
            hook_event,
            status,
            cwd_str
        );
        if hook_event == "UserPromptSubmit" {
            if let Some(jsonl_path) = resolve_session_jsonl_path(&session_id, Some(&cwd_str)) {
                log::info!(
                    "[claude_event] session file path: {} exists={}",
                    jsonl_path.display(),
                    jsonl_path.exists()
                );
                if jsonl_path.exists() {
                    start_session_file_watcher(
                        session_id.clone(),
                        jsonl_path,
                        state.clone(),
                        app.clone(),
                    );
                }
            }
        } else if hook_event == "Stop" || hook_event == "SubagentStop" || hook_event == "SessionEnd"
        {
            stop_session_file_watcher(&session_id);
        }

        return Some((session_id, hook_event));
    } else if let Err(e) = serde_json::from_str::<serde_json::Value>(buf_for_parse) {
        log::warn!(
            "[claude_event] JSON parse failed: err={}, len={}",
            e,
            buf_for_parse.len()
        );
    }
    None
}

pub(crate) async fn install_claude_hooks() -> Result<(), String> {
    crate::claude_hooks::install_claude_hooks().await?;
    crate::codex_hooks::install_codex_hooks().await?;
    Ok(())
}

pub(crate) async fn install_cursor_hooks() -> Result<(), String> {
    crate::cursor_hooks::install_cursor_hooks().await
}
