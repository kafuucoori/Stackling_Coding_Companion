use serde::{Deserialize, Serialize};

use crate::agent_files::{collect_claude_project_jsonl_files, collect_codex_session_jsonl_files};

type StatsCache = std::collections::HashMap<String, (String, ClaudeStats)>;
static STATS_CACHE: std::sync::LazyLock<std::sync::Mutex<StatsCache>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

fn files_signature(paths: &[std::path::PathBuf]) -> String {
    let mut entries = paths
        .iter()
        .filter_map(|path| {
            let metadata = path.metadata().ok()?;
            let modified = metadata
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis();
            Some(format!(
                "{}:{}:{}",
                path.display(),
                metadata.len(),
                modified
            ))
        })
        .collect::<Vec<_>>();
    entries.sort();
    entries.join("|")
}

/// Empty stats for sources where reliable token usage is unavailable.
fn empty_claude_stats() -> ClaudeStats {
    let now = chrono::Local::now();
    let mut daily_stats: Vec<ClaudeDailyStats> = Vec::with_capacity(14);
    for i in (0..14).rev() {
        let day = (now - chrono::Duration::days(i))
            .format("%Y-%m-%d")
            .to_string();
        daily_stats.push(ClaudeDailyStats {
            date: day,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            messages: 0,
            sessions: 0,
        });
    }
    ClaudeStats {
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cache_read_tokens: 0,
        total_cache_write_tokens: 0,
        total_messages: 0,
        total_sessions: 0,
        daily_stats,
        model: "unsupported".to_string(),
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClaudeDailyStats {
    date: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    messages: u64,
    sessions: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClaudeStats {
    #[serde(rename = "totalInputTokens")]
    total_input_tokens: u64,
    #[serde(rename = "totalOutputTokens")]
    total_output_tokens: u64,
    #[serde(rename = "totalCacheReadTokens")]
    total_cache_read_tokens: u64,
    #[serde(rename = "totalCacheWriteTokens")]
    total_cache_write_tokens: u64,
    #[serde(rename = "totalMessages")]
    total_messages: u64,
    #[serde(rename = "totalSessions")]
    total_sessions: u64,
    #[serde(rename = "dailyStats")]
    daily_stats: Vec<ClaudeDailyStats>,
    model: String,
}

#[tauri::command]
pub async fn get_claude_stats(source: Option<String>) -> Result<ClaudeStats, String> {
    let source = source.unwrap_or_default().to_ascii_lowercase();

    // Cursor no longer exposes reliable per-turn token usage in local data.
    if source == "cursor" {
        return Ok(empty_claude_stats());
    }

    let jsonl_files = match source.as_str() {
        "codex" => collect_codex_session_jsonl_files(),
        "cc" | "claude" => collect_claude_project_jsonl_files(),
        _ => {
            let mut files = collect_claude_project_jsonl_files();
            files.extend(collect_codex_session_jsonl_files());
            files
        }
    };
    if jsonl_files.is_empty() {
        return Ok(ClaudeStats {
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cache_read_tokens: 0,
            total_cache_write_tokens: 0,
            total_messages: 0,
            total_sessions: 0,
            daily_stats: vec![],
            model: String::new(),
        });
    }

    let cache_key = if source.is_empty() { "all" } else { &source }.to_string();
    let signature = files_signature(&jsonl_files);
    if let Some((cached_signature, cached)) = STATS_CACHE
        .lock()
        .ok()
        .and_then(|cache| cache.get(&cache_key).cloned())
    {
        if cached_signature == signature {
            return Ok(cached);
        }
    }

    let mut daily_map: std::collections::BTreeMap<String, ClaudeDailyStats> =
        std::collections::BTreeMap::new();
    let mut total_input = 0u64;
    let mut total_output = 0u64;
    let mut total_cache_read = 0u64;
    let mut total_cache_write = 0u64;
    let mut total_messages = 0u64;
    let mut total_sessions = 0u64;
    let mut model = String::new();

    let now = chrono::Utc::now();
    let cutoff = now - chrono::Duration::days(14);
    let cutoff_str = cutoff.format("%Y-%m-%d").to_string();

    for path in jsonl_files {
        let modified_day = path
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|t| {
                let dt: chrono::DateTime<chrono::Utc> = t.into();
                dt
            });
        if let Some(modified) = modified_day {
            if modified < cutoff {
                continue;
            }
        }

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let mut session_counted = false;
        let mut session_day: Option<String> = None;

        // Codex logs cumulative token totals on each token_count event.
        // We convert cumulative totals into per-event deltas to avoid
        // double-counting repeated snapshots.
        let mut prev_codex_total_input: Option<u64> = None;
        let mut prev_codex_total_output: Option<u64> = None;
        let mut prev_codex_total_cached_input: Option<u64> = None;

        for line in content.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let parsed: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let line_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");

            if line_type == "assistant" {
                let msg = match parsed.get("message") {
                    Some(m) => m,
                    None => continue,
                };
                let usage = match msg.get("usage") {
                    Some(u) => u,
                    None => continue,
                };

                let date = parsed
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .and_then(|ts| ts.get(..10))
                    .unwrap_or("")
                    .to_string();
                if date < cutoff_str {
                    continue;
                }

                let input = usage
                    .get("input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let output = usage
                    .get("output_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_read = usage
                    .get("cache_read_input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_write = usage
                    .get("cache_creation_input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);

                if model.is_empty() {
                    if let Some(m) = msg.get("model").and_then(|v| v.as_str()) {
                        model = m.to_string();
                    }
                }

                total_input += input;
                total_output += output;
                total_cache_read += cache_read;
                total_cache_write += cache_write;
                total_messages += 1;

                if !session_counted {
                    session_counted = true;
                    total_sessions += 1;
                }
                if session_day.is_none() && !date.is_empty() {
                    session_day = Some(date.clone());
                }

                if !date.is_empty() {
                    let entry = daily_map
                        .entry(date.clone())
                        .or_insert_with(|| ClaudeDailyStats {
                            date: date.clone(),
                            input_tokens: 0,
                            output_tokens: 0,
                            cache_read_tokens: 0,
                            cache_write_tokens: 0,
                            messages: 0,
                            sessions: 0,
                        });
                    entry.input_tokens += input;
                    entry.output_tokens += output;
                    entry.cache_read_tokens += cache_read;
                    entry.cache_write_tokens += cache_write;
                    entry.messages += 1;
                }
                continue;
            }

            if line_type == "session_meta" && model.is_empty() {
                if let Some(m) = parsed
                    .get("payload")
                    .and_then(|p| p.get("model"))
                    .and_then(|v| v.as_str())
                {
                    model = m.to_string();
                } else if let Some(provider) = parsed
                    .get("payload")
                    .and_then(|p| p.get("model_provider"))
                    .and_then(|v| v.as_str())
                {
                    model = provider.to_string();
                }
                continue;
            }

            // Codex format usage: event_msg -> payload.type=token_count -> info.total_token_usage.
            if line_type == "event_msg"
                && parsed
                    .get("payload")
                    .and_then(|p| p.get("type"))
                    .and_then(|v| v.as_str())
                    == Some("token_count")
            {
                let total_usage = match parsed
                    .get("payload")
                    .and_then(|p| p.get("info"))
                    .and_then(|i| i.get("total_token_usage"))
                {
                    Some(v) => v,
                    None => continue,
                };

                let total_input_now = total_usage
                    .get("input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let total_output_now = total_usage
                    .get("output_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let total_cached_now = total_usage
                    .get("cached_input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);

                let delta_input = match prev_codex_total_input {
                    Some(prev) => total_input_now.saturating_sub(prev),
                    None => total_input_now,
                };
                let delta_output = match prev_codex_total_output {
                    Some(prev) => total_output_now.saturating_sub(prev),
                    None => total_output_now,
                };
                let delta_cached = match prev_codex_total_cached_input {
                    Some(prev) => total_cached_now.saturating_sub(prev),
                    None => total_cached_now,
                };

                prev_codex_total_input = Some(total_input_now);
                prev_codex_total_output = Some(total_output_now);
                prev_codex_total_cached_input = Some(total_cached_now);

                // Same cumulative snapshot can be emitted multiple times.
                if delta_input == 0 && delta_output == 0 && delta_cached == 0 {
                    continue;
                }

                let date = parsed
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .and_then(|ts| ts.get(..10))
                    .unwrap_or("")
                    .to_string();
                if date < cutoff_str {
                    continue;
                }

                total_input += delta_input;
                total_output += delta_output;
                total_cache_read += delta_cached;
                total_messages += 1;

                if !session_counted {
                    session_counted = true;
                    total_sessions += 1;
                }
                if session_day.is_none() && !date.is_empty() {
                    session_day = Some(date.clone());
                }

                if !date.is_empty() {
                    let entry = daily_map
                        .entry(date.clone())
                        .or_insert_with(|| ClaudeDailyStats {
                            date: date.clone(),
                            input_tokens: 0,
                            output_tokens: 0,
                            cache_read_tokens: 0,
                            cache_write_tokens: 0,
                            messages: 0,
                            sessions: 0,
                        });
                    entry.input_tokens += delta_input;
                    entry.output_tokens += delta_output;
                    entry.cache_read_tokens += delta_cached;
                    entry.messages += 1;
                }
            }
        }

        // Count one session per day.
        if session_counted {
            let day =
                session_day.or_else(|| modified_day.map(|d| d.format("%Y-%m-%d").to_string()));
            if let Some(day_str) = day {
                let entry = daily_map
                    .entry(day_str.clone())
                    .or_insert_with(|| ClaudeDailyStats {
                        date: day_str.clone(),
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_read_tokens: 0,
                        cache_write_tokens: 0,
                        messages: 0,
                        sessions: 0,
                    });
                entry.sessions += 1;
            }
        }
    }

    // Fill in missing days in the 14-day range
    let mut daily_stats: Vec<ClaudeDailyStats> = Vec::new();
    for i in (0..14).rev() {
        let day = (now - chrono::Duration::days(i))
            .format("%Y-%m-%d")
            .to_string();
        if let Some(entry) = daily_map.remove(&day) {
            daily_stats.push(entry);
        } else {
            daily_stats.push(ClaudeDailyStats {
                date: day,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                messages: 0,
                sessions: 0,
            });
        }
    }

    let result = ClaudeStats {
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        total_cache_read_tokens: total_cache_read,
        total_cache_write_tokens: total_cache_write,
        total_messages,
        total_sessions,
        daily_stats,
        model,
    };
    if let Ok(mut cache) = STATS_CACHE.lock() {
        cache.insert(cache_key, (signature, result.clone()));
    }
    Ok(result)
}
