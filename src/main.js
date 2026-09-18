/*
 * JPMチャット デスクトップ版 - メインプロセス
 *
 * 【このアプリの存在理由】
 * ブラウザのタブを閉じるとチャットの同期が止まり、通知が届かなくなる。
 * element-web は Web Push に対応していないため、通知を受け続けるには
 * 「常駐して同期し続けるプロセス」が要る。それがこのアプリ。
 *
 * 【方針】
 * 画面は本番の element-web(https://chat.airparking.in) をそのまま読み込む。
 * 二次開発した機能(アルバム、累積既読など)は Web 版と完全に同一のものが動く。
 * このアプリが足すのは「常駐・通知・起動導線」だけで、チャット機能には手を入れない。
 */

const { app, BrowserWindow, WebContentsView, Tray, Menu, ipcMain, shell, nativeImage, dialog, session } = require("electron");
const path = require("path");

const { CHAT_ORIGIN, PROTOCOL } = require("./config");
const { loginWithJpmAccount, exchangeLaunchCode, USER_AGENT } = require("./jpm-auth");
const { setupAutoUpdater, currentVersion } = require("./updater");
const {
    buildInjectScript,
    CHECK_SESSION_SCRIPT,
    READ_SESSION_SCRIPT,
    CLEAR_SESSION_SCRIPT,
    DIAGNOSE_NOTIFICATION_SCRIPT,
    NOTIFICATION_TRACE_SCRIPT,
    ENABLE_NOTIFICATIONS_SCRIPT,
    BLANK_PAGE_SCRIPT,
    CHAT_PAINTED_SCRIPT,
} = require("./session-inject");
const { initLogger, log, getLogPath } = require("./logger");
const { MatrixNotifier } = require("./notifier");

/*
 * 【最重要】バックグラウンドでも同期を止めないための設定。
 *
 * webPreferences.backgroundThrottling: false だけでは足りない。Chromium は
 * 「見えていないウィンドウ」のレンダラプロセス自体を低優先度にしたり凍結したりするため、
 * ウィンドウを閉じて(トレイに格納して)いる間はメッセージが届かず通知も出ない。
 * 実測: 非表示中に送ったメッセージが 38 秒経っても一切届かなかった。
 *
 * このアプリは「閉じていても通知を受け取る」ことが存在理由なので、
 * 下記3つをプロセス起動時に無効化する（app.whenReady より前に設定する必要がある）。
 */
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
// Windows 固有: ウィンドウが他の窓に隠れている/画面外にあることを検出して
// レンダラを停止させる機能。これを切らないと、上記スイッチだけでは凍結を防げない。
// (この状態だと /sync の通信自体は完了するのにページ側で処理されず、通知が出ない)
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

/** Windows の通知に表示名を出すために必要（設定しないと electron.app.* と表示される）。 */
// 【注意】この ID は package.json の build.appId と一致させること（スタートメニューの
// ショートカットに同じ ID が書かれ、Windows はそれで通知の表示名とアイコンを引く）。
// 一度 "Electron" として登録された ID は Windows 側に名前がキャッシュされて直らないため、
// 過去の開発時の ID(vc.jpm.chat.desktop)から変更している。
app.setAppUserModelId("vc.jpm.jpmchat");

let mainWindow = null;
/**
 * チャット本体を表示するビュー。
 *
 * ウィンドウに直接読み込まず、タイトルバーの高さ分だけ下にずらした領域に置く。
 * こうすると右上のウィンドウ操作ボタン(最小化/最大化/閉じる)が部屋ヘッダのボタンに
 * 重ならない。element-web のスタイルには一切手を入れない（Web 版と同じ見た目を保つ）。
 */
let chatView = null;
/**
 * ログイン画面専用の WebContentsView（チャット本体の上に重ねる）。
 *
 * 【なぜ別ビューか】チャット本体のビューを file://(login.html) → https://(チャット) と跨って
 * 遷移させると、Chromium がレンダラプロセスを入れ替えた後も古い方の入力用ウィンドウ
 * (Chrome_RenderWidgetHostHWND)が残ってマウス操作を全部吸い取り、画面は描けているのに
 * 一切クリックできない状態になった（実測。ビューの付け直し・サイズ揺らし・hide/show でも直らない）。
 * ログイン画面を別ビューにすれば、チャット本体は常に同じサイト内でしか遷移せずプロセスも変わらない。
 */
let loginView = null;
let loginShown = false;
/**
 * 上端 32px のタイトルバー用ビュー。
 * ここに「掴める領域」を持つ頁を敷かないと、ウィンドウを動かせない
 * (titleBarStyle:"hidden" はボタンを描くだけで、ドラッグ領域は作らない)。
 */
let titleBarView = null;
/** ビューの位置合わせ（createWindow で設定。ログイン画面を出す時にも呼ぶ） */
let layoutViews = () => {};
/** タイトルバーの高さ(px)。ウィンドウ操作ボタンのオーバーレイと揃える。 */
const TITLE_BAR_HEIGHT = 32;
let tray = null;
/** メインプロセス側の通知エンジン（レンダラが凍結しても通知を出し続ける役）。 */
let notifier = null;
/** トレイ常駐のため、× では終了しない。本当に終了する時だけ true にする。 */
let isQuitting = false;

// 【重要】build/ は electron-builder の buildResources 扱いで app.asar に含まれない。
// パッケージ後もアイコンを読めるよう src/assets に置く（トレイが既定の Electron アイコンになるのを防ぐ）。
const ICON_PATH = path.join(__dirname, "assets", "icon.png");
// トレイは 16px 表示。1024 から縮小すると潰れるので、小サイズ用に描いた画像を使う。
const TRAY_ICON_PATH = path.join(__dirname, "assets", "tray.png");

// ---------------------------------------------------------------------------
// 単一インスタンス制御
// ---------------------------------------------------------------------------
// 常駐アプリなので二重起動させない。二重起動しようとした場合(またはブラウザから
// jpmchat:// で呼ばれた場合)は既存ウィンドウを前面に出す。
// 開発・検証用: 本番の exe と同じ PC で同時に動かす時は保存先を分ける（単一インスタンスのロックは保存先ごと）
if (process.env.JPM_CHAT_USER_DATA) {
    app.setPath("userData", process.env.JPM_CHAT_USER_DATA);
}
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    // quit() は非同期で、その後の whenReady 等が走ってしまう（起動ログやショートカット作成が
    // 二重に出た実測あり）。ここで即座に終了する
    app.exit(0);
} else {
    app.on("second-instance", (_event, argv) => {
        log(`[protocol] 2つ目のインスタンスから引数を受信: ${argv.map((a) => a.replace(/code=[^&\s"]*/, "code=***")).join(" | ")}`);
        showMainWindow();
        // ブラウザから jpmchat://open?code=... で起動された場合（既に常駐中のときはこちらに来る）
        const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
        if (url) void handleProtocolUrl(url);
    });
}

// ---------------------------------------------------------------------------
// ウィンドウ
// ---------------------------------------------------------------------------
/** チャット本体の WebContents（ページへの操作はすべてこれ経由）。 */
function wc() {
    return chatView.webContents;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 800,
        minHeight: 600,
        show: false,
        icon: ICON_PATH,
        title: "JPMチャット",
        // タイトルバーは Windows の既定だと強調色(青)になるので、灰色のオーバーレイに置き換える。
        // ボタン(最小化/最大化/閉じる)は残る。Windows 11 以降で有効。
        titleBarStyle: "hidden",
        titleBarOverlay: { color: "#e2e8f0", symbolColor: "#1e293b", height: TITLE_BAR_HEIGHT },
        // 上部のタイトルバー領域はこの色で塗られる
        backgroundColor: "#e2e8f0",
    });

    chatView = new WebContentsView({
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            backgroundThrottling: false,
            contextIsolation: true,
            nodeIntegration: false,
            // レンダラで動くのは他社製の巨大な SPA なので、権限は最小にしておく
            sandbox: false,
            spellcheck: false,
        },
    });
    chatView.setBackgroundColor("#ffffff");
    mainWindow.contentView.addChildView(chatView);

    // 上端 32px のタイトルバー。**ウィンドウを掴んで動かすために要る**。
    //   titleBarStyle:"hidden" はボタンだけ titleBarOverlay が描いてくれるが、
    //   掴める領域(-webkit-app-region: drag)はアプリ側の頁でしか作れない。
    //   ここに何も読み込んでいなかったため、ウィンドウがまったく動かせなかった。
    //   チャット本体は y=32 から下なので、element-web には一切触らずに済む。
    titleBarView = new WebContentsView({
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
        },
    });
    titleBarView.setBackgroundColor("#e2e8f0");
    titleBarView.webContents.loadFile(path.join(__dirname, "titlebar.html"));
    mainWindow.contentView.addChildView(titleBarView);

    // ログイン画面用のビュー（必要な時だけ子ビューに加えて手前に出す）
    loginView = new WebContentsView({
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            spellcheck: false,
        },
    });
    loginView.setBackgroundColor("#ffffff");

    // チャット領域（とログイン画面）はタイトルバーの下に敷く。ウィンドウの大きさが変わったら追従させる
    layoutViews = () => {
        const [w, h] = mainWindow.getContentSize();
        const bounds = { x: 0, y: TITLE_BAR_HEIGHT, width: w, height: Math.max(0, h - TITLE_BAR_HEIGHT) };
        chatView.setBounds(bounds);
        if (loginView) loginView.setBounds(bounds);
        // タイトルバーは上端いっぱい。幅が変わっても掴める場所が途切れないようにする
        if (titleBarView) titleBarView.setBounds({ x: 0, y: 0, width: w, height: TITLE_BAR_HEIGHT });
    };
    layoutViews();
    mainWindow.on("resize", layoutViews);
    mainWindow.on("maximize", layoutViews);
    mainWindow.on("unmaximize", layoutViews);

    mainWindow.setMenuBarVisibility(false);

    // 利用者が戻ってきたら点滅を止め、未読の仮カウントをリセットする
    // （以降の正確な未読数はページのタイトルから反映される）
    mainWindow.on("focus", () => {
        mainWindow.flashFrame(false);
        pendingNotifications = 0;
    });

    // × では終了せずトレイへ格納する（常駐して通知を受け続けるため）
    mainWindow.on("close", (e) => {
        if (!isQuitting) {
            e.preventDefault();
            hideToTray();
        }
    });

    // 【注意】ready-to-show はウィンドウ自身の webContents の事象で、内容を chatView に
    // 移した今は発火しない。chatView の最初の読み込み完了で表示する。
    // 何かで読み込みが止まっても真っ暗のままにならないよう、時間切れでも表示する。
    let shown = false;
    const showOnce = () => {
        if (shown || !mainWindow || mainWindow.isDestroyed()) return;
        shown = true;
        if (process.argv.includes("--hidden")) {
            // 自動起動時: フォーカスを奪わず一瞬だけ出し、同期が始まってから格納する
            mainWindow.showInactive();
            setTimeout(() => hideToTray(), 20000);
        } else {
            mainWindow.show();
        }
    };
    chatView.webContents.once("did-finish-load", showOnce);
    setTimeout(showOnce, 4000);

    // --- 遷移の制限（安全）: チャット以外のオリジンをアプリ内で開かない ---
    wc().on("will-navigate", (event, url) => {
        if (isAllowedUrl(url)) return;
        event.preventDefault();
        const internal = toInternalUrl(url);
        if (internal) {
            showMainWindow();
            safeLoad(() => wc().loadURL(internal));
            return;
        }
        shell.openExternal(url);
    });
    wc().setWindowOpenHandler(({ url }) => {
        // 通知をクリックした時などに matrix.to のリンクが開かれる。これを外部ブラウザに出すと
        // 「通知を押したのに知らないサイトが開く」状態になるので、アプリ内で該当の部屋へ移動する。
        const internal = toInternalUrl(url);
        if (internal) {
            showMainWindow();
            safeLoad(() => wc().loadURL(internal));
            return { action: "deny" };
        }
        // それ以外の外部リンクは既定のブラウザで開く（アプリ内に別ウィンドウを作らない）
        if (url.startsWith("http://") || url.startsWith("https://")) {
            shell.openExternal(url);
        }
        return { action: "deny" };
    });

    // element-web が自前のログイン画面(Matrix のユーザー名/パスワード)へ遷移したら、
    // JPM アカウントで入れる自前のログイン画面に差し替える。
    //   ・Matrix 側のパスワードはシステムが自動生成した値で利用者は知らない
    //   ・OIDC 経由(「JPM Systemで続行」)でも入れるが、画面を何枚も跨ぐ必要がある
    // セッション失効で追い出された時もここを通るので、常に JPM アカウントで復帰できる。
    wc().on("did-navigate-in-page", (_e, url) => guardLoginPage(url));
    wc().on("did-navigate", (_e, url) => guardLoginPage(url));

    // タイトルの未読件数をタスクバーに反映する。
    // element-web はタイトルを "[3] JPMチャット" のように更新するので、それを拾う。
    // element-web のタイトルは "JPMチャット [3] | 部屋名" のように未読数が途中に入るため、
    // 先頭固定ではなく文字列中の [数字] を拾う。
    wc().on("page-title-updated", (_e, title) => {
        mainWindow.setTitle(title || "JPMチャット");
        const m = title.match(/\[(\d+)\]/);
        const count = m ? parseInt(m[1], 10) : 0;
        updateBadge(count);
        if (count > 0) {
            log(`[未読] ${count} 件 (ウィンドウ:${isWindowHidden() ? "非表示" : "表示中"})`);
        }
    });

    // ページ側に注入した通知トレースの出力を拾う（原因切り分け用）。
    // Electron 44 で引数形式が変わったため、新旧どちらでも動くようにしておく。
    wc().on("console-message", (eventOrLevel, _level, messageArg) => {
        const message =
            eventOrLevel && typeof eventOrLevel === "object" && typeof eventOrLevel.message === "string"
                ? eventOrLevel.message
                : messageArg;
        if (typeof message === "string" && message.startsWith("[JPM-NOTIFY] ")) {
            const state = isWindowHidden() ? "非表示" : "表示中";
            log(`[通知] 発火 (ウィンドウ:${state}): ${message.slice("[JPM-NOTIFY] ".length)}`);
        }
    });

    // チャット本体を読み込むたびにトレースを入れ直す（ページ遷移で消えるため）
    wc().on("did-finish-load", async () => {
        const url = wc().getURL();
        if (!url.startsWith(CHAT_ORIGIN)) return;
        // ログイン直後のセッション注入中は何もしない。注入のための一時読み込みに反応して
        // 通知設定の書き換え→reload を走らせると、注入と再読み込みが同時に進んで画面が固まった（実測）
        if (sessionInjecting) return;
        // 画面が持っている Matrix セッションを通知エンジンへ渡す。
        // ウィンドウが見えている今のうちに読んでおけば、以降は凍結されても通知を出せる。
        try {
            const cred = await wc().executeJavaScript(READ_SESSION_SCRIPT, true);
            log(`[通知エンジン] セッション読み出し: token=${cred && cred.token ? "あり" : "なし"} userId=${cred ? cred.userId : "null"} engine=${notifier ? "あり" : "なし"}`);
            if (cred && cred.token && notifier) notifier.start(cred.token, cred.userId);
        } catch (e) {
            log("[通知エンジン] セッションの読み出しに失敗:", e.message);
        }
        try {
            await wc().executeJavaScript(NOTIFICATION_TRACE_SCRIPT, true);
            // 未設定なら「デスクトップ通知」を有効にする（このアプリは通知のために常駐するため）。
            // 利用者が明示的にオフにしている場合は上書きしない。
            const enabled = await wc().executeJavaScript(ENABLE_NOTIFICATIONS_SCRIPT, true);
            if (enabled) {
                // 【重要】ここで reload してはいけない。element-web が初期化中(IndexedDB/暗号ストアの作成)に
                // 再読み込みすると次の読み込みが固まった（ログアウト→再ログインのたびに再現）。
                // 通常はログイン時にセッションと一緒に書き込むので、ここに来るのは古いセッションだけ。
                // 次回起動から反映されればよい（通知そのものはメインプロセスの通知エンジンが出す）
                log("[通知設定] デスクトップ通知を既定で有効にしました（次回の読み込みから反映）");
            }
            const diag = await wc().executeJavaScript(DIAGNOSE_NOTIFICATION_SCRIPT, true);
            log(
                `[通知診断] 権限=${diag.permission} / デスクトップ通知=${diag.notificationsEnabled} ` +
                    `/ 本文表示=${diag.notificationBodyEnabled} / 音=${diag.audioNotificationsEnabled}`,
            );
        } catch (e) {
            log("[通知診断] 取得失敗:", e.message);
        }
    });

    return mainWindow;
}

/**
 * loadURL のラッパー。
 *
 * element-web は読み込み直後に自分でハッシュルート(#/home 等)へ遷移するため、
 * Electron の loadURL は ERR_ABORTED(-3) で reject することがある。
 * これは失敗ではなく「ページ側が先に遷移した」だけなので握りつぶす。
 * 握りつぶさないと後続の処理(セッション確認・注入)が丸ごと実行されなくなる。
 */
async function safeLoad(loader) {
    try {
        await loader();
    } catch (e) {
        const msg = String(e && e.message);
        if (msg.includes("ERR_ABORTED")) return;
        throw e;
    }
    // ページ側スクリプトが動き出すまで待つ（DOM 構築完了を待機）
    if (wc().isLoading()) {
        await new Promise((resolve) => wc().once("did-stop-loading", resolve));
    }
}

/**
 * チャットのオリジンか。
 * URL でもオリジン文字列でも受け付ける（末尾スラッシュの有無に影響されないようにするため）。
 */
function isChatOrigin(urlOrOrigin) {
    try {
        return new URL(urlOrOrigin).origin === CHAT_ORIGIN;
    } catch {
        return false;
    }
}

/**
 * matrix.to のリンクをアプリ内の URL に変換する。変換できなければ null。
 *
 * 通知のクリックや本文中のリンクから https://matrix.to/#/!room:server/$event という形で
 * 飛ばされることがある。これは Matrix 共通の「どのクライアントで開くか選ばせる」中継ページで、
 * 社内利用では意味が無いうえ、外部ブラウザが開いてしまい混乱するため自前で解決する。
 */
function toInternalUrl(url) {
    const m = /^https:\/\/matrix\.to\/#\/(.+)$/.exec(url);
    if (!m) return null;
    const target = decodeURIComponent(m[1]);
    // 先頭記号で行き先が決まる: ! と # は部屋、@ は利用者
    if (target.startsWith("@")) return `${CHAT_ORIGIN}/#/user/${target}`;
    if (target.startsWith("!") || target.startsWith("#")) return `${CHAT_ORIGIN}/#/room/${target}`;
    return null;
}

/** アプリ内で開いてよい URL か（チャット本体とローカルのログイン画面のみ）。 */
function isAllowedUrl(url) {
    if (url.startsWith("file://")) return true;
    return isChatOrigin(url);
}


/**
 * ウィンドウを「トレイに格納」する。
 *
 * 通知はメインプロセス側の通知エンジン(notifier.js)が出すため、
 * ここでは素直に hide() してよい（レンダラが凍結しても通知は途切れない）。
 */
function hideToTray() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.hide();
    log("[ウィンドウ] トレイへ格納");
}

/**
 * 利用者がこのウィンドウを見ていないか（通知を出すかの判断に使う）。
 * 非表示・最小化だけでなく「表示はされているがフォーカスが無い」も含める。
 * 別のアプリで作業中に届いたメッセージも通知するため（LINE と同じ挙動）。
 */
function isWindowHidden() {
    if (!mainWindow || mainWindow.isDestroyed()) return true;
    return !mainWindow.isVisible() || mainWindow.isMinimized() || !mainWindow.isFocused();
}

/**
 * jpmchat:// で渡された URL を処理する。
 *   jpmchat://open              … ウィンドウを前面に出すだけ
 *   jpmchat://open?code=XXXX    … ワンタイムコードを Matrix セッションに引き換えてログインする
 * 既にログイン済みでもコードが付いていれば、そのアカウントで入り直す（Web 側の利用者に合わせる）。
 */
async function handleProtocolUrl(url) {
    let code = null;
    try {
        code = new URL(url).searchParams.get("code");
    } catch {
        // 解析できない URL は無視
    }
    log(`[protocol] 受信: code=${code ? "あり" : "なし"}`);
    showMainWindow();
    if (!code) return;
    try {
        const session = await exchangeLaunchCode(code);
        await applySessionAndOpenChat(session);
        log("[protocol] ワンタイムコードでログインしました");
    } catch (e) {
        log("[protocol] コードの引き換えに失敗:", e.message);
        // 失敗しても既存セッションがあればそのまま使える。無ければログイン画面が出る
        dialog.showMessageBox(mainWindow, {
            type: "warning",
            message: "Web からの自動ログインに失敗しました",
            detail: `${e.message}\n\nJPM アカウントでログインし直してください。`,
            buttons: ["OK"],
        });
    }
}

function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    // 開いたついでに更新を確認する（30 分に 1 回まで）
    if (updater) updater.checkOnShow();
}

/** 自動更新の操作口（setupAutoUpdater の戻り値）。トレイの「更新を確認」と窓を開いた時の確認に使う */
let updater = null;

/** 直前の未読件数（増えた時だけタスクバーを点滅させるため）。 */
let lastUnreadCount = 0;

/** 利用者が見ていない間に届いた通知の数（フォーカスが戻ったらリセット）。 */
let pendingNotifications = 0;

/**
 * 新着を利用者に気付かせる（LINE と同じ見え方）。
 *   ・タスクバーのボタンを点滅させる（Windows の FlashWindow）
 *   ・トレイに格納中なら、最小化状態でタスクバーへ戻してから点滅させる
 *     （タスクバーに無いと点滅する場所が無いため。フォーカスは奪わない）
 *   ・アイコンに未読バッジを重ねる
 */
function attractAttention() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    pendingNotifications++;
    if (!mainWindow.isVisible()) {
        // 【順序が重要】showInactive() の後に minimize() する。逆だと showInactive が
        // 最小化を解除してウィンドウが画面に出てきてしまう（利用者が閉じたのに勝手に開く）。
        mainWindow.setSkipTaskbar(false);
        mainWindow.showInactive();
        mainWindow.minimize();
    }
    // 前面で操作中に点滅させるのは煩わしいだけなので、その時は光らせない。
    //   (窓が開いていても別のアプリを触っている間は点滅させる = LINE と同じ)
    if (!mainWindow.isFocused()) {
        mainWindow.flashFrame(true);
    }
    updateBadge(pendingNotifications);
}

/**
 * 未読件数をタスクバー・トレイに反映する。
 *
 * LINE と同じ見え方にするため、次の3つを行う:
 *   1. タスクバーアイコンに赤いバッジ（件数）を重ねる
 *   2. 未読が増えた瞬間にタスクバーを点滅させる（Windows 標準の注意喚起）
 *   3. トレイアイコンも未読ありの絵に差し替える
 */
function updateBadge(count) {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    if (process.platform === "win32") {
        if (count > 0) {
            const label = count > 99 ? "99+" : String(count);
            mainWindow.setOverlayIcon(createBadgeIcon(label), `未読 ${label} 件`);
        } else {
            mainWindow.setOverlayIcon(null, "");
        }
    } else {
        app.setBadgeCount(count);
    }

    // 未読が増えた時だけ点滅させる（同じ件数のまま再描画された時は鳴らさない）
    if (count > lastUnreadCount && !mainWindow.isFocused()) {
        mainWindow.flashFrame(true);
    } else if (count === 0) {
        mainWindow.flashFrame(false);
    }
    lastUnreadCount = count;

    updateTrayIcon(count);
}

/** トレイアイコンを未読状態に合わせて差し替える。 */
function updateTrayIcon(count) {
    if (!tray) return;
    tray.setToolTip(count > 0 ? `JPMチャット（未読 ${count} 件）` : "JPMチャット");
    const base = nativeImage.createFromPath(TRAY_ICON_PATH);
    if (base.isEmpty()) return;
    tray.setImage(base.resize({ width: 16, height: 16 }));
}

/** 未読バッジ画像をその場で描く（外部画像を持たずに済ませる）。 */
function createBadgeIcon(label) {
    const size = 32;
    const fontSize = label.length >= 3 ? 13 : 18;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
        <circle cx="16" cy="16" r="15" fill="#d32f2f"/>
        <text x="16" y="16" font-family="Segoe UI, sans-serif" font-size="${fontSize}"
              font-weight="bold" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${label}</text>
    </svg>`;
    return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
}

// ---------------------------------------------------------------------------
// トレイ
// ---------------------------------------------------------------------------
/**
 * デスクトップのショートカットは MSI ではなくアプリ自身が作る。
 *
 * 【理由】MSI にショートカットを持たせると、作成/削除のたびに Windows Installer が既存の .lnk を
 * <そのドライブ>:\Config.Msi へ改名して回滚用に退避する。デスクトップが D: 等のデータドライブにある PC では
 * 利用者に Modify 権限しか無く（権限の変更＝WRITE_DAC が無い）、退避ファイルの権限変更に失敗して
 * 「Error 1926」が卸载のたびに出た（実測）。DISABLEROLLBACK でも止まらない。
 * 卸载時は MSI のカスタムアクションが普通の del で消す（build/msi-project.js）。
 * 利用者が自分で消したショートカットは、同じ版の間は作り直さない。
 */
function ensureDesktopShortcut() {
    if (!app.isPackaged || process.platform !== "win32") return;
    const fs = require("fs");
    try {
        const lnk = path.join(app.getPath("desktop"), `${app.name}.lnk`);
        const marker = path.join(app.getPath("userData"), "desktop-shortcut.json");
        const version = require("../package.json").jpmVersion || app.getVersion();
        if (fs.existsSync(lnk)) return;
        let made = null;
        try { made = JSON.parse(fs.readFileSync(marker, "utf8")).version; } catch (_) { /* 未作成 */ }
        if (made === version) return;
        const ok = shell.writeShortcutLink(lnk, "create", {
            target: process.execPath,
            cwd: path.dirname(process.execPath),
            icon: process.execPath,
            iconIndex: 0,
            appUserModelId: "vc.jpm.jpmchat",
            description: app.name,
        });
        fs.writeFileSync(marker, JSON.stringify({ version, created: new Date().toISOString() }), "utf8");
        log(`[起動] デスクトップショートカット作成 ${ok ? "成功" : "失敗"}: ${lnk}`);
    } catch (e) {
        log(`[起動] デスクトップショートカット作成に失敗: ${e.message}`);
    }
}

function createTray() {
    const icon = nativeImage.createFromPath(TRAY_ICON_PATH);
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
    tray.setToolTip(`JPMチャット ${currentVersion()}`);
    tray.setContextMenu(
        Menu.buildFromTemplate([
            { label: `JPMチャットを開く（v${currentVersion()}）`, click: showMainWindow },
            {
                label: `更新を確認（現在 v${currentVersion()}）`,
                click: () => {
                    if (updater) void updater.checkManually();
                },
            },
            { type: "separator" },
            {
                label: "Windows起動時に自動で開始する",
                type: "checkbox",
                checked: app.getLoginItemSettings().openAtLogin,
                click: (item) => {
                    // 常駐しないと通知が来ないので、自動起動を既定の使い方にしたい
                    app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--hidden"] });
                },
            },
            {
                label: "ログアウト",
                click: async () => {
                    const { response } = await dialog.showMessageBox(mainWindow, {
                        type: "question",
                        buttons: ["ログアウト", "キャンセル"],
                        defaultId: 1,
                        cancelId: 1,
                        message: "ログアウトしますか？",
                        detail: "次回起動時に再度 JPM アカウントでのログインが必要になります。",
                    });
                    if (response === 0) await logout();
                },
            },
            {
                // 「通知が来ない」等の調査用。利用者にこのファイルを送ってもらう
                label: "ログを開く",
                click: () => {
                    const p = getLogPath();
                    if (p) shell.showItemInFolder(p);
                },
            },
            { type: "separator" },
            {
                label: "終了",
                click: () => {
                    isQuitting = true;
                    app.quit();
                },
            },
        ]),
    );
    tray.on("double-click", showMainWindow);
}

// ---------------------------------------------------------------------------
// 画面遷移（ログイン画面 ⇔ チャット本体）
// ---------------------------------------------------------------------------

/** ローカルのログイン画面を表示する。 */
async function showLoginPage() {
    if (!loginView || !mainWindow || mainWindow.isDestroyed()) return;
    if (loginShown) return;
    loginShown = true;
    // 毎回読み直す（前回の入力を残さない。file:// 同士なのでプロセスは変わらない）
    try {
        await loginView.webContents.loadFile(path.join(__dirname, "login.html"));
    } catch (e) {
        log(`[ログイン] ログイン画面の読み込みに失敗: ${e.message}`);
    }
    if (!mainWindow.contentView.children.includes(loginView)) mainWindow.contentView.addChildView(loginView);
    layoutViews();
    loginView.setVisible(true);
    loginView.webContents.focus();
}

/** ログイン画面を下げる（チャット本体が見える） */
function hideLoginPage() {
    if (!loginView || !loginShown) return;
    loginShown = false;
    loginView.setVisible(false);
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.contentView.children.includes(loginView)) {
        mainWindow.contentView.removeChildView(loginView);
    }
    wc().focus();
}

/** 差し替え処理の再入防止（loadFile 自体が did-navigate を発火させるため）。 */
let redirectingToLogin = false;
/** ログイン成功後のセッション注入中か。注入のための一時読み込みに他の処理が反応しないようにする。 */
let sessionInjecting = false;

/**
 * element-web のログイン/ウェルカム画面に着いたら、自前のログイン画面へ差し替える。
 * @param {string} url 遷移先 URL
 */
async function guardLoginPage(url) {
    if (redirectingToLogin || sessionInjecting) return;
    if (!url.startsWith(CHAT_ORIGIN)) return;

    const hash = url.split("#")[1] || "";
    if (!(hash.startsWith("/login") || hash.startsWith("/welcome") || hash.startsWith("/forgot_password"))) {
        return;
    }
    redirectingToLogin = true;
    try {
        log("[ログイン] element-web のログイン画面を検出したため JPM ログイン画面へ差し替えます");
        await showLoginPage();
    } finally {
        redirectingToLogin = false;
    }
}

/**
 * チャット本体を開く。セッションが無ければログイン画面へ回す。
 * @param {boolean} allowLoginFallback セッション未確立時にログイン画面を出すか
 */
async function openChat(allowLoginFallback = true) {
    await safeLoad(() => wc().loadURL(CHAT_ORIGIN + "/"));
    const hasSession = await wc().executeJavaScript(CHECK_SESSION_SCRIPT, true);
    log(`[起動] 既存セッション: ${hasSession ? "あり" : "なし"}`);
    if (!hasSession && allowLoginFallback) {
        await showLoginPage();
    }
}

/**
 * ログイン成功後: チャットのオリジンでセッションを注入してから本体を開く。
 * トークンを URL に載せないため、オリジン上でスクリプトを実行する方式にしている。
 */
async function applySessionAndOpenChat(session) {
    sessionInjecting = true;
    try {
        // 前のセッションの保存データ(IndexedDB の同期/暗号ストア等)を先に消す。
        // localStorage だけ消して IndexedDB を残すと、新しいセッションと古いストアが食い違って
        // element-web の起動が固まった（ログアウト→再ログインのたびに再現）
        await clearChatStorage();
        // 注入スクリプトを走らせるために、チャットと同じオリジンの「素のページ」(/config.json: JSON が文字で表示されるだけで JS 無し。/version は octet-stream で下載扱いになる)を読む。
        // "/" を読むと、直前が "/#/login" 等の時にハッシュ違いの同一文書扱いになって element が動いたまま
        // localStorage を書き換えることになり、真っ白な画面になった（実測）。/config.json → /#/home は本当の遷移になる。
        // （同じサイト内なのでレンダラプロセスは変わらない＝入力が効かなくなる問題は起きない）
        await safeLoad(() => wc().loadURL(CHAT_ORIGIN + "/config.json?_=" + Date.now()));
        // JSON の文字を消しておく（#/home へ遷移した直後、element の初回描画までこの画面が保持されて見えるため）
        await wc().executeJavaScript(BLANK_PAGE_SCRIPT, true);
        await wc().executeJavaScript(buildInjectScript(session), true);
        // 「デスクトップ通知」もここで有効にしておく（起動後に書き換えて reload しなくて済む）
        await wc().executeJavaScript(ENABLE_NOTIFICATIONS_SCRIPT, true);
        log("[ログイン] Matrix セッションを注入しました");
    } finally {
        sessionInjecting = false;
    }
    if (notifier) notifier.start(session.accessToken, session.userId);
    // 注入した認証情報で element-web を初期化し直す（同じサイト内の遷移なのでプロセスは変わらない）
    await safeLoad(() => wc().loadURL(CHAT_ORIGIN + "/#/home"));
    // element が最初の画面を描くまでログイン画面を手前に残す（真っ白や前の画面が一瞬見えないように）
    await waitForChatPainted();
    hideLoginPage();
}

/**
 * element-web が #matrixchat に最初の描画をするまで待つ（最長 5 秒。超えたら諦めて進む）。
 * 読み込み完了(did-stop-loading)の時点では JS が動き出しただけで画面は空のため、これを待たずに
 * ログイン画面を下げると、前の画面(注入用の /config.json)の保持画像や真っ白が一瞬見える。
 */
async function waitForChatPainted() {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
        try {
            if (await wc().executeJavaScript(CHAT_PAINTED_SCRIPT, true)) {
                log(`[ログイン] チャット画面の初回描画を確認 (${Date.now() - t0}ms)`);
                return;
            }
        } catch {
            // 遷移中は評価に失敗することがある。少し待って再試行
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    log("[ログイン] チャット画面の初回描画を 5 秒待っても確認できないため、そのまま進めます");
}

/**
 * チャットのオリジンに溜まった保存データ(localStorage / IndexedDB / Cache / ServiceWorker)を消す。
 * ログアウト時と、別のセッションを注入する直前に使う。
 * element-web 自身のログアウトはこれらを消すが、こちらのログアウトは localStorage しか消しておらず、
 * 残った IndexedDB(同期/暗号ストア)が次のセッションと食い違って画面が固まっていた。
 */
async function clearChatStorage() {
    try {
        await session.defaultSession.clearStorageData({
            origin: CHAT_ORIGIN,
            storages: ["localstorage", "indexdb", "cachestorage", "serviceworkers", "websql"],
        });
        log("[セッション] チャットの保存データを消去しました");
    } catch (e) {
        log(`[セッション] 保存データの消去に失敗: ${e.message}`);
    }
}

// ---------------------------------------------------------------------------
// チャット画面(element-web)の更新検知
// ---------------------------------------------------------------------------
/**
 * サーバー側の element-web が入れ替わったら知らせる。
 * exe は画面を読み込んだまま常駐するので、サーバーを更新しても自動では新しくならない
 * （利用者が「更新したのに変わらない」となった）。/version(no-cache) を定期的に見て、
 * 変わっていたら HTTP キャッシュを消して読み込み直す。窓が隠れている時は黙って、見えている時は聞いてから。
 */
let loadedChatVersion = null;
let chatVersionAskedFor = null;

async function fetchChatVersion() {
    const resp = await fetch(`${CHAT_ORIGIN}/version?t=${Date.now()}`, {
        headers: { "User-Agent": USER_AGENT, "Cache-Control": "no-cache" },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return (await resp.text()).trim();
}

async function reloadChatForNewVersion(version) {
    try {
        await session.defaultSession.clearCache();
    } catch (e) {
        log(`[画面更新] キャッシュの消去に失敗: ${e.message}`);
    }
    loadedChatVersion = version;
    chatVersionAskedFor = null;
    log(`[画面更新] キャッシュを消して読み込み直します (${version})`);
    wc().reload();
}

function startChatVersionWatcher() {
    const INTERVAL_MS = 5 * 60 * 1000;
    const check = async () => {
        try {
            const v = await fetchChatVersion();
            if (!loadedChatVersion) {
                loadedChatVersion = v;
                return;
            }
            if (v === loadedChatVersion) return;
            // ログイン画面等を出している時は、次にチャットを読む時に自然と新しくなる
            if (!wc().getURL().startsWith(CHAT_ORIGIN)) {
                loadedChatVersion = v;
                return;
            }
            log(`[画面更新] チャット画面の新しい版を検出: ${loadedChatVersion} → ${v}`);
            if (isWindowHidden()) {
                await reloadChatForNewVersion(v);
                return;
            }
            if (chatVersionAskedFor === v) return; // 「後で」と言われた版は、窓が隠れた時に黙って読み直す
            chatVersionAskedFor = v;
            const { response } = await dialog.showMessageBox(mainWindow, {
                type: "info",
                buttons: ["今すぐ再読み込み", "後で"],
                defaultId: 0,
                cancelId: 1,
                title: "JPMチャット",
                message: "チャット画面が更新されました",
                detail: "新しい画面に切り替えるために読み込み直します。入力途中の文章は下書きとして残ります。",
            });
            if (response === 0) await reloadChatForNewVersion(v);
        } catch (e) {
            log(`[画面更新] 版の確認に失敗: ${e.message}`);
        }
    };
    setTimeout(check, 30 * 1000);
    setInterval(check, INTERVAL_MS);
}

/**
 * exe の版が変わった最初の起動で HTTP キャッシュを消す。
 * 更新後に古い画像(ロゴ等)が残って見えるのを防ぐ。
 */
async function clearCacheIfAppUpdated() {
    const fs = require("fs");
    const marker = path.join(app.getPath("userData"), "last-app-version.txt");
    const current = (() => {
        try {
            return require("../package.json").jpmVersion || app.getVersion();
        } catch (_) {
            return app.getVersion();
        }
    })();
    let last = null;
    try {
        last = fs.readFileSync(marker, "utf8").trim();
    } catch (_) {
        // 初回
    }
    if (last === current) return;
    try {
        await session.defaultSession.clearCache();
        log(`[起動] 版が変わったため HTTP キャッシュを消去しました (${last || "初回"} → ${current})`);
    } catch (e) {
        log(`[起動] キャッシュの消去に失敗: ${e.message}`);
    }
    try {
        fs.writeFileSync(marker, current, "utf8");
    } catch (_) {
        // 書けなくても次回また消すだけ
    }
}

async function logout() {
    try {
        if (new URL(wc().getURL()).origin === CHAT_ORIGIN) {
            await wc().executeJavaScript(CLEAR_SESSION_SCRIPT, true);
        }
    } catch {
        // URL が file:// 等でも問題ない。続けてログイン画面へ移る
    }
    if (notifier) notifier.stop();
    updateBadge(0);
    // 先にログイン画面を手前に出してから消す。チャット本体は同じサイト内で読み直して
    // 未ログイン状態にしておく（file:// 等へ飛ばすとプロセスが入れ替わり入力が効かなくなる）
    await showLoginPage();
    await clearChatStorage();
    // element を動かしたままにせず、同じオリジンの素のページへ退避させておく（次のログインで本当の遷移になる）
    await safeLoad(() => wc().loadURL(CHAT_ORIGIN + "/config.json?_=" + Date.now()));
    // 退避先の JSON の文字も消しておく（ログイン画面の裏側とはいえ表示しない）
    try {
        await wc().executeJavaScript(BLANK_PAGE_SCRIPT, true);
    } catch {
        // 消せなくても支障はない（次のログインで読み直す）
    }
    showMainWindow();
}

// ---------------------------------------------------------------------------
// IPC（ログイン画面 → メインプロセス）
// ---------------------------------------------------------------------------
// 通知が発火したことの記録（preload から送られる。原因切り分け用）
ipcMain.on("jpm:notification-fired", (_event, title) => {
    const state = mainWindow && isWindowHidden() ? "非表示" : "表示中";
    log(`[通知] 発火 (ウィンドウ:${state}): ${title}`);
});

ipcMain.handle("jpm:login", async (_event, { username, password }) => {
    if (!username || !password) {
        return { ok: false, message: "ユーザー名とパスワードを入力してください" };
    }
    try {
        const session = await loginWithJpmAccount(username, password);
        await applySessionAndOpenChat(session);
        return { ok: true };
    } catch (e) {
        // サーバーからの日本語メッセージ（ロック残り回数など）をそのまま返す
        return { ok: false, message: e.message || "ログインに失敗しました" };
    }
});

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
/**
 * 権限要求の扱い。
 *
 * チャットの機能を Web 版と同一にするため、element-web が使う権限は許可する
 * （通知が拒否されると本アプリの存在意義が無くなる。通話・画面共有も Web 版で使える）。
 * それ以外（センサー・MIDI 等）のチャットに不要なものは既定で拒否する。
 */
function configurePermissions() {
    const ALLOWED = new Set([
        "notifications",
        "media", // マイク・カメラ（通話）
        "display-capture", // 画面共有
        "clipboard-read",
        "clipboard-sanitized-write",
        "fullscreen",
        "background-sync",
        "geolocation", // 位置情報の共有（現場から送る用途がある。Web 版と同じく利用者が操作した時だけ要求される）
    ]);

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        // チャット本体からの要求だけを対象にする
        callback(isChatOrigin(webContents.getURL()) && ALLOWED.has(permission));
    });

    // 同期的に問い合わせられる経路（Notification.permission の参照など）も同じ基準で答える。
    // 【注意】requestingOrigin は "https://chat.airparking.in/" のように末尾スラッシュ付きで
    // 渡ってくることがあるため、文字列の完全一致で比べてはいけない（比較に失敗すると
    // 通知権限が denied になり、通知が一切出なくなる）。
    session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
        return isChatOrigin(requestingOrigin) && ALLOWED.has(permission);
    });
}

/**
 * Matrix の同期通信を監視する。
 *
 * 「通知が来ない」時に、同期そのものが止まっているのか、同期はできているが
 * 通知が出ていないのかを切り分けるための計測。1分に1回だけ要約を出す。
 */
function watchSyncRequests() {
    let ok = 0;
    let ng = 0;
    let seen = 0;
    let lastReport = Date.now();

    // URL パターンは広めに取り、コールバック側で /sync を選別する
    // （細かいパターンだと一致せず、計測そのものが空振りする）
    const filter = { urls: [`${CHAT_ORIGIN}/*`] };

    session.defaultSession.webRequest.onCompleted(filter, (details) => {
        if (!details.url.includes("/sync")) return;
        if (details.statusCode >= 200 && details.statusCode < 300) ok++;
        else {
            ng++;
            log(`[同期] 応答 ${details.statusCode}`);
        }
        // 最初の数回は毎回出す（起動直後に同期できているかを確認するため）
        if (++seen <= 5) {
            log(`[同期] ${seen}回目 status=${details.statusCode} (ウィンドウ:${isWindowHidden() ? "非表示" : "表示中"})`);
        }
        const now = Date.now();
        if (now - lastReport >= 60000) {
            log(`[同期] 直近1分: 成功${ok}件 / 失敗${ng}件 (ウィンドウ:${isWindowHidden() ? "非表示" : "表示中"})`);
            ok = 0;
            ng = 0;
            lastReport = now;
        }
    });

    session.defaultSession.webRequest.onErrorOccurred(filter, (details) => {
        if (!details.url.includes("/sync")) return;
        if (String(details.error).includes("ABORTED")) return; // タイムアウト打ち切りは正常
        log(`[同期] エラー: ${details.error}`);
    });
}

app.whenReady().then(async () => {
    initLogger();
    watchSyncRequests();

    notifier = new MatrixNotifier({
        iconPath: ICON_PATH,
        isWindowHidden: () => isWindowHidden(),
        // 「今まさに見ている部屋」だけ通知を出さないための判定。
        //   element-web は開いている部屋を URL のハッシュ(#/room/<id>)に出すので、
        //   相手側に手を入れずにここから読み取れる。
        //   前面に出ていない時は「見ている」とは言えないので常に通知する。
        isViewingRoom: (roomId) => {
            try {
                if (!mainWindow || mainWindow.isDestroyed()) return false;
                if (!mainWindow.isVisible() || mainWindow.isMinimized() || !mainWindow.isFocused()) return false;
                return decodeURIComponent(wc().getURL() || "").includes(`/room/${roomId}`);
            } catch (e) {
                return false; // 判定できない時は通知する側に倒す(取りこぼしの方が困る)
            }
        },
        onNotified: () => attractAttention(),
        onOpenRoom: (roomId) => {
            // 通知をクリックしたらウィンドウを出して該当の部屋を開く
            showMainWindow();
            safeLoad(() => wc().loadURL(`${CHAT_ORIGIN}/#/room/${roomId}`));
        },
    });
    configurePermissions();
    await clearCacheIfAppUpdated();
    const _fs = require("fs");
    log(`[起動] アイコン=${_fs.existsSync(ICON_PATH)} トレイ画像=${_fs.existsSync(TRAY_ICON_PATH)}`);

    // ブラウザの「アプリ」アイコンから起動できるようにプロトコルを登録する
    if (process.defaultApp) {
        // 開発時(electron . 実行)はインタプリタとスクリプトパスを渡す必要がある
        if (process.argv.length >= 2) {
            app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
        }
    } else {
        app.setAsDefaultProtocolClient(PROTOCOL);
    }

    createWindow();
    createTray();
    ensureDesktopShortcut();
    startChatVersionWatcher();

    // 開発・検証用: 外部スクリプトに画面操作を任せる（ログアウト→再ログインの自動テスト等。本番では未設定）
    if (process.env.JPM_CHAT_DEBUG_SCRIPT) {
        try {
            require(process.env.JPM_CHAT_DEBUG_SCRIPT)({
                app,
                getWebContents: () => wc(),
                getLoginWebContents: () => (loginShown && loginView ? loginView.webContents : null),
                log,
                CHAT_ORIGIN,
                logout,
            });
        } catch (e) {
            log(`[debug] スクリプトの読み込みに失敗: ${e.message}`);
        }
    }

    // チャット側から見える UA を、反クローラフィルタが許可する形に揃える
    wc().setUserAgent(USER_AGENT);

    // 自動起動時(--hidden)はトレイだけで待機する。
    //
    // 【重要】いきなり hide してはいけない。一度も表示していないウィンドウは
    // Chromium が描画パイプラインを起動せず、element-web の同期が始まらないため、
    // メッセージも通知も一切届かなくなる（実測で確認済み）。
    // フォーカスを奪わない showInactive() で一瞬だけ出し、同期が始まってから隠す。
    // --hidden の扱いは createWindow 内の showOnce に集約した

    await openChat();

    // exe が起動していない状態でブラウザから jpmchat:// を踏むと、URL は起動引数で渡ってくる
    const launchUrl = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (launchUrl) void handleProtocolUrl(launchUrl);

    // ページ側のセッションを定期的に読み直し、通知エンジンが止まっていれば新しいトークンで再開する
    // （同じ端末IDで別の場所からログインし直すと旧トークンが失効して通知エンジンだけ止まるため）
    setInterval(async () => {
        try {
            if (!notifier || !wc() || wc().isDestroyed()) return;
            if (!wc().getURL().startsWith(CHAT_ORIGIN)) return;
            const cred = await wc().executeJavaScript(READ_SESSION_SCRIPT, true);
            if (cred && cred.token) notifier.start(cred.token, cred.userId);
        } catch {
            // ページが読み込み中などで取れない時は次回に回す
        }
    }, 60 * 1000);

    // 自動更新: 起動直後に確認し、その後は定期的に確認する
    updater = setupAutoUpdater({
        getWindow: () => mainWindow,
        log,
        // 更新適用のための終了。× の「トレイへ格納」を無効にしてから終了する
        quitForUpdate: () => {
            isQuitting = true;
            app.quit();
        },
    });
});

// 常駐アプリなので、全ウィンドウが閉じてもプロセスは終了させない
app.on("window-all-closed", (e) => {
    e.preventDefault();
});

app.on("before-quit", () => {
    isQuitting = true;
});
