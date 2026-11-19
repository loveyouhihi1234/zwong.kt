// dichvucong.gdt.gov.vn/tthc có nhiều ảnh captcha, id đều bắt đầu bằng "image-capt":
// - #image-capt: đăng nhập người nộp thuế (modal #modalLdap) và form tra cứu hồ sơ /tthc/tchs (#form-search-advanced)
// - #image-capt-cbt: đăng nhập cán bộ thuế (input "captchaCbt")
// - #image-capt-tdt: tra cứu hồ sơ thuế điện tử /tthc/tchs (#form_search_tdt)
// Một trang có thể có nhiều input name="captcha", nên ghép ảnh với input trong cùng form. Các form chung một captcha
// trong session nên chỉ ảnh tải sau cùng còn đúng: chỉ giải form đang hiển thị. Không tải lại URL ảnh vì mỗi lần GET là
// một captcha mới; vẽ đúng ảnh đang hiển thị ra canvas (readCanvasImage).

function timInputCaptcha(img) {
  if (img.id === "image-capt-cbt") return document.querySelector('input[name="captchaCbt"]');
  const vung = img.closest("form") || img.closest(".modal");
  return (
    vung?.querySelector('input[name="captcha"], input[name="captchaCbt"]') ??
    document.querySelector('input[name="captcha"]')
  );
}

function findPairs() {
  const pairs = [];
  for (const img of document.querySelectorAll('img[id^="image-capt"]')) {
    if (!img.checkVisibility()) continue;
    const input = timInputCaptcha(img);
    if (input?.checkVisibility()) pairs.push({ img, input });
  }
  return pairs;
}

watchCaptchas({ portal: "dvc", findPairs, readImage: readCanvasImage });

// Tra cứu hồ sơ (/tthc/tchs): thêm icon dưới số STT mỗi dòng, bấm thì xem chi tiết hồ sơ trong drawer ngay tại tab này.
// Nút con mắt của trang gọi viewDetail(this), chuyển cả tab sang /tthc/tchs/files/detail/{maHoSo}?loai={loai} (mất danh sách
// kết quả). Cổng thuế chặn mở nhiều tab (khoá APP_SINGLE_TAB_ACTIVE trong localStorage) nên không mở tab mới; drawer tải trang
// chi tiết bằng phiên đang đăng nhập rồi hiện trong iframe sandbox KHÔNG chạy script: script khoá tab của trang chi tiết
// không chạy nên không đụng tới tab chính. Nút gọi hàm JS trong trang chi tiết (onclick) được bấm lại trong trang chính, nơi
// có sẵn các hàm đó (downloadFile, downloadHoSo, downloadThongBao...).
const HV_ICON_XEM =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/>' +
  '<path d="M14 4v16"/><path d="M17 9h1M17 12h1"/></svg>';

const HV_DRAWER_STYLE = `
  :host{all:initial}
  .nen{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:2147483646;animation:hien .15s}
  .drawer{position:fixed;top:0;right:0;bottom:0;width:min(1200px,96vw);background:#fff;z-index:2147483647;display:flex;
    flex-direction:column;box-shadow:-8px 0 24px rgba(0,0,0,.18);font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    animation:truot .2s ease-out}
  .dau{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #e5e7eb}
  .dau img{width:20px;height:20px}
  .tieu-de{flex:1;font-weight:600;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .thuong-hieu{color:#0b6bcb;font-weight:700}
  .ngan{color:#94a3b8;font-weight:400;margin:0 6px}
  button{font:inherit;cursor:pointer;border-radius:6px;border:1px solid #cbd5e1;background:#fff;color:#0f172a;padding:5px 12px}
  button:hover{background:#f1f5f9}
  .dong{border:0;font-size:20px;line-height:1;padding:4px 8px;color:#475569}
  .than{flex:1;position:relative}
  iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
  .bao{padding:32px;text-align:center;color:#334155}
  .bao.loi{color:#b91c1c}
  .bao .chu{max-width:520px;margin:0 auto 14px;line-height:1.55}
  .bao .chinh{background:#0b6bcb;border-color:#0b6bcb;color:#fff;padding:7px 16px}
  .bao .chinh:hover{background:#0a5eb3}
  .bao .phu-chu{margin-top:12px;font-size:13px;color:#64748b}
  .xoay{width:28px;height:28px;margin:0 auto 12px;border:3px solid #cbd5e1;border-top-color:#0b6bcb;border-radius:50%;
    animation:quay .8s linear infinite}
  @keyframes quay{to{transform:rotate(360deg)}}
  @keyframes hien{from{opacity:0}}
  @keyframes truot{from{transform:translateX(40px);opacity:0}}
`;

let hvDrawerDong = null;

function hvBamLaiTrongTrangChinh(nut) {
  // Thuộc tính onclick chạy trong ngữ cảnh trang chính (hàm của trang), giữ nguyên data-* để hàm đọc như ở trang chi tiết.
  const ban = document.createElement(nut.tagName === "A" ? "a" : "button");
  for (const { name, value } of nut.attributes) {
    if (name === "onclick" || name.startsWith("data-") || name === "id" || name === "value") ban.setAttribute(name, value);
  }
  ban.style.display = "none";
  document.body.appendChild(ban);
  ban.click();
  ban.remove();
}

async function hvMoDrawerHoSo(mat) {
  hvDrawerDong?.();
  const maHoSo = mat.getAttribute("data-ma-ho-so");
  const loai = mat.getAttribute("data-loai") ?? "";
  const url = new URL(
    `/tthc/tchs/files/detail/${encodeURIComponent(maHoSo)}?loai=${encodeURIComponent(loai)}`,
    location.origin,
  ).href;

  const host = document.createElement("div");
  host.dataset.huvisoftPhu = ""; // dòng trạng thái captcha (common.js) tự ẩn khi drawer đang mở
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>${HV_DRAWER_STYLE}</style><div class="nen"></div>
    <div class="drawer" role="dialog" aria-modal="true">
      <div class="dau"><img alt=""><div class="tieu-de"><span class="thuong-hieu">Huvisoft</span><span class="ngan">·</span><span class="ten"></span></div>
        <button class="mo-tab">Mở trong tab này</button><button class="dong" title="Đóng" aria-label="Đóng">×</button></div>
      <div class="than"><div class="bao"><div class="xoay"></div>Đang tải chi tiết hồ sơ…</div></div>
    </div>`;
  root.querySelector("img").src = chrome.runtime.getURL("icons/icon-48.png");
  root.querySelector(".tieu-de .ten").textContent = `Chi tiết hồ sơ ${maHoSo}`;
  const than = root.querySelector(".than");

  const cuonCu = document.documentElement.style.overflow;
  document.documentElement.style.overflow = "hidden";
  const banPhim = (e) => e.key === "Escape" && dong();
  const dong = () => {
    host.remove();
    document.documentElement.style.overflow = cuonCu;
    document.removeEventListener("keydown", banPhim, true);
    hvDrawerDong = null;
  };
  hvDrawerDong = dong;
  document.addEventListener("keydown", banPhim, true);
  root.querySelector(".nen").addEventListener("click", dong);
  root.querySelector(".dong").addEventListener("click", dong);
  root.querySelector(".mo-tab").addEventListener("click", () => {
    dong();
    mat.click();
  });
  document.body.appendChild(host);

  const baoLoi = (chu) => {
    than.innerHTML = '<div class="bao loi"></div>';
    than.firstChild.textContent = chu;
  };

  let html;
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) {
      baoLoi(
        res.status === 429
          ? "Cổng thuế đang giới hạn tần suất. Bạn đợi một lát rồi thử lại, hoặc bấm “Mở trong tab này”."
          : `Cổng thuế chưa trả chi tiết hồ sơ (mã ${res.status}). Bạn bấm “Mở trong tab này” để xem như nút con mắt.`,
      );
      return;
    }
    html = await res.text();
  } catch {
    baoLoi("Không tải được chi tiết hồ sơ. Bạn bấm “Mở trong tab này” để xem như nút con mắt.");
    return;
  }
  if (!host.isConnected) return;

  const doc = new DOMParser().parseFromString(html, "text/html");
  // HV-979: miễn phí 5 lần/ngày, có gói Dịch vụ công thì không giới hạn. Không mở được qua drawer thì nút "Mở trong tab này"
  // (như nút con mắt của trang) vẫn dùng được.
  // Hỏi sau khi đã tải trang chi tiết: máy chủ cần MST của hồ sơ để xét quyền theo tài khoản (gói tờ khai + MST của tài khoản).
  // Mở lại hồ sơ đã tính lượt hôm nay thì không hỏi máy chủ: một hồ sơ mở bao nhiêu lần trong ngày cũng chỉ tính một lượt.
  const daTinh = await hvHoSoDaTinhLuot(maHoSo);
  const quyen = daTinh
    ? { ok: true }
    : await chrome.runtime.sendMessage({ type: "xem-ho-so-dvc", mst: hvMstHoSo(doc), maHoSo }).catch(() => ({ ok: true }));
  // Máy chủ không kiểm được (khongKiemDuoc) thì chưa trừ lượt: chưa nhớ, lần sau hỏi lại.
  if (!daTinh && quyen?.ok && !quyen.khongKiemDuoc) hvNhoHoSoDaTinhLuot(maHoSo);
  // HV-1030: dùng gần hết lượt xem nhanh hôm nay thì mời gói (common.js), drawer vẫn mở bình thường.
  if (quyen?.sapHetLuot) hvMoiSapHetLuot(quyen.sapHetLuot);
  if (!host.isConnected) return;
  if (!quyen?.ok) {
    const khoi = document.createElement("div");
    khoi.className = "bao";
    const chu = document.createElement("div");
    chu.className = "chu";
    khoi.append(chu);
    const nut = document.createElement("button");
    nut.className = "chinh";
    if (quyen?.needLogin) {
      chu.textContent = "Đăng nhập Huvisoft (miễn phí) để xem nhanh chi tiết hồ sơ ngay tại danh sách.";
      nut.textContent = "Đăng nhập / Đăng ký";
      nut.addEventListener("click", async () => {
        const r = await chrome.runtime.sendMessage({ type: "login" }).catch(() => null);
        if (r?.ok) hvMoDrawerHoSo(mat);
        else if (r?.message) chu.textContent = r.message;
      });
    } else if (quyen?.hetLuot) {
      chu.textContent = quyen.message || "Bạn đã dùng hết lượt xem nhanh hồ sơ miễn phí hôm nay.";
      nut.textContent = "Xem gói Huvisoft";
      nut.addEventListener("click", () => window.open(quyen.muaUrl, "_blank", "noopener"));
    } else {
      chu.textContent = quyen?.message || "Chưa mở được bản xem nhanh. Bạn thử lại sau.";
    }
    if (nut.textContent) khoi.append(nut);
    const phu = document.createElement("div");
    phu.className = "phu-chu";
    phu.textContent = "Bạn vẫn xem được hồ sơ bằng nút “Mở trong tab này” ở trên.";
    khoi.append(phu);
    than.replaceChildren(khoi);
    return;
  }
  doc.querySelectorAll("script, noscript").forEach((e) => e.remove());
  const base = doc.createElement("base");
  base.href = url;
  doc.head.prepend(base);

  const khung = document.createElement("iframe");
  // Không allow-scripts: script khoá tab và mọi JS của trang chi tiết không chạy. allow-same-origin để extension gắn sự kiện
  // vào nút trong khung (không có script thì không nguy hiểm); tải file và link tab mới vẫn dùng được.
  khung.setAttribute(
    "sandbox",
    "allow-same-origin allow-downloads allow-forms allow-popups allow-popups-to-escape-sandbox",
  );
  khung.addEventListener("load", () => {
    const tl = khung.contentDocument;
    if (!tl) return;
    tl.addEventListener(
      "click",
      (e) => {
        // Modal / link "#..." trước: không có script thì Bootstrap không mở modal, còn trình duyệt hiểu "#..." theo <base> là
        // chuyển cả khung sang trang dichvucong (cổng thuế cấm nhúng: "refused to connect"). Vd "Xem thông báo", "Xem tài liệu".
        if (hvModalTrongKhung(tl, e)) return;
        // Nút "Đóng" cuối trang chi tiết (ngoài modal) trên trang gốc là quay về danh sách, chạy bằng script của trang nên
        // trong khung bấm không có gì. Trong drawer, danh sách vẫn nằm ngay sau: đóng drawer. Không bấm lại ở trang chính
        // vì sẽ làm tab chính rời trang danh sách.
        const nutDong = e.target.closest?.("button, a, input[type='button'], input[type='submit']");
        if (nutDong && !nutDong.closest(".modal") && /^đóng$/i.test((nutDong.tagName === "INPUT" ? nutDong.value : nutDong.textContent).trim())) {
          e.preventDefault();
          hvDrawerDong?.();
          return;
        }
        const nut = e.target.closest?.("[onclick]");
        if (!nut) return;
        e.preventDefault();
        hvBamLaiTrongTrangChinh(nut);
      },
      true,
    );
  });
  khung.srcdoc = "<!doctype html>" + doc.documentElement.outerHTML;
  than.replaceChildren(khung);
}

// Hồ sơ đã tính lượt xem nhanh trong ngày (theo ngày giờ Việt Nam, như máy chủ đặt lại lượt mỗi ngày).
const HV_KHOA_HO_SO_DA_TINH = "hoSoDvcDaTinhLuot";
const hvHomNayVn = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });

async function hvHoSoDaTinhLuot(maHoSo) {
  try {
    const { [HV_KHOA_HO_SO_DA_TINH]: daTinh } = await chrome.storage.local.get(HV_KHOA_HO_SO_DA_TINH);
    return daTinh?.ngay === hvHomNayVn() && Array.isArray(daTinh.ma) && daTinh.ma.includes(maHoSo);
  } catch {
    return false;
  }
}

async function hvNhoHoSoDaTinhLuot(maHoSo) {
  try {
    const ngay = hvHomNayVn();
    const { [HV_KHOA_HO_SO_DA_TINH]: cu } = await chrome.storage.local.get(HV_KHOA_HO_SO_DA_TINH);
    const ma = cu?.ngay === ngay && Array.isArray(cu.ma) ? cu.ma.filter((m) => m !== maHoSo) : [];
    // Giữ 500 hồ sơ gần nhất cho storage gọn (người có gói mở nhiều hồ sơ một ngày).
    await chrome.storage.local.set({ [HV_KHOA_HO_SO_DA_TINH]: { ngay, ma: [...ma, maHoSo].slice(-500) } });
  } catch {}
}

/** MST của hồ sơ trên trang chi tiết: ô ngay sau nhãn "Mã số thuế". Không thấy thì null (máy chủ tính như chưa có gói). */
function hvMstHoSo(doc) {
  for (const nhan of doc.querySelectorAll("label, th, td, span, div, p")) {
    if (nhan.children.length > 1 || nhan.textContent.trim().replace(/\s+/g, " ") !== "Mã số thuế") continue;
    for (let o = nhan.nextElementSibling ?? nhan.parentElement?.nextElementSibling, i = 0; o && i < 3; o = o.nextElementSibling, i++) {
      const chu = (o.querySelector?.("input")?.getAttribute("value") ?? o.querySelector?.("input")?.value ?? o.textContent ?? "").trim();
      const mst = chu.match(/\b\d{10}(-\d{3})?\b|\b\d{12}\b/)?.[0];
      if (mst) return mst;
    }
  }
  return null;
}

/**
 * Mở / đóng modal Bootstrap trong khung drawer (khung không chạy script). Trả true khi đã xử lý cú bấm.
 * - Nút mở: data-toggle / data-bs-toggle="modal" với data-target / data-bs-target / href="#id".
 * - Nút đóng: data-dismiss / data-bs-dismiss="modal", hoặc bấm ra nền tối quanh modal.
 * - Link "#id" khác: cuộn tới phần tử đó thay vì để khung điều hướng đi.
 */
function hvModalTrongKhung(tl, e) {
  const dong = (modal) => {
    modal.classList.remove("show", "in");
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
    tl.querySelectorAll(".modal-backdrop[data-hv]").forEach((n) => n.remove());
    tl.body.classList.remove("modal-open");
  };
  const nutDong = e.target.closest?.('[data-dismiss="modal"], [data-bs-dismiss="modal"]');
  if (nutDong) {
    e.preventDefault();
    const modal = nutDong.closest(".modal");
    if (modal) dong(modal);
    return true;
  }
  // Bấm ra vùng tối quanh hộp thoại (chính phần tử .modal, ngoài .modal-dialog) thì đóng như Bootstrap.
  if (e.target.classList?.contains("modal") && e.target.style.display === "block") {
    dong(e.target);
    return true;
  }
  const link = e.target.closest?.('[data-toggle="modal"], [data-bs-toggle="modal"], a[href^="#"]');
  if (!link) return false;
  const dich =
    link.getAttribute("data-target") || link.getAttribute("data-bs-target") || link.getAttribute("href") || "";
  e.preventDefault();
  if (!dich.startsWith("#") || dich.length < 2) return !link.hasAttribute("onclick");
  let dichDen = null;
  try {
    dichDen = tl.querySelector(dich);
  } catch {
    dichDen = tl.getElementById(dich.slice(1));
  }
  if (!dichDen) return !link.hasAttribute("onclick");
  if (!dichDen.classList.contains("modal")) {
    dichDen.scrollIntoView({ block: "start" });
    return true;
  }
  tl.querySelectorAll(".modal[style*='display: block']").forEach(dong);
  const nen = tl.createElement("div");
  nen.className = "modal-backdrop fade show in";
  nen.dataset.hv = "";
  tl.body.append(nen);
  tl.body.classList.add("modal-open");
  dichDen.style.display = "block";
  dichDen.classList.add("show", "in");
  dichDen.removeAttribute("aria-hidden");
  return true;
}

// Vùng bấm 32px quanh icon 18px (icon 15px trước đây khó trúng), rê chuột thì nền nhạt cho biết bấm được.
function hvThemKieuIconXem() {
  if (document.getElementById("hv-kieu-xem-ho-so")) return;
  const kieu = document.createElement("style");
  kieu.id = "hv-kieu-xem-ho-so";
  kieu.textContent = `
    .hv-xem-ho-so { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; margin: 2px auto 0;
      border-radius: 6px; line-height: 0; cursor: pointer; }
    .hv-xem-ho-so:hover { background: rgba(11, 107, 203, .12); }
    .hv-xem-ho-so:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
  `;
  (document.head ?? document.documentElement).append(kieu);
}

function themIconXemHoSo() {
  hvThemKieuIconXem();
  for (const mat of document.querySelectorAll('[onclick*="viewDetail"]')) {
    const maHoSo = mat.getAttribute("data-ma-ho-so");
    const oStt = mat.closest("tr")?.cells[0];
    if (!maHoSo || !oStt || oStt.querySelector(".hv-xem-ho-so")) continue;
    const nut = document.createElement("a");
    nut.className = "hv-xem-ho-so";
    nut.href = "#";
    nut.title = "Xem nhanh chi tiết hồ sơ, không rời danh sách (Huvisoft)";
    nut.innerHTML = HV_ICON_XEM.replaceAll('"15"', '"18"');
    nut.style.color = getComputedStyle(mat).color;
    nut.addEventListener("click", (e) => {
      e.preventDefault();
      hvMoDrawerHoSo(mat);
    });
    oStt.appendChild(nut);
  }
}

// Tra cứu hồ sơ: form tìm kiếm chính (#field5 Từ ngày, #field6 Đến ngày) không tự giới hạn khoảng ngày như form thuế điện
// tử (#tuNgay_tdt có data-max-range=30, trang tự xử lý). Làm giống syncRange của trang: đổi Từ ngày mà quá 30 ngày thì dời
// Đến ngày = Từ ngày + 30 (không quá hôm nay); đổi Đến ngày thì dời Từ ngày = Đến ngày − 30.
const HV_KHOANG_TOI_DA = 30;
const HV_NGAY_MS = 86_400_000;

function hvDocNgay(chuoi) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((chuoi || "").trim());
  if (!m) return null;
  const ngay = Date.UTC(+m[3], +m[2] - 1, +m[1]);
  return Number.isNaN(ngay) ? null : ngay;
}

function hvGhiNgay(ms) {
  const d = new Date(ms);
  const hai = (n) => String(n).padStart(2, "0");
  return `${hai(d.getUTCDate())}/${hai(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

function hvBaoDaSua(input, chu) {
  const cu = input.parentElement.querySelector(".hv-da-sua-ngay");
  cu?.remove();
  const ghiChu = document.createElement("div");
  ghiChu.className = "hv-da-sua-ngay";
  ghiChu.textContent = chu;
  ghiChu.style.cssText = "font-size:12px;color:#0b6bcb;margin-top:4px";
  input.after(ghiChu);
  input.animate([{ backgroundColor: "#dbeafe" }, { backgroundColor: "" }], { duration: 1500 });
  setTimeout(() => ghiChu.remove(), 6000);
}

function hvDatNgay(input, ms) {
  input.value = hvGhiNgay(ms);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function hvTheoDoiKhoangNgay(idTu, idDen) {
  let cuTu = null;
  let cuDen = null;
  const kiemTra = () => {
    const tu = document.getElementById(idTu);
    const den = document.getElementById(idDen);
    if (!tu || !den) return;
    const doiTu = tu.value !== cuTu;
    const doiDen = den.value !== cuDen;
    cuTu = tu.value;
    cuDen = den.value;
    if (!doiTu && !doiDen) return;
    const ngayTu = hvDocNgay(tu.value);
    const ngayDen = hvDocNgay(den.value);
    if (ngayTu === null || ngayDen === null) return;
    const khoang = Math.round((ngayDen - ngayTu) / HV_NGAY_MS);
    if (khoang <= HV_KHOANG_TOI_DA && khoang >= 0) return;
    if (doiTu) {
      const homNay = hvDocNgay(hvGhiNgay(Date.now() + 7 * 3_600_000));
      const moi = Math.max(ngayTu, Math.min(ngayTu + HV_KHOANG_TOI_DA * HV_NGAY_MS, homNay));
      hvDatNgay(den, moi);
      cuDen = den.value;
      hvBaoDaSua(den, `Huvisoft đã đổi Đến ngày để khoảng tìm kiếm không quá ${HV_KHOANG_TOI_DA} ngày`);
    } else {
      hvDatNgay(tu, ngayDen - HV_KHOANG_TOI_DA * HV_NGAY_MS);
      cuTu = tu.value;
      hvBaoDaSua(tu, `Huvisoft đã đổi Từ ngày để khoảng tìm kiếm không quá ${HV_KHOANG_TOI_DA} ngày`);
    }
  };
  // Bộ chọn ngày của trang đổi value bằng jQuery, không phát sự kiện gốc, và ghi ngày SAU sự kiện click (lượt soi theo click
  // chạy trước khi có ngày mới): soi theo sự kiện cho nhanh, thêm vòng 250ms để luôn bắt kịp. Mỗi lượt chỉ so 2 chuỗi.
  for (const loai of ["change", "input", "focusout", "click", "keyup"]) {
    document.addEventListener(loai, () => setTimeout(kiemTra, 0), true);
  }
  setInterval(kiemTra, 250);
  // Ngày mặc định lúc tải trang: không tự đổi, chỉ sửa khi người dùng chọn lại.
  cuTu = document.getElementById(idTu)?.value ?? null;
  cuDen = document.getElementById(idDen)?.value ?? null;
}

if (location.pathname.startsWith("/tthc/tchs")) {
  hvTheoDoiKhoangNgay("field5", "field6");
  let henQuet = null;
  const quet = () => {
    clearTimeout(henQuet);
    henQuet = setTimeout(themIconXemHoSo, 150);
  };
  new MutationObserver(quet).observe(document.documentElement, { childList: true, subtree: true });
  quet();
}
