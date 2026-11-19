/* ------------------------------------------------------------------------------------------------
 * Đồng bộ hóa đơn qua IP mạng khách (HV-932), thay plugin invoice-agent.
 *
 * Extension giữ WebSocket tới gateway, nhận gdt.request, gọi thẳng cổng thuế từ trình duyệt của khách rồi trả kết quả
 * thô (giao thức: invoice-agent/PROTOCOL.md). Không hiểu API của cổng thuế, chỉ chạy đúng request gateway mô tả.
 * Trình duyệt đóng thì gateway tự đi proxyd như khách chưa cài gì.
 * ---------------------------------------------------------------------------------------------- */

// Chỉ các cổng gateway thật sự gọi; khớp host_permissions trong manifest.
const RELAY_HOSTS = new Set([
  "hoadondientu.gdt.gov.vn",
  "thuedientu.gdt.gov.vn",
  "dichvucong.gdt.gov.vn",
  "tracuunnt.gdt.gov.vn",
]);
const RELAY_MAX_INFLIGHT = 4;
const RELAY_DEFAULT_TIMEOUT_MS = 15_000;
// Service worker chỉ được sống tiếp khi có message WebSocket trong vòng 30 giây.
const RELAY_PING_MS = 20_000;
const RELAY_PONG_TIMEOUT_MS = 60_000;
const RELAY_RECONNECT_MAX_MS = 60_000;
const RELAY_ALARM = "relay-ket-noi";
const RELAY_ALARM_PHIEN = "relay-kiem-phien";
const RELAY_TOKEN_KEY = "relayToken";
const RELAY_DEVICE_KEY = "relayDeviceId";
// fetch không cho đặt các header này: đặt qua rule declarativeNetRequest gắn với tham số đánh dấu trên URL của đúng
// request đó. Một khách nhiều MST chạy song song nhiều phiên tới cùng một host, nên mỗi request phải có rule riêng.
const DNR_HEADERS = ["cookie", "origin", "referer", "user-agent"];
const RELAY_MARKER = "_hv";
const RESPONSE_HEADERS = ["content-type", "retry-after", "x-ratelimit-remaining"];

let relayWs = null;
let relayConnecting = false;
let relayRetryMs = 1000;
let relayRetryTimer = null;
let relayPingTimer = null;
let relayLastPong = 0;
let relayRuleSeq = 0;
const relayInflight = new Map();

// Rule của lượt chạy trước (service worker bị tắt giữa chừng) còn nằm trong phiên trình duyệt.
const relayRulesReady = chrome.declarativeNetRequest
  .getSessionRules()
  .then((rules) =>
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id) }),
  )
  .catch(() => {});

async function relayDeviceId() {
  const { [RELAY_DEVICE_KEY]: id } = await chrome.storage.local.get(RELAY_DEVICE_KEY);
  if (id) return id;
  const moi = `ext-${crypto.randomUUID()}`;
  await chrome.storage.local.set({ [RELAY_DEVICE_KEY]: moi });
  return moi;
}

/** id_token đang có trong phiên, không tự mở luồng đăng nhập ngầm: khách chưa đăng nhập thì relay chỉ nằm chờ. */
async function relayIdTokenDangCo() {
  const { [ID_TOKEN_KEY]: entry } = await chrome.storage.session.get(ID_TOKEN_KEY);
  return entry?.token && entry.exp - ID_TOKEN_MARGIN_MS > Date.now() ? entry.token : null;
}

async function relayLayToken() {
  const { [RELAY_TOKEN_KEY]: saved } = await chrome.storage.local.get(RELAY_TOKEN_KEY);
  if (saved?.token) return saved.token;

  const idToken = await relayIdTokenDangCo();
  if (!idToken) return null;
  const res = await fetch(`${API_BASE}/api/extension/agent-token`, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json", "X-Huvisoft-Id-Token": idToken },
    body: JSON.stringify({ deviceId: await relayDeviceId() }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const { agentToken } = await res.json().catch(() => ({}));
  if (!agentToken) return null;
  await chrome.storage.local.set({
    [RELAY_TOKEN_KEY]: { token: agentToken, sub: decodeJwtPayload(idToken)?.sub },
  });
  return agentToken;
}

/** Vừa có id_token mới (background.js gọi). Đổi tài khoản thì bỏ token relay cũ để không đồng bộ hộ tài khoản trước. */
async function relayCoIdToken(sub) {
  const { [RELAY_TOKEN_KEY]: saved } = await chrome.storage.local.get(RELAY_TOKEN_KEY);
  if (saved?.sub && saved.sub !== sub) {
    await chrome.storage.local.remove(RELAY_TOKEN_KEY);
    // Đang nối thì onclose tự nối lại bằng token mới.
    if (relayWs) return relayWs.close();
  }
  relayKetNoi();
}

/** Không còn phiên Huvisoft ID (đã đăng xuất): thôi đồng bộ hộ tài khoản đó, đăng nhập lại thì xin token mới. */
async function relayKhongCoPhien() {
  // Xoá cả id_token cũ: còn hạn thì relayLayToken sẽ dùng nó xin lại token cho tài khoản vừa đăng xuất.
  await chrome.storage.local.remove(RELAY_TOKEN_KEY);
  await chrome.storage.session.remove(ID_TOKEN_KEY);
  relayWs?.close();
}

function relayGui(msg) {
  if (relayWs?.readyState === WebSocket.OPEN) relayWs.send(JSON.stringify(msg));
}

function relayHenKetNoiLai() {
  clearTimeout(relayRetryTimer);
  relayRetryTimer = setTimeout(relayKetNoi, relayRetryMs);
  relayRetryMs = Math.min(relayRetryMs * 2, RELAY_RECONNECT_MAX_MS);
}

async function relayKetNoi() {
  if (relayWs || relayConnecting) return;
  relayConnecting = true;
  try {
    await sanSang;
    const token = await relayLayToken();
    if (!token) return;
    const ws = new WebSocket(GATEWAY_WS_URL, ["huvi-agent", token]);
    relayWs = ws;
    ws.onopen = async () => {
      relayLastPong = Date.now();
      relayGui({
        type: "hello",
        hello: {
          version: chrome.runtime.getManifest().version,
          os: "extension",
          deviceId: await relayDeviceId(),
          capabilities: { maxInflight: RELAY_MAX_INFLIGHT, cancelAck: true },
        },
      });
      relayPingTimer = setInterval(() => {
        if (Date.now() - relayLastPong > RELAY_PONG_TIMEOUT_MS) ws.close();
        else relayGui({ type: "ping" });
      }, RELAY_PING_MS);
    };
    ws.onmessage = (e) => {
      let env;
      try {
        env = JSON.parse(e.data);
      } catch {
        return;
      }
      relayNhan(env);
    };
    ws.onclose = async (e) => {
      clearInterval(relayPingTimer);
      for (const ctl of relayInflight.values()) ctl.abort("cancel");
      if (relayWs === ws) relayWs = null;
      // 4001: token không còn hợp lệ (gateway đổi khoá ký). Xin token mới ở lần nối lại.
      if (e.code === 4001) await chrome.storage.local.remove(RELAY_TOKEN_KEY);
      relayHenKetNoiLai();
    };
  } finally {
    relayConnecting = false;
  }
}

function relayNhan(env) {
  switch (env.type) {
    case "welcome":
      relayRetryMs = 1000;
      return;
    case "pong":
      relayLastPong = Date.now();
      return;
    case "gdt.cancel":
      relayInflight.get(env.corrId)?.abort("cancel");
      return;
    case "gdt.request":
      if (!env.corrId || !env.req) return;
      if (relayInflight.size >= RELAY_MAX_INFLIGHT) {
        relayGui({ type: "gdt.error", corrId: env.corrId, err: { kind: "busy", message: "extension đang bận" } });
        return;
      }
      relayChay(env.corrId, env.req);
  }
}

function relayDungUrl(req) {
  if (!req.baseURL) throw new Error("thiếu baseURL");
  let full = req.baseURL.replace(/\/+$/, "");
  if (req.path) full += req.path.startsWith("/") ? req.path : `/${req.path}`;
  const params = new URLSearchParams(req.params || {}).toString();
  if (params) full += (full.includes("?") ? "&" : "?") + params;
  const u = new URL(full);
  if (u.protocol !== "https:" || u.port || !RELAY_HOSTS.has(u.hostname)) {
    throw new Error(`host ngoài whitelist: ${u.host}`);
  }
  return full;
}

function relayBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

async function relayChay(corrId, req) {
  const ctl = new AbortController();
  relayInflight.set(corrId, ctl);
  const timeoutMs = req.timeoutMs > 0 ? req.timeoutMs : RELAY_DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => ctl.abort("timeout"), timeoutMs);
  let ruleId = null;
  try {
    let url;
    try {
      url = relayDungUrl(req);
    } catch (e) {
      relayGui({ type: "gdt.error", corrId, err: { kind: "rejected", message: e.message } });
      return;
    }

    const fetchHeaders = {};
    const dnrHeaders = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (DNR_HEADERS.includes(k.toLowerCase())) dnrHeaders[k.toLowerCase()] = String(v);
      else fetchHeaders[k] = String(v);
    }
    // Gateway không đặt Origin thì cũng không để lộ chrome-extension://... cho cổng thuế.
    const requestHeaders = DNR_HEADERS.flatMap((h) =>
      dnrHeaders[h] !== undefined
        ? [{ header: h, operation: "set", value: dnrHeaders[h] }]
        : h === "origin"
          ? [{ header: h, operation: "remove" }]
          : [],
    );
    const marker = `${RELAY_MARKER}=${crypto.randomUUID().replace(/-/g, "")}`;
    url += (url.includes("?") ? "&" : "?") + marker;
    await relayRulesReady;
    ruleId = ++relayRuleSeq;
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [
        {
          id: ruleId,
          priority: 1,
          action: { type: "modifyHeaders", requestHeaders },
          condition: { urlFilter: marker, tabIds: [chrome.tabs.TAB_ID_NONE] },
        },
      ],
    });

    const method = (req.method || "GET").toUpperCase();
    let body;
    if (method !== "GET" && method !== "HEAD" && req.body !== undefined && req.body !== null) {
      body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    }

    const res = await fetch(url, {
      method,
      headers: fetchHeaders,
      body,
      credentials: "omit",
      redirect: "manual",
      cache: "no-store",
      signal: ctl.signal,
    });

    // Như plugin: không theo redirect (có thể lách whitelist). fetch không cho đọc Location, gateway coi là non-2xx.
    if (res.type === "opaqueredirect") {
      relayGui({ type: "gdt.response", corrId, res: { status: 302, data: null, headers: {} } });
      return;
    }
    const headers = {};
    for (const h of RESPONSE_HEADERS) {
      const v = res.headers.get(h);
      if (v) headers[h] = v;
    }
    if (req.respType === "b64") {
      const dataB64 = relayBase64(await res.arrayBuffer());
      relayGui({ type: "gdt.response", corrId, res: { status: res.status, data: null, dataB64, headers } });
      return;
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    relayGui({ type: "gdt.response", corrId, res: { status: res.status, data, headers } });
  } catch (e) {
    const reason = ctl.signal.reason;
    const kind = reason === "timeout" ? "timeout" : reason === "cancel" ? "cancelled" : "network";
    relayGui({ type: "gdt.error", corrId, err: { kind, message: String(e?.message || e) } });
  } finally {
    clearTimeout(timer);
    relayInflight.delete(corrId);
    if (ruleId !== null) {
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
    }
  }
}

// Chrome tắt service worker khi rảnh; báo thức mỗi phút đánh thức lại để nối lại kết nối đã rớt.
// Chỉ tạo khi chưa có (HV-973): create lại mỗi lần service worker khởi động là đặt lại đồng hồ. Mất kết nối thì báo thức 1 phút
// khởi động worker mỗi phút, báo thức 15 phút bị đặt lại liên tục và không bao giờ tới.
function taoAlarmNeuChuaCo(ten, phut) {
  chrome.alarms.get(ten).then((a) => {
    if (!a) chrome.alarms.create(ten, { periodInMinutes: phut });
  });
}
taoAlarmNeuChuaCo(RELAY_ALARM, 1);
// Phiên id chỉ được kiểm khi mở popup / giải captcha; khách đăng xuất rồi để trình duyệt mở thì kiểm định kỳ ở đây.
taoAlarmNeuChuaCo(RELAY_ALARM_PHIEN, 15);
// Bản dev đổi local / dev: token relay ký cho gateway của môi trường cũ, bỏ đi rồi nối lại khi có id_token mới.
chrome.storage.onChanged.addListener(async (thayDoi, vung) => {
  if (!LA_BAN_DEV || vung !== "local" || !thayDoi.moiTruongDev) return;
  await chrome.storage.local.remove(RELAY_TOKEN_KEY);
  relayWs?.close();
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === RELAY_ALARM) relayKetNoi();
  if (a.name === RELAY_ALARM_PHIEN) {
    const { [RELAY_TOKEN_KEY]: saved } = await chrome.storage.local.get(RELAY_TOKEN_KEY);
    if (saved?.token) getIdToken().catch(() => {});
  }
});
relayKetNoi();
