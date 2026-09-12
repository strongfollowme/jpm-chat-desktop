// JPMチャット セットアップの画面ロジック。Rust 側のコマンド（get_info / pick_dir / preview_dir / install / launch / quit）だけを使う
(function () {
  "use strict";
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const $ = (id) => document.getElementById(id);
  const steps = { start: $("step-start"), progress: $("step-progress"), done: $("step-done"), error: $("step-error") };
  let installedDir = "";
  let installing = false;

  function show(name) {
    for (const [k, el] of Object.entries(steps)) el.classList.toggle("is-active", k === name);
  }

  function setProgress(percent, action) {
    const p = Math.max(0, Math.min(100, percent));
    $("percent").textContent = String(Math.round(p));
    const circumference = 326.7;
    $("ring-fg").style.strokeDashoffset = String(circumference * (1 - p / 100));
    if (action) $("action").textContent = translateAction(action);
  }

  // MSI の標準文言（英語）を日本語に。無いものはそのまま
  const ACTION_JA = {
    "Validating install": "インストール内容を確認しています",
    "Computing space requirements": "必要な容量を計算しています",
    "Copying new files": "ファイルをコピーしています",
    "Removing files": "古いファイルを削除しています",
    "Creating shortcuts": "ショートカットを作成しています",
    "Removing shortcuts": "ショートカットを削除しています",
    "Writing system registry values": "設定を登録しています",
    "Removing system registry values": "古い設定を削除しています",
    "Registering product": "製品を登録しています",
    "Unregistering product": "製品の登録を解除しています",
    "Publishing product information": "製品情報を公開しています",
    "Removing applications": "古い版を削除しています",
    "Updating component registration": "コンポーネントを更新しています",
    "Creating folders": "フォルダを作成しています",
    "Removing folders": "フォルダを削除しています",
    "Generating script operations for action:": "処理を準備しています",
  };
  function translateAction(text) {
    for (const [en, ja] of Object.entries(ACTION_JA)) {
      if (text.startsWith(en)) return ja;
    }
    return text;
  }

  async function init() {
    try {
      const info = await invoke("get_info");
      $("version").textContent = info.version;
      $("dir").value = info.defaultDir;
      if (info.installedDir) {
        $("dir-hint").textContent = "既にインストール済みです。同じ場所に上書きします（設定や履歴は保持されます）";
      }
    } catch (e) {
      $("dir-hint").textContent = "情報を取得できませんでした: " + e;
    }
  }

  $("btn-pick").addEventListener("click", async () => {
    const picked = await invoke("pick_dir", { current: $("dir").value });
    if (picked) {
      try {
        $("dir").value = await invoke("preview_dir", { input: picked });
      } catch (e) {
        $("dir-hint").textContent = String(e);
      }
    }
  });

  $("btn-install").addEventListener("click", async () => {
    if (installing) return;
    installing = true;
    $("btn-install").disabled = true;
    show("progress");
    setProgress(0, "準備しています…");
    try {
      const result = await invoke("install", { dir: $("dir").value });
      installedDir = result.dir;
      $("done-msg").textContent = result.code === 0 ? "インストール先: " + result.dir : result.message;
      setProgress(100, "完了");
      setTimeout(() => show("done"), 500);
    } catch (e) {
      $("error-msg").textContent = String(e);
      show("error");
    } finally {
      installing = false;
      $("btn-install").disabled = false;
    }
  });

  listen("progress", (ev) => {
    const p = ev.payload || {};
    setProgress(p.percent || 0, p.action || "");
  });

  $("btn-launch").addEventListener("click", async () => {
    try {
      await invoke("launch", { dir: installedDir });
    } catch (e) {
      $("done-msg").textContent = String(e);
    }
  });
  $("btn-finish").addEventListener("click", () => invoke("quit"));
  $("btn-error-close").addEventListener("click", () => invoke("quit"));
  $("btn-retry").addEventListener("click", () => show("start"));
  $("btn-close").addEventListener("click", () => {
    if (!installing) invoke("quit");
  });
  $("btn-min").addEventListener("click", () => invoke("minimize"));

  // 右クリックメニュー・ドラッグ等は無効（インストーラらしく）
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => e.preventDefault());

  init();
})();
