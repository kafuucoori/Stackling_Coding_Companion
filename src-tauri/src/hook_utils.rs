use std::path::Path;

pub(crate) fn read_json_config(path: &Path) -> Result<serde_json::Value, String> {
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|error| format!("invalid {}: {error}", path.display()))
}

pub(crate) fn write_if_changed(path: &Path, content: &str) -> Result<bool, String> {
    if std::fs::read_to_string(path).ok().as_deref() == Some(content) {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension(format!(
        "{}.tmp-{}",
        path.extension().and_then(|e| e.to_str()).unwrap_or("file"),
        std::process::id()
    ));
    std::fs::write(&temp, content).map_err(|e| e.to_string())?;
    let backup = if path.exists() {
        let backup = path.with_extension(format!(
            "{}.bak",
            path.extension().and_then(|e| e.to_str()).unwrap_or("file")
        ));
        std::fs::copy(path, &backup).map_err(|e| e.to_string())?;
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
        Some(backup)
    } else {
        None
    };
    if let Err(error) = std::fs::rename(&temp, path) {
        if let Some(backup) = backup {
            let _ = std::fs::copy(backup, path);
        }
        let _ = std::fs::remove_file(temp);
        return Err(error.to_string());
    }
    Ok(true)
}

pub(crate) fn write_json_if_changed(
    path: &Path,
    value: &serde_json::Value,
) -> Result<bool, String> {
    let mut content = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    content.push('\n');
    write_if_changed(path, &content)
}
