// Oyun akışı: mod, faz geçişleri, gizli hedef, ibreler, kilitleme, puan kaydı.
//
// Tasarım notu — neden sunucu kodu yok:
//  · Tüm faz geçişleri `rooms/{kod}/state` üzerinde TEK bir transaction'dır,
//    yani iki kişi aynı anda tetiklese bile ikinci deneme iptal olur.
//  · Gizli veriler (hedef ve bireysel moddaki tahmin ibreleri) güvenlik
//    kurallarıyla korunur; faz 'reveal' olduğu anda kural kendiliğinden açılır.
//  · Puan hiçbir yerde toplanmaz; her tur `history/{tur}` altına idempotent
//    yazılır, toplam istemcide türetilir.
//
// İki mod:
//  · shared — tek ortak ibre, tek ortak puan (klasik kooperatif).
//  · solo   — herkesin kendi ibresi ve kendi puanı; psişik ortalamayı alır.

import {
  dbRef, get, set, update, remove, onValue, runTransaction, uid, serverNow,
} from './firebase.js';
import { state, emit, onlinePlayers } from './room.js';
import { loadPool } from './spectrums.js';
import { randomTarget, scoreFor, shuffle, clampValue } from './scoring.js';
import {
  MODE, isMode, nextPsychic, mergeOrder, pickSpectrum,
  activeGuessers, allLocked, soloScores, psychicAverage,
} from './logic.js';

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
export const isSolo = () => mode() === MODE.SOLO;
export const isPsychic = () => !!state.game && state.game.psychicUid === uid();

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

export async function startGame() {
  const online = onlinePlayers().map(p => p.id);
  if (online.length < 2) throw new Error('En az 2 oyuncu gerekiyor.');
  const order = shuffle(online);
  const res = await runTransaction(stateRef(), (st) => {
    if (!st || st.phase !== 'lobby') return;
    st.phase = 'clue';
    st.roundIndex = 0;
    st.order = order;
    st.psychicUid = order[0];
    st.spectrum = null;
    st.clue = null;
    st.final = null;
    st.lockDeadline = null;
    st.dial = { value: 50, by: null, at: 0 };
    return st;
  });
  if (res.committed) await clearRoundData();
}

/** Yeni oyun: turlara göre indekslenen her şeyi sil. */
function clearRoundData() {
  return Promise.all([
    remove(dbRef(path('history'))),
    remove(dbRef(path('locks'))),
    remove(dbRef(path('guesses'))),
  ]);
}

/* ══════════ Tur açılışı (psişiğin cihazı yapar) ══════════ */

let drawing = false;

/** Faz 'clue' ve kart henüz çekilmemişse psişik kartı + gizli hedefi yazar. */
export async function ensureRoundDrawn() {
  const g = state.game;
  if (!g || g.phase !== 'clue' || g.spectrum || !isPsychic() || drawing) return;
  drawing = true;
  try {
    const pool = await loadPool();
    if (!pool.length) throw new Error('Spektrum havuzu boş. Önce spektrum ekleyin.');
    const usedSnap = await get(dbRef(path('usedSpectrumIds')));
    const picked = pickSpectrum(pool, usedSnap.val() || {});
    const target = randomTarget();

    // Gizli hedef önce yazılır: kart göründüğünde hedef mutlaka hazır olsun.
    await set(dbRef(path('secret/target')), target);
    rememberTarget(g.roundIndex, target);

    const res = await runTransaction(stateRef(), (st) => {
      if (!st || st.phase !== 'clue' || st.spectrum || st.psychicUid !== uid()) return;
      st.spectrum = {
        id: picked.spectrum.id,
        left: picked.spectrum.left,
        right: picked.spectrum.right,
      };
      st.dial = { value: 50, by: null, at: 0 };
      st.final = null;
      st.lockDeadline = null;
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
/** Bireysel modda kendi ibrem — yazması gecikse de arayüz anında tepki versin. */
let myGuessLocal = null;
let myGuessRound = -1;

/** Bireysel modda kendi ibremin bilinen değeri. */
export function myGuess() {
  if (myGuessRound === roundIndex() && myGuessLocal != null) return myGuessLocal;
  return null;
}

/** Bu turda kendi kilidim var mı (ortak modda güncel ibreye denk geliyor mu)? */
export function iLocked() {
  const g = state.game;
  if (!g) return false;
  const v = state.locks?.[g.roundIndex]?.[uid()];
  if (typeof v !== 'number') return false;
  if (isSolo()) return true;
  return Math.abs(v - (g.dial?.value ?? 50)) < 0.05;
}

/** Sürükleme sırasında çağrılır; saniyede ~7 yazımla sınırlanır. */
export function pushDial(value) {
  if (phase() !== 'guess' || iLocked()) return;
  if (isSolo()) { myGuessLocal = value; myGuessRound = roundIndex(); }
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
  const ref = isSolo()
    ? dbRef(path(`guesses/${roundIndex()}/${uid()}`))
    : dbRef(path('state/dial'));
  const payload = isSolo() ? value : { value, by: uid(), at: Date.now() };
  return set(ref, payload)
    .catch(() => { /* geçici bağlantı hatası: bir sonraki hareket düzeltir */ });
}

/* ══════════ Kilitleme ══════════ */

/**
 * Kendi onayımı basar. Kilit, basıldığı andaki ibre DEĞERİYLE saklanır;
 * ortak modda ibre sonradan oynarsa bu onay kendiliğinden geçersizleşir.
 */
export async function lockGuess() {
  const g = state.game;
  if (!g || g.phase !== 'guess' || isPsychic()) return false;
  const value = round1(isSolo() ? (myGuess() ?? 50) : (g.dial?.value ?? 50));

  if (isSolo()) {
    // Kilitleyen herkesin bir ibresi olsun (hiç dokunmadıysa 50).
    await set(dbRef(path(`guesses/${g.roundIndex}/${uid()}`)), value);
  } else {
    await flushDial();
  }
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

/** Bu turda kilitlemesi beklenenler. */
export function expectedGuessers() {
  return activeGuessers(state.players, state.game?.psychicUid);
}

/** Bu turun kilitleri. */
export function roundLocks() {
  return state.locks?.[roundIndex()] || {};
}

/** Herkes kilitledi mi? */
export function everyoneLocked() {
  const dialValue = isSolo() ? null : (state.game?.dial?.value ?? 50);
  return allLocked(roundLocks(), expectedGuessers(), dialValue);
}

/** Turu açar. Herkes kilitlediğinde veya süre dolduğunda çağrılır. */
async function revealNow() {
  const res = await runTransaction(stateRef(), (st) => {
    if (!st || st.phase !== 'guess') return;
    st.phase = 'reveal';
    st.lockDeadline = null;
    if (isMode(st.mode) === MODE.SHARED) {
      st.final = st.dial && Number.isFinite(st.dial.value) ? st.dial.value : 50;
    }
    return st;
  });
  return res.committed;
}

/* ══════════ Gizli hedef ══════════ */

const targetCache = new Map();
const keyFor = (idx) => `${state.code}:${idx}`;

function rememberTarget(idx, value) { targetCache.set(keyFor(idx), value); }

export function knownTarget() {
  const idx = state.game?.roundIndex;
  return idx == null ? null : (targetCache.get(keyFor(idx)) ?? null);
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
    if (typeof val === 'number') { rememberTarget(g.roundIndex, val); return val; }
    return null;
  } catch {
    return null;   // izin yok / bağlantı yok — bir sonraki döngüde tekrar denenir
  } finally {
    fetching = false;
  }
}

/* ══════════ Bireysel moddaki tahmin ibreleri ══════════ */

let feedUnsub = null;
let feedKey = null;
let feedData = {};

/**
 * Psişik, tahmin fazında herkesin ibresini canlı görür (tahminciler görmez —
 * bunu güvenlik kuralı zorlar). Abonelik faz/tur değişince yenilenir.
 */
function syncGuessFeed() {
  const g = state.game;
  const want = !!g && isSolo() && isPsychic() && g.phase === 'guess';
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
 * Kadranda gösterilecek tahmin ibreleri.
 * Açılışta history'den (herkeste aynı), tahmin fazında psişiğin canlı
 * akışından, diğer durumlarda yalnızca kendi ibrem.
 */
export function visibleGuesses() {
  const g = state.game;
  if (!g || !isSolo()) return {};
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
 * Tur sonucunu `history/{tur}` altına yazar. İçerik deterministiktir
 * (aynı hedef, aynı ibreler → aynı puanlar), bu yüzden hangi cihaz yazarsa
 * yazsın sonuç aynıdır ve iki kez yazılması zararsızdır.
 */
export async function writeHistory(target) {
  const g = state.game;
  if (!g || g.phase !== 'reveal' || target == null) return;
  const idx = g.roundIndex;
  if (state.history?.[idx]) return;

  const base = {
    clue: g.clue ?? '',
    left: g.spectrum?.left ?? '',
    right: g.spectrum?.right ?? '',
    spectrumId: g.spectrum?.id ?? '',
    psychicUid: g.psychicUid ?? '',
    mode: mode(),
    target,
  };

  let entry;
  if (isSolo()) {
    // Faz 'reveal' olduğu için kural gereği artık herkes okuyabilir.
    // Yazma ise yalnızca 'guess' fazında mümkün, yani liste artık sabit.
    const snap = await get(dbRef(path(`guesses/${idx}`)));
    const guesses = snap.val() || {};
    const points = soloScores(target, guesses);
    entry = { ...base, guesses, points, psychicPoints: psychicAverage(points) };
  } else {
    const dial = Number.isFinite(g.final) ? g.final : 50;
    entry = { ...base, dial, points: scoreFor(target, dial) };
  }

  await set(dbRef(path(`history/${idx}`)), entry)
    .catch(() => { /* başka cihaz yazmış olabilir */ });
}

let fallbackTimer = null;
/** Kilitleyen cihaz kopmuşsa kaydı bir başkası tamamlasın. */
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
  st.spectrum = null;
  st.clue = null;
  st.final = null;
  st.lockDeadline = null;
  st.dial = { value: 50, by: null, at: 0 };
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
    targetCache.clear();
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
 * Yeniden giriş: bir geçiş sürerken gelen durum değişimi ATILMAZ, sonunda
 * bir geçiş daha yapılır. Yoksa kendi yazdığımız faz değişimi (ör. turun
 * açılması) meşgulken gelir ve ardından yapılması gereken iş (sonucu
 * kaydetmek) hiç tetiklenmez.
 *
 * @returns {Promise<{changed:boolean, error?:string}>}
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
