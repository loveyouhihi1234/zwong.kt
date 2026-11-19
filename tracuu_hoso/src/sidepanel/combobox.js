// Ô chọn có tìm kiếm, bọc quanh một <select> sẵn có (select bị ẩn nhưng vẫn giữ giá trị thật,
// nên code khác cứ đọc/ghi select.value và thêm <option> như bình thường).
// - Gõ để lọc, không phân biệt hoa thường/dấu ("gia tri", "gtgt" đều khớp "GIÁ TRỊ GIA TĂNG").
// - Bàn phím: ↑ ↓ chọn dòng, Enter chọn, Esc đóng.

// Bỏ dấu tiếng Việt để so khớp
const fold = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();

let uid = 0;

/**
 * @param {HTMLSelectElement} select
 * @param {{placeholder?: string}} [o]
 */
export function createCombobox(select, { placeholder = 'Gõ để tìm…' } = {}) {
  const id = `combo${++uid}`;
  const box = document.createElement('div'); box.className = 'combo';
  const input = document.createElement('input');
  input.className = 'combo-input'; input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
  input.placeholder = placeholder;
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-controls', `${id}-list`);
  if (select.id) { input.id = `${select.id}Search`; document.querySelector(`label[for="${select.id}"]`)?.setAttribute('for', input.id); }
  const clear = document.createElement('button');
  clear.type = 'button'; clear.className = 'combo-clear'; clear.textContent = '×'; clear.tabIndex = -1;
  clear.title = 'Bỏ chọn'; clear.setAttribute('aria-label', 'Bỏ chọn');
  const list = document.createElement('ul');
  list.className = 'combo-list'; list.id = `${id}-list`; list.hidden = true; list.setAttribute('role', 'listbox');
  box.append(input, clear, list);
  select.hidden = true;
  select.after(box);

  let items = [];     // các option đang hiện (sau lọc)
  let active = -1;    // dòng đang được tô bằng bàn phím/chuột

  const options = () => [...select.options].map((o) => ({ value: o.value, label: o.textContent.trim() }));
  const selectedLabel = () => (select.value ? select.selectedOptions[0]?.textContent.trim() || '' : '');

  // Hiện nhãn của giá trị đang chọn ("Tất cả" để trống, chỉ hiện placeholder)
  function sync() {
    if (document.activeElement !== input) input.value = selectedLabel();
    input.title = input.value;
    box.classList.toggle('has-value', !!select.value);
  }

  function render() {
    const q = fold(input.value.trim());
    // Đang hiện đúng nhãn đã chọn (vừa mở) → hiện hết, không lọc
    const all = !q || input.value === selectedLabel();
    const words = q.split(/\s+/).filter(Boolean);
    items = options().filter((o) => all || words.every((w) => fold(o.label).includes(w)));
    list.replaceChildren(...items.map((o, i) => {
      const li = document.createElement('li');
      li.id = `${id}-o${i}`; li.setAttribute('role', 'option'); li.textContent = o.label; li.title = o.label;
      li.dataset.i = i;
      if (o.value === select.value) { li.classList.add('sel'); li.setAttribute('aria-selected', 'true'); }
      if (!o.value) li.classList.add('all');
      return li;
    }));
    if (!items.length) {
      const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'Không tìm thấy loại tờ khai phù hợp';
      list.append(li);
    }
    const sel = items.findIndex((o) => o.value === select.value);
    setActive(all ? Math.max(sel, 0) : (items.length ? 0 : -1));
  }

  function setActive(i) {
    list.querySelector('.active')?.classList.remove('active');
    active = i;
    const li = i >= 0 ? list.children[i] : null;
    if (li) { li.classList.add('active'); li.scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', li.id); }
    else input.removeAttribute('aria-activedescendant');
  }

  function open() {
    if (!list.hidden) return;
    list.hidden = false; box.classList.add('open'); input.setAttribute('aria-expanded', 'true');
    render();
  }
  function close() {
    list.hidden = true; box.classList.remove('open'); input.setAttribute('aria-expanded', 'false');
  }

  function choose(i) {
    const o = items[i];
    if (!o) return;
    if (select.value !== o.value) { select.value = o.value; select.dispatchEvent(new Event('change', { bubbles: true })); }
    close();
    input.value = selectedLabel(); sync();
  }

  input.addEventListener('focus', () => { open(); input.select(); });
  input.addEventListener('click', open);
  input.addEventListener('input', () => { open(); render(); });
  input.addEventListener('blur', () => { close(); input.value = selectedLabel(); sync(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) return open();
      if (items.length) setActive((active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
    } else if (e.key === 'Enter') {
      if (!list.hidden && active >= 0) { e.preventDefault(); choose(active); }
    } else if (e.key === 'Escape') {
      if (!list.hidden) { e.preventDefault(); close(); input.value = selectedLabel(); input.select(); }
    }
  });
  list.addEventListener('mousedown', (e) => e.preventDefault()); // giữ focus ở ô gõ
  list.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) choose(+li.dataset.i); });
  list.addEventListener('mousemove', (e) => { const li = e.target.closest('li[data-i]'); if (li && +li.dataset.i !== active) setActive(+li.dataset.i); });
  clear.addEventListener('mousedown', (e) => e.preventDefault());
  clear.addEventListener('click', () => {
    if (select.value) { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); }
    input.value = ''; sync();
    if (document.activeElement === input) render(); else input.focus();
  });

  // Danh sách option được nạp sau (khi kết nối tab dichvucong) → cập nhật theo
  new MutationObserver(() => { sync(); if (!list.hidden) render(); }).observe(select, { childList: true });
  select.addEventListener('change', sync);

  sync();
  return { refresh: sync, close };
}
