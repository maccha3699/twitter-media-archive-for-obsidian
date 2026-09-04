# X Media Archive Suite

X上で表示した画像・動画を保存するChrome拡張 **X Media Clone** と、保存jobをObsidian Vaultへ取り込んで閲覧するデスクトッププラグイン **X Media Archive Companion** のセットです。2つを一組で使用します。

## 制作方法について

このプロジェクトは、作者が要件、実機確認、受入判断を担当し、AIと対話しながら実装・検証を進める**バイブコーディング**によって制作しました。コードと文書にはAIが生成・修正した内容が含まれます。公開前に自動テストと作者による実機確認を行っていますが、無保証のPublic previewです。

## 構成

- `x-media-clone/`: Chrome 111以降向けManifest V3拡張。Xの表示済みデータを使い、未保存メディアをダウンロードしてローカルjobを作ります。
- `x-media-archive-companion/`: Obsidian 1.5以降のデスクトップ専用プラグイン。jobをVaultへ取り込み、投稿者別ギャラリー、検索、削除、再取込を提供します。

CompanionはX、FxTwitter、oEmbedなどの外部サービスへ通信せず、XのCookieやトークンも読みません。保存データはローカルのDownloadsとObsidian Vaultに置かれます。

## インストール

1. [Releases](../../releases)から次の2ファイルをダウンロードし、両方を展開します。
   - `x-media-clone-0.2.2.zip`
   - `x-media-archive-companion-0.1.0.zip`
2. Chromeで`chrome://extensions`を開き、デベロッパーモードを有効にして「パッケージ化されていない拡張機能を読み込む」から、展開した`x-media-clone`フォルダを選びます。
3. 展開した`x-media-archive-companion`フォルダを`<Vault>/.obsidian/plugins/`へコピーします。
4. Obsidianを再起動し、設定のコミュニティプラグインから`X Media Archive Companion`を有効にします。
5. Xで投稿を保存した後、Obsidianのコマンド`Import pending jobs`を実行します。

初回公開はGitHubからの手動導入です。Chrome Web StoreとObsidian Community Pluginsには未掲載です。

## 既定の保存先

- XMC job inbox: `~/Downloads/XMediaClone/_jobs`
- Obsidian archive root: `<Vault>/XMediaArchive`

Vaultが恒久データの正本です。自動バックアップ、クラウド同期、競合解決は提供しません。

## 開発と安全性

両コンポーネントの受渡し契約は[`docs/ARCHIVE_JOB_V1.md`](docs/ARCHIVE_JOB_V1.md)です。認証情報をjobへ含めず、CompanionからXへ通信しない設計です。

公開用リポジトリには実Vault、個人用移行記録、バックアップ、実機テストで使った個人名・ローカルパスを含めていません。

## License

[MIT](LICENSE)
