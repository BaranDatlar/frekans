// Ekran yönetimi ve oyun dışı ekranların çizimi.

import { colorFor, playerName } from './room.js';
import { historyList, totalScore } from './logic.js';
import { verdict } from './scoring.js';

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let current = null;

export function showScreen(id) {
  if (current === id) return;
  current = id;
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === `screen-${id}`));
}

export function currentScreen() { return current; }

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function setHint(sel, msg, isError = false) {
  const el = $(sel);
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError && !!msg);
}

/** Metni güvenle DOM'a koymak için (kullanıcı girdisi HTML olarak yorumlanmasın). */
export function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

/* ══════════ Lobi ══════════ */

export function renderLobby(state, players, hostId, poolCount) {
  $('#lobby-code').textContent = state.code || '····';
  $('#lobby-count').textContent = players.length ? `(${players.length})` : '';

  const list = $('#lobby-players');
  list.textContent = '';
  for (const p of players) {
    const li = el('li');
    const dot = el('span', 'dot' + (p.online ? '' : ' off'));
    dot.style.background = colorFor(p.id);
    li.append(dot, el('span', 'nm', p.name || 'Bilinmeyen'));
    if (p.id === state.me) li.append(el('span', 'tag me', 'sen'));
    else if (!p.online) li.append(el('span', 'tag', 'çevrimdışı'));
    list.append(li);
  }

  const rounds = state.game?.totalRounds ?? 10;
  const slider = $('#input-rounds');
  if (document.activeElement !== slider) slider.value = rounds;
  $('#rounds-value').textContent = rounds;

  $('#btn-lobby-spectrums').textContent =
    poolCount == null ? 'Spektrumlar' : `Spektrumlar (${poolCount})`;

  const online = players.filter(p => p.online).length;
  const iAmHost = hostId === state.me;
  const emptyPool = poolCount === 0;
  const startBtn = $('#btn-start');
  startBtn.disabled = !iAmHost || online < 2 || emptyPool;
  startBtn.textContent = iAmHost ? 'Oyunu Başlat' : 'Başlaması bekleniyor…';

  setHint('#lobby-hint',
    emptyPool ? 'Havuzda hiç spektrum yok. Spektrumlar ekranından başlangıç setini yükle.'
      : online < 2 ? 'Oyun için en az 2 oyuncu gerekiyor. Kodu arkadaşlarına gönder.'
        : iAmHost ? `${state.game?.totalRounds ?? 10} tur oynanacak.`
          : `${playerName(hostId)} oyunu başlatacak.`,
    emptyPool);
}

/* ══════════ Oyun sonu ══════════ */

export function renderOver(state) {
  const rows = historyList(state.history);
  const total = totalScore(state.history);
  const v = verdict(total, rows.length);

  $('#over-total').textContent = total;
  $('#over-max').textContent = `/${rows.length * 4}`;
  $('#over-title').textContent = v.title;
  $('#over-note').textContent = v.note;

  const list = $('#over-history');
  list.textContent = '';
  for (const h of rows) {
    const li = el('li');
    const txt = el('div', 'h-txt');
    txt.append(el('div', 'h-clue', h.clue || '—'));
    txt.append(el('div', 'h-spec', `${h.left} ↔ ${h.right} · ${playerName(h.psychicUid)}`));
    const pts = el('span', 'h-pts', `+${h.points ?? 0}`);
    pts.dataset.p = String(h.points ?? 0);
    li.append(txt, pts);
    list.append(li);
  }
  if (!rows.length) list.append(el('li', 'empty', 'Hiç tur oynanmadı.'));
}

/* ══════════ Spektrum editörü ══════════ */

export function renderSpectrumList(items, { filter, onDelete, onSeed }) {
  const q = (filter || '').trim().toLocaleLowerCase('tr');
  const shown = q
    ? items.filter(s => `${s.left} ${s.right}`.toLocaleLowerCase('tr').includes(q))
    : items;

  $('#spec-count').textContent = items.length ? `(${items.length})` : '';

  const list = $('#spec-list');
  list.textContent = '';

  if (!items.length) {
    const li = el('li', 'empty');
    li.append(el('p', null, 'Havuz boş. Başlangıç setiyle 86 hazır spektrum yükleyebilirsin.'));
    const btn = el('button', 'btn small primary', 'Başlangıç setini yükle');
    btn.addEventListener('click', onSeed);
    li.append(btn);
    list.append(li);
    return;
  }
  if (!shown.length) {
    list.append(el('li', 'empty', 'Eşleşen spektrum yok.'));
    return;
  }

  for (const s of shown) {
    const li = el('li');
    const txt = el('div', 's-txt');
    txt.append(el('span', 'l', s.left), el('span', 'sep', '↔'), el('span', 'r', s.right));
    // Havuz ortak: yanlışlıkla basılan silme herkesten siler, o yüzden iki adım.
    const del = el('button', 's-del', '×');
    del.title = 'Sil';
    del.setAttribute('aria-label', `${s.left} - ${s.right} sil`);
    let armed = false;
    let armTimer = null;
    del.addEventListener('click', () => {
      if (armed) { clearTimeout(armTimer); onDelete(s); return; }
      armed = true;
      del.textContent = 'Sil?';
      del.classList.add('armed');
      armTimer = setTimeout(() => {
        armed = false; del.textContent = '×'; del.classList.remove('armed');
      }, 3000);
    });
    li.append(txt, del);
    list.append(li);
  }
}
