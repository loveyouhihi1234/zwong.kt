import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SVG_DATA_PREFIX = 'data:image/svg+xml;base64,';
const MIN_SVG_CONFIDENCE = 80;

export interface SvgSolveResult {
  captcha: string;
  confidence: number;
  latencyMs: number;
}

interface SvgCaptchaEngine {
  solve: (svg: string) => { text: string; confidence: number; chars: Array<{ ch: string; distance: number }> };
}

let cachedEngine: SvgCaptchaEngine | null | undefined;

function getEngine(): SvgCaptchaEngine | null {
  if (cachedEngine !== undefined) return cachedEngine;
  try {
    const extDir = path.resolve(process.cwd(), 'extension', 'content');
    const templatesCode = fs.readFileSync(path.join(extDir, 'captcha-svg-templates.js'), 'utf8');
    const solverCode = fs.readFileSync(path.join(extDir, 'captcha-svg.js'), 'utf8');
    const sandbox: Record<string, unknown> = {};
    sandbox.self = sandbox;
    vm.runInNewContext(templatesCode, sandbox, { filename: 'captcha-svg-templates.js' });
    vm.runInNewContext(solverCode, sandbox, { filename: 'captcha-svg.js' });
    const engine = sandbox.SvgCaptcha as SvgCaptchaEngine | undefined;
    cachedEngine = engine && typeof engine.solve === 'function' ? engine : null;
  } catch {
    cachedEngine = null;
  }
  return cachedEngine;
}

/**
 * Tier-0 solver for Hóa đơn điện tử (`hddt`) raw SVG data URIs.
 * Returns null whenever the input is not a matching svg-captcha outline or confidence < 80,
 * allowing automatic fallback to Memory / ONNX / Gemini Flash.
 */
export function solveHddtSvgDataUrl(svgDataUrl: string): SvgSolveResult | null {
  if (typeof svgDataUrl !== 'string' || !svgDataUrl.startsWith(SVG_DATA_PREFIX)) {
    return null;
  }
  const engine = getEngine();
  if (!engine) return null;

  let svg = '';
  try {
    const b64 = svgDataUrl.slice(SVG_DATA_PREFIX.length);
    svg = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!svg || !svg.includes('<path')) return null;

  const t0 = performance.now();
  const res = engine.solve(svg);
  const latencyMs = Math.max(1, Math.round(performance.now() - t0));

  if (!res || res.confidence < MIN_SVG_CONFIDENCE) return null;
  if (!/^[A-Za-z0-9]{4,8}$/.test(res.text || '')) return null;

  return {
    captcha: res.text,
    confidence: res.confidence,
    latencyMs,
  };
}
