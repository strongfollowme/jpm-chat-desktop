fn main() {
    // embedded/ の中身が変わったら再ビルド（publish.js が MSI と meta.json を置く）
    println!("cargo:rerun-if-changed=embedded/JPMChat.msi");
    println!("cargo:rerun-if-changed=embedded/meta.json");
    tauri_build::build()
}
