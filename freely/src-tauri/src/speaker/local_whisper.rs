use std::path::PathBuf;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WhisperModel {
    TinyEn,
    BaseEn,
    SmallEn,
}

impl WhisperModel {
    pub fn filename(&self) -> &str {
        match self {
            Self::TinyEn => "ggml-tiny.en.bin",
            Self::BaseEn => "ggml-base.en.bin",
            Self::SmallEn => "ggml-small.en.bin",
        }
    }

    pub fn download_url(&self) -> String {
        format!(
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}",
            self.filename()
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperStatus {
    pub initialized: bool,
    pub model: Option<String>,
    pub model_path: Option<String>,
}

pub struct WhisperEngine {
    context: Option<WhisperContext>,
    model_name: Option<String>,
    model_path: Option<PathBuf>,
}

impl WhisperEngine {
    pub fn new() -> Self {
        Self {
            context: None,
            model_name: None,
            model_path: None,
        }
    }

    pub fn init(&mut self, model_path: PathBuf) -> Result<(), String> {
        let params = WhisperContextParameters::default();
        let ctx = WhisperContext::new_with_params(
            model_path.to_str().ok_or("Invalid model path")?,
            params,
        )
        .map_err(|e| format!("Failed to load Whisper model: {}", e))?;

        let model_name = model_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();

        self.context = Some(ctx);
        self.model_name = Some(model_name);
        self.model_path = Some(model_path);
        Ok(())
    }

    pub fn transcribe(&self, audio_f32: &[f32], _sample_rate: u32) -> Result<String, String> {
        let ctx = self.context.as_ref().ok_or("Whisper not initialized")?;
        let mut state = ctx
            .create_state()
            .map_err(|e| format!("Failed to create state: {}", e))?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("en"));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_single_segment(true);
        params.set_no_context(true);

        state
            .full(params, audio_f32)
            .map_err(|e| format!("Transcription failed: {}", e))?;

        let num_segments = state
            .full_n_segments()
            .map_err(|e| format!("Failed to get segments: {}", e))?;
        let mut text = String::new();
        for i in 0..num_segments {
            if let Ok(segment) = state.full_get_segment_text(i) {
                text.push_str(&segment);
            }
        }

        Ok(text.trim().to_string())
    }

    pub fn status(&self) -> WhisperStatus {
        WhisperStatus {
            initialized: self.context.is_some(),
            model: self.model_name.clone(),
            model_path: self
                .model_path
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
        }
    }
}

use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn init_local_whisper(app: AppHandle, model_path: String) -> Result<(), String> {
    let state = app.state::<crate::WhisperState>();
    let mut engine = state
        .engine
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    engine.init(PathBuf::from(model_path))
}

#[tauri::command]
pub async fn transcribe_local(app: AppHandle, audio_b64: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

    let state = app.state::<crate::WhisperState>();
    let engine = state
        .engine
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;

    let wav_bytes = B64
        .decode(&audio_b64)
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    let reader = hound::WavReader::new(std::io::Cursor::new(wav_bytes))
        .map_err(|e| format!("WAV decode error: {}", e))?;
    let spec = reader.spec();
    let samples: Vec<f32> = reader
        .into_samples::<i16>()
        .filter_map(|s| s.ok())
        .map(|s| s as f32 / i16::MAX as f32)
        .collect();

    engine.transcribe(&samples, spec.sample_rate)
}

#[tauri::command]
pub async fn get_local_whisper_status(app: AppHandle) -> Result<WhisperStatus, String> {
    let state = app.state::<crate::WhisperState>();
    let engine = state
        .engine
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    Ok(engine.status())
}
