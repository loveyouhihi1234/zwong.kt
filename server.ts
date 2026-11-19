import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  PORTAL_LIST,
  getModelForSpeedMode,
  isValidPortal,
  parseCaptchaImageInput,
  resolveSolveMode,
  sanitizeCaptchaText,
  type PortalId,
} from './src/utils/captchaLogic.ts';
import { createRateLimiter } from './server/rateLimit.ts';
import { buildExtensionArtifacts } from './server/extensionBundle.ts';
import { isSameOriginSandboxRequest, normalizeExtensionToken } from './server/auth.ts';
import { createDatasetStore } from './server/dataset.ts';
import { createMemoryStore, type FewShotMode } from './server/memory.ts';
import { createLocalOcrRouter } from './server/localOcr.ts';
import { solveHddtSvgDataUrl } from './server/svgCaptcha.ts';
import { buildAdaptivePortalPrompt } from './src/utils/portalRules.ts';

const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_FAST_MODEL = getModelForSpeedMode('fast');
const SOLVE_CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 200;

const solveCache = new Map<
  string,
  { captcha: string; model: string; sampleId: string; expiresAt: number }
>();
const datasetStore = createDatasetStore();
const memoryStore = createMemoryStore({
  getAllSamples: () => datasetStore.getAllSamples(),
});
const localOcr = createLocalOcrRouter();

export interface SolveLogEntry {
  id: string;
  timestamp: string;
  portal: PortalId;
  status: 'ok' | 'error';
  codeMasked: string;
  latencyMs: number;
  message: string;
}

const solveLogs: SolveLogEntry[] = [];
const MAX_LOG_ENTRIES = 100;

function recordLog(entry: SolveLogEntry) {
  solveLogs.unshift(entry);
  if (solveLogs.length > MAX_LOG_ENTRIES) {
    solveLogs.length = MAX_LOG_ENTRIES;
  }
}

function maskCode(code: string): string {
  if (!code) return '—';
  if (code.length <= 2) return '*'.repeat(code.length);
  return `${code[0]}${'*'.repeat(code.length - 2)}${code[code.length - 1]}`;
}

let cachedAiKey = '';
let cachedAiClient: GoogleGenAI | null = null;

function getAiClient(): GoogleGenAI | null {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']+|["']+$/g, '');
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  if (cachedAiClient && cachedAiKey === apiKey) {
    return cachedAiClient;
  }
  cachedAiKey = apiKey;
  cachedAiClient = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
  return cachedAiClient;
}

const rateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 45,
});

function resolveClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || 'local';
}

function resolveRequestOrigin(req: Request): string {
  const envUrl = process.env.APP_URL?.trim();
  if (envUrl && envUrl !== 'MY_APP_URL') {
    return envUrl.replace(/\/+$/, '');
  }
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

async function startServer() {
  await memoryStore.init().catch(() => {});
  await localOcr.scanModels().catch(() => {});

  // Tự động cập nhật trí nhớ AI định kỳ mỗi 15 phút & kiểm tra model ONNX mới
  const autoConsolidateTimer = setInterval(() => {
    memoryStore.consolidate('auto-timer').catch(() => {});
    localOcr.scanModels().catch(() => {});
  }, 15 * 60 * 1000);
  autoConsolidateTimer.unref?.();

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Allow Chrome Extension background service worker calls cleanly
  app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Extension-Token, X-TaxCap-Sandbox');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  let lastGeminiKeyInvalid = false;

  app.get('/api/health', (req: Request, res: Response) => {
    const ai = getAiClient();
    const geminiKeyFormatValid = Boolean(ai) && !lastGeminiKeyInvalid;
    const requiredToken = normalizeExtensionToken(process.env.EXTENSION_SHARED_TOKEN);
    const providedToken = normalizeExtensionToken(String(req.headers['x-extension-token'] || ''));
    const tokenRequired = Boolean(requiredToken);
    const tokenValid = !tokenRequired || providedToken === requiredToken;
    res.json({
      ok: true,
      model: DEFAULT_FAST_MODEL,
      accurateModel: getModelForSpeedMode('accurate'),
      geminiConfigured: Boolean(ai),
      geminiKeyFormatValid,
      tokenRequired,
      tokenValid,
      portals: PORTAL_LIST.map((p) => p.id),
    });
  });

  app.get('/api/stats', (_req: Request, res: Response) => {
    const total = solveLogs.length;
    const successCount = solveLogs.filter((l) => l.status === 'ok').length;
    const avgLatencyMs =
      successCount > 0
        ? Math.round(
            solveLogs
              .filter((l) => l.status === 'ok')
              .reduce((acc, item) => acc + item.latencyMs, 0) / successCount,
          )
        : 0;

    res.json({
      total,
      successCount,
      errorCount: total - successCount,
      avgLatencyMs,
      logs: solveLogs,
    });
  });

  app.delete('/api/stats', (_req: Request, res: Response) => {
    solveLogs.length = 0;
    res.json({ ok: true });
  });

  app.post('/api/captcha/solve', async (req: Request, res: Response) => {
    const start = Date.now();
    const portalRaw = String(req.body?.portal || '');
    const portal: PortalId = isValidPortal(portalRaw) ? portalRaw : 'hddt';

    const requiredToken = normalizeExtensionToken(process.env.EXTENSION_SHARED_TOKEN);
    if (requiredToken && !isSameOriginSandboxRequest(req, process.env.APP_URL)) {
      const provided = normalizeExtensionToken(String(req.headers['x-extension-token'] || ''));
      if (provided !== requiredToken) {
        recordLog({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          portal,
          status: 'error',
          codeMasked: '—',
          latencyMs: Date.now() - start,
          message: 'Mã truy cập Extension không khớp với EXTENSION_SHARED_TOKEN.',
        });
        res.status(401).json({
          ok: false,
          message: 'Mã truy cập Extension không hợp lệ. Vui lòng kiểm tra mục Mã truy cập nhóm trong Popup.',
        });
        return;
      }
    }

    const ip = resolveClientIp(req);
    const limit = rateLimiter.check(ip);
    if (!limit.allowed) {
      res.status(429).json({
        ok: false,
        message: `Vượt quá giới hạn tần suất. Thử lại sau ${Math.ceil(limit.resetInMs / 1000)} giây.`,
      });
      return;
    }

    const parsedImage = parseCaptchaImageInput(String(req.body?.image || ''));
    if (!parsedImage) {
      res.status(400).json({
        ok: false,
        message: 'Ảnh captcha không hợp lệ (cần PNG/JPEG/WEBP dạng base64).',
      });
      return;
    }

    const speedMode = resolveSolveMode(req.body?.speedMode);
    const activeModel = getModelForSpeedMode(speedMode);
    const bypassCache = Boolean(req.body?.bypassCache);
    const imageHash = crypto.createHash('sha256').update(parsedImage.data).digest('hex');
    const imageHash24 = imageHash.slice(0, 24);
    const cacheKey = `${speedMode}:${imageHash}`;

    if (!bypassCache) {
      // Tầng 0 (riêng HĐĐT khi nhận kèm svgDataUrl từ Sandbox): so khớp mẫu SVG (<5ms)
      if (portal === 'hddt' && typeof req.body?.svgDataUrl === 'string') {
        const svgHit = solveHddtSvgDataUrl(req.body.svgDataUrl);
        if (svgHit) {
          const sampleId = await datasetStore
            .recordSolve({
              portal,
              model: 'svg-local',
              speedMode,
              latencyMs: svgHit.latencyMs,
              predicted: svgHit.captcha,
              mimeType: parsedImage.mimeType,
              base64Data: parsedImage.data,
            })
            .catch(() => '');
          recordLog({
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            portal,
            status: 'ok',
            codeMasked: maskCode(svgHit.captcha),
            latencyMs: svgHit.latencyMs,
            message: `Giải tức thì SVG nội bộ (${svgHit.confidence}%)`,
          });
          res.json({
            ok: true,
            captcha: svgHit.captcha,
            sampleId,
            latencyMs: svgHit.latencyMs,
            model: 'svg-local',
            speedMode,
            source: 'svg-local',
            confidence: svgHit.confidence,
          });
          return;
        }
      }

      // Tầng 1: Trí nhớ vĩnh viễn trên đĩa (<5ms cho ảnh đã được người dùng xác nhận/sửa đúng)
      const memoryHit = await memoryStore.lookupExact(portal, imageHash24).catch(() => null);
      if (memoryHit) {
        const latencyMs = Math.max(1, Date.now() - start);
        recordLog({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          portal,
          status: 'ok',
          codeMasked: maskCode(memoryHit.label),
          latencyMs,
          message: 'Giải tức thì từ Trí nhớ AI (<5ms)',
        });
        res.json({
          ok: true,
          captcha: memoryHit.label,
          sampleId: memoryHit.sampleId,
          latencyMs,
          model: 'memory-exact',
          speedMode,
          source: 'memory',
          cached: true,
        });
        return;
      }

      // Tầng 2: Model ONNX nội bộ (<150ms nếu người dùng đã train ở Bước 3B)
      const localHit = await localOcr.trySolve(portal, parsedImage.data).catch(() => null);
      if (localHit) {
        const sampleId = await datasetStore
          .recordSolve({
            portal,
            model: 'local-onnx',
            speedMode,
            latencyMs: localHit.latencyMs,
            predicted: localHit.captcha,
            mimeType: parsedImage.mimeType,
            base64Data: parsedImage.data,
          })
          .catch(() => '');
        recordLog({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          portal,
          status: 'ok',
          codeMasked: maskCode(localHit.captcha),
          latencyMs: localHit.latencyMs,
          message: `Đọc bằng Model ONNX nội bộ (${Math.round(localHit.confidence * 100)}%)`,
        });
        res.json({
          ok: true,
          captcha: localHit.captcha,
          sampleId,
          latencyMs: localHit.latencyMs,
          model: 'local-onnx',
          speedMode,
          source: 'onnx',
        });
        return;
      }

      // Tầng 3a: Cache RAM ngắn hạn 60s
      const cached = solveCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        const latencyMs = Math.max(1, Date.now() - start);
        recordLog({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          portal,
          status: 'ok',
          codeMasked: maskCode(cached.captcha),
          latencyMs,
          message: `Đọc tức thì từ cache (${speedMode === 'fast' ? 'Flash Lite' : 'Flash'})`,
        });
        res.json({
          ok: true,
          captcha: cached.captcha,
          sampleId: cached.sampleId,
          latencyMs,
          model: cached.model,
          speedMode,
          source: 'cache',
          cached: true,
        });
        return;
      }
    }

    const ai = getAiClient();
    if (!ai) {
      const latencyMs = Date.now() - start;
      recordLog({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        portal,
        status: 'error',
        codeMasked: '—',
        latencyMs,
        message: 'Thiếu GEMINI_API_KEY trong cấu hình máy chủ',
      });
      res.status(503).json({
        ok: false,
        message: 'Máy chủ chưa được cấu hình GEMINI_API_KEY.',
      });
      return;
    }

    try {
      const [hintsMap, memoryHints, fewShotExamples] = await Promise.all([
        datasetStore.getPortalHints().catch(() => null),
        memoryStore.getAdaptiveHints(portal).catch(() => null),
        memoryStore.getFewShotExamples(portal, { speedMode, bypassCache }).catch(() => []),
      ]);
      const mergedHints =
        memoryHints && memoryHints.usableCount >= (hintsMap?.[portal]?.usableCount || 0)
          ? memoryHints
          : (hintsMap?.[portal] ?? null);
      const adaptivePrompt = buildAdaptivePortalPrompt(portal, mergedHints);
      const enhanced = Boolean(req.body?.enhanced);

      const parts: Array<
        | { inlineData: { mimeType: string; data: string } }
        | { text: string }
      > = [];

      if (fewShotExamples.length > 0) {
        parts.push({
          text: `Reference solved examples from this portal (${portal}) to calibrate tricky characters:`,
        });
        for (const ex of fewShotExamples) {
          parts.push({
            inlineData: {
              mimeType: ex.mimeType,
              data: ex.base64Data,
            },
          });
          parts.push({
            text: `Example answer: ${ex.label}`,
          });
        }
        parts.push({ text: 'Now solve this target CAPTCHA image:' });
      }

      parts.push({
        inlineData: {
          mimeType: parsedImage.mimeType,
          data: parsedImage.data,
        },
      });
      parts.push({ text: adaptivePrompt });

      const response = await ai.models.generateContent({
        model: activeModel,
        contents: { parts },
        config: {
          thinkingConfig: {
            thinkingLevel: speedMode === 'fast' ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW,
          },
        },
      });

      const latencyMs = Date.now() - start;
      const captcha = sanitizeCaptchaText(response.text || '');
      if (!captcha) {
        recordLog({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          portal,
          status: 'error',
          codeMasked: '—',
          latencyMs,
          message: 'Gemini Flash không đọc được ký tự rõ ràng',
        });
        res.status(400).json({
          ok: false,
          message: 'Không đọc được, bấm thử lại',
        });
        return;
      }

      const sampleId = await datasetStore
        .recordSolve({
          portal,
          model: activeModel,
          speedMode,
          latencyMs,
          predicted: captcha,
          mimeType: parsedImage.mimeType,
          base64Data: parsedImage.data,
        })
        .catch(() => '');

      if (solveCache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = solveCache.keys().next().value;
        if (oldestKey) solveCache.delete(oldestKey);
      }
      solveCache.set(cacheKey, {
        captcha,
        model: activeModel,
        sampleId,
        expiresAt: Date.now() + SOLVE_CACHE_TTL_MS,
      });

      const learnedCount = mergedHints?.usableCount || 0;
      const learnedTag = learnedCount > 0 ? ` · Học ${learnedCount} mẫu` : '';
      const enhanceTag = enhanced ? ' · Làm nét' : '';
      const fewShotTag = fewShotExamples.length > 0 ? ` · ${fewShotExamples.length} ảnh mẫu` : '';
      recordLog({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        portal,
        status: 'ok',
        codeMasked: maskCode(captcha),
        latencyMs,
        message: `Đọc thành công (${speedMode === 'fast' ? 'Flash Lite' : 'Flash'}${enhanceTag}${learnedTag}${fewShotTag})`,
      });

      lastGeminiKeyInvalid = false;
      res.json({
        ok: true,
        captcha,
        sampleId,
        latencyMs,
        model: activeModel,
        speedMode,
        source: 'gemini',
        fewShotCount: fewShotExamples.length,
      });
      return;
    } catch (err) {
      const latencyMs = Date.now() - start;
      const rawErr = err instanceof Error ? err.message : String(err || 'Lỗi gọi Gemini Flash');
      const isInvalidKey = /API[_\s]?KEY[_\s]?INVALID|API key not valid|PERMISSION_DENIED|UNAUTHENTICATED|\b401\b|\b403\b/i.test(
        rawErr,
      );
      if (isInvalidKey) lastGeminiKeyInvalid = true;
      const isQuota = /RESOURCE_EXHAUSTED|quota|\b429\b/i.test(rawErr);

      const status = isInvalidKey ? 401 : isQuota ? 429 : 502;
      const cleanMessage = isInvalidKey
        ? 'GEMINI_API_KEY chưa hợp lệ — vui lòng kiểm tra trong Settings > Secrets.'
        : isQuota
          ? 'Hết hạn mức gọi Gemini Flash (429) — thử lại sau hoặc bật Billing.'
          : 'Lỗi kết nối Gemini Flash, vui lòng thử lại.';

      recordLog({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        portal,
        status: 'error',
        codeMasked: '—',
        latencyMs,
        message: cleanMessage,
      });
      res.status(status).json({
        ok: false,
        message: cleanMessage,
      });
    }
  });

  app.post('/api/dataset/record-local', async (req: Request, res: Response) => {
    const requiredToken = normalizeExtensionToken(process.env.EXTENSION_SHARED_TOKEN);
    if (requiredToken && !isSameOriginSandboxRequest(req, process.env.APP_URL)) {
      const provided = normalizeExtensionToken(String(req.headers['x-extension-token'] || ''));
      if (provided !== requiredToken) {
        res.status(401).json({ ok: false, message: 'Mã truy cập Extension không hợp lệ.' });
        return;
      }
    }

    const portalRaw = String(req.body?.portal || '');
    const portal: PortalId = isValidPortal(portalRaw) ? portalRaw : 'hddt';
    const captcha = sanitizeCaptchaText(String(req.body?.captcha || ''));
    const parsedImage = parseCaptchaImageInput(String(req.body?.image || ''));
    if (!captcha || !parsedImage) {
      res.status(400).json({ ok: false, message: 'Dữ liệu mẫu nội bộ không hợp lệ.' });
      return;
    }

    const latencyMs = Math.max(1, Math.min(5000, Number(req.body?.latencyMs) || 2));
    const confidence = Math.max(0, Math.min(100, Math.round(Number(req.body?.confidence) || 100)));
    const sampleId = await datasetStore
      .recordSolve({
        portal,
        model: 'svg-local',
        speedMode: 'fast',
        latencyMs,
        predicted: captcha,
        mimeType: parsedImage.mimeType,
        base64Data: parsedImage.data,
      })
      .catch(() => '');

    recordLog({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      portal,
      status: 'ok',
      codeMasked: maskCode(captcha),
      latencyMs,
      message: `Extension giải SVG nội bộ (${confidence}%)`,
    });

    res.json({ ok: true, sampleId });
  });

  app.post('/api/dataset/feedback', async (req: Request, res: Response) => {
    const requiredToken = normalizeExtensionToken(process.env.EXTENSION_SHARED_TOKEN);
    if (requiredToken && !isSameOriginSandboxRequest(req, process.env.APP_URL)) {
      const provided = normalizeExtensionToken(String(req.headers['x-extension-token'] || ''));
      if (provided !== requiredToken) {
        res.status(401).json({ ok: false, message: 'Mã truy cập Extension không hợp lệ.' });
        return;
      }
    }

    const sampleId = String(req.body?.sampleId || '').trim();
    const rawOutcome = String(req.body?.outcome || '').trim();
    const outcome =
      rawOutcome === 'verified' || rawOutcome === 'corrected' || rawOutcome === 'rejected'
        ? rawOutcome
        : null;
    if (!sampleId || !outcome) {
      res.status(400).json({ ok: false, message: 'Thiếu sampleId hoặc outcome hợp lệ.' });
      return;
    }

    const finalLabel =
      typeof req.body?.finalLabel === 'string' ? req.body.finalLabel : undefined;
    const sample = await datasetStore.recordFeedback({ sampleId, outcome, finalLabel });
    if (!sample) {
      res.status(404).json({ ok: false, message: 'Không tìm thấy mẫu captcha.' });
      return;
    }
    if (outcome === 'corrected') {
      solveCache.clear();
    }
    const autoConsolidated = await memoryStore.notifyFeedbackRecorded().catch(() => false);
    res.json({ ok: true, sample, autoConsolidated });
  });

  app.get('/api/dataset', async (_req: Request, res: Response) => {
    try {
      const snapshot = await datasetStore.getSnapshot(60);
      res.json({ ok: true, ...snapshot });
    } catch {
      res.status(500).json({ ok: false, message: 'Không đọc được kho dữ liệu.' });
    }
  });

  app.get('/api/dataset/image/:filename', async (req: Request, res: Response) => {
    const filename = String(req.params.filename || '');
    const imgPath = await datasetStore.getImagePath(filename);
    if (!imgPath) {
      res.status(404).end();
      return;
    }
    res.sendFile(imgPath);
  });

  app.get('/api/dataset/export', async (_req: Request, res: Response) => {
    try {
      const { zipBuffer } = await datasetStore.exportZipBuffer();
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="taxcap-dataset.zip"');
      res.send(zipBuffer);
    } catch {
      res.status(500).json({ ok: false, message: 'Không xuất được bộ dữ liệu.' });
    }
  });

  app.delete('/api/dataset', async (_req: Request, res: Response) => {
    await datasetStore.clearAll();
    await memoryStore.reset();
    solveCache.clear();
    res.json({ ok: true });
  });

  app.get('/api/memory', async (_req: Request, res: Response) => {
    try {
      const [memory, localModels] = await Promise.all([
        memoryStore.getSummary(),
        localOcr.getStatus(),
      ]);
      res.json({ ok: true, memory, localModels });
    } catch {
      res.status(500).json({ ok: false, message: 'Không đọc được trí nhớ AI.' });
    }
  });

  app.post('/api/memory/consolidate', async (_req: Request, res: Response) => {
    try {
      await memoryStore.consolidate('manual');
      const [memory, localModels] = await Promise.all([
        memoryStore.getSummary(),
        localOcr.getStatus(),
      ]);
      res.json({ ok: true, memory, localModels });
    } catch {
      res.status(500).json({ ok: false, message: 'Không cập nhật được trí nhớ AI.' });
    }
  });

  app.post('/api/memory/config', async (req: Request, res: Response) => {
    const rawMode = String(req.body?.fewShotMode || '');
    const mode: FewShotMode =
      rawMode === 'always' || rawMode === 'off' ? rawMode : 'smart';
    await memoryStore.setFewShotMode(mode);
    const [memory, localModels] = await Promise.all([
      memoryStore.getSummary(),
      localOcr.getStatus(),
    ]);
    res.json({ ok: true, memory, localModels });
  });

  app.get('/api/extension/preview', async (req: Request, res: Response) => {
    try {
      const connectionMode = req.query.connectionMode === 'proxy' ? 'proxy' : 'direct';
      const apiBaseUrl = String(req.query.apiBaseUrl || resolveRequestOrigin(req));
      const accessToken = String(req.query.accessToken || '');
      const licenseApiUrl = String(req.query.licenseApiUrl || '');
      const { files } = await buildExtensionArtifacts({
        connectionMode,
        apiBaseUrl,
        accessToken,
        licenseApiUrl,
      });
      res.json({ ok: true, defaultApiBaseUrl: resolveRequestOrigin(req), files });
    } catch {
      res.status(500).json({ ok: false, message: 'Không đọc được mã nguồn extension.' });
    }
  });

  app.get('/api/extension/bundle', async (req: Request, res: Response) => {
    try {
      const connectionMode = req.query.connectionMode === 'proxy' ? 'proxy' : 'direct';
      const apiBaseUrl = String(req.query.apiBaseUrl || resolveRequestOrigin(req));
      const accessToken = String(req.query.accessToken || '');
      const licenseApiUrl = String(req.query.licenseApiUrl || '');
      const { zipBuffer } = await buildExtensionArtifacts({
        connectionMode,
        apiBaseUrl,
        accessToken,
        licenseApiUrl,
      });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="taxcap-suite-mv3.zip"');
      res.send(zipBuffer);
    } catch {
      res.status(500).json({ ok: false, message: 'Không đóng gói được tệp zip.' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', async (_req, res) => {
      const html = await fs.readFile(path.join(distDir, 'index.html'), 'utf8');
      res.status(200).type('html').send(html);
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TaxCap Proxy & Studio running on http://localhost:${PORT}`);
  });
}

startServer();
