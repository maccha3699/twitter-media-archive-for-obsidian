# X Media Archive Companion

このREADMEとコードは、すべてOpenAI GPT-5.6によるバイブコーディングで作成されました。
This README and all code were created through vibe coding with OpenAI GPT-5.6.

X Media Cloneの完了jobをVaultへ取り込む、Obsidianデスクトップ専用プラグインです。Chrome拡張`X Media Clone`と一組で動作します。ネットワークAPIを一切使わず、X、FxTwitter、oEmbed等へ通信しません。Xのcookieやtokenも読みません。

## 保存先

- 投稿ノート: `XMediaArchive/<最初のscreenName>/`
- プロフィール: `XMediaArchive/<最初のscreenName>/_profile.md`
- 投稿者カード: `XMediaArchive/_accounts/<同じscreenName>.md`
- アカウント一覧へ戻るカード: `XMediaArchive/<同じscreenName>/<同じscreenName>.md`（GridExplorerのフォルダノート。`type: folder`/`redirect`で`_accounts`へ移動する）
- メディア: `XMediaArchive/_media/<同じフォルダ>/`
- receipt: `XMediaArchive/_system/receipts/<jobId>.json`

GridExplorerはフォルダノートの frontmatter を投稿フォルダの表示設定として読みます。`sort: name-desc` でノート名の降順、つまり新しい投稿が先頭に来ます（ノート名が日時始まりのため）。`pinned` には `_profile.md` と戻るカード自身を並べ、両方をフォルダ先頭に固定します。`cardLayout: vertical` は画像を上、テキストを下に置く縦型カードです。同じ機構で `minMode` / `showDateDividers` / `showNoteInGrid` も指定できます。

`_accounts` 自身のフォルダノート `_accounts/_accounts.md` にも同じ設定を書きますが、**存在しない場合に一度だけ作成し、以後は書き換えません**。GridExplorerはこのノートにユーザー自身のピン止めとフォルダ色も保存するため、再生成すると失われます。

ノート名は `YYYY-MM-DD_HHmmss - 本文先頭32文字 - tweetId.md`。日時はAsia/Tokyoで、frontmatterにはUTC ISO-8601も保持します。authorIdを同一人物判定の正本とし、screenNameが変わっても最初のフォルダ名を維持します。

## ギャラリービュー

`XMediaArchive` 専用の閲覧ビューです。左リボンの画像アイコン、またはコマンド `Open archive gallery` で開きます。既存ビューが無い場合は**中央ペインの新規タブ**に開きます。ユーザーが配置済みの既存ビューはその場所を維持します。

- アカウント一覧: 代表画像・表示名・`@screenName`・件数。クリックでその投稿者へ
- 投稿一覧: 先頭画像・残り枚数バッジ・本文先頭。クリックでノートを開く（Ctrl+クリックで新規タブ）、`‹` でアカウント一覧へ
- 検索: アカウント一覧は表示名・`@screenName`・フォルダ名、投稿者別／お気に入り一覧はノート名由来の本文先頭・tweet ID・投稿者で絞り込む。全角半角と大文字小文字を吸収し、空白区切りはAND検索
- 全保存ノート検索: ヘッダーの検索ボタンから開く。全投稿者の投稿タイトル・tweet ID・投稿者と、プロフィールの表示名・現在／過去screenName・所在地・展開済みURLを横断検索する。`pixiv` や `booth` でURLを持つプロフィールを探せる
- 投稿ノート: 新規生成する通常投稿は投稿部分の左側へテーマのアクセントカラー縦線を表示する。返信ツリーは各投稿ごとに独立した縦線を表示する。メディア用の末尾`https://t.co/...`は重複表示せず、Original URLは各投稿部分の末尾へ置く
- 投稿者導線: 新規生成する通常投稿・返信ツリーの本文には「投稿者プロフィール」「このユーザーの投稿フォルダ」を表示しない。プロフィールノートと投稿者フォルダ入口自体は維持し、リンク生成は将来個別に再有効化できる独立箇所へ隔離する
- プロパティ表示: 投稿・プロフィールではObsidian標準の上側プロパティを隠し、読み取りビューとライブプレビューの本文末尾だけへ表示する。同じ内容のXMC専用ビューを右サイドバーへ自動展開し、対象ノートにフォーカスがある間だけ表示する。キーと値は通常のテキストとして選択・コピーできる
- 投稿者単位削除: 投稿者カードの右クリック直後に確認画面を開き、安全確認の進行後に投稿者名、ノート数、メディア数、receipt数を表示する。確認チェック後だけ投稿者フォルダ・投稿者カード・専有メディアをまとめてゴミ箱へ移す。外部ノートが参照中のメディアは残し、複数投稿者を含むreceiptは対象投稿だけを除く
- 単一投稿削除: 投稿ノートと専有メディアをVault内stageへ移し、対象notePathを持つ全receipt entryと投稿者カードを更新してからゴミ箱へ送る。trash前の失敗は元bytesへrollbackし、共有・索引未確定メディアは残す

カードは一番低い列へ順に足します。既に置いたカードを動かさないので逐次読み込みと両立し、列が空のうちは最も低い列＝最も左なので読み順も保たれます。タイルは画像が届く前に `--xmc-ratio` で高さを確保するため、デコード中の画像が上のカードを押し下げることはありません。

**ノートは1件も読みません。** カードと検索索引は `metadataCache` の frontmatter、`embeds`、Vault pathから組み立て、画像は `getResourcePath()` をObsidianへ渡すだけです。40,000件のノートを読む処理は存在しません。

投稿／返信ツリーノートでは`<!--xmc:user-->`より前をCompanion、後を利用者が所有します。再取込はmarker後を改行ごとbyte保持し、未知frontmatterも保持します。marker無し・重複・改変は推測で直さず、最初のVault mutation前に失敗します。Galleryはtweet ID、author folder、決定的media名が一致する管理メディアだけを使い、利用者領域の外部embedをpreview・件数・削除対象へ混ぜません。

## 公開配布向けnote移行

`scripts/public-distribution-migration.ts`は既存XMC投稿／返信ツリーへ所有markerを一度だけ追加します。path/registry異常はmanual reviewとして停止し、自動renameしません。artifactはGit除外済みprivate runへ置きます。

```powershell
npm run migration:public -- scan --archive C:\path\to\vault\XMediaArchive --out C:\private-run\scan.json
npm run migration:public -- plan --archive C:\path\to\vault\XMediaArchive --scan C:\private-run\scan.json --out C:\private-run\plan.json
# planを確認し、別の明示承認まで停止
npm run migration:public -- apply --archive C:\path\to\vault\XMediaArchive --plan C:\private-run\plan.json --run C:\private-run --confirm <planId>
npm run migration:public -- verify --archive C:\path\to\vault\XMediaArchive --plan C:\private-run\plan.json
```

GridExplorer用のフォルダノートは残してあるので、GridExplorerの `ignoredFolders` から `XMediaArchive` を外せば元の表示へ完全に戻せます。

投稿者削除は一度Vault内の`_system/delete-staging`へ移してからまとめてゴミ箱へ送り、途中失敗時は移動・receipt・ピン索引を元へ戻します。インポートや投稿者索引更新とは同時実行しません。ChromeのIndexedDB台帳はCompanionから変更できないため、削除後の一括DLでは必ず「保存済みも再取得する」を有効にしてください。旧receiptは対象投稿を除いた完了記録として残り、台帳再構築で削除済みメディアを復活させず、古いjobの再取込も防ぎます。

## 既存投稿ノートの旧導線を除去する

`scripts/post-navigation-cleanup.ts` は、XMC投稿ノートのfrontmatter直後にある、対象投稿者自身への
「投稿者プロフィール」「このユーザーの投稿フォルダ」の完全一致行だけを除去します。本文中の同じ語、
frontmatter、投稿本文、メディアembed、返信ツリー、プロフィールノート、投稿者フォルダ入口は変更しません。

順序は必ず `scan -> plan -> ユーザー確認 -> apply --confirm -> verify` です。scan/plan/verifyはread-onlyです。
applyはplan作成後にノートが変化していれば開始前に中止し、planと同じprivate runディレクトリへ全対象の
原本バックアップとapply receiptを作ります。途中失敗やreceipt書込み失敗では更新済みノートを戻します。

```powershell
npm run cleanup:navigation -- scan --archive C:\path\to\vault\XMediaArchive --out C:\private-run\scan.json
npm run cleanup:navigation -- plan --archive C:\path\to\vault\XMediaArchive --scan C:\private-run\scan.json --out C:\private-run\plan.json
# plan集計を確認し、ユーザーが明示承認するまでapplyしない
npm run cleanup:navigation -- apply --archive C:\path\to\vault\XMediaArchive --plan C:\private-run\plan.json --confirm
npm run cleanup:navigation -- verify --archive C:\path\to\vault\XMediaArchive --plan C:\private-run\plan.json
```

## 取込と回復

- 取込はユーザー操作で行う。常時監視はしない（ChromeからObsidianも開かない）
- 回復用URI: `obsidian://x-media-archive-import?vault=obsidian&job=<UUIDv4>`
- ギャラリーヘッダーのダウンロードアイコン: `Import pending X Media jobs`
- コマンド: `Import pending jobs`
- コマンド: `Reconcile pending jobs`
- コマンド: `Refresh account index`

URIからファイルパスは受け取りません。設定済みInboxからjobIdだけで解決します。同じjobの再実行は冪等です。

失敗はmedia単位で閉じ込めます。取り込めなかったmediaがあっても、その投稿は取得できた分のmediaと「Media pending repair」警告つきで `archive_state: partial` として保存し、**同じjobの他の投稿は通常どおり取り込みます**。receiptはmedia単位に `state` と `error` を記録します。job全体のロールバックは、media以外の書き込みが失敗した場合だけ行い、その試行で作成・更新したmedia、note、profile、registry、receiptを戻してstagingを残します。

stagingメディアの削除は、receiptが「書いた」と主張する成果物の実在を確認した後だけ行います。

再試行の可否も判定します。manifest自身が既に欠損を記録しているjob（DL時点で失われている）はそれ以上変わりようがないため `.xmc-imported` を書いて確定させます。I/Oエラーのように次回成功しうる失敗は未確定のまま残り、ユーザーが次にImport/Reconcileを実行したときだけ再試行されます。

欠損の発生時点はノートと診断ログの両方で区別できます。

- `download-failed` / 分類 `media-download-failed`: XMCがXから取得できなかった。manifestに記録された理由も併記される
- `import-lost` / 分類 `media-import-lost`: 取得済みだがVaultに届かなかった

各取込後、影響した投稿者のアカウントカードと投稿フォルダ入口を1回だけ更新します。既存分は`Refresh account index`で一括更新できます。カードの代表画像は画像をデコードせず、最初に選んだ静止画のVault pathを`cover_media`へ固定します。

実機診断は `XMediaArchive/_system/diagnostic.log` を使用します。JSON Lines、最大256KiBで、処理段階と安全化したエラー分類だけを保持します。

既定設定:

- Job inbox: `~/Downloads/XMediaClone/_jobs`
- Vault root: `XMediaArchive`

SaveXPostは従来どおり`Tweets/`、`Tweets/Authors/`、`Tweets/Media/`を使用し、Companionのファイルとはトップレベルから分離します。

## 導入

ビルド成果物 `main.js`, `manifest.json`, `styles.css` をVaultの `.obsidian/plugins/x-media-archive-companion/` に配置し、Obsidianのコミュニティプラグイン画面で有効化します。

## 開発

```powershell
npm test
npm run check
npm run build
```

保守スクリプト:

- `scripts/refresh-account-index.ts`: 既存投稿者の`_accounts`カードと戻るカードを再生成。画像内容は読まない。
- `scripts/audit-receipts.ts`: receiptのnote/media参照先を存在監査する。`vaultPath`が空・null・空白のmediaは、receiptのnotePathから安全に導いた投稿者フォルダ内でファイル名を照合し、唯一一致を`located`、複数候補を`ambiguous`、不在を`missing`として報告する。既に`partial`でも全成果物が揃うjobは`partialWithAllArtifacts`へ分ける。`--repair`は真の`missing`だけを`partial`へ降格し、発見したpathの書戻しや`partial`からの自動昇格は行わない。
- `scripts/backfill-profiles-from-savexpost.ts`: SaveXPostの`Tweets/Authors`からbioと展開済み外部URLを`_profile.md`へ補完。`--apply`なしはドライラン。既存bioは上書きしない。
- `scripts/migrate-selected-images.ts`: 固定manifestの画像10枚だけを`plan / apply / verify`。選定外を走査・移動しない。

テストはテキストとダミーバイナリだけを使います。実画像は表示・デコードしません。producer/consumer契約は `../docs/ARCHIVE_JOB_V1.md`、障害時は `../docs/RECOVERY.md` を参照してください。

GridExplorerのアカウントカード表示例は `examples/xmc-accounts-grid.css` です。ユーザーが調整するCSSなのでプラグインは自動上書きしません。
