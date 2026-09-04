# Contributing / コントリビューション

IssueとPull Requestを受け付けます。Issues and pull requests are welcome.

1. Forkし、変更ごとにbranchを作成してください。Fork the repository and create one branch per change.
2. 実データ、認証情報、Cookie、token、実画像、個人パスをcommitやIssueへ含めないでください。Never include real user data, credentials, cookies, tokens, real images, or private filesystem paths.
3. XMCとCompanionの受渡しを変える場合は、[`docs/ARCHIVE_JOB_V1.md`](docs/ARCHIVE_JOB_V1.md)と両側の実装を同じPRで更新してください。Changes to the producer/consumer boundary must update the contract and both components in the same pull request.
4. Companionの`src/`を変更した場合は`npm run build`後の`main.js`も含めてください。When changing Companion source, commit the rebuilt `main.js`.

```powershell
cd x-media-clone
node --test tests/*.test.js

cd ..\x-media-archive-companion
npm ci
npm test
npm run check
npm run build
```

Pull Requestには変更理由と確認結果だけを簡潔に書いてください。Keep pull requests focused and include the reason for the change and the verification performed.
