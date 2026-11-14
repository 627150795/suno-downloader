// Run with: node test.js (Node.js built-ins only; no live service or credentials).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

async function checkDownloads(content) {
  const crypto = require("node:crypto").webcrypto;
  for (const format of ["m4a-opus", "webm-opus"]) {
    for (const encrypted of [false, true]) {
      for (const session of [null, "synthetic-session"]) {
        const id = "synthetic-id", token = session || "synthetic-guest";
        const plain = Buffer.from(format === "webm-opus" ? [26, 69, 223, 163, 0, 0, 0, 0, 0] : [0, 0, 0, 12, 102, 116, 121, 112, 0]);
        const key = new Uint8Array(16).fill(7), iv = new Uint8Array(16).fill(8);
        const ctr = await crypto.subtle.importKey("raw", key, "AES-CTR", false, ["encrypt"]);
        const audio = encrypted ? Buffer.from(await crypto.subtle.encrypt({ name: "AES-CTR", counter: iv, length: 128 }, ctr, plain)) : plain;
        const kek = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)), "AES-GCM", false, ["encrypt"]);
        async function wrap(bytes) {
          const nonce = crypto.getRandomValues(new Uint8Array(12));
          const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(id) }, kek, bytes);
          return Buffer.concat([nonce, Buffer.from(data)]).toString("base64");
        }
        const rights = { key: await wrap(key), iv: await wrap(iv), glt: session ? undefined : token };
        let saved, clicked = false, rightsRequests = 0;
        const context = vm.createContext({
          crypto, TextEncoder, Uint8Array, Blob,
          atob: (value) => Buffer.from(value, "base64").toString("binary"),
          setTimeout: (fn) => fn(),
          URL: { createObjectURL(blob) { saved = blob; return "blob:test"; }, revokeObjectURL() {} },
          document: { body: { appendChild() {} }, createElement() { return { click() { clicked = this.download; }, remove() {} }; } },
          chrome: { runtime: { async sendMessage(message) {
            if (message.type === "getSession") return session;
            assert.equal(message.url, "https://cdn1.suno.ai/test");
            return audio.toString("base64");
          } } },
          fetch: async (url, options) => {
            assert.ok(url.startsWith("https://suno.com/a/api/"));
            if (url.endsWith("/rights")) {
              rightsRequests++;
              assert.equal(options.headers.Authorization, session ? "Bearer " + session : undefined);
              return { ok: true, json: async () => rights };
            }
            return { ok: true, json: async () => ({ title: "Test", media_urls: [
              { content_type: format, delivery: "streaming", url: "https://invalid.test/stream" },
              { content_type: format, delivery: "progressive", url: "https://cdn1.suno.ai/test", encoding: encrypted ? "1.0.0" : undefined },
            ] }) };
          },
        });
        vm.runInContext(content.split("// ---------- UI ----------")[0] + "globalThis.downloadSong = downloadSong; globalThis.selectMedia = typeof selectMedia === 'function' ? selectMedia : undefined; })();", context);
        await context.downloadSong(id, () => {});
        assert.equal(clicked, format === "webm-opus" ? "Test.webm" : "Test.m4a");
        assert.deepEqual(Buffer.from(await saved.arrayBuffer()), plain);
        assert.equal(rightsRequests, encrypted ? 1 : 0);
        assert.throws(() => context.selectMedia({ media_urls: [{ content_type: format, delivery: "streaming" }] }), /完整/);
      }
    }
  }
}

async function main() {
  let metaRequests = 0;
  const content = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
  const context = vm.createContext({
    fetch: async () => {
      metaRequests++;
      return { ok: true, json: async () => ({ title: "Test song" }) };
    },
  });
  vm.runInContext(content.split("// ---------- UI ----------")[0] +
    "globalThis.loadMeta = loadMeta; })();", context);
  const first = context.loadMeta("test-id");
  const concurrent = context.loadMeta("test-id");
  assert.equal((await first).title, "Test song");
  assert.equal((await concurrent).title, "Test song");
  const cached = context.loadMeta("test-id");
  assert.equal(typeof cached.then, "function", "cached metadata must remain awaitable");
  assert.equal((await cached).title, "Test song");
  assert.equal(metaRequests, 1);

  await checkDownloads(content);

  let listener, cookieReads = 0;
  const requests = [];
  const audio = Buffer.alloc(0x10001, 42);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "background.js"), "utf8"), {
    chrome: {
      runtime: { id: "test-extension", onMessage: { addListener(fn) { listener = fn; } } },
      cookies: { get(options, respond) { cookieReads++; respond({ value: "synthetic-token" }); } },
    },
    fetch: async (url, options) => {
      requests.push({ url, redirect: options.redirect });
      return { ok: true, arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.length) };
    },
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  });
  const sender = { id: "test-extension", url: "https://suno.com/song/test" };
  for (const invalid of [
    { ...sender, id: "another-extension" },
    { ...sender, url: "https://suno.com.evil.invalid/" },
    { ...sender, url: "http://suno.com/" },
    { id: sender.id },
  ]) listener({ type: "getSession" }, invalid, () => assert.fail("untrusted sender received a response"));
  assert.equal(cookieReads, 0);
  const send = (message) => new Promise((resolve) => listener(message, sender, resolve));
  assert.equal(await send({ type: "getSession" }), "synthetic-token");
  assert.equal(cookieReads, 1);
  for (const url of [
    "http://cdn1.suno.ai/test.m4a", "https://evil.invalid/test.m4a",
    "https://cdn1.suno.ai.evil.invalid/test.m4a", "https://cdn1.suno.ai@evil.invalid/test.m4a",
    "file:///tmp/test.m4a", "https://suno.com/test.m4a",
  ]) assert.equal(await send({ type: "fetchBin", url }), null);
  assert.equal(requests.length, 0);
  for (const host of ["d2lwuy8qc234o3.cloudfront.net", "cdn1.suno.ai", "cdn2.suno.ai"]) {
    const url = `https://${host}/test.m4a`;
    assert.deepEqual(Buffer.from(await send({ type: "fetchBin", url }), "base64"), audio);
    assert.deepEqual(requests.at(-1), { url, redirect: "error" });
  }
  console.log("PASS: M4A/WebM downloads, encrypted/plain audio, session/guest keys, cached metadata, sender checks, CDN allowlist, redirect rejection and binary transfer");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
