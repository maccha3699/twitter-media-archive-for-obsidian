# X Media Archive Suite

[日本語](README.md)

All README documentation and code in this repository were created through vibe coding with OpenAI GPT-5.6.

This tool downloads media from visible posts on X (formerly Twitter) and saves it into a local Obsidian Vault. It combines the **X Media Collector (XMC)** Chrome extension and the **X Media Archive Companion** Obsidian plugin.

This is a public preview for Windows, Chrome 111 or later, and Obsidian Desktop 1.5 or later.

## Installation

### Release ZIPs

1. Download and extract both `x-media-collector-0.2.2.zip` and `x-media-archive-companion-0.1.0.zip` from [Releases](../../releases).
2. Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose the extracted `x-media-collector` folder.
3. Place `x-media-archive-companion` under `<Vault>/.obsidian/plugins/`.
4. Restart Obsidian and enable `X Media Archive Companion` under Community plugins.

### Install and update with Git

```powershell
git clone https://github.com/maccha3699/x-media-archive-suite.git
git -C C:\path\to\x-media-archive-suite pull --ff-only
```

Load `x-media-collector` directly from the cloned repository. To update the Companion with the same `git pull`, close Obsidian and create a Windows directory junction on a fresh installation where the destination does not already exist.

```powershell
New-Item -ItemType Junction `
  -Path "C:\path\to\Vault\.obsidian\plugins\x-media-archive-companion" `
  -Target "C:\path\to\x-media-archive-suite\x-media-archive-companion"
```

After an update, reload the extension from `chrome://extensions`, reload open X tabs, and restart Obsidian.

## Usage

1. Save one post with the save button added to posts on X. For bulk saving, open the target profile's `/media` page and choose **一括DL** → **開始**.
2. Open the viewer from the image icon in Obsidian's left ribbon or run `Open archive gallery`.
3. Import pending jobs with the `Import pending X Media jobs` download icon in the viewer header.
4. Select an author card to open its posts. Use the search button in the header to search all saved notes.
5. Right-click a post or author card to delete it. To download deleted content again, enable **保存済みも再取得する** in the bulk-download dialog.
6. Run `Reconcile pending jobs` when an I/O failure leaves a retryable job.

Manual saves download the selected post each time. Bulk saves skip media already recorded as saved unless **保存済みも再取得する** is enabled.

## What happens during import

1. XMC saves media under `~/Downloads/XMediaClone/_jobs/<jobId>/media/` and publishes post metadata under `_manifest/<attemptUuid>/`. `XMediaClone` is a legacy internal name retained for compatibility.
2. The Companion reads only a manifest that has a `complete.json` marker.
3. Each media file is **copied** to a temporary file inside the Vault, checked for size and SHA-256, and then atomically published. An identical existing file is reused; a different-content collision fails safely.
4. The Companion writes post notes, profiles, indexes, and `receipts/<jobId>.json`, then verifies that the receipt's artifacts exist.
5. Only after that verification does it delete successfully imported media from the Downloads-side `media/` folder and write `.xmc-imported` at the job root.

The manifest, `complete.json`, and job directory are not automatically deleted. After a successful import, the manifest and `.xmc-imported` remain; media that failed with a retryable I/O error stays in staging. If a non-media write such as a note or receipt fails, that import attempt is rolled back.

`_jobs` is temporary handoff storage, not a backup. The durable source of truth is `XMediaArchive` inside the Vault. The suite does not provide automatic backups or cloud synchronization.

## File layout

```text
x-media-archive-suite/
├─ x-media-collector/              Chrome extension source and tests
├─ x-media-archive-companion/      Obsidian plugin source, distribution, and tests
├─ docs/ARCHIVE_JOB_V1.md          XMC → Companion handoff contract
├─ test-fixtures/                  Synthetic test data
├─ .github/workflows/test.yml      Push and pull-request checks
├─ CONTRIBUTING.md
└─ LICENSE
```

```text
~/Downloads/XMediaClone/_jobs/<jobId>/
├─ media/                           Media awaiting import
├─ _manifest/<attemptUuid>/
│  ├─ manifest-0001.json ...        Post and media metadata
│  └─ complete.json                 Manifest completion marker
└─ .xmc-imported                    Imported marker

<Vault>/XMediaArchive/
├─ <authorFolder>/
│  ├─ _profile.md
│  ├─ <authorFolder>.md
│  └─ <post>.md
├─ _media/<authorFolder>/           Durable media
├─ _accounts/                       Author cards
└─ _system/
   ├─ profiles.json                 Author rename index
   ├─ receipts/<jobId>.json         Import result
   └─ diagnostic.log                Sanitized diagnostics
```

Chrome IndexedDB is the operational deduplication ledger. Job manifests contain no cookies or tokens. In post notes, content after `<!--xmc:user-->` belongs to the user and is preserved during re-import. See [`docs/ARCHIVE_JOB_V1.md`](docs/ARCHIVE_JOB_V1.md) for the complete job contract.

## Troubleshooting and known limitations

- If the save button is missing, reload the extension from `chrome://extensions` and then reload the X tab.
- If imported content does not appear, run `Import pending jobs` followed by `Reconcile pending jobs`. Diagnostics are written to `XMediaArchive/_system/diagnostic.log`.
- Media from the source post of a quote is not saved automatically. Save the quoted source post separately when needed.
- Removing the extension or plugin does not automatically delete an existing `XMediaArchive`.

## Permissions and data

XMC uses the `downloads`, `storage`, and `unlimitedStorage` permissions plus host access for X/Twitter. The Companion does not contact X, FxTwitter, oEmbed, or similar services, and it does not read X cookies or tokens. Credentials are never stored in jobs.

## Issues and pull requests

Issues and pull requests are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before making changes. Never include real user data, credentials, real images, private paths, or private logs in issues or fixtures.

## License

[MIT License](LICENSE). This project is not affiliated with X Corp. or Obsidian.
