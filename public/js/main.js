// Uygulamanın kablolaması: olaylar, ekran seçimi, oyun sahnesinin çizimi.

import { authReady } from './firebase.js';
import {
  state, subscribe, createRoom, joinRoom, leaveRoom, normalizeCode,
  playerList, hostId, playerName, isOnline, colorFor,
} from './room.js';
import * as game from './game.js';
import * as spec from './spectrums.js';
import {
  totalScore, soloTotals, soloScores, psychicAverage, lockedGuessers,
} from './logic.js';
import { scoreFor } from './scoring.js';
import { Dial } from './dial.js';
import {
  $, showScreen, toast, setHint, el, renderLobby, renderOver, renderSpectrumList,
} from './ui.js';

const NAME_KEY = 'frekans.name';
const SKIP_DELAY_MS = 10000;

let dial = null;
let specOpen = false;
let specItems = [];
let unsubSpec = null;
let stageSig = null;
let shownTarget = null;
let clueEnteredAt = 0;
let heartbeat = null;
let poolCount = null;
let poolLoading = false;
let joinedAt = 0;

/* ══════════════════ Başlangıç ══════════════════ */

export async function start() {
  await authReady;

  const savedName = localStorage.getItem(NAME_KEY) || '';
  $('#input-name').value = savedName;

  const urlCode = normalizeCode(new URLSearchParams(location.search).get('oda') || '');
  if (urlCode) $('#input-code').value = urlCode;

  dial = new Dial($('#dial'), {
    onInput: (v) => game.pushDial(v),
    onCommit: (v) => { game.pushDial(v); game.flushDial(); },
  });

  wireHome();
  wireLobby();
  wireOver();
  wireSpectrums();

  subscribe(render);
  showScreen('home');

  if (urlCode && savedName) {
    // Bağlantıyla gelindi ve isim hatırlanıyor: doğrudan odaya al.
    await doJoin(urlCode, savedName);
  }
}

/* ══════════════════ Açılış ekranı ══════════════════ */

function currentName() {
  const n = $('#input-name').value.trim().slice(0, 14);
  return n;
}

function rememberName(n) { localStorage.setItem(NAME_KEY, n); }

function wireHome() {
  $('#btn-create').addEventListener('click', async () => {
    const name = currentName();
    if (!name) return setHint('#home-status', 'Önce adını yaz.', true);
    rememberName(name);
    await guarded('#home-status', '#btn-create', async () => {
      joinedAt = Date.now();
      const code = await createRoom(name);
      history.replaceState(null, '', `?oda=${code}`);
    });
  });

  $('#btn-join').addEventListener('click', async () => {
    const name = currentName();
    if (!name) return setHint('#home-status', 'Önce adını yaz.', true);
    rememberName(name);
    await doJoin($('#input-code').value, name);
  });

  $('#input-code').addEventListener('input', (e) => {
    e.target.value = normalizeCode(e.target.value);
  });
  $('#input-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-join').click();
  });
  $('#input-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#input-code').value ? $('#btn-join').click() : $('#btn-create').click();
  });

  $('#btn-open-spectrums').addEventListener('click', openSpectrums);
}

async function doJoin(code, name) {
  await guarded('#home-status', '#btn-join', async () => {
    joinedAt = Date.now();
    const c = await joinRoom(code, name);
    history.replaceState(null, '', `?oda=${c}`);
  });
}

/** Butonu kilitler, hatayı ipucu satırına yazar. */
async function guarded(hintSel, btnSel, fn) {
  const btn = $(btnSel);
  if (btn) btn.disabled = true;
  setHint(hintSel, '');
  try {
    await fn();
  } catch (err) {
    console.error(err);
    setHint(hintSel, err?.message || 'Bir şeyler ters gitti.', true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ══════════════════ Lobi ══════════════════ */

function wireLobby() {
  $('#btn-leave-lobby').addEventListener('click', exitRoom);
  $('#btn-leave-game').addEventListener('click', exitRoom);
  $('#btn-leave-over').addEventListener('click', exitRoom);

  $('#input-rounds').addEventListener('input', (e) => {
    $('#rounds-value').textContent = e.target.value;
  });
  $('#input-rounds').addEventListener('change', (e) => {
    game.setTotalRounds(Number(e.target.value)).catch(() => {});
  });

  $('#btn-start').addEventListener('click', async () => {
    await guarded('#lobby-hint', '#btn-start', () => game.startGame());
  });

  $('#btn-lobby-spectrums').addEventListener('click', openSpectrums);

  for (const btn of document.querySelectorAll('#mode-picker .mode-opt')) {
    btn.addEventListener('click', () => {
      game.setMode(btn.dataset.mode).catch(e => toast(e.message));
    });
  }

  $('#btn-share').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?oda=${state.code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Frekans', text: `Oda kodu: ${state.code}`, url });
      else { await navigator.clipboard.writeText(url); toast('Bağlantı kopyalandı'); }
    } catch { /* kullanıcı vazgeçti */ }
  });
}

async function exitRoom() {
  await leaveRoom();
  history.replaceState(null, '', location.pathname);
  stageSig = null;
  shownTarget = null;
  joinedAt = 0;
  showScreen('home');
}

/* ══════════════════ Oyun sonu ══════════════════ */

function wireOver() {
  $('#btn-again').addEventListener('click', async () => {
    await guarded(null, '#btn-again', () => game.restart());
  });
}

/* ══════════════════ Ana çizim döngüsü ══════════════════ */

function render() {
  $('#offline').hidden = !state.code || state.connected;

  if (specOpen) { showScreen('spectrums'); return; }

  if (!state.code) { showScreen('home'); stopHeartbeat(); return; }

  if (!state.game) {
    // Oda kaydı henüz gelmedi. Uzun sürerse takılı kalmayalım.
    showScreen('boot');
    setHint('#boot-status', 'Odaya giriliyor…');
    if (Date.now() - joinedAt > 8000) {
      toast('Oda bulunamadı.');
      exitRoom();
    } else {
      startHeartbeat();
    }
    return;
  }

  const phase = state.game.phase;
  if (phase === 'lobby') {
    stopHeartbeat();
    showScreen('lobby');
    renderLobby(state, playerList(), hostId(), poolCount);
    checkPool();
    return;
  }
  if (phase === 'gameover') {
    stopHeartbeat();
    showScreen('over');
    renderOver(state);
    return;
  }
  showScreen('game');
  startHeartbeat();
  renderGame();
  sideEffects();
}

/** Lobide havuzun boş olup olmadığını bir kez öğren (boş havuzla oyun başlamasın). */
async function checkPool() {
  if (poolCount !== null || poolLoading) return;
  poolLoading = true;
  try {
    poolCount = (await spec.loadPool()).length;
    render();
  } catch {
    /* bağlantı düzelince yeniden denenir */
  } finally {
    poolLoading = false;
  }
}

function startHeartbeat() {
  // Faz içi zamana bağlı öğeler (ör. "Sırayı atla" 10 sn sonra çıkar) için.
  if (!heartbeat) heartbeat = setInterval(render, 1000);
}
function stopHeartbeat() {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
}

/* ══════════════════ Oyun sahnesi ══════════════════ */

function renderGame() {
  const g = state.game;
  const me = state.me;
  const psychic = g.psychicUid === me;
  const target = game.knownTarget();
  const solo = game.isSolo();
  const locked = game.iLocked();
  const guesses = game.visibleGuesses();

  $('#game-round-label').textContent = `Tur ${g.roundIndex + 1}/${g.totalRounds}`;
  $('#game-score').textContent = solo ? (soloTotals(state.history)[me] || 0)
    : totalScore(state.history);
  $('#spec-left').textContent = g.spectrum?.left ?? '—';
  $('#spec-right').textContent = g.spectrum?.right ?? '—';

  // Sürükleme: tahmin fazında, psişik değilsen ve henüz kilitlemediysen
  dial.setInteractive(g.phase === 'guess' && !psychic && !locked);

  if (solo) {
    // Psişiğin kendi ibresi yok; diğerlerini renkli "hayalet" ibre olarak görür.
    dial.setMainVisible(!psychic);
    if (!psychic) {
      const mine = guesses[me] ?? game.myGuess() ?? 50;
      dial.setRemoteValue(mine);
    }
    dial.setGhosts(Object.entries(guesses)
      .filter(([id]) => id !== me)
      .map(([id, value]) => ({ id, value, color: colorFor(id) })));
  } else {
    dial.setMainVisible(true);
    dial.setGhosts([]);
    dial.setRemoteValue(g.phase === 'reveal'
      ? (Number.isFinite(g.final) ? g.final : 50)
      : (g.dial?.value ?? 50));
  }

  renderLegend(solo, psychic, guesses);

  // Bantlar: psişik turun başından beri görür, diğerleri sadece açılışta
  const maySeeBands = (psychic && g.phase !== 'reveal') || g.phase === 'reveal';
  const wantTarget = maySeeBands ? target : null;
  if (wantTarget !== shownTarget) {
    shownTarget = wantTarget;
    dial.setTarget(wantTarget);
  }

  const sig = [g.phase, g.roundIndex, psychic, !!g.spectrum, target != null,
    game.mode(), locked, !!state.history?.[g.roundIndex]].join('|');
  if (sig !== stageSig) {
    stageSig = sig;
    if (g.phase === 'clue') clueEnteredAt = Date.now();
    buildStage(g, psychic, target);
  }
  updateStageLive(g, psychic);
}

/** Kadranın altındaki renk açıklaması (yalnızca bireysel modda anlamlı). */
function renderLegend(solo, psychic, guesses) {
  const box = $('#legend');
  const ids = Object.keys(guesses);
  if (!solo || !ids.length) { box.hidden = true; box.textContent = ''; return; }
  box.hidden = false;
  box.textContent = '';
  for (const id of ids) {
    const item = el('span');
    const dot = el('i');
    dot.style.background = id === state.me ? '#e7ecf3' : colorFor(id);
    item.append(dot, document.createTextNode(id === state.me ? 'sen' : playerName(id)));
    box.append(item);
  }
}

function buildStage(g, psychic, target) {
  const stage = $('#stage');
  stage.textContent = '';

  if (g.phase === 'clue') return buildClueStage(stage, g, psychic);
  if (g.phase === 'guess') return buildGuessStage(stage, g, psychic);
  if (g.phase === 'reveal') return buildRevealStage(stage, g, target);
}

function buildClueStage(stage, g, psychic) {
  if (psychic) {
    if (!g.spectrum) {
      stage.append(el('p', 'waiting', 'Kart çekiliyor…'));
      return;
    }
    stage.append(el('div', 'psychic-banner',
      'Sen psişiksin. Kadranda işaretli yeri, tek bir kelime ya da kısa bir ifadeyle anlat. ' +
      'Yüzde, sayı ya da yön söylemek yasak.'));

    const input = el('input');
    input.type = 'text';
    input.id = 'clue-input';
    input.maxLength = 60;
    input.placeholder = 'ipucun…';
    input.autocomplete = 'off';

    const btn = el('button', 'btn primary wide', 'İpucunu Gönder');
    btn.id = 'btn-clue-send';
    const send = async () => {
      const v = input.value.trim();
      if (!v) return;
      btn.disabled = true;
      try { await game.submitClue(v); }
      catch (e) { toast(e.message); btn.disabled = false; }
    };
    btn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

    stage.append(input, btn);
    setTimeout(() => input.focus(), 60);
  } else {
    const who = el('p', 'waiting');
    who.append(el('b', null, playerName(g.psychicUid)), document.createTextNode(' ipucunu düşünüyor…'));
    stage.append(who);
    const skip = el('button', 'btn ghost small wide', 'Sırayı atla');
    skip.id = 'btn-skip';
    skip.hidden = true;
    skip.addEventListener('click', () => game.skipPsychic().catch(e => toast(e.message)));
    stage.append(skip);
  }
}

function buildGuessStage(stage, g, psychic) {
  const box = el('div', 'clue-box');
  box.append(el('div', 'who', `${playerName(g.psychicUid)} diyor ki`));
  box.append(el('div', 'what', g.clue || '—'));
  stage.append(box);

  if (!game.isSolo()) {
    const dragger = el('div', 'dragger');
    dragger.id = 'dragger';
    stage.append(dragger);
  }

  const status = el('div', 'lock-status');
  status.id = 'lock-status';
  stage.append(status);

  if (psychic) {
    stage.append(el('p', 'waiting', game.isSolo()
      ? 'Sessiz kal! Herkes kendi tahminini yapıyor.'
      : 'Sessiz kal! Takım kadranı ayarlıyor.'));
    return;
  }

  if (game.iLocked()) {
    const undo = el('button', 'btn ghost wide', 'Kilidi geri al');
    undo.id = 'btn-unlock';
    undo.addEventListener('click', () => game.unlockGuess().catch(e => toast(e.message)));
    stage.append(undo);
  } else {
    const lock = el('button', 'btn primary wide', 'Kilitle');
    lock.id = 'btn-lock';
    lock.addEventListener('click', async () => {
      lock.disabled = true;
      try { await game.lockGuess(); }
      catch (e) { toast(e.message); lock.disabled = false; }
    });
    stage.append(lock);
  }
}

function buildRevealStage(stage, g, target) {
  if (target == null) {
    stage.append(el('p', 'waiting', 'Hedef açılıyor…'));
    return;
  }

  if (game.isSolo()) {
    buildSoloReveal(stage, g, target);
  } else {
    // Puanı history'yi beklemeden yerel hesapla: aynı saf fonksiyon,
    // aynı hedef ve aynı ibre → her cihazda aynı sonuç.
    const points = scoreFor(target, Number.isFinite(g.final) ? g.final : 50);
    const burst = el('div', 'points-burst');
    burst.append(
      el('div', 'num' + (points ? '' : ' zero'), `+${points}`),
      el('div', 'lbl', points === 4 ? 'Tam isabet!' : points ? 'puan' : 'Hedefin dışında'));
    stage.append(burst);
  }

  const box = el('div', 'clue-box');
  box.append(el('div', 'who', `${playerName(g.psychicUid)} demişti ki`));
  box.append(el('div', 'what', g.clue || '—'));
  stage.append(box);

  const next = el('button', 'btn primary wide', 'Sonraki Tur');
  next.id = 'btn-next';
  next.addEventListener('click', async () => {
    next.disabled = true;
    try { await game.nextRound(); } finally { next.disabled = false; }
  });
  stage.append(next);
}

/** Bireysel mod açılışı: herkesin puanı ve psişiğin ortalaması. */
function buildSoloReveal(stage, g, target) {
  const guesses = game.visibleGuesses();
  const points = soloScores(target, guesses);
  const psyPoints = psychicAverage(points);
  const mine = points[state.me];

  const burst = el('div', 'points-burst');
  const own = state.me === g.psychicUid ? psyPoints : (mine ?? 0);
  burst.append(
    el('div', 'num' + (own ? '' : ' zero'), `+${own}`),
    el('div', 'lbl', state.me === g.psychicUid
      ? 'ortalama — anlatım puanın'
      : own === 4 ? 'Tam isabet!' : own ? 'puan' : 'Hedefin dışında'));
  stage.append(burst);

  const list = el('ul', 'rank-list');
  const rows = Object.entries(points)
    .map(([id, pts]) => ({ id, pts, name: playerName(id) }))
    .sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name, 'tr'));
  for (const r of rows) {
    const li = el('li');
    if (r.id === state.me) li.classList.add('me');
    const dot = el('span', 'dot');
    dot.style.background = r.id === state.me ? '#e7ecf3' : colorFor(r.id);
    const pts = el('span', 'pts', `+${r.pts}`);
    pts.dataset.p = String(r.pts);
    li.append(dot, el('span', 'nm', r.name), pts);
    list.append(li);
  }
  const psy = el('li');
  const pdot = el('span', 'dot');
  pdot.style.background = colorFor(g.psychicUid);
  const psyPts = el('span', 'pts', `+${psyPoints}`);
  psyPts.dataset.p = String(psyPoints);
  psy.append(pdot, el('span', 'nm', `${playerName(g.psychicUid)} (psişik)`), psyPts);
  list.append(psy);
  stage.append(list);
}

/** Sahneyi yeniden kurmadan güncellenen küçük parçalar. */
function updateStageLive(g, psychic) {
  if (g.phase === 'guess') {
    const d = $('#dragger');
    if (d) {
      const by = g.dial?.by;
      d.textContent = by && by !== state.me ? `${playerName(by)} çeviriyor` : '';
      d.style.color = by ? colorFor(by) : '';
    }

    const status = $('#lock-status');
    if (status) {
      status.textContent = '';
      const expected = game.expectedGuessers();
      const done = lockedGuessers(game.roundLocks(), expected,
        game.isSolo() ? null : (g.dial?.value ?? 50)).length;

      const line = el('span');
      line.append(el('b', null, `${done}/${expected.length}`),
        document.createTextNode(' kilitledi'));
      status.append(line);

      const left = game.countdownLeft();
      if (left != null) {
        status.append(document.createTextNode(' · '));
        const c = el('span', 'countdown', `${Math.ceil(left / 1000)} sn`);
        status.append(c);
        status.append(el('div', null, 'Süre bitince tur otomatik açılır.'));
      } else if (!psychic && !game.iLocked()) {
        status.append(el('div', null, 'Herkes kilitleyince tur açılır.'));
      }
    }
  }

  if (g.phase === 'clue' && !psychic) {
    const skip = $('#btn-skip');
    if (skip) {
      const stuck = !isOnline(g.psychicUid) || Date.now() - clueEnteredAt > SKIP_DELAY_MS;
      skip.hidden = !stuck;
      skip.textContent = isOnline(g.psychicUid)
        ? 'Sırayı atla' : `${playerName(g.psychicUid)} çevrimdışı — sırayı atla`;
    }
  }
}

/* ══════════════════ Yan etkiler ══════════════════ */

async function sideEffects() {
  const { changed, error } = await game.runSideEffects();
  if (error) toast(error);
  if (changed) render();
}

/* ══════════════════ Spektrum editörü ══════════════════ */

function openSpectrums() {
  specOpen = true;
  showScreen('spectrums');
  unsubSpec = spec.subscribePool((items) => {
    specItems = items;
    drawSpectrums();
  });
}

function closeSpectrums() {
  specOpen = false;
  if (unsubSpec) { unsubSpec(); unsubSpec = null; }
  poolCount = specItems.length;        // editörde değişmiş olabilir
  stageSig = null;
  render();
}

function drawSpectrums() {
  renderSpectrumList(specItems, {
    filter: $('#spec-search').value,
    onDelete: async (s) => {
      try { await spec.deleteSpectrum(s.id); }
      catch { toast('Silinemedi.'); }
    },
    onSeed: async () => {
      setHint('#spec-status', 'Yükleniyor…');
      try {
        const { added } = await spec.loadSeedPack();
        setHint('#spec-status', `${added} spektrum eklendi.`);
      } catch (e) { setHint('#spec-status', e.message, true); }
    },
  });
}

function wireSpectrums() {
  $('#btn-close-spectrums').addEventListener('click', closeSpectrums);
  $('#spec-search').addEventListener('input', drawSpectrums);

  $('#spec-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const l = $('#spec-in-left'), r = $('#spec-in-right');
    try {
      await spec.addSpectrum(l.value, r.value);
      l.value = ''; r.value = '';
      l.focus();
      setHint('#spec-status', 'Eklendi.');
    } catch (err) {
      setHint('#spec-status', err.message, true);
    }
  });

  $('#btn-spec-export').addEventListener('click', () => {
    if (!specItems.length) return setHint('#spec-status', 'İndirilecek bir şey yok.', true);
    spec.exportJson(specItems);
  });

  $('#btn-spec-import').addEventListener('click', () => $('#spec-file').click());
  $('#spec-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const items = spec.parseImport(await file.text());
      const { added, skipped } = await spec.addMany(items);
      setHint('#spec-status', `${added} eklendi, ${skipped} atlandı.`);
    } catch (err) {
      setHint('#spec-status', err.message, true);
    }
  });
}
