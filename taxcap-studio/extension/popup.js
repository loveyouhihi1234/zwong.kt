const SETTINGS_KEY = "taxcapSettings";
const STATS_KEY = "taxcapStats";

const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));
const panels = {
  captcha: document.getElementById("panel-captcha"),
  config: document.getElementById("panel-config"),
  dataset: document.getElementById("panel-dataset"),
  logs: document.getElementById("panel-logs"),
};

const enabledToggleWrap = document.getElementById("enabledToggleWrap");
const enabledToggle = document.getElementById("enabledToggle");
const enabledLabel = document.getElementById("enabledLabel");
const lockHeaderPill = document.getElementById("lockHeaderPill");

const panelActivate = document.getElementById("panel-activate");
const activateAlert = document.getElementById("activateAlert");
const activateAlertText = document.getElementById("activateAlertText");
const activateKeyInput = document.getElementById("activateKeyInput");
const activateUrlDirectWrap = document.getElementById("activateUrlDirectWrap");
const activateApiInput = document.getElementById("activateApiInput");
const activateUrlDetails = document.getElementById("activateUrlDetails");
const activateApiPresetInput = document.getElementById("activateApiPresetInput");
const activateBtn = document.getElementById("activateBtn");
const activateStatus = document.getElementById("activateStatus");
const activateDeviceId = document.getElementById("activateDeviceId");

const licUserName = document.getElementById("licUserName");
const licCodeText = document.getElementById("licCodeText");
const licBadge = document.getElementById("licBadge");
const licExpires = document.getElementById("licExpires");
const licDevices = document.getElementById("licDevices");
const licUsageToday = document.getElementById("licUsageToday");
const licSyncInfo = document.getElementById("licSyncInfo");
const licRefreshBtn = document.getElementById("licRefreshBtn");
const licDeactivateBtn = document.getElementById("licDeactivateBtn");
const licActionStatus = document.getElementById("licActionStatus");

const connBanner = document.getElementById("connBanner");
const connBannerText = document.getElementById("connBannerText");
const goConfigBtn = document.getElementById("goConfigBtn");
const activeModeChip = document.getElementById("activeModeChip");
const statSolved = document.getElementById("statSolved");
const statFailed = document.getElementById("statFailed");
const pause15Btn = document.getElementById("pause15Btn");
const resumeBtn = document.getElementById("resumeBtn");
const pauseStatus = document.getElementById("pauseStatus");
const speedModeSelect = document.getElementById("speedModeSelect");
const enhanceToggle = document.getElementById("enhanceToggle");
const portalBoxes = Array.from(document.querySelectorAll("[data-portal]"));

const connectionModeSelect = document.getElementById("connectionModeSelect");
const directFields = document.getElementById("directFields");
const proxyFields = document.getElementById("proxyFields");
const geminiKeyInput = document.getElementById("geminiKeyInput");
const toggleKeyBtn = document.getElementById("toggleKeyBtn");
const apiBaseInput = document.getElementById("apiBaseInput");
const tokenInput = document.getElementById("tokenInput");
const saveBtn = document.getElementById("saveBtn");
const pingBtn = document.getElementById("pingBtn");
const pingStatus = document.getElementById("pingStatus");
const memoryStatsText = document.getElementById("memoryStatsText");
const clearMemoryBtn = document.getElementById("clearMemoryBtn");

const dsTotal = document.getElementById("dsTotal");
const dsUsable = document.getElementById("dsUsable");
const dsAccuracy = document.getElementById("dsAccuracy");
const dsPending = document.getElementById("dsPending");
const dsPortalsGrid = document.getElementById("dsPortalsGrid");
const dsPortalFilter = document.getElementById("dsPortalFilter");
const dsRefreshBtn = document.getElementById("dsRefreshBtn");
const dsExportBtn = document.getElementById("dsExportBtn");
const dsClearBtn = document.getElementById("dsClearBtn");
const dsSampleList = document.getElementById("dsSampleList");

const logTotal = document.getElementById("logTotal");
const logOk = document.getElementById("logOk");
const logErr = document.getElementById("logErr");
const logLatency = document.getElementById("logLatency");
const logPortalFilter = document.getElementById("logPortalFilter");
const logStatusPills = Array.from(document.querySelectorAll("#logStatusPills .pill-btn"));
const logRefreshBtn = document.getElementById("logRefreshBtn");
const logClearBtn = document.getElementById("logClearBtn");
const logTableWrap = document.getElementById("logTableWrap");

let currentSettings = null;
let activeTab = "captcha";
let licenseUnlocked = false;
let cachedSamples = [];
let cachedLogs = [];
let editingSampleId = null;
let logStatusFilter = "all";

const PORTAL_NAMES = {
  hddt: "HĐĐT",
  tdt: "Thuế ĐT",
  dvc: "DVC Thuế",
  tracuunnt: "Tra cứu NNT",
};

function switchTab(nextTab) {
  if (!licenseUnlocked) return;
  activeTab = nextTab;
  panelActivate.classList.add("hidden");
  for (const btn of tabButtons) {
    const isMatch = btn.dataset.tab === nextTab;
    btn.classList.toggle("active", isMatch);
    btn.setAttribute("aria-selected", isMatch ? "true" : "false");
  }
  for (const [id, el] of Object.entries(panels)) {
    el.classList.toggle("hidden", id !== nextTab);
  }
  if (nextTab === "dataset") loadDatasetTab();
  if (nextTab === "logs") loadLogsTab();
  if (nextTab === "config") loadMemoryStats();
}

for (const btn of tabButtons) {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
}
goConfigBtn.addEventListener("click", () => switchTab("config"));

function syncModeVisibility(mode) {
  const isProxy = mode === "proxy";
  directFields.classList.toggle("hidden", isProxy);
  proxyFields.classList.toggle("hidden", !isProxy);
}

function renderConnectionSummary(settings) {
  const isProxy = settings.connectionMode === "proxy";
  const hasKey = Boolean(settings.geminiApiKey);
  const hasProxy = Boolean(settings.apiBaseUrl);

  if (!isProxy && !hasKey) {
    connBanner.className = "alert-warn";
    connBannerText.textContent = "Chưa nhập Gemini API Key (HĐĐT SVG vẫn chạy <5ms)";
    activeModeChip.textContent = "Chưa gắn API Key";
  } else if (isProxy && !hasProxy) {
    connBanner.className = "alert-warn";
    connBannerText.textContent = "Chưa nhập URL Backend Proxy";
    activeModeChip.textContent = "Proxy (chưa có URL)";
  } else {
    connBanner.className = "hidden";
    activeModeChip.textContent = isProxy ? "Qua Proxy" : "Độc lập (Gemini Key)";
  }
}

async function readSettingsDirect() {
  try {
    currentSettings = await chrome.runtime.sendMessage({ type: "TAXCAP_GET_SETTINGS" });
  } catch {
    currentSettings = null;
  }
  if (!currentSettings) {
    const res = await chrome.storage.local.get(SETTINGS_KEY);
    const saved = res[SETTINGS_KEY] || {};
    const defaults = self.TAXCAP_DEFAULTS || {
      connectionMode: "direct",
      geminiApiKey: "",
      apiBaseUrl: "",
      accessToken: "",
      enabled: true,
      pausedUntil: 0,
      portals: {},
    };
    currentSettings = {
      ...defaults,
      ...saved,
      portals: { ...(defaults.portals || {}), ...(saved.portals || {}) },
    };
  }
  return currentSettings;
}

async function loadMemoryStats() {
  try {
    const mem = await chrome.runtime.sendMessage({ type: "TAXCAP_GET_MEMORY_STATS" });
    if (mem?.ok) {
      const learned = mem.learnedCount || 0;
      const exact = mem.exactCount || 0;
      memoryStatsText.textContent = `Trí nhớ cục bộ: ${learned} mẫu học · ${exact} ảnh nhớ`;
      clearMemoryBtn.classList.toggle("hidden", learned === 0 && exact === 0);
    }
  } catch {
    // ignore
  }
}

function renderLicenseUi(licStatus) {
  const lic = licStatus?.license || {};
  const evalState = licStatus?.evaluation || { unlocked: false, reason: "UNACTIVATED" };
  const deviceId = licStatus?.deviceId || "—";
  const presetUrl = lic.licenseApiUrl || licStatus?.defaultApiUrl || self.TAXCAP_DEFAULTS?.licenseApiUrl || "";

  licenseUnlocked = Boolean(evalState.unlocked);
  activateDeviceId.textContent = deviceId;

  for (const btn of tabButtons) {
    btn.disabled = !licenseUnlocked;
  }
  enabledToggleWrap.classList.toggle("hidden", !licenseUnlocked);
  lockHeaderPill.classList.toggle("hidden", licenseUnlocked);

  if (!licenseUnlocked) {
    const pillLabel =
      evalState.reason === "LOCKED"
        ? "Đã khóa"
        : evalState.reason === "EXPIRED"
          ? "Hết hạn"
          : evalState.reason === "DAILY_LIMIT"
            ? "Hết lượt"
            : "Chưa kích hoạt";
    lockHeaderPill.textContent = pillLabel;

    for (const el of Object.values(panels)) {
      el.classList.add("hidden");
    }
    panelActivate.classList.remove("hidden");

    activateKeyInput.value = lic.licenseKey || "";
    if (presetUrl) {
      activateUrlDirectWrap.classList.add("hidden");
      activateUrlDetails.classList.remove("hidden");
      activateApiPresetInput.value = presetUrl;
    } else {
      activateUrlDirectWrap.classList.remove("hidden");
      activateUrlDetails.classList.add("hidden");
      activateApiInput.value = "";
    }

    if (evalState.reason && evalState.reason !== "UNACTIVATED") {
      activateAlert.classList.remove("hidden");
      activateAlertText.textContent = evalState.message || "Mã kích hoạt không hợp lệ.";
    } else {
      activateAlert.classList.add("hidden");
    }
    return;
  }

  panelActivate.classList.add("hidden");
  licUserName.textContent = lic.userName || "Người dùng TaxCap";
  licCodeText.textContent = lic.licenseKey || "—";
  licBadge.textContent = "Đang hoạt động";
  licBadge.className = "badge verified";
  licExpires.textContent =
    !lic.expiresAt || lic.expiresAt === "FOREVER" ? "Vĩnh viễn" : lic.expiresAt;
  licDevices.textContent = `${lic.deviceCount || 1}/${lic.maxDevices || 1} máy`;
  const used = Number(evalState.effectiveUsedToday) || 0;
  licUsageToday.textContent =
    lic.dailyLimit > 0 ? `${used}/${lic.dailyLimit}` : `${used} (Không giới hạn)`;
  const minsLeft = Math.max(0, Math.ceil((evalState.msUntilRefresh || 0) / 60000));
  const pendingCount = Number(lic.pendingUsageDelta) || 0;
  licSyncInfo.textContent =
    minsLeft > 0
      ? `~${minsLeft}p nữa${pendingCount > 0 ? ` (+${pendingCount})` : ""}`
      : "Sắp đồng bộ";

  switchTab(activeTab || "captcha");
}

async function loadLicenseStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "TAXCAP_LICENSE_STATUS" });
    if (res?.ok) {
      renderLicenseUi(res);
      return;
    }
  } catch {
    // ignore
  }
  renderLicenseUi({
    license: {},
    evaluation: { unlocked: false, reason: "UNACTIVATED" },
    defaultApiUrl: self.TAXCAP_DEFAULTS?.licenseApiUrl || "",
  });
}

async function loadState() {
  await readSettingsDirect();
  enabledToggle.checked = Boolean(currentSettings.enabled);
  enabledLabel.textContent = currentSettings.enabled ? "Đang bật" : "Đang tắt";

  const mode = currentSettings.connectionMode === "proxy" ? "proxy" : "direct";
  connectionModeSelect.value = mode;
  syncModeVisibility(mode);
  renderConnectionSummary(currentSettings);

  speedModeSelect.value = currentSettings.speedMode === "accurate" ? "accurate" : "fast";
  if (enhanceToggle) enhanceToggle.checked = currentSettings.enhanceImage !== false;
  geminiKeyInput.value = currentSettings.geminiApiKey || "";
  apiBaseInput.value = currentSettings.apiBaseUrl || "";
  tokenInput.value = currentSettings.accessToken || "";

  for (const box of portalBoxes) {
    const id = box.getAttribute("data-portal");
    box.checked = currentSettings.portals?.[id] !== false;
  }

  const remainingMs = (currentSettings.pausedUntil || 0) - Date.now();
  if (remainingMs > 0) {
    const mins = Math.ceil(remainingMs / 60000);
    pauseStatus.textContent = `Đang tạm dừng (còn ~${mins} phút)`;
  } else {
    pauseStatus.textContent = "";
  }

  const today = new Date().toISOString().slice(0, 10);
  const statsRes = await chrome.storage.local.get(STATS_KEY);
  const stats = statsRes[STATS_KEY];
  if (stats && stats.date === today) {
    statSolved.textContent = String(stats.solved || 0);
    statFailed.textContent = String(stats.failed || 0);
  }

  await loadMemoryStats();
  await loadLicenseStatus();
}

async function saveSettings(patch) {
  currentSettings = {
    ...currentSettings,
    ...patch,
    portals: {
      ...(currentSettings?.portals || {}),
      ...(patch.portals || {}),
    },
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: currentSettings });
  await loadState();
}

function collectConfigFields() {
  return {
    connectionMode: connectionModeSelect.value === "proxy" ? "proxy" : "direct",
    geminiApiKey: geminiKeyInput.value.trim().replace(/^["']+|["']+$/g, ""),
    apiBaseUrl: apiBaseInput.value.trim().replace(/\/+$/, ""),
    accessToken: tokenInput.value.trim(),
  };
}

enabledToggle.addEventListener("change", () => {
  saveSettings({ enabled: enabledToggle.checked, pausedUntil: 0 });
});

for (const box of portalBoxes) {
  box.addEventListener("change", () => {
    const id = box.getAttribute("data-portal");
    saveSettings({ portals: { [id]: box.checked } });
  });
}

pause15Btn.addEventListener("click", () => {
  saveSettings({ pausedUntil: Date.now() + 15 * 60 * 1000 });
});

resumeBtn.addEventListener("click", () => {
  saveSettings({ enabled: true, pausedUntil: 0 });
});

speedModeSelect.addEventListener("change", () => {
  saveSettings({ speedMode: speedModeSelect.value === "accurate" ? "accurate" : "fast" });
});

if (enhanceToggle) {
  enhanceToggle.addEventListener("change", () => {
    saveSettings({ enhanceImage: enhanceToggle.checked });
  });
}

connectionModeSelect.addEventListener("change", () => {
  const mode = connectionModeSelect.value === "proxy" ? "proxy" : "direct";
  syncModeVisibility(mode);
  saveSettings({ connectionMode: mode });
});

toggleKeyBtn.addEventListener("click", () => {
  const isPwd = geminiKeyInput.type === "password";
  geminiKeyInput.type = isPwd ? "text" : "password";
  toggleKeyBtn.textContent = isPwd ? "Ẩn" : "Hiện";
});

clearMemoryBtn.addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "TAXCAP_CLEAR_MEMORY" });
    await loadMemoryStats();
    pingStatus.className = "status ok";
    pingStatus.textContent = "Đã xóa trí nhớ cục bộ.";
  } catch {
    // ignore
  }
});

saveBtn.addEventListener("click", async () => {
  await saveSettings(collectConfigFields());
  pingStatus.className = "status ok";
  pingStatus.textContent = "Đã lưu cấu hình.";
});

pingBtn.addEventListener("click", async () => {
  pingStatus.className = "status";
  pingStatus.textContent = "Đang kiểm tra kết nối...";
  const fields = collectConfigFields();
  await saveSettings(fields);

  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: "TAXCAP_PING" });
  } catch {
    res = null;
  }

  if (!res) {
    res = { ok: false, message: "Không liên hệ được Service Worker." };
  }

  if (res?.ok && res?.tokenValid === false) {
    pingStatus.className = "status err";
    pingStatus.textContent = "Kết nối được Proxy nhưng sai Mã truy cập nhóm.";
  } else if (res?.ok && res?.mode === "direct") {
    pingStatus.className = "status ok";
    pingStatus.textContent = `Kết nối Gemini trực tiếp tốt (${res.model || "Flash Lite"}).`;
  } else if (res?.ok) {
    pingStatus.className = "status ok";
    pingStatus.textContent = `Kết nối Proxy tốt (${res.model || "Gemini Flash"}).`;
  } else {
    pingStatus.className = "status err";
    pingStatus.textContent = res?.message || "Kiểm tra kết nối thất bại.";
  }
});

// --- TAB 3: KHO DỮ LIỆU ---
function renderPortalCards(byPortal, portalHints) {
  dsPortalsGrid.innerHTML = "";
  for (const item of byPortal || []) {
    const pct = Math.min(100, Math.round((item.usable / 500) * 100));
    const card = document.createElement("div");
    card.className = "portal-card";

    const head = document.createElement("div");
    head.className = "portal-head";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = item.shortName || PORTAL_NAMES[item.portal] || item.portal;
    const countSpan = document.createElement("span");
    countSpan.className = "mono";
    countSpan.textContent = `${item.usable}/500`;
    head.append(nameSpan, countSpan);

    const track = document.createElement("div");
    track.className = "progress-track";
    const fill = document.createElement("div");
    fill.className = "progress-fill";
    fill.style.width = `${pct}%`;
    track.appendChild(fill);

    const meta = document.createElement("div");
    meta.className = "portal-meta";
    const totalSpan = document.createElement("span");
    totalSpan.textContent = `Ảnh: ${item.total}`;
    const accSpan = document.createElement("span");
    accSpan.textContent = `Đúng: ${item.accuracyPercent === null ? "—" : `${item.accuracyPercent}%`}`;
    meta.append(totalSpan, accSpan);

    card.append(head, track, meta);

    const hints = portalHints?.[item.portal];
    if (hints?.confusions?.length) {
      const conf = document.createElement("div");
      conf.className = "portal-confusion";
      conf.textContent = hints.confusions
        .slice(0, 2)
        .map((c) => `${c.from}→${c.to}(${c.count}x)`)
        .join(" ");
      card.appendChild(conf);
    }

    dsPortalsGrid.appendChild(card);
  }
}

function renderSampleList() {
  const filter = dsPortalFilter.value;
  const items = filter === "all" ? cachedSamples : cachedSamples.filter((s) => s.portal === filter);
  dsSampleList.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-box";
    empty.textContent = "Chưa có mẫu captcha nào. Mở cổng Thuế để Extension tự ghi nhận ảnh tại đây.";
    dsSampleList.appendChild(empty);
    return;
  }

  for (const sample of items.slice(0, 30)) {
    const row = document.createElement("div");
    row.className = "sample-item";

    if (sample.imageDataUrl) {
      const img = document.createElement("img");
      img.className = "sample-thumb";
      img.src = sample.imageDataUrl;
      img.alt = "Captcha";
      row.appendChild(img);
    } else {
      const emptyImg = document.createElement("div");
      emptyImg.className = "sample-thumb-empty";
      emptyImg.textContent = "Không ảnh";
      row.appendChild(emptyImg);
    }

    const body = document.createElement("div");
    body.className = "sample-body";

    const topLine = document.createElement("div");
    topLine.style.display = "flex";
    topLine.style.alignItems = "center";
    topLine.style.gap = "6px";

    const codeSpan = document.createElement("span");
    codeSpan.className = "sample-code";
    codeSpan.textContent = sample.finalLabel || sample.predicted || "—";
    topLine.appendChild(codeSpan);

    const badge = document.createElement("span");
    badge.className = `badge ${sample.outcome || "pending"}`;
    badge.textContent =
      sample.outcome === "verified"
        ? "Đúng"
        : sample.outcome === "corrected"
          ? "Đã sửa"
          : sample.outcome === "rejected"
            ? "Bỏ"
            : "Chờ nhãn";
    topLine.appendChild(badge);

    const subLine = document.createElement("div");
    subLine.className = "sample-sub";
    const timeStr = sample.timestamp ? new Date(sample.timestamp).toLocaleTimeString("vi-VN") : "";
    const predNote =
      sample.outcome === "corrected" && sample.predicted ? ` · AI: ${sample.predicted}` : "";
    subLine.textContent = `${PORTAL_NAMES[sample.portal] || sample.portal} · ${sample.source || "gemini"} · ${sample.latencyMs}ms · ${timeStr}${predNote}`;

    body.append(topLine, subLine);
    row.appendChild(body);

    if (editingSampleId === sample.sampleId) {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "edit-input";
      input.value = sample.finalLabel || sample.predicted || "";

      const saveEditBtn = document.createElement("button");
      saveEditBtn.type = "button";
      saveEditBtn.className = "primary sm";
      saveEditBtn.textContent = "Lưu";
      saveEditBtn.addEventListener("click", async () => {
        const val = input.value.trim();
        if (val.length < 2) return;
        await chrome.runtime.sendMessage({
          type: "TAXCAP_POPUP_UPDATE_SAMPLE",
          sampleId: sample.sampleId,
          finalLabel: val,
        });
        editingSampleId = null;
        await loadDatasetTab();
      });
      row.append(input, saveEditBtn);
    } else {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "sm";
      editBtn.textContent = "Sửa";
      editBtn.addEventListener("click", () => {
        editingSampleId = sample.sampleId;
        renderSampleList();
      });
      row.appendChild(editBtn);
    }

    dsSampleList.appendChild(row);
  }
}

async function loadDatasetTab() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "TAXCAP_GET_DATASET" });
    if (!res?.ok) return;
    const s = res.summary || {};
    dsTotal.textContent = String(s.total || 0);
    dsUsable.textContent = String(s.usable || 0);
    dsAccuracy.textContent = s.accuracyPercent === null || s.accuracyPercent === undefined ? "—" : `${s.accuracyPercent}%`;
    dsPending.textContent = String((s.pending || 0) + (s.rejected || 0));
    cachedSamples = Array.isArray(res.samples) ? res.samples : [];
    renderPortalCards(s.byPortal, res.portalHints);
    renderSampleList();
  } catch {
    // ignore
  }
}

dsPortalFilter.addEventListener("change", renderSampleList);
dsRefreshBtn.addEventListener("click", loadDatasetTab);
dsExportBtn.addEventListener("click", () => {
  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), samples: cachedSamples }, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `taxcap-dataset-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
dsClearBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "TAXCAP_CLEAR_DATASET" });
  editingSampleId = null;
  await loadDatasetTab();
  await loadMemoryStats();
});

// --- TAB 4: NHẬT KÝ ---
function renderLogsTable() {
  const portalFilter = logPortalFilter.value;
  const rows = cachedLogs.filter((item) => {
    if (portalFilter !== "all" && item.portal !== portalFilter) return false;
    if (logStatusFilter !== "all" && item.status !== logStatusFilter) return false;
    return true;
  });

  logTableWrap.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-box";
    empty.textContent = "Chưa có lượt giải captcha nào được ghi nhận.";
    logTableWrap.appendChild(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "log-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Giờ</th>
        <th>Cổng</th>
        <th>TT</th>
        <th>Mã</th>
        <th>Trễ</th>
        <th>Chi tiết</th>
      </tr>
    </thead>
  `;
  const tbody = document.createElement("tbody");

  for (const item of rows.slice(0, 50)) {
    const tr = document.createElement("tr");

    const tdTime = document.createElement("td");
    tdTime.className = "mono";
    tdTime.textContent = item.timestamp ? new Date(item.timestamp).toLocaleTimeString("vi-VN") : "";

    const tdPortal = document.createElement("td");
    tdPortal.textContent = PORTAL_NAMES[item.portal] || item.portal;

    const tdStatus = document.createElement("td");
    tdStatus.style.fontWeight = "600";
    tdStatus.style.color = item.status === "ok" ? "#15803d" : "#b91c1c";
    tdStatus.textContent = item.status === "ok" ? "OK" : "Lỗi";

    const tdCode = document.createElement("td");
    tdCode.className = "mono";
    tdCode.textContent = item.codeMasked || "—";

    const tdLat = document.createElement("td");
    tdLat.className = "mono";
    tdLat.textContent = `${item.latencyMs || 0}ms`;

    const tdMsg = document.createElement("td");
    tdMsg.textContent = item.message || "";

    tr.append(tdTime, tdPortal, tdStatus, tdCode, tdLat, tdMsg);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  logTableWrap.appendChild(table);
}

async function loadLogsTab() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "TAXCAP_GET_LOGS" });
    if (!res?.ok) return;
    const st = res.stats || {};
    logTotal.textContent = String(st.total || 0);
    logOk.textContent = String(st.successCount || 0);
    logErr.textContent = String(st.errorCount || 0);
    logLatency.textContent = `${st.avgLatencyMs || 0} ms`;
    cachedLogs = Array.isArray(res.logs) ? res.logs : [];
    renderLogsTable();
  } catch {
    // ignore
  }
}

logPortalFilter.addEventListener("change", renderLogsTable);
for (const pill of logStatusPills) {
  pill.addEventListener("click", () => {
    logStatusFilter = pill.dataset.status || "all";
    for (const p of logStatusPills) {
      p.classList.toggle("active", p === pill);
    }
    renderLogsTable();
  });
}
logRefreshBtn.addEventListener("click", loadLogsTab);
logClearBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "TAXCAP_CLEAR_LOGS" });
  await loadLogsTab();
});

activateBtn.addEventListener("click", async () => {
  const key = activateKeyInput.value.trim().toUpperCase();
  const url = activateUrlDirectWrap.classList.contains("hidden")
    ? activateApiPresetInput.value.trim()
    : activateApiInput.value.trim();

  if (!key) {
    activateStatus.className = "status err";
    activateStatus.textContent = "Hãy nhập Mã kích hoạt.";
    return;
  }
  if (!url) {
    activateStatus.className = "status err";
    activateStatus.textContent = "Hãy nhập URL Google Apps Script Web App.";
    return;
  }

  activateBtn.disabled = true;
  activateStatus.className = "status";
  activateStatus.textContent = "Đang xác thực với Google Sheets...";
  try {
    const res = await chrome.runtime.sendMessage({
      type: "TAXCAP_LICENSE_ACTIVATE",
      licenseKey: key,
      licenseApiUrl: url,
    });
    if (res?.ok) {
      activateStatus.className = "status ok";
      activateStatus.textContent = "Kích hoạt thành công!";
      activeTab = "captcha";
      renderLicenseUi(res);
    } else {
      activateStatus.className = "status err";
      activateStatus.textContent = res?.message || "Mã kích hoạt không hợp lệ.";
      renderLicenseUi(res);
    }
  } catch {
    activateStatus.className = "status err";
    activateStatus.textContent = "Không liên hệ được Service Worker.";
  } finally {
    activateBtn.disabled = false;
  }
});

licRefreshBtn.addEventListener("click", async () => {
  licActionStatus.className = "status";
  licActionStatus.textContent = "Đang đồng bộ Google Sheets...";
  licRefreshBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: "TAXCAP_LICENSE_REFRESH" });
    renderLicenseUi(res);
    licActionStatus.className = res?.ok ? "status ok" : "status err";
    licActionStatus.textContent = res?.message || (res?.ok ? "Đã đồng bộ." : "Lỗi đồng bộ.");
  } finally {
    licRefreshBtn.disabled = false;
  }
});

licDeactivateBtn.addEventListener("click", async () => {
  licActionStatus.className = "status";
  licActionStatus.textContent = "Đang gỡ thiết bị khỏi Google Sheets...";
  licDeactivateBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: "TAXCAP_LICENSE_DEACTIVATE" });
    activateStatus.textContent = "";
    renderLicenseUi(res);
  } finally {
    licDeactivateBtn.disabled = false;
  }
});

loadState();
