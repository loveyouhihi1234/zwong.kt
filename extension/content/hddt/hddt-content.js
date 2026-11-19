// Nhận lệnh từ side panel và chạy trong tab hoadondientu đã đăng nhập.
// 1 lần bấm "Tải dữ liệu": tra cứu từng tháng → (nếu cần) tải chi tiết từng hóa đơn → zip XML/HTML/PDF từng tháng
// → Excel bảng kê. Mọi xử lý trong bộ nhớ của tab, file ghi thẳng vào Downloads.
// NÂNG CẤP:
// - Chống skip hóa đơn: Khi gặp timeout/lỗi mạng tạm thời, không bỏ qua hóa đơn (không tăng errors++ rồi next),
//   mà kiên trì thử lại đến khi hoàn tất 100% dữ liệu.
// - Ngắt an toàn tức thì: Cho phép người dùng bấm "Dừng" bất kỳ lúc nào để dừng lại và lưu ngay dữ liệu đã tải.
// - Tối ưu danh sách: Hỗ trợ tùy chọn bỏ qua chi tiết sản phẩm (formats.lines = false) để tiết kiệm RAM và siêu tốc độ.
// - Đặt tên file thông minh: Tự động gắn MST phía trước và phân biệt rõ BangKeChiTiet vs BangKe theo lựa chọn.
// - Kiểm soát kích thước file Excel: File <= 40MB tự động lưu ngầm vào thư mục HoaDon/...; File > 40MB giữ an toàn
//   trong bộ nhớ tab và mở nút bấm tải trực tiếp bằng tay trên Side Panel để chống sập giới hạn 64MB của Chrome.
(() => {
let stopFlag = false;
let busy = false;
let pendingBigExcel = null; // Lưu tạm file Excel dung lượng lớn chờ người dùng bấm tải thủ công

const MAX_BG_BYTES = 40 * 1024 * 1024; // 40 MB: Ngưỡng an toàn tối đa cho kênh truyền tin nhắn Chrome (trần cứng là 64MB)
const safeName = (s) => (s || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 120);
const waitText = ({ secs, attempt, max, rate, retrying }) => (rate
  ? `cổng thuế báo gửi quá nhiều yêu cầu (429), tự thử lại sau ${secs} giây (lần ${attempt}/${max})`
  : retrying
    ? `mạng chậm hoặc cổng quá tải, đang kiên trì thử lại sau ${secs} giây (lần ${attempt}/${max})`
    : `cổng thuế chưa trả lời, đã chờ ${secs} giây${max > 1 ? ` (lần ${attempt}/${max})` : ''}`);
const isoOf = (vn) => vn.split('/').reverse().join('-'); // dd/mm/yyyy → yyyy-mm-dd
const DOWNLOAD_ROOT = 'HoaDon'; // Downloads/HoaDon/<MST – Tên công ty>/<từ ngày>_<đến ngày>/
const ZIP_PART_BYTES = 40 * 1024 * 1024; // ~40 MB/zip: data URL base64 còn ~55 MB, dưới giới hạn 64 MB của tin nhắn Chrome

function toDataUrl(bytes, mime) {
  return new Promise((ok, fail) => {
    const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail;
    r.readAsDataURL(new Blob([bytes], { type: mime }));
  });
}

// Lưu file thông qua service_worker (áp dụng cho file <= 40MB)
async function save(bytes, mime, filename) {
  const r = await chrome.runtime.sendMessage({ type: 'TAXCAP_DOWNLOAD_FILE', url: await toDataUrl(bytes, mime), filename });
  if (r?.error) throw new Error(r.error);
}

// Kích hoạt tải trực tiếp file lớn (> 40MB) bằng Blob URL ngay trên tab, không bị giới hạn 64MB của Chrome
function downloadPendingBigExcel() {
  if (!pendingBigExcel) return false;
  const blob = new Blob([pendingBigExcel.bytes], { type: pendingBigExcel.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = pendingBigExcel.name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 60000); // Thu hồi URL sau 1 phút
  return true;
}

async function runJob({ tuNgay, denNgay, kinds, forms, filters, formats, adjOnly, sheets = {} }, send) {
  const lic = await chrome.runtime.sendMessage({ type: 'TAXCAP_CHECK_LICENSE' }).catch(() => ({ ok: false }));
  if (!lic?.ok) throw new Error(lic?.message || 'Chưa kích hoạt mã bản quyền — hãy mở TaxCap Suite để kích hoạt.');
  stopFlag = false;
  pendingBigExcel = null; // Xóa cache file cũ khi bắt đầu lượt tải mới
  const shouldStop = () => stopFlag;
  const profile = await HDDT.getSessionInfo();
  if (!profile.ready) throw new Error('Chưa đăng nhập hoadondientu – hãy đăng nhập rồi bấm ↻');
  const dir = `${DOWNLOAD_ROOT}/${safeName([profile.mst, profile.company].filter(Boolean).join(' – ')) || 'CongTy'}/${isoOf(tuNgay)}_${isoOf(denNgay)}`;

  // 1. Tra cứu danh sách hóa đơn
  // Hóa đơn điện tử tra theo tháng, máy tính tiền theo đoạn 10 ngày (mỗi đoạn 1 captcha)
  const parts = forms.map((f) => `${HDDT.splitFor(f, tuNgay, denNgay).length} ${HDDT.FORMS[f].days ? `đoạn ${HDDT.FORMS[f].days} ngày` : 'tháng'}`);
  send({ type: 'status', text: `Đang tra cứu ${parts.join(' + ')}…` });
  const res = await HDDT.search({ tuNgay, denNgay, kinds, forms, filters, shouldStop,
    onProgress: (p) => send({ type: 'status', text: `${p.label}: đã đọc ${p.count} hóa đơn` }),
    onWarn: (text) => send({ type: 'log', level: 'warn', text }),
    // Cổng chậm: đếm giây ngay trên dòng trạng thái để người dùng biết vẫn đang chờ, không phải treo
    onWait: (w) => send({ type: 'status', text: `${w.label}: ${waitText(w)}${w.slow && !w.rate ? ' (tra máy tính tiền thường chậm, chờ tối đa 90 giây)' : ''}` }) });
  let rows = res.rows;
  // Chỉ HĐ thay thế / điều chỉnh / hủy: lọc theo tthai ngay sau tra cứu, trước khi tải chi tiết (tthai 1 = hóa đơn mới)
  if (adjOnly) {
    rows = rows.filter((r) => r.tthai && Number(r.tthai) !== 1);
    send({ type: 'log', level: 'ok', text: `Chỉ lấy hóa đơn thay thế/điều chỉnh/hủy: ${rows.length}/${res.rows.length} hóa đơn` });
  }
  const count = (k, f) => rows.filter((r) => r.kind === k && (!f || r.form === f)).length;
  // Mỗi loại 1 phần; chọn cả 2 hình thức thì tách thêm điện tử / máy tính tiền
  const byForm = (k) => (forms.length > 1 ? ` (${forms.map((f) => `${f === 'mtt' ? 'máy tính tiền' : 'điện tử'} ${count(k, f)}`).join(', ')})` : '');
  const found = kinds.map((k) => `${HDDT.KINDS[k].act} ${count(k)}${byForm(k)}`).join('; ');
  send({ type: 'log', level: 'ok', text: `Tìm thấy ${rows.length} hóa đơn: ${found}` });
  send({ type: 'summary', total: rows.length, purchase: count('purchase'), sold: count('sold') });
  if (!rows.length) return send({ type: 'done', total: 0, saved: 0, errors: 0, stopped: res.stopped });

  // 2. Chi tiết từng hóa đơn, gom zip theo loại + tháng.
  // Hóa đơn không mã (ttxly 6): cổng không lưu XML gốc → chỉ gọi API chi tiết khi cần dòng hàng hóa cho Excel.
  // PDF: bản thể hiện tự dựng trên máy từ XML (HĐ không mã: JSON chi tiết), không phải PDF gốc của nhà cung cấp
  const needDetail = formats.xml || formats.html || formats.pdf || formats.lines;
  const details = new Map();
  let errors = 0, saved = 0, done = 0;

  if (!needDetail) {
    send({ type: 'log', level: 'ok', text: 'Chế độ chỉ tải danh sách: bỏ qua bước tải chi tiết từng hóa đơn, tiết kiệm bộ nhớ và hoàn tất tức thì.' });
  }

  if (needDetail && !res.stopped) {
    const order = rows.filter((r) => formats.lines || formats.pdf || r.ttxly !== 6)
      .sort((a, b) => `${a.kind}|${a.month}|${a.form}`.localeCompare(`${b.kind}|${b.month}|${b.form}`));
    let bucket = null, files = [], bytes = 0, part = 1;
    const flush = async (last) => {
      if (!bucket || !files.length) return;
      const [kind, month] = bucket.split('|');
      // Zip quá lớn (gói HTML ~300 KB/hóa đơn) → tách phần để không vượt giới hạn truyền dữ liệu của Chrome
      const suffix = part > 1 || !last ? `_phan${part}` : '';
      await save(Zip.writeZip(files), 'application/zip', `${dir}/${HDDT.KINDS[kind].folder}_${month}${suffix}.zip`);
      saved++; files = []; bytes = 0; part++;
    };
    const add = (name, data) => { files.push({ name, data }); bytes += data.length; };

    for (const row of order) {
      if (stopFlag) break;
      const b = `${row.kind}|${row.month}`;
      if (b !== bucket) { await flush(true); bucket = b; part = 1; }
      if (bytes > ZIP_PART_BYTES) await flush(false);
      // Bán cho khách lẻ thường không có MST người mua → "KhachLe"
      const base = safeName(`${(row.kind === 'purchase' ? row.nbmst : row.nmmst) || 'KhachLe'}_${row.khmshdon}${row.khhdon}_${row.shdon}`);
      const sub = HDDT.FORMS[row.form].ep === 'sco-query' ? 'MayTinhTien/' : '';

      // Tải chi tiết: kiên trì thử lại (patient retry), KHÔNG TỰ Ý BỎ QUA khi timeout/lỗi mạng
      let inv = null;
      while (!stopFlag) {
        try {
          inv = await HDDT.fetchInvoice(row, shouldStop,
            (w) => send({ type: 'status', text: `Đang tải chi tiết ${done + 1}/${order.length}: ${waitText(w)}` }));
          break; // Tải thành công hoặc đã dừng
        } catch (e) {
          if (e.status === 401) throw e;
          if (stopFlag || e.message === 'Đã dừng theo yêu cầu') break;
          // Lỗi cố định (vd 4xx không thể phục hồi): ghi nhận lỗi và tiếp tục
          const isPermanent = e.status && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
          if (isPermanent) {
            errors++;
            const mst = row.kind === 'purchase' ? row.nbmst : row.nmmst;
            send({ type: 'log', level: 'error', text: `Không tải được hóa đơn ${row.khhdon}-${row.shdon} (${mst ? `MST ${mst}` : 'khách lẻ'}): ${e.message}` });
            break;
          }
          // Lỗi mạng hoặc lỗi 500 tạm thời: thông báo và tự động thử lại sau 3s, không bỏ qua
          send({ type: 'log', level: 'warn', text: `${row.khhdon}-${row.shdon}: ${e.message} – đang kiên nhẫn thử lại sau 3s (bấm Dừng nếu muốn kết thúc và lưu)…` });
          await HDDT.sleep(3000);
        }
      }

      // Người dùng bấm Dừng hoặc không lấy được chi tiết do lỗi cố định
      if (stopFlag) break;
      if (!inv) {
        send({ type: 'progress', done: ++done, total: order.length });
        continue;
      }

      // head (chữ ký số, ngày ký, địa chỉ, hình thức thanh toán…) dùng cho DS hóa đơn + Kiểm tra rủi ro HĐ; dòng hàng chỉ giữ khi cần
      details.set(row.key, { source: inv.source, head: inv.head, ...(formats.lines ? { lines: inv.lines, fees: inv.fees } : {}) });
      if (inv.source === 'xml') {
        // Nguyên bytes gốc của cổng (không giải mã/mã hóa lại) để mở được bằng phần mềm của Cục Thuế
        if (formats.xml) add(`XML/${sub}${base}.xml`, inv.xml);
        // HTML: đủ bộ file trong zip của cổng (invoice.html cần details.js + ảnh nền/ảnh chữ ký cùng thư mục)
        if (formats.html) for (const [n, data] of Object.entries(inv.files)) if (!/\.xml$/i.test(n)) add(`HTML/${sub}${base}/${n}`, data);
      } else if (row.ttxly !== 6 && (formats.xml || formats.html)) {
        send({ type: 'log', level: 'warn', text: `${row.khhdon}-${row.shdon}: cổng không trả được XML gốc (chỉ có trong Excel${formats.pdf ? ', PDF' : ''})` });
      }
      if (formats.pdf) {
        try { add(`PDF/${sub}${base}.pdf`, await Pdf.buildInvoicePdf(row, inv, HDDT.originalLookup(row, inv.head))); } catch (e) {
          send({ type: 'log', level: 'warn', text: `${row.khhdon}-${row.shdon}: không dựng được PDF (${e.message})` });
        }
      }

      send({ type: 'progress', done: ++done, total: order.length });
      await HDDT.sleep(HDDT.DELAY);
    }
    await flush(true);
    const khongMa = rows.filter((r) => r.ttxly === 6).length;
    if (khongMa && (formats.xml || formats.html)) send({ type: 'log', text: `${khongMa} hóa đơn không mã (ký hiệu bắt đầu bằng K): cổng thuế không lưu file XML/HTML gốc nên chỉ có trong Excel – bình thường, không phải lỗi` });
  }

  // 3. Sheet HĐ thay thế / điều chỉnh: cần dòng hàng của cả 2 hóa đơn → tải thêm HĐ thay thế/điều chỉnh chưa có chi tiết
  // và hóa đơn gốc (kể cả gốc nằm ngoài khoảng ngày). Thường chỉ vài hóa đơn nên tải luôn, tuần tự như bước 2.
  const originals = new Map();
  if (formats.excel && sheets.adjust && !stopFlag && !res.stopped) {
    const adj = rows.filter((r) => Report.isAdjusting(r));
    const byRef = new Map(rows.map((r) => [Report.refKey(r), r]));
    const todo = [];
    for (const r of adj) {
      if (!details.get(r.key)?.lines) todo.push({ row: r, get: () => HDDT.fetchInvoice(r, shouldStop), put: (inv) => details.set(r.key, { source: inv.source, head: inv.head, lines: inv.lines, fees: inv.fees }) });
      const k = Report.refKey(r.gocRef), inRange = byRef.get(k);
      if (inRange ? details.get(inRange.key)?.lines || todo.some((t) => t.row === inRange) : originals.has(k)) continue;
      if (inRange) todo.push({ row: inRange, get: () => HDDT.fetchInvoice(inRange, shouldStop), put: (inv) => details.set(inRange.key, { source: inv.source, head: inv.head, lines: inv.lines, fees: inv.fees }) });
      else { originals.set(k, null); todo.push({ row: r, gocOf: true, get: () => HDDT.fetchOriginal(r, shouldStop), put: (inv) => originals.set(k, inv) }); }
    }
    let i = 0;
    for (const t of todo) {
      if (stopFlag) break;
      send({ type: 'status', text: `Đang tải hóa đơn gốc để so sánh HĐ thay thế/điều chỉnh ${++i}/${todo.length}` });
      try {
        const inv = await t.get();
        if (inv) t.put(inv);
      } catch (e) {
        if (e.status === 401) throw e;
        if (stopFlag || e.message === 'Đã dừng theo yêu cầu') break;
        const ref = t.gocOf ? t.row.goc : `${t.row.khhdon}-${t.row.shdon}`;
        send({ type: 'log', level: 'warn', text: `Không tải được hóa đơn ${t.gocOf ? 'gốc ' : ''}${ref}: ${e.message}` });
      }
      await HDDT.sleep(HDDT.DELAY);
    }
  }

  // 3b. Sheet Kiểm tra rủi ro MST: đối chiếu MST người bán (mua vào) / người mua (bán ra) với danh sách công khai sử dụng hóa đơn
  // không hợp pháp của cổng (cache trên máy, tra gộp nhiều MST / request). Lỗi → chỉ cảnh báo, Excel vẫn lưu.
  let illegal = null;
  if (formats.excel && sheets.seller && !stopFlag && !res.stopped) {
    const msts = rows.map((r) => (r.kind === 'purchase' ? r.nbmst : r.nmmst)).filter(Boolean);
    try {
      illegal = await HDDT.illegalCheck(msts, { shouldStop, onStatus: (text) => send({ type: 'status', text }) });
      const hits = Object.values(illegal).filter((e) => e.recs.length).length;
      send({ type: 'log', level: hits ? '' : 'ok', text: hits ? `${hits} người bán/người mua có tên trong danh sách sử dụng hóa đơn không hợp pháp của Cục Thuế – xem cột "Kiểm tra rủi ro MST" trong Excel` : 'Không người bán/người mua nào có tên trong danh sách sử dụng hóa đơn không hợp pháp của Cục Thuế' });
    } catch (e) {
      if (e.status === 401) throw e;
      if (!stopFlag) send({ type: 'log', level: 'warn', text: `Không đối chiếu được danh sách công khai hóa đơn không hợp pháp: ${e.message}` });
    }
  }

  // 4. Excel bảng kê (kể cả khi đã bấm Dừng: lưu với dữ liệu đã có)
  if (formats.excel) {
    // Đặt tên file thông minh: [MST]_[BangKe / BangKeChiTiet]_[Loại HĐ]_[Từ ngày]_[Đến ngày].xlsx
    const typeName = formats.lines ? 'BangKeChiTiet' : 'BangKe';
    const prefixMst = profile.mst ? `${safeName(profile.mst)}_` : '';
    const baseFileName = `${prefixMst}${typeName}_${kinds.map((k) => HDDT.KINDS[k].folder).join('-')}_${isoOf(tuNgay)}_${isoOf(denNgay)}.xlsx`;
    const name = `${dir}/${baseFileName}`;
    const book = Report.buildSheets(rows, details, { withLines: formats.lines, withPdf: formats.pdf, sheets, originals, illegal, tuNgay, denNgay, mst: profile.mst, company: profile.company,
      kinds, adjOnly, skipped: res.skipped || [], stopped: stopFlag || res.stopped });

    const xlsxBytes = Xlsx.buildXlsx(book);
    const sizeMB = (xlsxBytes.length / (1024 * 1024)).toFixed(1);

    // KIỂM TRA DUNG LƯỢNG FILE EXCEL:
    // - File <= 40MB: Tự động tải ngầm qua background lưu đúng cây thư mục Downloads/HoaDon/...
    // - File > 40MB: Chống lỗi 64MB của Chrome, lưu tạm file vào bộ nhớ tab và gửi tín hiệu để Side Panel hiện nút bấm tải tay
    if (xlsxBytes.length <= MAX_BG_BYTES) {
      await save(xlsxBytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name);
      send({ type: 'log', level: 'ok', text: `Đã lưu file Excel bảng kê (${sizeMB} MB, ${book.length} sheet)` });
      saved++;
    } else {
      pendingBigExcel = {
        bytes: xlsxBytes,
        name: baseFileName,
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sizeMB,
        sheetCount: book.length
      };
      send({ type: 'log', level: 'warn', text: `File Excel có dung lượng lớn (${sizeMB} MB) vượt ngưỡng tự động lưu ngầm. Vui lòng bấm nút "Tải File Excel" trên giao diện để lưu file về máy.` });
      send({ type: 'big_excel_ready', name: baseFileName, sizeMB, sheetCount: book.length });
    }

    // 1 dòng: số sheet + tóm tắt rủi ro (chỉ nêu khi có cảnh báo / lưu ý)
    const risk = book.find((x) => x.summary)?.summary;
    const flags = risk ? [risk.bad && `${risk.bad} hóa đơn bị cảnh báo`, risk.warn && `${risk.warn} hóa đơn cần lưu ý`].filter(Boolean).join(', ') : '';
    if (flags) send({ type: 'log', text: `Có ${flags} – xem lý do trong sheet "Kiểm tra rủi ro HĐ"` });
    else if (risk) send({ type: 'log', level: 'ok', text: 'Kiểm tra rủi ro: tất cả hóa đơn hợp lệ' });
    for (const note of book.notes || []) send({ type: 'log', level: 'warn', text: note });
  }

  send({
    type: 'done',
    total: rows.length,
    saved,
    errors,
    stopped: stopFlag || res.stopped,
    dir,
    bigExcel: pendingBigExcel ? { name: pendingBigExcel.name, sizeMB: pendingBigExcel.sizeMB } : null
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'hddt-info' && msg?.type !== 'hddt-stop' && msg?.type !== 'hddt-download-big-excel') {
    return;
  }
  (async () => {
    switch (msg.type) {
      case 'hddt-info': return { ...await HDDT.getSessionInfo(), busy };
      case 'hddt-stop': stopFlag = true; return { ok: true };
      case 'hddt-download-big-excel': return { ok: downloadPendingBigExcel() };
    }
  })().then(reply, (e) => reply({ error: e.message }));
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'hddt-job') return;
  const send = (m) => { try { port.postMessage(m); } catch { /* panel đã đóng – job vẫn chạy tiếp */ } };
  port.onMessage.addListener(async (msg) => {
    // Lệnh yêu cầu tải file Excel dung lượng lớn từ Side Panel
    if (msg.type === 'hddt-download-big-excel' || msg.type === 'download_big_excel') {
      const ok = downloadPendingBigExcel();
      send({
        type: 'log',
        level: ok ? 'ok' : 'warn',
        text: ok ? `Đã kích hoạt tải file Excel: ${pendingBigExcel?.name} (${pendingBigExcel?.sizeMB} MB)` : 'Không tìm thấy file Excel nào đang chờ tải.'
      });
      return;
    }

    if (busy) return send({ type: 'log', level: 'warn', text: 'Đang có tác vụ chạy, hãy đợi hoặc bấm Dừng.' });
    busy = true;
    try {
      if (msg.type === 'run') await runJob(msg, send);
    } catch (e) {
      send({ type: 'error', text: e.message });
    } finally {
      busy = false;
      send({ type: 'idle' });
    }
  });
});
})();
