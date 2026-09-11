/*
 * 更新案内ウィンドウ(update.html)用のプリロード。
 * 画面側には「選択を伝える」「進み具合を受け取る」の窓口だけを渡す。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jpmUpdate", {
    /** 利用者の選択: "update" | "later" | "install-now" | "install-later" */
    choose: (action) => ipcRenderer.send("jpm:update-choice", action),
    onProgress: (cb) => ipcRenderer.on("jpm:update-progress", (_e, pct) => cb(pct)),
    onDownloaded: (cb) => ipcRenderer.on("jpm:update-downloaded", () => cb()),
    onError: (cb) => ipcRenderer.on("jpm:update-error", (_e, msg) => cb(msg)),
});
