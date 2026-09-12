/*
 * Matrix セッションを element-web に注入するスクリプトを組み立てる。
 *
 * 【なぜ auto-login.html を開かずに自前で注入するのか】
 * Web 版は /auto-login.html?token=... という URL でセッションを渡しているが、
 * その方式だとアクセストークンがクエリ文字列に載り、nginx のアクセスログや
 * プロキシの記録に残ってしまう。デスクトップ版はレンダラプロセスに直接
 * スクリプトを流し込めるので、トークンをネットワーク上に一切出さずに済む。
 *
 * 【処理内容は auto-login.html と同一にすること】
 * element-web 側の初期化手順(IndexedDB の上書き → 旧DBの削除 → localStorage 設定)は
 * Web 版と揃える。ずれると「Web では入れるがデスクトップでは入れない」状態になる。
 * 参照元: frontend/jpm-element-web/apps/web/auto-login.html
 */

/**
 * @param {{accessToken: string, userId: string, deviceId?: string, homeserverUrl: string}} session
 * @returns {string} レンダラで評価するスクリプト（Promise を返す）
 */
function buildInjectScript(session) {
    // JSON.stringify で埋め込む(生の文字列連結だとクォート混入でスクリプトが壊れる)
    const payload = JSON.stringify({
        token: session.accessToken,
        userId: session.userId,
        deviceId: session.deviceId || "",
        hsUrl: session.homeserverUrl,
    });

    return `
(function () {
    var p = ${payload};

    function setLocalStorage() {
        // 旧セッションの残骸を消してから新しいセッションを書き込む
        var keysToRemove = [];
        for (var i = 0; i < localStorage.length; i++) {
            var key = localStorage.key(i);
            if (key && (key.indexOf('mx_') === 0 || key.indexOf('matrix-js-sdk') === 0 || key.indexOf('element') === 0)) {
                keysToRemove.push(key);
            }
        }
        keysToRemove.forEach(function (k) { localStorage.removeItem(k); });

        localStorage.setItem('mx_hs_url', p.hsUrl);
        localStorage.setItem('mx_user_id', p.userId);
        localStorage.setItem('mx_access_token', p.token);
        localStorage.setItem('mx_has_access_token', 'true');
        if (p.deviceId) { localStorage.setItem('mx_device_id', p.deviceId); }
    }

    // ステップ1: matrix-react-sdk のトークンを直接上書きする
    // (deleteDatabase は他タブが開いていると blocked になるため open+put で対処)
    function overwriteTokenInIDB() {
        return new Promise(function (resolve) {
            try {
                var dbReq = indexedDB.open('matrix-react-sdk', 1);
                dbReq.onupgradeneeded = function (e) {
                    var db = e.target.result;
                    if (!db.objectStoreNames.contains('pickleKey')) { db.createObjectStore('pickleKey'); }
                    if (!db.objectStoreNames.contains('account')) { db.createObjectStore('account'); }
                };
                dbReq.onsuccess = function (e) {
                    var db = e.target.result;
                    try {
                        var tx = db.transaction(['account', 'pickleKey'], 'readwrite');
                        tx.objectStore('account').put(p.token, 'mx_access_token');
                        tx.objectStore('account').delete('mx_refresh_token');
                        tx.objectStore('pickleKey').clear();
                        tx.oncomplete = function () { db.close(); resolve(); };
                        tx.onerror = function () { db.close(); resolve(); };
                    } catch (ex) {
                        try { db.close(); } catch (ignored) {}
                        resolve();
                    }
                };
                dbReq.onerror = function () { resolve(); };
            } catch (ex) { resolve(); }
        });
    }

    // ステップ2: matrix-react-sdk 以外の全DB(crypto, sync等)を削除する
    // 旧セッションの暗号化データが新セッションと不一致になるため必須
    function deleteOtherDatabases() {
        return new Promise(function (resolve) {
            if (!window.indexedDB || !window.indexedDB.databases) { resolve(); return; }
            window.indexedDB.databases().then(function (dbs) {
                var toDelete = [];
                dbs.forEach(function (db) {
                    if (db.name === 'matrix-react-sdk') return;
                    if (db.name && (
                        db.name.indexOf('matrix') >= 0 ||
                        db.name.indexOf('riot') >= 0 ||
                        db.name.indexOf('element') >= 0 ||
                        db.name.indexOf('idb://') >= 0 ||
                        db.name === 'account'
                    )) { toDelete.push(db.name); }
                });
                if (toDelete.length === 0) { resolve(); return; }
                var count = 0;
                toDelete.forEach(function (name) {
                    var req = window.indexedDB.deleteDatabase(name);
                    req.onsuccess = req.onerror = req.onblocked = function () {
                        count++;
                        if (count === toDelete.length) { resolve(); }
                    };
                });
            }).catch(function () { resolve(); });
        });
    }

    return overwriteTokenInIDB()
        .then(deleteOtherDatabases)
        .then(function () { setLocalStorage(); return true; })
        .catch(function () { setLocalStorage(); return true; });
})();
`;
}

/**
 * 既存セッションの有無を調べるスクリプト。
 * element-web が使う localStorage のキーをそのまま見る。
 */
const CHECK_SESSION_SCRIPT = `
(function () {
    try {
        return !!(localStorage.getItem('mx_access_token') && localStorage.getItem('mx_user_id'));
    } catch (e) { return false; }
})();
`;

/**
 * 画面が保持している Matrix のセッションを読み出すスクリプト。
 * メインプロセスの通知エンジンが同じ資格情報で同期するために使う。
 */
const READ_SESSION_SCRIPT = `
(function () {
    try {
        return {
            token: localStorage.getItem('mx_access_token'),
            userId: localStorage.getItem('mx_user_id')
        };
    } catch (e) { return null; }
})();
`;

/** ログアウト時にセッションを消すスクリプト。 */
const CLEAR_SESSION_SCRIPT = `
(function () {
    try {
        var keys = [];
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && (k.indexOf('mx_') === 0 || k.indexOf('matrix-js-sdk') === 0 || k.indexOf('element') === 0)) { keys.push(k); }
        }
        keys.forEach(function (k) { localStorage.removeItem(k); });
        localStorage.removeItem('jpm_access_token');
        localStorage.removeItem('jpm_refresh_token');
        localStorage.removeItem('jpm_api_base');
    } catch (e) {}
    return true;
})();
`;

/**
 * 通知まわりの状態を調べるスクリプト。
 * 「通知が来ない」時に、権限の問題なのか element-web の設定の問題なのかを切り分ける。
 */
const DIAGNOSE_NOTIFICATION_SCRIPT = `
(function () {
    var s = {};
    try { s = JSON.parse(localStorage.getItem('mx_local_settings') || '{}'); } catch (e) {}
    return {
        permission: (window.Notification && window.Notification.permission) || '(Notification API なし)',
        notificationsEnabled: s.notificationsEnabled,
        notificationBodyEnabled: s.notificationBodyEnabled,
        audioNotificationsEnabled: s.audioNotificationsEnabled
    };
})();
`;

/**
 * ページ側の世界で Notification をラップし、発火を console 経由でメインプロセスへ知らせる。
 *
 * preload(isolated world)では element-web の window に触れないため、
 * executeJavaScript でページ本体の世界に注入する必要がある。
 */
const NOTIFICATION_TRACE_SCRIPT = `
(function () {
    if (!window.Notification || window.__jpmNotifyTraced) return false;
    var Original = window.Notification;

    // 通知の表示はメインプロセスの通知エンジンが一元的に行う。ここでは記録だけ残し、
    // 実際のポップアップは出さない（出すと同じメッセージが二重に通知される）。
    function Traced(title, options) {
        try { console.log('[JPM-NOTIFY] ' + String(title || '')); } catch (e) {}
        var stub = { close: function () {}, onclick: null, onclose: null, onerror: null, onshow: null,
                     addEventListener: function () {}, removeEventListener: function () {} };
        return stub;
    }
    Traced.prototype = Original.prototype;
    Object.defineProperty(Traced, 'permission', { get: function () { return Original.permission; } });
    Traced.requestPermission = function () { return Original.requestPermission.apply(Original, arguments); };

    window.Notification = Traced;
    window.__jpmNotifyTraced = true;
    return true;
})();
`;

/**
 * デスクトップ通知を既定で有効にするスクリプト。
 *
 * element-web の「デスクトップ通知」はデバイス単位の設定(localStorage の mx_local_settings)で、
 * 既定値は false。ブラウザで有効にしていても、このアプリは別デバイス扱いなので引き継がれない。
 * 通知を受け取るために常駐するアプリで通知が既定オフでは本末転倒なので、初回ログイン時に有効化する。
 * （利用者が後から設定画面でオフにした場合は、その選択を上書きしない）
 */
const ENABLE_NOTIFICATIONS_SCRIPT = `
(function () {
    var s = {};
    try { s = JSON.parse(localStorage.getItem('mx_local_settings') || '{}'); } catch (e) {}
    var changed = false;
    if (s.notificationsEnabled === undefined) { s.notificationsEnabled = true; changed = true; }
    if (s.notificationBodyEnabled === undefined) { s.notificationBodyEnabled = true; changed = true; }
    if (changed) {
        try { localStorage.setItem('mx_local_settings', JSON.stringify(s)); } catch (e) { return false; }
    }
    return changed;
})();
`;


/**
 * デスクトップ版のウィンドウ枠に合わせた調整 CSS。
 *
 * タイトルバーを消して灰色のオーバーレイに置き換えているため、次の2点が必要になる:
 *   1. 右上のウィンドウ操作ボタン(最小化/最大化/閉じる)が部屋ヘッダのボタンに被る
 *      → ヘッダ右側に余白を作って逃がす
 *   2. タイトルバーが無いのでウィンドウを掴んで動かせない
 *      → ヘッダの余白部分をドラッグ領域にする（ボタン類は除外する）
 */
const DESKTOP_CHROME_CSS = `
/* 1) 右上のウィンドウ操作ボタン(約138px)と重ならないようにする */
.mx_RoomHeader {
    padding-right: 150px !important;
}
/* 2) ヘッダの空き部分でウィンドウを移動できるようにする */
.mx_RoomHeader,
.mx_RoomHeader .mx_RoomHeader_infoWrapper {
    -webkit-app-region: drag;
}
/* ただし操作できる要素はドラッグ対象から外す（クリックできなくなるため） */
.mx_RoomHeader button,
.mx_RoomHeader a,
.mx_RoomHeader input,
.mx_RoomHeader [role="button"],
.mx_RoomHeader [tabindex],
.mx_RoomHeader .mx_BaseAvatar,
.mx_RoomHeader .mx_FacePile {
    -webkit-app-region: no-drag;
}
`;


/**
 * ページに「今は見えていない」と認識させるスクリプト。
 *
 * 【なぜ必要か】
 * トレイ格納は hide() ではなく画面外への退避で実現している。hide() すると
 * Chromium がレンダラを凍結して同期が止まるためだが、その代わりページからは
 * visibilityState が "visible" のままに見える。element-web は可視状態だと
 * 「利用者が見ている」と判断して通知を出さないので、通知が一切鳴らなくなる。
 * (実測: hasFocus=false / visibilityState=visible の状態では通知が出なかった)
 *
 * そこで visibilityState だけを上書きして hidden と答えさせる。
 * Chromium 内部の状態は変わらないので同期は継続したまま、通知だけが出るようになる。
 */
const MARK_PAGE_HIDDEN_SCRIPT = `
(function () {
    try {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return 'hidden'; } });
        Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return true; } });
        document.dispatchEvent(new Event('visibilitychange'));
        return true;
    } catch (e) { return false; }
})();
`;

/** 上書きを解除して本来の可視状態に戻すスクリプト。 */
const MARK_PAGE_VISIBLE_SCRIPT = `
(function () {
    try {
        delete document.visibilityState;
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
        return true;
    } catch (e) { return false; }
})();
`;

/**
 * セッション注入の踏み台に使う /config.json の画面を空にする。
 * /config.json は JSON がそのまま文字で表示されるページで、ログイン画面の裏で読んでいるが、
 * 次の #/home へ遷移した直後に element が最初の描画をするまで Chromium が前の画面(=JSON の文字)を
 * 保持して見せるため、一瞬 JSON が見えていた。中身は誰でも取れる公開設定だが、見えるべきものではない。
 */
const BLANK_PAGE_SCRIPT = `
(function () {
    try {
        document.title = "";
        document.body.innerHTML = "";
        document.body.style.background = "#fff";
        return true;
    } catch (e) { return false; }
})();
`;

/** element-web が最初の画面を描いたか（#matrixchat の中に React が何か描いたか）。 */
const CHAT_PAINTED_SCRIPT = `
(function () {
    try {
        var root = document.getElementById("matrixchat");
        return !!(root && root.childElementCount > 0);
    } catch (e) { return false; }
})();
`;

module.exports = {
    buildInjectScript,
    CHECK_SESSION_SCRIPT,
    READ_SESSION_SCRIPT,
    CLEAR_SESSION_SCRIPT,
    DIAGNOSE_NOTIFICATION_SCRIPT,
    NOTIFICATION_TRACE_SCRIPT,
    ENABLE_NOTIFICATIONS_SCRIPT,
    BLANK_PAGE_SCRIPT,
    CHAT_PAINTED_SCRIPT,
    DESKTOP_CHROME_CSS,
    MARK_PAGE_HIDDEN_SCRIPT,
    MARK_PAGE_VISIBLE_SCRIPT,
};
