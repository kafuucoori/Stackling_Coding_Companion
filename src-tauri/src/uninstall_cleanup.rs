use crate::hook_utils::{read_json_config, write_json_if_changed};
use std::path::Path;

fn contains_marker(value: &serde_json::Value, marker: &str) -> bool {
    match value {
        serde_json::Value::String(value) => value.contains(marker),
        serde_json::Value::Array(values) => {
            values.iter().any(|value| contains_marker(value, marker))
        }
        serde_json::Value::Object(values) => {
            values.values().any(|value| contains_marker(value, marker))
        }
        _ => false,
    }
}

fn remove_hook_entries(path: &Path, marker: &str) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let mut config = read_json_config(path)?;
    let Some(hooks) = config
        .get_mut("hooks")
        .and_then(|value| value.as_object_mut())
    else {
        return Ok(());
    };
    let mut changed = false;

    for entries in hooks.values_mut() {
        let Some(entries) = entries.as_array_mut() else {
            continue;
        };
        entries.retain_mut(|entry| {
            if let Some(handlers) = entry
                .get_mut("hooks")
                .and_then(|value| value.as_array_mut())
            {
                let previous_len = handlers.len();
                handlers.retain(|handler| !contains_marker(handler, marker));
                changed |= handlers.len() != previous_len;
                !handlers.is_empty()
            } else {
                let keep = !contains_marker(entry, marker);
                changed |= !keep;
                keep
            }
        });
    }
    let previous_len = hooks.len();
    hooks.retain(|_, entries| !entries.as_array().is_some_and(|entries| entries.is_empty()));
    changed |= hooks.len() != previous_len;

    if changed {
        write_json_if_changed(path, &config)?;
    }
    Ok(())
}

fn remove_file_if_present(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to remove {}: {error}", path.display())),
    }
}

pub(crate) fn cleanup_integrations(home: &Path) -> Result<(), String> {
    let integrations = [
        (
            home.join(".claude"),
            "settings.json",
            "stackling-claude-hook",
        ),
        (home.join(".codex"), "hooks.json", "stackling-codex-hook"),
        (home.join(".cursor"), "hooks.json", "stackling-cursor-hook"),
    ];
    let mut errors = Vec::new();

    for (root, config_name, marker) in integrations {
        if let Err(error) = remove_hook_entries(&root.join(config_name), marker) {
            errors.push(error);
        }
        if let Err(error) =
            remove_file_if_present(&root.join("hooks").join(format!("{marker}.ps1")))
        {
            errors.push(error);
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::cleanup_integrations;

    #[test]
    fn removes_only_stackling_hooks_and_scripts() {
        let root = std::env::temp_dir().join(format!(
            "stackling-uninstall-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for integration in [".claude", ".codex", ".cursor"] {
            std::fs::create_dir_all(root.join(integration).join("hooks")).unwrap();
        }
        std::fs::write(
            root.join(".claude/settings.json"),
            r#"{"model":"sonnet","hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"command":"other-hook"},{"command":"stackling-claude-hook.ps1"}]}]}}"#,
        )
        .unwrap();
        std::fs::write(
            root.join(".codex/hooks.json"),
            r#"{"hooks":{"Stop":[{"hooks":[{"command":"stackling-codex-hook.ps1"}]},{"hooks":[{"command":"other-hook"}]}]}}"#,
        )
        .unwrap();
        std::fs::write(
            root.join(".cursor/hooks.json"),
            r#"{"version":1,"hooks":{"stop":[{"command":"stackling-cursor-hook.ps1"},{"command":"other-hook"}]}}"#,
        )
        .unwrap();
        for (integration, script) in [
            (".claude", "stackling-claude-hook.ps1"),
            (".codex", "stackling-codex-hook.ps1"),
            (".cursor", "stackling-cursor-hook.ps1"),
        ] {
            std::fs::write(root.join(integration).join("hooks").join(script), "").unwrap();
        }

        cleanup_integrations(&root).unwrap();

        for (integration, config) in [
            (".claude", "settings.json"),
            (".codex", "hooks.json"),
            (".cursor", "hooks.json"),
        ] {
            let content = std::fs::read_to_string(root.join(integration).join(config)).unwrap();
            assert!(content.contains("other-hook"));
            assert!(!content.contains("stackling-"));
        }
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &std::fs::read_to_string(root.join(".claude/settings.json")).unwrap()
            )
            .unwrap()["model"],
            "sonnet"
        );
        assert!(!root
            .join(".claude/hooks/stackling-claude-hook.ps1")
            .exists());
        assert!(!root.join(".codex/hooks/stackling-codex-hook.ps1").exists());
        assert!(!root
            .join(".cursor/hooks/stackling-cursor-hook.ps1")
            .exists());

        std::fs::remove_dir_all(root).unwrap();
    }
}
