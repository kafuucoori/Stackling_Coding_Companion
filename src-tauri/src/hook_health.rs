use serde::Serialize;
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookHealth {
    source: String,
    installed: bool,
    config_valid: bool,
    registered: bool,
    listener_ready: bool,
    healthy: bool,
    message: String,
}

fn listener_ready(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

fn inspect(source: &str, script: &Path, config: &Path, marker: &str, port: u16) -> HookHealth {
    let installed = script.is_file();
    let config_text = std::fs::read_to_string(config);
    let config_valid = !config.exists()
        || config_text
            .as_ref()
            .ok()
            .and_then(|content| serde_json::from_str::<serde_json::Value>(content).ok())
            .is_some();
    let registered = config_text
        .as_ref()
        .is_ok_and(|content| content.contains(marker));
    let listener_ready = listener_ready(port);
    let healthy = installed && config_valid && registered && listener_ready;
    let message = if healthy {
        "运行正常".to_string()
    } else if !config_valid && config.exists() {
        "配置文件格式损坏，已停止自动修改".to_string()
    } else if !installed || !registered {
        "Hook 未完整安装".to_string()
    } else {
        "Stackling 监听端口未就绪".to_string()
    };
    HookHealth {
        source: source.to_string(),
        installed,
        config_valid,
        registered,
        listener_ready,
        healthy,
        message,
    }
}

#[tauri::command]
pub fn get_hook_health() -> Result<Vec<HookHealth>, String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    Ok(vec![
        inspect(
            "cc",
            &home.join(".claude/hooks/stackling-claude-hook.ps1"),
            &home.join(".claude/settings.json"),
            "stackling-claude-hook",
            19283,
        ),
        inspect(
            "codex",
            &home.join(".codex/hooks/stackling-codex-hook.ps1"),
            &home.join(".codex/hooks.json"),
            "stackling-codex-hook",
            19283,
        ),
        inspect(
            "cursor",
            &home.join(".cursor/hooks/stackling-cursor-hook.ps1"),
            &home.join(".cursor/hooks.json"),
            "stackling-cursor-hook",
            19284,
        ),
    ])
}

#[tauri::command]
pub async fn repair_hooks(source: String) -> Result<(), String> {
    match source.as_str() {
        "cc" => crate::claude_hooks::install_claude_hooks().await,
        "codex" => crate::codex_hooks::install_codex_hooks().await,
        "cursor" => crate::cursor_hooks::install_cursor_hooks().await,
        "all" => {
            crate::claude_hooks::install_claude_hooks().await?;
            crate::codex_hooks::install_codex_hooks().await?;
            crate::cursor_hooks::install_cursor_hooks().await
        }
        _ => Err(format!("unknown hook source: {source}")),
    }
}
