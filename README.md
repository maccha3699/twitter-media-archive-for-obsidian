# X Media Archive Suite

本リポジトリのREADMEとコードは、すべてOpenAI GPT-5.6によるバイブコーディングで作成されました。

All README documentation and code in this repository were created through vibe coding with OpenAI GPT-5.6.

Chrome拡張 **X Media Clone** とObsidianプラグイン **X Media Archive Companion** のセットです。2つを一組で使用します。

This suite combines the **X Media Clone** Chrome extension with the **X Media Archive Companion** Obsidian plugin. The two components are designed to be used together.

Windows、Chrome 111以降、Obsidian Desktop 1.5以降向けのPublic previewです。

Public preview for Windows, Chrome 111 or later, and Obsidian Desktop 1.5 or later.

## 日本語

### インストール

#### ZIP

1. [Releases](../../releases)から`x-media-clone-0.2.2.zip`と`x-media-archive-companion-0.1.0.zip`を取得し、両方を展開します。
2. Chromeで`chrome://extensions`を開き、デベロッパーモードを有効にします。「パッケージ化されていない拡張機能を読み込む」から`x-media-clone`を選びます。
3. `x-media-archive-companion`を`<Vault>/.obsidian/plugins/`へ置きます。
4. Obsidianを再起動し、設定のコミュニティプラグインから`X Media Archive Companion`を有効にします。

#### Gitで導入・更新

```powershell
git clone https://github.com/maccha3699/x-media-archive-suite.git
git -C C:\path\to\x-media-archive-suite pull --ff-only
```

Chromeにはclone先の`x-media-clone`を直接読み込ませます。Companionも`git pull`だけで更新したい場合は、Obsidianを閉じ、リンク先がまだ存在しない新規導入時に限りWindowsのジャンクションを作ります。

```powershell
New-Item -ItemType Junction `
  -Path "C:\path\to\Vault\.obsidian\plugins\x-media-archive-companion" `
  -Target "C:\path\to\x-media-archive-suite\x-media-archive-companion"
```

更新後は`chrome://extensions`で拡張機能を再読み込みし、開いているXタブも再読み込みします。Obsidianも再起動します。

### 使い方

1. Xの投稿に表示される保存ボタンで1件保存します。一括保存は対象プロフィールの`/media`ページで「一括DL」→「開始」です。
2. Obsidianで、ギャラリー上部のダウンロードアイコン、またはコマンドパレットの`Import pending jobs`を実行します。
3. ビューアーはObsidian左リボンの画像アイコン、または`Open archive gallery`コマンドから開きます。
4. 投稿者カードを選ぶと投稿一覧が開きます。ヘッダーの検索から全保存ノートを検索できます。
5. 投稿または投稿者の削除はカードの右クリックから行います。削除後に再取得するときは一括DLの「保存済みも再取得する」を有効にします。
6. 未処理jobが残った場合は`Reconcile pending jobs`を実行します。

既定のjob inboxは`~/Downloads/XMediaClone/_jobs`、Vault内の保存先は`XMediaArchive`です。Vaultが恒久データの正本です。自動バックアップとクラウド同期は行いません。

### 困ったとき・既知の制限

- 保存ボタンが出ない場合は、`chrome://extensions`で拡張機能を再読み込みしてからXタブも再読み込みします。
- 取込結果が見えない場合は`Import pending jobs`、続けて`Reconcile pending jobs`を実行します。診断ログは`XMediaArchive/_system/diagnostic.log`です。
- 引用元ポストのメディアは自動保存されません。必要な場合は引用元ポストも別に保存します。
- 拡張機能やプラグインを削除しても、既存の`XMediaArchive`は自動削除されません。

### 権限とデータ

XMCは`downloads`、`storage`、`unlimitedStorage`とX/Twitter上のhost権限を使用します。CompanionはX、FxTwitter、oEmbed等へ通信せず、XのCookieやトークンも読みません。認証情報はjobへ保存しません。

### Issue・Pull Request

不具合報告とPull Requestを受け付けます。変更前に[`CONTRIBUTING.md`](CONTRIBUTING.md)を確認してください。実データ、認証情報、実画像をIssue、fixture、ログへ含めないでください。

## English

### Installation

#### ZIP

1. Download and extract both `x-media-clone-0.2.2.zip` and `x-media-archive-companion-0.1.0.zip` from [Releases](../../releases).
2. Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose the extracted `x-media-clone` folder.
3. Place `x-media-archive-companion` under `<Vault>/.obsidian/plugins/`.
4. Restart Obsidian and enable `X Media Archive Companion` under Community plugins.

#### Install and update with Git

```powershell
git clone https://github.com/maccha3699/x-media-archive-suite.git
git -C C:\path\to\x-media-archive-suite pull --ff-only
```

Load `x-media-clone` directly from the cloned repository. To update the Companion with the same `git pull`, close Obsidian and create a Windows directory junction on a fresh installation where the destination does not already exist.

```powershell
New-Item -ItemType Junction `
  -Path "C:\path\to\Vault\.obsidian\plugins\x-media-archive-companion" `
  -Target "C:\path\to\x-media-archive-suite\x-media-archive-companion"
```

After an update, reload the extension from `chrome://extensions`, reload open X tabs, and restart Obsidian.

### Usage

1. Save one post with the save button added to posts on X. For bulk saving, open the target profile's `/media` page and choose **一括DL** → **開始**.
2. In Obsidian, select the download icon in the gallery header or run `Import pending jobs` from the Command Palette.
3. Open the viewer from the image icon in Obsidian's left ribbon or run `Open archive gallery`.
4. Select an author card to open its posts. Use the search button in the header to search all saved notes.
5. Right-click a post or author card to delete it. To download deleted content again, enable **保存済みも再取得する** in the bulk-download dialog.
6. Run `Reconcile pending jobs` if an unfinished job remains.

The default job inbox is `~/Downloads/XMediaClone/_jobs`, and the Vault archive root is `XMediaArchive`. The Vault is the durable source of truth. Automatic backups and cloud synchronization are not provided.

### Troubleshooting and known limitations

- If the save button is missing, reload the extension from `chrome://extensions` and then reload the X tab.
- If imported content does not appear, run `Import pending jobs` followed by `Reconcile pending jobs`. Diagnostics are written to `XMediaArchive/_system/diagnostic.log`.
- Media from the source post of a quote is not saved automatically. Save the quoted source post separately when needed.
- Removing the extension or plugin does not automatically delete an existing `XMediaArchive`.

### Permissions and data

XMC uses the `downloads`, `storage`, and `unlimitedStorage` permissions plus host access for X/Twitter. The Companion does not contact X, FxTwitter, oEmbed, or similar services, and it does not read X cookies or tokens. Credentials are never stored in jobs.

### Issues and pull requests

Issues and pull requests are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before making changes. Never include real user data, credentials, real images, or private logs in issues or fixtures.

## License

[MIT License](LICENSE). This project is not affiliated with X Corp. or Obsidian.
