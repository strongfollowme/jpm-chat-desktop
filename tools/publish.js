/*
 * 新版の発行: 版番号を上げ → MSI をビルド → 配信サーバーへ置き → latest.yml を書き出す。
 *
 * 使い方:  npm run release                 … jpmVersion の末尾を +1 してビルド・発行（既定）
 *          npm run release -- --set 0.2.0.1 … 版番号を明示（上位桁を変える時。利用者の指示がある時だけ）
 *          npm run release -- --no-bump     … 版番号を変えずに今の版を発行し直す
 *
 * 【版番号の規則（利用者指定）】4 桁 "A.B.C.N"。初版 0.1.0.1。発行のたびに末尾 N を +1 する
 * （0.1.0.100 の次は 0.1.0.101）。上 3 桁は利用者から指示があった時だけ変える。
 * electron-builder は 3 桁 semver しか受け付けないので、package.json の "version" には上 3 桁だけを、
 * 実際の版番号は "jpmVersion" に持つ（アプリの表示・更新判定・配信ファイル名はすべて jpmVersion）。
 *
 * 配信先: D:\jpm-updater-server\jpm-chat\   ← 26 機の docker nginx(jpm-updater, :8099) が読み取り専用で公開
 *   JPMChat-<version>.msi … electron-updater が取得する実体（latest.yml の path と一致させる）
 *   JPMChat-Setup.msi     … Web のホーム画面「インストーラをダウンロード」が指す固定名（常に最新）
 *   latest.yml            … 版番号と sha512。exe はこれと自分の版を比べて更新を案内する
 *
 * 【注意】electron-builder は msi ターゲットでは latest.yml を作らないので、ここで自前で作る。
 * sha512 は electron-updater の要求どおり base64 で記載する。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const RELEASE_DIR = path.join(ROOT, "release");
const PUBLISH_DIR = process.env.JPM_CHAT_PUBLISH_DIR || "D:\\jpm-updater-server\\jpm-chat";

const { execSync } = require("child_process");
const PKG_PATH = path.join(ROOT, "package.json");
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));

// ---- 版番号を決める ----
const args = process.argv.slice(2);
const setIdx = args.indexOf("--set");
let version;
if (setIdx >= 0) {
    version = args[setIdx + 1];
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(version || "")) {
        console.error("--set には 4 桁の版番号を指定してください（例: 0.2.0.1）");
        process.exit(1);
    }
} else if (args.includes("--no-bump")) {
    version = pkg.jpmVersion;
} else {
    const parts = String(pkg.jpmVersion || "0.1.0.0").split(".").map((n) => parseInt(n, 10) || 0);
    while (parts.length < 4) parts.push(0);
    parts[3] += 1;
    version = parts.join(".");
}
const semver = version.split(".").slice(0, 3).join(".");
pkg.jpmVersion = version;
pkg.version = semver;
pkg.build = pkg.build || {};
pkg.build.buildVersion = version;
fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n", "utf8");
console.log(`版番号: ${version} (semver ${semver})`);

// ---- ビルド ----
if (!args.includes("--no-build")) {
    console.log("MSI をビルドしています…");
    execSync("npx electron-builder --win msi --x64", {
        cwd: ROOT,
        stdio: "inherit",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
    });
}

const msi = fs
    .readdirSync(RELEASE_DIR)
    .filter((f) => f.toLowerCase().endsWith(".msi") && f.includes(semver))
    .map((f) => path.join(RELEASE_DIR, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
if (!msi) {
    console.error(`release/ に ${version} の MSI がありません。先に npm run dist を実行してください`);
    process.exit(1);
}

const data = fs.readFileSync(msi);
const sha512 = crypto.createHash("sha512").update(data).digest("base64");
const fileName = `JPMChat-${version}.msi`;

fs.mkdirSync(PUBLISH_DIR, { recursive: true });
fs.copyFileSync(msi, path.join(PUBLISH_DIR, fileName));
fs.copyFileSync(msi, path.join(PUBLISH_DIR, "JPMChat-Setup.msi"));

const yml = [
    `version: ${version}`,
    `files:`,
    `  - url: ${fileName}`,
    `    sha512: ${sha512}`,
    `    size: ${data.length}`,
    `path: ${fileName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    ``,
].join("\n");
fs.writeFileSync(path.join(PUBLISH_DIR, "latest.yml"), yml, "utf8");

console.log(`発行完了: ${version}`);
console.log(`  ${path.join(PUBLISH_DIR, fileName)} (${(data.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  ${path.join(PUBLISH_DIR, "latest.yml")}`);
