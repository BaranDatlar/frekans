// Oyun akışı: faz geçişleri, gizli hedef, ibre senkronu, puan kaydı.
//
// Tasarım notu — neden sunucu kodu yok:
//  · Tüm faz geçişleri `rooms/{kod}/state` düğümü üzerinde TEK bir transaction'dır,
//    yani iki kişi aynı anda basarsa bile ikinci deneme iptal olur.
//  · Gizli hedef `rooms/{kod}/secret/target` altındadır ve güvenlik kuralı gereği
//    sadece psişik okuyabilir; faz 'reveal' olduğu anda herkese açılır.
//  · Puan hiçbir yerde toplanmaz; her tur `history/{tur}` altına idempotent yazılır,
//    toplam istemcide türetilir. Böylece "puan iki kez eklendi" hatası imkânsızdır.

import { dbRef, get, set, update, remove, runTransaction, uid } from './firebase.js';
import { state, onlinePlayers } from './room.js';
import { loadPool } from './spectrums.js';
import { randomTarget, scoreFor, shuffle } from './scoring.js';
import { nextPsychic, mergeOrder, pickSpectrum } from './logic.js';

const DIAL_THROTTLE_MS = 150;
const HISTORY_FALLBACK_MS = 1400;

const path = (suffix) => `rooms/${state.code}/${suffix}`;
const stateRef = () => dbRef(path('state'));

export const isPsychic = () => !!state.game && state.game.psychicUid === uid();
export const phase = () => state.game?.phase ?? null;

/* ══════════ Lobi ══════════ */

export async function setTotalRounds(n) {
  const rounds = Math.max(3, Math.min(20, Math.round(n)));
  await runTransaction(stateRef(), (st) => {
    if (!st || st.phase !== 'lobby') return;
    st.totalRounds = rounds;
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
    st.dial = { value: 50, by: null, at: 0 };
    return st;
  });
  if (res.committed) await remove(dbRef(path('history')));
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

/** Sürükleme sırasında çağrılır; saniyede ~7 yazımla sınırlanır. */
export function pushDial(value) {
  if (phase() !== 'guess') return;
  pendingValue = value;
  const wait = DIAL_THROTTLE_MS - (Date.now() - lastSent);
  if (wait <= 0) { flushDial(); return; }
  if (!flushTimer) flushTimer = setTimeout(flushDial, wait);
}

/** Parmak kalkınca son değeri kesin olarak yazar. */
export function flushDial() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (pendingValue == null || phase() !== 'guess') { pendingValue = null; return; }
  const value = Math.round(pendingValue * 10) / 10;
  pendingValue = null;
  lastSent = Date.now();
  set(dbRef(path('state/dial')), { value, by: uid(), at: Date.now() })
    .catch(() => { /* geçici bağlantı hatası: bir sonraki hareket düzeltir */ });
}

/* ══════════ Kilitleme ══════════ */

export async function lockGuess() {
  const res = await runTransaction(stateRef(), (st) => {
    if (!st || st.phase !== 'guess') return;
    st.final = st.dial && Number.isFinite(st.dial.value) ? st.dial.value : 50;
    st.phase = 'reveal';
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

/* ══════════ Tur sonucu ══════════ */

/**
 * Tur sonucunu `history/{tur}` altına yazar. İçerik tamamen deterministik
 * olduğu için hangi cihaz yazarsa yazsın sonuç aynıdır; iki kez yazılması zararsız.
 */
export async function writeHistory(target) {
  const g = state.game;
  if (!g || g.phase !== 'reveal' || target == null) return;
  const idx = g.roundIndex;
  if (state.history[idx]) return;
  const dial = Number.isFinite(g.final) ? g.final : 50;
  await set(dbRef(path(`history/${idx}`)), {
    clue: g.clue ?? '',
    left: g.spectrum?.left ?? '',
    right: g.spectrum?.right ?? '',
    spectrumId: g.spectrum?.id ?? '',
    psychicUid: g.psychicUid ?? '',
    target,
    dial,
    points: scoreFor(target, dial),
  }).catch(() => { /* başka cihaz yazmış olabilir */ });
}

let fallbackTimer = null;
/** Kilitleyen cihaz kopmuşsa kaydı bir başkası tamamlasın. */
export function scheduleHistoryFallback() {
  if (fallbackTimer) return;
  fallbackTimer = setTimeout(async () => {
    fallbackTimer = null;
    const g = state.game;
    if (!g || g.phase !== 'reveal' || state.history[g.roundIndex]) return;
    const t = await fetchTarget();
    if (t != null) await writeHistory(t);
  }, HISTORY_FALLBACK_MS);
}

/* ══════════ Tur geçişi ══════════ */

/** Sonraki tura geçer; turlar bittiyse oyunu bitirir. */
export async function nextRound() {
  const online = onlinePlayers().map(p => p.id);
  await runTransaction(stateRef(), (st) => {
    if (!st || st.phase !== 'reveal') return;
    const idx = st.roundIndex + 1;
    if (idx >= st.totalRounds) { st.phase = 'gameover'; return st; }
    const order = mergeOrder(st.order, online);
    st.roundIndex = idx;
    st.order = order;
    st.psychicUid = nextPsychic(order, st.psychicUid, online);
    st.spectrum = null;
    st.clue = null;
    st.final = null;
    st.dial = { value: 50, by: null, at: 0 };
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
    st.spectrum = null;
    st.clue = null;
    st.final = null;
    st.dial = { value: 50, by: null, at: 0 };
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
    st.spectrum = null;
    st.clue = null;
    st.final = null;
    st.dial = { value: 50, by: null, at: 0 };
    return st;
  });
  if (res.committed) {
    targetCache.clear();
    await remove(dbRef(path('history')));
  }
}

/* ══════════ Yan etki döngüsü ══════════ */

let effectBusy = false;

/**
 * Duruma bakıp o an gereken yazımları yapar. Her durum değişiminde çağrılır.
 * Arayüzden bağımsızdır; uçtan uca testler de bunu çalıştırır.
 * @returns {Promise<{changed:boolean, error?:string}>}
 */
export async function runSideEffects() {
  const g = state.game;
  if (!g || effectBusy) return { changed: false };
  effectBusy = true;
  let changed = false;
  let error = null;
  try {
    // 1) Psişiksem ve kart henüz çekilmediyse çek
    if (g.phase === 'clue' && g.psychicUid === uid() && !g.spectrum) {
      try { await ensureRoundDrawn(); changed = true; }
      catch (e) { error = e.message; }
    }
    // 2) Hedefi görmeye hakkım varsa ve elimde yoksa oku
    if (knownTarget() == null &&
        ((g.psychicUid === uid() && g.spectrum) || g.phase === 'reveal')) {
      if (await fetchTarget() != null) changed = true;
    }
    // 3) Tur açıldıysa sonucu kaydet (idempotent)
    if (g.phase === 'reveal' && !state.history[g.roundIndex]) {
      const t = knownTarget();
      if (t != null) { await writeHistory(t); changed = true; }
      scheduleHistoryFallback();
    }
  } finally {
    effectBusy = false;
  }
  return { changed, error };
}
