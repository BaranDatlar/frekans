// Uygulamanın kablolaması: kimlik kapısı, ekranlar, oyun sahnesinin çizimi.

import {
  initAuth, onUser, signInGoogle, signInGuest, signOutUser,
  currentUser, isGuest, canCreateRooms, canSavePacks, providerName,
  takeRedirectError,
} from './auth.js';
import {
  state, subscribe, createRoom, joinRoom, leaveRoom, closeRoom, normalizeCode,
  playerList, hostId, ownerId, iAmOwner, onlinePlayers, playerName, isOnline,
  colorFor, sweepExpiredRooms,
} from './room.js';
import * as game from './game.js';
import * as packs from './packs.js';
import { MODE, soloTotals, soloScores, psychicAverage, lockedGuessers } from './logic.js';
import { TEAM_META, teamOf, teamTotals, psychicTeamAverage } from './teams.js';
import { SOURCE, validatePack, normalizeSide } from './deck.js';
import { scoreFor } from './scoring.js';
import { Dial } from './dial.js';
import {
  $, showScreen, toast, setHint, el,
  renderLobby, renderOver, renderPacksList, renderCardList,
} from './ui.js';

const NAME_KEY = 'frekans.name';
const SKIP_DELAY_MS = 10000;

let dial = null;
let packsOpen = false;
let myPacks = [];
let unsubPacks = null;
let editing = null;          // { id|null, name, cards }
let stageSig = null;
let shownTarget = null;
let clueEnteredAt = 0;
let heartbeat = null;
let joinedAt = 0;

/* ══════════════════ Başlangıç ══════════════════ */

export async function start() {
  await initAuth();

  dial = new Dial($('#dial'), {
    onInput: (v) => game.pushDial(v),
    onCommit: (v) => { game.pushDial(v); game.flushDial(); },
  });

  wireLogin();
  wireHome();
  wireLobby();
  wireOver();
  wirePacks();

  subscribe(render);
  onUser(onUserChanged);

  const err = takeRedirectError();
  if (err) setHint('#login-status', err, true);
}

/** Kimlik değişince: ekranı ve kişiye bağlı verileri tazele. */
function onUserChanged(user) {
  if (unsubPacks) { unsubPacks(); unsubPacks = null; }
  myPacks = [];

  if (!user) {
    if (state.code) leaveRoom({ notify: false });
    showScreen('login');
    return;
  }

  $('#input-name').value = savedName();
  $('#account-label').textContent = isGuest()
    ? 'Misafir olarak giriş yaptın'
    : (currentUser()?.email || providerName() || 'Giriş yapıldı');

  if (canSavePacks()) {
    myPacks = packs.cachedPacks();
    unsubPacks = packs.subscribePacks((list) => { myPacks = list; drawPacks(); render(); });
  }

  sweepExpiredRooms().catch(() => {});
  render();
  maybeAutoJoin();
}

function savedName() {
  const stored = (localStorage.getItem(NAME_KEY) || '').trim();
  return stored || providerName();
}

let autoJoined = false;
async function maybeAutoJoin() {
  if (autoJoined || state.code) return;
  const code = normalizeCode(new URLSearchParams(location.search).get('oda') || '');
  if (!code) return;
  $('#input-code').value = code;
  const name = savedName();
  if (!name) return;
  autoJoined = true;
  await doJoin(code, name);
}

/* ══════════════════ Giriş ekranı ══════════════════ */

function wireLogin() {
  $('#btn-google').addEventListener('click', () =>
    guarded('#login-status', '#btn-google', () => signInGoogle()));
  $('#btn-guest').addEventListener('click', () =>
    guarded('#login-status', '#btn-guest', () => signInGuest()));
}

/* ══════════════════ Ana ekran ══════════════════ */

function currentName() {
  return $('#input-name').value.trim().slice(0, 14);
}

function rememberName(n) {
  localStorage.setItem(NAME_KEY, n);
  packs.saveProfileName(n);
}

function wireHome() {
  $('#btn-create').addEventListener('click', async () => {
    if (!canCreateRooms()) {
      return setHint('#home-status',
        'Oda kurmak için Google ile giriş yapmalısın. Misafir olarak odalara katılabilirsin.', true);
    }
    const name = currentName();
    if (!name) return setHint('#home-status', 'Önce adını yaz.', true);
    rememberName(name);
    await guarded('#home-status', '#btn-create', async () => {
      joinedAt = Date.now();
      await sweepExpiredRooms().catch(() => {});
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

  $('#btn-open-packs').addEventListener('click', openPacks);

  $('#btn-signout').addEventListener('click', async () => {
    if (state.code) await leaveRoom();
    history.replaceState(null, '', location.pathname);
    localStorage.removeItem(NAME_KEY);
    autoJoined = false;
    await signOutUser();
  });
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
  const btn = btnSel ? $(btnSel) : null;
  if (btn) btn.disabled = true;
  setHint(hintSel, '');
  try {
    await fn();
  } catch (err) {
    // Beklenen kullanıcı hataları program hatası değil; konsolu kirletmesin.
    console.warn('[Frekans]', err?.message || err);
    setHint(hintSel, friendlyError(err), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function friendlyError(err) {
  const msg = String(err?.message || err || '');
  if (/permission[_ ]denied/i.test(msg)) {
    return 'Sunucu isteği reddetti. Sayfayı yenileyip tekrar dene.';
  }
  if (/network|offline|unavailable/i.test(msg)) {
    return 'Bağlantı kurulamadı. İnternetini kontrol et.';
  }
  return msg || 'Bir şeyler ters gitti.';
}

/* ══════════════════ Lobi ══════════════════ */

function wireLobby() {
  for (const sel of ['#btn-leave-lobby', '#btn-leave-game', '#btn-leave-over']) {
    wireLeaveButton(sel);
  }

  $('#input-rounds').addEventListener('input', (e) => {
    $('#rounds-value').textContent = e.target.value;
  });
  $('#input-rounds').addEventListener('change', (e) => {
    game.setTotalRounds(Number(e.target.value)).catch(() => {});
  });

  $('#btn-start').addEventListener('click', async () => {
    await guarded('#lobby-hint', '#btn-start', () => game.startGame());
  });

  for (const btn of $$mode('#mode-picker')) {
    btn.addEventListener('click', () => game.setMode(btn.dataset.mode).catch(e => toast(e.message)));
  }
  for (const btn of $$mode('#deck-picker')) {
    btn.addEventListener('click', () => applyDeck(btn.dataset.deck).catch(e => toast(e.message)));
  }
  $('#deck-pack').addEventListener('change', () => {
    const source = state.deck?.source;
    if (source && source !== SOURCE.BUILTIN) applyDeck(source).catch(e => toast(e.message));
  });
  $('#btn-shuffle-teams').addEventListener('click', () =>
    game.shuffleTeams().catch(e => toast(e.message)));

  $('#btn-lobby-packs')?.addEventListener('click', openPacks);

  $('#btn-share').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?oda=${state.code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Frekans', text: `Oda kodu: ${state.code}`, url });
      else { await navigator.clipboard.writeText(url); toast('Bağlantı kopyalandı'); }
    } catch { /* kullanıcı vazgeçti */ }
  });
}

const $$mode = (sel) => Array.from(document.querySelectorAll(`${sel} .mode-opt`));

/** Kurucunun deste seçimi. */
async function applyDeck(source) {
  if (source === SOURCE.BUILTIN) {
    await game.setDeck({ source: SOURCE.BUILTIN });
    return;
  }
  const packId = $('#deck-pack').value || myPacks[0]?.id;
  const pack = myPacks.find(p => p.id === packId);
  if (!pack) throw new Error('Önce Setlerim\'den bir set oluştur.');
  await game.setDeck({ source, name: pack.name, cards: pack.cards });
}

/**
 * Geri düğmesi. Odayı kuran çıkarsa oda kapanır, o yüzden yanında başkası
 * varken tek dokunuşla kapanmasın: ikinci dokunuş onaydır.
 */
function wireLeaveButton(sel) {
  const btn = $(sel);
  let armed = false;
  let timer = null;
  const disarm = () => { armed = false; btn.classList.remove('armed'); btn.textContent = '←'; };

  btn.addEventListener('click', async () => {
    if (!iAmOwner()) { await exitRoom(); return; }
    if (onlinePlayers().filter(p => p.id !== state.me).length === 0) {
      await closeAndGoHome();
      return;
    }
    if (armed) { clearTimeout(timer); disarm(); await closeAndGoHome(); return; }
    armed = true;
    btn.classList.add('armed');
    btn.textContent = '✕';
    toast('Odayı kapatmak için tekrar dokun — herkes çıkacak.', 4000);
    timer = setTimeout(disarm, 4000);
  });
}

async function closeAndGoHome() {
  await closeRoom();
  history.replaceState(null, '', location.pathname);
  resetRoomUi();
  showScreen('home');
  toast('Oda kapatıldı.');
}

function resetRoomUi() {
  stageSig = null;
  shownTarget = null;
  joinedAt = 0;
  autoJoined = true;
}

async function exitRoom(opts) {
  await leaveRoom(opts);
  history.replaceState(null, '', location.pathname);
  resetRoomUi();
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
  if (!currentUser()) { showScreen('login'); stopHeartbeat(); return; }

  $('#offline').hidden = !state.code || state.connected;

  if (packsOpen) { showScreen('packs'); return; }

  if (!state.code) {
    showScreen('home');
    stopHeartbeat();
    $('#btn-create').disabled = !canCreateRooms();
    if (!canCreateRooms()) {
      setHint('#home-status', 'Misafir olarak odalara katılabilirsin. Oda kurmak için Google ile gir.');
    }
    return;
  }

  if (state.roomGone) {
    stopHeartbeat();
    toast('Oda kapandı.', 4000);
    exitRoom({ notify: false });
    return;
  }

  if (state.game?.phase === 'closed') {
    stopHeartbeat();
    toast(`${playerName(ownerId())} odayı kapattı.`, 4000);
    exitRoom({ notify: false });
    return;
  }

  if (!state.game) {
    showScreen('boot');
    setHint('#boot-status', 'Odaya giriliyor…');
    if (Date.now() - joinedAt > 8000) { toast('Oda bulunamadı.'); exitRoom(); }
    else startHeartbeat();
    return;
  }

  const phase = state.game.phase;
  if (phase === 'lobby') {
    stopHeartbeat();
    showScreen('lobby');
    renderLobby(state, {
      players: playerList(),
      hostId: hostId(),
      iAmHost: hostId() === state.me,
      packs: myPacks,
      onTeamPick: (t) => game.setMyTeam(t).catch(e => toast(e.message)),
    });
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

function startHeartbeat() {
  // Faz içi zamana bağlı öğeler (geri sayım, "Sırayı atla") için.
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
  const locked = game.iLocked();
  const guesses = game.visibleGuesses();
  const teamMode = game.isTeamMode();

  $('#game-round-label').textContent = `Tur ${g.roundIndex + 1}/${g.totalRounds}`;
  $('#game-score').textContent = myScore();
  $('#spec-left').textContent = g.spectrum?.left ?? '—';
  $('#spec-right').textContent = g.spectrum?.right ?? '—';

  // Sürükleme: tahmin fazında, psişik değilsen ve henüz kilitlemediysen
  dial.setInteractive(g.phase === 'guess' && !psychic && !locked);

  // Psişiğin kendi ibresi yok; diğerlerini renkli "hayalet" ibre olarak görür.
  dial.setMainVisible(!psychic);
  if (!psychic) dial.setRemoteValue(guesses[me] ?? game.myGuess() ?? 50);
  dial.setGhosts(Object.entries(guesses)
    .filter(([id]) => id !== me)
    .map(([id, value]) => ({ id, value, color: colorFor(id) })));

  renderLegend(guesses, teamMode);

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

/** Üst bardaki puan: bireyselde kendi puanım, takımda takımımın puanı. */
function myScore() {
  if (game.isTeamMode()) {
    const t = game.myTeam();
    return t ? teamTotals(state.history)[t] : 0;
  }
  return soloTotals(state.history)[state.me] || 0;
}

/** Kadranın altındaki renk açıklaması. */
function renderLegend(guesses, teamMode) {
  const box = $('#legend');
  const ids = Object.keys(guesses);
  if (!ids.length) { box.hidden = true; box.textContent = ''; return; }
  box.hidden = false;
  box.textContent = '';
  const teams = game.teamState();
  for (const id of ids) {
    const item = el('span');
    const dot = el('i');
    dot.style.background = id === state.me ? '#e7ecf3' : colorFor(id);
    item.append(dot, document.createTextNode(id === state.me ? 'sen' : playerName(id)));
    if (teamMode) {
      const t = teamOf(teams, id);
      if (t) {
        const tag = el('span', 'team-tag', TEAM_META[t].name);
        tag.style.color = TEAM_META[t].color;
        item.append(tag);
      }
    }
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

  const status = el('div', 'lock-status');
  status.id = 'lock-status';
  stage.append(status);

  if (psychic) {
    stage.append(el('p', 'waiting', 'Sessiz kal! Herkes kendi tahminini yapıyor.'));
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

  const teamMode = game.isTeamMode();
  const teams = game.teamState();
  const guesses = game.visibleGuesses();
  // Puanı history'yi beklemeden yerel hesapla: aynı saf fonksiyon, aynı hedef
  // ve aynı ibreler → her cihazda aynı sonuç.
  const points = soloScores(target, guesses);
  const psyPoints = teamMode
    ? psychicTeamAverage(points, teams, g.psychicUid)
    : psychicAverage(points);

  const own = state.me === g.psychicUid ? psyPoints : (points[state.me] ?? 0);
  const burst = el('div', 'points-burst');
  burst.append(
    el('div', 'num' + (own ? '' : ' zero'), `+${own}`),
    el('div', 'lbl', state.me === g.psychicUid
      ? (teamMode ? 'takımına anlatım puanın' : 'ortalama — anlatım puanın')
      : own === 4 ? 'Tam isabet!' : own ? 'puan' : 'Hedefin dışında'));
  stage.append(burst);

  stage.append(buildRoundTable(g, points, psyPoints, teamMode, teams));

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

function buildRoundTable(g, points, psyPoints, teamMode, teams) {
  const list = el('ul', 'rank-list');
  const rows = Object.entries(points)
    .map(([id, pts]) => ({ id, pts, name: playerName(id) }))
    .concat([{ id: g.psychicUid, pts: psyPoints, name: `${playerName(g.psychicUid)} (psişik)` }]);

  if (teamMode) {
    rows.sort((a, b) => (teamOf(teams, a.id) || 'z').localeCompare(teamOf(teams, b.id) || 'z')
      || b.pts - a.pts);
  } else {
    rows.sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name, 'tr'));
  }

  for (const r of rows) {
    const li = el('li');
    if (r.id === state.me) li.classList.add('me');
    const dot = el('span', 'dot');
    dot.style.background = r.id === state.me ? '#e7ecf3' : colorFor(r.id);
    li.append(dot, el('span', 'nm', r.name));
    if (teamMode) {
      const t = teamOf(teams, r.id);
      if (t) {
        const tag = el('span', 'team-tag', TEAM_META[t].name);
        tag.style.color = TEAM_META[t].color;
        li.append(tag);
      }
    }
    const pts = el('span', 'pts', `+${r.pts}`);
    pts.dataset.p = String(r.pts);
    li.append(pts);
    list.append(li);
  }
  return list;
}

/** Sahneyi yeniden kurmadan güncellenen küçük parçalar. */
function updateStageLive(g, psychic) {
  if (g.phase === 'guess') {
    const status = $('#lock-status');
    if (status) {
      status.textContent = '';
      const expected = game.expectedGuessers();
      const done = lockedGuessers(game.roundLocks(), expected).length;

      const line = el('span');
      line.append(el('b', null, `${done}/${expected.length}`),
        document.createTextNode(' kilitledi'));
      status.append(line);

      const left = game.countdownLeft();
      if (left != null) {
        status.append(document.createTextNode(' · '));
        status.append(el('span', 'countdown', `${Math.ceil(left / 1000)} sn`));
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

/* ══════════════════ Setlerim ══════════════════ */

function openPacks() {
  packsOpen = true;
  editing = null;
  showScreen('packs');
  drawPacks();
  if (canSavePacks()) packs.loadPacks().then((list) => { myPacks = list; drawPacks(); });
}

function closePacks() {
  if (editing) { editing = null; drawPacks(); return; }   // önce editörden çık
  packsOpen = false;
  stageSig = null;
  render();
}

function drawPacks() {
  const editingNow = !!editing;
  $('#packs-list-view').hidden = editingNow;
  $('#packs-edit-view').hidden = !editingNow;
  $('#packs-title').textContent = editingNow ? (editing.id ? 'Seti düzenle' : 'Yeni set') : 'Setlerim';

  if (!editingNow) {
    setHint('#packs-status', canSavePacks()
      ? 'Oluşturduğun setler hesabına kaydedilir; lobide "Deste" bölümünden yükleyebilirsin.'
      : '');
    $('#btn-pack-new').disabled = !canSavePacks();
    $('#btn-pack-import').disabled = !canSavePacks();
    renderPacksList(myPacks, { canSave: canSavePacks(), onOpen: openEditor });
    return;
  }

  $('#btn-pack-delete').hidden = !editing.id;
  renderCardList(editing.cards, (i) => {
    editing.cards.splice(i, 1);
    drawPacks();
  });
}

function openEditor(pack) {
  editing = pack
    ? { id: pack.id, name: pack.name, cards: pack.cards.map(c => ({ ...c })) }
    : { id: null, name: '', cards: [] };
  // Ad alanı yalnızca burada doldurulur: her yeniden çizimde yazılanı
  // silmemesi için drawPacks ona dokunmaz.
  $('#pack-name').value = editing.name;
  drawPacks();
}

function wirePacks() {
  $('#btn-close-packs').addEventListener('click', closePacks);
  $('#btn-pack-new').addEventListener('click', () => openEditor(null));
  $('#pack-name').addEventListener('input', (e) => {
    if (editing) editing.name = e.target.value;
  });

  $('#card-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const l = normalizeSide($('#card-left').value);
    const r = normalizeSide($('#card-right').value);
    if (!l || !r) return setHint('#pack-status', 'İki uç da dolu olmalı.', true);
    if (l.toLocaleLowerCase('tr') === r.toLocaleLowerCase('tr')) {
      return setHint('#pack-status', 'İki uç aynı olamaz.', true);
    }
    editing.cards.unshift({ l, r });
    $('#card-left').value = '';
    $('#card-right').value = '';
    $('#card-left').focus();
    setHint('#pack-status', '');
    drawPacks();
  });

  $('#btn-pack-save').addEventListener('click', async () => {
    editing.name = $('#pack-name').value;   // yazılan son hâli al
    await guarded('#pack-status', '#btn-pack-save', async () => {
      validatePack(editing);                       // erken ve anlaşılır hata
      await packs.savePack(editing);
      myPacks = await packs.loadPacks();
      editing = null;
      drawPacks();
      toast('Set kaydedildi.');
    });
  });

  $('#btn-pack-delete').addEventListener('click', async () => {
    const btn = $('#btn-pack-delete');
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = 'Emin misin?';
      setTimeout(() => { btn.dataset.armed = '0'; btn.textContent = 'Seti sil'; }, 3000);
      return;
    }
    btn.dataset.armed = '0';
    btn.textContent = 'Seti sil';
    await guarded('#pack-status', '#btn-pack-delete', async () => {
      await packs.deletePack(editing.id);
      myPacks = await packs.loadPacks();
      editing = null;
      drawPacks();
      toast('Set silindi.');
    });
  });

  $('#btn-pack-export').addEventListener('click', () => {
    packs.exportPack({ name: $('#pack-name').value || 'set', cards: editing.cards });
  });

  $('#btn-pack-import').addEventListener('click', () => $('#pack-file').click());
  $('#pack-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = packs.parseImport(await file.text(), file.name.replace(/\.json$/i, ''));
      openEditor({ id: null, name: parsed.name, cards: parsed.cards });
      setHint('#pack-status', `${parsed.cards.length} kart okundu. Kaydetmeyi unutma.`);
    } catch (err) {
      setHint('#packs-status', err.message, true);
    }
  });
}
