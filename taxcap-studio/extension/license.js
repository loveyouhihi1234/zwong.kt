// Quản lý bản quyền & đồng bộ Google Sheets nhẹ tải (Cache 15 phút + Gom lô lượt giải).
// Dùng chung được trong Service Worker (importScripts), Popup và Node unit test.
(function (root) {
  const LICENSE_CACHE_TTL_MS = 15 * 60 * 1000; // 15 phút kiểm tra lại Google Sheets 1 lần
  const GRACE_RETRY_TTL_MS = 5 * 60 * 1000; // 5 phút gia hạn tạm nếu mạng Google chập chờn
  const MAX_OFFLINE_GRACE_MS = 24 * 60 * 60 * 1000; // Tối đa 24h gia hạn nếu đã xác thực trước đó
  const USAGE_SYNC_BATCH_SIZE = 10; // Gom 10 lượt mới đồng bộ lên Sheet 1 lần

  function getTodayDateKey(nowMs = Date.now()) {
    // Múi giờ Việt Nam (UTC+7) để khớp với ngày trên Google Sheets
    const vnMs = Number(nowMs) + 7 * 60 * 60 * 1000;
    return new Date(vnMs).toISOString().slice(0, 10);
  }

  function normalizeLicenseKey(raw) {
    return String(raw || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, "");
  }

  function normalizeLicenseApiUrl(raw) {
    return String(raw || "").trim().replace(/\/+$/, "");
  }

  function isValidAppsScriptUrl(url) {
    const clean = normalizeLicenseApiUrl(url);
    return /^https:\/\/script\.(google|googleusercontent)\.com\/.+/i.test(clean);
  }

  function createEmptyLicenseState(defaultApiUrl = "") {
    return {
      licenseKey: "",
      licenseApiUrl: normalizeLicenseApiUrl(defaultApiUrl),
      userName: "",
      status: "UNACTIVATED", // UNACTIVATED | ACTIVE | LOCKED | EXPIRED | DEVICE_LIMIT | NOT_FOUND | ERROR
      expiresAt: "",
      maxDevices: 1,
      deviceCount: 0,
      dailyLimit: 0,
      baseUsedToday: 0,
      usedDate: "",
      totalSolved: 0,
      pendingUsageDelta: 0,
      verifiedAt: 0,
      cacheExpiresAt: 0,
      lastVerifyOk: false,
      lastError: "",
      lastReason: "",
    };
  }

  function normalizeLicenseState(raw, defaultApiUrl = "") {
    const base = createEmptyLicenseState(defaultApiUrl);
    if (!raw || typeof raw !== "object") return base;
    return {
      ...base,
      ...raw,
      licenseKey: normalizeLicenseKey(raw.licenseKey),
      licenseApiUrl: normalizeLicenseApiUrl(raw.licenseApiUrl || defaultApiUrl),
      maxDevices: Math.max(1, Number(raw.maxDevices) || 1),
      deviceCount: Math.max(0, Number(raw.deviceCount) || 0),
      dailyLimit: Math.max(0, Number(raw.dailyLimit) || 0),
      baseUsedToday: Math.max(0, Number(raw.baseUsedToday) || 0),
      totalSolved: Math.max(0, Number(raw.totalSolved) || 0),
      pendingUsageDelta: Math.max(0, Number(raw.pendingUsageDelta) || 0),
      verifiedAt: Number(raw.verifiedAt) || 0,
      cacheExpiresAt: Number(raw.cacheExpiresAt) || 0,
      lastVerifyOk: Boolean(raw.lastVerifyOk),
    };
  }

  function isExpiredDate(expiresAt, todayKey) {
    const clean = String(expiresAt || "").trim().toUpperCase();
    if (!clean || clean === "FOREVER" || clean === "VĨNH VIỄN") return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) return false;
    return todayKey > clean;
  }

  function formatStatusMessage(reason, fallback) {
    switch (reason) {
      case "UNACTIVATED":
        return "Chưa nhập mã kích hoạt — hãy kích hoạt để sử dụng.";
      case "NOT_FOUND":
        return "Mã kích hoạt không tồn tại trên hệ thống.";
      case "LOCKED":
        return "Tài khoản đã bị Admin tạm khóa.";
      case "EXPIRED":
        return "Mã kích hoạt đã hết hạn sử dụng.";
      case "DEVICE_LIMIT":
        return "Mã này đã đạt giới hạn số thiết bị cho phép.";
      case "DAILY_LIMIT":
        return "Bạn đã dùng hết hạn mức lượt trong ngày hôm nay.";
      case "NO_API_URL":
        return "Chưa cấu hình URL Google Apps Script.";
      default:
        return fallback || "Không thể xác thực mã kích hoạt.";
    }
  }

  function evaluateLocalLicense(rawState, nowMs = Date.now()) {
    const state = normalizeLicenseState(rawState);
    const today = getTodayDateKey(nowMs);

    if (!state.licenseKey) {
      return {
        unlocked: false,
        needsRefresh: false,
        reason: "UNACTIVATED",
        message: formatStatusMessage("UNACTIVATED"),
        effectiveUsedToday: 0,
        remainingToday: null,
        msUntilRefresh: 0,
      };
    }

    if (state.status === "LOCKED" || state.lastReason === "LOCKED") {
      return {
        unlocked: false,
        needsRefresh: true,
        reason: "LOCKED",
        message: state.lastError || formatStatusMessage("LOCKED"),
        effectiveUsedToday: state.baseUsedToday,
        remainingToday: null,
        msUntilRefresh: 0,
      };
    }

    if (state.status === "NOT_FOUND" || state.lastReason === "NOT_FOUND") {
      return {
        unlocked: false,
        needsRefresh: true,
        reason: "NOT_FOUND",
        message: state.lastError || formatStatusMessage("NOT_FOUND"),
        effectiveUsedToday: 0,
        remainingToday: null,
        msUntilRefresh: 0,
      };
    }

    if (state.status === "DEVICE_LIMIT" || state.lastReason === "DEVICE_LIMIT") {
      return {
        unlocked: false,
        needsRefresh: true,
        reason: "DEVICE_LIMIT",
        message: state.lastError || formatStatusMessage("DEVICE_LIMIT"),
        effectiveUsedToday: 0,
        remainingToday: null,
        msUntilRefresh: 0,
      };
    }

    if (
      state.status === "EXPIRED" ||
      state.lastReason === "EXPIRED" ||
      (state.lastVerifyOk && isExpiredDate(state.expiresAt, today))
    ) {
      return {
        unlocked: false,
        needsRefresh: true,
        reason: "EXPIRED",
        message: state.lastError || formatStatusMessage("EXPIRED"),
        effectiveUsedToday: 0,
        remainingToday: null,
        msUntilRefresh: 0,
      };
    }

    if (!state.lastVerifyOk) {
      return {
        unlocked: false,
        needsRefresh: true,
        reason: state.lastReason || "UNVERIFIED",
        message: state.lastError || formatStatusMessage("UNACTIVATED"),
        effectiveUsedToday: 0,
        remainingToday: null,
        msUntilRefresh: 0,
      };
    }

    const baseToday = state.usedDate === today ? state.baseUsedToday : 0;
    const effectiveUsedToday = baseToday + state.pendingUsageDelta;
    const remainingToday =
      state.dailyLimit > 0 ? Math.max(0, state.dailyLimit - effectiveUsedToday) : null;

    if (state.dailyLimit > 0 && effectiveUsedToday >= state.dailyLimit) {
      return {
        unlocked: false,
        needsRefresh: nowMs >= state.cacheExpiresAt,
        reason: "DAILY_LIMIT",
        message: formatStatusMessage("DAILY_LIMIT"),
        effectiveUsedToday,
        remainingToday: 0,
        msUntilRefresh: Math.max(0, state.cacheExpiresAt - nowMs),
      };
    }

    const msUntilRefresh = Math.max(0, state.cacheExpiresAt - nowMs);
    const needsRefresh =
      nowMs >= state.cacheExpiresAt ||
      state.pendingUsageDelta >= USAGE_SYNC_BATCH_SIZE ||
      (state.usedDate && state.usedDate !== today);

    return {
      unlocked: true,
      needsRefresh,
      reason: "ACTIVE",
      message: "Đang hoạt động",
      effectiveUsedToday,
      remainingToday,
      msUntilRefresh,
    };
  }

  function applyServerVerifyResult(prevRaw, serverData, ctx = {}) {
    const nowMs = Number(ctx.nowMs) || Date.now();
    const prev = normalizeLicenseState(prevRaw, ctx.licenseApiUrl);
    const licenseKey = normalizeLicenseKey(ctx.licenseKey || prev.licenseKey);
    const licenseApiUrl = normalizeLicenseApiUrl(ctx.licenseApiUrl || prev.licenseApiUrl);
    const sentDelta = Math.max(0, Number(ctx.sentDelta) || 0);
    const today = getTodayDateKey(nowMs);

    if (serverData && serverData.ok === true) {
      const remainingPending = Math.max(0, prev.pendingUsageDelta - sentDelta);
      return {
        ...prev,
        licenseKey,
        licenseApiUrl,
        userName: String(serverData.userName || prev.userName || ""),
        status: "ACTIVE",
        expiresAt: String(serverData.expiresAt || "FOREVER"),
        maxDevices: Math.max(1, Number(serverData.maxDevices) || 1),
        deviceCount: Math.max(1, Number(serverData.deviceCount) || 1),
        dailyLimit: Math.max(0, Number(serverData.dailyLimit) || 0),
        baseUsedToday: Math.max(0, Number(serverData.usedToday) || 0),
        usedDate: String(serverData.usedDate || today),
        totalSolved: Math.max(0, Number(serverData.totalSolved) || 0),
        pendingUsageDelta: remainingPending,
        verifiedAt: nowMs,
        cacheExpiresAt: nowMs + LICENSE_CACHE_TTL_MS,
        lastVerifyOk: true,
        lastError: "",
        lastReason: "ACTIVE",
      };
    }

    // Lỗi mạng / Google Sheets quá tải tạm thời -> gia hạn tạm nếu trước đó đã kích hoạt hợp lệ trong 24h
    if (serverData && serverData.networkError) {
      const withinGrace =
        prev.lastVerifyOk &&
        prev.licenseKey === licenseKey &&
        nowMs - prev.verifiedAt < MAX_OFFLINE_GRACE_MS &&
        !isExpiredDate(prev.expiresAt, today);

      if (withinGrace) {
        return {
          ...prev,
          licenseKey,
          licenseApiUrl,
          cacheExpiresAt: nowMs + GRACE_RETRY_TTL_MS,
          lastError: serverData.message || "Tạm mất kết nối Google Sheets (đang dùng bộ nhớ đệm)",
        };
      }
      return {
        ...prev,
        licenseKey,
        licenseApiUrl,
        lastVerifyOk: false,
        status: "ERROR",
        lastReason: "NETWORK_ERROR",
        lastError: serverData.message || "Không kết nối được Google Apps Script.",
        cacheExpiresAt: 0,
      };
    }

    // Máy chủ Google Sheets từ chối rõ ràng (LOCKED, EXPIRED, NOT_FOUND, DEVICE_LIMIT, DAILY_LIMIT)
    const reason = String(serverData?.reason || "ERROR").toUpperCase();
    const msg = String(serverData?.message || formatStatusMessage(reason));
    return {
      ...prev,
      licenseKey,
      licenseApiUrl,
      userName: String(serverData?.userName || prev.userName || ""),
      status: reason,
      expiresAt: String(serverData?.expiresAt || prev.expiresAt || ""),
      maxDevices: Math.max(1, Number(serverData?.maxDevices) || prev.maxDevices || 1),
      deviceCount: Math.max(0, Number(serverData?.deviceCount) || prev.deviceCount || 0),
      dailyLimit: Math.max(0, Number(serverData?.dailyLimit) ?? prev.dailyLimit),
      baseUsedToday: Math.max(0, Number(serverData?.usedToday) ?? prev.baseUsedToday),
      usedDate: String(serverData?.usedDate || prev.usedDate || today),
      lastVerifyOk: reason === "DAILY_LIMIT", // DAILY_LIMIT vẫn giữ thông tin user nhưng evaluateLocalLicense sẽ chặn
      verifiedAt: nowMs,
      cacheExpiresAt: nowMs + (reason === "DAILY_LIMIT" ? LICENSE_CACHE_TTL_MS : 0),
      lastReason: reason,
      lastError: msg,
    };
  }

  function incrementPendingUsage(rawState, amount = 1, nowMs = Date.now()) {
    const state = normalizeLicenseState(rawState);
    const today = getTodayDateKey(nowMs);
    const inc = Math.max(1, Number(amount) || 1);
    if (state.usedDate && state.usedDate !== today) {
      return {
        ...state,
        baseUsedToday: 0,
        usedDate: today,
        pendingUsageDelta: state.pendingUsageDelta + inc,
      };
    }
    return {
      ...state,
      usedDate: state.usedDate || today,
      pendingUsageDelta: state.pendingUsageDelta + inc,
    };
  }

  const exported = {
    LICENSE_CACHE_TTL_MS,
    GRACE_RETRY_TTL_MS,
    USAGE_SYNC_BATCH_SIZE,
    getTodayDateKey,
    normalizeLicenseKey,
    normalizeLicenseApiUrl,
    isValidAppsScriptUrl,
    createEmptyLicenseState,
    normalizeLicenseState,
    isExpiredDate,
    formatStatusMessage,
    evaluateLocalLicense,
    applyServerVerifyResult,
    incrementPendingUsage,
  };

  root.TaxCapLicense = exported;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
})(typeof self !== "undefined" ? self : globalThis);
