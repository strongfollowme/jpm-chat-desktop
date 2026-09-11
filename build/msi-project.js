/*
 * electron-builder の msiProjectCreated フック（package.json の build.msiProjectCreated から呼ばれる）。
 *
 * 目的: jpmchat:// プロトコルの登録を MSI 自身に持たせ、アンインストール時に確実に消す。
 *
 * 【経緯】exe 起動時の app.setAsDefaultProtocolClient() で書かれる HKCU\Software\Classes\jpmchat は
 * MSI の管理外なので、アンインストールしても残る。すると Web のホームで「チャット」を押した時に
 * ブラウザが「jpmchat を開きますか？」と聞くのに exe は無く何も起きず、しかも Web 側は
 * 「起動できた」と誤判定してインストール案内が出なかった（実際に発生）。
 * ForceDeleteOnUninstall で鍵ごと削除させる。
 */
const fs = require("fs");

// 部品 GUID は固定（変えると別部品扱いになり、上書き更新時に古い鍵が残る）
const COMPONENT_GUID = "7A2C9E6B-5D41-4F8B-9C3E-2B6F1D0A8E57";

exports.default = async function (projectFile) {
    const pkg = require("../package.json");
    const exe = `${pkg.build.productName}.exe`;
    const protocol = require("../src/config").PROTOCOL;

    const fragment = [
        `      <Component Id="JpmChatProtocolReg" Guid="{${COMPONENT_GUID}}" Directory="APPLICATIONFOLDER">`,
        `        <RegistryKey Root="HKCU" Key="Software\\Classes\\${protocol}" ForceDeleteOnUninstall="yes">`,
        `          <RegistryValue Type="string" Value="URL:${protocol}" KeyPath="yes"/>`,
        // "URL Protocol" は空の値が規約（この WiX 版では Value 属性の省略不可なので明示する）
        `          <RegistryValue Type="string" Name="URL Protocol" Value=""/>`,
        `          <RegistryKey Key="DefaultIcon">`,
        `            <RegistryValue Type="string" Value="&quot;[APPLICATIONFOLDER]${exe}&quot;,0"/>`,
        `          </RegistryKey>`,
        `          <RegistryKey Key="shell\\open\\command">`,
        `            <RegistryValue Type="string" Value="&quot;[APPLICATIONFOLDER]${exe}&quot; &quot;%1&quot;"/>`,
        `          </RegistryKey>`,
        `        </RegistryKey>`,
        `      </Component>`,
        `    </ComponentGroup>`,
    ].join("\n");

    let xml = fs.readFileSync(projectFile, "utf8");

    // 「インストール範囲(自分のみ / 全ユーザー)」の選択画面を飛ばす。
    // 本製品は利用者ごとのインストール固定(perMachine=false)なので選ばせる意味が無く、
    // しかも ja-jp の標準文言がこの画面で重なって崩れて見える。Welcome → 確認 → 実行 にする。
    const scopeNext = 'Event="NewDialog" Value="InstallScopeDlg" Order="2">NOT Installed</Publish>';
    const scopeBack = '<Publish Dialog="VerifyReadyDlg" Control="Back" Event="NewDialog" Value="InstallScopeDlg" Order="2">NOT Installed</Publish>';
    if (!xml.includes(scopeNext) || !xml.includes(scopeBack)) {
        throw new Error("msi-project.js: InstallScopeDlg の遷移が見つかりません（electron-builder の雛形が変わった？）");
    }
    xml = xml.replace(scopeNext, 'Event="NewDialog" Value="VerifyReadyDlg" Order="2">NOT Installed</Publish>');
    xml = xml.replace(scopeBack, '<Publish Dialog="VerifyReadyDlg" Control="Back" Event="NewDialog" Value="WelcomeDlg" Order="2">NOT Installed</Publish>');

    const marker = "    </ComponentGroup>";
    const idx = xml.lastIndexOf(marker);
    if (idx < 0) {
        throw new Error("msi-project.js: project.wxs に </ComponentGroup> が見つかりません（electron-builder の雛形が変わった？）");
    }
    xml = xml.slice(0, idx) + fragment + xml.slice(idx + marker.length);
    fs.writeFileSync(projectFile, xml, "utf8");
    console.log(`  • msi-project.js: ${protocol}:// のレジストリ登録を MSI に追加（アンインストールで削除）、範囲選択画面を省略`);
};
