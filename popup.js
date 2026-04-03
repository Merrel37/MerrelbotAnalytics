const cutoffEl = document.getElementById("cutoffDate");
const collectModeEl = document.getElementById("collectMode");
const exportModeEl = document.getElementById("exportMode");
const statusEl = document.getElementById("status");

let currentSyncId = null;

function setStatus(msg) {
  statusEl.textContent = msg;
}

function chromeStorageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function chromeStorageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

function prettyMode(mode){
  if(mode === "success_only") return "SUCCESS";
  if(mode === "success_delivering") return "SUCCESS+DELIVERING";
  return "ALL";
}

function applyExportFilter(records, mode){
  if(mode === "success_only") return records.filter(r => r.state === "SUCCESS");
  if(mode === "success_delivering") return records.filter(r => r.state === "SUCCESS" || r.state === "DELIVERING");
  return records;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "PROGRESS") return;
  if (!currentSyncId || msg.syncId !== currentSyncId) return;

  const pct = msg.totalPages ? Math.round((msg.page / msg.totalPages) * 100) : 0;
  setStatus(
    `Парсим… ${pct}%\n` +
    `Страница: ${msg.page}/${msg.totalPages || "?"}\n` +
    `Добавлено: ${msg.added}\n` +
    `Просмотрено: ${msg.scanned}\n` +
    `Стоп-условие: ${msg.stopHint || "-"}`
  );
});

async function init() {
  const { settings, db } = await chromeStorageGet(["settings", "db"]);
  if (settings?.cutoffDate) cutoffEl.value = settings.cutoffDate;
  if (settings?.collectMode) collectModeEl.value = settings.collectMode;
  if (settings?.exportMode) exportModeEl.value = settings.exportMode;

  const count = db?.records?.length || 0;
  setStatus(`Готово.\nЗаписей: ${count}\nПоследний top_id: ${db?.last_top_id || "-"}\nCollect: ${prettyMode(collectModeEl.value)} / Export: ${prettyMode(exportModeEl.value)}`);
}

document.getElementById("save").addEventListener("click", async () => {
  const cutoffDate = cutoffEl.value || "";
  const collectMode = collectModeEl.value || "all";
  const exportMode = exportModeEl.value || "all";
  await chromeStorageSet({ settings: { cutoffDate, collectMode, exportMode } });
  setStatus("Сохранено ✅");
});

document.getElementById("run").addEventListener("click", async () => {
  const cutoffDate = cutoffEl.value || "";
  const collectMode = collectModeEl.value || "all";

  currentSyncId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;

  setStatus(`Запуск…\nCollect: ${prettyMode(collectMode)}\nSync: ${currentSyncId}`);

  chrome.runtime.sendMessage({ type: "RUN_SYNC", cutoffDate, collectMode, syncId: currentSyncId }, (resp) => {
    if (!resp) return setStatus("Нет ответа от background (проверь ошибки в расширениях).");
    if (!resp.ok) return setStatus(`Ошибка ❌\n${resp.error || "unknown"}`);

    setStatus(
      `Готово ✅\n` +
      `Добавлено: ${resp.added}\n` +
      `Просмотрено: ${resp.scanned}\n` +
      `Страниц: ${resp.pages}\n` +
      `Стоп: ${resp.stopReason}\n` +
      `Записей всего: ${resp.total}\n` +
      `top_id теперь: ${resp.last_top_id || "-"}`
    );
  });
});

document.getElementById("export").addEventListener("click", async () => {
  const exportMode = exportModeEl.value || "all";
  setStatus("Готовлю экспорт…");

  chrome.runtime.sendMessage({ type: "GET_DB" }, async (resp) => {
    if (!resp?.ok) return setStatus(`Ошибка ❌\n${resp?.error || "unknown"}`);

    const filtered = applyExportFilter(resp.records || [], exportMode);
    const payload = {
      exported_at: new Date().toISOString(),
      total: filtered.length,
      mode: exportMode,
      records: filtered
    };

    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const filename = `buff_sell_history_${exportMode}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

      await chrome.downloads.download({
        url,
        filename,
        saveAs: true
      });

      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setStatus(`Экспортировано ✅\nФайл: ${filename}\nЗаписей: ${filtered.length}`);
    } catch (e) {
      setStatus(`Ошибка экспорта ❌\n${String(e.message || e)}`);
    }
  });
});

document.getElementById("clear").addEventListener("click", async () => {
  await chromeStorageSet({ db: { records: [], last_top_id: null } });
  setStatus("Очищено 🧹");
});

init();
