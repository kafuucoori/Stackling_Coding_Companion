pub(crate) fn get_active_ghostty_terminal_id() -> Option<String> {
    None
}

pub(crate) fn get_frontmost_app_name() -> String {
    String::new()
}

pub(crate) fn is_cursor_frontmost_app(name: &str) -> bool {
    name == "Cursor" || name == "stackling"
}

pub(crate) fn is_codex_frontmost_app(name: &str) -> bool {
    if matches!(name, "stackling" | "Code" | "Visual Studio Code") {
        return true;
    }
    let lowered = name.to_ascii_lowercase();
    lowered == "codex" || lowered.contains("codex")
}

pub(crate) fn is_codex_host_terminal(name: &str) -> bool {
    name == "Code" || name == "Visual Studio Code" || name.eq_ignore_ascii_case("codex")
}

pub(crate) fn frontmost_matches_host_terminal(frontmost: &str, host_terminal: &str) -> bool {
    if frontmost == "stackling" {
        return true;
    }
    if frontmost.eq_ignore_ascii_case(host_terminal) {
        return true;
    }
    if host_terminal == "Apple_Terminal" && frontmost == "Terminal" {
        return true;
    }
    if host_terminal == "Claude Desktop" && frontmost.eq_ignore_ascii_case("Claude") {
        return true;
    }
    false
}

#[cfg(target_os = "windows")]
pub(crate) fn try_recover_cursor_mojibake(buf: &str) -> Option<String> {
    use encoding_rs::{GBK, UTF_8};

    if buf.is_ascii() {
        return None;
    }
    let (gbk_bytes, _, encode_errors) = GBK.encode(buf);
    if encode_errors {
        return None;
    }
    let (decoded, _, decode_errors) = UTF_8.decode(&gbk_bytes);
    if decode_errors {
        return None;
    }
    Some(decoded.into_owned())
}

pub(crate) fn normalize_cursor_path(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }

    let bytes = raw.as_bytes();
    let stripped = if bytes.len() >= 4
        && bytes[0] == b'/'
        && (bytes[1] as char).is_ascii_alphabetic()
        && bytes[2] == b':'
        && (bytes[3] == b'/' || bytes[3] == b'\\')
    {
        &raw[1..]
    } else {
        raw
    };
    stripped.replace('/', "\\")
}

#[cfg(target_os = "windows")]
fn get_process_exe_path(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::{CloseHandle, MAX_PATH};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; MAX_PATH as usize];
        let mut size: u32 = buf.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        if result.is_ok() {
            Some(String::from_utf16_lossy(&buf[..size as usize]))
        } else {
            None
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn find_host_app_for_pid_win(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()? };
    let mut entries: Vec<(u32, u32)> = Vec::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    unsafe {
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            entries.push((entry.th32ProcessID, entry.th32ParentProcessID));
            while Process32NextW(snapshot, &mut entry).is_ok() {
                entries.push((entry.th32ProcessID, entry.th32ParentProcessID));
            }
        }
        let _ = CloseHandle(snapshot);
    }

    let mut current = pid;
    for _ in 0..10 {
        let parent = entries
            .iter()
            .find(|(process_id, _)| *process_id == current)
            .map(|(_, parent_id)| *parent_id)?;
        if parent == 0 || parent == current {
            return None;
        }
        if let Some(exe_path) = get_process_exe_path(parent) {
            let exe_lower = exe_path.to_lowercase();
            if (exe_lower.ends_with("\\claude.exe") || exe_lower.ends_with("/claude.exe"))
                && exe_lower.contains("windowsapps")
            {
                return Some("Claude Desktop".to_string());
            }
            if exe_lower.ends_with("\\windowsterminal.exe") {
                return Some("Windows Terminal".to_string());
            }
            if exe_lower.ends_with("\\ghostty.exe") {
                return Some("Ghostty".to_string());
            }
        }
        current = parent;
    }
    None
}
