//! JPMチャット セットアップ。
//!
//! MSI（tools/publish.js が embedded/ に置く）を exe に内蔵し、自前の画面（ui/）で
//! インストール先の選択 → インストール（msi.dll の進捗コールバック）→ 起動 までを行う。
//! MSI の古い見た目のダイアログは一切出さない。ネットワークは使わない。
//!
//! 安全面:
//! - 内蔵 MSI はビルド時の SHA-256（embedded/meta.json）と照合してから書き出す
//! - 利用者ごとのインストール（管理者権限不要）。インストール先はドライブ直下等を避けて必ず製品名のフォルダを付ける
//! - 画面は内蔵ファイルだけ（CSP で外部読み込み禁止）。コマンドは固定の数個のみ

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod msi;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, Window};

// publish.js が置く。無ければビルドが失敗する（MSI 無しの exe を作らないため）
static MSI_BYTES: &[u8] = include_bytes!("../embedded/JPMChat.msi");
static META_JSON: &str = include_str!("../embedded/meta.json");
static INSTALLING: AtomicBool = AtomicBool::new(false);

const PRODUCT_FOLDER: &str = "jpm-chat-desktop";
const PRODUCT_NAME: &str = "JPMチャット";

#[derive(Deserialize)]
struct Meta {
    version: String,
    sha256: String,
    exe_name: String,
}

fn meta() -> Meta {
    serde_json::from_str(META_JSON).expect("embedded/meta.json が不正")
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Info {
    version: String,
    msi_size: u64,
    default_dir: String,
    installed_dir: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    percent: f32,
    action: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InstallResult {
    code: u32,
    message: String,
    dir: String,
}

fn local_app_data() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\"))
}

/// 既定のインストール先（MSI の既定 = %LOCALAPPDATA%\Programs\jpm-chat-desktop と同じ）
fn default_dir() -> PathBuf {
    local_app_data().join("Programs").join(PRODUCT_FOLDER)
}

/// 前回のインストール先（MSI が HKCU\Software\JPM\JPMChat\InstallDir に残す）
fn installed_dir() -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let key: Vec<u16> = "Software\\JPM\\JPMChat".encode_utf16().chain(std::iter::once(0)).collect();
    let name: Vec<u16> = "InstallDir".encode_utf16().chain(std::iter::once(0)).collect();
    let mut buf: Vec<u16> = vec![0; 1024];
    let mut size: u32 = (buf.len() * 2) as u32;
    let rc = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr() as *mut _,
            &mut size,
        )
    };
    if rc != 0 {
        return None;
    }
    let len = (size as usize / 2).saturating_sub(1);
    let s = String::from_utf16_lossy(&buf[..len]).trim_end_matches('\\').to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 利用者が選んだフォルダを安全なインストール先に正規化する。
/// ドライブ直下・ユーザーフォルダ直下・デスクトップ等に直接ばら撒かないよう、製品フォルダ名を付ける。
fn normalize_target(input: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(input.trim());
    if !p.is_absolute() {
        return Err("インストール先は絶対パスで指定してください".into());
    }
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let looks_like_product = name.eq_ignore_ascii_case(PRODUCT_FOLDER) || name == PRODUCT_NAME;
    let is_shallow = p.components().count() <= 2; // "D:\" や "D:\foo" 程度
    let is_special = {
        let s = p.to_string_lossy().to_lowercase();
        let home = std::env::var("USERPROFILE").unwrap_or_default().to_lowercase();
        s == home
            || s.ends_with("\\desktop")
            || s.ends_with("\\documents")
            || s.ends_with("\\downloads")
            || s.ends_with("\\programs")
    };
    if looks_like_product || !(is_shallow || is_special) {
        return Ok(p);
    }
    Ok(p.join(PRODUCT_NAME))
}

#[tauri::command]
fn get_info() -> Info {
    let m = meta();
    Info {
        version: m.version,
        msi_size: MSI_BYTES.len() as u64,
        default_dir: installed_dir().unwrap_or_else(|| default_dir().to_string_lossy().to_string()),
        installed_dir: installed_dir(),
    }
}

#[tauri::command]
async fn pick_dir(current: String) -> Option<String> {
    let start = if Path::new(&current).is_dir() {
        PathBuf::from(&current)
    } else {
        local_app_data().join("Programs")
    };
    // 同期ダイアログはブロッキングなので別スレッドで
    tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("インストール先を選択")
            .set_directory(start)
            .pick_folder()
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
fn preview_dir(input: String) -> Result<String, String> {
    normalize_target(&input).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn install(app: AppHandle, dir: String) -> Result<InstallResult, String> {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("インストールは既に実行中です".into());
    }
    let result = tauri::async_runtime::spawn_blocking(move || install_blocking(app, dir)).await;
    INSTALLING.store(false, Ordering::SeqCst);
    match result {
        Ok(r) => r,
        Err(e) => Err(format!("内部エラー: {e}")),
    }
}

fn install_blocking(app: AppHandle, dir: String) -> Result<InstallResult, String> {
    let target = normalize_target(&dir)?;
    let m = meta();
    let emit = |percent: f32, action: &str| {
        let _ = app.emit("progress", ProgressPayload { percent, action: action.to_string() });
    };

    // 1) 内蔵 MSI の照合（改ざん・破損の検出）
    emit(0.0, "インストーラを確認しています");
    let digest = hex::encode(Sha256::digest(MSI_BYTES));
    if !digest.eq_ignore_ascii_case(&m.sha256) {
        return Err("内蔵のインストーラが壊れています（検証に失敗）。もう一度ダウンロードしてください".into());
    }

    // 2) 一時フォルダへ書き出す（利用者専用の場所）
    let tmp_dir = std::env::temp_dir().join("jpm-chat-setup");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("一時フォルダを作れません: {e}"))?;
    let msi_path = tmp_dir.join(format!("JPMChat-{}.msi", m.version));
    std::fs::write(&msi_path, MSI_BYTES).map_err(|e| format!("一時ファイルを書けません: {e}"))?;

    // 3) インストール先を用意
    std::fs::create_dir_all(&target).map_err(|e| format!("インストール先を作れません: {e}"))?;
    emit(2.0, "インストールを開始します");

    // 4) msi.dll で画面無しインストール（進捗はイベントで画面へ）
    let app2 = app.clone();
    let sink = Box::new(move |p: msi::Progress| {
        let _ = app2.emit("progress", ProgressPayload { percent: p.percent, action: p.action });
    });
    let dir_prop = format!(
        "APPLICATIONFOLDER=\"{}\" MSIINSTALLPERUSER=1 ALLUSERS=2 REBOOT=ReallySuppress",
        target.to_string_lossy().trim_end_matches('\\')
    );
    let rc = msi::install(&msi_path.to_string_lossy(), &dir_prop, sink);
    let _ = std::fs::remove_file(&msi_path);

    let message = msi::describe(rc);
    if rc == 0 || rc == 3010 || rc == 1641 {
        emit(100.0, "完了");
        Ok(InstallResult { code: rc, message, dir: target.to_string_lossy().to_string() })
    } else {
        Err(message)
    }
}

#[tauri::command]
fn launch(app: AppHandle, dir: String) -> Result<(), String> {
    let exe = Path::new(&dir).join(meta().exe_name);
    if !exe.is_file() {
        return Err(format!("起動ファイルが見つかりません: {}", exe.display()));
    }
    std::process::Command::new(&exe)
        .current_dir(&dir)
        .spawn()
        .map_err(|e| format!("起動できません: {e}"))?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn quit(app: AppHandle) {
    if INSTALLING.load(Ordering::SeqCst) {
        return; // インストール中は閉じない
    }
    app.exit(0);
}

#[tauri::command]
fn minimize(window: Window) {
    let _ = window.minimize();
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_info, pick_dir, preview_dir, install, launch, quit, minimize])
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window");
            // 窓は完全に透明のまま、画面側(ui/)がすりガラス風のカードと影を描く。
            // OS のアクリルは窓の矩形全体に掛かり、角丸の外側に四角い縁が見えてしまうため使わない
            let _ = window.show();
            let _ = window.set_focus();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("セットアップの起動に失敗");
}
