(() => {
  const LICENSE_KEY = "taxcapLicense";
  const DEVICE_ID_KEY = "taxcapDeviceId";
  const ACTIVE_TAB_KEY = "taxcapActiveMainTab";
  const VALID_TABS = ["hddt", "hoso", "captcha"];

  const shellStatus = document.getElementById("shellStatus");
  const shellLockView = document.getElementById("shellLockView");
  const shellLockAlert = document.getElementById("shellLockAlert");
  const shellKeyInput = document.getElementById("shellKeyInput");
  const shellUrlDirectWrap = document.getElementById("shellUrlDirectWrap");
  const shellApiInput = document.getElementById("shellApiInput");
  const shellUrlDetails = document.getElementById("shellUrlDetails");
  const shellApiPresetInput = document.getElementById("shellApiPresetInput");
  const shellActivateBtn = document.getElementById("shellActivateBtn");
  const shellActivateStatus = document.getElementById("shellActivateStatus");
  const shellDeviceId = document.getElementById("shellDeviceId");

  const tabButtons = Array.from(document.querySelectorAll(".main-tab-btn"));
  const frames = {
    hddt: document.getElementById("frame-hddt"),
    hoso: document.getElementById("frame-hoso"),
    captcha: document.getElementById("frame-captcha"),
  };

  let isUnlocked = false;
  let activeTab = "hddt";
  let cachedDeviceId = "";

  function hasChromeRuntime() {
    return typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage);
  }

  function hasChromeStorage() {
    return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
  }

  function generateDeviceIdString() {
    const rawUuid =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().replace(/-/g, "")
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
    return `dev_${rawUuid.slice(0, 12)}`;
  }

  async function ensureLocalDeviceId() {
    if (cachedDeviceId) return cachedDeviceId;
    if (hasChromeStorage()) {
      try {
        const res = await chrome.storage.local.get(DEVICE_ID_KEY);
        if (res?.[DEVICE_ID_KEY]) {
          cachedDeviceId = String(res[DEVICE_ID_KEY]);
          return cachedDeviceId;
        }
        const generated = generateDeviceIdString();
        await chrome.storage.local.set({ [DEVICE_ID_KEY]: generated });
        cachedDeviceId = generated;
        return cachedDeviceId;
      } catch {
        // Fallback below
      }
    }
    try {
      const saved = localStorage.getItem(DEVICE_ID_KEY);
      if (saved) {
        cachedDeviceId = saved;
        return cachedDeviceId;
      }
      const generated = generateDeviceIdString();
      localStorage.setItem(DEVICE_ID_KEY, generated);
      cachedDeviceId = generated;
      return cachedDeviceId;
    } catch {
      cachedDeviceId = generateDeviceIdString();
      return cachedDeviceId;
    }
  }

  async function readLocalLicenseDirect() {
    const deviceId = await ensureLocalDeviceId();
    const defaultApiUrl = self.TAXCAP_DEFAULTS?.licenseApiUrl || "";
    let rawLic = null;
    if (hasChromeStorage()) {
      try {
        const stored = await chrome.storage.local.get(LICENSE_KEY);
        rawLic = stored?.[LICENSE_KEY] || null;
      } catch {
        rawLic = null;
      }
    }
    const licState = self.TaxCapLicense.normalizeLicenseState(rawLic, defaultApiUrl);
    const evaluation = self.TaxCapLicense.evaluateLocalLicense(licState);
    return {
      ok: true,
      deviceId,
      license: licState,
      state: licState,
      evaluation,
      defaultApiUrl,
    };
  }

  async function activateLicenseDirect(licenseKey, licenseApiUrl) {
    const deviceId = await ensureLocalDeviceId();
    const cleanUrl = self.TaxCapLicense.normalizeLicenseApiUrl(licenseApiUrl);
    const cleanKey = self.TaxCapLicense.normalizeLicenseKey(licenseKey);
    const defaultApiUrl = self.TAXCAP_DEFAULTS?.licenseApiUrl || "";

    let prevRaw = null;
    if (hasChromeStorage()) {
      try {
        const stored = await chrome.storage.local.get(LICENSE_KEY);
        prevRaw = stored?.[LICENSE_KEY] || null;
      } catch {
        prevRaw = null;
      }
    }
    const current = self.TaxCapLicense.normalizeLicenseState(prevRaw, defaultApiUrl);

    if (!self.TaxCapLicense.isValidAppsScriptUrl(cleanUrl)) {
      return {
        ok: false,
        deviceId,
        license: current,
        evaluation: self.TaxCapLicense.evaluateLocalLicense(current),
        defaultApiUrl,
        message: "URL Google Apps Script chưa đúng định dạng https://script.google.com/macros/s/.../exec",
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), 12000);
    let serverRes;
    try {
      const resp = await fetch(cleanUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "verify",
          licenseKey: cleanKey,
          deviceId,
          delta: 0,
        }),
        signal: controller.signal,
      });
      const text = await resp.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== "object") {
        serverRes = {
          ok: false,
          networkError: true,
          message: "Google Apps Script trả về dữ liệu không hợp lệ (kiểm tra Deploy Web App: Anyone).",
        };
      } else {
        serverRes = parsed;
      }
    } catch {
      serverRes = {
        ok: false,
        networkError: true,
        message: "Không kết nối được Google Sheets (kiểm tra Internet hoặc URL Apps Script).",
      };
    } finally {
      clearTimeout(timer);
    }

    const nextState = self.TaxCapLicense.applyServerVerifyResult(current, serverRes, {
      licenseKey: cleanKey,
      licenseApiUrl: cleanUrl,
      deviceId,
      sentDelta: 0,
      nowMs: Date.now(),
    });
    if (hasChromeStorage()) {
      await chrome.storage.local.set({ [LICENSE_KEY]: nextState }).catch(() => {});
    }
    const evaluation = self.TaxCapLicense.evaluateLocalLicense(nextState);
    return {
      ok: evaluation.unlocked,
      deviceId,
      license: nextState,
      state: nextState,
      evaluation,
      defaultApiUrl,
      message: evaluation.unlocked ? "Kích hoạt thành công!" : evaluation.message || nextState.lastError,
    };
  }

  function ensureFramesMounted() {
    for (const id of VALID_TABS) {
      const frame = frames[id];
      if (!frame) continue;
      const target = frame.dataset.src;
      if (!frame.getAttribute("src") || frame.getAttribute("src") === "about:blank") {
        frame.setAttribute("src", target);
      }
    }
  }

  function unmountFrames() {
    for (const id of VALID_TABS) {
      const frame = frames[id];
      if (!frame) continue;
      frame.classList.add("hidden");
      if (frame.getAttribute("src") && frame.getAttribute("src") !== "about:blank") {
        frame.setAttribute("src", "about:blank");
      }
    }
  }

  function setMainTab(nextTab, persist = true) {
    if (!VALID_TABS.includes(nextTab)) nextTab = "hddt";
    activeTab = nextTab;

    for (const btn of tabButtons) {
      const match = btn.dataset.mainTab === nextTab;
      btn.classList.toggle("active", match);
      btn.setAttribute("aria-selected", match ? "true" : "false");
    }

    if (!isUnlocked) return;

    ensureFramesMounted();
    for (const id of VALID_TABS) {
      frames[id]?.classList.toggle("hidden", id !== nextTab);
    }

    if (persist && hasChromeStorage()) {
      chrome.storage.local.set({ [ACTIVE_TAB_KEY]: nextTab }).catch(() => {});
    }
  }

  for (const btn of tabButtons) {
    btn.addEventListener("click", () => {
      if (!isUnlocked) return;
      setMainTab(btn.dataset.mainTab, true);
    });
  }

  function configureApiUrlField(savedUrl, defaultApiUrl = "") {
    const presetUrl = defaultApiUrl || self.TAXCAP_DEFAULTS?.licenseApiUrl || "";
    const effective = savedUrl || presetUrl;
    if (presetUrl && effective === presetUrl) {
      shellUrlDirectWrap.classList.add("hidden");
      shellUrlDetails.classList.remove("hidden");
      shellApiPresetInput.value = presetUrl;
      shellApiInput.value = presetUrl;
    } else {
      shellUrlDirectWrap.classList.remove("hidden");
      shellUrlDetails.classList.add("hidden");
      shellApiInput.value = effective;
      shellApiPresetInput.value = effective;
    }
  }

  function getEnteredApiUrl() {
    if (!shellUrlDetails.classList.contains("hidden")) {
      return shellApiPresetInput.value.trim();
    }
    return shellApiInput.value.trim();
  }

  function applyLicenseUi(licRes, options = {}) {
    const state = licRes?.license || licRes?.state || {};
    const evaluation = licRes?.evaluation || { unlocked: false, reason: "UNACTIVATED", message: "" };
    const preserveInputs = Boolean(options.preserveInputs);
    isUnlocked = Boolean(evaluation.unlocked);

    if (shellDeviceId) {
      const nextDeviceId = licRes?.deviceId || state.deviceId || cachedDeviceId || "";
      if (nextDeviceId) {
        cachedDeviceId = nextDeviceId;
        shellDeviceId.textContent = nextDeviceId;
      } else if (!shellDeviceId.textContent || shellDeviceId.textContent === "—") {
        shellDeviceId.textContent = "—";
      }
    }

    for (const btn of tabButtons) {
      btn.disabled = !isUnlocked;
    }

    if (!isUnlocked) {
      unmountFrames();
      shellLockView.classList.remove("hidden");
      shellStatus.textContent = "Chưa kích hoạt";
      shellStatus.className = "brand-meta locked";

      if (!preserveInputs) {
        if (state.licenseKey || !shellKeyInput.value.trim()) {
          shellKeyInput.value = state.licenseKey || "";
        }
        configureApiUrlField(state.licenseApiUrl || "", licRes?.defaultApiUrl || "");
      }

      const reasonMsg =
        evaluation.reason && evaluation.reason !== "UNACTIVATED"
          ? evaluation.message || state.lastError || ""
          : state.lastError || "";

      if (reasonMsg) {
        shellLockAlert.textContent = reasonMsg;
        shellLockAlert.classList.remove("hidden");
      } else {
        shellLockAlert.classList.add("hidden");
      }
      return;
    }

    shellLockView.classList.add("hidden");
    const userLabel = state.userName || state.licenseKey || "Đã kích hoạt";
    shellStatus.textContent = userLabel;
    shellStatus.className = "brand-meta active";
    setMainTab(activeTab, false);
  }

  async function refreshLicenseStatus() {
    const localDeviceId = await ensureLocalDeviceId();
    if (shellDeviceId && localDeviceId) {
      shellDeviceId.textContent = localDeviceId;
    }

    if (hasChromeRuntime()) {
      try {
        const res = await chrome.runtime.sendMessage({ type: "TAXCAP_LICENSE_STATUS" });
        if (res && typeof res === "object" && (res.license || res.state || res.deviceId)) {
          applyLicenseUi({ ...res, deviceId: res.deviceId || localDeviceId });
          return;
        }
      } catch {
        // Fallback sang đọc trực tiếp chrome.storage.local bên dưới
      }
    }

    const direct = await readLocalLicenseDirect();
    applyLicenseUi(direct);
  }

  async function handleActivate() {
    const licenseKey = shellKeyInput.value.trim().toUpperCase();
    const licenseApiUrl = getEnteredApiUrl();
    if (!licenseKey) {
      shellActivateStatus.textContent = "Vui lòng nhập Mã kích hoạt.";
      shellActivateStatus.className = "status err";
      shellKeyInput.focus();
      return;
    }
    if (!licenseApiUrl) {
      shellActivateStatus.textContent = "Vui lòng nhập URL Google Apps Script.";
      shellActivateStatus.className = "status err";
      shellApiInput.focus();
      return;
    }

    shellActivateBtn.disabled = true;
    shellActivateBtn.textContent = "Đang xác thực qua Google Sheets…";
    shellActivateStatus.textContent = "";
    shellActivateStatus.className = "status";

    try {
      let res = null;
      if (hasChromeRuntime()) {
        try {
          res = await chrome.runtime.sendMessage({
            type: "TAXCAP_LICENSE_ACTIVATE",
            licenseKey,
            licenseApiUrl,
          });
        } catch {
          res = null;
        }
      }
      if (!res || typeof res !== "object" || (!res.evaluation && !res.license && !res.state && !res.message)) {
        res = await activateLicenseDirect(licenseKey, licenseApiUrl);
      }

      if (res?.ok) {
        shellActivateStatus.textContent = "Kích hoạt thành công! Đang mở khóa cả 3 tính năng…";
        shellActivateStatus.className = "status ok";
        applyLicenseUi(res);
      } else {
        const errMsg =
          res?.message ||
          res?.evaluation?.message ||
          res?.license?.lastError ||
          res?.state?.lastError ||
          "Mã kích hoạt không hợp lệ.";
        shellActivateStatus.textContent = errMsg;
        shellActivateStatus.className = "status err";
        applyLicenseUi(res, { preserveInputs: true });
      }
    } catch (err) {
      shellActivateStatus.textContent =
        err?.message || "Không gửi được yêu cầu kích hoạt tới Google Sheets.";
      shellActivateStatus.className = "status err";
    } finally {
      shellActivateBtn.disabled = false;
      shellActivateBtn.textContent = "Kích hoạt & Mở khóa";
    }
  }

  shellActivateBtn.addEventListener("click", handleActivate);
  shellKeyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleActivate();
  });

  // Đồng bộ tức thì nếu người dùng hủy kích hoạt trong tab Captcha -> Cấu hình
  // hoặc phiên đồng bộ 15 phút phát hiện mã bị khóa/hết hạn
  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes[LICENSE_KEY]) {
        refreshLicenseStatus();
      }
    });
  }

  // Khôi phục tab chính cuối cùng (mặc định Tab 1: Tải HĐĐT)
  (async () => {
    if (hasChromeStorage()) {
      try {
        const stored = await chrome.storage.local.get(ACTIVE_TAB_KEY);
        if (VALID_TABS.includes(stored?.[ACTIVE_TAB_KEY])) {
          activeTab = stored[ACTIVE_TAB_KEY];
        }
      } catch {
        // Giữ mặc định hddt
      }
    }
    await refreshLicenseStatus();
  })();
})();
