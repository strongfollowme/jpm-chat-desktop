/*
 * JPM アカウントで Matrix セッションを取得する（メインプロセス側）。
 *
 * Web 版で主アプリがやっていることと同じ手順を、デスクトップアプリ内で行う:
 *   1. POST /api/auth/login        … JPM アカウントで認証し JWT を得る
 *   2. GET  /api/chat/matrix-token … その JWT で Matrix のアクセストークンを発行してもらう
 *
 * どちらも既に本番稼働中の API で、新設は不要。JPM の JWT はここで使い捨てにし、
 * 保持するのは Matrix のセッションだけにする（保存する秘密を最小限にするため）。
 */

const { JPM_API_BASE } = require("./config");

/**
 * 反クローラフィルタ(AntiCrawlerFilter)対策の User-Agent。
 * 先頭が Mozilla でないと 403 で弾かれる。末尾の識別子はサーバー側ログでの追跡用。
 */
// Chrome の版は Electron が内蔵する Chromium の実版を名乗る。固定の古い版(120)にしていたら、
// element-web の対応ブラウザ判定(直近 2 版の Chrome)に落ちて「このブラウザをサポートしていません」が
// 出続けた（閉じても再表示）。JPMChatDesktop/<版> は反クローラ判定と調査用の目印。
const CHROME_VERSION = (process.versions && process.versions.chrome) || "120.0.0.0";
const APP_VERSION = (() => {
    try { return require("../package.json").jpmVersion || "0.1.0"; } catch (_) { return "0.1.0"; }
})();
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    `Chrome/${CHROME_VERSION} Safari/537.36 JPMChatDesktop/${APP_VERSION}`;

/** 応答が JSON でない(nginx のエラーページ等)場合も落ちないように読む。 */
async function readJson(resp) {
    const text = await resp.text();
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`サーバーから予期しない応答が返りました (HTTP ${resp.status})`);
    }
}

/**
 * JPM アカウントでログインし、Matrix セッションを取得する。
 *
 * @param {string} username JPM のユーザー名
 * @param {string} password JPM のパスワード
 * @returns {Promise<{accessToken: string, userId: string, deviceId: string, homeserverUrl: string}>}
 * @throws {Error} 認証失敗・通信失敗時。message はそのまま利用者に見せる想定（サーバーの日本語メッセージを活かす）
 */
async function loginWithJpmAccount(username, password) {
    // --- 1. JPM 認証 ---
    let loginResp;
    try {
        loginResp = await fetch(`${JPM_API_BASE}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
            body: JSON.stringify({ username, password }),
        });
    } catch (e) {
        throw new Error(`サーバーに接続できません: ${e.message}`);
    }
    const loginJson = await readJson(loginResp);
    if (loginJson.code !== 200 || !loginJson.data?.accessToken) {
        // アカウントロックの残り回数など、サーバーからの案内をそのまま伝える
        throw new Error(loginJson.msg || "ログインに失敗しました");
    }
    const jpmToken = loginJson.data.accessToken;

    // --- 2. Matrix セッション発行 ---
    let matrixResp;
    try {
        matrixResp = await fetch(`${JPM_API_BASE}/api/chat/matrix-token`, {
            method: "GET",
            headers: { Authorization: `Bearer ${jpmToken}`, "User-Agent": USER_AGENT },
        });
    } catch (e) {
        throw new Error(`チャットサーバーに接続できません: ${e.message}`);
    }
    const matrixJson = await readJson(matrixResp);
    if (matrixJson.code !== 200 || !matrixJson.data?.accessToken) {
        throw new Error(matrixJson.msg || "チャットの認証情報を取得できませんでした");
    }

    const data = matrixJson.data;
    return {
        accessToken: data.accessToken,
        userId: data.userId,
        deviceId: data.deviceId || "",
        // サーバーが返す値を優先する（環境ごとの差異をアプリ側で持たないため）
        homeserverUrl: data.homeserverUrl || require("./config").HOMESERVER_URL,
    };
}

/**
 * Web のホーム画面から渡されたワンタイムコードを Matrix セッションに引き換える。
 *
 * 流れ: ブラウザ側が POST /api/chat/desktop/launch-code で 60 秒有効のコードを取得し、
 * jpmchat://open?code=... で本アプリを起動 → ここで /desktop/exchange に投げる。
 * コードは 1 回で無効になるので、URL がログに残っても再利用はできない。
 */
async function exchangeLaunchCode(code) {
    let resp;
    try {
        resp = await fetch(`${JPM_API_BASE}/api/chat/desktop/exchange`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
            body: JSON.stringify({ code }),
        });
    } catch (e) {
        throw new Error(`サーバーに接続できません: ${e.message}`);
    }
    const json = await readJson(resp);
    if (json.code !== 200 || !json.data?.accessToken) {
        throw new Error(json.msg || "起動コードの引き換えに失敗しました");
    }
    const data = json.data;
    return {
        accessToken: data.accessToken,
        userId: data.userId,
        deviceId: data.deviceId || "",
        homeserverUrl: data.homeserverUrl || require("./config").HOMESERVER_URL,
    };
}

module.exports = { loginWithJpmAccount, exchangeLaunchCode, USER_AGENT };
