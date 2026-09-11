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
    const lnk = `${pkg.build.productName}.lnk`;
    const protocol = require("../src/config").PROTOCOL;

    // MSI が入れるファイルの一覧（release/win-unpacked の直下）。卸载/更新時に MSI が消す前に
    // 普通の del で消しておくための正確な名前のリスト。ワイルドカードは使わない
    // （利用者がインストール先に D:\ 直下などを選んでいても、他のファイルを巻き込まないため）。
    const unpackedDir = require("path").join(__dirname, "..", "release", "win-unpacked");
    const entries = fs.readdirSync(unpackedDir, { withFileTypes: true });
    const wipeFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
    const wipeDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (!wipeFiles.includes(exe) || wipeDirs.length === 0) {
        throw new Error(`msi-project.js: ${unpackedDir} の内容が想定と違います（${exe} が無い、またはサブフォルダ無し）`);
    }
    const xmlQ = (v) => `&quot;${v}&quot;`;
    const wipeFileList = wipeFiles.map(xmlQ).join(" ");
    const wipeDirList = wipeDirs.map(xmlQ).join(" ");

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
        // インストール先を覚えておき、次回（手動での上書き/更新）も同じ場所に入れる
        `        <RegistryKey Root="HKCU" Key="Software\\JPM\\JPMChat" ForceDeleteOnUninstall="yes">`,
        `          <RegistryValue Type="string" Name="InstallDir" Value="[APPLICATIONFOLDER]"/>`,
        `        </RegistryKey>`,
        `      </Component>`,
        `    </ComponentGroup>`,
    ].join("\n");

    let xml = fs.readFileSync(projectFile, "utf8");

    // 「インストール範囲(自分のみ / 全ユーザー)」の選択画面を飛ばし、代わりにインストール先の選択画面を出す。
    // 本製品は利用者ごとのインストール固定(perMachine=false)なので範囲を選ばせる意味が無く、
    // しかも ja-jp の標準文言がこの画面で重なって崩れて見える。Welcome → インストール先 → 確認 → 実行 にする。
    const replaceOnce = (from, to) => {
        if (!xml.includes(from)) throw new Error(`msi-project.js: 雛形に見つかりません（electron-builder の雛形が変わった？）: ${from}`);
        xml = xml.replace(from, to);
    };
    replaceOnce('<Publish Dialog="WelcomeDlg" Control="Next" Event="NewDialog" Value="InstallScopeDlg" Order="2">NOT Installed</Publish>',
                '<Publish Dialog="WelcomeDlg" Control="Next" Event="NewDialog" Value="InstallDirDlg" Order="2">NOT Installed</Publish>');
    replaceOnce('<Publish Dialog="InstallDirDlg" Control="Back" Event="NewDialog" Value="InstallScopeDlg" Order="2">1</Publish>',
                '<Publish Dialog="InstallDirDlg" Control="Back" Event="NewDialog" Value="WelcomeDlg" Order="2">1</Publish>');
    // 「確認 → 戻る → インストール先」は WixUI_InstallDir が既に持っているので、雛形が足した範囲画面行きを消すだけ
    replaceOnce('<Publish Dialog="VerifyReadyDlg" Control="Back" Event="NewDialog" Value="InstallScopeDlg" Order="2">NOT Installed</Publish>', '');

    // デスクトップのショートカットは MSI に持たせない（package.json の createDesktopShortcut=false）。
    // 【理由】MSI が .lnk を作成/削除すると Windows Installer は既存の .lnk を <そのドライブ>:\Config.Msi へ
    // 改名して回滚用に退避する。デスクトップが D: 等のデータドライブにある PC では利用者に Modify 権限しか無く
    // （権限の変更＝WRITE_DAC が無い）、退避ファイルの権限変更に失敗して「Error 1926」が卸载のたびに出た（実測）。
    // DISABLEROLLBACK でも止まらない。作成はアプリ起動時(src/main.js ensureDesktopShortcut)、
    // 削除はここで普通の del を実行する（普通の削除は退避しない）。
    replaceOnce('<Directory Id="ProgramMenuFolder"/>',
                '<Directory Id="DesktopFolder" Name="Desktop"/>\n      <Directory Id="ProgramMenuFolder"/>');
    replaceOnce('    <Directory Id="TARGETDIR" Name="SourceDir">', [
        `    <!-- 前回のインストール先を復元する（手動での上書き・更新でも同じ場所に入れる） -->`,
        `    <Property Id="APPLICATIONFOLDER">`,
        `      <RegistrySearch Id="JpmChatInstallDirSearch" Root="HKCU" Key="Software\\JPM\\JPMChat" Name="InstallDir" Type="raw"/>`,
        `    </Property>`,
        `    <!-- 起動中のアプリを先に終了させる。動かしたまま上書き/削除すると、古いプロセスが消えたファイルを抱えて`,
        `         残り続け、新しい exe を起動しても単一インスタンスの転送先が古い方になって固まる（実測） -->`,
        `    <CustomAction Id="JpmChatCloseApp" Directory="TARGETDIR" ExeCommand="cmd.exe /c taskkill /IM &quot;${exe}&quot; /F /T" Execute="immediate" Return="ignore"/>`,
        `    <!-- 卸载・更新で MSI がファイルを消す前に、普通の del で消しておく。`,
        `         Windows Installer は消すファイルを <ドライブ>:\\Config.Msi へ改名して回滚退避するが、D: 等のデータ`,
        `         ドライブでは利用者に権限変更(WRITE_DAC)が無く Error 1926 になる。先に消しておけば MSI は`,
        `         「ファイル無し」として通過し退避しない。更新時は新しい MSI 側がこれを行うので、古い版の卸载も通る。`,
        `         名前は MSI が入れたものだけ（ワイルドカード無し）。resources\\app.asar が無ければ何もしない -->`,
        `    <Property Id="JPMCHAT_WIPE_FILES" Value="${wipeFileList}"/>`,
        `    <Property Id="JPMCHAT_WIPE_DIRS" Value="${wipeDirList}"/>`,
        `    <CustomAction Id="JpmChatWipeFiles" Directory="APPLICATIONFOLDER" ExeCommand="cmd.exe /c if exist &quot;resources\\app.asar&quot; (del /q /f [JPMCHAT_WIPE_FILES] &amp; rmdir /s /q [JPMCHAT_WIPE_DIRS])" Execute="immediate" Return="ignore"/>`,
        `    <!-- 卸载時にデスクトップのショートカットを普通の削除で消す（回滚退避を発生させない） -->`,
        `    <CustomAction Id="JpmChatRemoveDesktopLnk" Directory="DesktopFolder" ExeCommand="cmd.exe /c del /q /f &quot;[DesktopFolder]${lnk}&quot;" Execute="deferred" Impersonate="yes" Return="ignore"/>`,
        `    <InstallExecuteSequence>`,
        `      <Custom Action="JpmChatCloseApp" Before="InstallValidate">1</Custom>`,
        `      <Custom Action="JpmChatWipeFiles" Before="RemoveExistingProducts">REMOVE~="ALL" OR WIX_UPGRADE_DETECTED</Custom>`,
        `      <Custom Action="JpmChatRemoveDesktopLnk" After="InstallInitialize">REMOVE~="ALL" AND NOT UPGRADINGPRODUCTCODE</Custom>`,
        `    </InstallExecuteSequence>`,
        ``,
        `    <Directory Id="TARGETDIR" Name="SourceDir">`,
    ].join("\n"));

    const marker = "    </ComponentGroup>";
    const idx = xml.lastIndexOf(marker);
    if (idx < 0) {
        throw new Error("msi-project.js: project.wxs に </ComponentGroup> が見つかりません（electron-builder の雛形が変わった？）");
    }
    xml = xml.slice(0, idx) + fragment + xml.slice(idx + marker.length);
    fs.writeFileSync(projectFile, xml, "utf8");
    // 生成物の確認用に控えを残す（release/ は git 管理外）
    try { fs.writeFileSync(require("path").join(__dirname, "..", "release", "last-project.wxs"), xml, "utf8"); } catch (_) { /* 無くても困らない */ }
    console.log(`  • msi-project.js: ${protocol}:// のレジストリ登録を MSI に追加（アンインストールで削除）、範囲選択→インストール先選択、デスクトップ .lnk は del で削除`);
};
