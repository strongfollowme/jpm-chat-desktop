/*
 * アプリ内自動更新（MSI 版・自前実装）。
 *
 * 【なぜ electron-updater を使わないか】
 * electron-updater の Windows 対応は NSIS インストーラのみで、MSI には対応していない。
 * 配布は MSI に統一する方針（利用者指定）なので、同じ考え方の最小構成を自前で持つ:
 *   1. 配信サーバーの latest.yml を読む（version / path / sha512 / size）
 *   2. 自分の版より新しければ「今すぐ更新」「次回にする」を出す
 *   3. 「今すぐ更新」: MSI を一時フォルダへ取得し sha512 を照合
 *   4. 取得完了後「今すぐ再起動」: 自分を終了してから msiexec で上書きインストール
 *      （MSI の MajorUpgrade で旧版は自動的に置き換わる。runAfterFinish で更新後に再起動する）
 *
 * 利用者の体験（利用者指定）:
 *   「次回にする」は今回の起動中はもう聞かない。次に起動した時にまた聞く。
 *   「後で」を選んだ場合でも、取得済みならアプリ終了時に適用する。
 *
 * 配信元: package.json の build.publish.url（26 機の jpm-updater nginx: /jpm-chat/）。
 * 発行手順は tools/publish.js を参照。
 */

const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const { USER_AGENT } = require("./jpm-auth");
const { UPDATE_FEED_URL } = require("./config");

/** 起動後の初回確認までの待ち（同期の立ち上がりと重ねない）。 */
const FIRST_CHECK_DELAY_MS = 15 * 1000;
/** 定期確認の間隔。 */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * 実際の版番号（4桁 "0.1.0.N"）。package.json の jpmVersion。
 * electron-builder が 3 桁 semver しか受け付けないため、app.getVersion() とは別に持つ。
 */
function currentVersion() {
    try {
        return require("../package.json").jpmVersion || app.getVersion();
    } catch {
        return app.getVersion();
    }
}

/**
 * 配信 URL（末尾スラッシュ付き）。config.js の定数。
 * package.json の build.publish.url はパッケージ時に削除されるため参照できない（実際に undefined になった）。
 */
function feedUrl() {
    const url = UPDATE_FEED_URL;
    if (!url) return null;
    return url.endsWith("/") ? url : `${url}/`;
}

/** latest.yml の最小パーサ（electron-builder 形式の平坦な key: value だけを読む）。 */
function parseLatestYml(text) {
    const out = {};
    for (const line of text.split(/\r?\n/)) {
        const m = /^(version|path|sha512|releaseDate):\s*(.+)$/.exec(line.trim());
        if (m) out[m[1]] = m[2].replace(/^'|'$/g, "");
    }
    return out.version && out.path && out.sha512 ? out : null;
}

/** "0.1.10" と "0.1.9" のような版番号を数値で比べる。a > b なら正。 */
function compareVersion(a, b) {
    const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d;
    }
    return 0;
}

/**
 * @param {object} deps
 * @param {() => import("electron").BrowserWindow|null} deps.getWindow ダイアログの親
 * @param {(...a: any[]) => void} deps.log
 * @param {() => void} deps.quitForUpdate トレイ常駐の「閉じても終了しない」を解除して終了する
 */
function setupAutoUpdater({ getWindow, log, quitForUpdate }) {
    if (!app.isPackaged) {
        log("[更新] 開発モードのため自動更新は無効");
        return;
    }
    const base = feedUrl();
    if (!base) {
        log("[更新] 配信 URL が設定されていないため無効");
        return;
    }

    /** 「次回にする」を選んだ版。今回の起動中は同じ版で再度聞かない。 */
    let postponedVersion = null;
    /** 取得済みで未適用の MSI。終了時に適用する。 */
    let downloadedMsi = null;
    let busy = false;

    async function fetchLatest() {
        const resp = await fetch(`${base}latest.yml?t=${Date.now()}`, {
            headers: { "User-Agent": USER_AGENT, "Cache-Control": "no-cache" },
        });
        if (!resp.ok) throw new Error(`latest.yml HTTP ${resp.status}`);
        const info = parseLatestYml(await resp.text());
        if (!info) throw new Error("latest.yml の形式が不正です");
        return info;
    }

    async function download(info, onProgress) {
        const dir = path.join(app.getPath("temp"), "jpm-chat-update");
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, info.path);
        const resp = await fetch(`${base}${info.path}`, { headers: { "User-Agent": USER_AGENT } });
        if (!resp.ok || !resp.body) throw new Error(`MSI の取得に失敗 (HTTP ${resp.status})`);

        const total = Number(resp.headers.get("content-length")) || 0;
        const hash = crypto.createHash("sha512");
        const out = fs.createWriteStream(dest);
        let received = 0;
        let lastLogged = -1;
        for await (const chunk of resp.body) {
            hash.update(chunk);
            out.write(chunk);
            received += chunk.length;
            if (total) {
                const pct = Math.floor((received / total) * 100);
                if (onProgress) onProgress(pct);
                const step = Math.floor(pct / 10) * 10;
                if (step !== lastLogged) {
                    lastLogged = step;
                    log(`[更新] 取得中 ${step}%`);
                }
            }
        }
        await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));

        const digest = hash.digest("base64");
        if (digest !== info.sha512) {
            fs.rmSync(dest, { force: true });
            throw new Error("取得したファイルの検証(sha512)に失敗しました");
        }
        return dest;
    }

    /** 自分を終了してから msiexec で上書きインストールする。 */
    /**
     * 更新適用用のスクリプトを書き出して、切り離したプロセスとして実行する。
     *
     * 【なぜ PowerShell スクリプトにするか】
     * ・spawn に長いコマンド列を渡すと cmd /c の引用符の扱いで壊れる（start の引用符が欠けて msiexec が走らなかった）
     * ・.cmd バッチは日本語パス（%APPDATA%\JPMチャット、JPMチャット.exe）を chcp 65001 でも正しく読めず、
     *   ログ書き出しと再起動の行だけ黙って失敗した（msiexec の行だけ動いた）
     * PowerShell は Unicode パスをそのまま扱えるので確実。
     *
     * ・自プロセスの終了を待ってから msiexec を実行する（使用中ファイルの差し替えを確実にする）
     * ・/passive: 進行バーだけ出す / /norestart: OS の再起動はしない
     * ・relaunch=true なら msiexec 完了後にアプリを起動し直す（/passive では MSI 側の起動オプションが効かない）
     * ・経過は userData/update.log に残す（うまくいかない時の調査用）
     */
    function runInstaller(msiPath, relaunch) {
        const exe = process.execPath;
        const dir = app.getPath("userData");
        const ps1 = path.join(dir, "apply-update.ps1");
        const logFile = path.join(dir, "update.log");
        const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
        // 利用者がインストール先を変えていても同じ場所へ上書きする（既定のままなら既定の場所）。
        // 末尾の \ は付けない（msiexec の引数で \" と解釈されて壊れる）
        const installDirArg = `APPLICATIONFOLDER="${path.dirname(exe).replace(/[\\/]+$/, "")}"`;
        const lines = [
            `$log = ${q(logFile)}`,
            `Add-Content -Path $log -Value ("[{0}] apply start: {1}" -f (Get-Date -Format s), ${q(msiPath)})`,
            `Start-Sleep -Seconds 3`,
            `$p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', ${q(msiPath)}, '/passive', '/norestart', ${q(installDirArg)}) -Wait -PassThru`,
            `Add-Content -Path $log -Value ("[{0}] msiexec exit={1}" -f (Get-Date -Format s), $p.ExitCode)`,
        ];
        if (relaunch) {
            lines.push(`[Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $null, 'Process')`);
            lines.push(`Start-Process -FilePath ${q(exe)}`);
            lines.push(`Add-Content -Path $log -Value ("[{0}] relaunched" -f (Get-Date -Format s))`);
        }
        // BOM 付き UTF-8 で書く（PowerShell 5.1 が日本語を正しく読むため）
        fs.writeFileSync(ps1, "\ufeff" + lines.join("\r\n") + "\r\n", "utf8");
        // 【重要】powershell を直接 spawn すると、アプリ終了時に Chromium のジョブオブジェクトごと
        // 巻き添えで終了してしまい、msiexec まで到達しなかった（実測）。cmd の start 経由で
        // 別プロセスとして切り離してから起動する（cmd 経由の msiexec は生き残ることを確認済み）。
        const child = spawn(
            "cmd.exe",
            ["/c", "start", '""', "/min", "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", ps1],
            { detached: true, stdio: "ignore", windowsHide: true },
        );
        child.unref();
    }

    function installAndRestart(msiPath) {
        log(`[更新] 適用開始: ${msiPath}`);
        downloadedMsi = null; // 終了時の二重適用を防ぐ（msiexec が2つ走ると片方が失敗する）
        runInstaller(msiPath, true);
        quitForUpdate();
    }

    /**
     * 更新案内ウィンドウ（自前の小窓）。
     * OS のメッセージボックスは見た目が古く、しかもトレイ格納中は親ウィンドウごと隠れて見えないため、
     * 常に前面に出る独立した小窓で案内する。
     */
    function openUpdateWindow(info) {
        const win = new BrowserWindow({
            width: 440,
            height: 300,
            resizable: false,
            minimizable: false,
            maximizable: false,
            frame: false,
            transparent: true,
            alwaysOnTop: true,
            skipTaskbar: false,
            title: "JPMチャットの更新",
            webPreferences: {
                preload: path.join(__dirname, "update-preload.js"),
                contextIsolation: true,
                nodeIntegration: false,
            },
        });
        win.setMenuBarVisibility(false);
        const qs = `?version=${encodeURIComponent(info.version)}&current=${encodeURIComponent(currentVersion())}`;
        win.loadFile(path.join(__dirname, "update.html"), { search: qs });
        win.once("ready-to-show", () => win.show());
        return win;
    }

    async function offerUpdate(info) {
        const win = openUpdateWindow(info);
        const choice = () =>
            new Promise((resolve) => {
                const handler = (event, action) => {
                    if (event.sender !== win.webContents) return;
                    ipcMain.removeListener("jpm:update-choice", handler);
                    resolve(action);
                };
                ipcMain.on("jpm:update-choice", handler);
                win.once("closed", () => {
                    ipcMain.removeListener("jpm:update-choice", handler);
                    resolve("closed");
                });
            });

        const first = await choice();
        if (first !== "update") {
            postponedVersion = info.version;
            log("[更新] 次回に延期");
            if (!win.isDestroyed()) win.close();
            return;
        }

        busy = true;
        try {
            const msi = await download(info, (pct) => {
                if (!win.isDestroyed()) win.webContents.send("jpm:update-progress", pct);
            });
            downloadedMsi = msi;
            log(`[更新] 取得完了: ${info.version}`);
            if (win.isDestroyed()) return; // 取得中に閉じられた → 終了時に適用
            win.webContents.send("jpm:update-downloaded");
            const second = await choice();
            if (!win.isDestroyed()) win.close();
            if (second === "install-now") installAndRestart(msi);
            else log("[更新] 適用は次回終了時");
        } catch (e) {
            log("[更新] 取得に失敗:", e && e.message);
            if (!win.isDestroyed()) win.webContents.send("jpm:update-error", String((e && e.message) || e));
        } finally {
            busy = false;
        }
    }

    async function check() {
        if (busy) return;
        try {
            const info = await fetchLatest();
            if (compareVersion(info.version, currentVersion()) <= 0) return;
            if (postponedVersion === info.version) return;
            log(`[更新] 新しい版があります: ${info.version} (現在 ${currentVersion()})`);
            await offerUpdate(info);
        } catch (e) {
            // 配信サーバーに届かない（社外・26 停止中）のは日常的にあり得るので、ログだけにする
            log("[更新] 確認できませんでした:", e && e.message);
        }
    }

    // 「後で」を選んだ取得済み MSI は終了時に適用する（利用者が自分で終了した時は起動し直さない）
    app.on("before-quit", () => {
        if (!downloadedMsi) return;
        const msi = downloadedMsi;
        downloadedMsi = null;
        log("[更新] 終了時に適用します");
        runInstaller(msi, false);
    });

    setTimeout(check, FIRST_CHECK_DELAY_MS);
    setInterval(check, CHECK_INTERVAL_MS);
}

module.exports = { setupAutoUpdater, currentVersion };
