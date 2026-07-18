// lib.rs —— Stackling 主入口（Windows）
//
// 六窗口：看板娘、信息面板、设置、完成提示、聊天输入和聊天历史。
// 接入拆分后的 agent 监控管线（CC/Codex/Cursor）。
// 窗口的定位/显隐/拖动主要在前端用 Tauri JS API 完成；Rust 这里只做：
//   - 注册 agent 状态、hook 安装、socket 服务器、命令
//   - 系统托盘（显示看板娘 / 设置 / 退出）
//   - 启动时定位并显示看板娘

mod agent_files;
mod agent_focus;
mod agent_monitor;
mod agent_sessions;
mod agent_sockets;
mod agent_stats;
mod claude_hooks;
mod codex_hooks;
mod credentials;
mod cursor_hooks;
mod hook_health;
mod hook_utils;
mod model_chat;
mod uninstall_cleanup;
mod updates;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

use agent_monitor::{install_claude_hooks, install_cursor_hooks, ClaudeState};
use agent_sockets::{start_claude_socket_server, start_cursor_socket_server};

/// 显示并聚焦某个窗口（托盘 / 命令用）。
fn show_window(app: &tauri::AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn center_window_on_primary(app: &tauri::AppHandle, win: &tauri::WebviewWindow) {
    let Ok(Some(mon)) = app.primary_monitor() else {
        return;
    };
    let Ok(size) = win.outer_size() else {
        return;
    };
    let ms = mon.size();
    let mp = mon.position();
    let x = mp.x + ((ms.width as i32 - size.width as i32) / 2);
    let y = mp.y + ((ms.height as i32 - size.height as i32) / 2);
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
}

fn show_settings_window(app: &tauri::AppHandle) {
    static CENTERED_ONCE: OnceLock<Mutex<bool>> = OnceLock::new();
    if let Some(win) = app.get_webview_window("settings") {
        let should_center = {
            let lock = CENTERED_ONCE.get_or_init(|| Mutex::new(false));
            match lock.lock() {
                Ok(mut centered) if !*centered => {
                    *centered = true;
                    true
                }
                _ => false,
            }
        };
        if should_center {
            center_window_on_primary(app, &win);
        }
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 显示看板娘：除了 show/focus，还把它移回当前显示器中央并置顶，
fn show_mascot(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("mascot") {
        let _ = win.unminimize();
        let _ = win.show();
        // 居中到窗口当前所在显示器（取不到则退回主显示器）。
        if let Ok(Some(mon)) = win.current_monitor() {
            if let Ok(size) = win.outer_size() {
                let ms = mon.size();
                let mp = mon.position();
                let x = mp.x + ((ms.width as i32 - size.width as i32) / 2);
                let y = mp.y + ((ms.height as i32 - size.height as i32) / 2);
                let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
            }
        }
        let _ = win.set_always_on_top(true);
        let _ = win.set_focus();
    }
}

/// 打开设置窗口（前端右键菜单 / 托盘调用）。
#[tauri::command]
fn open_settings_window(app: tauri::AppHandle) {
    show_settings_window(&app);
}

/// 退出应用。
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

pub fn run() {
    if std::env::args().any(|argument| argument == "--uninstall-cleanup") {
        let result = dirs::home_dir()
            .ok_or_else(|| "no home dir".to_string())
            .and_then(|home| uninstall_cleanup::cleanup_integrations(&home));
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }

    #[cfg(target_os = "windows")]
    {
        let key = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
        let flag = "--disable-accelerated-video-decode";
        let merged = match std::env::var(key) {
            Ok(existing) if !existing.contains(flag) && !existing.trim().is_empty() => {
                format!("{} {}", existing, flag)
            }
            Ok(existing) if existing.contains(flag) => existing,
            _ => flag.to_string(),
        };
        std::env::set_var(key, merged);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(ClaudeState {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            pending_permissions: Arc::new(Mutex::new(HashMap::new())),
        })
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let _ = app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                );
            }

            // 幂等安装 CC + Codex hook
            if let Err(e) = tauri::async_runtime::block_on(install_claude_hooks()) {
                log::warn!("install_claude_hooks: {e}");
            }
            // 幂等安装 Cursor hook
            if let Err(e) = tauri::async_runtime::block_on(install_cursor_hooks()) {
                log::warn!("install_cursor_hooks: {e}");
            }

            // 起两个 socket 服务器（CC/Codex 共用一个，Cursor 单独）
            {
                let st = app.state::<ClaudeState>();
                start_claude_socket_server(
                    Arc::clone(&st.sessions),
                    Arc::clone(&st.pending_permissions),
                    app.handle().clone(),
                );
                start_cursor_socket_server(Arc::clone(&st.sessions), app.handle().clone());
            }

            // 系统托盘：显示看板娘 / 设置 / 退出
            let show_item =
                MenuItem::with_id(app, "show_mascot", "显示看板娘", true, None::<&str>)?;
            let settings_item =
                MenuItem::with_id(app, "open_settings", "设置", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &settings_item, &quit_item])?;

            let tray_icon_bytes = include_bytes!("../icons/tray-icon.png");
            let tray_icon =
                tauri::image::Image::from_bytes(tray_icon_bytes).expect("failed to load tray icon");

            TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show_mascot" => show_mascot(app),
                    "open_settings" => show_settings_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // 看板娘窗口启动即显示（位置由前端读持久化后用 JS API 复位）。
            show_window(app.handle(), "mascot");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // —— 本模块窗口命令 ——
            open_settings_window,
            quit_app,
            // —— agent 监控命令 ——
            agent_sessions::get_claude_sessions,
            agent_sessions::remove_claude_session,
            agent_sessions::resolve_claude_permission,
            agent_stats::get_claude_stats,
            agent_files::get_claude_conversation,
            model_chat::send_model_chat_message,
            model_chat::stream_model_chat_message,
            model_chat::cancel_model_chat_stream,
            credentials::get_model_chat_api_key,
            credentials::set_model_chat_api_key,
            hook_health::get_hook_health,
            hook_health::repair_hooks,
            updates::check_for_updates,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
