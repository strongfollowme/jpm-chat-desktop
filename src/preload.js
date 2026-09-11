/*
 * プリロード（ログイン画面用）
 *
 * レンダラには Node の機能を一切渡さず、ログイン要求だけを通す窓口を用意する。
 * チャット本体(element-web)もこのプリロードを共有するが、element-web 側は
 * window.jpmDesktop を参照しないので影響しない。
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jpmDesktop", {
    /**
     * JPM アカウントでログインする。
     * 成功するとメインプロセスがチャット画面へ遷移させる。
     * @returns {Promise<{ok: boolean, message?: string}>}
     */
    login: (username, password) => ipcRenderer.invoke("jpm:login", { username, password }),
});

/*
 * 通知の追跡はここでは行わない。
 * contextIsolation を有効にしているため、この preload の window はページ本体とは
 * 別の世界(isolated world)であり、ここで window.Notification を差し替えても
 * element-web からは見えない。追跡はメインプロセスから executeJavaScript で
 * ページ側の世界に注入する（src/main.js の NOTIFICATION_TRACE_SCRIPT）。
 */
