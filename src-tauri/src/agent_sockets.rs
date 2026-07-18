use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

use crate::agent_monitor::{process_claude_event, ClaudeSession, PendingPermissions};

const MAX_CONNECTIONS: usize = 32;
const MAX_PAYLOAD_BYTES: usize = 2 * 1024 * 1024;
static CURSOR_CONNECTIONS: AtomicUsize = AtomicUsize::new(0);
static CLAUDE_CONNECTIONS: AtomicUsize = AtomicUsize::new(0);

struct ConnectionGuard(&'static AtomicUsize);

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Release);
    }
}

fn acquire_connection(counter: &'static AtomicUsize) -> Option<ConnectionGuard> {
    let previous = counter.fetch_add(1, Ordering::Acquire);
    if previous >= MAX_CONNECTIONS {
        counter.fetch_sub(1, Ordering::Release);
        None
    } else {
        Some(ConnectionGuard(counter))
    }
}

pub fn start_cursor_socket_server(
    claude_state: Arc<Mutex<HashMap<String, ClaudeSession>>>,
    app: tauri::AppHandle,
) {
    let listener = match std::net::TcpListener::bind("127.0.0.1:19284") {
        Ok(l) => l,
        Err(e) => {
            log::warn!("[cursor_socket] TCP bind failed: {}", e);
            return;
        }
    };
    log::info!("[cursor_socket] listening on 127.0.0.1:19284");

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let Some(guard) = acquire_connection(&CURSOR_CONNECTIONS) else {
                log::warn!("[cursor_socket] connection limit reached");
                continue;
            };
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
            let state = Arc::clone(&claude_state);
            let app = app.clone();
            std::thread::spawn(move || {
                use std::io::Read;
                let _guard = guard;
                let stream = stream;
                let mut buf = String::new();
                let _ = stream
                    .take((MAX_PAYLOAD_BYTES + 1) as u64)
                    .read_to_string(&mut buf);
                if buf.len() > MAX_PAYLOAD_BYTES {
                    log::warn!("[cursor_socket] payload too large, dropped");
                    return;
                }
                if !buf.is_empty() {
                    process_claude_event(&buf, &state, &app, Some("cursor"));
                }
            });
        }
    });
}

pub fn start_claude_socket_server(
    claude_state: Arc<Mutex<HashMap<String, ClaudeSession>>>,
    pending_permissions: PendingPermissions,
    app_handle: tauri::AppHandle,
) {
    std::thread::spawn(move || {
        use std::net::TcpListener;
        let listener = match TcpListener::bind("127.0.0.1:19283") {
            Ok(l) => l,
            Err(e) => {
                log::error!("Failed to bind claude TCP socket: {}", e);
                return;
            }
        };
        log::info!("Claude TCP server listening on 127.0.0.1:19283");

        for stream in listener.incoming() {
            let Ok(mut stream) = stream else {
                continue;
            };
            let Some(guard) = acquire_connection(&CLAUDE_CONNECTIONS) else {
                log::warn!("[claude_tcp] connection limit reached");
                continue;
            };
            let state = Arc::clone(&claude_state);
            let app = app_handle.clone();
            let pending = Arc::clone(&pending_permissions);
            std::thread::spawn(move || {
                use std::io::{Read, Write};
                let _guard = guard;
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .ok();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            if buf.len() + n > MAX_PAYLOAD_BYTES {
                                log::warn!("[claude_tcp] payload too large, dropped");
                                return;
                            }
                            buf.extend_from_slice(&chunk[..n]);
                        }
                        Err(e) => {
                            if !buf.is_empty() {
                                break;
                            }
                            log::warn!("[claude_tcp] read error with empty buf: {}", e);
                            return;
                        }
                    }
                }
                let text = String::from_utf8_lossy(&buf);
                if text.contains("\"cursor_version\"")
                    || text.contains("\"source\":\"cursor\"")
                    || text.contains("\"source\": \"cursor\"")
                {
                    log::info!(
                        "[claude_tcp] dropping cursor-originated event on cc socket (len={})",
                        text.len()
                    );
                    return;
                }

                let Some((session_id, hook_event)) =
                    process_claude_event(&text, &state, &app, None)
                else {
                    return;
                };
                if hook_event != "PermissionRequest" {
                    return;
                }

                let (tx, rx) = std::sync::mpsc::channel::<String>();
                pending.lock().unwrap().insert(session_id.clone(), tx);
                stream.set_read_timeout(None).ok();
                match rx.recv_timeout(std::time::Duration::from_secs(600)) {
                    Ok(response_json) => {
                        let bytes = response_json.as_bytes();
                        if stream.write_all(bytes).is_err() || stream.flush().is_err() {
                            log::warn!(
                                "[claude_tcp] permission response write failed session={} bytes={}",
                                &session_id[..session_id.len().min(8)],
                                bytes.len(),
                            );
                        }
                    }
                    Err(_) => {
                        log::warn!(
                            "[claude_tcp] permission timeout for session={}",
                            &session_id[..session_id.len().min(8)]
                        );
                    }
                }
                pending.lock().unwrap().remove(&session_id);
            });
        }
    });
}
