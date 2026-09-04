// lib/download_filename.js
// Pure bookkeeping for chrome.downloads.onDeterminingFilename.
//
// Chrome ignores DownloadOptions.filename when any extension has registered
// an onDeterminingFilename listener. Keep the filename we intend to use in a
// short-lived queue so our service worker can explicitly suggest it when the
// event fires. A queue (rather than a single value) also handles repeated URLs.

export class DownloadFilenameClaims {
  constructor() {
    this.byUrl = new Map();
  }

  add(url, filename) {
    if (typeof url !== "string" || url === "") return;
    if (typeof filename !== "string" || filename === "") return;

    const queue = this.byUrl.get(url) || [];
    queue.push(filename);
    this.byUrl.set(url, queue);
  }

  claim(downloadItem, extensionId) {
    if (!downloadItem || downloadItem.byExtensionId !== extensionId) return null;

    const queue = this.byUrl.get(downloadItem.url);
    if (!queue || queue.length === 0) return null;

    const filename = queue.shift();
    if (queue.length === 0) this.byUrl.delete(downloadItem.url);
    return filename;
  }

  remove(url, filename) {
    const queue = this.byUrl.get(url);
    if (!queue) return;

    const index = queue.indexOf(filename);
    if (index !== -1) queue.splice(index, 1);
    if (queue.length === 0) this.byUrl.delete(url);
  }
}
