// Observe Cursor's current local workspace state without shutdown hooks.
// Unknown/unreadable state never means a session has closed.
use std::collections::{HashMap, HashSet};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use tauri::Emitter;

use crate::agent_files::stop_session_file_watcher;
use crate::agent_monitor::ClaudeSession;

const POLL_INTERVAL: Duration = Duration::from_millis(500);

enum WorkspaceState {
    Open(HashSet<String>),
    Closed,
    Unknown,
}

#[derive(Default)]
struct SessionBinding {
    database: PathBuf,
    missing_samples: u8,
}

#[derive(Default)]
struct LifecycleTracker {
    bindings: HashMap<String, SessionBinding>,
}

impl LifecycleTracker {
    fn update(
        &mut self,
        sessions: &[(String, u64)],
        workspaces: &HashMap<PathBuf, WorkspaceState>,
    ) -> Vec<(String, u64)> {
        self.bindings
            .retain(|id, _| sessions.iter().any(|(session, _)| session == id));
        let mut closed = Vec::new();
        for (id, updated_at) in sessions {
            {
                // Establish positive evidence first. A session not yet written
                // to disk, or a stale database from another workspace, is ignored.
                if let Some((database, _)) = workspaces.iter().find(
                    |(_, state)| matches!(state, WorkspaceState::Open(ids) if ids.contains(id)),
                ) {
                    let binding = self.bindings.entry(id.clone()).or_default();
                    binding.database = database.clone();
                    binding.missing_samples = 0;
                }
            }
            let Some(binding) = self.bindings.get_mut(id) else {
                continue;
            };
            let missing = match workspaces.get(&binding.database) {
                Some(WorkspaceState::Open(ids)) => !ids.contains(id),
                Some(WorkspaceState::Closed) => true,
                Some(WorkspaceState::Unknown) | None => {
                    binding.missing_samples = 0;
                    continue;
                }
            };
            binding.missing_samples = if missing {
                binding.missing_samples.saturating_add(1)
            } else {
                0
            };
            // Two consecutive observations avoid transient file release/reopen.
            if binding.missing_samples >= 2 {
                closed.push((id.clone(), *updated_at));
            }
        }
        closed
    }
}

fn database_in_use(path: &Path) -> Option<bool> {
    use windows::Wdk::Storage::FileSystem::{
        FileProcessIdsUsingFileInformation, NtQueryInformationFile,
    };
    use windows::Win32::{Foundation::HANDLE, System::IO::IO_STATUS_BLOCK};
    // Metadata-only handle with full sharing: never acquire an exclusive file
    // handle or interfere with Cursor opening/writing its database.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .access_mode(0x80)
        .share_mode(7)
        .open(path)
        .ok()?;
    #[repr(C)]
    struct ProcessIds {
        count: u32,
        ids: [usize; 64],
    }
    let mut info = ProcessIds {
        count: 0,
        ids: [0; 64],
    };
    let mut status = IO_STATUS_BLOCK::default();
    // SAFETY: the handle remains alive, both output buffers have the correct
    // alignment/layout, and the kernel receives their exact allocated size.
    let result = unsafe {
        NtQueryInformationFile(
            HANDLE(file.as_raw_handle()),
            &mut status,
            &mut info as *mut ProcessIds as *mut _,
            std::mem::size_of::<ProcessIds>() as u32,
            FileProcessIdsUsingFileInformation,
        )
    };
    if result.is_err() || info.count as usize > info.ids.len() {
        return None;
    }
    let own_pid = std::process::id() as usize;
    Some(
        info.ids[..info.count as usize]
            .iter()
            .any(|pid| *pid != own_pid),
    )
}

fn read_selected_sessions(path: &Path) -> Option<HashSet<String>> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    connection.busy_timeout(Duration::ZERO).ok()?;
    let json: String = connection
        .query_row(
            "SELECT value FROM ItemTable WHERE key = 'composer.composerData'",
            [],
            |row| row.get(0),
        )
        .ok()?;
    let value: serde_json::Value = serde_json::from_str(&json).ok()?;
    value
        .get("selectedComposerIds")?
        .as_array()?
        .iter()
        .map(|id| id.as_str().map(String::from))
        .collect()
}

fn inspect_workspace(path: &Path) -> WorkspaceState {
    match database_in_use(path) {
        Some(false) => WorkspaceState::Closed,
        Some(true) => read_selected_sessions(path)
            .map(WorkspaceState::Open)
            .unwrap_or(WorkspaceState::Unknown),
        None => WorkspaceState::Unknown,
    }
}

fn host_is_alive(pid: u32, expected_creation_ms: u64) -> Option<bool> {
    use windows::Win32::Foundation::{
        CloseHandle, ERROR_INVALID_PARAMETER, FILETIME, STILL_ACTIVE,
    };
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: the handle is checked and closed on every path; all out-parameters
    // are valid allocated values. Creation time prevents PID reuse mistakes.
    unsafe {
        let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => handle,
            Err(error) if error.code() == ERROR_INVALID_PARAMETER.to_hresult() => {
                return Some(false)
            }
            Err(_) => return None,
        };
        let result = (|| {
            let mut exit_code = 0;
            GetExitCodeProcess(handle, &mut exit_code).ok()?;
            if exit_code != STILL_ACTIVE.0 as u32 {
                return Some(false);
            }
            let (mut created, mut exited, mut kernel, mut user) = (
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
            );
            GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user).ok()?;
            let created_ms =
                (((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64) / 10000;
            Some(created_ms == expected_creation_ms)
        })();
        let _ = CloseHandle(handle);
        result
    }
}

fn discover_workspaces(root: &Path) -> HashMap<PathBuf, WorkspaceState> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return HashMap::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let database = entry.path().join("state.vscdb");
            // Closed historical workspaces are not candidates for new bindings.
            if database_in_use(&database) != Some(true) {
                return None;
            }
            let ids = read_selected_sessions(&database)?;
            Some((database, WorkspaceState::Open(ids)))
        })
        .collect()
}

pub fn start_cursor_lifecycle_monitor(
    sessions: Arc<Mutex<HashMap<String, ClaudeSession>>>,
    app: tauri::AppHandle,
) {
    let Some(root) = dirs::config_dir().map(|dir| dir.join("Cursor/User/workspaceStorage")) else {
        return;
    };
    std::thread::spawn(move || {
        let mut tracker = LifecycleTracker::default();
        let mut tick = 0u64;
        loop {
            std::thread::sleep(POLL_INTERVAL);
            let observed: Vec<_> = match sessions.lock() {
                Ok(sessions) => sessions
                    .values()
                    .filter(|s| s.source == "cursor")
                    .map(|s| (s.session_id.clone(), s.updated_at, s.cursor_host))
                    .collect(),
                Err(_) => continue,
            };
            let snapshot: Vec<_> = observed
                .iter()
                .map(|(id, updated, _)| (id.clone(), *updated))
                .collect();
            tick = tick.wrapping_add(1);
            let needs_binding = snapshot
                .iter()
                .any(|(id, _)| !tracker.bindings.contains_key(id));
            let suspect_closure = tracker
                .bindings
                .values()
                .any(|binding| binding.missing_samples > 0);
            let mut workspaces = if (needs_binding && tick % 2 == 0) || suspect_closure {
                discover_workspaces(&root)
            } else {
                HashMap::new()
            };
            for binding in tracker.bindings.values() {
                workspaces
                    .entry(binding.database.clone())
                    .or_insert_with(|| inspect_workspace(&binding.database));
            }
            let mut closed = tracker.update(&snapshot, &workspaces);
            for (id, updated, host) in &observed {
                if host.is_some_and(|(pid, created)| host_is_alive(pid, created) == Some(false)) {
                    closed.push((id.clone(), *updated));
                }
            }
            for (id, observed_update) in closed {
                let removed = if let Ok(mut sessions) = sessions.lock() {
                    // A new hook may have resumed the session since the probe.
                    let unchanged = sessions.get(&id).is_some_and(|session| {
                        session.source == "cursor" && session.updated_at == observed_update
                    });
                    if unchanged {
                        sessions.remove(&id);
                    }
                    unchanged
                } else {
                    false
                };
                tracker.bindings.remove(&id);
                if removed {
                    stop_session_file_watcher(&id);
                    let _ = app.emit("claude-session-update", &id);
                    log::info!("[cursor_lifecycle] closed session {}", id);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn states(state: WorkspaceState) -> HashMap<PathBuf, WorkspaceState> {
        HashMap::from([(PathBuf::from("workspace/state.vscdb"), state)])
    }
    fn open(ids: &[&str]) -> WorkspaceState {
        WorkspaceState::Open(ids.iter().map(|id| id.to_string()).collect())
    }

    #[test]
    fn closes_only_after_observing_open_then_two_missing_samples() {
        let mut tracker = LifecycleTracker::default();
        let sessions = vec![("session".to_string(), 10)];
        assert!(tracker
            .update(&sessions, &states(WorkspaceState::Closed))
            .is_empty());
        assert!(tracker
            .update(&sessions, &states(open(&["session"])))
            .is_empty());
        assert!(tracker.update(&sessions, &states(open(&[]))).is_empty());
        assert_eq!(tracker.update(&sessions, &states(open(&[]))), sessions);
    }

    #[test]
    fn workspace_release_closes_its_sessions_but_not_unknown_ones() {
        let mut tracker = LifecycleTracker::default();
        let sessions = vec![("known".to_string(), 10), ("unknown".to_string(), 11)];
        tracker.update(&sessions, &states(open(&["known"])));
        tracker.update(&sessions, &states(WorkspaceState::Closed));
        assert_eq!(
            tracker.update(&sessions, &states(WorkspaceState::Closed)),
            vec![("known".to_string(), 10)]
        );
    }

    #[test]
    fn unreadable_or_reopened_state_resets_closure_confirmation() {
        let mut tracker = LifecycleTracker::default();
        let sessions = vec![("session".to_string(), 10)];
        tracker.update(&sessions, &states(open(&["session"])));
        tracker.update(&sessions, &states(WorkspaceState::Closed));
        assert!(tracker
            .update(&sessions, &states(WorkspaceState::Unknown))
            .is_empty());
        assert!(tracker
            .update(&sessions, &states(WorkspaceState::Closed))
            .is_empty());
        assert!(tracker
            .update(&sessions, &states(open(&["session"])))
            .is_empty());
        assert!(tracker.update(&sessions, &states(open(&[]))).is_empty());
    }

    #[test]
    fn session_still_open_in_another_workspace_is_not_closed() {
        let mut tracker = LifecycleTracker::default();
        let sessions = vec![("session".to_string(), 10)];
        tracker.update(&sessions, &states(open(&["session"])));
        tracker.update(&sessions, &states(WorkspaceState::Closed));
        let mut next = states(WorkspaceState::Closed);
        next.insert(PathBuf::from("other/state.vscdb"), open(&["session"]));
        assert!(tracker.update(&sessions, &next).is_empty());
        assert_eq!(
            tracker.bindings["session"].database,
            PathBuf::from("other/state.vscdb")
        );
    }

    #[test]
    fn readonly_probe_observes_sqlite_updates_and_file_release() {
        let path = std::env::temp_dir().join(format!(
            "stackling-cursor-lifecycle-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT); INSERT INTO ItemTable VALUES ('composer.composerData', '{\"selectedComposerIds\":[\"session\"]}');").unwrap();
        // A handle in our own process must not look like a live Cursor window.
        assert_eq!(database_in_use(&path), Some(false));
        assert_eq!(
            read_selected_sessions(&path).unwrap(),
            HashSet::from(["session".to_string()])
        );
        db.execute(
            "UPDATE ItemTable SET value = '{\"selectedComposerIds\":[]}'",
            [],
        )
        .unwrap();
        assert!(read_selected_sessions(&path).unwrap().is_empty());
        db.execute("UPDATE ItemTable SET value = '{\"changedSchema\":[]}'", [])
            .unwrap();
        assert!(read_selected_sessions(&path).is_none());
        drop(db);
        assert_eq!(database_in_use(&path), Some(false));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn process_probe_detects_external_owner_without_blocking_other_opens() {
        use std::io::{BufRead, BufReader};
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        let path = std::env::temp_dir().join(format!(
            "stackling-cursor-owner-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, "test").unwrap();
        let script = format!("$f=[System.IO.File]::Open('{}',[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite); $created=[long][Math]::Floor([System.Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToFileTimeUtc()/10000); [Console]::Out.WriteLine('ready,'+$created); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null; $f.Close()", path.to_string_lossy().replace('\'', "''"));
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        let observed = database_in_use(&path);
        let created = ready
            .trim()
            .strip_prefix("ready,")
            .and_then(|value| value.parse::<u64>().ok());
        let host_alive = created.and_then(|created| host_is_alive(child.id(), created));
        let wrong_creation = created.and_then(|created| host_is_alive(child.id(), created + 1));
        let another_open = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .is_ok();
        drop(child.stdin.take());
        let exit = child.wait().unwrap();
        assert!(created.is_some());
        assert_eq!(host_alive, Some(true));
        assert_eq!(wrong_creation, Some(false));
        assert!(exit.success());
        assert_eq!(host_is_alive(child.id(), created.unwrap()), Some(false));
        assert_eq!(observed, Some(true));
        assert!(another_open);
        assert_eq!(database_in_use(&path), Some(false));
        std::fs::remove_file(path).unwrap();
    }
}
