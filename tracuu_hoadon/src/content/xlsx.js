// Ghi file .xlsx tối giản (nhiều sheet, dòng tiêu đề in đậm + cố định, số có dấu phân cách nghìn).
// sheets: [{ name, columns: [{ header, width, type: 'text'|'number'|'int'|'dec2', fills?: { 'giá trị': 'ok'|'warn'|'bad' } }], rows: [[...]], totalRow?: boolean, boldRows?: Set<chỉ số dòng> }]
// Sheet theo mẫu (vd bảng kê tải lên HTKK): { name, layout: true, widths: [...], rows: [[giá trị | { v, s } | { f, s }]],
//   rowProps?: Map<chỉ số dòng, { ht, hidden }>, merges?: ['B26:B28'], freeze?: 'A5' } – không có dòng tiêu đề tự động, không lọc.
//   { f: 'D9+F9-H9' } là công thức, Excel tự tính khi mở file (calcPr fullCalcOnLoad).
(() => {
  // Hàm escape ký tự đặc biệt trong XML để tránh lỗi cú pháp OpenXML
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); // Ký tự điều khiển làm hỏng XML

  // Chuyển chỉ số cột 0, 1, 2... thành tên cột Excel A, B, C... AA, AB...
  const colName = (i) => { let s = ''; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

  // Danh sách màu nền tô ô (chg vàng = khác, new xanh = thêm mới, out cam = ngoài khoảng ngày, gone đỏ = không còn)
  const FILLS = { chg: 'FFFFF2CC', new: 'FFE2EFDA', out: 'FFFCE4D6', gone: 'FFFFC7CE' };

  // Style cơ bản cho các ô:
  // 0: Thường | 1: Tiêu đề cột | 2: Số nguyên #,##0 | 3: Số lẻ #,##0.#### | 4: Chữ in đậm | 5: Số nguyên in đậm
  // 6 - 11: Dành cho sheet theo mẫu HTKK (cỡ chữ 8pt, viền mảnh)
  const xfs = [
    '<xf/>',
    '<xf fontId="1" fillId="2" applyFont="1" applyFill="1"/>',
    '<xf numFmtId="3" applyNumberFormat="1"/>',
    '<xf numFmtId="164" applyNumberFormat="1"/>',
    '<xf fontId="1" applyFont="1"/>',
    '<xf numFmtId="3" fontId="1" applyNumberFormat="1" applyFont="1"/>',
    '<xf fontId="3" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>',
    '<xf fontId="1" applyFont="1"/>',
    '<xf fontId="2" borderId="1" applyFont="1" applyBorder="1"/>',
    '<xf numFmtId="3" fontId="2" borderId="1" applyNumberFormat="1" applyFont="1" applyBorder="1"/>',
    '<xf fontId="2" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>',
    '<xf numFmtId="165" fontId="2" borderId="1" applyNumberFormat="1" applyFont="1" applyBorder="1"/>'
  ];

  const LAYOUT_STYLE = { head: 6, title: 7, text: 8, int: 9, stt: 10, dec: 11 };

  // Bổ sung style cho số thập phân 2 chữ số (#,##0.00) trong bảng dữ liệu thông thường
  // numFmtId 166: formatCode #,##0.00
  const DEC2_STYLE = xfs.length;
  xfs.push('<xf numFmtId="166" applyNumberFormat="1"/>');
  const DEC2_BOLD_STYLE = xfs.length;
  xfs.push('<xf numFmtId="166" fontId="1" applyNumberFormat="1" applyFont="1"/>');

  const fillIds = Object.fromEntries(Object.keys(FILLS).map((k, i) => [k, 4 + i]));
  const addXf = (name, xml) => { LAYOUT_STYLE[name] = xfs.length; xfs.push(xml); };

  // Tạo các biến thể ô theo màu nền cho sheet layout
  for (const [pre, fill] of [['', 0], ...Object.keys(FILLS).map((k) => [k, fillIds[k]])]) {
    const f = fill ? ` fillId="${fill}" applyFill="1"` : '';
    addXf(pre || 'cell', `<xf borderId="1"${f} applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>`);
    addXf(pre ? `${pre}Int` : 'cellInt', `<xf numFmtId="3" borderId="1"${f} applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>`);
    addXf(pre ? `${pre}Dec` : 'cellDec', `<xf numFmtId="164" borderId="1"${f} applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>`);
    addXf(pre ? `${pre}Dec2` : 'cellDec2', `<xf numFmtId="166" borderId="1"${f} applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>`);
  }

  addXf('hd', '<xf fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>');
  addXf('big', '<xf fontId="4" applyFont="1"/>');
  addXf('sum', '<xf numFmtId="3" fontId="1" borderId="1" applyNumberFormat="1" applyFont="1" applyBorder="1"/>');
  addXf('sumDec2', '<xf numFmtId="166" fontId="1" borderId="1" applyNumberFormat="1" applyFont="1" applyBorder="1"/>');
  addXf('sumText', '<xf fontId="1" borderId="1" applyFont="1" applyBorder="1"/>');
  addXf('note', '<xf fontId="5" applyFont="1"/>');

  // Cột có fills (vd Kết quả của sheet Kiểm tra rủi ro HĐ): ô chữ tô nền theo giá trị
  const CELL_FILL = { ok: 'new', warn: 'chg', bad: 'gone' };
  const FILL_STYLE = {};
  for (const [k, f] of Object.entries(CELL_FILL)) { FILL_STYLE[k] = xfs.length; xfs.push(`<xf fontId="1" fillId="${fillIds[f]}" applyFont="1" applyFill="1"/>`); }
  const LINK_STYLE = xfs.length;
  xfs.push('<xf fontId="6" applyFont="1"/>');

  // Định nghĩa Stylesheet OpenXML với 3 format số tùy chỉnh:
  // 164: #,##0.#### (tối đa 4 số lẻ)
  // 165: #,##0.0 (1 số lẻ)
  // 166: #,##0.00 (cố định 2 số lẻ cho Số lượng, Đơn giá chuẩn kế toán)
  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3">
  <numFmt numFmtId="164" formatCode="#,##0.####"/>
  <numFmt numFmtId="165" formatCode="#,##0.0"/>
  <numFmt numFmtId="166" formatCode="#,##0.00"/>
</numFmts>
<fonts count="7">
  <font><sz val="11"/><name val="Calibri"/></font>
  <font><b/><sz val="11"/><name val="Calibri"/></font>
  <font><sz val="8"/><name val="Calibri"/></font>
  <font><b/><sz val="8"/><name val="Calibri"/></font>
  <font><b/><sz val="13"/><name val="Calibri"/></font>
  <font><i/><sz val="10"/><color rgb="FF555555"/><name val="Calibri"/></font>
  <font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font>
</fonts>
<fills count="${4 + Object.keys(FILLS).length}">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFE6F0FA"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFCCFFCC"/></patternFill></fill>
  ${Object.values(FILLS).map((c) => `<fill><patternFill patternType="solid"><fgColor rgb="${c}"/></patternFill></fill>`).join('')}
</fills>
<borders count="2">
  <border/>
  <border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  // Hàm sinh thẻ XML ô tính cho sheet thông thường
  function cell(ref, v, type, bold, fill) {
    if (v === null || v === undefined || v === '') return '';
    // Ô chứa liên kết HYPERLINK
    if (typeof v === 'object' && v.link) return `<c r="${ref}" t="str" s="${LINK_STYLE}"><f>${esc(`HYPERLINK("${v.link.replace(/"/g, '""')}")`)}</f><v>${esc(v.link)}</v></c>`;
    if (fill) return `<c r="${ref}" t="inlineStr" s="${FILL_STYLE[fill]}"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;

    // Xử lý các định dạng số: nguyên (int), lẻ tự động (number), hoặc cố định 2 số thập phân (dec2)
    if ((type === 'number' || type === 'int' || type === 'dec2') && typeof v === 'number' && Number.isFinite(v)) {
      const s = bold
        ? (type === 'dec2' ? DEC2_BOLD_STYLE : 5)
        : (type === 'int' ? 2 : type === 'dec2' ? DEC2_STYLE : 3);
      return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"${bold ? ' s="4"' : ''}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  }

  // Tạo XML cho sheet bảng dữ liệu tự động (có thanh lọc, cố định dòng tiêu đề)
  function sheetXml({ columns, rows, totalRow, boldRows }) {
    const cols = columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join('');
    const head = `<row r="1">${columns.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="1"><is><t>${esc(c.header)}</t></is></c>`).join('')}</row>`;
    const body = rows.map((r, ri) => {
      const n = ri + 2, bold = (totalRow && ri === rows.length - 1) || !!boldRows?.has(ri);
      return `<row r="${n}">${r.map((v, ci) => cell(`${colName(ci)}${n}`, v, columns[ci]?.type, bold, columns[ci]?.fills?.[v])).join('')}</row>`;
    }).join('');
    const last = `${colName(columns.length - 1)}${Math.max(rows.length + 1, 1)}`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${head}${body}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
  }

  // Cố định các dòng phía trên ô freeze (vd 'A5' → dòng 1–4)
  const freezePane = (ref) => {
    const n = Number(/\d+$/.exec(ref || '')?.[0] || 1) - 1;
    return n > 0 ? `<pane ySplit="${n}" topLeftCell="A${n + 1}" activePane="bottomLeft" state="frozen"/>` : '';
  };

  // Tạo ô tính cho sheet layout (theo mẫu tùy chỉnh như HTKK)
  function layoutCell(ref, x) {
    const { v, s, f } = x !== null && typeof x === 'object' ? x : { v: x };
    const st = s ? ` s="${LAYOUT_STYLE[s]}"` : '';
    if (f) return `<c r="${ref}"${st}><f>${esc(f)}</f></c>`;
    if (v === null || v === undefined || v === '') return st ? `<c r="${ref}"${st}/>` : ''; // Ô trống vẫn giữ viền
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  }

  function layoutXml({ widths, rows, rowProps, merges, freeze }) {
    const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const body = rows.map((r, ri) => {
      const p = rowProps?.get(ri) || {};
      const attr = `${p.ht ? ` ht="${p.ht}" customHeight="1"` : ''}${p.hidden ? ' hidden="1"' : ''}`;
      return `<row r="${ri + 1}"${attr}>${(r || []).map((x, ci) => layoutCell(`${colName(ci)}${ri + 1}`, x)).join('')}</row>`;
    }).join('');
    const merged = merges?.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0">${freezePane(freeze)}</sheetView></sheetViews><cols>${cols}</cols><sheetData>${body}</sheetData>${merged}</worksheet>`;
  }

  // Tên sheet: tối đa 31 ký tự, không chứa ký tự cấm []:*?/\
  const sheetName = (s) => s.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31);

  // Vùng lọc của các sheet dạng bảng (Excel báo lỗi nếu <definedNames> rỗng)
  const filterNames = (sheets) => {
    const names = sheets.map((s, i) => s.layout ? '' : `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(sheetName(s.name))}'!$A$1:$${colName(s.columns.length - 1)}$${Math.max(s.rows.length + 1, 1)}</definedName>`).join('');
    return names ? `<definedNames>${names}</definedNames>` : '';
  };

  // Đóng gói toàn bộ các sheet thành cấu trúc file .xlsx (OpenXML chuẩn trong file ZIP)
  function buildXlsx(sheets) {
    const files = [
      { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
      { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(sheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${filterNames(sheets)}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { name: 'xl/styles.xml', data: STYLES },
      ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.layout ? layoutXml(s) : sheetXml(s) })),
    ];
    return Zip.writeZip(files);
  }

  window.Xlsx = { buildXlsx };
})();
