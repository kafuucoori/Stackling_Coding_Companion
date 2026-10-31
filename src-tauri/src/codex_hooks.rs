use crate::hook_utils::{read_json_config, write_if_changed, write_json_if_changed};
use std::path::Path;

const HOOK_SCRIPT: &str = r#"$ErrorActionPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$response = '{}'
try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
    $trimmed = $raw.TrimStart([char]0xFEFF).TrimStart()
    if ($trimmed.StartsWith('{')) {
        # `source` belongs to Codex (startup/resume/fork); keep it intact.
        $raw = '{"stackling_source":"codex",' + $trimmed.Substring(1)
    }

    $isPermission = $raw -match '"hook_event_name"\s*:\s*"PermissionRequest"'
    $client = [System.Net.Sockets.TcpClient]::new()
    $connectResult = $client.BeginConnect('127.0.0.1', 19283, $null, $null)
    $waitHandle = $connectResult.AsyncWaitHandle
    if (-not $waitHandle.WaitOne(250)) { exit 0 }
    $client.EndConnect($connectResult)
    $client.SendTimeout = 500
    $client.ReceiveTimeout = 600000
    $stream = $client.GetStream()
    $stream.WriteTimeout = 500
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($raw)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
    $client.Client.Shutdown([System.Net.Sockets.SocketShutdown]::Send)
    if ($isPermission) {
        $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8)
        $received = $reader.ReadToEnd()
        if ($received) { $response = $received }
        $reader.Close()
    }
    $client.Close()
} catch {
} finally {
    if ($waitHandle) { $waitHandle.Close() }
    if ($client) { $client.Close() }
    # Always return valid, BOM-free UTF-8 JSON, including offline/error paths.
    $stdout = [Console]::OpenStandardOutput()
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($response)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}
"#;

fn commands_for(hook_path: &Path) -> (String, String) {
    let path = hook_path.to_string_lossy().to_string();
    let command_windows = format!(
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
        path.replace('"', "\\\"")
    );
    let command = format!(
        "pwsh -NoProfile -File \"{}\"",
        path.replace('\\', "/").replace('"', "\\\"")
    );
    (command, command_windows)
}

fn contains_our_hook(entry: &serde_json::Value) -> bool {
    let is_ours = |cmd: &str| cmd.contains("stackling-codex-hook");
    entry
        .get("command")
        .and_then(|c| c.as_str())
        .is_some_and(is_ours)
        || entry
            .get("commandWindows")
            .and_then(|c| c.as_str())
            .is_some_and(is_ours)
        || entry
            .get("command_windows")
            .and_then(|c| c.as_str())
            .is_some_and(is_ours)
        || entry
            .get("hooks")
            .and_then(|hs| hs.as_array())
            .is_some_and(|hs| {
                hs.iter().any(|inner| {
                    inner
                        .get("command")
                        .and_then(|c| c.as_str())
                        .is_some_and(is_ours)
                        || inner
                            .get("commandWindows")
                            .and_then(|c| c.as_str())
                            .is_some_and(is_ours)
                        || inner
                            .get("command_windows")
                            .and_then(|c| c.as_str())
                            .is_some_and(is_ours)
                })
            })
}

fn register_codex_hooks(codex_dir: &Path, hook_path: &Path) -> Result<(), String> {
    let hooks_json_path = codex_dir.join("hooks.json");
    let mut config = read_json_config(&hooks_json_path)?;

    let (command, command_windows) = commands_for(hook_path);
    let hooks = config
        .as_object_mut()
        .ok_or("codex hooks config not object")?
        .entry("hooks")
        .or_insert(serde_json::json!({}))
        .as_object_mut()
        .ok_or("codex hooks not object")?;

    let handler = serde_json::json!({
        "type": "command",
        "command": command.clone(),
        "commandWindows": command_windows.clone(),
        "timeout": 10,
    });
    let permission_handler = serde_json::json!({
        "type": "command",
        "command": command,
        "commandWindows": command_windows,
        "timeout": 600,
    });
    // Codex caps Interrupt and SessionEnd command hooks at three seconds.
    let terminal_handler = serde_json::json!({
        "type": "command",
        "command": handler["command"],
        "commandWindows": handler["commandWindows"],
        "timeout": 3,
    });
    let without_matcher = || vec![serde_json::json!({ "hooks": [handler.clone()] })];
    let with_matcher =
        |matcher: &str| vec![serde_json::json!({ "matcher": matcher, "hooks": [handler.clone()] })];

    let hook_configs: Vec<(&str, Vec<serde_json::Value>)> = vec![
        ("SessionStart", without_matcher()),
        (
            "SessionEnd",
            vec![serde_json::json!({ "hooks": [terminal_handler.clone()] })],
        ),
        (
            "Interrupt",
            vec![serde_json::json!({ "hooks": [terminal_handler] })],
        ),
        ("UserPromptSubmit", without_matcher()),
        ("PreToolUse", with_matcher("*")),
        (
            "PermissionRequest",
            vec![serde_json::json!({ "matcher": "*", "hooks": [permission_handler] })],
        ),
        ("PostToolUse", with_matcher("*")),
        ("PreCompact", with_matcher("manual|auto")),
        ("PostCompact", with_matcher("manual|auto")),
        ("SubagentStart", with_matcher("*")),
        ("SubagentStop", with_matcher("*")),
        ("Stop", without_matcher()),
    ];

    // Replace existing Stackling entries while preserving hooks installed by
    // the user, plugins, or other tools.
    for entries in hooks.values_mut() {
        if let Some(entries) = entries.as_array_mut() {
            entries.retain(|entry| !contains_our_hook(entry));
        }
    }
    hooks.retain(|_, entries| !entries.as_array().is_some_and(|entries| entries.is_empty()));

    for (event, configs) in hook_configs {
        let arr = hooks
            .entry(event)
            .or_insert(serde_json::json!([]))
            .as_array_mut()
            .ok_or("codex hook event not array")?;
        arr.extend(configs);
    }

    write_json_if_changed(&hooks_json_path, &config)?;

    Ok(())
}

pub async fn install_codex_hooks() -> Result<(), String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let codex_dir = home.join(".codex");
    let hooks_dir = codex_dir.join("hooks");
    std::fs::create_dir_all(&hooks_dir).map_err(|e| e.to_string())?;

    let hook_path = hooks_dir.join("stackling-codex-hook.ps1");
    write_if_changed(&hook_path, HOOK_SCRIPT)?;
    register_codex_hooks(&codex_dir, &hook_path)?;

    log::info!(
        "[codex_hooks] installed official Codex hooks at {}",
        codex_dir.join("hooks.json").display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::register_codex_hooks;

    fn temp_root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "stackling-codex-hooks-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("hooks")).unwrap();
        root
    }

    #[test]
    fn registration_is_idempotent_without_touching_other_hooks() {
        let root = temp_root();
        let script = root.join("hooks").join("stackling-codex-hook.ps1");
        std::fs::write(&script, "").unwrap();
        std::fs::write(
            root.join("hooks.json"),
            r#"{
              "custom": true,
              "hooks": {
                "PreToolUse": [
                  {"matcher":"Bash","hooks":[{"type":"command","command":"other-hook"}]},
                  {"matcher":"*","hooks":[{"type":"command","commandWindows":"powershell -File stackling-codex-hook.ps1"}]}
                ]
              }
            }"#,
        )
        .unwrap();

        register_codex_hooks(&root, &script).unwrap();
        register_codex_hooks(&root, &script).unwrap();
        let config: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("hooks.json")).unwrap())
                .unwrap();
        let hooks = config["hooks"].as_object().unwrap();

        assert_eq!(config["custom"], true);
        assert_eq!(hooks["PreToolUse"].as_array().unwrap().len(), 2);
        assert!(hooks["PreToolUse"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["hooks"][0]["command"] == "other-hook"));
        assert_eq!(hooks["PostCompact"][0]["matcher"], "manual|auto");
        assert_eq!(hooks["Stop"][0]["hooks"][0]["timeout"], 10);
        assert_eq!(hooks["PermissionRequest"][0]["hooks"][0]["timeout"], 600);
        assert_eq!(hooks["Interrupt"][0]["hooks"][0]["timeout"], 3);
        assert_eq!(hooks["SessionEnd"][0]["hooks"][0]["timeout"], 3);
        assert!(hooks["SessionStart"][0].get("matcher").is_none());
        assert!(hooks["Stop"][0]["hooks"][0]["commandWindows"]
            .as_str()
            .unwrap()
            .contains("stackling-codex-hook.ps1"));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_to_overwrite_invalid_user_config() {
        let root = temp_root();
        let script = root.join("hooks").join("stackling-codex-hook.ps1");
        std::fs::write(root.join("hooks.json"), "{ invalid").unwrap();

        assert!(register_codex_hooks(&root, &script).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("hooks.json")).unwrap(),
            "{ invalid"
        );

        std::fs::remove_dir_all(root).unwrap();
    }
}
