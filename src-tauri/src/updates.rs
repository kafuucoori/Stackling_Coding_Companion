// updates.rs —— 从 GitHub Releases 检查最新正式版本。

use std::time::Duration;

use semver::Version;
use serde::{Deserialize, Serialize};

const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/kafuucoori/Stackling_Coding_Companion/releases/latest";

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    published_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    latest_version: String,
    update_available: bool,
    release_name: String,
    release_url: String,
    published_at: Option<String>,
}

fn parse_release_version(tag: &str) -> Result<Version, String> {
    let normalized = tag.trim().trim_start_matches(['v', 'V']);
    Version::parse(normalized).map_err(|e| format!("GitHub 发布版本号无效（{tag}）：{e}"))
}

#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateInfo, String> {
    let client = reqwest::Client::builder()
        .user_agent(format!("Stackling/{}", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| format!("创建更新检查请求失败：{e}"))?;

    let response = client
        .get(LATEST_RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("无法连接 GitHub：{e}"))?;

    if !response.status().is_success() {
        return Err(format!("GitHub 更新检查失败（HTTP {}）", response.status()));
    }

    let release = response
        .json::<GithubRelease>()
        .await
        .map_err(|e| format!("无法解析 GitHub 发布信息：{e}"))?;
    let current = Version::parse(env!("CARGO_PKG_VERSION"))
        .map_err(|e| format!("当前应用版本号无效：{e}"))?;
    let latest = parse_release_version(&release.tag_name)?;

    // 只接受本项目 GitHub Releases 下的地址，避免服务响应异常时打开外部链接。
    let release_url = if release
        .html_url
        .starts_with("https://github.com/kafuucoori/Stackling_Coding_Companion/releases/")
    {
        release.html_url
    } else {
        "https://github.com/kafuucoori/Stackling_Coding_Companion/releases/latest".to_string()
    };

    Ok(UpdateInfo {
        current_version: current.to_string(),
        latest_version: latest.to_string(),
        update_available: latest > current,
        release_name: release.name.unwrap_or_else(|| release.tag_name.clone()),
        release_url,
        published_at: release.published_at,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_release_version;

    #[test]
    fn parses_common_github_release_tags() {
        assert_eq!(
            parse_release_version("v1.2.3").unwrap().to_string(),
            "1.2.3"
        );
        assert_eq!(
            parse_release_version("V2.0.0").unwrap().to_string(),
            "2.0.0"
        );
        assert!(parse_release_version("release-1.2.3").is_err());
    }
}
