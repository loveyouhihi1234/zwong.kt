import type { IncomingHttpHeaders } from 'node:http';

export interface SandboxRequestLike {
  headers: IncomingHttpHeaders;
  get(name: string): string | string[] | undefined;
}

export function normalizeExtensionToken(rawValue: string | undefined): string {
  const cleaned = (rawValue || '').trim().replace(/^["']+|["']+$/g, '').trim();
  if (!cleaned || cleaned === 'MY_EXTENSION_SHARED_TOKEN') return '';
  return cleaned;
}

export function isSameOriginSandboxRequest(
  req: SandboxRequestLike,
  appUrl?: string,
): boolean {
  if (String(req.headers['x-taxcap-sandbox'] || '') !== '1') return false;

  const originOrReferer =
    (typeof req.headers.origin === 'string' && req.headers.origin) ||
    (typeof req.headers.referer === 'string' && req.headers.referer) ||
    '';
  if (!originOrReferer) return false;

  let callerHost: string;
  try {
    callerHost = new URL(originOrReferer).host.toLowerCase();
  } catch {
    return false;
  }

  const allowedHosts = new Set<string>();
  const directHost = req.get('host');
  if (typeof directHost === 'string' && directHost) {
    allowedHosts.add(directHost.toLowerCase());
  }

  const forwardedHost = req.headers['x-forwarded-host'];
  if (typeof forwardedHost === 'string') {
    for (const part of forwardedHost.split(',')) {
      const h = part.trim().toLowerCase();
      if (h) allowedHosts.add(h);
    }
  }

  if (appUrl && appUrl !== 'MY_APP_URL') {
    try {
      allowedHosts.add(new URL(appUrl).host.toLowerCase());
    } catch {
      // Ignore malformed APP_URL
    }
  }

  return allowedHosts.has(callerHost);
}
