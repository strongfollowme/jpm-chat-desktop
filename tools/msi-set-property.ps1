# MSI の Property テーブルに値を書き込む（発行スクリプト tools/publish.js から呼ばれる）
# 用途: DISABLEROLLBACK=1 を埋め込み、<ドライブ>:\Config.Msi へのロールバック用ファイル作成をやめさせる。
#   利用者ごとのインストール(管理者権限なし)だと、ドライブ直下の Config.Msi に書けない環境で
#   「Could not set file security for file 'D:\Config.Msi\xxxx.rbf'. Error: 5」がインストール/アンインストール時に出るため。
param(
    [Parameter(Mandatory = $true)][string]$MsiPath,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value
)
$ErrorActionPreference = "Stop"
$installer = New-Object -ComObject WindowsInstaller.Installer
# 1 = msiOpenDatabaseModeTransact
$db = $installer.GetType().InvokeMember("OpenDatabase", "InvokeMethod", $null, $installer, @($MsiPath, 1))
# 既存の値があれば消してから入れる
foreach ($sql in @(
    "DELETE FROM Property WHERE Property = '$Name'",
    "INSERT INTO Property (Property, Value) VALUES ('$Name', '$Value')"
)) {
    $view = $db.GetType().InvokeMember("OpenView", "InvokeMethod", $null, $db, @($sql))
    $view.GetType().InvokeMember("Execute", "InvokeMethod", $null, $view, $null) | Out-Null
    $view.GetType().InvokeMember("Close", "InvokeMethod", $null, $view, $null) | Out-Null
}
$db.GetType().InvokeMember("Commit", "InvokeMethod", $null, $db, $null) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($db) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($installer) | Out-Null
Write-Output "Property 設定: $Name=$Value"
