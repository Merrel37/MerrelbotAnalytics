const BASE_URL = "https://buff.163.com/api/market/sell_order/history?game=csgo";
const PAGE_URL = (n) => `${BASE_URL}&page_num=${n}`;

// ---- helpers ----
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function toNumber(str) {
  if (str === null || str === undefined) return null;
  const n = Number(String(str).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function unixFromDateInput(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  return Math.floor(dt.getTime() / 1000);
}

function isoFromUnix(sec) {
  if (!sec) return null;
  return new Date(sec * 1000).toISOString();
}

async function storageGet(keys) { return new Promise((resolve) => chrome.storage.local.get(keys, resolve)); }
async function storageSet(obj) { return new Promise((resolve) => chrome.storage.local.set(obj, resolve)); }

async function fetchJson(url) {
  const res = await fetch(url, { method: "GET", credentials: "include", headers: { "accept": "application/json, text/plain, */*" } });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data || data.code !== "OK") throw new Error(`API not OK: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

function stateAllowed(state, mode) {
  if (mode === "success_only") return state === "SUCCESS";
  if (mode === "success_delivering") return state === "SUCCESS" || state === "DELIVERING";
  return true;
}

function extractRecord(api, item) {
  const goodsId = item.goods_id;
  const goods = api?.data?.goods_infos?.[String(goodsId)];
  const name = goods?.market_hash_name || goods?.name || goods?.short_name || null;

  const ai = item.asset_info || {};
  const info = ai.info || {};

  const soldTs = item.transact_time ?? item.created_at ?? item.updated_at ?? null;

  return {
    id: item.id || null,
    assetid: ai.assetid || null,
    name,
    sold_ts: soldTs,
    sold_at: isoFromUnix(soldTs),
    price: toNumber(item.price),
    paintwear: toNumber(ai.paintwear),
    paintseed: Number.isFinite(info.paintseed) ? info.paintseed : (ai?.info?.paintseed ?? null),
    state: item.state || null
  };
}

function sendProgress(syncId, page, totalPages, added, scanned, stopHint) {
  if (!syncId) return;
  chrome.runtime.sendMessage({ type: "PROGRESS", syncId, page, totalPages, added, scanned, stopHint: stopHint || null }).catch(() => { });
}

async function runSync(cutoffDateStr, collectMode, syncId) {
  const cutoffUnix = unixFromDateInput(cutoffDateStr);

  const { db } = await storageGet(["db"]);
  const existing = db?.records || [];
  const lastTopId = db?.last_top_id || null;

  const byId = new Map();
  for (const r of existing) if (r?.id) byId.set(r.id, r);

  let added = 0, scanned = 0, pages = 0, stopReason = "done";

  // 1) no page_num
  let topIdCandidate = null;
  try {
    const api0 = await fetchJson(BASE_URL);
    const items0 = api0?.data?.items || [];
    if (items0.length > 0) topIdCandidate = items0[0]?.id || null;

    for (const item of items0) {
      scanned++;

      if (lastTopId && item.id === lastTopId) { stopReason = "hit_last_top_id_on_no_page"; break; }

      const rec = extractRecord(api0, item);

      if (cutoffUnix && rec.sold_ts && rec.sold_ts < cutoffUnix) { stopReason = "cutoff_reached_on_no_page"; break; }

      if (!stateAllowed(rec.state, collectMode)) continue;

      if (rec.id && !byId.has(rec.id)) { byId.set(rec.id, rec); added++; }
    }
  } catch (e) {
    stopReason = `no_page_failed: ${String(e.message || e)}`;
  }

  // 2) page 1
  // 2) pages loop (dynamic total_page)
  let totalPageHint = null;

  for (let p = 1; ; p++) {
    pages = p;
    sendProgress(syncId, pages, totalPageHint, added, scanned, stopReason);

    const api = await fetchJson(PAGE_URL(p));
    const items = api?.data?.items || [];

    // total_page у Buff "плавающий" — обновляем подсказку для UI
    const tp = api?.data?.total_page || null;
    if (tp && (!totalPageHint || tp > totalPageHint)) totalPageHint = tp;

    // если страница пустая — дальше уже обычно не будет ничего
    if (!items.length) {
      stopReason = "empty_page";
      break;
    }

    // на первой странице можно (как и раньше) взять topIdCandidate
    if (p === 1 && !topIdCandidate) {
      topIdCandidate = items[0]?.id || null;
    }

    let shouldStop = false;

    for (const item of items) {
      scanned++;

      if (lastTopId && item.id === lastTopId) { stopReason = "hit_last_top_id"; shouldStop = true; break; }

      const rec = extractRecord(api, item);

      if (cutoffUnix && rec.sold_ts && rec.sold_ts < cutoffUnix) { stopReason = "cutoff_reached"; shouldStop = true; break; }

      if (!stateAllowed(rec.state, collectMode)) continue;

      if (rec.id && !byId.has(rec.id)) { byId.set(rec.id, rec); added++; }
    }

    sendProgress(syncId, pages, totalPageHint, added, scanned, stopReason);

    if (shouldStop) break;

    await sleep(1500);
  }
  const out = Array.from(byId.values()).sort((a, b) => (b.sold_ts || 0) - (a.sold_ts || 0));
  await storageSet({ db: { records: out, last_top_id: topIdCandidate || lastTopId } });

  return { ok: true, added, scanned, pages, stopReason, total: out.length, last_top_id: topIdCandidate || lastTopId };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "RUN_SYNC") {
        const resp = await runSync(msg.cutoffDate || "", msg.collectMode || "all", msg.syncId || null);
        sendResponse(resp);
        return;
      }
      if (msg?.type === "GET_DB") {
        const { db } = await storageGet(["db"]);
        sendResponse({ ok: true, records: db?.records || [], last_top_id: db?.last_top_id || null });
        return;
      }
      sendResponse({ ok: false, error: "unknown_message" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true;
});
