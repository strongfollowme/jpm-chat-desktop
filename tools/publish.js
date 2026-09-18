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
 * 配信先(2026-09-12 以降は 2 箇所へ発行):
 *   ① AWS  s3://superjpm-frontend/downloads/jpm-chat/  ← CloudFront 経由で
 *          https://web.airparking.in/downloads/jpm-chat/ として公開（**これが本番**）
 *   ② 社内  D:\jpm-updater-server\jpm-chat\            ← 26 機の nginx(:8099)。**移行期間のみ**
 *          既存インストール済みの端末は旧 URL しか見ないため、全端末が新版へ上がるまで残す。
 *          上がりきったら `JPM_CHAT_PUBLISH_DIR=D:\temp\jpm-chat-staging` のように
 *          配信されない場所へ向ければ社内配信は止まる（8099 も停止してよい）。
 *   ※ PUBLISH_DIR は AWS へ上げる際の**置き場（ステージング）も兼ねる**ので、無効化ではなく移動で止める。
 *   環境変数: JPM_CHAT_AWS_PUBLISH=0 で AWS 側の発行だけを止められる。
 *   JPMChat-<version>.msi … electron-updater が取得する実体（latest.yml の path と一致させる）
 *   JPMChat-Setup.msi     … MSI の固定名（常に最新）
 *   JPMChat-Setup.exe     … Web のホーム画面「インストーラをダウンロード」が指す固定名。MSI を内蔵した自前の画面のインストーラ
 *                           （installer/ の Tauri アプリ。--no-installer で省略可）
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

// ロールバック無効化(DISABLEROLLBACK=1)を MSI に埋め込む。
// 利用者ごとのインストールでは <ドライブ>:\Config.Msi に書けない環境があり、
// 「Could not set file security ... Error: 5」がインストール/アンインストール時に出るため。
// ハッシュ計算より前に行うこと（ファイルが変わる）。
execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(__dirname, "msi-set-property.ps1")}" -MsiPath "${msi}" -Name DISABLEROLLBACK -Value 1`,
    { stdio: "inherit" },
);

const data = fs.readFileSync(msi);
const sha512 = crypto.createHash("sha512").update(data).digest("base64");
const fileName = `JPMChat-${version}.msi`;

fs.mkdirSync(PUBLISH_DIR, { recursive: true });
fs.copyFileSync(msi, path.join(PUBLISH_DIR, fileName));
fs.copyFileSync(msi, path.join(PUBLISH_DIR, "JPMChat-Setup.msi"));

// ---- 自前インストーラ(JPMChat-Setup.exe) ----
// installer/ の Tauri アプリに MSI を内蔵してビルドする。Web のホームの案内モーダルはこれを指す。
// MSI の古い見た目のダイアログを出さず、すりガラス風の画面でインストール先の選択・進捗・起動まで行う。
// 自動更新は従来どおり MSI(msiexec /passive)を使うので、こちらは初回インストール用。
if (!args.includes("--no-installer")) {
    const installerDir = path.join(ROOT, "installer", "src-tauri");
    const embedded = path.join(installerDir, "embedded");
    fs.mkdirSync(embedded, { recursive: true });
    fs.copyFileSync(msi, path.join(embedded, "JPMChat.msi"));
    fs.writeFileSync(
        path.join(embedded, "meta.json"),
        JSON.stringify(
            {
                version,
                sha256: crypto.createHash("sha256").update(data).digest("hex"),
                exe_name: `${pkg.build.productName}.exe`,
            },
            null,
            2,
        ),
        "utf8",
    );
    const cargoBin = path.join(process.env.USERPROFILE || "", ".cargo", "bin");
    console.log("セットアップ exe をビルドしています…（初回は数分かかります）");
    execSync("cargo build --release", {
        cwd: installerDir,
        stdio: "inherit",
        env: { ...process.env, PATH: `${cargoBin};${process.env.PATH}`, ELECTRON_RUN_AS_NODE: "" },
    });
    const setupExe = path.join(installerDir, "target", "release", "jpm-chat-setup.exe");
    if (!fs.existsSync(setupExe)) {
        console.error("セットアップ exe が見つかりません: " + setupExe);
        process.exit(1);
    }
    fs.copyFileSync(setupExe, path.join(PUBLISH_DIR, `JPMChat-${version}-Setup.exe`));
    fs.copyFileSync(setupExe, path.join(PUBLISH_DIR, "JPMChat-Setup.exe"));
    console.log(`  ${path.join(PUBLISH_DIR, "JPMChat-Setup.exe")} (${(fs.statSync(setupExe).size / 1024 / 1024).toFixed(1)} MB)`);

    // ---- Edge 対策の zip ----
    // 署名が無いため、端末によっては Edge が .exe のダウンロードそのものを遮断する(実測)。
    // zip なら遮断されにくいので、設定の「デスクトップ版」タブは Edge にこちらを既定で出す
    // (JpmDesktopUserSettingsTab.tsx)。中身は同じ JPMChat-Setup.exe。
    //
    // 【なぜここで作るのか】2026-09-18 まで zip は手作業で上げており、
    //   発行しても zip だけ古いままになる状態だった(Edge の利用者だけ旧版を掴む)。
    //   手で作る限り必ず忘れるので、発行の一部にする。
    const zipPath = path.join(PUBLISH_DIR, "JPMChat-Setup.zip");
    if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
    execSync(
        `powershell -NoProfile -Command "Compress-Archive -Path '${path.join(PUBLISH_DIR, "JPMChat-Setup.exe")}' -DestinationPath '${zipPath}' -Force"`,
        { stdio: "inherit" },
    );
    console.log(`  ${zipPath} (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)`);
}

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

// ===========================================================================
// AWS(S3 + CloudFront)へも発行する
//
// 2026-09-12: 配信を社内 26 機から AWS へ移した。社外からも更新でき、26 機の
// 稼働に依存しなくなる。ビルド自体は 26 に残す（Windows + WiX + Rust が要るため）。
//
// 【キャッシュ指定が肝】CloudFront は S3 の Cache-Control をそのまま使う。
//   - latest.yml / JPMChat-Setup.(exe|msi) は **固定名なのに中身が変わる** →
//     no-cache にしないと、更新したのに古い版を配り続ける（rule 38 と同じ罠）。
//   - JPMChat-<version>.msi は名前に版が入る＝中身が変わらない → 長期キャッシュで良い。
//
// 【移行期間】既にインストール済みの端末は旧 URL(26)しか見ないため、両方へ発行する。
//   全端末が新版へ上がったら JPM_CHAT_PUBLISH_DIR を配信されない場所へ向けて旧側を止める。
// ===========================================================================
const S3_PREFIX = process.env.JPM_CHAT_S3_PREFIX || "s3://superjpm-frontend/downloads/jpm-chat";
const CF_DIST_ID = process.env.JPM_CHAT_CF_DIST_ID || "E2Z1TJFUF6AERL";
const NO_CACHE = "no-cache, must-revalidate";
const LONG_CACHE = "public, max-age=31536000, immutable";

if (process.env.JPM_CHAT_AWS_PUBLISH !== "0") {
    const up = (local, key, cacheControl, contentType) => {
        const ct = contentType ? ` --content-type "${contentType}"` : "";
        execSync(
            `aws s3 cp "${local}" "${S3_PREFIX}/${key}" --cache-control "${cacheControl}"${ct} --only-show-errors`,
            { stdio: "inherit" },
        );
        console.log(`  S3 ← ${key}`);
    };
    console.log("AWS へ発行しています…");
    // 版番号入りの実体を先に上げる。latest.yml はこれらが揃ってから最後に上げること
    //（先に上げると、まだ存在しないファイルを取りに行く端末が出る）。
    up(path.join(PUBLISH_DIR, fileName), fileName, LONG_CACHE, "application/x-msi");
    up(path.join(PUBLISH_DIR, "JPMChat-Setup.msi"), "JPMChat-Setup.msi", NO_CACHE, "application/x-msi");
    if (!args.includes("--no-installer")) {
        up(path.join(PUBLISH_DIR, `JPMChat-${version}-Setup.exe`), `JPMChat-${version}-Setup.exe`, LONG_CACHE, "application/vnd.microsoft.portable-executable");
        up(path.join(PUBLISH_DIR, "JPMChat-Setup.exe"), "JPMChat-Setup.exe", NO_CACHE, "application/vnd.microsoft.portable-executable");
        // 固定名で中身が変わるので no-cache(Edge 向けの導線がこれを指している)
        up(path.join(PUBLISH_DIR, "JPMChat-Setup.zip"), "JPMChat-Setup.zip", NO_CACHE, "application/zip");
    }
    // ---- 最後に latest.yml ----
    up(path.join(PUBLISH_DIR, "latest.yml"), "latest.yml", NO_CACHE, "text/yaml");

    // 固定名のものだけ CloudFront のキャッシュを消す（版番号入りは消す必要がない）
    const paths = [
        "/downloads/jpm-chat/latest.yml",
        "/downloads/jpm-chat/JPMChat-Setup.exe",
        "/downloads/jpm-chat/JPMChat-Setup.msi",
        "/downloads/jpm-chat/JPMChat-Setup.zip",
    ];
    execSync(
        `aws cloudfront create-invalidation --distribution-id ${CF_DIST_ID} --paths ${paths.join(" ")} --query "Invalidation.Id" --output text`,
        { stdio: "inherit" },
    );
    console.log(`AWS 発行完了: ${S3_PREFIX}/latest.yml`);
}
