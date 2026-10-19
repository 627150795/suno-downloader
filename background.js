// 读取 __session Cookie（httpOnly，页面脚本读不到，只能在这里读）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith("https://suno.com/")) return;
  if (msg && msg.type === "getSession") {
    chrome.cookies.get({ url: "https://suno.com", name: "__session" }, (c) => {
      sendResponse(c && c.value ? c.value : null);
    });
    return true; // 异步响应
  }
  if (msg && msg.type === "fetchBin" && typeof msg.url === "string") {
    if (!/^https:\/\/(?:d2lwuy8qc234o3\.cloudfront\.net|cdn[12]\.suno\.ai)\//.test(msg.url)) {
      sendResponse(null);
      return;
    }
    // CDN 音频：页面上下文受 CORS 限制，background 有 host_permissions 可直连
    fetch(msg.url, { redirect: "error" })
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("http " + r.status))))
      .then((buf) => {
        const bytes = new Uint8Array(buf);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        sendResponse(btoa(bin));
      })
      .catch(() => sendResponse(null));
    return true; // 异步响应
  }
});
