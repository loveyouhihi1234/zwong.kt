(() => {
// Nhận lệnh từ side panel / service worker và chạy trong tab dichvucong đã đăng nhập.
// Tên file/thư mục hợp lệ trên Windows/macOS (giữ tiếng Việt có dấu)
const safeName = (s) => (s || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 120);

let stopFlag = false;
let busy = false;
let lastRows = []; // kết quả lần tìm gần nhất – trang chi tiết chỉ mở được cho hồ sơ thuộc lần tìm này

async function ensureLicense() {
  const lic = await chrome.runtime.sendMessage({ type: 'TAXCAP_CHECK_LICENSE' }).catch(() => ({ ok: false }));
  if (!lic?.ok) throw new Error(lic?.message || 'Chưa kích hoạt mã bản quyền — hãy mở TaxCap Suite để kích hoạt.');
}

async function runSearch({ source, tuNgay, denNgay, maToKhai, captcha }, send) {
  await ensureLicense();
  stopFlag = false;
  send({ type: 'status', text: 'Đang tra cứu…' });
  const { rows, total, stopped } = await GDT.search({ source, tuNgay, denNgay, maToKhai, captcha,
    shouldStop: () => stopFlag,
    onProgress: (p) => send({ type: 'status', text: `Đọc trang ${p.page}/${p.pages} (${p.count}/${p.total} hồ sơ)` }) });
  lastRows = rows;
  send({ type: 'rows', rows, total });
  send({ type: 'status', text: stopped ? `Đã dừng – tìm thấy ${rows.length} hồ sơ` : `Tìm thấy ${rows.length} hồ sơ` });
}

const KINDS = ['hoso', 'thongbao'];
const KIND_LABEL = { hoso: 'HoSo', thongbao: 'ThongBao' };
const KIND_NONE = { hoso: 'Không có tờ khai', thongbao: 'Không có thông báo' };

// Tải tuần tự các hồ sơ có maHoSo trong `ids` (không truyền ids = tải hết), chỉ các loại file trong `kinds`.
// Đi theo thứ tự trang kết quả: máy chủ chỉ mở chi tiết cho hồ sơ trên trang đang hiển thị.
async function runDownload({ ids, kinds = KINDS, rows: panelRows, search }, send) {
  await ensureLicense();
  stopFlag = false;
  kinds = KINDS.filter((k) => kinds.includes(k));
  // Trang web đã chuyển trang (content script mới) → lấy lại danh sách + điều kiện tìm từ panel
  if (!lastRows.length && panelRows?.length) lastRows = panelRows;
  if (search) await GDT.restoreQuery(search);
  const rows = (ids ? lastRows.filter((r) => ids.includes(r.maHoSo)) : lastRows).slice().sort((a, b) => a.page - b.page);
  // Downloads/HoSoThue/<Tên công ty>/<ThueDienTu|DVC>/<mã>_<tên file gốc>
  const { company } = await GDT.getSessionInfo();
  const companyDir = safeName(company) || 'CongTy';
  let done = 0, synced = false;
  for (const row of rows) {
    if (stopFlag) { send({ type: 'status', text: 'Đã dừng.' }); break; }
    const status = (kind, state, text) => send({ type: 'rowStatus', id: row.maHoSo, kind, state, text });
    kinds.forEach((k) => status(k, 'loading'));
    try {
      if (!await GDT.gotoPage(row.page, !synced)) throw new Error(`Không chuyển được tới trang kết quả ${row.page}`);
      synced = true;
      const det = await GDT.fetchDetail(row);
      row.mst = det.mst;
      for (const kind of kinds) {
        if (stopFlag) { status(kind, 'warn', 'Đã dừng'); continue; }
        const files = det.files.filter((f) => f.kind === kind);
        if (!files.length) { status(kind, 'warn', KIND_NONE[kind]); continue; }
        try {
          let n = 0;
          for (const [i, f] of files.entries()) {
            if (stopFlag) break;
            const file = await GDT.downloadFile(f);
            const mime = /\//.test(file.fileType || '') ? file.fileType : 'application/octet-stream';
            // Cổng trả cùng tên "files_<mã>.zip" cho cả tờ khai lẫn thông báo → tự đặt tên theo
            // <mã giao dịch>_<HoSo|ThongBao>[_n].<đuôi gốc> để không ghi đè nhau
            const ext = (safeName(file.fileName).match(/\.[a-z0-9]{1,5}$/i) || [''])[0];
            const name = `${safeName(row.maGiaoDich)}_${KIND_LABEL[kind]}${files.length > 1 ? `_${i + 1}` : ''}${ext}`;
            const r = await chrome.runtime.sendMessage({ type: 'TAXCAP_DOWNLOAD_FILE', url: `data:${mime};base64,${file.content}`, filename: `${GDT.DOWNLOAD_ROOT}/${companyDir}/${GDT.folderOf(row.source)}/${name}` });
            if (r?.error) throw new Error(r.error);
            n++;
            await GDT.sleep(1200);
          }
          status(kind, n ? 'ok' : 'warn', n ? `${n} file` : 'Đã dừng');
        } catch (e) {
          status(kind, 'error', e.message);
          send({ type: 'log', level: 'error', text: `${row.maGiaoDich} (${kind === 'hoso' ? 'hồ sơ' : 'thông báo'}): ${e.message}` });
        }
      }
    } catch (e) {
      kinds.forEach((k) => status(k, 'error', e.message));
      send({ type: 'log', level: 'error', text: `${row.maGiaoDich}: ${e.message}` });
    }
    done++;
    send({ type: 'progress', done, total: rows.length });
    await GDT.sleep(800);
  }
  send({ type: 'done' });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'hoso-info' && msg?.type !== 'hoso-status' && msg?.type !== 'hoso-stop') {
    return;
  }
  (async () => {
    switch (msg.type) {
      case 'hoso-info': {
        // Đang chạy job thì không fetch lại trang tra cứu / captcha (tránh đổi trạng thái phiên giữa chừng)
        const info = await GDT.getSessionInfo({ refresh: !busy });
        return { ...info, rows: lastRows, busy };
      }
      case 'hoso-status': { const { ready, company } = await GDT.getSessionInfo({ refresh: !busy }); return { ready, company, busy }; }
      case 'hoso-stop': stopFlag = true; return { ok: true };
    }
  })().then(reply, (e) => reply({ error: e.message }));
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'hoso-job') return;
  const send = (m) => { try { port.postMessage(m); } catch { /* panel đã đóng – job vẫn chạy tiếp */ } };
  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'hoso-stop' || msg.type === 'stop') {
      stopFlag = true;
      return;
    }
    if (busy) return send({ type: 'log', level: 'warn', text: 'Đang có tác vụ chạy, hãy đợi hoặc bấm Dừng.' });
    busy = true;
    try {
      if (msg.type === 'search') await runSearch(msg, send);
      if (msg.type === 'download') await runDownload(msg, send);
    } catch (e) {
      send({ type: 'error', text: e.message });
    } finally {
      busy = false;
      send({ type: 'idle' });
    }
  });
});
})();
