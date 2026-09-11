/*
 * メインプロセス側の通知エンジン。
 *
 * 【なぜレンダラ(element-web)任せにできないのか】
 * ウィンドウを画面から消すと Chromium はそのレンダラを凍結する。実測では
 *   ・backgroundThrottling: false
 *   ・disable-background-timer-throttling / disable-renderer-backgrounding
 *     / disable-backgrounding-occluded-windows
 *   ・disable-features=CalculateNativeWinOcclusion
 *   ・hide() をやめて画面外へ退避
 *   ・document.visibilityState の上書き
 * のいずれを行っても、非表示中は element-web が新着を処理せず通知を出さなかった
 * (/sync の通信自体はブラウザプロセスのネットワーク層が行うので 200 が返るが、
 *  ページ側のコールバックが走らない)。
 *
 * そこで「常駐して通知を出す」という本アプリの目的そのものは、凍結されない
 * メインプロセス(Node)で受け持つ。element-web は画面表示の担当に徹してもらう。
 *
 * 二重通知を避けるため、ウィンドウが見えている間はこちらからは通知しない
 * (その時は element-web が自前で通知を出せる状態なので任せる)。
 */

const { Notification } = require("electron");
const { log } = require("./logger");
const { CHAT_ORIGIN } = require("./config");
const { USER_AGENT } = require("./jpm-auth");

/** 長ポーリングの待ち時間(ミリ秒)。Matrix の標準的な値。 */
const SYNC_TIMEOUT_MS = 30000;

class MatrixNotifier {
    /**
     * @param {object} deps
     * @param {() => boolean} deps.isWindowHidden ウィンドウが退避中か（通知を出すかの判断に使う）
     * @param {(roomId: string) => void} deps.onOpenRoom 通知クリック時に開く部屋
     */
    constructor({ iconPath, isWindowHidden, onOpenRoom, onNotified }) {
        this.iconPath = iconPath;
        this.isWindowHidden = isWindowHidden;
        this.onOpenRoom = onOpenRoom;
        this.onNotified = onNotified || (() => {});

        this.accessToken = null;
        this.userId = null;
        /** 401 で止まった時のトークン。同じトークンで再開しないための目印 */
        this.invalidToken = null;
        this.nextBatch = null;
        this.running = false;
        this.abortController = null;

        /** 部屋 ID → 表示名 */
        this.roomNames = new Map();
        /** ユーザー ID → 表示名 */
        this.displayNames = new Map();
        /** 直近で通知したイベント ID（再通知の防止） */
        this.notifiedEventIds = new Set();
    }

    /** 認証情報を渡して同期を開始する。既に動いていれば入れ替える。 */
    start(accessToken, userId) {
        if (!accessToken) return;
        if (this.running && this.accessToken === accessToken) return;
        if (!this.running && this.invalidToken === accessToken) return; // 失効済みと分かっているトークン

        this.stop();
        this.accessToken = accessToken;
        this.userId = userId || null;
        this.nextBatch = null;
        this.running = true;
        log("[通知エンジン] 開始");
        this.loop().catch((e) => log("[通知エンジン] 異常終了:", e && e.message));
    }

    stop() {
        this.running = false;
        if (this.abortController) {
            try {
                this.abortController.abort();
            } catch {
                // 中断済みなら無視
            }
            this.abortController = null;
        }
    }

    /** Matrix API を叩く（認証ヘッダと UA を付ける）。 */
    async api(path, { signal } = {}) {
        const resp = await fetch(`${CHAT_ORIGIN}${path}`, {
            headers: { Authorization: `Bearer ${this.accessToken}`, "User-Agent": USER_AGENT },
            signal,
        });
        if (resp.status === 401) {
            // トークンが失効した（同じ端末IDで別の場所からログインし直すと旧トークンは無効になる）。
            // ページ側が新しいトークンを持っていれば main.js の定期確認で再開される
            log("[通知エンジン] トークンが無効になりました。同期を停止します（ページ側の新トークンで再開待ち）");
            this.invalidToken = this.accessToken;
            this.running = false;
            return null;
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
    }

    /** 同期ループ本体。 */
    async loop() {
        // 初回は timeout=0 で現在位置だけ取得する（過去の未読で通知が大量に出るのを防ぐ）
        while (this.running) {
            try {
                this.abortController = new AbortController();
                const qs = this.nextBatch
                    ? `?since=${encodeURIComponent(this.nextBatch)}&timeout=${SYNC_TIMEOUT_MS}`
                    : `?timeout=0`;
                const data = await this.api(`/_matrix/client/v3/sync${qs}`, { signal: this.abortController.signal });
                if (!data) return; // 401 等で停止

                const isFirst = !this.nextBatch;
                this.nextBatch = data.next_batch;
                if (!isFirst) await this.handleSync(data);
            } catch (e) {
                if (!this.running) return;
                const msg = String(e && e.message);
                if (msg.includes("abort")) continue;
                // ネットワーク断など。少し待って続ける（常駐アプリなので諦めない）
                log("[通知エンジン] 同期エラー、5秒後に再試行:", msg);
                await new Promise((r) => setTimeout(r, 5000));
            }
        }
    }

    /** sync 応答から通知すべきイベントを拾って通知する。 */
    async handleSync(data) {
        const rooms = (data.rooms && data.rooms.join) || {};
        for (const [roomId, room] of Object.entries(rooms)) {
            // 部屋名の更新（state に含まれていれば拾っておく）
            const stateEvents = (room.state && room.state.events) || [];
            for (const ev of stateEvents) {
                if (ev.type === "m.room.name" && ev.content && ev.content.name) {
                    this.roomNames.set(roomId, ev.content.name);
                }
            }

            // サーバーが「通知すべき」と判断した件数。0 なら何もしない
            // （ミュート設定や既読の判定はサーバー側のプッシュルールに従う）
            const count = (room.unread_notifications && room.unread_notifications.notification_count) || 0;
            if (count === 0) continue;

            const events = (room.timeline && room.timeline.events) || [];
            for (const ev of events) {
                if (ev.type !== "m.room.message") continue;
                if (this.userId && ev.sender === this.userId) continue; // 自分の発言
                if (!ev.event_id || this.notifiedEventIds.has(ev.event_id)) continue;
                this.notifiedEventIds.add(ev.event_id);
                // 際限なく増やさない
                if (this.notifiedEventIds.size > 500) {
                    this.notifiedEventIds = new Set([...this.notifiedEventIds].slice(-200));
                }
                await this.notify(roomId, ev);
            }
        }
    }

    /** 実際に通知を出す。 */
    async notify(roomId, ev) {
        // ウィンドウが見えている時は element-web 側が通知するので二重に出さない
        if (!this.isWindowHidden()) return;
        if (!Notification.isSupported()) return;

        const roomName = await this.getRoomName(roomId);
        const sender = await this.getDisplayName(ev.sender);
        const body = this.previewOf(ev.content);

        const n = new Notification({
            title: roomName ? `${sender} (${roomName})` : sender,
            body,
            // アプリのアイコンを明示する（Windows 側の登録に頼らず、常に JPM のアイコンで出す）
            icon: this.iconPath,
            silent: false,
        });
        n.on("click", () => this.onOpenRoom(roomId));
        n.show();
        log(`[通知エンジン] 通知を表示: ${sender}`);
        this.onNotified();
    }

    /** 本文のプレビュー文字列（種類に応じて短くする）。 */
    previewOf(content) {
        if (!content) return "新しいメッセージ";
        switch (content.msgtype) {
            case "m.image":
                return "画像を送信しました";
            case "m.video":
                return "動画を送信しました";
            case "m.audio":
                return "音声を送信しました";
            case "m.file":
                return "ファイルを送信しました";
            case "m.jpm.album":
                return "アルバムを送信しました";
            default: {
                const text = String(content.body || "新しいメッセージ");
                return text.length > 120 ? text.slice(0, 120) + "…" : text;
            }
        }
    }

    /** 部屋の表示名（取得できなければ null）。結果は使い回す。 */
    async getRoomName(roomId) {
        if (this.roomNames.has(roomId)) return this.roomNames.get(roomId);
        try {
            const data = await this.api(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`);
            const name = data && data.name ? data.name : null;
            this.roomNames.set(roomId, name);
            return name;
        } catch {
            // 1対1の部屋など名前が無いことは普通にあるので、失敗しても静かに諦める
            this.roomNames.set(roomId, null);
            return null;
        }
    }

    /** 送信者の表示名（取得できなければ localpart）。結果は使い回す。 */
    async getDisplayName(userId) {
        if (!userId) return "新着メッセージ";
        if (this.displayNames.has(userId)) return this.displayNames.get(userId);
        const fallback = userId.startsWith("@") ? userId.slice(1).split(":")[0] : userId;
        try {
            const data = await this.api(`/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`);
            const name = (data && data.displayname) || fallback;
            this.displayNames.set(userId, name);
            return name;
        } catch {
            this.displayNames.set(userId, fallback);
            return fallback;
        }
    }
}

module.exports = { MatrixNotifier };
