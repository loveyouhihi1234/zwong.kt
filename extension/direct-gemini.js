// Logic trí nhớ cục bộ + gọi thẳng Gemini REST API + Kho dữ liệu & Nhật ký cho TaxCap Standalone Extension
// Dùng chung được cả trong Service Worker (importScripts) và Node unit test.
(function (root) {
  const DIRECT_MODELS = {
    fast: "gemini-3.1-flash-lite",
    accurate: "gemini-4-hydrogen",
  };

  const PORTAL_IDS = ["hddt", "tdt", "dvc", "tracuunnt"];

  const PORTAL_PROFILES = {
    hddt: {
      shortName: "HĐĐT",
      promptRules:
        "Portal: Hóa đơn điện tử (hoadondientu.gdt.gov.vn). Typical captcha: 6 uppercase alphanumeric characters (A-Z, 0-9) with crossing lines/dots. Preserve lowercase only if clearly lowercase. Carefully distinguish 0 vs O, 1 vs I vs L, 5 vs S, 8 vs B, 2 vs Z.",
    },
    tdt: {
      shortName: "Thuế ĐT",
      promptRules:
        "Portal: Thuế điện tử eTax (thuedientu.gdt.gov.vn). Typical captcha: 4 to 6 alphanumeric characters (A-Z, a-z, 0-9) with background speckle/line noise. Preserve exact case when clear.",
    },
    dvc: {
      shortName: "DVC Thuế",
      promptRules:
        "Portal: Dịch vụ công Thuế (dichvucong.gdt.gov.vn). Typical captcha: 5 distorted characters, usually lowercase letters (a-z) and digits (0-9) on a light gray box with thin crossing lines. Preserve lowercase when lowercase. Carefully distinguish 0 vs o, 1 vs l vs i, 6 vs b, 5 vs s, g vs q.",
    },
    tracuunnt: {
      shortName: "Tra cứu NNT",
      promptRules:
        "Portal: Tra cứu Người nộp thuế (tracuunnt.gdt.gov.vn). Typical captcha: 5 to 6 alphanumeric characters (A-Z, a-z, 0-9) in a small noisy bitmap. Preserve exact case.",
    },
  };

  const MAX_EXACT_HASHES = 400;
  const MAX_FEWSHOTS_PER_PORTAL = 3;
  const MAX_SAMPLES = 60;
  const MAX_LOGS = 100;

  function resolveDirectModel(speedMode) {
    return speedMode === "accurate" ? DIRECT_MODELS.accurate : DIRECT_MODELS.fast;
  }

  function sanitizeCaptchaText(raw) {
    if (typeof raw !== "string") return "";
    const cleaned = raw
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ""))
      .replace(/[`'"\s\r\n\t]/g, "")
      .replace(/[^A-Za-z0-9]/g, "");
    if (cleaned.length < 2 || cleaned.length > 12) {
      return cleaned.slice(0, 12);
    }
    return cleaned;
  }

  function parseImageDataUrl(input) {
    if (typeof input !== "string") return null;
    const trimmed = input.trim();
    if (!trimmed) return null;
    const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(trimmed);
    if (!match || match[2].length < 32) return null;
    const mime = match[1].toLowerCase();
    return {
      mimeType: mime === "image/jpg" ? "image/jpeg" : mime,
      data: match[2],
    };
  }

  function hashBase64Quick(str) {
    let h1 = 2166136261;
    let h2 = 33554467;
    const s = String(str || "");
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      h1 ^= code;
      h1 = Math.imul(h1, 16777619);
      h2 ^= code + (i & 255);
      h2 = Math.imul(h2, 2654435761);
    }
    return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}:${s.length}`;
  }

  function maskCode(code) {
    const s = String(code || "");
    if (!s) return "—";
    if (s.length <= 2) return "*".repeat(s.length);
    return `${s[0]}${"*".repeat(s.length - 2)}${s[s.length - 1]}`;
  }

  function createEmptyMemoryState() {
    return {
      version: 1,
      exactHashes: {},
      portalHints: {},
      fewShots: {},
      stats: {
        learnedCount: 0,
        correctedCount: 0,
      },
    };
  }

  function normalizeMemoryState(raw) {
    const base = createEmptyMemoryState();
    if (!raw || typeof raw !== "object") return base;
    return {
      version: 1,
      exactHashes: raw.exactHashes && typeof raw.exactHashes === "object" ? raw.exactHashes : {},
      portalHints: raw.portalHints && typeof raw.portalHints === "object" ? raw.portalHints : {},
      fewShots: raw.fewShots && typeof raw.fewShots === "object" ? raw.fewShots : {},
      stats: {
        learnedCount: Number(raw.stats?.learnedCount) || 0,
        correctedCount: Number(raw.stats?.correctedCount) || 0,
      },
    };
  }

  function trimExactHashes(exactHashes) {
    const entries = Object.entries(exactHashes);
    if (entries.length <= MAX_EXACT_HASHES) return exactHashes;
    entries.sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
    return Object.fromEntries(entries.slice(0, MAX_EXACT_HASHES));
  }

  function updateLocalLearningState(prevState, event) {
    const state = normalizeMemoryState(prevState);
    const portal = PORTAL_PROFILES[event?.portal] ? event.portal : "hddt";
    const outcome = event?.outcome;
    const predicted = sanitizeCaptchaText(String(event?.predicted || ""));
    const finalLabel = sanitizeCaptchaText(String(event?.finalLabel || ""));
    const imageHash = String(event?.imageHash || "");
    const now = Number(event?.timestamp) || Date.now();

    if (outcome === "rejected") {
      if (imageHash && state.exactHashes[imageHash]) {
        delete state.exactHashes[imageHash];
      }
      return state;
    }

    if ((outcome !== "verified" && outcome !== "corrected") || finalLabel.length < 2) {
      return state;
    }

    if (imageHash) {
      state.exactHashes[imageHash] = {
        label: finalLabel,
        portal,
        updatedAt: now,
      };
      state.exactHashes = trimExactHashes(state.exactHashes);
    }

    const portalHint = state.portalHints[portal] || {
      usableCount: 0,
      correctedCount: 0,
      lengthCounts: {},
      confusionCounts: {},
    };
    portalHint.usableCount += 1;
    const lenKey = String(finalLabel.length);
    portalHint.lengthCounts[lenKey] = (portalHint.lengthCounts[lenKey] || 0) + 1;

    if (outcome === "corrected" && predicted && predicted !== finalLabel) {
      portalHint.correctedCount += 1;
      state.stats.correctedCount += 1;
      if (predicted.length === finalLabel.length) {
        for (let i = 0; i < predicted.length; i++) {
          if (predicted[i] !== finalLabel[i]) {
            const pairKey = `${predicted[i]}->${finalLabel[i]}`;
            portalHint.confusionCounts[pairKey] = (portalHint.confusionCounts[pairKey] || 0) + 1;
          }
        }
      }
    }
    state.portalHints[portal] = portalHint;
    state.stats.learnedCount += 1;

    if (event?.mimeType && event?.base64Data && String(event.base64Data).length <= 32000) {
      const list = Array.isArray(state.fewShots[portal]) ? [...state.fewShots[portal]] : [];
      const deduped = list.filter((item) => item.imageHash !== imageHash);
      deduped.unshift({
        imageHash,
        mimeType: event.mimeType,
        data: event.base64Data,
        label: finalLabel,
        isCorrection: outcome === "corrected",
        updatedAt: now,
      });
      deduped.sort((a, b) => {
        if (Boolean(a.isCorrection) !== Boolean(b.isCorrection)) {
          return a.isCorrection ? -1 : 1;
        }
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
      state.fewShots[portal] = deduped.slice(0, MAX_FEWSHOTS_PER_PORTAL);
    }

    return state;
  }

  function getExactMemoryMatch(state, portal, imageHash) {
    if (!imageHash || !state?.exactHashes) return null;
    const entry = state.exactHashes[imageHash];
    if (!entry || entry.portal !== portal || !entry.label) return null;
    return entry.label;
  }

  function getAdaptiveHints(state, portal) {
    const raw = state?.portalHints?.[portal];
    if (!raw || !raw.usableCount) return null;

    const observedLengths = Object.entries(raw.lengthCounts || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([len]) => Number(len))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);

    const confusions = Object.entries(raw.confusionCounts || {})
      .map(([key, count]) => {
        const [from, to] = key.split("->");
        return { from, to, count: Number(count) || 0 };
      })
      .filter((c) => c.from && c.to && c.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      usableCount: raw.usableCount,
      correctedCount: raw.correctedCount || 0,
      observedLengths,
      confusions,
    };
  }

  function getFewShotExamples(state, portal, options) {
    const speedMode = options?.speedMode === "accurate" ? "accurate" : "fast";
    const bypassCache = Boolean(options?.bypassCache);
    if (!bypassCache && speedMode !== "accurate") return [];
    const list = state?.fewShots?.[portal];
    if (!Array.isArray(list) || list.length === 0) return [];
    return list.slice(0, 2);
  }

  function buildAdaptivePrompt(portal, hints) {
    const profile = PORTAL_PROFILES[portal] || PORTAL_PROFILES.hddt;
    const parts = [
      "Read the exact alphanumeric CAPTCHA characters shown in this image.",
      profile.promptRules,
    ];

    if (hints && hints.usableCount >= 1) {
      const statBits = [];
      if (Array.isArray(hints.observedLengths) && hints.observedLengths.length > 0) {
        statBits.push(`observed character counts: ${hints.observedLengths.join("/")}`);
      }
      if (Array.isArray(hints.confusions) && hints.confusions.length > 0) {
        const top = hints.confusions
          .slice(0, 5)
          .map((c) => `'${c.from}'->'${c.to}' (${c.count}x)`)
          .join(", ");
        statBits.push(`past OCR misreads corrected by users here (double-check carefully): ${top}`);
      }
      if (statBits.length > 0) {
        parts.push(`Learned history (${hints.usableCount} labeled samples): ${statBits.join("; ")}.`);
      }
    }

    parts.push("Reply with ONLY the characters, no spaces, quotes, or extra text.");
    return parts.join(" ");
  }

  function buildGeminiRequestBody({ portal, parsedImage, speedMode, hints, fewShots }) {
    const parts = [];
    if (Array.isArray(fewShots) && fewShots.length > 0) {
      parts.push({
        text: `Reference solved examples from this portal (${portal}) to calibrate tricky characters:`,
      });
      for (const ex of fewShots) {
        if (!ex?.mimeType || !ex?.data || !ex?.label) continue;
        parts.push({
          inlineData: {
            mimeType: ex.mimeType,
            data: ex.data,
          },
        });
        parts.push({ text: `Example answer: ${ex.label}` });
      }
      parts.push({ text: "Now solve this target CAPTCHA image:" });
    }

    parts.push({
      inlineData: {
        mimeType: parsedImage.mimeType,
        data: parsedImage.data,
      },
    });
    parts.push({ text: buildAdaptivePrompt(portal, hints) });

    return {
      contents: [{ role: "user", parts }],
      generationConfig: {
        thinkingConfig: {
          thinkingLevel: speedMode === "accurate" ? "LOW" : "MINIMAL",
        },
      },
    };
  }

  function extractGeminiCaptchaText(apiJson) {
    const parts = apiJson?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return "";
    const text = parts
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join(" ")
      .trim();
    return sanitizeCaptchaText(text);
  }

  // --- Kho dữ liệu cục bộ (tương đương Kho Dữ liệu của TaxCap Studio) ---
  function recordSampleInDataset(prevSamples, entry, maxSamples = MAX_SAMPLES) {
    const list = Array.isArray(prevSamples) ? prevSamples : [];
    const portal = PORTAL_PROFILES[entry?.portal] ? entry.portal : "hddt";
    const item = {
      sampleId: String(entry?.sampleId || ""),
      timestamp: entry?.timestamp || new Date().toISOString(),
      portal,
      source: String(entry?.source || "direct-gemini"),
      predicted: sanitizeCaptchaText(String(entry?.predicted || "")),
      finalLabel: "",
      outcome: "pending",
      latencyMs: Math.max(0, Math.round(Number(entry?.latencyMs) || 0)),
      imageDataUrl: typeof entry?.imageDataUrl === "string" ? entry.imageDataUrl : "",
      imageHash: String(entry?.imageHash || ""),
    };
    const next = [item, ...list.filter((s) => s.sampleId !== item.sampleId)];
    return next.slice(0, maxSamples);
  }

  function applySampleFeedback(prevSamples, { sampleId, outcome, finalLabel }) {
    const list = Array.isArray(prevSamples) ? prevSamples : [];
    const cleaned = sanitizeCaptchaText(String(finalLabel || ""));
    let updatedSample = null;
    const next = list.map((s) => {
      if (s.sampleId !== sampleId) return s;
      const nextOutcome =
        outcome === "verified" || outcome === "corrected" || outcome === "rejected" ? outcome : s.outcome;
      updatedSample = {
        ...s,
        outcome: nextOutcome,
        finalLabel: nextOutcome === "rejected" ? "" : cleaned || s.predicted,
      };
      return updatedSample;
    });
    return { samples: next, updatedSample };
  }

  function computeDatasetSummary(samples) {
    const list = Array.isArray(samples) ? samples : [];
    const byPortalMap = {};
    for (const id of PORTAL_IDS) {
      byPortalMap[id] = {
        portal: id,
        shortName: PORTAL_PROFILES[id].shortName,
        total: 0,
        usable: 0,
        verified: 0,
        corrected: 0,
        rejected: 0,
        pending: 0,
        accuracyPercent: null,
      };
    }

    let verified = 0;
    let corrected = 0;
    let rejected = 0;
    let pending = 0;

    for (const s of list) {
      const p = byPortalMap[s.portal] || byPortalMap.hddt;
      p.total += 1;
      if (s.outcome === "verified") {
        p.verified += 1;
        p.usable += 1;
        verified += 1;
      } else if (s.outcome === "corrected") {
        p.corrected += 1;
        p.usable += 1;
        corrected += 1;
      } else if (s.outcome === "rejected") {
        p.rejected += 1;
        rejected += 1;
      } else {
        p.pending += 1;
        pending += 1;
      }
    }

    const byPortal = PORTAL_IDS.map((id) => {
      const p = byPortalMap[id];
      const denom = p.verified + p.corrected + p.rejected;
      p.accuracyPercent = denom > 0 ? Math.round((p.verified / denom) * 100) : null;
      return p;
    });

    const usable = verified + corrected;
    const totalJudged = usable + rejected;
    const accuracyPercent = totalJudged > 0 ? Math.round((verified / totalJudged) * 100) : null;

    return {
      total: list.length,
      usable,
      verified,
      corrected,
      rejected,
      pending,
      accuracyPercent,
      byPortal,
    };
  }

  // --- Nhật ký cục bộ (tương đương Nhật ký Proxy của TaxCap Studio) ---
  function createLogEntry({ id, portal, status, code, latencyMs, message, timestamp }) {
    const safePortal = PORTAL_PROFILES[portal] ? portal : "hddt";
    const safeStatus = status === "ok" ? "ok" : "error";
    return {
      id: String(id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
      timestamp: timestamp || new Date().toISOString(),
      portal: safePortal,
      status: safeStatus,
      codeMasked: safeStatus === "ok" ? maskCode(code) : "—",
      latencyMs: Math.max(0, Math.round(Number(latencyMs) || 0)),
      message: String(message || ""),
    };
  }

  function appendSolveLog(prevLogs, entry, maxLogs = MAX_LOGS) {
    const list = Array.isArray(prevLogs) ? prevLogs : [];
    return [entry, ...list].slice(0, maxLogs);
  }

  function computeLogStats(logs) {
    const list = Array.isArray(logs) ? logs : [];
    const total = list.length;
    let successCount = 0;
    let errorCount = 0;
    let latencySum = 0;
    for (const item of list) {
      if (item.status === "ok") successCount += 1;
      else errorCount += 1;
      latencySum += Number(item.latencyMs) || 0;
    }
    const avgLatencyMs = total > 0 ? Math.round(latencySum / total) : 0;
    const successRate = total > 0 ? Math.round((successCount / total) * 100) : 0;
    return { total, successCount, errorCount, avgLatencyMs, successRate };
  }

  const exported = {
    DIRECT_MODELS,
    PORTAL_IDS,
    PORTAL_PROFILES,
    resolveDirectModel,
    sanitizeCaptchaText,
    parseImageDataUrl,
    hashBase64Quick,
    maskCode,
    createEmptyMemoryState,
    normalizeMemoryState,
    updateLocalLearningState,
    getExactMemoryMatch,
    getAdaptiveHints,
    getFewShotExamples,
    buildAdaptivePrompt,
    buildGeminiRequestBody,
    extractGeminiCaptchaText,
    recordSampleInDataset,
    applySampleFeedback,
    computeDatasetSummary,
    createLogEntry,
    appendSolveLog,
    computeLogStats,
  };

  root.TaxCapDirect = exported;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
})(typeof self !== "undefined" ? self : globalThis);
