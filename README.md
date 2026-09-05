# X Media Archive Suite for Cosense

[English](README.en.md)

本リポジトリのREADMEとコードは、すべてOpenAI GPT-5.6によるバイブコーディングで作成されました。

Twitter（現:X）のツイート(現:ポスト)からメディアをダウンロードし、ローカルのObsidian Vaultへ保存するツールです。Chrome拡張 **X Media Collector（XMC）** とObsidianプラグイン **X Media Archive Companion** を一組で使用します。
ツイート単体をmd形式で保存するプラグインはあるものの、投稿者単位でメディアを管理でき、画像や動画をメイソンツリーで表示できるプラグインはなかったため自作しました。

Windows、Chrome 111以降、Obsidian Desktop 1.5以降向けのPublic previewです。

## インストール

### Release ZIP

1. [Releases](../../releases)から`x-media-collector-0.2.2.zip`と`x-media-archive-companion-0.1.0.zip`を取得し、両方を展開します。
2. Chromeで`chrome://extensions`を開き、デベロッパーモードを有効にします。「パッケージ化されていない拡張機能を読み込む」から`x-media-collector`を選びます。
3. `x-media-archive-companion`を`<Vault>/.obsidian/plugins/`へ置きます。
4. Obsidianを再起動し、設定のコミュニティプラグインから`X Media Archive Companion`を有効にします。

### Gitで導入・更新

```powershell
git clone https://github.com/maccha3699/x-media-archive-suite.git
git -C C:\path\to\x-media-archive-suite pull --ff-only
```

Chromeにはclone先の`x-media-collector`を直接読み込ませます。Companionも同じ`git pull`で更新する場合は、Obsidianを閉じ、リンク先が存在しない新規導入時にWindowsのジャンクションを作ります。

```powershell
New-Item -ItemType Junction `
  -Path "C:\path\to\Vault\.obsidian\plugins\x-media-archive-companion" `
  -Target "C:\path\to\x-media-archive-suite\x-media-archive-companion"
```

更新後は`chrome://extensions`で拡張機能を再読み込みし、開いているXタブも再読み込みします。Obsidianも再起動します。

## 使い方

1. Xの投稿に表示される保存ボタンで1件保存します。一括保存は対象プロフィールの`/media`ページで「一括DL」→「開始」です。
2. Obsidian左リボンの画像アイコン、または`Open archive gallery`コマンドからビューアーを開きます。
3. ビューアー上部のダウンロードアイコン`Import pending X Media jobs`を押して取り込みます。
4. 投稿者カードを選ぶと投稿一覧が開きます。ヘッダーの検索から全保存ノートを検索できます。
5. 投稿または投稿者の削除はカードの右クリックから行います。削除後に再取得するときは一括DLの「保存済みも再取得する」を有効にします。
6. I/Oエラーなどで未処理jobが残った場合は`Reconcile pending jobs`を実行します。

手動保存はその都度取得します。一括保存は保存済みメディアを既定でスキップし、「保存済みも再取得する」を有効にした場合だけ取り直します。

## 取込時のデータ移動

1. XMCはメディアを`~/Downloads/XMediaClone/_jobs/<jobId>/media/`へ保存し、投稿情報を`_manifest/<attemptUuid>/`へ確定します。`XMediaClone`は互換性のため残している旧内部名です。
2. Companionは`complete.json`があるmanifestだけを読みます。
3. メディアをVault内の一時ファイルへ**コピー**し、サイズとSHA-256を確認してから正式な保存先へ切り替えます。同一内容の既存ファイルは再利用し、異なる内容との衝突は失敗として扱います。
4. 投稿ノート、プロフィール、索引、`receipts/<jobId>.json`を書き、receiptが参照する成果物の存在を確認します。
5. 確認後に、正常に取り込めたメディアだけをDownloads側の`media/`から削除し、job直下へ`.xmc-imported`を書きます。

manifest、`complete.json`、jobディレクトリは自動削除しません。正常取込後はmanifestと`.xmc-imported`が残り、I/Oエラーで失敗したメディアは再試行用にstagingへ残ります。ノートやreceiptなどメディア以外の書込みが失敗した場合は、その試行の変更を戻します。

`_jobs`は一時受渡し領域でありバックアップではありません。恒久データの正本はVaultの`XMediaArchive`です。本ソフトは自動バックアップやクラウド同期を行いません。

## ファイル構造

```text
x-media-archive-suite/
├─ x-media-collector/              Chrome拡張のソースとテスト
├─ x-media-archive-companion/      Obsidianプラグインのソース、配布物、テスト
├─ docs/ARCHIVE_JOB_V1.md          XMC → Companionの受渡し契約
├─ test-fixtures/                  合成テストデータ
├─ .github/workflows/test.yml      Push / Pull Requestの検証
├─ CONTRIBUTING.md
└─ LICENSE
```

```text
~/Downloads/XMediaClone/_jobs/<jobId>/
├─ media/                           取込前メディア
├─ _manifest/<attemptUuid>/
│  ├─ manifest-0001.json ...        投稿・メディア情報
│  └─ complete.json                 manifest確定マーカー
└─ .xmc-imported                    取込済みマーカー

<Vault>/XMediaArchive/
├─ <authorFolder>/
│  ├─ _profile.md
│  ├─ <authorFolder>.md
│  └─ <post>.md
├─ _media/<authorFolder>/           恒久メディア
├─ _accounts/                       投稿者カード
└─ _system/
   ├─ profiles.json                 投稿者名変更を追う索引
   ├─ receipts/<jobId>.json         取込結果
   └─ diagnostic.log                安全化された診断ログ
```

Chrome IndexedDBは重複防止用の操作台帳です。jobのmanifestにCookieやtokenは入りません。投稿ノートでは`<!--xmc:user-->`より後が利用者領域で、再取込時も保持されます。詳細なjob形式は[`docs/ARCHIVE_JOB_V1.md`](docs/ARCHIVE_JOB_V1.md)にあります。

## 困ったとき・既知の制限

- 保存ボタンが出ない場合は、`chrome://extensions`で拡張機能を再読み込みしてからXタブも再読み込みします。
- 取込結果が見えない場合は`Import pending jobs`、続けて`Reconcile pending jobs`を実行します。診断ログは`XMediaArchive/_system/diagnostic.log`です。
- 引用元ポストのメディアは自動保存されません。必要な場合は引用元ポストも別に保存します。
- 拡張機能やプラグインを削除しても、既存の`XMediaArchive`は自動削除されません。

## 権限とデータ

XMCは`downloads`、`storage`、`unlimitedStorage`とX/Twitter上のhost権限を使用します。CompanionはX、FxTwitter、oEmbed等へ通信せず、XのCookieやtokenも読みません。認証情報はjobへ保存しません。

## Issue・Pull Request

不具合報告とPull Requestを受け付けます。変更前に[`CONTRIBUTING.md`](CONTRIBUTING.md)を確認してください。実データ、認証情報、実画像、個人パスをIssue、fixture、ログへ含めないでください。

## ライセンス

[MIT License](LICENSE)。本プロジェクトはX Corp.およびObsidianとは無関係です。
