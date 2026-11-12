// Small DOM helpers: element builder, toast, popup menu, dialogs.
export function h(tag, props, ...kids) {
  const [name, ...cls] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (cls.length) el.className = cls.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

let toastTimer = null;
export function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, kind === 'error' ? 5200 : 2600);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: 0 } });
  document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

// ---- popup (menu / palette): one at a time, closes on outside press or Escape
let popup = null;
export function closePopup() { popup?.remove(); popup = null; }
function place(el, x, y) {
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
}
document.addEventListener('pointerdown', (e) => { if (popup && !popup.contains(e.target)) closePopup(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && popup) { closePopup(); e.stopPropagation(); } }, true);

export function menu(x, y, items) {
  closePopup();
  popup = h('div.popup.menu', { role: 'menu' }, items.filter(Boolean).map((it) => (it === '-' ? h('hr') : h('button', {
    role: 'menuitem', className: it.danger ? 'danger' : '', disabled: !!it.disabled,
    onclick: () => { closePopup(); it.run(); },
  }, h('span', {}, it.label), it.key ? h('kbd', {}, it.key) : null))));
  place(popup, x, y);
}

// Searchable list. groups: [{ label, items: [{ id, title, hint }] }]
export function palette(x, y, groups, onPick, placeholder = '노드 찾기') {
  closePopup();
  const list = h('div.palette-list');
  const input = h('input', { type: 'search', placeholder, 'aria-label': placeholder });
  let flat = [], active = 0;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    list.replaceChildren(); flat = [];
    for (const g of groups) {
      const items = g.items.filter((it) => !q || `${it.title} ${it.hint || ''}`.toLowerCase().includes(q));
      if (!items.length) continue;
      list.append(h('div.palette-group', {}, g.label));
      for (const it of items) {
        const row = h('button.palette-item', { onclick: () => { closePopup(); onPick(it.id); } }, h('b', {}, it.title), it.hint ? h('small', {}, it.hint) : null);
        flat.push(row); list.append(row);
      }
    }
    if (!flat.length) list.append(h('div.palette-empty', {}, '맞는 항목이 없습니다'));
    active = 0; mark();
  };
  const mark = () => flat.forEach((r, i) => { r.classList.toggle('active', i === active); if (i === active) r.scrollIntoView({ block: 'nearest' }); });
  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(flat.length - 1, active + 1); mark(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); mark(); e.preventDefault(); }
    else if (e.key === 'Enter') { flat[active]?.click(); e.preventDefault(); }
  });
  popup = h('div.popup.palette', {}, input, list);
  draw(); place(popup, x, y);
  input.focus();
}

// List with tabs across the top. tabs: [{ id, label, items: [{ id, title, hint }] }]
export function tabPicker(x, y, tabs, current, onPick) {
  closePopup();
  const list = h('div.palette-list');
  const bar = h('div.tabbar', { role: 'tablist' });
  const input = h('input', { type: 'search', placeholder: '이름으로 찾기', 'aria-label': '모델 찾기' });
  let active = tabs[0].id;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    bar.replaceChildren(...tabs.map((t) => h('button', { role: 'tab', 'aria-selected': String(t.id === active), className: t.id === active ? 'on' : '', onclick: () => { active = t.id; input.value = ''; draw(); } }, t.label)));
    // Typing searches every model, whatever tab is open.
    const pool = q ? tabs.find((t) => t.all) || tabs[0] : tabs.find((t) => t.id === active);
    const items = pool.items.filter((it) => !q || `${it.title} ${it.hint || ''}`.toLowerCase().includes(q));
    list.replaceChildren(...(items.length ? items.map((it) => h(`button.palette-item${it.id === current ? '.active' : ''}`, { onclick: () => { closePopup(); onPick(it.id); } }, h('b', {}, it.title), it.hint ? h('small', {}, it.hint) : null)) : [h('div.palette-empty', {}, '맞는 모델이 없습니다')]));
  };
  input.addEventListener('input', draw);
  popup = h('div.popup.palette.wide', {}, input, bar, list);
  draw(); place(popup, x, y);
  input.focus();
}

// ---- modal dialogs
export function modal(title, body, buttons) {
  return new Promise((resolve) => {
    const done = (v) => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(undefined); } };
    const box = h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', {}, title), h('div.modal-body', {}, body),
      h('div.modal-foot', {}, buttons.map((b) => h('button', { className: b.primary ? 'primary' : '', onclick: () => done(typeof b.value === 'function' ? b.value() : b.value) }, b.label))));
    const back = h('div.modal-back', { onpointerdown: (e) => { if (e.target === back) done(undefined); } }, box);
    document.addEventListener('keydown', onKey, true);
    document.body.append(back);
    (box.querySelector('[autofocus]') || box.querySelector('.primary') || box).focus?.();
  });
}
export const confirmBox = (title, text, okLabel = '실행') => modal(title, h('p', {}, text), [{ label: '취소', value: false }, { label: okLabel, value: true, primary: true }]).then((v) => !!v);
export const askBox = (question, options) => modal('확인', h('p', {}, question), [{ label: '취소', value: undefined }, ...options.map((o, i) => ({ ...o, primary: i === 0 }))]);

// Relay: show the request to copy into a Claude chat, take the pasted answer back.
export function relayBox(text, kind) {
  const writing = kind === 'text';
  const answer = h('textarea', { rows: writing ? 7 : 4, placeholder: writing ? 'Claude가 쓴 글을 여기에 붙여넣으세요' : 'Claude가 답한 결과 주소를 여기에 붙여넣으세요', autofocus: true });
  const req = h('textarea', { rows: 9, readOnly: true, value: text });
  const body = h('div.relay', {},
    h('p', {}, writing ? '① 아래 요청을 복사해 Claude 채팅에 붙여넣습니다. ② Claude가 쓴 글을 아래 칸에 붙여넣습니다.' : `① 아래 요청을 복사해 Higgsfield 커넥터가 켜진 Claude 채팅에 붙여넣습니다. ② ${kind === 'video' ? '영상' : '이미지'}이 만들어지면 결과 주소를 아래 칸에 붙여넣습니다.`),
    req,
    h('button', { onclick: async (e) => { e.target.textContent = (await copyText(text)) ? '복사했습니다' : '복사하지 못했습니다. 직접 선택해 복사하세요'; } }, '요청 복사'),
    answer);
  return modal('Claude에게 전달', body, [{ label: '취소', value: null }, { label: '결과 넣기', primary: true, value: () => answer.value }]).then((v) => (v === undefined ? null : v));
}

// Full-size view. With `info` (what the result was made from) a side panel shows the model, settings and the prompt that was sent.
export function lightbox(item, url, info) {
  const media = item.type === 'video' && !item.still ? h('video', { src: url, controls: true, autoplay: true, loop: true }) : h('img', { src: url, alt: '' });
  const req = info?.request;
  const facts = req ? [req.model, req.finalOf ? `v${req.finalOf} 드래프트를 ${req.resolution}로 완성` : req.draft ? '드래프트' : null, !req.finalOf && req.resolution ? req.resolution : null, req.aspect, req.duration ? `${req.duration}초` : null].filter(Boolean) : [];
  const side = req ? h('aside.lightbox-info', {},
    h('h2', {}, [info.title, info.v ? `v${info.v}` : null].filter(Boolean).join(' · ')),
    facts.length ? h('p.facts', {}, facts.join(' · ')) : null,
    h('h3', {}, '사용한 프롬프트'),
    h('pre', {}, req.prompt || '(프롬프트 없이 생성)'),
    req.prompt ? h('button', { onclick: async (e) => { e.target.textContent = (await copyText(req.prompt)) ? '복사했습니다' : '복사하지 못했습니다'; } }, '프롬프트 복사') : null) : null;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };
  const back = h(`div.lightbox${side ? '.with-info' : ''}`, { onclick: (e) => { if (e.target === back || e.target.classList.contains('lightbox-media')) close(); } }, h('div.lightbox-media', {}, media), side, h('button.lightbox-close', { 'aria-label': '닫기', onclick: close }, '닫기'));
  const onKey = (e) => { if (e.key === 'Escape') { close(); e.stopPropagation(); } };
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
}
