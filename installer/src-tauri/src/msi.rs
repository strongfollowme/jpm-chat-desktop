//! Windows Installer(msi.dll) を直接呼んで、MSI の画面を一切出さずにインストールし、
//! 進捗をコールバックで受け取る。msiexec を子プロセスで起動する方式だと進捗が取れず、
//! 進行バーの MSI ダイアログも出てしまうため、こちらを使う。
//!
//! 進捗の計算は Microsoft の資料「Handling Progress Messages Using MsiSetExternalUI」の手順どおり。

use std::ffi::c_void;
use std::sync::Mutex;
use windows_sys::Win32::System::ApplicationInstallationAndServicing::{
    MsiInstallProductW, MsiRecordGetInteger, MsiRecordGetStringW, MsiSetExternalUIRecord, MsiSetInternalUI,
    INSTALLUILEVEL_NONE, MSIHANDLE,
};

// INSTALLMESSAGE_* は上位バイトが種別。INSTALLLOGMODE_* は 1 << (種別)
const INSTALLMESSAGE_FATALEXIT: u32 = 0x0000_0000;
const INSTALLMESSAGE_ERROR: u32 = 0x0100_0000;
const INSTALLMESSAGE_WARNING: u32 = 0x0200_0000;
const INSTALLMESSAGE_ACTIONSTART: u32 = 0x0800_0000;
const INSTALLMESSAGE_ACTIONDATA: u32 = 0x0900_0000;
const INSTALLMESSAGE_PROGRESS: u32 = 0x0A00_0000;
const fn logmode(msg: u32) -> u32 {
    1 << (msg >> 24)
}
const IDOK: i32 = 1;

/// 進捗の通知。percent は 0〜100、action は今やっている処理の説明（英語の MSI 標準文言）
#[derive(Clone, Debug)]
pub struct Progress {
    pub percent: f32,
    pub action: String,
}

struct State {
    total: i64,
    completed: i64,
    forward: bool,
    /// ACTIONDATA ごとに進める幅（field1==1 で指定される）
    step: i64,
    step_enabled: bool,
    /// 2 段階（費用計算 → 実行）のうち今どちらか。実行段階を 20〜100% に割り当てる
    phase: u8,
    action: String,
    sink: Box<dyn FnMut(Progress) + Send>,
    last_sent: f32,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn field_int(rec: MSIHANDLE, i: u32) -> i64 {
    let v = unsafe { MsiRecordGetInteger(rec, i) };
    // MSI_NULL_INTEGER (0x80000000) は「無し」
    if v == i32::MIN {
        0
    } else {
        v as i64
    }
}

fn field_str(rec: MSIHANDLE, i: u32) -> String {
    let mut len: u32 = 0;
    // 必要な長さを問い合わせ（終端を含めない長さが返る）
    let mut dummy: [u16; 1] = [0];
    unsafe { MsiRecordGetStringW(rec, i, dummy.as_mut_ptr(), &mut len) };
    let mut buf: Vec<u16> = vec![0; (len as usize) + 1];
    let mut cap: u32 = buf.len() as u32;
    let rc = unsafe { MsiRecordGetStringW(rec, i, buf.as_mut_ptr(), &mut cap) };
    if rc != 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..cap as usize])
}

fn emit(st: &mut State, force: bool) {
    let raw = if st.total > 0 {
        (st.completed as f32 / st.total as f32).clamp(0.0, 1.0)
    } else {
        0.0
    };
    // 段階 0(費用計算) は 0〜20%、段階 1 以降(実行) は 20〜100% に割り当てる
    let percent = if st.phase == 0 { raw * 20.0 } else { 20.0 + raw * 80.0 };
    let percent = percent.clamp(0.0, 100.0);
    if !force && (percent - st.last_sent).abs() < 0.5 {
        return;
    }
    st.last_sent = percent;
    let p = Progress { percent, action: st.action.clone() };
    (st.sink)(p);
}

unsafe extern "system" fn external_ui(_ctx: *mut c_void, message_type: u32, record: MSIHANDLE) -> i32 {
    let kind = message_type & 0xFF00_0000;
    let mut guard = match STATE.lock() {
        Ok(g) => g,
        Err(_) => return IDOK,
    };
    let Some(st) = guard.as_mut() else {
        return IDOK;
    };
    match kind {
        INSTALLMESSAGE_PROGRESS => {
            let f1 = field_int(record, 1);
            match f1 {
                0 => {
                    // リセット: total=field2, direction=field3(0=前進), field4=1 なら実行スクリプト段階
                    st.total = field_int(record, 2);
                    st.completed = 0;
                    st.forward = field_int(record, 3) == 0;
                    st.step_enabled = false;
                    if field_int(record, 4) == 1 {
                        st.phase = 1;
                    }
                    emit(st, true);
                }
                1 => {
                    // ACTIONDATA ごとの進み幅
                    if field_int(record, 3) == 1 {
                        st.step = field_int(record, 2);
                        st.step_enabled = true;
                    } else {
                        st.step_enabled = false;
                    }
                }
                2 => {
                    let delta = field_int(record, 2);
                    if st.forward {
                        st.completed += delta;
                    } else {
                        st.completed -= delta;
                    }
                    emit(st, false);
                }
                3 => {
                    st.total += field_int(record, 2);
                }
                _ => {}
            }
            IDOK
        }
        INSTALLMESSAGE_ACTIONSTART => {
            // field2 = 処理名の説明（"Copying new files" 等）。空なら field1(内部名)
            let desc = field_str(record, 2);
            let name = field_str(record, 1);
            st.action = if desc.trim().is_empty() { name.clone() } else { desc };
            if st.phase == 0 && (st.action.contains("Copying") || name.contains("InstallFiles")) {
                st.phase = 1;
            }
            emit(st, true);
            IDOK
        }
        INSTALLMESSAGE_ACTIONDATA => {
            if st.step_enabled {
                if st.forward {
                    st.completed += st.step;
                } else {
                    st.completed -= st.step;
                }
                emit(st, false);
            }
            IDOK
        }
        INSTALLMESSAGE_ERROR | INSTALLMESSAGE_FATALEXIT | INSTALLMESSAGE_WARNING => {
            // 画面は出さない。内容は action に残して呼び出し側のログへ
            let text = field_str(record, 0);
            if !text.trim().is_empty() {
                st.action = text;
                emit(st, true);
            }
            IDOK
        }
        _ => IDOK,
    }
}

/// MSI を画面無しでインストールする。戻り値は Windows Installer のエラーコード（0=成功、3010=再起動が必要）。
/// `command_line` は "PROP=value" 形式のプロパティ列。
pub fn install(msi_path: &str, command_line: &str, sink: Box<dyn FnMut(Progress) + Send>) -> u32 {
    {
        let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
        *g = Some(State {
            total: 0,
            completed: 0,
            forward: true,
            step: 0,
            step_enabled: false,
            phase: 0,
            action: String::new(),
            sink,
            last_sent: -1.0,
        });
    }
    let path: Vec<u16> = msi_path.encode_utf16().chain(std::iter::once(0)).collect();
    let cmd: Vec<u16> = command_line.encode_utf16().chain(std::iter::once(0)).collect();
    let filter = logmode(INSTALLMESSAGE_PROGRESS)
        | logmode(INSTALLMESSAGE_ACTIONSTART)
        | logmode(INSTALLMESSAGE_ACTIONDATA)
        | logmode(INSTALLMESSAGE_ERROR)
        | logmode(INSTALLMESSAGE_FATALEXIT)
        | logmode(INSTALLMESSAGE_WARNING);
    let rc = unsafe {
        MsiSetInternalUI(INSTALLUILEVEL_NONE, std::ptr::null_mut());
        // windows-sys 0.59 の束縛では 4 番目(前のハンドラの受け取り)も Option<fn> 型なので None を渡す
        MsiSetExternalUIRecord(Some(external_ui), filter, std::ptr::null(), None);
        let rc = MsiInstallProductW(path.as_ptr(), cmd.as_ptr());
        // 後始末: コールバックを外す
        MsiSetExternalUIRecord(None, 0, std::ptr::null(), None);
        rc
    };
    {
        let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
        *g = None;
    }
    rc
}

/// エラーコードを利用者向けの日本語にする
pub fn describe(rc: u32) -> String {
    match rc {
        0 => "完了".into(),
        3010 => "完了（反映には Windows の再起動が必要です）".into(),
        1602 => "インストールを取り消しました".into(),
        1603 => "インストール中に致命的なエラーが発生しました".into(),
        1618 => "別のインストールが実行中です。終わってからもう一度お試しください".into(),
        1619 | 1620 => "インストーラの内容を開けませんでした（ファイルが壊れている可能性があります）".into(),
        1625 => "このコンピューターの方針によりインストールが禁止されています".into(),
        1638 => "同じ版が既にインストールされています".into(),
        1641 => "完了（再起動を開始しました）".into(),
        other => format!("Windows Installer エラー {other}"),
    }
}
