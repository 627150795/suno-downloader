// Run with: node test.js (Node.js built-ins only; no live service or credentials).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

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
  console.log("PASS: cached metadata, sender checks, CDN allowlist, redirect rejection and binary transfer");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
