/*
 * ファイルログ。
 *
 * インストール版(GUI アプリ)は console 出力がどこにも残らないため、
 * 「通知が来ない」「ログインできない」といった問い合わせを調べる手段が無くなる。
 * userData 配下にテキストで残しておき、利用者に送ってもらえるようにする。
 *
 * 個人情報・認証情報は書かない（トークンやメッセージ本文は出さず、件数や状態だけ）。
 */

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

let logPath = null;

/** ログファイルの場所を決めて初期化する。 */
function initLogger() {
    try {
        const dir = app.getPath("userData");
        fs.mkdirSync(dir, { recursive: true });
        logPath = path.join(dir, "jpm-chat.log");

        // 肥大化を防ぐ: 1MB を超えていたら 1 世代だけ残して切り詰める
        try {
            const st = fs.statSync(logPath);
            if (st.size > 1024 * 1024) {
                fs.copyFileSync(logPath, logPath + ".1");
                fs.truncateSync(logPath, 0);
            }
        } catch {
            // 初回はファイルが無いので何もしない
        }
        let ver = app.getVersion();
        try { ver = require("../package.json").jpmVersion || ver; } catch { /* 無ければ semver */ }
        log(`===== 起動 ${ver} (${process.platform}) =====`);
        log(`ログ: ${logPath}`);
    } catch (e) {
        // ログが取れなくても本体は動かす
        console.error("ログ初期化に失敗:", e && e.message);
    }
}

/** 1行書く（コンソールにも出すので開発時はそのまま見える）。 */
function log(...args) {
    const line = `[${new Date().toLocaleString("ja-JP")}] ${args.join(" ")}`;
    console.log(line);
    if (!logPath) return;
    try {
        fs.appendFileSync(logPath, line + "\n", "utf8");
    } catch {
        // 書けなくても無視する
    }
}

/** ログファイルの場所（トレイメニューから開けるようにするため）。 */
function getLogPath() {
    return logPath;
}

module.exports = { initLogger, log, getLogPath };
