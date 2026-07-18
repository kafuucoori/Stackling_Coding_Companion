use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};

const TARGET: &str = "Stackling/model-chat-api-key";

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn read_api_key(target_name: &str) -> Result<Option<String>, String> {
    let target = wide(target_name);
    let mut credential = std::ptr::null_mut();
    if unsafe {
        CredReadW(
            PCWSTR(target.as_ptr()),
            CRED_TYPE_GENERIC,
            0,
            &mut credential,
        )
    }
    .is_err()
    {
        return Ok(None);
    }
    if credential.is_null() {
        return Ok(None);
    }
    let value = unsafe {
        let credential_ref = &*credential;
        let blob = std::slice::from_raw_parts(
            credential_ref.CredentialBlob,
            credential_ref.CredentialBlobSize as usize,
        );
        String::from_utf8(blob.to_vec()).map_err(|e| e.to_string())
    };
    unsafe { CredFree(credential.cast()) };
    value.map(Some)
}

#[tauri::command]
pub fn get_model_chat_api_key() -> Result<String, String> {
    Ok(read_api_key(TARGET)?.unwrap_or_default())
}

#[tauri::command]
pub fn set_model_chat_api_key(api_key: String) -> Result<(), String> {
    let target = wide(TARGET);
    if api_key.is_empty() {
        let _ = unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, 0) };
        return Ok(());
    }
    if api_key.len() > 2560 {
        return Err("API 密钥过长，Windows 凭据管理器最多保存 2560 字节".to_string());
    }
    let username = wide("Stackling");
    let mut blob = api_key.into_bytes();
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_ptr() as *mut u16),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: PWSTR(username.as_ptr() as *mut u16),
        ..Default::default()
    };
    unsafe { CredWriteW(&credential, 0) }.map_err(|e| e.to_string())?;
    Ok(())
}
