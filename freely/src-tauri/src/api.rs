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

// Pluely Prompts API (kept for type compatibility)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PluelyPrompt {
    title: String,
    prompt: String,
    #[serde(rename = "modelId")]
    model_id: String,
    #[serde(rename = "modelName")]
    model_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PluelyPromptsResponse {
    prompts: Vec<PluelyPrompt>,
    total: i32,
    #[serde(rename = "last_updated")]
    last_updated: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SystemPromptResponse {
    prompt_name: String,
    system_prompt: String,
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

// Fetch prompts removed - returns empty list
#[tauri::command]
pub async fn fetch_prompts() -> Result<PluelyPromptsResponse, String> {
    Ok(PluelyPromptsResponse {
        prompts: vec![],
        total: 0,
        last_updated: None,
    })
}

// Create system prompt removed - returns error as no-op
#[tauri::command]
pub async fn create_system_prompt(
    _app: AppHandle,
    _user_prompt: String,
) -> Result<SystemPromptResponse, String> {
    Err("Freely API system prompt generation has been removed.".to_string())
}

// License status check - always returns true (all features unlocked)
#[tauri::command]
pub async fn check_license_status(_app: AppHandle) -> Result<bool, String> {
    Ok(true)
}

// Activity API removed - returns empty data
#[allow(dead_code)]
#[tauri::command]
pub async fn get_activity(_app: AppHandle) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "success": true,
        "data": [],
        "total_tokens_used": 0
    }))
}
