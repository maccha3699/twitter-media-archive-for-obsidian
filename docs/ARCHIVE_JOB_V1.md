# ArchiveJob v1

X Media Clone（producer）とX Media Archive Companion（consumer）の唯一の受渡し契約です。

## Job

```json
{
  "schemaVersion": 1,
  "jobId": "UUIDv4",
  "mode": "manual | bulk",
  "createdAt": "UTC ISO-8601",
  "state": "complete",
  "posts": []
}
```

postは `tweetId`, `tweetUrl`, nullable `text`, nullable `createdAt`, 任意のnullable `replyToTweetId`, `replyToUserId`, `conversationId`, `author`, `media[]` を持ちます。直接返信IDは一括jobをオフラインでチェーン化するために使い、追加のX通信は行いません。authorはnullable `id`, 必須 `screenName`, nullable `displayName`, nullable `bio`, `urls[]`, nullable `location`, nullable `followers` を持ちます。

返信ツリーjobのpostは任意の `replyTree` を持ちます。`rootTweetId`, nullable `previousTweetId`, nullable `nextTweetId`, 1始まりの`position`, 2〜50の`size`, boolean `partial` です。参照先は同一job・同一投稿者に限り、同じチェーンの本文とメディアは投稿順に1つの集約ノートへ保存します。複数postのreceiptは同じ`notePath`を参照できます。親欠損、分岐、50件上限は`partial: true`で記録します。

mediaは以下を持ちます。

- `mediaKey`: XのmediaKeyを優先。無い場合は `tweetId:ordinal:type`。
- `ordinal`: 投稿内の1始まり位置。
- `type`: `photo | video | animated_gif`。
- `extension`: 先頭ドットなしの安全な拡張子。
- `stagingRelativePath`: jobディレクトリ内の相対path、または保存済みskip時のnull。
- `downloadState`: `complete | failed | skipped | missing | pending`。
- `error`: 取得に失敗した理由。nullable、省略可。改行を含まない256文字以内。

`error` は producer の台帳にしか存在しない失敗理由を consumer へ運ぶためのものです。これが無いと欠損は `downloadState: missing` としてだけ届き、**なぜ失われたのかが二度と分かりません**。consumerはこれを投稿ノートへ表示します。省略するv1 producerも受け入れます。

cookie、token、Authorization、その他のX認証情報を含めてはいけません。未知fieldはv1 consumerが無視し、未知schemaVersionは拒否します。絶対path、UNC、drive path、`..`、UUIDv4でないjobIdは拒否します。

## Chunk公開

Downloads APIのdata URL制約に合わせ、UTF-8 JSONを512KiB以下のchunkへ分割します。

```text
XMediaClone/_jobs/<jobId>/_manifest/<attemptUuid>/
├─ manifest-0001.json
├─ manifest-0002.json
└─ complete.json
```

chunk wrapper:

```json
{
  "schemaVersion": 1,
  "kind": "archive-job-chunk",
  "jobId": "UUIDv4",
  "chunkIndex": 0,
  "chunkCount": 1,
  "encoding": "base64-utf8-json",
  "payload": "..."
}
```

complete marker:

```json
{
  "schemaVersion": 1,
  "kind": "archive-job-complete",
  "jobId": "UUIDv4",
  "chunkCount": 1
}
```

producerは全chunk完了後にmarkerを最後に公開します。consumerはmarkerのあるattemptだけを候補にし、新しいcompleted attemptが壊れていれば古いcompleted attemptへ戻ります。chunk番号、件数、jobId、byte結合後のschemaを再検証します。

## Receipt

Companionは `XMediaArchive/_system/receipts/<jobId>.json` を原子的に書きます。receiptはjob状態、postごとのnotePath、mediaKey、ordinal、`complete | partial`、vaultPathまたはerrorを保持します。XMCはreceipt配列からIndexedDB台帳を明示再構築できます。

## 冪等性

- jobId、tweetId、mediaKey、決定的なVault pathで再実行を判定する。
- 同一targetはサイズとSHA-256が一致する場合だけ再利用する。
- 異なる内容を上書きしない。
- complete receipt後の再実行は既存結果を返す。
- partial receiptは同じjobを再取込して欠損だけ修復できる。
