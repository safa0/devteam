use serde::{Deserialize, Serialize};
use tauri::AppHandle;

// Model API Structs (kept for type compatibility)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Model {
    provider: String,
    name: String,
    id: String,
    model: String,
    description: String,
    modality: String,
    #[serde(rename = "isAvailable")]
    is_available: bool,
}

// Audio API Structs
#[derive(Debug, Serialize, Deserialize)]
pub struct AudioResponse {
    success: bool,
    transcription: Option<String>,
    error: Option<String>,
}


// Audio transcription removed - returns error as no-op
#[tauri::command]
pub async fn transcribe_audio(
    _app: AppHandle,
    _audio_base64: String,
) -> Result<AudioResponse, String> {
    Err("Freely API audio transcription has been removed. Please use a custom STT provider.".to_string())
}

// Chat streaming removed - returns error as no-op
#[tauri::command]
pub async fn chat_stream_response(
    _app: AppHandle,
    _user_message: String,
    _system_prompt: Option<String>,
    _image_base64: Option<serde_json::Value>,
    _history: Option<String>,
) -> Result<String, String> {
    Err("Freely API chat has been removed. Please use a custom AI provider.".to_string())
}

// Fetch models removed - returns empty list
#[tauri::command]
pub async fn fetch_models(_app: AppHandle) -> Result<Vec<Model>, String> {
    Ok(vec![])
}

// License status check - always returns true (all features unlocked)
#[tauri::command]
pub async fn check_license_status(_app: AppHandle) -> Result<bool, String> {
    Ok(true)
}

