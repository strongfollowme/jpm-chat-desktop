/*
 * JPMチャット デスクトップ版 - 接続先の設定
 *
 * 本番(45サーバー)の chat ドメインだけを見る。nginx が同一ドメインで
 *   /            → element-web (chat-element-web)
 *   /_matrix/    → Synapse
 *   /api/        → JPMWebService(8080)
 * を振り分けているため、ベースURLは1つで足りる。
 */

/** チャット(element-web)と各APIの基点。ここ以外のオリジンへはアプリ内で遷移させない。 */
const CHAT_ORIGIN = "https://chat.airparking.in";

/** Matrix ホームサーバー。element-web の localStorage(mx_hs_url) に書き込む値。 */
const HOMESERVER_URL = "https://chat.airparking.in";

/**
 * JPMWebService の API 基点（nginx が /api/ を 8080 へ反向プロキシしている）。
 * 開発機での動作確認用に環境変数 JPM_CHAT_API_BASE で差し替えられる
 * （例: http://localhost:8080）。通常の利用者環境では設定されないので本番の値になる。
 */
const JPM_API_BASE = process.env.JPM_CHAT_API_BASE || "https://chat.airparking.in";

/** カスタムプロトコル。ブラウザの「アプリ」アイコンから本アプリを起動するために使う。 */
const PROTOCOL = "jpmchat";

/**
 * 自動更新の配信元（latest.yml と MSI の置き場所・末尾スラッシュ付き）。
 * 【注意】package.json の build.publish.url と同じ値にすること。electron-builder はパッケージ時に
 * package.json から build セクションを削除するため、実行時はこちらの定数を使う。
 *
 * 2026-09-12: 社内 26 機(http://192.168.26.26:8099/)から **AWS(S3 + CloudFront)** へ移行。
 *   - 社外からも更新できるようになる（従来は社内ネットワークからのみ）
 *   - 26 機の稼働に依存しなくなる
 *   ※ 置き場所は業務フロントと同じバケット/分発の `downloads/` 配下。専用ドメインも証明書も要らない。
 *
 * 【重要・切替の順序】「新しい配信元を知っている」のは**新しい exe だけ**。
 *   既にインストール済みの端末は旧 URL(26)しか見に行かないため、
 *   ① この変更を入れた版を **まず 26 の旧 URL へも発行**し、
 *   ② 全端末がその版へ更新されたことを確認してから、
 *   ③ 26 の 8099 を停止する。
 *   publish.js は移行期間中この両方へ発行する（JPM_CHAT_LEGACY_PUBLISH=0 で旧側を止められる）。
 */
const UPDATE_FEED_URL = "https://web.airparking.in/downloads/jpm-chat/";

module.exports = { CHAT_ORIGIN, HOMESERVER_URL, JPM_API_BASE, PROTOCOL, UPDATE_FEED_URL };
