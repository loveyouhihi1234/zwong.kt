importScripts("config.js", "cai-dat.js");
// Bản phát hành (Web Store, zip) có config.js ghi "prod" do release.yml sinh. Bản nạp từ repo là "dev": popup chọn gọi invoice-app
// chạy trên máy (local) hay app-dev.huvisoft.com (dev), để đổi API không ảnh hưởng khách đang dùng.
const LA_BAN_DEV = self.HV_BAN !== "prod";
const MOI_TRUONG = {
  prod: { api: "https://app.huvisoft.com", id: "https://id.huvisoft.com/oidc", gateway: "wss://api.huvisoft.com/agent/ws" },
  dev: {
    api: "https://app-dev.huvisoft.com",
    id: "https://id-dev.huvisoft.com/oidc",
    gateway: "wss://api-dev.huvisoft.com/agent/ws",
  },
  // invoice-app chạy trên máy (cổng PORT trong .env.worktree của worktree), đăng nhập qua id-dev. Gateway trên máy không có dịch vụ
  // giải captcha nên những việc cần giải captcha của trang thuế (tự giải captcha, tra MST ở tracuunnt) vẫn đi qua app-dev.
  local: {
    api: "http://localhost:3400",
    id: "https://id-dev.huvisoft.com/oidc",
    gateway: "ws://localhost:3001/agent/ws",
    giaiCaptcha: "https://app-dev.huvisoft.com",
    ruiRo: "https://app-dev.huvisoft.com",
  },
};
let TEN_MOI_TRUONG;
let API_BASE;
let API_GIAI_CAPTCHA;
let API_RUI_RO;
// Issuer OIDC của Huvisoft ID (oidc-provider gắn ở /oidc).
let ID_ISSUER;
// WebSocket tới gateway cho relay đồng bộ qua mạng khách (relay.js).
let GATEWAY_WS_URL;
let PACKAGE_URL;

function apDungMoiTruong(chon) {
  TEN_MOI_TRUONG = LA_BAN_DEV ? (chon === "local" ? "local" : "dev") : "prod";
  const mt = MOI_TRUONG[TEN_MOI_TRUONG];
  API_BASE = mt.api;
  API_GIAI_CAPTCHA = mt.giaiCaptcha ?? mt.api;
  API_RUI_RO = mt.ruiRo ?? mt.api;
  ID_ISSUER = mt.id;
  GATEWAY_WS_URL = mt.gateway;
  PACKAGE_URL = `${API_BASE}/cong-cu-ke-toan?mode=extension`;
}
apDungMoiTruong();
// Mọi lệnh gọi máy chủ chờ đọc xong lựa chọn local/dev, không thì lượt đầu sau khi service worker thức dậy gọi nhầm môi trường.
const sanSang = LA_BAN_DEV
  ? chrome.storage.local
      .get("moiTruongDev")
      .then(({ moiTruongDev }) => apDungMoiTruong(moiTruongDev))
      .catch(() => {})
  : Promise.resolve();

// App công khai của extension trên Huvisoft ID; địa chỉ quay về là chrome.identity.getRedirectURL()
// (https://<mã extension>.chromiumapp.org/). Bản Chrome Web Store có mã cố định hahpdlpcejdmjpojknkmdmjhenldooif; bản zip
// cũ mỗi máy một mã, id nhận mọi mã đúng dạng. "key" trong manifest là khóa riêng của bản nạp từ repo (mã
// nkcdejnedgldlgdfgihpljkifppnjdlp, khai trên id-dev, HV-960) nên cài được cạnh bản Web Store; release.yml bỏ key khỏi gói phát
// hành, vì đổi mã làm Chrome gỡ mất bản zip đang cài.
const ID_CLIENT_ID = "invoice-extension";
// Chưa có phiên Huvisoft ID trên trình duyệt: extension chỉ đăng nhập bằng Huvisoft ID (HV-921).
const NEED_LOGIN = {
  ok: false,
  needLogin: true,
  message: "Đăng nhập Huvisoft để tự giải captcha",
};
/* ------------------------------------------------------------------------------------------------
 * Đăng nhập bằng Huvisoft ID (HV-855, từ 0.4.0)
 *
 * Extension là một app riêng trên id: lấy id_token bằng Authorization Code + PKCE qua
 * chrome.identity.launchWebAuthFlow. Lấy NGẦM (prompt=none) bằng phiên id sẵn có của trình duyệt, nên còn đăng nhập
 * id là extension còn chạy: không phụ thuộc phiên của app (1 giờ / 7 ngày, bị đá khi đăng nhập nơi khác) nữa.
 * id_token chỉ giữ trong bộ nhớ phiên của trình duyệt (chrome.storage.session), hết hạn thì xin lại ngầm.
 * ---------------------------------------------------------------------------------------------- */

const ID_TOKEN_KEY = "idToken";
// id_token sống 1 giờ nhưng chỉ dùng lại tối đa 5 phút rồi xin lại ngầm: đổi tài khoản / đăng xuất trên id thì
// extension theo kịp trong vài phút, không giải tiếp bằng tài khoản cũ suốt một giờ.
const ID_TOKEN_REUSE_MS = 5 * 60 * 1000;
const ID_TOKEN_MARGIN_MS = 2 * 60 * 1000;
// Không có phiên id thì đừng mỗi captcha lại mở một luồng ngầm: nghỉ một lúc rồi mới thử lại.
const ID_RETRY_AFTER_MS = 60 * 1000;

// Mất mạng / không tới được Huvisoft ID: khác "chưa đăng nhập", không được bảo khách đăng nhập lại (HV-927).
class LoiMang extends Error {}
// Khách chủ động bấm đăng nhập mà hỏng: message là câu hiện cho khách (HV-956). Không có lớp này thì nút bấm như không có gì xảy ra.
class LoiDangNhap extends Error {}

const LY_DO_TU_ID = (moTa) =>
  /not allowed for client/i.test(moTa)
    ? "Bản extension này chưa được phép đăng nhập. Bạn cài bản từ Chrome Web Store hoặc Microsoft Edge Add-ons giúp."
    : `Huvisoft ID từ chối đăng nhập${moTa ? `: ${moTa}` : "."}`;

let idDiscovery = null;
let idTokenPromise = null;
let idUnavailableUntil = 0;

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function randomString() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function pkceChallenge(verifier) {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

function decodeJwtPayload(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(part)
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(""),
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function getDiscovery() {
  await sanSang;
  if (!idDiscovery) {
    idDiscovery = fetch(`${ID_ISSUER}/.well-known/openid-configuration`, { credentials: "omit" })
      .catch(() => {
        throw new LoiMang("discovery");
      })
      .then((res) => {
        if (!res.ok) throw new Error(`discovery ${res.status}`);
        return res.json();
      })
      .catch((e) => {
        idDiscovery = null;
        throw e;
      });
  }
  return idDiscovery;
}

/**
 * Chạy một vòng đăng nhập id. interactive=false: ngầm (prompt=none), không hiện gì; trả null nếu id cần người dùng
 * đăng nhập. interactive=true: mở cửa sổ đăng nhập id (khi user bấm "Đăng nhập Huvisoft").
 */
async function runIdFlow(interactive, { doiTaiKhoan = false } = {}) {
  if (!navigator.onLine) throw new LoiMang("offline");
  const cfg = await getDiscovery();
  const verifier = randomString();
  const state = randomString();
  const nonce = randomString();
  const redirectUri = chrome.identity.getRedirectURL();
  const url = new URL(cfg.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: ID_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    // email + profile (HV-920): id_token mang email, họ tên để app tạo tài khoản cho khách cài extension trước, tạo
    // Huvisoft ID ngay trong cửa sổ đăng nhập của extension, chưa từng vào app.
    scope: "openid email profile",
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
    // Không dùng prompt=none: id chỉ nhận phiên SSO của oidc-provider, không nhận cookie id_phien của người đăng nhập
    // ở trang id, nên trả login_required dù đang có phiên. Bỏ prompt thì id tự nhận phiên hiện tại.
    ...(interactive && doiTaiKhoan ? { prompt: "login" } : {}),
  }).toString();

  // Luồng ngầm hỏng chỉ có nghĩa "chưa có phiên id"; luồng khách bấm thì phải nói lý do.
  const hong = (lyDo) => {
    if (interactive) throw new LoiDangNhap(lyDo);
    return null;
  };

  let result;
  try {
    result = await chrome.identity.launchWebAuthFlow({
      url: url.toString(),
      interactive,
      // Ngầm: có phiên thì id chuyển hướng thẳng về extension; cần nhập gì thì trang vừa tải là dừng, không hiện cửa sổ.
    });
  } catch (e) {
    // Khách tự đóng cửa sổ thì không phải lỗi, khỏi báo.
    if (/did not approve/i.test(e?.message ?? "")) return null;
    return hong("Không mở được cửa sổ đăng nhập Huvisoft. Bạn thử lại sau.");
  }
  if (!result) return null;

  const back = new URL(result);
  const params = back.searchParams;
  if (params.get("error")) return hong(LY_DO_TU_ID(params.get("error_description") ?? ""));
  if (params.get("state") !== state || !params.get("code")) return hong("Đăng nhập không hoàn tất. Bạn thử lại giúp.");

  const res = await fetch(cfg.token_endpoint, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.get("code"),
      redirect_uri: redirectUri,
      client_id: ID_CLIENT_ID,
      code_verifier: verifier,
    }),
  }).catch(() => {
    throw new LoiMang("token");
  });
  if (!res.ok) {
    const { error_description: moTa } = await res.json().catch(() => ({}));
    return hong(LY_DO_TU_ID(moTa ?? ""));
  }
  const { id_token: idToken } = await res.json().catch(() => ({}));
  const payload = idToken && decodeJwtPayload(idToken);
  // Chữ ký do máy chủ app kiểm; ở đây chỉ chống lẫn phản hồi của vòng khác.
  if (!payload || payload.nonce !== nonce || typeof payload.exp !== "number") return null;

  const entry = { token: idToken, exp: payload.exp * 1000, at: Date.now() };
  await chrome.storage.session.set({ [ID_TOKEN_KEY]: entry });
  idUnavailableUntil = 0;
  relayCoIdToken(payload.sub);
  return entry.token;
}

/** id_token còn hạn, hoặc xin mới ngầm. null = không có phiên id. Ném LoiMang khi không tới được id. */
async function getIdToken({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const { [ID_TOKEN_KEY]: entry } = await chrome.storage.session.get(ID_TOKEN_KEY);
    const now = Date.now();
    if (entry?.token && entry.exp - ID_TOKEN_MARGIN_MS > now && now - entry.at < ID_TOKEN_REUSE_MS) {
      return entry.token;
    }
  }
  if (Date.now() < idUnavailableUntil) return null;
  idTokenPromise ??= runIdFlow(false)
    .catch((e) => {
      if (e instanceof LoiMang) throw e;
      return null;
    })
    .then((token) => {
      if (!token) {
        idUnavailableUntil = Date.now() + ID_RETRY_AFTER_MS;
        relayKhongCoPhien();
      }
      return token;
    })
    .finally(() => {
      idTokenPromise = null;
    });
  return idTokenPromise;
}

async function clearIdToken() {
  await chrome.storage.session.remove(ID_TOKEN_KEY);
}

async function callSolveWithIdToken(idToken, portal, image) {
  await sanSang;
  return fetch(`${API_GIAI_CAPTCHA}/api/extension/captcha-solve`, {
    method: "POST",
    credentials: "omit",
    // Máy chủ ghi phiên bản để biết khách nào còn ở bản cũ (HV-935).
    headers: {
      "Content-Type": "application/json",
      "X-Huvisoft-Id-Token": idToken,
      "X-Huvisoft-Extension-Version": chrome.runtime.getManifest().version,
      ...(await headerMaCai()),
    },
    body: JSON.stringify({ portal, image }),
  }).then(daNoiMaCaiNeuXong);
}

/** Giải bằng phiên id. null = chưa có phiên id, cần đăng nhập. */
async function solveViaId(portal, image) {
  let token = await getIdToken();
  if (!token) return null;
  let res = await callSolveWithIdToken(token, portal, image);
  if (res.status === 401) {
    await clearIdToken();
    token = await getIdToken({ forceRefresh: true });
    if (!token) return null;
    res = await callSolveWithIdToken(token, portal, image);
  }
  return res.status === 401 ? null : res;
}

const KHONG_KET_NOI = {
  ok: false,
  network: true,
  thuLai: true,
  message: "Không kết nối được Huvisoft",
};

async function solveMotLan(portal, image) {
  let res;
  try {
    res = await solveViaId(portal, image);
  } catch {
    return KHONG_KET_NOI;
  }
  if (!res) return NEED_LOGIN;

  const data = await res.json().catch(() => ({}));
  // sapHetLuot (HV-1030): app mới báo đã giải gần hết lượt hôm nay, kèm lời mời gói; app cũ không có thì thôi.
  if (res.ok && data.captcha) return { ok: true, captcha: data.captcha, ...sapHetLuotTu(data) };
  // 200 mà rỗng: model không đọc được ảnh, như 400 (trước đây rơi xuống "Máy chủ Huvisoft đang bận").
  if (res.ok) return { ok: false, unsolved: true, message: "Chưa giải được ảnh này" };
  if (res.status === 401) return NEED_LOGIN;
  if (res.status === 403) {
    if (data.code !== "FEATURE_ACCESS_DENIED") {
      // Bị từ chối có lý do (vd phiên đăng nhập hộ không được dùng extension): hiện đúng câu máy chủ trả, không giải lại.
      return { ok: false, tuChoi: true, message: data.message || "Không dùng được extension với tài khoản này" };
    }
    return {
      ok: false,
      needPackage: true,
      packageUrl: PACKAGE_URL,
      message: data.message || "Tài khoản này chưa dùng được tự giải captcha",
    };
  }
  if (res.status === 429) {
    return {
      ok: false,
      rateLimited: true,
      reason: data.reason,
      message: data.message || "Quá nhiều yêu cầu. Vui lòng thử lại sau 30 phút.",
    };
  }
  // 400: ảnh không giải được (model trả rỗng, ảnh hỏng). 5xx: máy chủ / gateway lỗi, thường qua đi sau vài giây.
  if (res.status === 400) return { ok: false, unsolved: true, message: data.message || "Chưa giải được ảnh này" };
  // Lỗi máy chủ khi giải captcha: gửi về để lần ra (trước đây khách chỉ thấy "Máy chủ Huvisoft đang bận").
  baoLoi({ noi: portal, thongDiep: `captcha-solve ${res.status}: ${data.message ?? ""}`.trim() });
  return {
    ok: false,
    serverError: true,
    status: res.status,
    thuLai: res.status >= 500,
    message: data.message || `Lỗi ${res.status}`,
  };
}

// Lỗi mạng / 5xx thường chỉ thoáng qua: tự thử lại 2 lần (sau 0,7 giây rồi 1,5 giây) rồi mới báo khách (HV-927).
const CHO_THU_LAI_MS = [700, 1500];

async function solve(portal, image) {
  for (let lan = 0; ; lan++) {
    const { thuLai, ...ketQua } = await solveMotLan(portal, image);
    if (!thuLai || lan >= CHO_THU_LAI_MS.length) return ketQua;
    await new Promise((r) => setTimeout(r, CHO_THU_LAI_MS[lan]));
  }
}

/**
 * Dấu "!" đỏ trên biểu tượng extension khi chưa đăng nhập Huvisoft (HV-927): khách đóng cửa sổ / tab đăng nhập rồi vẫn
 * thấy còn việc phải làm. Lỗi mạng thì không đổi: không biết khách đã đăng nhập hay chưa.
 */
function capNhatBadge(daDangNhap) {
  self.daDangNhapCuoi = daDangNhap;
  // Bản dev luôn mang nhãn môi trường (DEV / LOC) để khỏi nhầm với bản khách đang dùng; chưa đăng nhập thì "!" như bản thật.
  // Đã tải bản mới mà chưa áp dụng (HV-973, cap-nhat.js): "↑" xanh, xếp sau "!" vì chưa đăng nhập thì extension không chạy.
  const nhanMoiTruong = LA_BAN_DEV ? (TEN_MOI_TRUONG === "local" ? "LOC" : "DEV") : "";
  const banMoi = daDangNhap && self.banMoiDangCho;
  // Thứ tự: "!" chưa đăng nhập > "↑" có bản chờ > "MỚI" chưa xem Có gì mới (HV-975) > "||" đang tắt / tạm dừng > nhãn môi trường.
  const coGiMoi = daDangNhap && !banMoi && self.coGiMoiChuaXem;
  const dangTat = daDangNhap && !banMoi && !coGiMoi && !hvDuocTuGiaiChung();
  chrome.action
    .setBadgeText({ text: !daDangNhap ? "!" : banMoi ? "↑" : coGiMoi ? "MỚI" : dangTat ? "||" : nhanMoiTruong })
    .catch(() => {});
  chrome.action
    .setBadgeBackgroundColor({
      color: !daDangNhap ? "#dc2626" : banMoi || coGiMoi ? "#16a34a" : dangTat ? "#6b7280" : "#ea580c",
    })
    .catch(() => {});
  chrome.action
    .setTitle({
      title: !daDangNhap
        ? "Huvisoft - Tự giải captcha: đăng nhập để bắt đầu"
        : banMoi
          ? `Huvisoft - Tự giải captcha: có bản mới ${self.banMoiDangCho}, bấm để cập nhật`
          : "Huvisoft - Tự giải captcha",
    })
    .catch(() => {});
}

function capNhatBadgeTheoKetQua(ketQua) {
  if (ketQua.needLogin) capNhatBadge(false);
  else if (!ketQua.network) capNhatBadge(true);
}

/** Kiểm tra ngầm lúc cài / mở trình duyệt, chỉ để đặt badge. */
async function kiemTraDangNhapNgam() {
  try {
    capNhatBadge(Boolean(await getIdToken()));
  } catch {
    // Mất mạng: để nguyên badge.
  }
}

/**
 * User bấm "Đăng nhập Huvisoft": mở cửa sổ đăng nhập Huvisoft ID ngay trong extension. Đăng nhập xong extension có
 * phiên id riêng, không cần mở app. id chưa sẵn sàng / user đóng cửa sổ: mở trang đăng nhập app như trước.
 */
async function login(doiTaiKhoan = false) {
  idUnavailableUntil = 0;
  try {
    const token = await runIdFlow(true, { doiTaiKhoan });
    if (!token) return { ok: false };
    await chrome.storage.local.remove("lastResult");
    capNhatBadge(true);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message:
        e instanceof LoiDangNhap
          ? e.message
          : e instanceof LoiMang
            ? "Không kết nối được Huvisoft. Bạn kiểm tra mạng rồi thử lại."
            : "Không đăng nhập được. Bạn thử lại sau.",
    };
  }
}

/** Tài khoản Huvisoft đang đăng nhập, hiện ở popup: tên đăng nhập (không có thì họ tên) và email. */
async function getAccount() {
  await sanSang;
  // Link "Mở Huvisoft" trong popup: đúng app của môi trường đang gọi (prod / dev / local).
  const appUrl = `${API_BASE}/?utm_source=extension&utm_medium=popup`;
  idUnavailableUntil = 0; // user vừa mở popup: kiểm tra thật, không dùng kết quả "chưa có phiên" cũ
  let token;
  try {
    token = await getIdToken();
  } catch {
    return { loggedIn: false, offline: true, appUrl };
  }
  const payload = token && decodeJwtPayload(token);
  capNhatBadge(Boolean(payload));
  if (!payload) return { loggedIn: false, appUrl };
  // Tên đăng nhập (preferred_username) chỉ tài khoản nhân viên / chuyển từ app cũ có; không có thì hiện họ tên.
  const ten = payload.preferred_username || payload.name || null;
  return { loggedIn: true, ten, email: payload.email || null, appUrl };
}

/**
 * Lời mời mua gói khi đã dùng gần hết lượt miễn phí hôm nay (HV-1030): app trả `sapHetLuot` cạnh `conLai`, mỗi tài khoản tối
 * đa một lần mỗi ngày. Chỉ nhận link tới huvisoft.com; app cũ không có trường này thì trả `{}`.
 */
function sapHetLuotTu(data) {
  const s = data?.sapHetLuot;
  if (!s || typeof s.link !== "string" || !/^https:\/\/(app\.)?huvisoft\.com\//.test(s.link)) return {};
  const chu = (v) => (typeof v === "string" ? v.slice(0, 200) : null);
  return { sapHetLuot: { link: s.link, tieuDe: chu(s.tieuDe), moTa: chu(s.moTa), loai: chu(s.loai) } };
}

/** Gọi API extension có hạn mức. Trả `{ data }` khi có phản hồi dùng được, không thì `{ loi }` là kết quả để báo khách. */
async function goiApiCoHanMuc(duongDan, body, viec, goc) {
  await sanSang;
  const khongKetNoi = { ok: false, message: "Không kết nối được Huvisoft. Bạn kiểm tra mạng rồi thử lại." };
  const canDangNhap = { ok: false, needLogin: true, message: `Đăng nhập Huvisoft (miễn phí) để ${viec}.` };
  let token;
  try {
    token = await getIdToken();
  } catch {
    return { loi: khongKetNoi };
  }
  if (!token) return { loi: canDangNhap };

  let res;
  try {
    res = await fetch(`${goc ?? API_BASE}${duongDan}`, {
      method: "POST",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        "X-Huvisoft-Id-Token": token,
        "X-Huvisoft-Extension-Version": chrome.runtime.getManifest().version,
        ...(await headerMaCai()),
      },
      body: JSON.stringify(body),
    }).then(daNoiMaCaiNeuXong);
  } catch {
    return { loi: khongKetNoi };
  }
  if (res.status === 401) return { loi: canDangNhap };
  const data = await res.json().catch(() => ({}));
  if (data.code === "HET_LUOT_NGAY") return { loi: { ok: false, hetLuot: true, message: data.message, muaUrl: data.muaUrl } };
  if (!res.ok) return { loi: { ok: false, status: res.status, message: data.message } };
  return { data };
}

// mstCongTy: MST công ty đang làm (người mua ở tab mua vào, người bán ở tab bán ra), máy chủ đếm lượt miễn phí theo cả công ty.
async function traCuuHoaDon(xml, mstCongTy) {
  const { data, loi } = await goiApiCoHanMuc(
    "/api/extension/tra-cuu-hoa-don",
    { xml, mstCongTy },
    "tra cứu link và mã",
  );
  if (loi) return loi;
  // taiDuocPdf: gateway xác nhận tải được PDF gốc hóa đơn này (như app chỉ hiện nút khi tải được); thiếu trường thì coi là không.
  return {
    ok: true,
    linkTraCuu: data.linkTraCuu,
    maTraCuu: data.maTraCuu,
    taiDuocPdf: data.taiDuocPdf === true,
    conLai: data.conLai,
    ...sapHetLuotTu(data),
  };
}

/** Để PDF cho khung xem (xem-pdf.html trong drawer trên trang thuế) đọc; khung đọc xong là xoá. */
async function luuPdfChoKhungXem(pdfBase64) {
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [`xemPdf:${id}`]: pdfBase64 });
  return id;
}

/** Dựng bản Trống Đồng; trang thuế mở drawer xem trước như app. */
async function xemTrongDong(hoaDon, mstCongTy) {
  const { data, loi } = await goiApiCoHanMuc(
    "/api/extension/ban-trong-dong",
    { ...hoaDon, mstCongTy },
    "xem bản Trống Đồng",
  );
  if (loi) return loi;
  if (!data.pdfBase64) {
    return { ok: false, message: data.message || "Chưa tạo được bản Trống Đồng. Bạn thử lại sau." };
  }

  return {
    ok: true,
    xemPdf: await luuPdfChoKhungXem(data.pdfBase64),
    pdfBase64: data.pdfBase64,
    conLai: data.conLai,
    ...sapHetLuotTu(data),
  };
}

async function taiPdfGoc(xml, mstCongTy) {
  const { data, loi } = await goiApiCoHanMuc("/api/extension/tai-pdf-goc", { xml, mstCongTy }, "tải PDF gốc");
  // 422: nhà cung cấp chưa tự tải được qua extension, phần mềm Huvisoft tải được.
  if (loi?.status === 422) return { ok: false, sangHuvisoft: true };
  if (loi) return loi;
  if (!data.pdfBase64) return { ok: false, message: "Chưa tải được PDF gốc. Bạn thử lại sau." };
  return {
    ok: true,
    xemPdf: await luuPdfChoKhungXem(data.pdfBase64),
    pdfBase64: data.pdfBase64,
    filename: data.filename,
    conLai: data.conLai,
    ...sapHetLuotTu(data),
  };
}

async function traRuiRoNcc(mstList, mstCongTy) {
  const { data, loi } = await goiApiCoHanMuc(
    "/api/extension/rui-ro-mst",
    { mstList, mstCongTy },
    "tra rủi ro NCC",
    API_RUI_RO,
  );
  if (loi) return loi;
  return {
    ok: true,
    ketQua: Object.fromEntries((data.ketQua ?? []).map((k) => [k.mst, k])),
    conLai: data.conLai,
    ...sapHetLuotTu(data),
  };
}

/**
 * HV-979: giữ 1 lượt trước khi mở drawer xem nhanh hồ sơ trên dichvucong (miễn phí 5 lần/ngày, có gói Tải tờ khai Thuế và
 * đúng MST của tài khoản thì không giới hạn). Chỉ chặn khi máy chủ trả lời rõ: cần đăng nhập, hết lượt, gọi dồn dập, bị từ chối. Máy chủ Huvisoft lỗi hay mất
 * mạng thì vẫn cho mở: drawer tải trang bằng phiên cổng thuế của khách, không để sự cố phía mình chặn oan khách.
 */
async function xemHoSoDvc(mst, maHoSo) {
  // mst: MST của hồ sơ (đọc ở trang chi tiết). Máy chủ chỉ bỏ giới hạn khi tài khoản có gói tờ khai VÀ có quyền với MST này.
  // maHoSo: máy chủ tính mỗi hồ sơ 1 lượt mỗi ngày cho tài khoản, kể cả mở trên máy / trình duyệt khác (HV-979).
  const { data, loi } = await goiApiCoHanMuc("/api/extension/xem-ho-so-dvc", { mst, maHoSo }, "xem nhanh hồ sơ");
  if (!loi) return { ok: true, ...sapHetLuotTu(data) };
  if (loi.needLogin || loi.hetLuot || loi.status === 429 || loi.status === 403) return loi;
  return { ok: true, khongKiemDuoc: true };
}

/**
 * Số lượt miễn phí còn lại hôm nay của từng tiện ích (để khoá nút khi hết lượt). Chỉ đọc, không giữ lượt. Chưa đăng nhập hay lỗi thì
 * null (nút giữ nguyên, không bật đăng nhập: chưa bấm gì thì chưa làm phiền).
 */
async function luotConLai(mstCongTy) {
  await sanSang;
  const token = await getIdToken().catch(() => null);
  if (!token) return null;
  try {
    const res = await fetch(`${API_BASE}/api/extension/luot-con-lai?mst=${encodeURIComponent(mstCongTy ?? "")}`, {
      credentials: "omit",
      headers: { "X-Huvisoft-Id-Token": token, ...(await headerMaCai()) },
    }).then(daNoiMaCaiNeuXong);
    if (!res.ok) return null;
    return (await res.json()).luot ?? null;
  } catch {
    return null;
  }
}

/**
 * Link mời đồng nghiệp của tài khoản đang đăng nhập (HV-1022): đồng nghiệp đăng ký và kích hoạt extension qua link thì cả hai
 * được thêm lượt. Trả `{ link, daMoi, thuong, luat }` của app; chưa đăng nhập, mất mạng hay app chưa có API (404) thì null để
 * popup / tab chào mừng ẩn phần mời. Giữ trong bộ nhớ vài phút cho khỏi hỏi mỗi lần mở popup.
 */
const MOI_DONG_NGHIEP_GIU_MS = 5 * 60 * 1000;
let moiDongNghiepDaGiu = null;

async function moiDongNghiep({ moi = false } = {}) {
  await sanSang;
  const token = await getIdToken().catch(() => null);
  if (!token) return null;
  const email = decodeJwtPayload(token)?.email ?? null;
  const giu = moiDongNghiepDaGiu;
  if (!moi && giu && giu.email === email && Date.now() - giu.luc < MOI_DONG_NGHIEP_GIU_MS) return giu.data;
  try {
    const res = await fetch(`${API_BASE}/api/extension/moi-dong-nghiep`, {
      credentials: "omit",
      headers: {
        "X-Huvisoft-Id-Token": token,
        "X-Huvisoft-Extension-Version": chrome.runtime.getManifest().version,
        ...(await headerMaCai()),
      },
    }).then(daNoiMaCaiNeuXong);
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data?.link !== "string" || !/^https:\/\/([a-z0-9-]+\.)*huvisoft\.com\/|^http:\/\/localhost[:/]/.test(data.link)) {
      return null;
    }
    moiDongNghiepDaGiu = { email, luc: Date.now(), data };
    return data;
  } catch {
    return null;
  }
}

/** Tắt hẳn hoặc đang tạm dừng (không xét từng trang): để biểu tượng hiện "||". */
function hvDuocTuGiaiChung() {
  const cd = self.hvCaiDat;
  return cd.tuGiai && Date.now() >= (cd.tamDungDen || 0);
}

// "Có gì mới" (HV-975): cập nhật lên bản có ghi chú trong HV_CO_GI_MOI thì nhớ lại, popup mở ra là coi như đã xem.
chrome.storage.local
  .get("coGiMoi")
  .then(({ coGiMoi }) => {
    self.coGiMoiChuaXem = Boolean(coGiMoi && !coGiMoi.daXem);
    if (self.coGiMoiChuaXem) capNhatBadge(self.daDangNhapCuoi ?? true);
  })
  .catch(() => {});
chrome.storage.onChanged.addListener((thayDoi, vung) => {
  if (vung !== "local") return;
  if (thayDoi.coGiMoi) self.coGiMoiChuaXem = Boolean(thayDoi.coGiMoi.newValue && !thayDoi.coGiMoi.newValue.daXem);
  if (thayDoi.coGiMoi || thayDoi.caiDat) {
    hvCaiDatSanSang.then(() => capNhatBadge(self.daDangNhapCuoi ?? true));
    henHetTamDung();
  }
});

// Hết giờ tạm dừng thì bỏ dấu "||": báo thức đúng mốc (service worker có thể đã nghỉ).
const HET_TAM_DUNG_ALARM = "het-tam-dung";
function henHetTamDung() {
  const den = self.hvCaiDat.tamDungDen || 0;
  if (den > Date.now()) chrome.alarms.create(HET_TAM_DUNG_ALARM, { when: den + 500 });
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === HET_TAM_DUNG_ALARM) capNhatBadge(self.daDangNhapCuoi ?? true);
});

/* ------------------------------------------------------------------------------------------------
 * Lượt cài ẩn danh (HV-1029): đo phễu cài → đăng nhập → kích hoạt.
 *
 * Lúc cài sinh mã cài ngẫu nhiên, gửi app một ping chỉ gồm mã cài và phiên bản (không có gì về người dùng). Mất mạng thì
 * gửi lại ở lần service worker thức sau (cờ maCaiDaGui). Đã đăng nhập thì request tới app gửi kèm mã cài (header
 * X-Huvisoft-Ma-Cai) tới khi một request thành công, để app nối lượt cài với tài khoản. Cài từ bản cũ hơn thì không có mã.
 * ---------------------------------------------------------------------------------------------- */
const maCaiSanSang = chrome.storage.local
  .get(["maCai", "maCaiDaNoi"])
  .then(({ maCai, maCaiDaNoi }) => {
    if (maCai && !maCaiDaNoi) self.maCaiChoNoi ??= maCai;
    if (maCai) self.maCaiDangDung ??= maCai;
  })
  .catch(() => {});

// HV-1022: mã cài đang dùng gửi ở MỌI request đã đăng nhập (header riêng, không đổi luồng nối mã cài ở trên) để app biết những
// tài khoản nào đã đăng nhập trên cùng lượt cài: chống tự mời đồng nghiệp bằng tài khoản phụ. Chỉ là mã ngẫu nhiên lúc cài.
async function headerMaCai() {
  await maCaiSanSang;
  return {
    ...(self.maCaiChoNoi ? { "X-Huvisoft-Ma-Cai": self.maCaiChoNoi } : {}),
    ...(self.maCaiDangDung ? { "X-Huvisoft-Ma-Cai-Dang-Dung": self.maCaiDangDung } : {}),
  };
}

function daNoiMaCaiNeuXong(res) {
  if (self.maCaiChoNoi && res.ok) {
    self.maCaiChoNoi = null;
    chrome.storage.local.set({ maCaiDaNoi: true }).catch(() => {});
  }
  return res;
}

async function guiLuotCai() {
  try {
    const { maCai, maCaiDaGui } = await chrome.storage.local.get(["maCai", "maCaiDaGui"]);
    if (!maCai || maCaiDaGui) return;
    await sanSang;
    const res = await fetch(`${API_BASE}/api/extension/cai-dat`, {
      method: "POST",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        "X-Huvisoft-Extension-Version": chrome.runtime.getManifest().version,
      },
      body: JSON.stringify({ maCai }),
    });
    // 204: đã nhận (gửi trùng không sao). 404 (app chưa có API), 429, 5xx: gửi lại lần sau.
    if (res.ok) await chrome.storage.local.set({ maCaiDaGui: true });
  } catch {
    // Mất mạng: gửi lại ở lần service worker thức sau.
  }
}
guiLuotCai();

async function taoLuotCai() {
  const maCai = crypto.randomUUID();
  self.maCaiChoNoi = maCai;
  self.maCaiDangDung = maCai;
  await chrome.storage.local.set({ maCai, maCaiDaGui: false, maCaiDaNoi: false }).catch(() => {});
  await guiLuotCai();
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // HV-920 "cài trước, đăng nhập sau", HV-927: vừa cài xong mở tab chào mừng (đăng nhập / tạo Huvisoft ID, ghim biểu
  // tượng, mở trang thuế). Tab không tự biến mất như cửa sổ đăng nhập bật lên trước đây, khách bấm đăng nhập khi đã hiểu
  // vì sao cần. Cập nhật bản thì không mở lại.
  if (reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
    taoLuotCai();
  }
  const phienBan = chrome.runtime.getManifest().version;
  if (reason === "update" && HV_CO_GI_MOI[phienBan]) {
    chrome.storage.local.set({ coGiMoi: { phienBan, daXem: false } }).catch(() => {});
  }
  kiemTraDangNhapNgam();
});

chrome.runtime.onStartup.addListener(kiemTraDangNhapNgam);

// Bản dev đổi local / dev trong popup: bỏ phiên và cấu hình id của môi trường cũ rồi kiểm tra đăng nhập lại.
chrome.storage.onChanged.addListener((thayDoi, vung) => {
  if (!LA_BAN_DEV || vung !== "local" || !thayDoi.moiTruongDev) return;
  apDungMoiTruong(thayDoi.moiTruongDev.newValue);
  idDiscovery = null;
  idUnavailableUntil = 0;
  chrome.storage.session.remove(ID_TOKEN_KEY).then(kiemTraDangNhapNgam, () => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "account") {
    getAccount().then(sendResponse);
    return true;
  }
  if (msg?.type === "login") {
    login(Boolean(msg.doiTaiKhoan)).then(sendResponse);
    return true;
  }
  if (msg?.type === "trong-dong") {
    xemTrongDong(msg.hoaDon, msg.mstCongTy)
      .catch(() => ({ ok: false, message: "Chưa tạo được bản Trống Đồng. Bạn thử lại sau." }))
      .then(sendResponse);
    return true;
  }
  if (msg?.type === "tra-cuu") {
    traCuuHoaDon(msg.xml, msg.mstCongTy)
      .catch(() => ({ ok: false, message: "Chưa tra cứu được hóa đơn này. Bạn thử lại sau." }))
      .then(sendResponse);
    return true;
  }
  if (msg?.type === "tai-pdf-goc") {
    taiPdfGoc(msg.xml, msg.mstCongTy)
      .catch(() => ({ ok: false, message: "Chưa tải được PDF gốc. Bạn thử lại sau." }))
      .then(sendResponse);
    return true;
  }
  // Mở lại bản PDF trang thuế đã nhớ: mã xem cũ đã bị khung xem xoá, cấp mã mới.
  if (msg?.type === "xem-lai-pdf") {
    if (typeof msg.pdfBase64 !== "string" || !msg.pdfBase64) {
      sendResponse(null);
      return false;
    }
    luuPdfChoKhungXem(msg.pdfBase64)
      .catch(() => null)
      .then(sendResponse);
    return true;
  }
  if (msg?.type === "rui-ro-ncc") {
    traRuiRoNcc(msg.mstList, msg.mstCongTy)
      .catch(() => ({ ok: false, message: "Chưa tra được MST này. Bạn thử lại sau." }))
      .then(sendResponse);
    return true;
  }
  if (msg?.type === "xem-ho-so-dvc") {
    xemHoSoDvc(msg.mst ?? null, typeof msg.maHoSo === "string" ? msg.maHoSo : null)
      .catch(() => ({ ok: true, khongKiemDuoc: true }))
      .then(sendResponse);
    return true;
  }
  // Script trên trang thuế không mở được trang của extension: mở phần mời ở tab chào mừng (HV-1022).
  if (msg?.type === "mo-trang-moi") {
    chrome.tabs
      .create({ url: chrome.runtime.getURL("welcome.html#moi-dong-nghiep") })
      .then(() => sendResponse(true), () => sendResponse(false));
    return true;
  }
  if (msg?.type === "moi-dong-nghiep") {
    moiDongNghiep({ moi: Boolean(msg.moi) }).then(sendResponse);
    return true;
  }
  if (msg?.type === "luot-con-lai") {
    luotConLai(msg.mstCongTy).then(sendResponse);
    return true;
  }
  // Script trên trang thuế không gọi được chrome.action.
  if (msg?.type === "ghim") {
    chrome.action
      .getUserSettings()
      .then((s) => sendResponse({ daGhim: s.isOnToolbar }))
      .catch(() => sendResponse(null));
    return true;
  }
  if (msg?.type !== "solve") return;
  solve(msg.portal, msg.image).then(async (result) => {
    capNhatBadgeTheoKetQua(result);
    await chrome.storage.local.set({
      lastResult: { ...result, portal: msg.portal, at: Date.now() },
    });
    sendResponse(result);
  });
  return true;
});

// Đồng bộ hóa đơn qua IP mạng khách (HV-932). Nạp cuối để relay.js dùng được hằng số và hàm ở trên.
importScripts("relay.js");
importScripts("bao-loi.js");
importScripts("cap-nhat.js");
