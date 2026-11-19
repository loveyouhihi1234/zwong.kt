// Mọi URL + selector của cổng dichvucong.gdt.gov.vn nằm ở đây.
// Khi Tổng cục Thuế đổi giao diện, chỉ cần sửa file này.
(() => {
  // Không thao tác giao diện của cổng (không điền form, không bấm, không chuyển trang):
  // mọi việc đi qua fetch. Form tra cứu (lấy _csrf/action/trường mặc định) đọc từ trang hiện tại nếu có,
  // không thì fetch ngầm trang /tthc/tchs – nhờ vậy chạy được trên mọi trang dichvucong sau khi đăng nhập.
  // fetch HTML không chạy JS của cổng nên không vướng cơ chế chặn đa tab (chỉ ở phía trình duyệt).
  // Hai nguồn tra cứu trên trang /tthc/tchs. cols = vị trí cột trong bảng kết quả.
  const SOURCES = {
    // Thuế điện tử (hồ sơ nộp trước 01/07/2025): POST htmx, giới hạn 1 tháng chỉ ở giao diện.
    tdt: {
      folder: 'ThueDienTu',
      form: '#form_search_tdt', method: 'POST',
      fields: { tuNgay: 'tuNgay_tdt', denNgay: 'denNgay_tdt', maToKhai: 'maToKhai_tdt' },
      cols: { maGiaoDich: 1, toKhai: 2, kyTinhThue: 3, loaiToKhai: 4, lanNop: 5, lanBoSung: 6, ngayNop: 7, noiNop: 8, trangThai: 9 },
      defaultLoai: 'ETAX',
      keepCaptchaOnPaging: true, // trang của cổng gửi lại mã cũ khi chuyển trang
    },
    // Hồ sơ nộp trên DVC (từ 01/07/2025): GET htmx /tthc/ho-so/search. Giao diện chặn 30 ngày, máy chủ
    // không chặn (12 tháng OK). Sau 1 lần nhập captcha, các truy vấn sau gửi captcha rỗng vẫn được.
    dvc: {
      folder: 'DVC',
      form: '#form-search-advanced', method: 'GET', url: '/tthc/ho-so/search',
      fields: { tuNgay: 'tuNgay', denNgay: 'denNgay', maToKhai: 'maToKhai' },
      cols: { maHoSo: 2, tenTTHC: 3, toKhai: 4, kyTinhThue: 5, loaiToKhai: 6, lanBoSung: 7, lanNop: 8, noiNop: 9, ngayNop: 10, trangThai: 11 },
      defaultLoai: '',
      keepCaptchaOnPaging: false,
    },
  };
  const SEL = {
    form: SOURCES.tdt.form,
    maToKhai: '#form_search_tdt [name=maToKhai_tdt]',
    companyName: '.user-header .user-name .ten_dn, .ten_dn', // góc phải header, cạnh chuông thông báo
  };
  const URL_SEARCH_PAGE = '/tthc/tchs';
  const DOWNLOAD_ROOT = 'HoSoThue'; // Downloads/HoSoThue/<Tên công ty>/<ThueDienTu|DVC>/
  const MAX_MONTHS = 12; // giới hạn khoảng ngày mỗi lần tra cứu (cả 2 nguồn)
  const PAGE_SIZE = 100; // cả 2 nguồn nhận size=100 (kiểm chứng 11/10/2026)
  const URL_DETAIL = (maHoSo, loai) =>
    `/tthc/tchs/files/detail/${encodeURIComponent(maHoSo)}?loai=${encodeURIComponent(loai || '')}`;
  // Nút "Tải xuống" trên trang chi tiết gọi downloadHoSo()/downloadThongBao() (downloadCommon-*.js):
  // POST JSON kèm header CSRF, trả {content: base64, fileName, fileType}.
  const URL_VALIDATE = (id) => `/tthc/tchs/validateIdTkhai?idTKhai=${encodeURIComponent(id)}`;
  const URL_DL_HOSO = (loai, tdt) => tdt ? `/tthc/tchs/downloadhoso-tdt?loaiTraCuu=${encodeURIComponent(loai)}` : '/tthc/tchs/downloadhoso';
  const URL_DL_TBAO = (loai, tdt) => tdt ? `/tthc/tchs/downloadthongbao-tdt?loaiTraCuu=${encodeURIComponent(loai)}` : '/tthc/tchs/downloadthongbao';
  const CSRF = { token: 'meta[name=csrf-token]', header: 'meta[name=csrf-header]' };

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();

  // Trang tra cứu đã parse (document hiện tại hoặc bản fetch). null = chưa đăng nhập.
  let pageDoc = null;
  async function loadSearchPage(force = false) {
    if ($(SEL.form)) return (pageDoc = document);
    if (pageDoc && !force) return pageDoc;
    const res = await fetch(URL_SEARCH_PAGE, { credentials: 'include', cache: 'no-store' });
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    // Chưa đăng nhập: cổng chuyển hướng về homelogin, không có form
    pageDoc = res.ok && new URL(res.url).pathname.startsWith(URL_SEARCH_PAGE) && $(SEL.form, doc) ? doc : null;
    return pageDoc;
  }
  async function needSearchPage() {
    const doc = await loadSearchPage();
    if (!doc) throw new Error('Chưa đăng nhập dichvucong – hãy đăng nhập rồi bấm ↻');
    return doc;
  }

  function csrfHeaders(doc, extra = {}) {
    const h = { ...extra };
    const token = $(CSRF.token, doc)?.content;
    if (token) h[$(CSRF.header, doc)?.content || 'X-XSRF-TOKEN'] = token;
    return h;
  }

  async function getSessionInfo({ refresh = false } = {}) {
    const doc = await loadSearchPage(refresh).catch(() => null);
    const company = text($(SEL.companyName)) || (doc && text($(SEL.companyName, doc))) || null;
    return { company, url: location.href, ready: !!doc, toKhai: getToKhaiOptions(doc) };
  }

  function getToKhaiOptions(doc) {
    const sel = doc && $(SEL.maToKhai, doc);
    if (!sel) return [];
    return [...sel.options].map((o) => ({ value: o.value, label: o.text.trim() }));
  }

  function parseRows(root, src) {
    return $$('table tbody tr', root).map((tr) => {
      const holder = tr.querySelector('[data-ma-ho-so]');
      if (!holder) return null;
      const c = [...tr.cells].map(text);
      const row = Object.fromEntries(Object.entries(src.cols).map(([k, i]) => [k, c[i] || '']));
      row.maHoSo = holder.dataset.maHoSo;
      row.maGiaoDich ||= row.maHoSo; // DVC không có cột mã giao dịch
      row.loai = holder.dataset.loai || src.defaultLoai;
      return row;
    }).filter(Boolean);
  }

  function pageInfo(root) {
    // TĐT: "Trang 1/ 2 — Tổng số bản ghi: 16"; DVC: "Trang /2 - Tổng số bản ghi: 14" (số trang hiện tại nằm trong ô input)
    const m = text(root.body || root).match(/Trang\s*(\d*)\s*\/\s*(\d+)\s*[—–-]?\s*Tổng số bản ghi:\s*(\d+)/);
    return m ? { page: m[1] ? +m[1] : null, pages: +m[2], total: +m[3] } : null;
  }

  // Lần tìm gần nhất: dùng lại để xin trang khác (cổng không hỏi lại captcha khi chuyển trang).
  let query = null; // { src, params }
  let currentPage = 0;

  // Gửi form tra cứu như htmx của cổng làm, trả về đoạn HTML bảng kết quả đã parse.
  async function runQuery({ src, params }) {
    const doc = await needSearchPage();
    const headers = csrfHeaders(doc, { 'HX-Request': 'true' });
    const res = src.method === 'GET'
      ? await fetch(`${src.url}?${params}`, { credentials: 'include', headers })
      : await fetch($(src.form, doc).getAttribute('action'), {
        method: 'POST', credentials: 'include', body: params,
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    const html = await res.text();
    // Sai captcha: cổng trả HTTP 400 kèm thông báo dạng text
    if (!res.ok) throw new Error(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Mã captcha không chính xác');
    return new DOMParser().parseFromString(html, 'text/html');
  }

  async function queryPage(p) {
    query.params.set('page', String(p));
    if (p > 1 && !query.src.keepCaptchaOnPaging) query.params.set('captcha', '');
    const doc = await runQuery(query);
    currentPage = p;
    return doc;
  }

  // Chuyển "trang hiện tại" phía máy chủ – cần vì trang chi tiết chỉ mở được cho hồ sơ trên trang đó.
  // force: gửi lại kể cả khi tưởng đang ở trang p (phiên có thể đã bị đặt lại, vd. fetch lại trang tra cứu).
  async function gotoPage(p, force = false) {
    if (currentPage === p && !force) return true;
    if (!query) return false;
    const info = pageInfo(await queryPage(p));
    return !!info && (info.page == null || info.page === p);
  }

  async function buildParams(src, { tuNgay, denNgay, maToKhai = '', captcha = '' }) {
    const doc = await loadSearchPage(true);
    if (!doc) await needSearchPage();
    const params = new URLSearchParams(new FormData($(src.form, doc) || undefined));
    params.set(src.fields.tuNgay, tuNgay);
    params.set(src.fields.denNgay, denNgay);
    params.set(src.fields.maToKhai, maToKhai);
    params.set('captcha', captcha);
    params.set('page', '1');
    params.set('size', String(PAGE_SIZE));
    return params;
  }

  // Trang web vừa chuyển trang → content script mới, mất truy vấn trong bộ nhớ. Dựng lại từ điều kiện
  // panel giữ (phiên phía máy chủ vẫn còn hiệu lực captcha nên không cần nhập lại).
  async function restoreQuery({ source = 'tdt', tuNgay, denNgay, maToKhai, captcha }) {
    if (query) return;
    const src = SOURCES[source];
    const params = await buildParams(src, { tuNgay, denNgay, maToKhai, captcha: src.keepCaptchaOnPaging ? captcha : '' });
    query = { src, params }; currentPage = 0;
  }

  // Gửi form với khoảng ngày tuỳ ý (máy chủ không giới hạn 1 tháng) + captcha người dùng nhập,
  // rồi đọc hết các trang kết quả.
  async function search({ source = 'tdt', tuNgay, denNgay, maToKhai = '', captcha, onProgress = () => {} }) {
    const src = SOURCES[source];
    if (!src) throw new Error(`Nguồn tra cứu không hợp lệ: ${source}`);
    // Tối đa 12 tháng mỗi lần (panel cũng chặn) – ngày dạng dd/mm/yyyy
    const [d1, m1, y1] = tuNgay.split('/').map(Number), [d2, m2, y2] = denNgay.split('/').map(Number);
    const from = new Date(y1, m1 - 1, d1), to = new Date(y2, m2 - 1, d2);
    if (from > to) throw new Error('Từ ngày không được sau Đến ngày');
    if (to >= new Date(y1, m1 - 1 + MAX_MONTHS, d1)) throw new Error(`Khoảng ngày tối đa ${MAX_MONTHS} tháng`);
    const params = await buildParams(src, { tuNgay, denNgay, maToKhai, captcha });
    query = null; currentPage = 0;

    let doc = await runQuery({ src, params });
    query = { src, params }; currentPage = 1;
    const info = pageInfo(doc);
    if (!info) {
      if (/captcha|mã xác nhận/i.test(text(doc.body))) throw new Error('Mã captcha không chính xác');
      return { rows: [], total: 0 };
    }

    const all = [];
    for (let p = 1; p <= info.pages; p++) {
      if (p > 1) { await sleep(1000); doc = await queryPage(p); }
      all.push(...parseRows(doc, src).map((r) => ({ ...r, source, page: p })));
      onProgress({ page: p, pages: info.pages, count: all.length, total: info.total });
    }
    return { rows: all, total: info.total };
  }

  // Lấy trang chi tiết bằng fetch (không chuyển trang, giữ nguyên kết quả tìm kiếm).
  // Máy chủ trả 500 nếu hồ sơ KHÔNG nằm trên "trang hiện tại" của lần tìm → gọi gotoPage(row.page) trước.
  async function fetchDetail(row) {
    const res = await fetch(URL_DETAIL(row.maHoSo, row.loai), { credentials: 'include' });
    if (!res.ok) throw new Error(`Trang chi tiết lỗi HTTP ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const field = (label) => {
      const lb = $$('label, div, td, span', doc).find((e) => text(e) === label);
      const inp = lb?.parentElement?.querySelector('input, textarea');
      return inp?.value || null;
    };
    const files = $$('a[onclick]', doc).map((a) => {
      const fn = a.getAttribute('onclick');
      const loai = a.dataset.loaitracuu || row.loai;
      const tdt = a.dataset.isThueDienTu === 'true';
      if (/downloadHoSo\(/.test(fn)) return { kind: 'hoso', id: a.dataset.mahoso, loai, tdt };
      if (/downloadThongBao\(/.test(fn)) return { kind: 'thongbao', id: a.dataset.id, loai, tdt };
      return null;
    }).filter((f) => f?.id);
    return { mst: field('Mã số thuế'), tenNNT: field('Tên người nộp thuế'), files };
  }

  // Tải 1 file như nút "Tải xuống" của cổng. Trả {content (base64), fileName, fileType}.
  async function downloadFile(f) {
    const headers = csrfHeaders(await needSearchPage(), { 'Content-Type': 'application/json' });
    let url, body;
    if (f.kind === 'hoso') {
      const v = await fetch(URL_VALIDATE(f.id), { credentials: 'include' });
      if (!v.ok || (await v.text()).replace(/"/g, '').trim() !== '200') throw new Error('Mã tờ khai không hợp lệ hoặc phiên đã hết hạn');
      url = URL_DL_HOSO(f.loai, f.tdt); body = { maHoSo: f.id };
    } else {
      url = URL_DL_TBAO(f.loai, f.tdt); body = { idTbao: f.id, loaiTBao: '' };
    }
    const res = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    const msg = data.error || data.message;
    // Cổng không còn file (vd. tờ khai TĐT năm 2020): nút "Tải xuống" trên cổng cũng báo y hệt
    if (/Không tìm thấy hồ sơ/i.test(msg || '')) throw new Error('Cổng thuế không còn lưu file này (tải trên cổng cũng báo lỗi)');
    if (!res.ok || !data.content) throw new Error(msg || `Tải ${f.kind === 'hoso' ? 'tờ khai' : 'thông báo'} lỗi HTTP ${res.status}`);
    return { content: data.content, fileName: data.fileName, fileType: data.fileType };
  }

  const folderOf = (source) => SOURCES[source]?.folder || 'HoSo';

  window.GDT = { SEL, DOWNLOAD_ROOT, folderOf, getSessionInfo, getToKhaiOptions, search, restoreQuery, gotoPage, fetchDetail, downloadFile, sleep };
})();
