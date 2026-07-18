use crate::hook_utils::{read_json_config, write_if_changed, write_json_if_changed};
use std::path::Path;

const HOOK_SCRIPT: &str = r#"$ErrorActionPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
function Write-JsonResponse([string]$json) {
    try {
        if ([string]::IsNullOrWhiteSpace($json)) { $json = '{}' }
        $stdout = [System.Console]::OpenStandardOutput()
        $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
        $jsonBytes = $utf8.GetBytes($json)
        $stdout.Write($jsonBytes, 0, $jsonBytes.Length)
        $stdout.Flush()
    } catch {}
}
try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { Write-JsonResponse '{}'; exit 0 }

    $ccPid = 0
    try {
        $current = $PID
        for ($i = 0; $i -lt 10; $i++) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$current"
            if (-not $proc) { break }
            $parentId = $proc.ParentProcessId
            if (-not $parentId -or $parentId -eq 0 -or $parentId -eq $current) { break }
            $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId"
            if (-not $parent) { break }
            $exe = ''
            if ($parent.ExecutablePath) { $exe = $parent.ExecutablePath.ToLower() }
            if ($ccPid -eq 0 -and $exe.EndsWith('\claude.exe')) { $ccPid = [int]$parent.ProcessId }
            $current = $parentId
        }
    } catch {}

    # Cursor imports Claude user hooks but currently ignores exec-form args.
    # When this hook is not running below claude.exe, acknowledge the event
    # without forwarding it as a duplicate Claude session event.
    if ($ccPid -eq 0) { Write-JsonResponse '{}'; exit 0 }

    if ($raw.StartsWith('{') -and $ccPid -ne 0) {
        $raw = '{"pid":' + $ccPid + ',' + $raw.Substring(1)
    }

    $isPermission = $raw -match '"hook_event_name"\s*:\s*"PermissionRequest"'
    if (-not $isPermission) { Write-JsonResponse '{}' }

    $client = [System.Net.Sockets.TcpClient]::new()
    $connectResult = $client.BeginConnect('127.0.0.1', 19283, $null, $null)
    $waitHandle = $connectResult.AsyncWaitHandle
    if (-not $waitHandle.WaitOne(500)) {
        if ($isPermission) { Write-JsonResponse '{}' }
        exit 0
    }
    $client.EndConnect($connectResult)
    $client.SendTimeout = 5000
    $client.ReceiveTimeout = 600000
    $stream = $client.GetStream()
    $stream.WriteTimeout = 5000
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($raw)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
    $client.Client.Shutdown([System.Net.Sockets.SocketShutdown]::Send)
    if ($isPermission) {
        $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8)
        $response = $reader.ReadToEnd()
        Write-JsonResponse $response
        $reader.Close()
    }
    $client.Close()
} catch {
    if ($isPermission) { Write-JsonResponse '{}' }
}
"#;

fn command_for(hook_path: &Path) -> String {
    format!(
        "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{}\"",
        hook_path.to_string_lossy()
    )
}

fn contains_our_hook(entry: &serde_json::Value) -> bool {
    let is_ours = |value: &str| value.contains("stackling-claude-hook");
    let handler_is_ours = |handler: &serde_json::Value| {
        handler
            .get("command")
            .and_then(|value| value.as_str())
            .is_some_and(is_ours)
            || handler
                .get("args")
                .and_then(|value| value.as_array())
                .is_some_and(|args| args.iter().any(|arg| arg.as_str().is_some_and(is_ours)))
    };
    handler_is_ours(entry)
        || entry
            .get("hooks")
            .and_then(|hooks| hooks.as_array())
            .is_some_and(|hooks| hooks.iter().any(handler_is_ours))
}

fn register_claude_hooks(claude_dir: &Path, hook_path: &Path) -> Result<(), String> {
    let settings_path = claude_dir.join("settings.json");
    let mut settings = read_json_config(&settings_path)?;

    let hook_script = command_for(hook_path);
    let hooks = settings
        .as_object_mut()
        .ok_or("settings not object")?
        .entry("hooks")
        .or_insert(serde_json::json!({}))
        .as_object_mut()
        .ok_or("hooks not object")?;

    // Claude supports both exec form and shell form. Use an explicit PowerShell
    // shell command because Cursor also imports Claude user hooks but currently
    // drops a separate `args` array while doing so.
    let handler = serde_json::json!({
        "type": "command",
        "command": hook_script,
        "shell": "powershell",
        "timeout": 10
    });
    let permission_handler = serde_json::json!({
        "type": "command",
        "command": command_for(hook_path),
        "shell": "powershell",
        "timeout": 600
    });
    let without_matcher = || vec![serde_json::json!({ "hooks": [handler.clone()] })];
    let with_matcher =
        |matcher: &str| vec![serde_json::json!({ "matcher": matcher, "hooks": [handler.clone()] })];

    let hook_configs: Vec<(&str, Vec<serde_json::Value>)> = vec![
        ("SessionStart", with_matcher("startup|resume|clear|compact")),
        ("UserPromptSubmit", without_matcher()),
        ("UserPromptExpansion", with_matcher("*")),
        ("PreToolUse", with_matcher("*")),
        (
            "PermissionRequest",
            vec![serde_json::json!({ "matcher": "*", "hooks": [permission_handler] })],
        ),
        ("PermissionDenied", with_matcher("*")),
        ("PostToolUse", with_matcher("*")),
        ("PostToolUseFailure", with_matcher("*")),
        ("PostToolBatch", without_matcher()),
        ("Notification", with_matcher("*")),
        ("SubagentStart", with_matcher("*")),
        ("SubagentStop", with_matcher("*")),
        ("TaskCreated", without_matcher()),
        ("TaskCompleted", without_matcher()),
        ("Stop", without_matcher()),
        ("StopFailure", with_matcher("*")),
        ("TeammateIdle", without_matcher()),
        ("CwdChanged", without_matcher()),
        ("PreCompact", with_matcher("manual|auto")),
        ("PostCompact", with_matcher("manual|auto")),
        ("Elicitation", with_matcher("*")),
        ("ElicitationResult", with_matcher("*")),
        (
            "SessionEnd",
            with_matcher("clear|resume|logout|prompt_input_exit|bypass_permissions_disabled|other"),
        ),
    ];

    // Replace existing Stackling entries so repeated starts remain idempotent.
    // Preserve hooks owned by the user or other tools.
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
            .ok_or("hook event is not array")?;
        arr.extend(configs);
    }

    write_json_if_changed(&settings_path, &settings)?;

    log::info!(
        "[claude_hooks] installed official Claude Code hooks at {}",
        settings_path.display()
    );
    Ok(())
}

pub async fn install_claude_hooks() -> Result<(), String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let claude_dir = home.join(".claude");
    let hooks_dir = claude_dir.join("hooks");
    std::fs::create_dir_all(&hooks_dir).map_err(|e| e.to_string())?;

    let hook_path = hooks_dir.join("stackling-claude-hook.ps1");
    write_if_changed(&hook_path, HOOK_SCRIPT)?;
    register_claude_hooks(&claude_dir, &hook_path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::register_claude_hooks;

    fn temp_root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "stackling-claude-hooks-{}-{}",
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
    fn registration_is_idempotent_and_uses_cursor_compatible_shell_form() {
        let root = temp_root();
        let script = root.join("hooks").join("stackling-claude-hook.ps1");
        std::fs::write(&script, "").unwrap();
        std::fs::write(
            root.join("settings.json"),
            r#"{
              "hooks": {
                "PreToolUse": [
                  {"matcher":"Bash","hooks":[{"type":"command","command":"other-hook"}]},
                  {"matcher":"*","hooks":[{"type":"command","command":"powershell -File stackling-claude-hook.ps1"}]}
                ]
              }
            }"#,
        )
        .unwrap();

        register_claude_hooks(&root, &script).unwrap();
        register_claude_hooks(&root, &script).unwrap();
        let settings: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("settings.json")).unwrap())
                .unwrap();
        let hooks = settings["hooks"].as_object().unwrap();

        assert_eq!(hooks["PreToolUse"].as_array().unwrap().len(), 2);
        assert!(hooks["PreToolUse"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| { entry["hooks"][0]["command"] == "other-hook" }));
        let ours = hooks["CwdChanged"][0]["hooks"][0].as_object().unwrap();
        assert!(ours["command"]
            .as_str()
            .unwrap()
            .contains(script.to_string_lossy().as_ref()));
        assert!(ours.get("args").is_none());
        assert_eq!(ours["shell"], "powershell");
        assert_eq!(hooks["PermissionRequest"][0]["hooks"][0]["timeout"], 600);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_to_overwrite_invalid_user_config() {
        let root = temp_root();
        let script = root.join("hooks").join("stackling-claude-hook.ps1");
        std::fs::write(root.join("settings.json"), "{ invalid").unwrap();

        assert!(register_claude_hooks(&root, &script).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("settings.json")).unwrap(),
            "{ invalid"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hook_returns_json_when_cursor_imports_claude_user_hooks() {
        assert!(super::HOOK_SCRIPT.contains("if ($ccPid -eq 0)"));
        assert!(super::HOOK_SCRIPT.contains("Write-JsonResponse '{}'"));
        assert!(super::HOOK_SCRIPT.contains("UTF8Encoding -ArgumentList $false"));
    }
}
