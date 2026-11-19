import { createRangePicker } from './datepicker.js';
import { createCombobox } from './combobox.js';

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toVN = (s) => s.split('-').reverse().join('/'); // yyyy-mm-dd -> dd/mm/yyyy
let tabId = null;
let connected = false;
let busy = false;
let panelRows = [];   // panel tự giữ danh sách: trang web chuyển trang thì content script mất dữ liệu
let lastSearch = null;
let pendingSearch = null; // điều kiện của lần tìm thành công gần nhất (để khôi phục khi tải)
let downloadAll = false;  // job tải hiện tại là "Tải tất cả" → xong thì hiện modal
let stopped = false;      // người dùng bấm Dừng → không hiện modal
const PORTAL = 'https://dichvucong.gdt.gov.vn/*';
const isPortal = (url) => /^https:\/\/dichvucong\.gdt\.gov\.vn\//.test(url || '');

async function findTab() {
  // Tab dichvucong bất kỳ (cổng chỉ cho 1 tab/tài khoản); ưu tiên tab đang ở trang tra cứu
  // Không cần quyền "tabs": quyền host dichvucong đủ để lọc tab theo URL và đọc tab.url của tab đó
  const tabs = await chrome.tabs.query({ url: PORTAL });
  return (tabs.find((t) => /\/tthc\/tchs/.test(t.url || '')) || tabs[0])?.id ?? null;
}
const ask = (msg) => chrome.tabs.sendMessage(tabId, msg);

// Nhật ký nằm cuối trang: dòng đầu tiên thì cuộn xuống, sau đó bám cuối trang
// trừ khi người dùng đã cuộn lên xem chỗ khác
const page = document.documentElement;
let followLog = true;
addEventListener('scroll', () => { followLog = innerHeight + scrollY >= page.scrollHeight - 40; }, { passive: true });
function log(text, level = 'warn') {
  if ($('log').firstElementChild?.textContent === text) return $('log').firstElementChild; // không ghi trùng dòng mới nhất
  if (!$('log').firstElementChild) followLog = true;
  const li = document.createElement('li'); li.textContent = text; li.className = level || 'warn'; $('log').prepend(li);
  if (followLog) requestAnimationFrame(() => window.scrollTo(0, page.scrollHeight));
  return li;
}
let connErr = null; // dòng lỗi "không kết nối được tab" – xoá khi kết nối lại được


function setConnected(on, company = null) {
  connected = on;
  $('company').hidden = !(on && company);
  $('company').textContent = on && company ? company : '';
  $('company').title = $('company').textContent;
  $('noCompany').hidden = !$('company').hidden;
  $('session').className = `badge ${on ? 'on' : 'off'}`;
  $('session').textContent = on ? 'Đã kết nối' : 'Chưa kết nối – hãy đăng nhập';
  syncRun();
}

async function init() {
  tabId = await findTab();
  if (!tabId) { setConnected(false); return; }
  let info;
  try { info = await ask({ type: 'info' }); } catch (e) {
    // Tab mở trước khi cài/tải lại extension → chưa có content script
    setConnected(false);
    connErr = log('Hãy đăng nhập vào trang dichvucong.gdt.gov.vn rồi bấm ↻', 'error');
    tabId = null; return;
  }
  connErr?.remove(); connErr = null;
  setConnected(!!info.ready, info.company);
  $('toKhai').length = 1;
  for (const o of info.toKhai || []) {
    if (!o.value) continue;
    const opt = document.createElement('option'); opt.value = o.value; opt.textContent = o.label; $('toKhai').append(opt);
  }
  summarize();
  if (info.error) log(info.error, 'error');
  if (info.rows?.length) renderRows(info.rows); // không xoá danh sách panel đang giữ
  setBusy(!!info.busy);
}

// Mỗi nguồn chỉ có hồ sơ trong một khoảng ngày: TĐT nộp trước 01/07/2025, DVC từ 01/07/2025 đến nay.
const SPLIT = '2025-07-01';
const source = () => document.querySelector('input[name=source]:checked').value; // dvc | tdt
function limits(src = source()) {
  const today = iso(new Date());
  return src === 'tdt' ? { min: '2000-01-01', max: '2025-06-30' } : { min: SPLIT, max: today };
}

// Khoảng chọn nhanh (chip dưới "Nguồn tra cứu"), mỗi nguồn một bộ riêng.
// Khoảng được cắt theo giới hạn của nguồn; khoảng nằm ngoài hẳn hoặc trùng khoảng trước thì ẩn.
function presets(src = source()) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth(), q = Math.floor(m / 3);
  const r = (a, b) => [iso(a), iso(b)];
  const list = src === 'tdt'
    ? [
      { key: 'h1', label: '6 tháng đầu 2025', range: r(new Date(2025, 0, 1), new Date(2025, 5, 30)) },
      { key: 'q2', label: 'Quý 2/2025', range: r(new Date(2025, 3, 1), new Date(2025, 5, 30)) },
      { key: 'y2024', label: 'Năm 2024', range: r(new Date(2024, 0, 1), new Date(2024, 11, 31)) },
      { key: 'y2023', label: 'Năm 2023', range: r(new Date(2023, 0, 1), new Date(2023, 11, 31)) },
    ]
    : [
      { key: 'lastMonth', label: 'Tháng trước', range: r(new Date(y, m - 1, 1), new Date(y, m, 0)) },
      { key: 'lastQuarter', label: 'Quý trước', range: r(new Date(y, (q - 1) * 3, 1), new Date(y, q * 3, 0)) },
      { key: 'thisYear', label: `Năm ${y}`, range: r(new Date(y, 0, 1), now) },
      { key: 'last12', label: '12 tháng qua', range: r(new Date(y - 1, m, now.getDate() + 1), now) },
    ];
  const { min, max } = limits(src), seen = new Set();
  return list.map((p) => {
    const a = p.range[0] < min ? min : p.range[0], b = p.range[1] > max ? max : p.range[1];
    return { ...p, range: [a, b] };
  }).filter((p) => p.range[0] <= p.range[1] && !seen.has(p.range.join()) && seen.add(p.range.join()));
}
let activePreset = null;
const markPreset = (kind) => { activePreset = kind; renderPresets(); };
function preset(kind) {
  const p = presets().find((x) => x.key === kind);
  if (!p) return;
  [$('from').value, $('to').value] = p.range;
  markPreset(kind);
  checkRange();
  picker?.refresh(true);
}
function renderPresets() {
  $('presets').replaceChildren(...presets().map((p) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip' + (p.key === activePreset ? ' active' : ''); b.textContent = p.label;
    b.title = `${toVN(p.range[0])} – ${toVN(p.range[1])}`;
    b.setAttribute('aria-pressed', String(p.key === activePreset));
    b.addEventListener('click', () => { preset(p.key); picker?.close(); });
    return b;
  }));
}
// Đổi nguồn → bộ chip + giới hạn ngày mới, chọn sẵn khoảng mặc định của nguồn đó.
const defaultPreset = () => (source() === 'dvc' ? 'last12' : 'h1');
$('source').addEventListener('change', () => { picker?.close(); preset(defaultPreset()); });
// Chặn bấm liên tiếp/double click: bỏ qua cú bấm khi thao tác trước của nút chưa xong.
function guard(btn, fn) {
  btn.addEventListener('click', async (e) => {
    if (btn.dataset.running) return;
    btn.dataset.running = '1';
    try { await fn(e); } finally { delete btn.dataset.running; }
  });
}
guard($('reconnect'), async () => {
  const b = $('reconnect');
  b.classList.add('spin');
  $('session').className = 'badge'; $('session').textContent = 'Đang kết nối…';
  try { await init(); } catch (e) { setConnected(false); log(e.message, 'error'); }
  b.classList.remove('spin');
});
$('from').addEventListener('input', () => { markPreset(null); checkRange(); });
$('from').addEventListener('change', () => { clampTo(); checkRange(); }); // change = đã chọn/gõ xong ngày
$('to').addEventListener('input', () => { markPreset(null); checkRange(); });

// Giới hạn 12 tháng cho cả 2 nguồn: Đến ngày ≤ Từ ngày + 12 tháng − 1 ngày.
const MAX_MONTHS = 12;
// Ngày yyyy-mm-dd hợp lệ và đã gõ đủ năm (khi đang gõ, ô date cho ra năm như "0002")
const fullDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && +v.slice(0, 4) >= 2000;
// Ngày kết thúc lớn nhất: Từ ngày + 12 tháng − 1 ngày, không vượt giới hạn của nguồn.
function maxTo(from) {
  const [y, m, d] = from.split('-').map(Number);
  const dt = new Date(2000, 0, 1);
  dt.setFullYear(y, m - 1 + MAX_MONTHS, d - 1); // setFullYear: tránh JS hiểu năm < 100 thành 19xx
  const { max } = limits();
  return iso(dt) > max ? max : iso(dt);
}
function rangeError() {
  const from = $('from').value, to = $('to').value;
  if (!fullDate(from) || !fullDate(to)) return 'Hãy chọn Từ ngày và Đến ngày';
  const { min, max } = limits(), src = source() === 'tdt' ? 'Thuế điện tử' : 'Dịch vụ công';
  if (from < min) return `${src}: chỉ tra cứu từ ${toVN(min)}`;
  if (to > max) return `${src}: chỉ tra cứu đến ${toVN(max)}`;
  if (from > to) return 'Từ ngày không được sau Đến ngày';
  if (to > maxTo(from)) return `Khoảng ngày tối đa ${MAX_MONTHS} tháng`;
  return null;
}
function checkRange() {
  const from = $('from').value;
  if (fullDate(from)) { $('to').min = from; $('to').max = maxTo(from); }
  else { $('to').removeAttribute('min'); $('to').removeAttribute('max'); }
  const err = rangeError();
  // khoảng của nguồn đã ghi trên thẻ chọn nguồn
  $('rangeHint').textContent = err || `*Tối đa ${MAX_MONTHS} tháng mỗi lần · có thể nhập hoặc chọn ngày`;
  $('rangeHint').classList.toggle('error', !!err);
  $('toText').classList.toggle('invalid', !!err);
  summarize();
  return !err;
}
// Đổi Từ ngày làm Đến ngày ra ngoài khoảng cho phép → tự kéo Đến ngày về (tối đa hôm nay)
function clampTo() {
  const from = $('from').value, to = $('to').value;
  if (!fullDate(from)) return;
  const max = maxTo(from), today = iso(new Date());
  if (!fullDate(to) || to < from || to > max) { $('to').value = today >= from && today <= max ? today : max; picker?.refresh(); }
}
// Tự kết nối lại khi người dùng đăng nhập / chuyển tới trang tra cứu sau khi đã mở panel
chrome.tabs.onRemoved.addListener((id) => { if (id === tabId) { tabId = null; setConnected(false); } });
let recheckTimer = null;
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  // Rời khỏi dichvucong thì báo chưa kết nối
  if (id === tabId && change.url && !isPortal(change.url)) { tabId = null; setConnected(false); }
  if (change.status !== 'complete' || !isPortal(tab.url)) return;
  clearTimeout(recheckTimer);
  recheckTimer = setTimeout(() => (connected && id === tabId ? recheck() : init()).catch((e) => log(e.message, 'error')), 500);
});

// Đang kết nối mà người dùng chuyển trang trên web: chỉ kiểm tra còn đăng nhập không.
// Không lấy captcha mới (sẽ làm mã đang gõ mất hiệu lực), không vẽ lại danh sách.
async function recheck() {
  const r = await ask({ type: 'status' }).catch(() => null);
  // Đăng nhập sang công ty khác → kết nối lại từ đầu (danh sách cũ không còn dùng được)
  if (r?.ready && r.company && r.company !== $('company').textContent) {
    renderRows([]); lastSearch = null;
    return init();
  }
  if (r?.ready) return;
  setConnected(false);
}
$('run').addEventListener('click', search);
$('stop').addEventListener('click', () => { stopped = true; if (tabId) ask({ type: 'stop' }); });
// "Tải tất cả" theo lựa chọn File cần tải; nút trong từng cột chỉ tải đúng loại của cột đó.
const selectedKinds = () => [...document.querySelectorAll('input[name=kinds]:checked')].map((i) => i.value);
// Bảng kết quả chỉ hiện cột tải của loại file đang chọn (CSS dựa vào data-kinds); bỏ chọn hết thì hiện cả 2 cột.
// Tô ô đang chọn bằng class (không dùng :has() – side panel có bản Chrome không vẽ lại sau cú bấm đầu)
function showKinds() {
  $('results').dataset.kinds = (selectedKinds().join(',') || 'hoso,thongbao');
  document.querySelectorAll('input[name=kinds]').forEach((i) => i.closest('.tile').classList.toggle('on', i.checked));
  summarize();
}
document.querySelectorAll('input[name=kinds]').forEach((r) => r.addEventListener('change', showKinds));
$('clearKinds').addEventListener('click', () => {
  document.querySelectorAll('input[name=kinds]').forEach((i) => { i.checked = false; });
  showKinds();
});
$('toKhai').addEventListener('change', () => summarize());
$('dlAll').addEventListener('click', () => {
  if (!selectedKinds().length) return log('Hãy chọn ít nhất 1 loại file cần tải', 'warn');
  const ids = shownIds();
  if (!ids.length) return log('Không có hồ sơ nào ở trạng thái đang chọn', 'warn');
  download(ids, selectedKinds(), true);
});
$('stop').addEventListener('dblclick', (e) => e.preventDefault());
$('rows').addEventListener('click', (e) => { const b = e.target.closest('button.get'); if (b) download([b.dataset.id], [b.dataset.kind]); });

// Một port dùng chung cho cả tìm và tải; content script giữ kết quả lần tìm gần nhất.
let port = null;
function job(msg) {
  if (!port) {
    port = chrome.tabs.connect(tabId, { name: 'job' });
    port.onDisconnect.addListener(() => {
      port = null;
      // Trang web chuyển trang/tải lại giữa chừng → job trong content script bị huỷ
      if (busy) {
        log('Bị gián đoạn vì trang web vừa chuyển trang – bấm tải lại các hồ sơ chưa xong', 'warn');
        document.querySelectorAll('#rows .st.loading').forEach((st) => { st.className = 'st error'; st.textContent = 'Bị gián đoạn'; });
        setBusy(false);
      }
    });
    port.onMessage.addListener(onJobMessage);
  }
  setBusy(true);
  port.postMessage(msg);
}

function onJobMessage(m) {
  if (m.type === 'status') $('status').textContent = m.text;
  if (m.type === 'rows') { lastSearch = pendingSearch; renderRows(m.rows); }
  if (m.type === 'rowStatus') setRowStatus(m.id, m.kind, m.state, m.text);
  if (m.type === 'progress') { $('bar').max = m.total || 1; $('bar').value = m.done; $('status').textContent = `Đã tải ${m.done}/${m.total} hồ sơ`; }
  if (m.type === 'log') log(m.text, m.level);
  if (m.type === 'error') { log(m.text, 'error'); $('status').textContent = 'Lỗi – thử lại'; }
  if (m.type === 'done') {
    $('status').textContent = 'Hoàn tất. File nằm trong Downloads/HoSoThue/';
    if (downloadAll && !stopped) showDone();
    downloadAll = false;
  }
  if (m.type === 'idle') setBusy(false);
}

function showDone() {
  const errors = document.querySelectorAll('#rows .st.error').length;
  $('doneText').textContent = `Đã tải ${$('bar').max} hồ sơ vào thư mục Downloads/HoSoThue/`
    + (errors ? ` (${errors} file lỗi – xem bảng kết quả).` : '.');
  $('doneModal').showModal();
}

// Tóm tắt lựa chọn ở footer
const KIND_LABELS = { hoso: 'Hồ sơ khai thuế', thongbao: 'Thông báo' };
function summarize() {
  const from = $('from').value, to = $('to').value, src = source() === 'tdt' ? 'Thuế điện tử' : 'Dịch vụ công';
  $('sumRange').textContent = fullDate(from) && fullDate(to) ? `${toVN(from)} – ${toVN(to)} · ${src}` : '—';
  const tk = $('toKhai');
  $('sumToKhai').textContent = tk.value ? tk.selectedOptions[0]?.textContent || tk.value : 'Tất cả';
  $('sumToKhai').title = $('sumToKhai').textContent;
  $('sumKinds').textContent = selectedKinds().map((k) => KIND_LABELS[k]).join(' + ') || '—';
  $('sumStatus').textContent = [...document.querySelectorAll('input[name=status]:checked')].map((i) => i.nextElementSibling.textContent).join(' + ') || '—';
}

// Chưa đăng nhập hoặc đang chạy → khóa nút Tìm kiếm
function syncRun() {
  $('run').disabled = busy || !connected;
  $('run').title = connected ? '' : 'Hãy đăng nhập dichvucong trước';
}

function setBusy(on) {
  busy = on;
  document.body.classList.toggle('busy', on);
  $('stop').hidden = !on;
  syncRun();
  $('run').textContent = on ? 'Đang xử lý…' : 'Tìm kiếm';
  $('dlAll').disabled = on;
  document.querySelectorAll('button.get').forEach((b) => { b.disabled = on; });
}

async function search() {
  if (busy) return; // đang tìm/tải: bỏ qua bấm lặp
  if (!tabId || !connected) return init();
  if (!checkRange()) { $('toText').focus(); return; }
  $('log').innerHTML = ''; $('bar').value = 0; $('status').textContent = '';
  pendingSearch = { source: source(), tuNgay: toVN($('from').value), denNgay: toVN($('to').value), maToKhai: $('toKhai').value, captcha: '' };
  job({ type: 'search', ...pendingSearch });
}

async function download(ids, kinds, all = false) {
  if (busy) return;
  if (!tabId) return init();
  $('bar').value = 0;
  downloadAll = all; stopped = false;
  job({ type: 'download', ids, kinds, rows: panelRows, search: lastSearch });
}

function renderRows(rows) {
  panelRows = rows;
  $('results').hidden = !rows.length;
  $('count').textContent = rows.length;
  $('rows').replaceChildren(...rows.map((r) => {
    const tr = document.createElement('tr'); tr.dataset.id = r.maHoSo;
    const td = (text, cls = '') => { const c = document.createElement('td'); c.textContent = text || ''; c.className = cls; return c; };
    // Mỗi loại file một cột riêng, có nút tải + trạng thái của riêng nó
    const act = (kind, label) => {
      const c = document.createElement('td'); c.className = `act ${kind}`; c.dataset.kind = kind; c.dataset.label = label;
      const b = document.createElement('button'); b.className = 'get'; b.dataset.id = r.maHoSo; b.dataset.kind = kind;
      b.textContent = 'Tải xuống'; b.title = `Tải ${label.toLowerCase()} ${r.maHoSo}`; b.disabled = busy;
      const st = document.createElement('span'); st.className = 'st';
      c.append(b, st);
      return c;
    };
    const meta = td([r.kyTinhThue && `Kỳ ${r.kyTinhThue}`, r.ngayNop, r.trangThai].filter(Boolean).join(' · '), 'meta');
    tr.append(td(r.maHoSo, 'id'), td(r.toKhai, 'tk'), td(r.kyTinhThue, 'nowrap col'), td(r.ngayNop, 'col'), td(r.trangThai, 'col'),
      act('hoso', 'Hồ sơ khai thuế'), act('thongbao', 'Thông báo'), meta);
    return tr;
  }));
  applyStatus();
}

// Trạng thái hồ sơ: kết quả lẫn hồ sơ được và không được chấp nhận ("Không chấp nhận việc nộp HSKT điện tử").
// Cổng không lọc được theo trạng thái → lọc ở panel; mặc định chỉ chọn "Được chấp nhận".
// Đổi lựa chọn sau khi tìm thì lọc lại ngay; "Tải tất cả" chỉ tải hồ sơ đang hiện.
const statusOf = (s) => (/không chấp nhận|từ chối/i.test(s || '') ? 'rejected' : 'ok');
function applyStatus() {
  const on = new Set([...document.querySelectorAll('input[name=status]:checked')].map((i) => i.value));
  document.querySelectorAll('#rows tr').forEach((tr, i) => { tr.hidden = !on.has(statusOf(panelRows[i]?.trangThai)); });
  const shown = shownIds().length;
  $('count').textContent = shown === panelRows.length ? shown : `${shown}/${panelRows.length}`;
  $('count').title = shown === panelRows.length ? '' : `${panelRows.length - shown} hồ sơ bị ẩn theo lựa chọn Trạng thái hồ sơ`;
  summarize();
}
const shownIds = () => [...document.querySelectorAll('#rows tr:not([hidden])')].map((tr) => tr.dataset.id);
document.querySelectorAll('input[name=status]').forEach((i) => i.addEventListener('change', applyStatus));

function setRowStatus(id, kind, state, text) {
  const st = document.querySelector(`#rows tr[data-id="${CSS.escape(id)}"] td[data-kind="${kind}"] .st`);
  if (!st) return;
  st.className = `st ${state}`;
  st.textContent = state === 'loading' ? 'Đang tải…' : state === 'ok' ? `✓ ${text}` : text || '';
  st.title = text || '';
}

const picker = createRangePicker({
  from: $('from'), to: $('to'), fromText: $('fromText'), toText: $('toText'), anchor: $('dateRange'), maxTo,
  limits: () => limits(),
});
// Loại tờ khai: ô tìm kiếm thay cho dropdown dài (select #toKhai vẫn giữ giá trị)
createCombobox($('toKhai'), { placeholder: 'Tất cả loại tờ khai · gõ để tìm, vd. GTGT, TNDN' });
showKinds();
applyStatus();
preset(defaultPreset());

init().catch((e) => log(e.message, 'error'));
