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
    let codex_home = std::env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".codex"));
    let mut files = collect_jsonl_files_recursive(&codex_home.join("sessions"));
    files.extend(collect_jsonl_files_recursive(
        &codex_home.join("archived_sessions"),
    ));
    files
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

fn find_cursor_session_file(projects: &std::path::Path, session_id: &str) -> Option<PathBuf> {
    // Current Cursor layout: projects/<project>/agent-transcripts/<id>/<id>.jsonl.
    std::fs::read_dir(projects)
        .ok()?
        .flatten()
        .map(|entry| {
            entry
                .path()
                .join("agent-transcripts")
                .join(session_id)
                .join(format!("{session_id}.jsonl"))
        })
        .find(|path| path.is_file())
}

pub(crate) fn resolve_session_jsonl_path(
    session_id: &str,
    cwd: Option<&str>,
    source: &str,
) -> Option<PathBuf> {
    if source == "codex" {
        return find_codex_session_file(session_id);
    }
    if source == "cursor" {
        return find_cursor_session_file(&dirs::home_dir()?.join(".cursor/projects"), session_id);
    }
    if source != "cc" {
        return None;
    }
    if let Some(cwd_str) = cwd {
        if !cwd_str.is_empty() {
            let by_cwd = claude_session_file_path(session_id, cwd_str);
            if by_cwd.exists() {
                return Some(by_cwd);
            }
        }
    }
    find_claude_session_file(session_id)
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

fn check_interrupted(path: &std::path::Path, source: &str) -> bool {
    let Ok(content) = read_file_tail(path, 512 * 1024) else {
        return false;
    };
    transcript_was_interrupted(&content, source)
}

fn transcript_was_interrupted(content: &str, source: &str) -> bool {
    for record in content
        .lines()
        .rev()
        .take(120)
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
    {
        if source == "codex" && record.get("type").and_then(|v| v.as_str()) == Some("event_msg") {
            // These are current lifecycle events, not the removed chat-message format.
            match record.pointer("/payload/type").and_then(|v| v.as_str()) {
                Some("turn_aborted") => return true,
                Some("task_started" | "task_complete") => return false,
                _ => {}
            }
        }
        let user_text = match source {
            "codex"
                if record.get("type").and_then(|v| v.as_str()) == Some("response_item")
                    && record.pointer("/payload/type").and_then(|v| v.as_str())
                        == Some("message")
                    && record.pointer("/payload/role").and_then(|v| v.as_str()) == Some("user") =>
            {
                record
                    .pointer("/payload/content")
                    .and_then(|v| text_blocks(v, &["input_text"]))
            }
            "cc" if record.get("type").and_then(|v| v.as_str()) == Some("user") => {
                record.pointer("/message/content").and_then(|v| {
                    v.as_str()
                        .map(String::from)
                        .or_else(|| text_blocks(v, &["text"]))
                })
            }
            _ => None,
        };
        if let Some(text) = user_text {
            return text
                .trim_start()
                .starts_with("[Request interrupted by user")
                || text.trim_start().starts_with("<turn_aborted>");
        }
    }
    false
}

pub(crate) fn session_transcript_was_interrupted(session: &ClaudeSession) -> bool {
    session
        .transcript_path
        .clone()
        .filter(|path| path.is_file())
        .or_else(|| {
            resolve_session_jsonl_path(&session.session_id, Some(&session.cwd), &session.source)
        })
        .as_deref()
        .is_some_and(|path| check_interrupted(path, &session.source))
}

pub(crate) fn stop_event_was_interrupted(
    event: &serde_json::Value,
    session_source: &str,
    claude_status: &str,
) -> bool {
    let status = claude_status.trim().to_ascii_lowercase();
    if session_source == "cursor" {
        // Current Cursor stop status is completed, aborted, or error.
        return status != "completed";
    }

    let stop_message = event
        .get("last_assistant_message")
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
        .map(|p| check_interrupted(std::path::Path::new(p), session_source))
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

                    let source = sessions2
                        .lock()
                        .unwrap()
                        .get(&sid2)
                        .map(|session| session.source.clone());
                    let Some(source) = source else {
                        return;
                    };
                    let interrupted = check_interrupted(&path2, &source);

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
pub async fn get_claude_conversation(
    session_id: String,
    state: tauri::State<'_, crate::agent_monitor::ClaudeState>,
) -> Result<Vec<ChatMessage>, String> {
    let (source, reported_path) = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(&session_id)
        .map(|session| {
            (
                session.source.clone(),
                session
                    .transcript_path
                    .clone()
                    .filter(|path| path.is_file()),
            )
        })
        .ok_or("会话已结束，请返回列表重新选择")?;
    let path =
        match reported_path.or_else(|| resolve_session_jsonl_path(&session_id, None, &source)) {
            Some(p) => p,
            None => return Ok(vec![]),
        };

    let content = read_file_tail(&path, 16 * 1024 * 1024).map_err(|e| e.to_string())?;
    Ok(parse_conversation(&content, &source))
}

// These readers intentionally accept only the current schema for each source.
fn text_blocks(content: &serde_json::Value, types: &[&str]) -> Option<String> {
    let text = content
        .as_array()?
        .iter()
        .filter(|block| {
            block
                .get("type")
                .and_then(|v| v.as_str())
                .is_some_and(|kind| types.contains(&kind))
        })
        .filter_map(|block| block.get("text").and_then(|v| v.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    (!text.trim().is_empty()).then_some(text)
}

fn conversation_message(record: &serde_json::Value, source: &str) -> Option<ChatMessage> {
    let (role, text) = match source {
        "codex" => {
            if record.get("type")?.as_str()? != "response_item" {
                return None;
            }
            let payload = record.get("payload")?;
            if payload.get("type")?.as_str()? != "message" {
                return None;
            }
            let role = payload.get("role")?.as_str()?;
            let text = text_blocks(payload.get("content")?, &["input_text", "output_text"])?;
            (role, text)
        }
        "cc" => {
            let role = record.get("type")?.as_str()?;
            if record.get("isMeta").and_then(|v| v.as_bool()) == Some(true) {
                return None;
            }
            let content = record.get("message")?.get("content")?;
            // Current Claude user prompts may be strings; assistant replies use blocks.
            let text = if role == "user" && content.is_string() {
                content.as_str()?.to_string()
            } else {
                text_blocks(content, &["text"])?
            };
            if text.starts_with("<command-name>")
                || text.starts_with("[Request interrupted")
                || text.starts_with("<task-notification>")
                || text.starts_with("<local-command")
                || text.starts_with("This session is being continued from a previous conversation")
            {
                return None;
            }
            (role, text)
        }
        "cursor" => {
            let role = record.get("role")?.as_str()?;
            let text = text_blocks(record.get("message")?.get("content")?, &["text"])?;
            (role, text)
        }
        _ => return None,
    };
    if !matches!(role, "user" | "assistant") || text.trim().is_empty() {
        return None;
    }
    Some(ChatMessage {
        role: role.to_string(),
        text,
        timestamp: record
            .get("timestamp")
            .and_then(|v| v.as_str())
            .map(String::from),
    })
}

fn parse_conversation(content: &str, source: &str) -> Vec<ChatMessage> {
    let mut messages = content
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter_map(|record| conversation_message(&record, source))
        .take(1000)
        .collect::<Vec<_>>();
    messages.reverse();
    messages
}

#[cfg(test)]
mod conversation_tests {
    use super::{
        find_cursor_session_file, parse_conversation, read_file_tail, stop_event_was_interrupted,
        transcript_was_interrupted,
    };
    use serde_json::json;

    #[test]
    fn reads_current_codex_messages_without_mirrors_or_internal_items() {
        let records = [
            json!({"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"internal"}]}}),
            json!({"type":"response_item","timestamp":"first","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"修复历史记录 🌸"}]}}),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"修复历史记录 🌸"}}),
            json!({"type":"response_item","payload":{"type":"reasoning","summary":[{"text":"private reasoning"}]}}),
            json!({"type":"response_item","timestamp":"second","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"已经修复"},{"type":"output_text","text":"可以读取"}]}}),
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"已经修复\n可以读取"}}),
        ];
        let content = records
            .iter()
            .map(|r| r.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let messages = parse_conversation(&content, "codex");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].text, "修复历史记录 🌸");
        assert_eq!(messages[0].timestamp.as_deref(), Some("first"));
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].text, "已经修复\n可以读取");
    }

    #[test]
    fn rejects_old_codex_messages_and_reads_current_claude() {
        let legacy = concat!(
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"question\"}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"answer\"}}\n"
        );
        assert!(parse_conversation(legacy, "codex").is_empty());
        let claude = concat!(
            "{\"type\":\"user\",\"message\":{\"content\":\"question\"}}\n",
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"answer\"}]}}\n"
        );
        let messages = parse_conversation(claude, "cc");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1].text, "answer");
    }

    #[test]
    fn reads_current_cursor_without_tools_reasoning_or_control_lines() {
        let records = [
            json!({"role":"user","message":{"content":[{"type":"text","text":"question"}]}}),
            json!({"role":"assistant","message":{"content":[{"type":"text","text":"answer"},{"type":"tool_use","name":"Read"},{"type":"thinking","thinking":"internal"}]}}),
            json!({"role":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}),
            json!({"type":"turn_ended","status":"success"}),
        ];
        let content = records
            .iter()
            .map(|r| r.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let messages = parse_conversation(&content, "cursor");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].text, "answer");
        assert!(parse_conversation(&content, "cc").is_empty());
        assert!(parse_conversation(&content, "codex").is_empty());
    }

    #[test]
    fn rejects_removed_aliases_and_guessed_codex_content_shapes() {
        let records = [
            json!({"type":"human","message":{"content":"old alias"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":"old string"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"text","text":"wrong block type"}]}}),
        ];
        let content = records
            .iter()
            .map(|r| r.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        for source in ["cc", "codex", "cursor", "unknown"] {
            assert!(parse_conversation(&content, source).is_empty());
        }
    }

    #[test]
    fn current_lifecycle_events_reset_interruption_at_new_turn() {
        let aborted = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"turn_aborted\"}}";
        assert!(transcript_was_interrupted(aborted, "codex"));
        let prompt = json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"new task"}]}});
        assert!(!transcript_was_interrupted(
            &format!("{aborted}\n{prompt}"),
            "codex"
        ));
        assert!(!transcript_was_interrupted(aborted, "cc"));
        assert!(!transcript_was_interrupted(aborted, "cursor"));
        assert!(stop_event_was_interrupted(&json!({}), "cursor", "error"));
        assert!(stop_event_was_interrupted(&json!({}), "cursor", "aborted"));
        assert!(!stop_event_was_interrupted(
            &json!({}),
            "cursor",
            "completed"
        ));
    }

    #[test]
    fn finds_current_cursor_transcript_layout() {
        let root = std::env::temp_dir().join(format!(
            "stackling-cursor-transcript-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let dir = root.join("project/agent-transcripts/session-id");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session-id.jsonl");
        std::fs::write(&path, "").unwrap();
        assert_eq!(find_cursor_session_file(&root, "session-id"), Some(path));
        assert!(find_cursor_session_file(&root, "missing").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ignores_truncated_lines_and_keeps_recent_message_limit() {
        let record = json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}).to_string();
        let content = format!(
            "truncated\n{}\n{{",
            std::iter::repeat(record)
                .take(1005)
                .collect::<Vec<_>>()
                .join("\n")
        );
        assert_eq!(parse_conversation(&content, "codex").len(), 1000);
    }

    #[test]
    #[ignore = "Set STACKLING_TEST_TRANSCRIPT to a local Codex JSONL file"]
    fn reads_local_codex_transcript() {
        assert_local_transcript("codex", "STACKLING_TEST_TRANSCRIPT");
    }

    #[test]
    #[ignore = "Set STACKLING_TEST_CURSOR_TRANSCRIPT to a local Cursor JSONL file"]
    fn reads_local_cursor_transcript() {
        assert_local_transcript("cursor", "STACKLING_TEST_CURSOR_TRANSCRIPT");
    }

    fn assert_local_transcript(source: &str, variable: &str) {
        let path = std::env::var_os(variable).expect("set transcript path environment variable");
        let content = read_file_tail(std::path::Path::new(&path), 16 * 1024 * 1024).unwrap();
        let messages = parse_conversation(&content, source);
        let users = messages.iter().filter(|m| m.role == "user").count();
        let assistants = messages.iter().filter(|m| m.role == "assistant").count();
        assert!(
            users > 0 && assistants > 0,
            "expected user and assistant messages"
        );
        println!("{source}: parsed {users} user messages and {assistants} assistant messages; text omitted");
    }
}
