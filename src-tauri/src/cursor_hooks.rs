use crate::hook_utils::{read_json_config, write_if_changed, write_json_if_changed};

const HOOK_SCRIPT: &str = r#"$ErrorActionPreference = 'SilentlyContinue'
function Write-EmptyJsonResponse {
    try {
        $stdout = [System.Console]::OpenStandardOutput()
        $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
        $jsonBytes = $utf8.GetBytes('{}')
        $stdout.Write($jsonBytes, 0, $jsonBytes.Length)
        $stdout.Flush()
    } catch {}
}
try {
    $stdin = [System.Console]::OpenStandardInput()
    $ms = New-Object System.IO.MemoryStream
    $buffer = New-Object byte[] 8192
    while (($n = $stdin.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $ms.Write($buffer, 0, $n)
    }
    $bytes = $ms.ToArray()
    if ($bytes.Length -eq 0) { Write-EmptyJsonResponse; exit 0 }

    $offset = 0
    $count = $bytes.Length
    if ($count -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        $offset = 3
        $count = $count - 3
    }

    # Cursor must receive valid JSON even when the Stackling listener is busy.
    # Respond before doing the optional event forwarding and flush without a BOM.
    Write-EmptyJsonResponse

    $client = $null
    $waitHandle = $null
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $connectResult = $client.BeginConnect('127.0.0.1', 19284, $null, $null)
        $waitHandle = $connectResult.AsyncWaitHandle
        if (-not $waitHandle.WaitOne(250)) {
            exit 0
        }
        $client.EndConnect($connectResult)
        $client.SendTimeout = 500
        $stream = $client.GetStream()
        $stream.WriteTimeout = 500
        $stream.Write($bytes, $offset, $count)
        $stream.Flush()
    } catch {
        # Event forwarding is best-effort and must never block a Cursor action.
    } finally {
        if ($waitHandle) { $waitHandle.Close() }
        if ($client) { $client.Close() }
    }
} catch {
    Write-EmptyJsonResponse
}
"#;

const MONITORED_EVENTS: &[&str] = &[
    "sessionStart",
    "sessionEnd",
    "beforeSubmitPrompt",
    "preToolUse",
    "postToolUse",
    "postToolUseFailure",
    "subagentStart",
    "subagentStop",
    "preCompact",
    "afterAgentResponse",
    "stop",
];

fn register_cursor_hooks(
    cursor_dir: &std::path::Path,
    hooks_dir: &std::path::Path,
) -> Result<(), String> {
    let hooks_json_path = cursor_dir.join("hooks.json");
    let mut config = read_json_config(&hooks_json_path)?;

    config["version"] = serde_json::json!(1);
    if config.get("hooks").is_none() {
        config["hooks"] = serde_json::json!({});
    }

    let hook_command = format!(
        "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{}\"",
        hooks_dir
            .join("stackling-cursor-hook.ps1")
            .to_string_lossy()
    );
    let is_ours = |command: &str| command.contains("stackling-cursor-hook");
    let hooks = config["hooks"]
        .as_object_mut()
        .ok_or("hooks is not an object")?;

    // Use Cursor's generic agent-loop hooks instead of registering both the
    // generic and tool-specific variants. This avoids duplicate events for
    // Shell/MCP/file operations while still covering every tool type.
    // Replace existing Stackling registrations without touching hooks installed
    // by the user or other tools.
    for entries in hooks.values_mut() {
        if let Some(arr) = entries.as_array_mut() {
            arr.retain(|entry| {
                !entry
                    .get("command")
                    .and_then(|c| c.as_str())
                    .map(is_ours)
                    .unwrap_or(false)
            });
        }
    }
    hooks.retain(|_, entries| !entries.as_array().is_some_and(|entries| entries.is_empty()));

    for event_name in MONITORED_EVENTS {
        let arr = hooks
            .entry(event_name.to_string())
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .ok_or("hook event is not an array")?;
        let entry = serde_json::json!({ "command": hook_command, "timeout": 10 });
        if let Some(idx) = arr.iter().position(|existing| {
            existing
                .get("command")
                .and_then(|c| c.as_str())
                .map(is_ours)
                .unwrap_or(false)
        }) {
            arr[idx] = entry;
        } else {
            arr.push(entry);
        }
    }

    write_json_if_changed(&hooks_json_path, &config)?;
    log::info!("[cursor_hooks] installed hooks to {:?}", hooks_json_path);
    Ok(())
}

pub async fn install_cursor_hooks() -> Result<(), String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let cursor_dir = home.join(".cursor");
    let hooks_dir = cursor_dir.join("hooks");
    std::fs::create_dir_all(&hooks_dir).map_err(|e| e.to_string())?;
    write_if_changed(&hooks_dir.join("stackling-cursor-hook.ps1"), HOOK_SCRIPT)?;
    register_cursor_hooks(&cursor_dir, &hooks_dir)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{register_cursor_hooks, HOOK_SCRIPT, MONITORED_EVENTS};

    fn temp_root(label: &str) -> std::path::PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("stackling-{label}-{}-{unique}", std::process::id()))
    }

    #[test]
    fn registration_is_idempotent_without_touching_other_hooks() {
        let root = temp_root("cursor-hooks");
        let hooks_dir = root.join("hooks");
        std::fs::create_dir_all(&hooks_dir).unwrap();
        std::fs::write(
            root.join("hooks.json"),
            r#"{
              "version": 1,
              "hooks": {
                "preToolUse": [
                  {"command": "other-tool.ps1"},
                  {"command": "stackling-cursor-hook.ps1"}
                ],
                "stop": [{"command": "stackling-cursor-hook.ps1"}]
              }
            }"#,
        )
        .unwrap();

        register_cursor_hooks(&root, &hooks_dir).unwrap();
        register_cursor_hooks(&root, &hooks_dir).unwrap();

        let config: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("hooks.json")).unwrap())
                .unwrap();
        let hooks = config["hooks"].as_object().unwrap();
        let pre_tool_use = hooks["preToolUse"].as_array().unwrap();
        assert_eq!(pre_tool_use.len(), 2);
        assert!(pre_tool_use
            .iter()
            .any(|entry| entry["command"] == "other-tool.ps1"));

        for event in MONITORED_EVENTS {
            let entries = hooks[*event].as_array().unwrap();
            let ours: Vec<_> = entries
                .iter()
                .filter(|entry| {
                    entry["command"]
                        .as_str()
                        .is_some_and(|command| command.contains("stackling-cursor-hook"))
                })
                .collect();
            assert_eq!(ours.len(), 1, "event {event}");
            assert_eq!(ours[0]["timeout"], 10);
            assert!(ours[0]["command"]
                .as_str()
                .unwrap()
                .contains("-NonInteractive"));
        }

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_to_overwrite_invalid_user_config() {
        let root = temp_root("cursor-invalid");
        let hooks_dir = root.join("hooks");
        std::fs::create_dir_all(&hooks_dir).unwrap();
        std::fs::write(root.join("hooks.json"), "{ invalid").unwrap();

        assert!(register_cursor_hooks(&root, &hooks_dir).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("hooks.json")).unwrap(),
            "{ invalid"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hook_writes_exact_utf8_json_without_powershell_formatting() {
        assert!(HOOK_SCRIPT.contains("OpenStandardOutput"));
        assert!(HOOK_SCRIPT.contains("UTF8Encoding -ArgumentList $false"));
        assert!(HOOK_SCRIPT.contains("WaitOne(250)"));
        assert!(HOOK_SCRIPT.contains("WriteTimeout = 500"));
        assert!(
            HOOK_SCRIPT.find("Write-EmptyJsonResponse").unwrap()
                < HOOK_SCRIPT.find("BeginConnect").unwrap()
        );
        assert!(!HOOK_SCRIPT.contains("Write-Output"));
    }
}
