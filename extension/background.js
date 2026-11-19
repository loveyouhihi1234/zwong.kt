importScripts("config.js", "direct-gemini.js", "license.js");

const SETTINGS_KEY = "taxcapSettings";
const STATS_KEY = "taxcapStats";
const MEMORY_KEY = "taxcapMemory";
const SAMPLES_KEY = "taxcapSamples";
const LOGS_KEY = "taxcapLogs";
const LICENSE_KEY = "taxcapLicense";
const DEVICE_ID_KEY = "taxcapDeviceId";
const PENDING_SOLVES_KEY = "taxcapPendingSolves";
const PAUSE_ALARM = "taxcap-resume";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const pendingMemoryMap = new Map();
let inFlightLicenseSync = null;

// Mở Side Panel khi bấm icon (dự phòng mở cửa sổ riêng cho Chrome cũ / Cốc Cốc)
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} else if (chrome.action?.onClicked) {
  chrome.action.onClicked.addListener(() => {
    chrome.windows.create({
      url: chrome.runtime.getURL("sidepanel.html"),
      type: "popup",
      width: 460,
      height: 760,
    });
  });
}

function normalizeApiKey(raw) {
  return String(raw || "").trim().replace(/^["']+|["']+$/g, "");
}

function resolveConnectionMode(settings) {
  if (settings?.connectionMode === "proxy") return "proxy";
  if (settings?.connectionMode === "direct") return "direct";
  return settings?.apiBaseUrl ? "proxy" : "direct";
}

async function getSettings() {
  const res = await chrome.storage.local.get(SETTINGS_KEY);
  const saved = res[SETTINGS_KEY] || {};
  const merged = {
    ...self.TAXCAP_DEFAULTS,
    ...saved,
    portals: {
      ...self.TAXCAP_DEFAULTS.portals,
      ...(saved.portals || {}),
    },
  };
  merged.connectionMode = resolveConnectionMode(merged);
  merged.geminiApiKey = normalizeApiKey(merged.geminiApiKey);
  return merged;
}

async function ensureDeviceId() {
  const res = await chrome.storage.local.get(DEVICE_ID_KEY);
  if (res[DEVICE_ID_KEY]) return String(res[DEVICE_ID_KEY]);
  const generated = `dev_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await chrome.storage.local.set({ [DEVICE_ID_KEY]: generated });
  return generated;
}

async function loadLicenseState() {
  const res = await chrome.storage.local.get(LICENSE_KEY);
  const defaultApiUrl = self.TAXCAP_DEFAULTS?.licenseApiUrl || "";
  return self.TaxCapLicense.normalizeLicenseState(res[LICENSE_KEY], defaultApiUrl);
}

async function saveLicenseState(nextState) {
  await chrome.storage.local.set({ [LICENSE_KEY]: nextState });
}

async function postAppsScript(apiUrl, payload) {
  const cleanUrl = self.TaxCapLicense.normalizeLicenseApiUrl(apiUrl);
  if (!self.TaxCapLicense.isValidAppsScriptUrl(cleanUrl)) {
    return {
      ok: false,
      reason: "NO_API_URL",
      message: "URL Google Apps Script chưa đúng định dạng https://script.google.com/macros/s/.../exec",
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), 12000);
  try {
    const res = await fetch(cleanUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!data || typeof data !== "object") {
      return {
        ok: false,
        networkError: true,
        message: "Google Apps Script trả về dữ liệu không hợp lệ (kiểm tra quyền Deploy: Anyone).",
      };
    }
    return data;
  } catch {
    return {
      ok: false,
      networkError: true,
      message: "Không kết nối được Google Sheets (kiểm tra Internet hoặc URL Apps Script).",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function refreshLicenseIfNeeded(options = {}) {
  const force = Boolean(options.force);
  const current = await loadLicenseState();
  const licenseKey = self.TaxCapLicense.normalizeLicenseKey(options.licenseKey || current.licenseKey);
  const licenseApiUrl = self.TaxCapLicense.normalizeLicenseApiUrl(
    options.licenseApiUrl || current.licenseApiUrl || self.TAXCAP_DEFAULTS?.licenseApiUrl || "",
  );
  const localEval = self.TaxCapLicense.evaluateLocalLicense(current);

  if (!force && !localEval.needsRefresh) {
    return { state: current, evaluation: localEval };
  }
  if (!licenseKey || !licenseApiUrl) {
    const updated = !licenseApiUrl && licenseKey
      ? { ...current, licenseKey, lastError: "Chưa nhập URL Google Apps Script." }
      : current;
    return { state: updated, evaluation: self.TaxCapLicense.evaluateLocalLicense(updated) };
  }

  if (inFlightLicenseSync && !force) {
    return inFlightLicenseSync;
  }

  const run = (async () => {
    const deviceId = await ensureDeviceId();
    const sentDelta = current.licenseKey === licenseKey ? Math.max(0, Number(current.pendingUsageDelta) || 0) : 0;
    const serverRes = await postAppsScript(licenseApiUrl, {
      action: "verify",
      licenseKey,
      deviceId,
      delta: sentDelta,
    });
    const nextState = self.TaxCapLicense.applyServerVerifyResult(current, serverRes, {
      licenseKey,
      licenseApiUrl,
      deviceId,
      sentDelta,
      nowMs: Date.now(),
    });
    await saveLicenseState(nextState);
    const nextEval = self.TaxCapLicense.evaluateLocalLicense(nextState);
    await updateBadge(false);
    return { state: nextState, evaluation: nextEval, serverRes };
  })();

  inFlightLicenseSync = run;
  try {
    return await run;
  } finally {
    inFlightLicenseSync = null;
  }
}

async function ensureLicenseUnlocked() {
  const current = await loadLicenseState();
  const localEval = self.TaxCapLicense.evaluateLocalLicense(current);
  if (localEval.unlocked && !localEval.needsRefresh) {
    return { ok: true, state: current, evaluation: localEval };
  }
  if (!current.licenseKey) {
    return {
      ok: false,
      state: current,
      evaluation: localEval,
      message: "Chưa kích hoạt mã — bấm biểu tượng TaxCap để nhập mã.",
    };
  }
  const refreshed = await refreshLicenseIfNeeded({ force: false });
  if (refreshed.evaluation.unlocked) {
    return { ok: true, state: refreshed.state, evaluation: refreshed.evaluation };
  }
  return {
    ok: false,
    state: refreshed.state,
    evaluation: refreshed.evaluation,
    message: refreshed.evaluation.message || "Mã kích hoạt không hợp lệ.",
  };
}

async function recordLicensedSolve() {
  const current = await loadLicenseState();
  if (!current.licenseKey || !current.lastVerifyOk) return;
  const next = self.TaxCapLicense.incrementPendingUsage(current, 1, Date.now());
  await saveLicenseState(next);
  if (next.pendingUsageDelta >= self.TaxCapLicense.USAGE_SYNC_BATCH_SIZE) {
    refreshLicenseIfNeeded({ force: true }).catch(() => {});
  }
}

async function updateBadge(hasError = false) {
  const lic = await loadLicenseState().catch(() => null);
  const licEval = lic ? self.TaxCapLicense.evaluateLocalLicense(lic) : { unlocked: false };
  if (!licEval.unlocked) {
    await chrome.action.setBadgeText({ text: "KEY" }).catch(() => {});
    await chrome.action.setBadgeBackgroundColor({ color: "#b45309" }).catch(() => {});
    return;
  }
  const settings = await getSettings();
  const isPaused = !settings.enabled || Date.now() < (settings.pausedUntil || 0);
  if (hasError) {
    await chrome.action.setBadgeText({ text: "!" }).catch(() => {});
    await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" }).catch(() => {});
    return;
  }
  if (isPaused) {
    await chrome.action.setBadgeText({ text: "||" }).catch(() => {});
    await chrome.action.setBadgeBackgroundColor({ color: "#64748b" }).catch(() => {});
    return;
  }
  await chrome.action.setBadgeText({ text: "" }).catch(() => {});
}

async function bumpStats(ok) {
  const today = new Date().toISOString().slice(0, 10);
  const res = await chrome.storage.local.get(STATS_KEY);
  const prev =
    res[STATS_KEY] && res[STATS_KEY].date === today
      ? res[STATS_KEY]
      : { date: today, solved: 0, failed: 0 };
  if (ok) prev.solved += 1;
  else prev.failed += 1;
  await chrome.storage.local.set({ [STATS_KEY]: prev });
}

async function loadLocalMemory() {
  const res = await chrome.storage.local.get(MEMORY_KEY);
  return self.TaxCapDirect.normalizeMemoryState(res[MEMORY_KEY]);
}

async function saveLocalMemory(nextState) {
  await chrome.storage.local.set({ [MEMORY_KEY]: nextState });
}

async function loadSamples() {
  const res = await chrome.storage.local.get(SAMPLES_KEY);
  return Array.isArray(res[SAMPLES_KEY]) ? res[SAMPLES_KEY] : [];
}

async function saveSamples(samples) {
  await chrome.storage.local.set({ [SAMPLES_KEY]: samples });
}

async function appendSampleRecord(entry) {
  const prev = await loadSamples();
  const next = self.TaxCapDirect.recordSampleInDataset(prev, entry);
  await saveSamples(next);
}

async function loadLogs() {
  const res = await chrome.storage.local.get(LOGS_KEY);
  return Array.isArray(res[LOGS_KEY]) ? res[LOGS_KEY] : [];
}

async function pushSolveLog(params) {
  const prev = await loadLogs();
  const entry = self.TaxCapDirect.createLogEntry(params);
  const next = self.TaxCapDirect.appendSolveLog(prev, entry);
  await chrome.storage.local.set({ [LOGS_KEY]: next });
}

function summarizeMemory(state) {
  const exactCount = Object.keys(state?.exactHashes || {}).length;
  const learnedCount = Number(state?.stats?.learnedCount) || 0;
  const correctedCount = Number(state?.stats?.correctedCount) || 0;
  return { exactCount, learnedCount, correctedCount };
}

async function savePendingSolve(sampleId, record) {
  pendingMemoryMap.set(sampleId, record);
  if (pendingMemoryMap.size > 20) {
    const oldest = pendingMemoryMap.keys().next().value;
    if (oldest) pendingMemoryMap.delete(oldest);
  }
  try {
    if (chrome.storage.session) {
      const res = await chrome.storage.session.get(PENDING_SOLVES_KEY);
      const list = Array.isArray(res[PENDING_SOLVES_KEY]) ? res[PENDING_SOLVES_KEY] : [];
      const next = [{ sampleId, ...record }, ...list.filter((x) => x.sampleId !== sampleId)].slice(0, 12);
      await chrome.storage.session.set({ [PENDING_SOLVES_KEY]: next });
    }
  } catch {
    // ignore
  }
}

async function takePendingSolve(sampleId) {
  const mem = pendingMemoryMap.get(sampleId);
  if (mem) {
    pendingMemoryMap.delete(sampleId);
    return mem;
  }
  try {
    if (chrome.storage.session) {
      const res = await chrome.storage.session.get(PENDING_SOLVES_KEY);
      const list = Array.isArray(res[PENDING_SOLVES_KEY]) ? res[PENDING_SOLVES_KEY] : [];
      const found = list.find((x) => x.sampleId === sampleId);
      if (found) {
        await chrome.storage.session.set({
          [PENDING_SOLVES_KEY]: list.filter((x) => x.sampleId !== sampleId),
        });
        return found;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function isAisDevPreviewUrl(url) {
  return /^https:\/\/ais-dev-/i.test(String(url || "").trim());
}

async function solveDirectGemini(portal, image, bypassCache, settings) {
  const started = Date.now();
  const parsed = self.TaxCapDirect.parseImageDataUrl(image);
  if (!parsed) {
    await bumpStats(false);
    await updateBadge(false);
    await pushSolveLog({
      portal,
      status: "error",
      latencyMs: Date.now() - started,
      message: "Ảnh captcha không hợp lệ",
    });
    return { ok: false, message: "Ảnh captcha không hợp lệ" };
  }

  const imageHash = self.TaxCapDirect.hashBase64Quick(`${parsed.mimeType}:${parsed.data}`);
  const memoryState = await loadLocalMemory();

  if (!bypassCache) {
    const cachedLabel = self.TaxCapDirect.getExactMemoryMatch(memoryState, portal, imageHash);
    if (cachedLabel) {
      const sampleId = `local:${crypto.randomUUID()}`;
      const latencyMs = Math.max(1, Date.now() - started);
      await savePendingSolve(sampleId, {
        portal,
        predicted: cachedLabel,
        imageHash,
        mimeType: parsed.mimeType,
        base64Data: parsed.data,
      });
      await appendSampleRecord({
        sampleId,
        portal,
        source: "memory-local",
        predicted: cachedLabel,
        latencyMs,
        imageDataUrl: image,
        imageHash,
      });
      await pushSolveLog({
        portal,
        status: "ok",
        code: cachedLabel,
        latencyMs,
        message: "Trí nhớ cục bộ (<5ms)",
      });
      await bumpStats(true);
      await updateBadge(false);
      return {
        ok: true,
        captcha: cachedLabel,
        sampleId,
        source: "memory-local",
        latencyMs,
      };
    }
  }

  const apiKey = normalizeApiKey(settings.geminiApiKey);
  if (!apiKey) {
    const latencyMs = Date.now() - started;
    await bumpStats(false);
    await updateBadge(true);
    await pushSolveLog({
      portal,
      status: "error",
      latencyMs,
      message: "Chưa nhập Gemini API Key",
    });
    return {
      ok: false,
      network: true,
      message: "Chưa nhập Gemini API Key — mở tab Cấu hình để dán key",
    };
  }

  const speedMode = settings.speedMode === "accurate" ? "accurate" : "fast";
  const model = self.TaxCapDirect.resolveDirectModel(speedMode);
  const hints = self.TaxCapDirect.getAdaptiveHints(memoryState, portal);
  const fewShots = self.TaxCapDirect.getFewShotExamples(memoryState, portal, {
    speedMode,
    bypassCache,
  });
  const body = self.TaxCapDirect.buildGeminiRequestBody({
    portal,
    parsedImage: parsed,
    speedMode,
    hints,
    fewShots,
  });

  const attempt = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), 15000);
    try {
      const response = await fetch(`${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errMsg = String(data?.error?.message || "");
        const isInvalidKey =
          response.status === 400 ||
          response.status === 401 ||
          response.status === 403 ||
          /API[_\s]?KEY|PERMISSION_DENIED|UNAUTHENTICATED/i.test(errMsg);
        if (isInvalidKey) {
          return {
            ok: false,
            retryable: false,
            network: true,
            message: "Gemini API Key chưa hợp lệ — mở tab Cấu hình để kiểm tra",
          };
        }
        if (response.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(errMsg)) {
          return {
            ok: false,
            retryable: false,
            network: false,
            message: "Hết hạn mức Gemini API (429) — chờ vài giây rồi thử lại",
          };
        }
        return {
          ok: false,
          retryable: response.status >= 500,
          network: response.status >= 500,
          message: `Lỗi Gemini API (${response.status})`,
        };
      }

      const captcha = self.TaxCapDirect.extractGeminiCaptchaText(data);
      if (!captcha) {
        return {
          ok: false,
          retryable: false,
          message: "Không đọc được, bấm thử lại",
        };
      }

      const sampleId = `local:${crypto.randomUUID()}`;
      const latencyMs = Date.now() - started;
      await savePendingSolve(sampleId, {
        portal,
        predicted: captcha,
        imageHash,
        mimeType: parsed.mimeType,
        base64Data: parsed.data,
      });
      await appendSampleRecord({
        sampleId,
        portal,
        source: model,
        predicted: captcha,
        latencyMs,
        imageDataUrl: image,
        imageHash,
      });

      return {
        ok: true,
        captcha,
        sampleId,
        source: "direct-gemini",
        latencyMs,
        learnedCount: hints?.usableCount || 0,
        fewShotCount: fewShots.length,
      };
    } catch {
      return {
        ok: false,
        retryable: true,
        network: true,
        message: "Không kết nối được tới Google Gemini API",
      };
    } finally {
      clearTimeout(timer);
    }
  };

  let result = await attempt();
  if (!result.ok && result.retryable) {
    await new Promise((r) => setTimeout(r, 650));
    result = await attempt();
  }

  const latencyMs = result.latencyMs || Date.now() - started;
  if (result.ok) {
    const modeLabel = speedMode === "accurate" ? "Flash 4" : "Flash Lite";
    const enhanceTag = settings.enhanceImage !== false ? " · Làm nét" : "";
    const learnedTag = result.learnedCount > 0 ? ` · Học ${result.learnedCount} mẫu` : "";
    const fsTag = result.fewShotCount > 0 ? ` · ${result.fewShotCount} ảnh mẫu` : "";
    await pushSolveLog({
      portal,
      status: "ok",
      code: result.captcha,
      latencyMs,
      message: `Đọc thành công (${modeLabel}${enhanceTag}${learnedTag}${fsTag})`,
    });
  } else {
    await pushSolveLog({
      portal,
      status: "error",
      latencyMs,
      message: result.message || "Lỗi đọc Gemini",
    });
  }

  await bumpStats(result.ok);
  await updateBadge(Boolean(result.network));
  return result;
}

async function callSolveProxy(portal, image, bypassCache, settings) {
  const started = Date.now();
  const baseUrl = String(settings.apiBaseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) {
    return { ok: false, message: "Chưa cấu hình URL Backend Proxy" };
  }
  if (isAisDevPreviewUrl(baseUrl)) {
    return {
      ok: false,
      message: "URL ais-dev bị khóa cookie AI Studio — hãy chuyển sang chế độ Độc lập (API Key)",
    };
  }

  const speedMode = settings.speedMode === "accurate" ? "accurate" : "fast";
  const enhanced = settings.enhanceImage !== false;
  const headers = { "Content-Type": "application/json" };
  if (settings.accessToken) {
    headers["X-Extension-Token"] = settings.accessToken;
  }

  const attempt = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), 12000);
    try {
      const response = await fetch(`${baseUrl}/api/captcha/solve`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          portal,
          image,
          speedMode,
          enhanced,
          bypassCache: Boolean(bypassCache),
        }),
        signal: controller.signal,
      });
      const ct = response.headers.get("content-type") || "";
      if (response.redirected || !ct.includes("application/json")) {
        return {
          ok: false,
          retryable: false,
          network: true,
          message: "Proxy bị chặn bởi trang xác thực (nên chuyển sang chế độ Độc lập)",
        };
      }
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok && data.captcha) {
        return {
          ok: true,
          captcha: data.captcha,
          sampleId: data.sampleId || "",
          latencyMs: data.latencyMs,
          source: data.source || "proxy",
        };
      }
      return {
        ok: false,
        status: response.status,
        retryable: response.status >= 500,
        message: data.message || `Lỗi máy chủ (${response.status})`,
      };
    } catch {
      return {
        ok: false,
        retryable: true,
        network: true,
        message: "Không kết nối được Backend Proxy",
      };
    } finally {
      clearTimeout(timer);
    }
  };

  let result = await attempt();
  if (!result.ok && result.retryable) {
    await new Promise((r) => setTimeout(r, 650));
    result = await attempt();
  }

  const latencyMs = result.latencyMs || Date.now() - started;
  if (result.ok) {
    const parsed = self.TaxCapDirect.parseImageDataUrl(image);
    const imageHash = parsed
      ? self.TaxCapDirect.hashBase64Quick(`${parsed.mimeType}:${parsed.data}`)
      : "";
    if (result.sampleId) {
      await appendSampleRecord({
        sampleId: result.sampleId,
        portal,
        source: result.source || "proxy",
        predicted: result.captcha,
        latencyMs,
        imageDataUrl: image,
        imageHash,
      });
    }
    await pushSolveLog({
      portal,
      status: "ok",
      code: result.captcha,
      latencyMs,
      message: `Proxy đọc thành công (${result.source || "gemini"})`,
    });
  } else {
    await pushSolveLog({
      portal,
      status: "error",
      latencyMs,
      message: result.message || "Lỗi Backend Proxy",
    });
  }

  await bumpStats(result.ok);
  await updateBadge(Boolean(result.network));
  return result;
}

async function handleSolve(portal, image, bypassCache = false) {
  const gate = await ensureLicenseUnlocked();
  if (!gate.ok) {
    return {
      ok: false,
      licenseLocked: true,
      message: gate.message,
    };
  }
  const settings = await getSettings();
  const result =
    settings.connectionMode === "proxy"
      ? await callSolveProxy(portal, image, bypassCache, settings)
      : await solveDirectGemini(portal, image, bypassCache, settings);
  if (result?.ok) {
    await recordLicensedSolve();
  }
  return result;
}

chrome.runtime.onInstalled.addListener(async () => {
  const res = await chrome.storage.local.get(SETTINGS_KEY);
  const saved = res[SETTINGS_KEY];
  if (!saved) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: self.TAXCAP_DEFAULTS });
  } else {
    const nextSettings = {
      ...self.TAXCAP_DEFAULTS,
      ...saved,
      portals: {
        ...self.TAXCAP_DEFAULTS.portals,
        ...(saved.portals || {}),
      },
    };
    if (self.TAXCAP_DEFAULTS.connectionMode === "proxy" && self.TAXCAP_DEFAULTS.apiBaseUrl) {
      nextSettings.connectionMode = "proxy";
      nextSettings.apiBaseUrl = self.TAXCAP_DEFAULTS.apiBaseUrl;
      nextSettings.accessToken = self.TAXCAP_DEFAULTS.accessToken || saved.accessToken || "";
    } else if (!saved.connectionMode) {
      nextSettings.connectionMode = "direct";
    }
    if (self.TAXCAP_DEFAULTS.geminiApiKey && !saved.geminiApiKey) {
      nextSettings.geminiApiKey = self.TAXCAP_DEFAULTS.geminiApiKey;
    }
    await chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings });
  }
  await updateBadge(false);
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes[SETTINGS_KEY]) return;
  const next = changes[SETTINGS_KEY].newValue;
  if (next?.pausedUntil > Date.now()) {
    chrome.alarms?.create(PAUSE_ALARM, { when: next.pausedUntil + 500 });
  }
  await updateBadge(false);
});

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === PAUSE_ALARM) updateBadge(false);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "TAXCAP_GET_SETTINGS") {
    (async () => {
      const [settings, licState] = await Promise.all([getSettings(), loadLicenseState()]);
      let evaluation = self.TaxCapLicense.evaluateLocalLicense(licState);
      if (licState.licenseKey && evaluation.unlocked && evaluation.needsRefresh) {
        const refreshed = await refreshLicenseIfNeeded({ force: false });
        evaluation = refreshed.evaluation;
      }
      sendResponse({
        ...settings,
        licenseGate: {
          unlocked: evaluation.unlocked,
          reason: evaluation.reason,
          message: evaluation.message,
        },
      });
    })();
    return true;
  }

  if (msg?.type === "TAXCAP_LICENSE_STATUS") {
    (async () => {
      const [deviceId, licState] = await Promise.all([ensureDeviceId(), loadLicenseState()]);
      const evaluation = self.TaxCapLicense.evaluateLocalLicense(licState);
      sendResponse({
        ok: true,
        deviceId,
        license: licState,
        evaluation,
        defaultApiUrl: self.TAXCAP_DEFAULTS?.licenseApiUrl || "",
      });
    })();
    return true;
  }

  if (msg?.type === "TAXCAP_LICENSE_ACTIVATE") {
    refreshLicenseIfNeeded({
      force: true,
      licenseKey: msg.licenseKey || "",
      licenseApiUrl: msg.licenseApiUrl || "",
    })
      .then(async (res) => {
        const deviceId = await ensureDeviceId();
        sendResponse({
          ok: res.evaluation.unlocked,
          deviceId,
          license: res.state,
          evaluation: res.evaluation,
          message: res.evaluation.unlocked ? "Kích hoạt thành công!" : res.evaluation.message,
        });
      })
      .catch(() => sendResponse({ ok: false, message: "Lỗi kích hoạt mã." }));
    return true;
  }

  if (msg?.type === "TAXCAP_LICENSE_REFRESH") {
    refreshLicenseIfNeeded({ force: true })
      .then(async (res) => {
        const deviceId = await ensureDeviceId();
        sendResponse({
          ok: res.evaluation.unlocked,
          deviceId,
          license: res.state,
          evaluation: res.evaluation,
          message: res.evaluation.unlocked ? "Đã đồng bộ Google Sheets." : res.evaluation.message,
        });
      })
      .catch(() => sendResponse({ ok: false, message: "Không đồng bộ được." }));
    return true;
  }

  if (msg?.type === "TAXCAP_LICENSE_DEACTIVATE") {
    (async () => {
      const [current, deviceId] = await Promise.all([loadLicenseState(), ensureDeviceId()]);
      if (current.licenseKey && current.licenseApiUrl) {
        await postAppsScript(current.licenseApiUrl, {
          action: "deactivate",
          licenseKey: current.licenseKey,
          deviceId,
          delta: Math.max(0, Number(current.pendingUsageDelta) || 0),
        }).catch(() => {});
      }
      const resetState = self.TaxCapLicense.createEmptyLicenseState(
        current.licenseApiUrl || self.TAXCAP_DEFAULTS?.licenseApiUrl || "",
      );
      await saveLicenseState(resetState);
      await updateBadge(false);
      sendResponse({
        ok: true,
        deviceId,
        license: resetState,
        evaluation: self.TaxCapLicense.evaluateLocalLicense(resetState),
      });
    })();
    return true;
  }

  if (msg?.type === "TAXCAP_SOLVE") {
    handleSolve(msg.portal, msg.image, Boolean(msg.bypassCache)).then(sendResponse);
    return true;
  }

  if (msg?.type === "TAXCAP_RECORD_LOCAL") {
    (async () => {
      const gate = await ensureLicenseUnlocked();
      if (!gate.ok) {
        sendResponse({ ok: false, licenseLocked: true, message: gate.message });
        return;
      }
      await recordLicensedSolve();
      await bumpStats(true);
      await updateBadge(false);
      const settings = await getSettings();
      const parsed = self.TaxCapDirect.parseImageDataUrl(msg.image || "");
      const portal = msg.portal || "hddt";
      const latencyMs = Math.max(1, Math.round(Number(msg.latencyMs) || 2));
      const confidence = Math.max(0, Math.min(100, Math.round(Number(msg.confidence) || 95)));

      await pushSolveLog({
        portal,
        status: "ok",
        code: msg.captcha || "",
        latencyMs,
        message: `SVG nội bộ (${confidence}%)`,
      });

      if (settings.connectionMode === "direct") {
        const imageHash = parsed
          ? self.TaxCapDirect.hashBase64Quick(`${parsed.mimeType}:${parsed.data}`)
          : "";
        const sampleId = `local:${crypto.randomUUID()}`;
        if (parsed) {
          await savePendingSolve(sampleId, {
            portal,
            predicted: msg.captcha || "",
            imageHash,
            mimeType: parsed.mimeType,
            base64Data: parsed.data,
          });
        }
        await appendSampleRecord({
          sampleId,
          portal,
          source: "svg-local",
          predicted: msg.captcha || "",
          latencyMs,
          imageDataUrl: msg.image || "",
          imageHash,
        });
        sendResponse({ ok: true, sampleId, localOnly: true });
        return;
      }

      const baseUrl = String(settings.apiBaseUrl || "").replace(/\/+$/, "");
      if (!baseUrl || isAisDevPreviewUrl(baseUrl) || !msg.image) {
        sendResponse({ ok: true, localOnly: true });
        return;
      }
      const headers = { "Content-Type": "application/json" };
      if (settings.accessToken) {
        headers["X-Extension-Token"] = settings.accessToken;
      }
      try {
        const res = await fetch(`${baseUrl}/api/dataset/record-local`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            portal,
            captcha: msg.captcha,
            confidence,
            latencyMs,
            image: msg.image,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (data.sampleId) {
          await appendSampleRecord({
            sampleId: data.sampleId,
            portal,
            source: "svg-local",
            predicted: msg.captcha || "",
            latencyMs,
            imageDataUrl: msg.image || "",
            imageHash: parsed
              ? self.TaxCapDirect.hashBase64Quick(`${parsed.mimeType}:${parsed.data}`)
              : "",
          });
        }
        sendResponse({ ok: res.ok, sampleId: data.sampleId || "" });
      } catch {
        sendResponse({ ok: true, localOnly: true });
      }
    })();
    return true;
  }

  if (msg?.type === "TAXCAP_FEEDBACK") {
    (async () => {
      const sampleId = String(msg.sampleId || "");
      const outcome = msg.outcome;
      if (!sampleId || !outcome) {
        sendResponse({ ok: false });
        return;
      }

      // Cập nhật nhãn trong Kho Dữ liệu cục bộ
      const prevSamples = await loadSamples();
      const { samples: nextSamples, updatedSample } = self.TaxCapDirect.applySampleFeedback(prevSamples, {
        sampleId,
        outcome,
        finalLabel: msg.finalLabel || "",
      });
      if (updatedSample) {
        await saveSamples(nextSamples);
      }

      if (sampleId.startsWith("local:")) {
        const pending = await takePendingSolve(sampleId);
        const parsed = updatedSample?.imageDataUrl
          ? self.TaxCapDirect.parseImageDataUrl(updatedSample.imageDataUrl)
          : null;
        const sourceMeta = pending || (updatedSample ? {
          portal: updatedSample.portal,
          predicted: updatedSample.predicted,
          imageHash: updatedSample.imageHash,
          mimeType: parsed?.mimeType || "",
          base64Data: parsed?.data || "",
        } : null);

        if (!sourceMeta) {
          sendResponse({ ok: false });
          return;
        }
        const prevMem = await loadLocalMemory();
        const nextMem = self.TaxCapDirect.updateLocalLearningState(prevMem, {
          portal: sourceMeta.portal,
          predicted: sourceMeta.predicted,
          finalLabel: msg.finalLabel || "",
          outcome,
          imageHash: sourceMeta.imageHash,
          mimeType: sourceMeta.mimeType,
          base64Data: sourceMeta.base64Data,
        });
        await saveLocalMemory(nextMem);
        sendResponse({ ok: true, localLearned: true });
        return;
      }

      const settings = await getSettings();
      const baseUrl = String(settings.apiBaseUrl || "").replace(/\/+$/, "");
      if (!baseUrl) {
        sendResponse({ ok: Boolean(updatedSample) });
        return;
      }
      const headers = { "Content-Type": "application/json" };
      if (settings.accessToken) {
        headers["X-Extension-Token"] = settings.accessToken;
      }
      try {
        const res = await fetch(`${baseUrl}/api/dataset/feedback`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            sampleId,
            outcome,
            finalLabel: msg.finalLabel || "",
          }),
        });
        sendResponse({ ok: res.ok });
      } catch {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (msg?.type === "TAXCAP_GET_DATASET") {
    Promise.all([loadSamples(), loadLocalMemory()])
      .then(([samples, mem]) => {
        const summary = self.TaxCapDirect.computeDatasetSummary(samples);
        const portalHints = {};
        for (const id of self.TaxCapDirect.PORTAL_IDS) {
          portalHints[id] = self.TaxCapDirect.getAdaptiveHints(mem, id);
        }
        sendResponse({
          ok: true,
          summary,
          samples,
          portalHints,
          memoryStats: summarizeMemory(mem),
        });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg?.type === "TAXCAP_POPUP_UPDATE_SAMPLE") {
    (async () => {
      const sampleId = String(msg.sampleId || "");
      const cleaned = self.TaxCapDirect.sanitizeCaptchaText(String(msg.finalLabel || ""));
      if (!sampleId || cleaned.length < 2) {
        sendResponse({ ok: false });
        return;
      }
      const prevSamples = await loadSamples();
      const target = prevSamples.find((s) => s.sampleId === sampleId);
      if (!target) {
        sendResponse({ ok: false });
        return;
      }
      const outcome = cleaned === target.predicted ? "verified" : "corrected";
      const { samples: nextSamples, updatedSample } = self.TaxCapDirect.applySampleFeedback(prevSamples, {
        sampleId,
        outcome,
        finalLabel: cleaned,
      });
      await saveSamples(nextSamples);

      const parsed = updatedSample?.imageDataUrl
        ? self.TaxCapDirect.parseImageDataUrl(updatedSample.imageDataUrl)
        : null;
      const prevMem = await loadLocalMemory();
      const nextMem = self.TaxCapDirect.updateLocalLearningState(prevMem, {
        portal: target.portal,
        predicted: target.predicted,
        finalLabel: cleaned,
        outcome,
        imageHash: target.imageHash,
        mimeType: parsed?.mimeType || "",
        base64Data: parsed?.data || "",
      });
      await saveLocalMemory(nextMem);
      sendResponse({ ok: true, sample: updatedSample });
    })();
    return true;
  }

  if (msg?.type === "TAXCAP_CLEAR_DATASET") {
    Promise.all([
      saveSamples([]),
      saveLocalMemory(self.TaxCapDirect.createEmptyMemoryState()),
    ])
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg?.type === "TAXCAP_GET_LOGS") {
    loadLogs()
      .then((logs) => {
        const stats = self.TaxCapDirect.computeLogStats(logs);
        sendResponse({ ok: true, stats, logs });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg?.type === "TAXCAP_CLEAR_LOGS") {
    chrome.storage.local
      .set({ [LOGS_KEY]: [] })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg?.type === "TAXCAP_GET_MEMORY_STATS") {
    loadLocalMemory()
      .then((mem) => sendResponse({ ok: true, ...summarizeMemory(mem) }))
      .catch(() => sendResponse({ ok: true, exactCount: 0, learnedCount: 0, correctedCount: 0 }));
    return true;
  }

  if (msg?.type === "TAXCAP_CLEAR_MEMORY") {
    saveLocalMemory(self.TaxCapDirect.createEmptyMemoryState())
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg?.type === "TAXCAP_PING") {
    getSettings().then(async (settings) => {
      if (settings.connectionMode !== "proxy") {
        const apiKey = normalizeApiKey(settings.geminiApiKey);
        if (!apiKey) {
          await updateBadge(true);
          sendResponse({
            ok: false,
            message: "Chưa nhập Gemini API Key (lấy miễn phí tại aistudio.google.com/apikey)",
          });
          return;
        }
        const model = self.TaxCapDirect.resolveDirectModel(settings.speedMode);
        try {
          const res = await fetch(`${GEMINI_API_BASE}/${encodeURIComponent(model)}`, {
            method: "GET",
            headers: { "x-goog-api-key": apiKey },
          });
          if (res.ok) {
            await updateBadge(false);
            sendResponse({ ok: true, mode: "direct", model });
            return;
          }
          const data = await res.json().catch(() => ({}));
          await updateBadge(true);
          sendResponse({
            ok: false,
            message:
              res.status === 400 || res.status === 401 || res.status === 403
                ? "Gemini API Key không hợp lệ — hãy kiểm tra lại key AIza..."
                : data?.error?.message || `Lỗi Gemini API (${res.status})`,
          });
        } catch {
          await updateBadge(true);
          sendResponse({ ok: false, message: "Không kết nối được tới Google Gemini API" });
        }
        return;
      }

      const baseUrl = String(settings.apiBaseUrl || "").replace(/\/+$/, "");
      if (!baseUrl) {
        await updateBadge(true);
        sendResponse({ ok: false, message: "Chưa nhập URL Backend Proxy" });
        return;
      }
      if (isAisDevPreviewUrl(baseUrl)) {
        await updateBadge(true);
        sendResponse({
          ok: false,
          message: "URL ais-dev-... bị AI Studio chặn cookie. Hãy chuyển sang chế độ Độc lập (API Key).",
        });
        return;
      }
      const headers = {};
      if (settings.accessToken) {
        headers["X-Extension-Token"] = settings.accessToken;
      }
      try {
        const res = await fetch(`${baseUrl}/api/health`, { headers });
        const ct = res.headers.get("content-type") || "";
        if (res.redirected || !ct.includes("application/json")) {
          await updateBadge(true);
          sendResponse({
            ok: false,
            message: "Máy chủ trả về HTML/đăng nhập thay vì API JSON.",
          });
          return;
        }
        const data = await res.json().catch(() => ({}));
        await updateBadge(!res.ok);
        sendResponse({ ok: res.ok, mode: "proxy", ...data });
      } catch {
        await updateBadge(true);
        sendResponse({ ok: false, message: "Không kết nối được máy chủ Proxy" });
      }
    });
    return true;
  }

  if (msg?.type === "TAXCAP_CHECK_LICENSE") {
    ensureLicenseUnlocked()
      .then((res) => {
        sendResponse({
          ok: Boolean(res.ok),
          locked: !res.ok,
          reason: res.evaluation?.reason || "",
          message: res.message || res.evaluation?.message || "",
        });
      })
      .catch(() => {
        sendResponse({
          ok: false,
          locked: true,
          reason: "ERROR",
          message: "Không kiểm tra được trạng thái kích hoạt.",
        });
      });
    return true;
  }

  if (msg?.type === "TAXCAP_DOWNLOAD_FILE" || msg?.type === "download") {
    (async () => {
      const licCheck = await ensureLicenseUnlocked();
      if (!licCheck.ok) {
        sendResponse({
          error: licCheck.message || "Chưa kích hoạt mã bản quyền — hãy mở TaxCap Suite để kích hoạt.",
        });
        return;
      }
      try {
        const id = await chrome.downloads.download({
          url: msg.url,
          filename: msg.filename,
          conflictAction: "overwrite",
          saveAs: false,
        });
        sendResponse({ id });
      } catch (e) {
        sendResponse({ error: e?.message || "Không lưu được tệp tải về." });
      }
    })();
    return true;
  }
});
