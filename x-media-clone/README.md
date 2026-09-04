# X Media Clone

Xの表示済み投稿から画像・動画を保存し、Obsidian Companionへローカルjobを渡すChrome MV3拡張です。`X Media Archive Companion`と一組で動作します。複数のXログインアカウントを同じChromeプロファイルで切り替えても、同じIndexedDB台帳と保存先を使います。

## 操作

- 手動: 投稿上の保存ボタンを1回押す。
- 一括: 対象プロフィールの `/media` で「一括DL」→「開始」。既定同時数は20。
- 返信ツリー: 通常の保存ボタン1個が表示済みGraphQLの同一投稿者返信チェーンを自動判定する。最大50件を既存のbulk ArchiveJobへ載せ、Companionで投稿順の1ノートにする。一括保存も終了時に収集済みチェーンを同じ契約へまとめる。親欠損・分岐・上限到達は部分ツリーとして明示する。
- 手動保存は常に取得する。1投稿への意図的な1クリックであり、台帳はVaultが実体を失ったことを知り得ないため、拒否すると取り戻す手段が無くなる。
- 一括保存は保存済みmediaKeyをダウンロード要求前にスキップする。モーダルの「保存済みも再取得する」を明示的に有効にした場合だけ上書きする。
- 重複は問題にならない。consumerは投稿もメディアもIDから決まるパスへ書き、バイトが一致する既存ファイルは書き換えない。
- リツイートは元投稿として収集する。引用は引用元・引用先ともそれぞれの投稿者の投稿として扱う。
- ChromeからObsidianを開かない。Companionがローカルinboxを監視する。
- 失敗は記録し、自動リトライを連打しない。Obsidian未取込なら既存jobを保持し、回復コマンドで取り込む。

## 保存と受渡し

連携は既定で有効です。

```text
Downloads/XMediaClone/_jobs/<jobId>/
├─ media/<tweetId>-<ordinal>-<mediaKey>.<ext>
└─ _manifest/<attemptUuid>/
   ├─ manifest-0001.json ...
   └─ complete.json
```

manifest公開後は、Companionのギャラリーヘッダーまたは `Import pending jobs` コマンドからユーザーが明示的に未処理jobを取り込みます。Chromeから`obsidian://`を開かないため確認ポップアップは出ません。manifestにcookie、token、X認証情報は入りません。連携を無効にした場合は `Downloads/XMediaClone/<投稿者>/` へ保存します。

ArchiveJob仕様は `../docs/ARCHIVE_JOB_V1.md` を参照してください。

## 台帳

- IndexedDB、mediaKey単位、状態は `pending / staged / complete / failed / missing / legacy-unverified`。
- 件数上限、FIFO、TTL、自動削除なし。
- `pending` はChrome download中、`staged` はdownload済み・Vault未確定、`complete` はVaultへのcommit確認済みを表す。
- `complete`、進行中の `pending`、再取込待ちの `staged` は通信前に抑止する。`staged` の再クリックは既存jobのURIだけを再送する。
- 旧版がdownload完了だけで付けた誤った `complete` は、stagingが残っていれば自動的に `staged` へ戻す。job自体が失われていれば明示再クリックで再保存できる。
- 旧 `xmcHistory` は `legacy-unverified` として移行し、実ファイル未確認のまま抑止には使わない。
- 500MiB/1GiBは注意表示だけ。DB書込失敗や実ディスク不足では既存DBを保持して安全停止する。
- receipt配列からの再構築、台帳export、統計取得はservice workerの明示メッセージAPIとして提供する。

## 権限と他拡張

権限は `downloads`, `storage`, `unlimitedStorage`。`cookies` 権限は削除済みです。`downloads.onDeterminingFilename` は自拡張が開始したdownloadだけを命名し、他拡張のdownloadには同期的に `suggest()` して変更しません。自拡張でも上書きせず `uniquify` を使います。

## Xへの通信

投稿本文、日時、投稿者ID/name/bio/URL、mediaKeyは表示済みGraphQL/DOMデータを再利用します。プロフィールページで受信済みのuser payloadをauthorId/screenNameキャッシュへ合流し、FANBOX・Pixiv等の展開済みURLも保存します。プロフィール未観測時は`profile-pending`として空欄を完成扱いにしません。未保存メディアの実体取得だけX CDNへ行います。Companion側にX通信を移しません。

user nodeの形状は2026-08にXが変更しました。`legacy`ブロックは廃止され、bioは`profile_bio.description`、bio内リンクは`profile_bio.entities`、所在地は`location.location`（オブジェクト）、follower数は`relationship_counts.followers`へ移りました。`UserByScreenName`も廃止され`ProfileSpotlightsQuery`/`UserTweets`が使われます。`lib/graphql_extract.js` は新形状を優先し、旧`legacy`形状もフォールバックとして読みます。

この種の変更は例外を出しません。`core`がscreen_nameを供給し続けるためuser nodeとしては成立し、**全項目が空のプロフィールとして正常に取り込まれます**。プロフィールが空で増え続けたら、まず実ペイロードの形状を疑ってください。`tests/fixtures/profile_user_2026.json` は実レスポンスから採取した形です。

## 既知の不具合

**保存済みアカウントのプロフィールは、後から遡って埋められません。**

台帳は`complete`のmediaKeyをダウンロード要求前に抑止します。これは重複DL防止として正しい挙動ですが、結果として既に一括保存し終えた投稿者に対しては新しいjobが生まれず、manifestも公開されないため、**プロフィール抽出を修正してもそのアカウントには反映されません**。過去jobのmanifestにはbioが存在しないので、Companion側の再取込でも埋まりません。

現状の回避策は、その投稿者が新しく投稿したメディアを保存することだけです（その時点のプロフィールがmanifestに載ります）。プロフィールだけを再取得する経路は用意していません。

メディアについては「保存済みも再取得する」で上書きできます。Vaultから実体が失われても台帳へ伝える経路が無いため、抑止を解けるのはユーザーだけです。既定はオフで、有効にすると対象範囲を丸ごと取り直します。

## 導入

`chrome://extensions` でデベロッパーモードを有効にし、この `x-media-clone` ディレクトリを読み込むか、既存項目を再読み込みします。比較用 `2.0.7_0` を読み込まないでください。

## テスト

```powershell
node --test tests/*.test.js
node tests/benchmark_job_reads.mjs
node tests/browser/run_job_read_benchmark.mjs
```

`benchmark_job_reads.mjs`と`run_job_read_benchmark.mjs`は、既定で816投稿・940メディア・同時投稿worker数20を使い、完全なjob組立とheader読込をmemory store／実Chrome IndexedDBで比較します。引数は順に投稿数、メディア数、同時数です。

既存の大規模台帳ベンチ`tests/browser/run_indexeddb_benchmark.mjs`では、10万・100万件のmediaKey lookupと予約＋更新を検証できます。2026-08-11時点で100万件lookup p95 0.4ms、予約＋更新 p95 0.8msでした。

## 保守境界

- `lib/archive_contract.js`: ArchiveJob、mediaKey、Windows path、日時。
- `lib/save_request.js`: 手動・一括共通の保存要求。
- `lib/ledger.js`: IndexedDB台帳と永続job。
- `lib/graphql_extract.js` / `lib/media.js`: X表示データの正規化。
- `lib/profile_cache.js`: プロフィールGraphQLと投稿authorの合流。
- `lib/reply_tree.js`: 表示済み投稿から同一投稿者の返信チェーンを選ぶ純粋ロジック。
- `sw.js`: Chrome downloads、完了追跡、manifest、Obsidian URI。
- `content_main.js`: X上のボタン、一括モーダル、進捗表示。

XのDOM/GraphQL形状が変わった場合も、保存・台帳・manifest契約へ直接X依存を持ち込まないでください。
