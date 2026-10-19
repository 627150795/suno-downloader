// Suno 下载器 —— 内容脚本
// 原理（源自 Suno 官方播放流程的逆向验证）：
//   1. 扫描页面里所有 /song/<uuid> 链接，逐首通过 /api/clip/<id> 补齐封面/作者/时长
//   2. 点下载：POST /api/mango/rights 换取 AES-GCM 加密的 key/iv（匿名用户用返回的 glt）
//   3. KEK = SHA-256(JWT 或 glt)，解包出 AES-CTR 的 key/iv（aad = 歌曲 id）
//   4. 由 background 拉 CDN 加密 m4a（页面上下文受 CORS 限制），本地 AES-CTR 解密
//   5. 得到 Opus-in-MP4 原始音质文件，直接保存 .m4a（无录音、无转码、无音质损失）
(function () {
  const API = "https://studio-api-prod.suno.com";
  const PANEL_ID = "suno-dl-panel";
  const BTN_ID = "suno-dl-btn";
  const ROW_ID = (id) => "suno-dl-row-" + id;

  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const isFtyp = (u8) => u8.length > 8 && u8[4] === 102 && u8[5] === 116 && u8[6] === 121 && u8[7] === 112; // "ftyp"
  const fmtDur = (s) => {
    if (!s || !isFinite(s)) return "";
    const m = Math.floor(s / 60), sec = Math.round(s % 60);
    return m + ":" + String(sec).padStart(2, "0");
  };

  // ---------- 下载核心 ----------
  async function getSession() {
    try { return await chrome.runtime.sendMessage({ type: "getSession" }); }
    catch (e) { return null; }
  }

  async function downloadSong(id, onStatus) {
    onStatus("获取密钥…");
    const jwt = await getSession();
    const headers = { "Content-Type": "application/json" };
    if (jwt) headers["Authorization"] = "Bearer " + jwt;
    const rightsRes = await fetch(`${API}/api/mango/rights`, {
      method: "POST", headers, credentials: "include",
      body: JSON.stringify({ content_params: { content_id: id, content_type: "clip" } }),
    });
    if (!rightsRes.ok) throw new Error("密钥接口失败 (" + rightsRes.status + ")");
    const rights = await rightsRes.json();

    const kekInput = jwt || rights.glt;
    if (!kekInput) throw new Error("拿不到密钥素材（未登录且匿名额度受限？）");

    const kek = await crypto.subtle.importKey(
      "raw",
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(kekInput)),
      { name: "AES-GCM" }, false, ["decrypt"]
    );
    const unwrap = async (b64) => {
      const w = b64ToBytes(b64);
      return new Uint8Array(await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: w.slice(0, 12), additionalData: new TextEncoder().encode(id) },
        kek, w.slice(12)
      ));
    };
    const keyRaw = await unwrap(rights.key);
    const ivRaw = await unwrap(rights.iv);

    onStatus("下载音频…");
    let meta = metaCache.get(id);
    if (meta && typeof meta.then === "function") meta = await meta;
    if (!meta) meta = {};
    const mediaUrl =
      (meta.media_urls && meta.media_urls[0] && meta.media_urls[0].url) ||
      `https://d2lwuy8qc234o3.cloudfront.net/1/clip/${id}.m4a`;
    const encB64 = await chrome.runtime.sendMessage({ type: "fetchBin", url: mediaUrl });
    if (!encB64) throw new Error("音频下载失败（网络或权限问题）");
    const enc = b64ToBytes(encB64);

    let out = enc;
    if (!isFtyp(enc)) {
      onStatus("解密中…");
      const key = await crypto.subtle.importKey("raw", keyRaw, { name: "AES-CTR" }, false, ["decrypt"]);
      out = new Uint8Array(await crypto.subtle.decrypt(
        { name: "AES-CTR", counter: ivRaw, length: 128 }, key, enc
      ));
      if (!isFtyp(out)) throw new Error("解密校验失败（格式不符）");
    }

    const title = ((meta.title) || id).replace(/[\\/:*?"<>|]/g, "_");
    const blob = new Blob([out], { type: "audio/mp4" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = title + ".m4a";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    onStatus("✓ 已保存 " + title + ".m4a");
  }

  // ---------- 歌曲元数据 ----------
  const metaCache = new Map(); // id -> clip json | Promise
  async function loadMeta(id) {
    if (metaCache.has(id)) return metaCache.get(id);
    const p = fetch(`${API}/api/clip/${id}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((j) => { if (j) metaCache.set(id, j); return j; });
    metaCache.set(id, p);
    return p;
  }

  // ---------- 页面扫描 ----------
  const known = new Map(); // id -> {row, btn, statusEl, metaApplied}
  function pageSongId() {
    const m = location.href.match(/\/song\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return m ? m[1] : null;
  }
  function scan() {
    const ids = [];
    const cur = pageSongId();
    if (cur) ids.push(cur);
    document.querySelectorAll('a[href*="/song/"]').forEach((a) => {
      const m = (a.getAttribute("href") || "").match(/\/song\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (m && !ids.includes(m[1])) ids.push(m[1]);
    });
    // 移除已不在页面的行（当前页歌曲除外）
    for (const [id, item] of known) {
      if (!ids.includes(id) && id !== cur) { item.row.remove(); known.delete(id); }
    }
    for (const id of ids) {
      if (!known.has(id)) {
        const item = addRow(id);
        known.set(id, item);
        applyMeta(id, item);
      }
      // 当前页歌曲固定置顶
      const item = known.get(id);
      if (id === cur && listEl.firstChild !== item.row) listEl.prepend(item.row);
    }
    const cnt = document.getElementById("suno-dl-count");
    if (cnt) cnt.textContent = known.size;
  }

  function applyMeta(id, item) {
    loadMeta(id).then((meta) => {
      if (!meta || !document.getElementById(ROW_ID(id))) return;
      const img = item.row.querySelector("img");
      if (img && meta.image_url) img.src = meta.image_url;
      const titleEl = item.row.querySelector(".suno-dl-title");
      if (titleEl && meta.title) titleEl.textContent = meta.title;
      const parts = [];
      if (meta.display_name) parts.push(meta.display_name);
      const dur = meta.metadata && meta.metadata.duration;
      if (dur) parts.push(fmtDur(dur));
      if (meta.display_tags) parts.push(meta.display_tags.split(",")[0].trim());
      const metaEl = item.row.querySelector(".suno-dl-meta");
      if (metaEl && parts.length) metaEl.textContent = parts.join(" · ");
      if (item.statusEl && item.statusEl.dataset.auto) item.statusEl.textContent = "";
    });
  }

  // ---------- UI ----------
  const css = document.createElement("style");
  css.textContent = `
    #${PANEL_ID} { position: fixed; right: 24px; top: 90px; bottom: 90px; width: 340px; z-index: 99999;
      background: #111113; border: 1px solid #2e2e33; border-radius: 14px; display: none;
      flex-direction: column; overflow: hidden; color: #e5e7eb;
      font-family: -apple-system, "PingFang SC", "Segoe UI", sans-serif;
      box-shadow: 0 12px 40px rgba(0,0,0,.65); }
    #${PANEL_ID}.open { display: flex; }
    #${PANEL_ID} .hd { display: flex; align-items: center; gap: 8px; padding: 12px 14px;
      border-bottom: 1px solid #26262b; font-size: 14px; font-weight: 600; }
    #${PANEL_ID} .hd .cnt { background: #2e2e33; border-radius: 999px; padding: 1px 9px;
      font-size: 12px; font-weight: 400; color: #9ca3af; }
    #${PANEL_ID} .hd .x { margin-left: auto; background: none; border: none; color: #9ca3af;
      font-size: 16px; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
    #${PANEL_ID} .hd .x:hover { background: #2e2e33; color: #fff; }
    #${PANEL_ID} .list { flex: 1; overflow-y: auto; padding: 6px; }
    #${PANEL_ID} .empty { padding: 24px 16px; color: #6b7280; font-size: 13px; text-align: center; }
    .suno-dl-row { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 10px; }
    .suno-dl-row:hover { background: #1c1c20; }
    .suno-dl-row img { width: 44px; height: 44px; border-radius: 8px; object-fit: cover; flex: none;
      background: #26262b; }
    .suno-dl-row .mid { flex: 1; min-width: 0; }
    .suno-dl-row .suno-dl-title { font-size: 13px; font-weight: 600; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; }
    .suno-dl-row .suno-dl-meta { font-size: 11px; color: #9ca3af; margin-top: 2px; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; }
    .suno-dl-row .suno-dl-status { font-size: 11px; color: #6ee7b7; margin-top: 2px; min-height: 13px; }
    .suno-dl-row .suno-dl-status.err { color: #fca5a5; }
    .suno-dl-row button.dl { flex: none; background: #2e2e33; border: 1px solid #3f3f46; color: #f9fafb;
      font-size: 12px; padding: 6px 14px; border-radius: 999px; cursor: pointer; }
    .suno-dl-row button.dl:hover:not(:disabled) { background: #3b3b42; }
    .suno-dl-row button.dl:disabled { opacity: .5; cursor: default; }
    #${BTN_ID} { position: fixed; right: 24px; bottom: 24px; z-index: 99999;
      padding: 10px 18px; border-radius: 999px; border: 1px solid #374151;
      background: #1f2937; color: #f9fafb; font-size: 14px; cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,.5); font-family: inherit; }
    #${BTN_ID}:hover { background: #374151; }
  `;
  document.head.appendChild(css);

  const toggleBtn = document.createElement("button");
  toggleBtn.id = BTN_ID;
  toggleBtn.textContent = "⬇ Suno 下载";
  document.documentElement.appendChild(toggleBtn);

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="hd"><span>Suno 下载器</span><span class="cnt" id="suno-dl-count">0</span>
      <button class="x" title="关闭">✕</button></div>
    <div class="list" id="suno-dl-list"></div>
  `;
  document.documentElement.appendChild(panel);
  const listEl = panel.querySelector(".list");

  toggleBtn.onclick = () => panel.classList.toggle("open");
  panel.querySelector(".x").onclick = () => panel.classList.remove("open");

  function addRow(id) {
    const row = document.createElement("div");
    row.className = "suno-dl-row";
    row.id = ROW_ID(id);
    row.innerHTML = `
      <img alt="">
      <div class="mid">
        <div class="suno-dl-title">${id.slice(0, 8)}…</div>
        <div class="suno-dl-meta"></div>
        <div class="suno-dl-status" data-auto="1">识别到歌曲…</div>
      </div>
      <button class="dl">下载</button>
    `;
    const statusEl = row.querySelector(".suno-dl-status");
    const btn = row.querySelector("button.dl");
    const setStatus = (t, isErr) => {
      statusEl.dataset.auto = "";
      statusEl.textContent = t;
      statusEl.classList.toggle("err", !!isErr);
    };
    btn.onclick = async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        await downloadSong(id, setStatus);
      } catch (e) {
        console.error("[SunoDL]", e);
        setStatus("✗ " + (e && e.message ? e.message : "下载失败"), true);
      } finally {
        setTimeout(() => { btn.disabled = false; }, 1500);
      }
    };
    listEl.appendChild(row);
    return { row, btn, statusEl };
  }

  setInterval(scan, 2000);
  scan();
})();
