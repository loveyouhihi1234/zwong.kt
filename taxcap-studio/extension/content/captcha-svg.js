// Giải captcha SVG kiểu svg-captcha cho Hóa đơn điện tử: mỗi ký tự là một <path fill> riêng, đường nhiễu là <path fill="none">.
// Thuần xử lý chuỗi & hình học (<5ms, không cần canvas hay API), tự động fallback sang ONNX/Gemini nếu không khớp mẫu.
(() => {
  /** Tách các ký tự trong SVG, sắp xếp từ trái sang phải. */
  function parseSvgCaptcha(svg) {
    if (typeof svg !== "string" || !svg) return [];
    const glyphs = [];
    for (const [tag] of svg.matchAll(/<path\b[^>]*>/gi)) {
      if (/\bfill\s*=\s*(["'])none\1/i.test(tag)) continue; // đường nhiễu
      if (/\bstyle\s*=\s*(["'])[^"']*\bfill\s*:\s*none\b/i.test(tag)) continue;
      const d = tag.match(/\bd\s*=\s*(["'])([^"']+)\1/i)?.[2];
      if (!d) continue;
      const norm = normalizePath(d);
      if (norm) glyphs.push(norm);
    }
    return glyphs.sort((a, b) => a.cx - b.cx);
  }

  /** Chuẩn hóa path: chuỗi lệnh + tọa độ đưa về khung cao = 1 (không phụ thuộc vị trí, cỡ chữ). */
  function normalizePath(d) {
    const cmdsMatch = d.match(/[A-Za-z]/g);
    const numsMatch = d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi);
    if (!cmdsMatch || !numsMatch || numsMatch.length < 2) return null;

    const cmds = cmdsMatch.join("");
    const nums = numsMatch.map(Number);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = nums[i];
      const y = nums[i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) return null;
    const size = y1 - y0 || 1;
    const pts = nums.map((v, i) => (i % 2 ? (v - y0) : (v - x0)) / size);
    return { cmds, pts, cx: (x0 + x1) / 2, aspect: (x1 - x0) / size };
  }

  /**
   * Nhận diện từng ký tự bằng bảng mẫu.
   * @param {Array<{ch, cmds, pts, aspect}>} templates
   * @returns {{text: string, confidence: number, chars: Array<{ch, distance}>}}
   */
  function matchSvgGlyphs(glyphs, templates, { charset } = {}) {
    if (!Array.isArray(glyphs) || !glyphs.length || !Array.isArray(templates) || !templates.length) {
      return { text: "", confidence: 0, chars: [] };
    }
    const pool = charset ? templates.filter((t) => charset.includes(t.ch)) : templates;
    if (!pool.length) {
      return { text: "", confidence: 0, chars: [] };
    }
    const chars = glyphs.map((g) => {
      let best = { ch: "", distance: Infinity };
      for (const t of pool) {
        const distance = glyphDistance(g, t);
        if (distance < best.distance) best = { ch: t.ch, distance };
      }
      return best;
    });
    const worst = Math.max(0, ...chars.map((c) => c.distance));
    return {
      text: chars.map((c) => c.ch).join(""),
      // khớp cùng cấu trúc lệnh: distance ~0.002-0.003 (chỉ do nhiễu ±0.1) -> ~94-100
      confidence: Math.max(0, Math.round(100 - worst * 2000)),
      chars,
    };
  }

  function glyphDistance(g, t) {
    if (g.cmds === t.cmds && g.pts.length === t.pts.length) {
      let sum = 0;
      for (let i = 0; i < g.pts.length; i++) sum += Math.abs(g.pts[i] - t.pts[i]);
      return sum / g.pts.length;
    }
    // Khác cấu trúc (font khác / path bị biến đổi): so sánh thô theo tỉ lệ khung + độ dài lệnh
    return 1 + Math.abs(g.aspect - t.aspect) + Math.abs(g.cmds.length - t.cmds.length) / Math.max(g.cmds.length, t.cmds.length);
  }

  const solve = (svg) => matchSvgGlyphs(parseSvgCaptcha(svg), self.SVG_CAPTCHA_TEMPLATES);

  self.SvgCaptcha = { parseSvgCaptcha, matchSvgGlyphs, solve };
})();
