use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::agent_monitor::ClaudeSession;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub text: String,
    pub timestamp: Option<String>,
}

fn claude_session_file_path(session_id: &str, cwd: &str) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    let project_dir = cwd.replace(['/', '\\', ':', '.'], "-");
    home.join(".claude")
        .join("projects")
        .join(project_dir)
        .join(format!("{}.jsonl", session_id))
}

fn collect_jsonl_files_recursive(root: &std::path::Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if !root.exists() {
        return out;
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                out.push(path);
            }
        }
    }
    out
}

pub(crate) fn collect_claude_project_jsonl_files() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    let claude_projects = home.join(".claude").join("projects");
    if !claude_projects.exists() {
        return Vec::new();
    }
    let mut out = Vec::new();
    if let Ok(project_dirs) = std::fs::read_dir(claude_projects) {
        for project_entry in project_dirs.flatten() {
            let project_dir = project_entry.path();
            if !project_dir.is_dir() {
                continue;
            }
            if let Ok(files) = std::fs::read_dir(project_dir) {
                for file_entry in files.flatten() {
                    let path = file_entry.path();
                    if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                        out.push(path);
                    }
                }
            }
        }
    }
    out
}

pub(crate) fn collect_codex_session_jsonl_files() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    let codex_sessions = home.join(".Codex").join("sessions");
    collect_jsonl_files_recursive(&codex_sessions)
}

fn find_claude_session_file(session_id: &str) -> Option<PathBuf> {
    let target = format!("{}.jsonl", session_id);
    collect_claude_project_jsonl_files()
        .into_iter()
        .find(|path| path.file_name().and_then(|n| n.to_str()) == Some(target.as_str()))
}

fn find_codex_session_file(session_id: &str) -> Option<PathBuf> {
    for path in collect_codex_session_jsonl_files() {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.ends_with(".jsonl") && name.contains(session_id) {
            return Some(path);
        }
    }
    None
}

pub(crate) fn resolve_session_jsonl_path(session_id: &str, cwd: Option<&str>) -> Option<PathBuf> {
    if let Some(cwd_str) = cwd {
        if !cwd_str.is_empty() {
            let by_cwd = claude_session_file_path(session_id, cwd_str);
            if by_cwd.exists() {
                return Some(by_cwd);
            }
        }
    }
    find_claude_session_file(session_id).or_else(|| find_codex_session_file(session_id))
}

fn read_file_tail(path: &std::path::Path, max_bytes: u64) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes)?;
    if start > 0 {
        if let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') {
            bytes.drain(..=newline);
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn check_interrupted(path: &std::path::Path) -> bool {
    if let Ok(content) = read_file_tail(path, 512 * 1024) {
        for line in content.lines().rev().take(120) {
            if line.contains("\"type\":\"event_msg\"") && line.contains("\"type\":\"turn_aborted\"")
            {
                return true;
            }
            if line.contains("\"type\":\"function_call_output\"") {
                if line.contains("rejected by user")
                    || line.contains("Rejected(\\\"rejected by user\\\")")
                {
                    return true;
                }
                return false;
            }
            if line.contains("\"type\":\"event_msg\"") && line.contains("\"type\":\"user_message\"")
            {
                return false;
            }
            if line.contains("\"type\":\"user\"") {
                return line.contains("[Request interrupted by user")
                    || line.contains("<turn_aborted>");
            }
        }
    }
    false
}

pub(crate) fn session_transcript_was_interrupted(session_id: &str, cwd: &str) -> bool {
    resolve_session_jsonl_path(session_id, Some(cwd))
        .as_deref()
        .is_some_and(check_interrupted)
}

pub(crate) fn stop_event_was_interrupted(
    event: &serde_json::Value,
    session_source: &str,
    claude_status: &str,
) -> bool {
    let status = claude_status.trim().to_ascii_lowercase();
    if session_source == "cursor" {
        if status == "completed" {
            return false;
        }
        if matches!(
            status.as_str(),
            "interrupted" | "cancelled" | "canceled" | "aborted" | "stopped"
        ) {
            return true;
        }
    }

    let stop_message = event
        .get("lastResponse")
        .or_else(|| event.get("last_assistant_message"))
        .or_else(|| event.get("codex_last_assistant_message"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if stop_message.contains("[Request interrupted by user")
        || stop_message.contains("<turn_aborted>")
        || stop_message.contains("turn_aborted")
        || stop_message.contains("rejected by user")
    {
        return true;
    }

    event
        .get("transcript_path")
        .and_then(|v| v.as_str())
        .filter(|p| !p.is_empty())
        .map(|p| check_interrupted(std::path::Path::new(p)))
        .unwrap_or(false)
}

use notify::{RecursiveMode, Watcher};

static SESSION_WATCHERS: std::sync::LazyLock<Mutex<HashMap<String, notify::RecommendedWatcher>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

const WATCHER_DEBOUNCE_MS: u64 = 200;

pub(crate) fn start_session_file_watcher(
    session_id: String,
    jsonl_path: PathBuf,
    sessions: Arc<Mutex<HashMap<String, ClaudeSession>>>,
    app: tauri::AppHandle,
) {
    stop_session_file_watcher(&session_id);

    let sid = session_id.clone();
    let path_for_handler = jsonl_path.clone();

    let initial_size = std::fs::metadata(&jsonl_path).map(|m| m.len()).unwrap_or(0);
    let last_size = Arc::new(Mutex::new(initial_size));
    let generation = Arc::new(AtomicU64::new(0));

    let watcher_result =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                if !event.kind.is_modify() {
                    return;
                }

                let sessions2 = sessions.clone();
                let app2 = app.clone();
                let sid2 = sid.clone();
                let path2 = path_for_handler.clone();
                let last_size2 = last_size.clone();
                let generation2 = generation.clone();
                let event_generation = generation2.fetch_add(1, Ordering::Relaxed) + 1;

                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(WATCHER_DEBOUNCE_MS));
                    if generation2.load(Ordering::Relaxed) != event_generation {
                        return;
                    }

                    let new_size = std::fs::metadata(&path2).map(|m| m.len()).unwrap_or(0);
                    let mut prev = last_size2.lock().unwrap();
                    if *prev == new_size {
                        return;
                    }
                    *prev = new_size;
                    drop(prev);

                    let interrupted = check_interrupted(&path2);

                    let mut sessions_guard = sessions2.lock().unwrap();
                    let session = match sessions_guard.get_mut(&sid2) {
                        Some(s) => s,
                        None => return,
                    };

                    let mut changed = false;

                    if matches!(
                        session.status.as_str(),
                        "processing" | "tool_running" | "waiting"
                    ) && interrupted
                    {
                        log::info!("File watcher: interrupted session {}", sid2);
                        session.status = "stopped".to_string();
                        let now_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        session.task_duration_ms = session
                            .task_started_at
                            .map(|started_at| now_ms.saturating_sub(started_at));
                        if let Some(waiting_started_at) = session.waiting_started_at.take() {
                            session.waiting_duration_ms = session
                                .waiting_duration_ms
                                .saturating_add(now_ms.saturating_sub(waiting_started_at));
                        }
                        session.tool = None;
                        session.tool_input = None;
                        changed = true;
                    }

                    if changed {
                        session.updated_at = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        let _ = app2.emit("claude-session-update", &sid2);
                    }
                });
            }
        });

    match watcher_result {
        Ok(mut watcher) => {
            if let Err(e) = watcher.watch(&jsonl_path, RecursiveMode::NonRecursive) {
                log::error!("Failed to watch session file {:?}: {}", jsonl_path, e);
                return;
            }
            log::info!(
                "Started file watcher for session {} at {:?}",
                session_id,
                jsonl_path
            );
            SESSION_WATCHERS.lock().unwrap().insert(session_id, watcher);
        }
        Err(e) => {
            log::error!("Failed to create file watcher: {}", e);
        }
    }
}

pub(crate) fn stop_session_file_watcher(session_id: &str) {
    if let Some(_watcher) = SESSION_WATCHERS.lock().unwrap().remove(session_id) {
        log::info!("Stopped file watcher for session {}", session_id);
    }
}

#[tauri::command]
pub async fn get_claude_conversation(session_id: String) -> Result<Vec<ChatMessage>, String> {
    let path = match resolve_session_jsonl_path(&session_id, None) {
        Some(p) => p,
        None => return Ok(vec![]),
    };

    let content = read_file_tail(&path, 16 * 1024 * 1024).map_err(|e| e.to_string())?;
    let mut messages = Vec::new();
    let max_messages = 1000;

    for line in content.lines().rev() {
        if messages.len() >= max_messages {
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let msg_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");

        if msg_type == "assistant" || msg_type == "user" || msg_type == "human" {
            if parsed
                .get("isMeta")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                continue;
            }

            let role = if msg_type == "assistant" {
                "assistant"
            } else {
                "user"
            };
            let text = if let Some(s) = parsed
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
            {
                s.to_string()
            } else if let Some(arr) = parsed
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            {
                arr.iter()
                    .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                continue;
            };

            if text.trim().is_empty() {
                continue;
            }
            if text.starts_with("<command-name>") || text.starts_with("[Request interrupted") {
                continue;
            }
            if text.starts_with("<task-notification>") || text.starts_with("<local-command") {
                continue;
            }

            let text = if text
                .starts_with("This session is being continued from a previous conversation")
            {
                "/compact".to_string()
            } else {
                text
            };
            let timestamp = parsed
                .get("timestamp")
                .and_then(|t| t.as_str())
                .map(String::from);
            messages.push(ChatMessage {
                role: role.to_string(),
                text,
                timestamp,
            });
            continue;
        }

        if msg_type == "event_msg" {
            let payload_type = parsed
                .get("payload")
                .and_then(|p| p.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let role = match payload_type {
                "user_message" => "user",
                "agent_message" => "assistant",
                _ => continue,
            };
            let text = parsed
                .get("payload")
                .and_then(|p| p.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if text.trim().is_empty() {
                continue;
            }
            let timestamp = parsed
                .get("timestamp")
                .and_then(|t| t.as_str())
                .map(String::from);
            messages.push(ChatMessage {
                role: role.to_string(),
                text,
                timestamp,
            });
        }
    }

    messages.reverse();
    Ok(messages)
}
