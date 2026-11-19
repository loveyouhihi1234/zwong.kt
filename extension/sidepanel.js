(() => {
  const LICENSE_KEY = "taxcapLicense";
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

  function hasChromeRuntime() {
    return typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage);
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

    if (persist && typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({ [ACTIVE_TAB_KEY]: nextTab }).catch(() => {});
    }
  }

  for (const btn of tabButtons) {
    btn.addEventListener("click", () => {
      if (!isUnlocked) return;
      setMainTab(btn.dataset.mainTab, true);
    });
  }

  function configureApiUrlField(savedUrl) {
    const presetUrl = self.TAXCAP_DEFAULTS?.licenseApiUrl || "";
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

  function applyLicenseUi(licRes) {
    const state = licRes?.state || {};
    const evaluation = licRes?.evaluation || { unlocked: false, reason: "UNACTIVATED", message: "" };
    isUnlocked = Boolean(evaluation.unlocked);

    if (shellDeviceId) {
      shellDeviceId.textContent = licRes?.deviceId || state.deviceId || "—";
    }

    for (const btn of tabButtons) {
      btn.disabled = !isUnlocked;
    }

    if (!isUnlocked) {
      unmountFrames();
      shellLockView.classList.remove("hidden");
      shellStatus.textContent = "Chưa kích hoạt";
      shellStatus.className = "brand-meta locked";

      shellKeyInput.value = state.licenseKey || "";
      configureApiUrlField(state.licenseApiUrl || "");

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
    if (!hasChromeRuntime()) {
      applyLicenseUi({
        deviceId: "preview-local",
        state: {},
        evaluation: { unlocked: false, reason: "UNACTIVATED", message: "" },
      });
      return;
    }
    try {
      const res = await chrome.runtime.sendMessage({ type: "TAXCAP_GET_LICENSE" });
      applyLicenseUi(res);
    } catch {
      applyLicenseUi({
        state: {},
        evaluation: {
          unlocked: false,
          reason: "ERROR",
          message: "Không thể kết nối Service Worker — hãy tải lại Extension.",
        },
      });
    }
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
      const res = await chrome.runtime.sendMessage({
        type: "TAXCAP_ACTIVATE_LICENSE",
        licenseKey,
        licenseApiUrl,
      });
      if (res?.ok) {
        shellActivateStatus.textContent = "Kích hoạt thành công! Đang mở khóa cả 3 tính năng…";
        shellActivateStatus.className = "status ok";
        applyLicenseUi(res);
      } else {
        shellActivateStatus.textContent = res?.message || "Mã kích hoạt không hợp lệ.";
        shellActivateStatus.className = "status err";
        applyLicenseUi(res);
      }
    } catch {
      shellActivateStatus.textContent = "Không gửi được yêu cầu kích hoạt tới Extension.";
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
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
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
