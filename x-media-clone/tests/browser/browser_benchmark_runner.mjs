import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { this.socket.close(); }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runBrowserBenchmark({ pageName, searchParams = {}, timeoutMs = 10 * 60 * 1000 }) {
  const pageUrl = new URL(pathToFileURL(path.join(here, pageName)));
  for (const [key, value] of Object.entries(searchParams)) pageUrl.searchParams.set(key, String(value));
  const profile = await mkdtemp(path.join(tmpdir(), "xmc-browser-benchmark-"));
  const chromePath = process.env.XMC_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--disable-logging",
    "--no-first-run",
    "--no-default-browser-check",
    "--allow-file-access-from-files",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    pageUrl.href,
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });

  function devToolsEndpoint() {
    return new Promise((resolve, reject) => {
      let stderr = "";
      const timeout = setTimeout(() => reject(new Error(`Chrome DevTools endpoint timeout: ${stderr}`)), 15000);
      const fail = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      if (chrome.exitCode !== null) {
        fail(new Error(`Chrome exited before DevTools was ready (${chrome.exitCode})`));
        return;
      }
      chrome.stderr.setEncoding("utf8");
      chrome.stderr.on("data", (chunk) => {
        stderr += chunk;
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
        if (!match) return;
        clearTimeout(timeout);
        resolve(match[1]);
      });
      chrome.once("error", (error) => fail(error));
      chrome.once("exit", (code) => fail(new Error(`Chrome exited before DevTools was ready (${code}): ${stderr}`)));
    });
  }

  let client;
  try {
    const browserWs = await devToolsEndpoint();
    const endpoint = new URL(browserWs);
    const listUrl = `http://${endpoint.host}/json/list`;
    let target;
    for (let attempt = 0; attempt < 100 && !target; attempt += 1) {
      const targets = await fetch(listUrl).then((response) => response.json());
      target = targets.find((item) => item.type === "page" && item.url.startsWith("file:"));
      if (!target) await delay(50);
    }
    if (!target) throw new Error("benchmark page target was not found");
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.open();
    await client.send("Runtime.enable");

    let raw = "running";
    const deadline = Date.now() + timeoutMs;
    while (raw === "running" && Date.now() < deadline) {
      const evaluated = await client.send("Runtime.evaluate", {
        expression: "document.querySelector('#result')?.textContent ?? 'missing'",
        returnByValue: true,
      });
      raw = evaluated.result.value;
      if (raw === "running") await delay(100);
    }
    if (raw === "running") throw new Error("benchmark did not finish before its deadline");
    const result = JSON.parse(raw);
    console.log(JSON.stringify({ ...result, temporaryProfile: profile }));
    if (!result.ok || !result.withinThresholds) process.exitCode = 1;
    return result;
  } finally {
    client?.close();
    chrome.kill();
  }
}
