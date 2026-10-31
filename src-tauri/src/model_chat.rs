use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChatRequest {
    pub provider_url: String,
    pub api_key: String,
    pub model: String,
    pub messages: Vec<ModelChatMessage>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChatStreamRequest {
    pub request_id: String,
    pub provider_url: String,
    pub api_key: String,
    pub model: String,
    pub messages: Vec<ModelChatMessage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChatResponse {
    pub content: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ModelChatStreamEvent {
    request_id: String,
    kind: String,
    content: Option<String>,
    error: Option<String>,
}

fn active_streams() -> &'static Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>> =
        OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remove_active_stream(request_id: &str) {
    if let Ok(mut streams) = active_streams().lock() {
        streams.remove(request_id);
    }
}

#[derive(Debug, Serialize)]
struct ChatCompletionRequest<'a> {
    model: &'a str,
    messages: &'a [ModelChatMessage],
    stream: bool,
}

fn completions_url(provider_url: &str) -> Result<String, String> {
    let base = provider_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("请先填写提供商地址".to_string());
    }
    if base.ends_with("/v1") {
        Ok(format!("{base}/chat/completions"))
    } else if base.ends_with("/chat/completions") {
        Ok(base.to_string())
    } else {
        Ok(format!("{base}/v1/chat/completions"))
    }
}

fn extract_error(body: &Value) -> Option<String> {
    body.get("error")
        .and_then(|e| {
            e.get("message")
                .or_else(|| e.get("msg"))
                .or_else(|| e.get("type"))
                .and_then(|v| v.as_str())
        })
        .map(str::to_string)
}

fn extract_content(body: &Value) -> Result<String, String> {
    if let Some(err) = extract_error(body) {
        return Err(err);
    }
    body.get("choices")
        .and_then(|v| v.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "响应中没有可显示的文本".to_string())
}

fn extract_delta(body: &Value) -> Option<String> {
    body.get("choices")
        .and_then(|v| v.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("delta"))
        .and_then(|delta| delta.get("content"))
        .and_then(|content| content.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

fn extract_reasoning_delta(body: &Value) -> Option<String> {
    body.get("choices")
        .and_then(|v| v.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("delta"))
        .and_then(|delta| {
            delta
                .get("reasoning_content")
                .or_else(|| delta.get("reasoning"))
                .or_else(|| delta.get("reasoningContent"))
        })
        .and_then(|content| content.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

fn emit_stream_event(
    app: &AppHandle,
    request_id: &str,
    kind: &str,
    content: Option<String>,
    error: Option<String>,
) {
    let _ = app.emit(
        "model-chat-stream",
        ModelChatStreamEvent {
            request_id: request_id.to_string(),
            kind: kind.to_string(),
            content,
            error,
        },
    );
}

#[tauri::command]
pub async fn send_model_chat_message(
    request: ModelChatRequest,
) -> Result<ModelChatResponse, String> {
    let api_key = request.api_key.trim();
    let model = request.model.trim();
    if api_key.is_empty() {
        return Err("请先填写 API 密钥".to_string());
    }
    if model.is_empty() {
        return Err("请先填写模型名称".to_string());
    }
    if request.messages.is_empty() {
        return Err("消息不能为空".to_string());
    }

    let url = completions_url(&request.provider_url)?;
    let client = reqwest::Client::new();
    let res = client
        .post(url)
        .bearer_auth(api_key)
        .json(&ChatCompletionRequest {
            model,
            messages: &request.messages,
            stream: false,
        })
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;

    let status = res.status();
    let body = res
        .json::<Value>()
        .await
        .map_err(|e| format!("响应解析失败：{e}"))?;

    if !status.is_success() {
        return Err(extract_error(&body).unwrap_or_else(|| format!("接口返回 HTTP {status}")));
    }

    Ok(ModelChatResponse {
        content: extract_content(&body)?,
    })
}

#[tauri::command]
pub async fn stream_model_chat_message(
    app: AppHandle,
    request: ModelChatStreamRequest,
) -> Result<(), String> {
    let request_id = request.request_id.trim().to_string();
    if request_id.is_empty() {
        return Err("requestId 不能为空".to_string());
    }

    let api_key = request.api_key.trim().to_string();
    let model = request.model.trim().to_string();
    if api_key.is_empty() {
        return Err("请先填写 API 密钥".to_string());
    }
    if model.is_empty() {
        return Err("请先填写模型名称".to_string());
    }
    if request.messages.is_empty() {
        return Err("消息不能为空".to_string());
    }
    let url = completions_url(&request.provider_url)?;
    let messages = request.messages;
    let task_request_id = request_id.clone();
    let task = tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        let res = match client
            .post(url)
            .bearer_auth(api_key)
            .json(&ChatCompletionRequest {
                model: &model,
                messages: &messages,
                stream: true,
            })
            .send()
            .await
        {
            Ok(response) => response,
            Err(e) => {
                emit_stream_event(
                    &app,
                    &task_request_id,
                    "error",
                    None,
                    Some(format!("请求失败：{e}")),
                );
                remove_active_stream(&task_request_id);
                return;
            }
        };

        let status = res.status();
        if !status.is_success() {
            let body = res
                .json::<Value>()
                .await
                .unwrap_or_else(|_| serde_json::json!({}));
            let error = extract_error(&body).unwrap_or_else(|| format!("接口返回 HTTP {status}"));
            emit_stream_event(&app, &task_request_id, "error", None, Some(error));
            remove_active_stream(&task_request_id);
            return;
        }

        let mut stream = res.bytes_stream();
        let mut pending = String::new();

        while let Some(item) = stream.next().await {
            let bytes = match item {
                Ok(bytes) => bytes,
                Err(e) => {
                    emit_stream_event(
                        &app,
                        &task_request_id,
                        "error",
                        None,
                        Some(format!("流式响应读取失败：{e}")),
                    );
                    remove_active_stream(&task_request_id);
                    return;
                }
            };

            pending.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(pos) = pending.find('\n') {
                let line = pending[..pos].trim().to_string();
                pending = pending[pos + 1..].to_string();
                if !line.starts_with("data:") {
                    continue;
                }

                let data = line.trim_start_matches("data:").trim();
                if data == "[DONE]" {
                    emit_stream_event(&app, &task_request_id, "done", None, None);
                    remove_active_stream(&task_request_id);
                    return;
                }

                match serde_json::from_str::<Value>(data) {
                    Ok(value) => {
                        if let Some(err) = extract_error(&value) {
                            emit_stream_event(&app, &task_request_id, "error", None, Some(err));
                            remove_active_stream(&task_request_id);
                            return;
                        }
                        if let Some(delta) = extract_delta(&value) {
                            emit_stream_event(&app, &task_request_id, "delta", Some(delta), None);
                        }
                        if let Some(reasoning) = extract_reasoning_delta(&value) {
                            emit_stream_event(
                                &app,
                                &task_request_id,
                                "reasoning",
                                Some(reasoning),
                                None,
                            );
                        }
                    }
                    Err(_) => continue,
                }
            }
        }

        emit_stream_event(&app, &task_request_id, "done", None, None);
        remove_active_stream(&task_request_id);
    });

    let previous = active_streams()
        .lock()
        .map_err(|_| "流式请求状态不可用".to_string())?
        .insert(request_id, task);
    if let Some(previous) = previous {
        previous.abort();
    }

    Ok(())
}

#[tauri::command]
pub fn cancel_model_chat_stream(request_id: String) {
    if let Ok(mut streams) = active_streams().lock() {
        if let Some(task) = streams.remove(&request_id) {
            task.abort();
        }
    }
}
