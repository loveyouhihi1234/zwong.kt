import type { PortalId } from './captchaLogic.ts';

export interface PortalProfile {
  portal: PortalId;
  expectedLengths: number[];
  caseRule: 'upper' | 'lower' | 'mixed';
  ruleSummaryVi: string;
  promptRules: string;
}

export interface ConfusionPair {
  from: string;
  to: string;
  count: number;
}

export interface PortalLearnedHints {
  portal: PortalId;
  usableCount: number;
  correctedCount: number;
  observedLengths: number[];
  confusions: ConfusionPair[];
}

export const PORTAL_PROFILES: Record<PortalId, PortalProfile> = {
  hddt: {
    portal: 'hddt',
    expectedLengths: [6],
    caseRule: 'upper',
    ruleSummaryVi: 'Thường dài 6 ký tự (chữ in hoa A–Z & số 0–9), nét SVG rõ trên nền sáng.',
    promptRules:
      'Portal: Hóa đơn điện tử (hoadondientu.gdt.gov.vn). Typical captcha: 6 uppercase alphanumeric characters (A-Z, 0-9) with crossing lines/dots. Preserve lowercase only if clearly lowercase. Carefully distinguish 0 vs O, 1 vs I vs L, 5 vs S, 8 vs B, 2 vs Z.',
  },
  tdt: {
    portal: 'tdt',
    expectedLengths: [4, 5, 6],
    caseRule: 'mixed',
    ruleSummaryVi: 'Thường dài 4–6 ký tự chữ và số, nền có nhiễu chấm/sọc nhẹ.',
    promptRules:
      'Portal: Thuế điện tử eTax (thuedientu.gdt.gov.vn). Typical captcha: 4 to 6 alphanumeric characters (A-Z, a-z, 0-9) with background speckle/line noise. Preserve exact case when clear.',
  },
  dvc: {
    portal: 'dvc',
    expectedLengths: [5],
    caseRule: 'lower',
    ruleSummaryVi: 'Thường dài 5 ký tự (hay gặp chữ thường a–z & số 0–9, chữ nghiêng/nối nhẹ trên nền xám).',
    promptRules:
      'Portal: Dịch vụ công Thuế (dichvucong.gdt.gov.vn). Typical captcha: 5 distorted characters, usually lowercase letters (a-z) and digits (0-9) on a light gray box with thin crossing lines. Preserve lowercase when lowercase. Carefully distinguish 0 vs o, 1 vs l vs i, 6 vs b, 5 vs s, g vs q.',
  },
  tracuunnt: {
    portal: 'tracuunnt',
    expectedLengths: [5, 6],
    caseRule: 'mixed',
    ruleSummaryVi: 'Thường dài 5–6 ký tự chữ và số, ảnh bitmap nhỏ có nhiễu nền.',
    promptRules:
      'Portal: Tra cứu Người nộp thuế (tracuunnt.gdt.gov.vn). Typical captcha: 5 to 6 alphanumeric characters (A-Z, a-z, 0-9) in a small noisy bitmap. Preserve exact case.',
  },
};

export interface LabeledSampleLike {
  portal: PortalId;
  predicted: string;
  finalLabel: string;
  outcome: 'pending' | 'verified' | 'corrected' | 'rejected';
}

/**
 * Extracts character-level confusion pairs and observed captcha lengths per portal
 * from user-verified and user-corrected samples in the Bước 1 dataset.
 */
export function computePortalConfusionHints(
  samples: LabeledSampleLike[],
): Record<PortalId, PortalLearnedHints> {
  const portals: PortalId[] = ['hddt', 'tdt', 'dvc', 'tracuunnt'];
  const result = {} as Record<PortalId, PortalLearnedHints>;

  for (const portal of portals) {
    const relevant = samples.filter(
      (s) =>
        s.portal === portal &&
        (s.outcome === 'verified' || s.outcome === 'corrected') &&
        s.finalLabel.length >= 2,
    );

    const lengthCounts = new Map<number, number>();
    const pairCounts = new Map<string, number>();
    let correctedCount = 0;

    for (const s of relevant) {
      lengthCounts.set(s.finalLabel.length, (lengthCounts.get(s.finalLabel.length) || 0) + 1);
      if (s.outcome === 'corrected' && s.predicted && s.predicted !== s.finalLabel) {
        correctedCount += 1;
        if (s.predicted.length === s.finalLabel.length) {
          for (let i = 0; i < s.predicted.length; i++) {
            const from = s.predicted[i];
            const to = s.finalLabel[i];
            if (from !== to) {
              const key = `${from}->${to}`;
              pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
            }
          }
        }
      }
    }

    const observedLengths = Array.from(lengthCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([len]) => len)
      .sort((a, b) => a - b);

    const confusions: ConfusionPair[] = Array.from(pairCounts.entries())
      .map(([key, count]) => {
        const [from, to] = key.split('->');
        return { from, to, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    result[portal] = {
      portal,
      usableCount: relevant.length,
      correctedCount,
      observedLengths,
      confusions,
    };
  }

  return result;
}

/**
 * Builds an adaptive Gemini OCR prompt combining portal rules with real learned
 * confusion patterns from the Bước 1 dataset.
 */
export function buildAdaptivePortalPrompt(
  portal: PortalId,
  hints?: PortalLearnedHints | null,
): string {
  const profile = PORTAL_PROFILES[portal] || PORTAL_PROFILES.hddt;
  const parts: string[] = [
    'Read the exact alphanumeric CAPTCHA characters shown in this image.',
    profile.promptRules,
  ];

  if (hints && hints.usableCount >= 1) {
    const statBits: string[] = [];
    if (hints.observedLengths.length > 0) {
      statBits.push(`observed character counts: ${hints.observedLengths.join('/')}`);
    }
    if (hints.confusions.length > 0) {
      const top = hints.confusions
        .slice(0, 5)
        .map((c) => `'${c.from}'->'${c.to}' (${c.count}x)`)
        .join(', ');
      statBits.push(`past OCR misreads corrected by users here (double-check carefully): ${top}`);
    }
    if (statBits.length > 0) {
      parts.push(`Learned history (${hints.usableCount} labeled samples): ${statBits.join('; ')}.`);
    }
  }

  parts.push('Reply with ONLY the characters, no spaces, quotes, or extra text.');
  return parts.join(' ');
}

/**
 * Pure RGBA pixel contrast-stretching + background whitening + isolated speckle cleanup.
 * Runs in < 2ms on typical captcha sizes (150x48 to 350x100) with zero native dependencies.
 */
export function enhanceCaptchaPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const totalPixels = width * height;
  if (totalPixels === 0 || data.length < totalPixels * 4) return data;

  const lum = new Uint8Array(totalPixels);
  const hist = new Uint32Array(256);

  for (let i = 0; i < totalPixels; i++) {
    const p = i * 4;
    const alpha = data[p + 3];
    let l: number;
    if (alpha < 24) {
      l = 255;
    } else {
      // Blend over white background according to alpha
      const a = alpha / 255;
      const r = data[p] * a + 255 * (1 - a);
      const g = data[p + 1] * a + 255 * (1 - a);
      const b = data[p + 2] * a + 255 * (1 - a);
      l = Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
    }
    lum[i] = l;
    hist[l] += 1;
  }

  // Find 8th percentile (foreground ink floor) and 72nd percentile (background ceiling)
  const lowTarget = Math.max(1, Math.floor(totalPixels * 0.08));
  const highTarget = Math.max(lowTarget + 1, Math.floor(totalPixels * 0.72));
  let cum = 0;
  let darkFloor = 0;
  let bgCeiling = 255;
  let foundLow = false;

  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (!foundLow && cum >= lowTarget) {
      darkFloor = v;
      foundLow = true;
    }
    if (cum >= highTarget) {
      bgCeiling = v;
      break;
    }
  }

  const cutoff = Math.min(248, Math.round(bgCeiling * 0.92));
  const span = cutoff - darkFloor;

  const gray = new Uint8Array(totalPixels);
  if (span < 16) {
    // Nearly flat image: only whiten transparent/very bright pixels safely
    for (let i = 0; i < totalPixels; i++) {
      gray[i] = lum[i] > 235 ? 255 : lum[i];
    }
  } else {
    for (let i = 0; i < totalPixels; i++) {
      const l = lum[i];
      if (l >= cutoff) {
        gray[i] = 255;
      } else {
        const norm = Math.max(0, Math.min(1, (l - darkFloor) / span));
        const boosted = Math.pow(norm, 1.15);
        gray[i] = Math.round(10 + boosted * 226);
      }
    }
  }

  // Light isolated-speckle removal (only removes faint gray dots surrounded >=7/8 by pure white)
  const cleaned = new Uint8Array(gray);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const val = gray[idx];
      if (val > 130 && val < 255) {
        let whiteNeighbors = 0;
        if (gray[idx - width - 1] >= 245) whiteNeighbors++;
        if (gray[idx - width] >= 245) whiteNeighbors++;
        if (gray[idx - width + 1] >= 245) whiteNeighbors++;
        if (gray[idx - 1] >= 245) whiteNeighbors++;
        if (gray[idx + 1] >= 245) whiteNeighbors++;
        if (gray[idx + width - 1] >= 245) whiteNeighbors++;
        if (gray[idx + width] >= 245) whiteNeighbors++;
        if (gray[idx + width + 1] >= 245) whiteNeighbors++;
        if (whiteNeighbors >= 7) {
          cleaned[idx] = 255;
        }
      }
    }
  }

  for (let i = 0; i < totalPixels; i++) {
    const p = i * 4;
    const v = cleaned[i];
    data[p] = v;
    data[p + 1] = v;
    data[p + 2] = v;
    data[p + 3] = 255;
  }

  return data;
}
