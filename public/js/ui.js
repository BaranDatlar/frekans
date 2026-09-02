// Ekran yönetimi ve oyun dışı ekranların çizimi.

import { colorFor, playerName, ownerId } from './room.js';
import { MODE, isMode, historyList, soloTotals, rankings } from './logic.js';
import { TEAM_META, teamMembers, teamOf, teamTotals, teamWinner, teamsBalanced } from './teams.js';
import { deckLabel } from './deck.js';

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

/**
 * @param {object} ctx { players, hostId, iAmHost, packs, onTeamPick }
 */
export function renderLobby(state, ctx) {
  const { players, hostId, iAmHost, packs } = ctx;
  const mode = isMode(state.game?.mode);
  const teams = state.game?.teams || {};
  const onlineIds = players.filter(p => p.online).map(p => p.id);

  $('#lobby-code').textContent = state.code || '····';
  $('#lobby-count').textContent = players.length ? `(${players.length})` : '';

  renderPlayerList(state, players, teams, mode);

  // ── Mod
  for (const btn of $$('#mode-picker .mode-opt')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
    btn.disabled = !iAmHost;
  }

  // ── Takımlar
  const teamMode = mode === MODE.TEAM;
  $('#teams-field').hidden = !teamMode;
  $('#btn-shuffle-teams').hidden = !teamMode || !iAmHost;
  if (teamMode) renderTeamPicker(state, players, teams, ctx.onTeamPick);

  // ── Deste
  $('#deck-field').hidden = !iAmHost;
  const source = state.deck?.source || 'builtin';
  for (const btn of $$('#deck-picker .mode-opt')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.deck === source));
    btn.disabled = btn.dataset.deck !== 'builtin' && !packs.length;
  }
  const select = $('#deck-pack');
  select.hidden = source === 'builtin';
  if (!select.hidden) renderPackOptions(select, packs, state.deck);
  setHint('#deck-info', iAmHost
    ? (packs.length ? '' : 'Kendi setini kullanmak için önce Setlerim\'den bir set oluştur.')
    : `Deste: ${deckLabel(state.deck)}`);

  // ── Tur sayısı
  const rounds = state.game?.totalRounds ?? 10;
  const slider = $('#input-rounds');
  if (document.activeElement !== slider) slider.value = rounds;
  $('#rounds-value').textContent = rounds;
  slider.disabled = !iAmHost;

  // ── Başlat
  const online = onlineIds.length;
  const balance = teamsBalanced(teams, onlineIds);
  const blocked = online < 2 || (teamMode && !balance.playable);

  const startBtn = $('#btn-start');
  startBtn.disabled = !iAmHost || blocked;
  startBtn.textContent = iAmHost ? 'Oyunu Başlat' : 'Başlaması bekleniyor…';

  setHint('#lobby-hint', lobbyHint({
    online, teamMode, balance, iAmHost, hostId, rounds,
  }), blocked);
}

function lobbyHint({ online, teamMode, balance, iAmHost, hostId, rounds }) {
  if (online < 2) return 'Oyun için en az 2 oyuncu gerekiyor. Kodu arkadaşlarına gönder.';
  if (teamMode && !balance.playable) {
    return `Takım modunda her takımda en az 2 oyuncu olmalı (şu an ${balance.a}–${balance.b}).`;
  }
  if (teamMode && !balance.even) {
    return `Takımlar eşit değil (${balance.a}–${balance.b}); kalabalık takım avantajlı olur.`;
  }
  if (!iAmHost) return `${playerName(hostId)} oyunu başlatacak.`;
  return `${rounds} tur oynanacak.`;
}

function renderPlayerList(state, players, teams, mode) {
  const list = $('#lobby-players');
  list.textContent = '';
  for (const p of players) {
    const li = el('li');
    const dot = el('span', 'dot' + (p.online ? '' : ' off'));
    dot.style.background = colorFor(p.id);
    li.append(dot, el('span', 'nm', p.name || 'Bilinmeyen'));
    if (mode === MODE.TEAM) {
      const t = teamOf(teams, p.id);
      if (t) {
        const tag = el('span', 'team-tag', TEAM_META[t].name);
        tag.style.color = TEAM_META[t].color;
        li.append(tag);
      }
    }
    if (p.id === ownerId()) li.append(el('span', 'tag', 'kurucu'));
    if (p.id === state.me) li.append(el('span', 'tag me', 'sen'));
    else if (!p.online) li.append(el('span', 'tag', 'çevrimdışı'));
    list.append(li);
  }
}

function renderTeamPicker(state, players, teams, onPick) {
  const box = $('#team-picker');
  box.textContent = '';
  const ids = players.filter(p => p.online).map(p => p.id);
  const members = teamMembers(teams, ids);
  const mine = teamOf(teams, state.me);

  for (const id of ['a', 'b']) {
    const meta = TEAM_META[id];
    const card = el('button', 'team-card');
    card.type = 'button';
    card.dataset.team = id;
    card.setAttribute('aria-pressed', String(mine === id));
    card.style.borderColor = mine === id ? meta.color : '';

    const title = el('b', null, meta.name);
    title.style.color = meta.color;
    card.append(title);

    // Oyuncu renkleri kadrandaki ibreler için; takım kartında nokta koymak
    // takım rengiyle karışıyor (Mavi takımda turuncu nokta gibi). Sade isim.
    const ul = el('ul');
    for (const uid of members[id]) {
      ul.append(el('li', uid === state.me ? 'me' : null, playerName(uid)));
    }
    if (!members[id].length) ul.append(el('li', 'empty-slot', 'boş'));
    card.append(ul);

    card.addEventListener('click', () => onPick(id));
    box.append(card);
  }
}

function renderPackOptions(select, packs, deck) {
  const wanted = deck?.name;
  select.textContent = '';
  for (const p of packs) {
    const opt = el('option', null, `${p.name} (${p.cards.length})`);
    opt.value = p.id;
    if (p.name === wanted) opt.selected = true;
    select.append(opt);
  }
  if (!packs.length) {
    const opt = el('option', null, 'Set yok');
    opt.value = '';
    select.append(opt);
  }
}

/* ══════════ Oyun sonu ══════════ */

export function renderOver(state) {
  const rows = historyList(state.history);
  const teamMode = isMode(state.game?.mode) === MODE.TEAM;

  if (teamMode) renderTeamResult(state, rows);
  else renderSoloResult(state, rows);

  const list = $('#over-history');
  list.textContent = '';
  for (const h of rows) {
    const li = el('li');
    const txt = el('div', 'h-txt');
    txt.append(el('div', 'h-clue', h.clue || '—'));
    txt.append(el('div', 'h-spec',
      `${h.left} ↔ ${h.right} · psişik: ${playerName(h.psychicUid)}`));
    const p = h.psychicPoints ?? 0;
    const pts = el('span', 'h-pts', `+${p}`);
    pts.dataset.p = String(Math.min(4, Math.max(0, Math.round(p))));
    pts.title = 'psişiğin puanı';
    li.append(txt, pts);
    list.append(li);
  }
  if (!rows.length) list.append(el('li', 'empty', 'Hiç tur oynanmadı.'));
}

/** Bireysel mod: kişi başı sıralama. */
function renderSoloResult(state, rows) {
  $('#over-teams').hidden = true;
  $('#over-rank').hidden = false;
  $('#over-rank-title').hidden = false;

  const totals = soloTotals(state.history);
  const table = rankings(totals, state.players);
  const best = table[0];
  const tied = table.filter(r => r.points === best?.points);

  $('#over-total').textContent = best ? best.points : 0;
  $('#over-max').textContent = `/${rows.length * 4}`;
  $('#over-title').textContent = !best ? '—'
    : tied.length > 1 ? 'Berabere!'
      : `${best.name} kazandı`;
  $('#over-note').textContent = tied.length > 1
    ? tied.map(r => r.name).join(', ') + ' aynı puanda.'
    : `${rows.length} turda toplanan puanlar:`;

  renderRankList($('#over-rank'), table, state.me);
}

/** Takım modu: iki takım kartı + oyuncu kırılımı. */
function renderTeamResult(state, rows) {
  const totals = teamTotals(state.history);
  const { winner, tie } = teamWinner(totals);
  const teams = lastTeams(rows) || state.game?.teams || {};

  $('#over-teams').hidden = false;
  $('#over-rank').hidden = false;
  $('#over-rank-title').hidden = false;

  $('#over-total').textContent = Math.max(totals.a, totals.b);
  $('#over-max').textContent = `/${rows.length * 4}`;
  $('#over-title').textContent = tie ? 'Berabere!' : `${TEAM_META[winner].name} kazandı`;
  $('#over-note').textContent = tie
    ? 'İki takım da aynı puanda.'
    : `${rows.length} turun sonunda:`;

  const box = $('#over-teams');
  box.textContent = '';
  for (const id of ['a', 'b']) {
    const card = el('div', 'team-score' + (winner === id ? ' win' : ''));
    const nm = el('div', 'nm', TEAM_META[id].name);
    nm.style.color = TEAM_META[id].color;
    const pts = el('div', 'pts', String(totals[id]));
    pts.style.color = TEAM_META[id].color;
    card.append(nm, pts);
    box.append(card);
  }

  // Oyuncu kırılımı: takıma göre gruplu
  const totalsByPlayer = soloTotals(state.history);
  const table = rankings(totalsByPlayer, state.players)
    .map(r => ({ ...r, team: teamOf(teams, r.id) }))
    .sort((a, b) => (a.team || 'z').localeCompare(b.team || 'z') || b.points - a.points);
  renderRankList($('#over-rank'), table, state.me, teams);
}

/** Son turun takım dağılımı — oyun sonu kırılımı için. */
function lastTeams(rows) {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].teams) return rows[i].teams;
  return null;
}

function renderRankList(list, table, me, teams = null) {
  list.textContent = '';
  table.forEach((r, i) => {
    const li = el('li');
    if (i === 0 && !teams) li.classList.add('first');
    if (r.id === me) li.classList.add('me');
    const dot = el('span', 'dot');
    dot.style.background = colorFor(r.id);
    if (!teams) li.append(el('span', 'pos', `${i + 1}.`));
    li.append(dot, el('span', 'nm', r.name));
    if (teams) {
      const t = teamOf(teams, r.id);
      if (t) {
        const tag = el('span', 'team-tag', TEAM_META[t].name);
        tag.style.color = TEAM_META[t].color;
        li.append(tag);
      }
    }
    li.append(el('span', 'pts', String(r.points)));
    list.append(li);
  });
  if (!table.length) list.append(el('li', 'empty', 'Puan yok.'));
}

/* ══════════ Setlerim ══════════ */

export function renderPacksList(packs, { onOpen, canSave }) {
  const list = $('#packs-list');
  list.textContent = '';

  if (!canSave) {
    const li = el('li', 'empty');
    li.append(el('p', null,
      'Kendi setlerini kaydetmek için Google ile giriş yapmalısın. ' +
      'Misafir olarak odalara katılıp oynayabilirsin.'));
    list.append(li);
    return;
  }
  if (!packs.length) {
    list.append(el('li', 'empty', 'Henüz setin yok. "Yeni set" ile başla.'));
    return;
  }
  for (const p of packs) {
    const li = el('li');
    const txt = el('div', 's-txt');
    txt.append(el('div', null, p.name));
    txt.append(el('div', 'h-spec', `${p.cards.length} kart`));
    li.append(txt, el('span', 'tag', 'düzenle'));
    li.style.cursor = 'pointer';
    li.addEventListener('click', () => onOpen(p));
    list.append(li);
  }
}

export function renderCardList(cards, onRemove) {
  const list = $('#card-list');
  list.textContent = '';
  if (!cards.length) {
    list.append(el('li', 'empty', 'Bu sette henüz kart yok. En az 3 kart gerekiyor.'));
    return;
  }
  cards.forEach((c, i) => {
    const li = el('li');
    const txt = el('div', 's-txt');
    txt.append(el('span', 'l', c.l), el('span', 'sep', '↔'), el('span', 'r', c.r));
    const del = el('button', 's-del', '×');
    del.title = 'Kartı çıkar';
    del.setAttribute('aria-label', `${c.l} - ${c.r} çıkar`);
    del.addEventListener('click', () => onRemove(i));
    li.append(txt, del);
    list.append(li);
  });
}
