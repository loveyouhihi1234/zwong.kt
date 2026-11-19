(() => {
  const SVG_PREFIX = "data:image/svg+xml;base64,";
  const MIN_SVG_CONFIDENCE = 80;

  function decodeBase64Svg(src) {
    try {
      const raw = src.slice(SVG_PREFIX.length);
      const bin = atob(raw);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8").decode(bytes);
    } catch {
      return "";
    }
  }

  /**
   * Tầng 0 cho riêng HĐĐT: giải trực tiếp mã SVG vector trong DOM (<5ms, không cần API).
   * Trả về null nếu độ tin cậy thấp hoặc cổng đổi cấu trúc để tự động fallback sang ONNX/Gemini.
   */
  function tryLocalSolve(img) {
    const src = img.currentSrc || img.getAttribute("src") || "";
    if (!src.startsWith(SVG_PREFIX) || !window.SvgCaptcha) return null;

    const svg = decodeBase64Svg(src);
    if (!svg || !svg.includes("<path")) return null;

    const t0 = performance.now();
    const res = window.SvgCaptcha.solve(svg);
    const latencyMs = Math.max(1, Math.round(performance.now() - t0));

    if (!res || res.confidence < MIN_SVG_CONFIDENCE) return null;
    if (!/^[A-Za-z0-9]{4,8}$/.test(res.text || "")) return null;

    return {
      captcha: res.text,
      confidence: res.confidence,
      latencyMs,
      source: "svg-local",
    };
  }

  function findPairs() {
    const pairs = [];
    for (const img of document.querySelectorAll('img[alt="captcha"]')) {
      const src = img.getAttribute("src") || "";
      if (!src) continue;
      if (!src.startsWith(SVG_PREFIX) && !(img.complete && img.naturalWidth > 0)) continue;
      if (!img.checkVisibility()) continue;
      const scope = img.closest("form") || img.closest(".ant-modal-content") || document;
      const input = scope.querySelector('input[id="cvalue"], input[id$="_cvalue"], input[name="cvalue"]');
      if (input?.checkVisibility()) pairs.push({ img, input });
    }
    return pairs;
  }

  window.taxcapWatchCaptchas({
    portal: "hddt",
    findPairs,
    readImage: window.taxcapReadCanvasImage,
    tryLocalSolve,
  });
})();
