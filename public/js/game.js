// Oyun akışı: mod, takımlar, faz geçişleri, gizli hedef, ibreler, kilitleme, puan.
//
// Tasarım notu — neden sunucu kodu yok:
//  · Tüm faz geçişleri `rooms/{kod}/state` üzerinde TEK bir transaction'dır,
//    yani iki kişi aynı anda tetiklese bile ikinci deneme iptal olur.
//  · Gizli veriler (hedef ve tahmin ibreleri) güvenlik kurallarıyla korunur;
//    faz 'reveal' olduğu anda kural kendiliğinden açılır.
//  · Puan hiçbir yerde toplanmaz; her tur `history/{tur}` altına idempotent
//    yazılır, toplam istemcide türetilir.
//
// İki mod — ikisinde de herkesin kendi ibresi var ve psişik hepsini canlı
// görür; fark yalnızca puanın nereye yazıldığı:
//  · solo — herkes kendi puanını toplar, psişik tüm tahmincilerin ortalamasını.
//  · team — puanlar takıma yazılır, psişik kendi takımdaşlarının ortalamasını.

import {
  dbRef, get, set, update, remove, onValue, runTransaction, uid, serverNow,
} from './firebase.js';
import { state, emit, onlinePlayers } from './room.js';
import { randomTarget, scoreFor, clampValue } from './scoring.js';
import {
  MODE, isMode, nextPsychic, mergeOrder, pickSpectrum,
  activeGuessers, allLocked, soloScores, psychicAverage,
} from './logic.js';
import {
  assignRandom, interleaveOrder, teamsBalanced, psychicTeamAverage, teamOf,
} from './teams.js';
import { resolveDeck } from './deck.js';
import { BUILTIN_CARDS } from './builtin.js';

const DIAL_THROTTLE_MS = 150;
const HISTORY_FALLBACK_MS = 1400;
/** İlk kilitten sonra turun otomatik açılmasına kalan süre. */
export const LOCK_COUNTDOWN_MS = 20000;

const path = (suffix) => `rooms/${state.code}/${suffix}`;
const stateRef = () => dbRef(path('state'));
const round1 = (v) => Math.round(clampValue(v) * 10) / 10;

export const phase = () => state.game?.phase ?? null;
export const roundIndex = () => state.game?.roundIndex ?? 0;
export const mode = () => isMode(state.game?.mode);
export const isTeamMode = () => mode() === MODE.TEAM;
export const isPsychic = () => !!state.game && state.game.psychicUid === uid();

/** Odanın destesi (yalnızca o turun psişiği okur). */
export const deckCards = () => resolveDeck(state.deck, BUILTIN_CARDS);

/* ══════════ Lobi ══════════ */

export async function setTotalRounds(n) {
  const rounds = Math.max(3, Math.min(20, Math.round(n)));
  await runTransaction(stateRef(), (st) => {
    if (!st || st.phase !== 'lobby') return;
    st.totalRounds = rounds;
    return st;
  });
}

export async function setMode(m) {
  const wanted = isMode(m);
  await runTransaction(stateRef(), (st) => {
    if (!st || st.phase !== 'lobby') return;
    st.mode = wanted;
    return st;
  });
}

/** Kendi takımını seçer. */
export async function setMyTeam(teamId) {
  const me = uid();
  await runTransaction(stateRef(), (st) => {
    if (!st || st.phase !== 'lobby') return;
    st.teams = { ...(st.teams || {}), [me]: teamId === 'b' ? 'b' : 'a' };
    return st;
  });
}

/** Kurucunun "Rastgele dağıt"ı: çevrimiçi herkesi iki takıma eşit böler. */
export async function shuffleTeams() {
  const online = onlinePlayers().map(p => p.id);
  const teams = assignRandom(online);
  await runTransaction(stateRef(), (st) => {
    if (!st || st.phase !== 'lobby') return;
    st.teams = teams;
    return st;
  });
}

export function teamState() {
  return state.game?.teams || {};
}

export function myTeam() {
  return teamOf(teamState(), state.me);
}

export async function startGame() {
  const online = onlinePlayers().map(p => p.id);
  if (online.length < 2) throw new Error('En az 2 oyuncu gerekiyor.');

  const teams = teamState();
  const teamMode = isTeamMode();
  if (teamMode) {
    const balance = teamsBalanced(teams, online);
    if (!balance.playable) {
      throw new Error('Takım modunda her takımda en az 2 oyuncu olmalı.');
    }
  }
  // Takım modunda sıra dönüşümlü kurulur; yoksa kalabalık takım daha çok
  // psişik sırası alıp avantaj kazanır.
  const order = teamMode ? interleaveOrder(teams, online) : shuffleIds(online);

  const res = await runTransaction(stateRef(), (st) => {
    if (!st || st.phase !== 'lobby') return;
    st.phase = 'clue';
    st.roundIndex = 0;
    st.order = order;
    st.psychicUid = order[0];
    resetRoundFields(st);
    return st;
  });
  if (res.committed) await clearRoundData();
}

function shuffleIds(ids) {
  const a = ids.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Yeni oyun: turlara göre indekslenen her şeyi sil. */
function clearRoundData() {
  return Promise.all([
    remove(dbRef(path('history'))),
    remove(dbRef(path('locks'))),
    remove(dbRef(path('guesses'))),
  ]);
}

/* ══════════ Deste ══════════ */

/** Odanın destesini değiştirir. Yalnızca kurucu, yalnızca lobide. */
export async function setDeck(deck) {
  await set(dbRef(path('deck')), deck);
}

/* ══════════ Tur açılışı (psişiğin cihazı yapar) ══════════ */

let drawing = false;

/** Faz 'clue' ve kart henüz çekilmemişse psişik kartı + gizli hedefi yazar. */
export async function ensureRoundDrawn() {
  const g = state.game;
  if (!g || g.phase !== 'clue' || g.spectrum || !isPsychic() || drawing) return;
  drawing = true;
  try {
    const pool = deckCards();
    if (!pool.length) throw new Error('Deste boş. Lobiden başka bir deste seç.');
    const usedSnap = await get(dbRef(path('usedSpectrumIds')));
    const picked = pickSpectrum(pool, usedSnap.val() || {});
    const target = randomTarget();
    // Her çekilişin benzersiz damgası. Hedef önbelleği buna bağlanır; tur
    // numarası yetmez, çünkü sıra atlanınca ya da yeniden oynanınca AYNI tur
    // numarasına yeni bir hedef gelir.
    const drawId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    // Gizli hedef önce yazılır: kart göründüğünde hedef mutlaka hazır olsun.
    await set(dbRef(path('secret/target')), target);
    rememberTarget(g.roundIndex, drawId, target);

    const res = await runTransaction(stateRef(), (st) => {
      if (!st || st.phase !== 'clue' || st.spectrum || st.psychicUid !== uid()) return;
      st.drawId = drawId;
      st.spectrum = {
        id: picked.spectrum.id,
        left: picked.spectrum.left,
        right: picked.spectrum.right,
      };
      return st;
    });

    if (res.committed) {
      if (picked.exhausted) await remove(dbRef(path('usedSpectrumIds')));
      await update(dbRef(path('usedSpectrumIds')), { [picked.spectrum.id]: true });
    }
  } finally {
    drawing = false;
  }
}

/* ══════════ İpucu ══════════ */

export async function submitClue(text) {
  const clue = String(text || '').trim().slice(0, 60);
  if (!clue) throw new Error('İpucu boş olamaz.');
  await runTransaction(stateRef(), (st) => {
    if (!st || st.phase !== 'clue' || st.psychicUid !== uid() || !st.spectrum) return;
    st.clue = clue;
    st.phase = 'guess';
    return st;
  });
}

/* ══════════ İbre ══════════ */

let lastSent = 0;
let pendingValue = null;
let flushTimer = null;
/** Kendi ibrem — yazması gecikse de arayüz anında tepki versin. */
let myGuessLocal = null;
let myGuessRound = -1;

export function myGuess() {
  if (myGuessRound === roundIndex() && myGuessLocal != null) return myGuessLocal;
  return null;
}

/** Bu turda kendi kilidim var mı? */
export function iLocked() {
  const g = state.game;
  if (!g) return false;
  return Number.isFinite(state.locks?.[g.roundIndex]?.[uid()]);
}

/** Sürükleme sırasında çağrılır; saniyede ~7 yazımla sınırlanır. */
export function pushDial(value) {
  if (phase() !== 'guess' || isPsychic() || iLocked()) return;
  myGuessLocal = value;
  myGuessRound = roundIndex();
  pendingValue = value;
  const wait = DIAL_THROTTLE_MS - (Date.now() - lastSent);
  if (wait <= 0) { flushDial(); return; }
  if (!flushTimer) flushTimer = setTimeout(flushDial, wait);
}

/** Parmak kalkınca son değeri kesin olarak yazar. */
export function flushDial() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (pendingValue == null || phase() !== 'guess') { pendingValue = null; return; }
  const value = round1(pendingValue);
  pendingValue = null;
  lastSent = Date.now();
  return set(dbRef(path(`guesses/${roundIndex()}/${uid()}`)), value)
    .catch(() => { /* geçici bağlantı hatası: bir sonraki hareket düzeltir */ });
}

/* ══════════ Kilitleme ══════════ */

export async function lockGuess() {
  const g = state.game;
  if (!g || g.phase !== 'guess' || isPsychic()) return false;
  const value = round1(myGuess() ?? 50);
  // Kilitleyen herkesin bir ibresi olsun (hiç dokunmadıysa 50).
  await set(dbRef(path(`guesses/${g.roundIndex}/${uid()}`)), value);
  await set(dbRef(path(`locks/${g.roundIndex}/${uid()}`)), value);
  await startCountdown();
  return true;
}

/** Kendi onayımı geri çeker (fikir değiştirenler için). */
export async function unlockGuess() {
  const g = state.game;
  if (!g || g.phase !== 'guess') return;
  await remove(dbRef(path(`locks/${g.roundIndex}/${uid()}`)));
}

/** İlk kilitte geri sayımı başlatır; zaten varsa dokunmaz. */
function startCountdown() {
  return runTransaction(stateRef(), (st) => {
    if (!st || st.phase !== 'guess' || st.lockDeadline) return;
    st.lockDeadline = serverNow() + LOCK_COUNTDOWN_MS;
    return st;
  });
}

/** Geri sayımdan kalan süre (ms). Sayaç yoksa null. */
export function countdownLeft() {
  const dl = state.game?.lockDeadline;
  if (!dl || phase() !== 'guess') return null;
  return Math.max(0, dl - serverNow());
}

export function expectedGuessers() {
  return activeGuessers(state.players, state.game?.psychicUid);
}

export function roundLocks() {
  return state.locks?.[roundIndex()] || {};
}

export function everyoneLocked() {
  return allLocked(roundLocks(), expectedGuessers());
}

/** Turu açar. Herkes kilitlediğinde veya süre dolduğunda çağrılır. */
async function revealNow() {
  const res = await runTransaction(stateRef(), (st) => {
    if (!st || st.phase !== 'guess') return;
    st.phase = 'reveal';
    st.lockDeadline = null;
    return st;
  });
  return res.committed;
}

/* ══════════ Gizli hedef ══════════ */

/**
 * Hedef önbelleği. Yalnızca TEK bir çekilişe aittir ve `drawId` ile doğrulanır:
 * sıra atlandığında ve "Tekrar Oyna"dan sonra aynı tur numarasına YENİ bir
 * hedef çekilir, tur numarasına dayanan önbellek bayat kalırdı.
 */
let cachedTarget = null;   // { code, round, drawId, value }

const currentDrawId = () => state.game?.drawId ?? null;

function rememberTarget(round, drawId, value) {
  cachedTarget = { code: state.code, round, drawId, value };
}

export function knownTarget() {
  const g = state.game;
  if (!g || !cachedTarget) return null;
  if (cachedTarget.code !== state.code) return null;
  if (cachedTarget.round !== g.roundIndex) return null;
  if (cachedTarget.drawId !== currentDrawId()) return null;
  return cachedTarget.value;
}

let fetching = false;

/**
 * Hedefi okumaya çalışır. İzin kuralı gereği yalnızca psişik için (her zaman)
 * veya faz 'reveal' iken (herkes için) başarılı olur.
 */
export async function fetchTarget() {
  const g = state.game;
  if (!g) return null;
  const cached = knownTarget();
  if (cached != null) return cached;
  const allowed = isPsychic() || g.phase === 'reveal';
  if (!allowed || fetching) return null;
  fetching = true;
  try {
    const snap = await get(dbRef(path('secret/target')));
    const val = snap.val();
    if (typeof val === 'number') {
      rememberTarget(g.roundIndex, currentDrawId(), val);
      return val;
    }
    return null;
  } catch {
    return null;   // izin yok / bağlantı yok — bir sonraki döngüde tekrar denenir
  } finally {
    fetching = false;
  }
}

/* ══════════ Tahmin ibreleri ══════════ */

let feedUnsub = null;
let feedKey = null;
let feedData = {};

/**
 * Psişik, tahmin fazında herkesin ibresini canlı görür (tahminciler görmez —
 * bunu güvenlik kuralı zorlar). Abonelik faz/tur değişince yenilenir.
 */
function syncGuessFeed() {
  const g = state.game;
  const want = !!g && isPsychic() && g.phase === 'guess';
  const key = want ? `${state.code}:${g.roundIndex}` : null;
  if (key === feedKey) return;

  if (feedUnsub) { try { feedUnsub(); } catch { /* yoksay */ } feedUnsub = null; }
  feedData = {};
  feedKey = key;
  if (!key) { emit(); return; }

  feedUnsub = onValue(dbRef(path(`guesses/${g.roundIndex}`)), (snap) => {
    feedData = snap.val() || {};
    emit();
  }, () => { /* izin kalmadı (tur değişti): sessizce bırak */ });
}

/**
 * Kadranda gösterilecek tahmin ibreleri: açılışta history'den (herkeste aynı),
 * tahmin fazında psişiğin canlı akışından, diğer durumlarda yalnızca kendi ibrem.
 */
export function visibleGuesses() {
  const g = state.game;
  if (!g) return {};
  if (g.phase === 'reveal') {
    const h = state.history?.[g.roundIndex];
    if (h?.guesses) return h.guesses;
  }
  if (isPsychic()) return feedData;
  const mine = myGuess();
  return mine == null ? {} : { [uid()]: mine };
}

/* ══════════ Tur sonucu ══════════ */

/**
 * Tur sonucunu `history/{tur}` altına yazar. İçerik deterministiktir (aynı
 * hedef, aynı ibreler → aynı puanlar), bu yüzden hangi cihaz yazarsa yazsın
 * sonuç aynıdır ve iki kez yazılması zararsızdır.
 */
export async function writeHistory(target) {
  const g = state.game;
  if (!g || g.phase !== 'reveal' || target == null) return;
  const idx = g.roundIndex;
  if (state.history?.[idx]) return;

  // Faz 'reveal' olduğu için kural gereği artık herkes okuyabilir. Yazma ise
  // yalnızca 'guess' fazında mümkün, yani liste artık sabit.
  const snap = await get(dbRef(path(`guesses/${idx}`)));
  const guesses = snap.val() || {};
  const points = soloScores(target, guesses);
  const teams = teamState();

  const entry = {
    clue: g.clue ?? '',
    left: g.spectrum?.left ?? '',
    right: g.spectrum?.right ?? '',
    spectrumId: g.spectrum?.id ?? '',
    psychicUid: g.psychicUid ?? '',
    mode: mode(),
    target,
    guesses,
    points,
    psychicPoints: isTeamMode()
      ? psychicTeamAverage(points, teams, g.psychicUid)
      : psychicAverage(points),
  };
  // Takım dağılımını turla birlikte sakla: biri sonradan takım değiştirse
  // bile geçmiş turların puanı kaymaz.
  if (isTeamMode()) entry.teams = teams;

  await set(dbRef(path(`history/${idx}`)), entry)
    .catch(() => { /* başka cihaz yazmış olabilir */ });
}

let fallbackTimer = null;
/** Turu açan cihaz kopmuşsa kaydı bir başkası tamamlasın. */
export function scheduleHistoryFallback() {
  if (fallbackTimer) return;
  fallbackTimer = setTimeout(async () => {
    fallbackTimer = null;
    const g = state.game;
    if (!g || g.phase !== 'reveal' || state.history?.[g.roundIndex]) return;
    const t = await fetchTarget();
    if (t != null) await writeHistory(t);
  }, HISTORY_FALLBACK_MS);
}

/* ══════════ Tur geçişi ══════════ */

function resetRoundFields(st) {
  st.drawId = null;
  st.spectrum = null;
  st.clue = null;
  st.lockDeadline = null;
}

/** Oyun başladıktan sonra katılanlara da takım ver ki puanları sayılsın. */
function fillMissingTeams(st, online) {
  if (isMode(st.mode) !== MODE.TEAM) return;
  const teams = { ...(st.teams || {}) };
  let a = 0, b = 0;
  for (const t of Object.values(teams)) { if (t === 'a') a++; else if (t === 'b') b++; }
  for (const id of online) {
    if (teams[id] === 'a' || teams[id] === 'b') continue;
    if (a <= b) { teams[id] = 'a'; a++; } else { teams[id] = 'b'; b++; }
  }
  st.teams = teams;
}

/** Sonraki tura geçer; turlar bittiyse oyunu bitirir. */
export async function nextRound() {
  const online = onlinePlayers().map(p => p.id);
  await runTransaction(stateRef(), (st) => {
    if (!st || st.phase !== 'reveal') return;
    const idx = st.roundIndex + 1;
    if (idx >= st.totalRounds) { st.phase = 'gameover'; st.lockDeadline = null; return st; }
    const order = mergeOrder(st.order, online);
    st.roundIndex = idx;
    st.order = order;
    st.psychicUid = nextPsychic(order, st.psychicUid, online);
    fillMissingTeams(st, online);
    resetRoundFields(st);
    st.phase = 'clue';
    return st;
  });
}

/** Psişik kaybolduysa: turu kaybetmeden sırayı bir sonrakine devret. */
export async function skipPsychic() {
  const online = onlinePlayers().map(p => p.id);
  await runTransaction(stateRef(), (st) => {
    if (!st || st.phase !== 'clue') return;
    const order = mergeOrder(st.order, online);
    st.order = order;
    st.psychicUid = nextPsychic(order, st.psychicUid, online);
    fillMissingTeams(st, online);
    resetRoundFields(st);
    return st;
  });
}

/** Oyun sonundan lobiye dön. */
export async function restart() {
  const res = await runTransaction(stateRef(), (st) => {
    if (!st || st.phase !== 'gameover') return;
    st.phase = 'lobby';
    st.roundIndex = 0;
    st.order = null;
    st.psychicUid = null;
    resetRoundFields(st);
    return st;
  });
  if (res.committed) {
    cachedTarget = null;
    myGuessLocal = null;
    myGuessRound = -1;
    await clearRoundData();
  }
}

/* ══════════ Yan etki döngüsü ══════════ */

let effectBusy = false;
let effectAgain = false;
const MAX_PASSES = 6;

/**
 * Duruma bakıp o an gereken yazımları yapar. Her durum değişiminde çağrılır.
 * Arayüzden bağımsızdır; uçtan uca testler de bunu çalıştırır.
 *
 * Yeniden giriş: bir geçiş sürerken gelen durum değişimi ATILMAZ, sonunda bir
 * geçiş daha yapılır. Yoksa kendi yazdığımız faz değişimi (ör. turun açılması)
 * meşgulken gelir ve ardından yapılması gereken iş hiç tetiklenmez.
 */
export async function runSideEffects() {
  if (effectBusy) { effectAgain = true; return { changed: false }; }
  if (!state.game) return { changed: false };

  effectBusy = true;
  let changed = false;
  let error = null;
  try {
    for (let i = 0; i < MAX_PASSES; i++) {
      effectAgain = false;
      const r = await onePass();
      changed = changed || r.changed;
      error = error || r.error;
      if (!effectAgain && !r.changed) break;
    }
  } finally {
    effectBusy = false;
  }
  return { changed, error };
}

/** Tek geçiş. Her adımda durumu TAZE okur — geçiş sırasında değişebilir. */
async function onePass() {
  let changed = false;
  let error = null;

  syncGuessFeed();

  // 1) Psişiksem ve kart henüz çekilmediyse çek
  let g = state.game;
  if (g && g.phase === 'clue' && g.psychicUid === uid() && !g.spectrum) {
    try { await ensureRoundDrawn(); changed = true; }
    catch (e) { error = e.message; }
  }

  // 2) Hedefi görmeye hakkım varsa ve elimde yoksa oku
  g = state.game;
  if (g && knownTarget() == null &&
      ((g.psychicUid === uid() && g.spectrum) || g.phase === 'reveal')) {
    if (await fetchTarget() != null) changed = true;
  }

  // 3) Tahmin fazı bitti mi? (herkes kilitledi ya da süre doldu)
  g = state.game;
  if (g && g.phase === 'guess') {
    const expired = g.lockDeadline != null && countdownLeft() === 0;
    if (everyoneLocked() || expired) {
      if (await revealNow()) changed = true;
    }
  }

  // 4) Tur açıldıysa sonucu kaydet (idempotent)
  g = state.game;
  if (g && g.phase === 'reveal' && !state.history?.[g.roundIndex]) {
    const t = knownTarget() ?? await fetchTarget();
    if (t != null) { await writeHistory(t); changed = true; }
    scheduleHistoryFallback();
  }

  return { changed, error };
}
