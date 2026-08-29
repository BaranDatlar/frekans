// Saf oyun akışı yardımcıları — Firebase'e ve DOM'a bağımlı değil,
// bu yüzden `node --test` altında doğrudan test edilebilir.

import { scoreFor } from './scoring.js';

/** İki oyun modu. */
export const MODE = {
  /** Tek ortak ibre, tek ortak puan. Klasik kooperatif. */
  SHARED: 'shared',
  /** Herkesin kendi ibresi ve kendi puanı; psişik ortalamayı alır. */
  SOLO: 'solo',
};

export const isMode = (m) => m === MODE.SOLO ? MODE.SOLO : MODE.SHARED;

/**
 * Sıradaki psişik: `order` içinde mevcut psişikten sonraki ilk ÇEVRİMİÇİ oyuncu.
 * Kimse çevrimiçi değilse sıradaki oyuncuya düşer (oyun kilitlenmesin).
 */
export function nextPsychic(order, currentUid, onlineIds) {
  const list = Array.isArray(order) ? order.filter(Boolean) : [];
  const online = new Set(onlineIds || []);
  if (!list.length) return (onlineIds && onlineIds[0]) || null;
  const idx = list.indexOf(currentUid);
  const start = idx === -1 ? -1 : idx;
  for (let i = 1; i <= list.length; i++) {
    const cand = list[(start + i + list.length) % list.length];
    if (online.has(cand)) return cand;
  }
  return list[(start + 1 + list.length) % list.length];
}

/** Oyun başladıktan sonra katılanları sıranın sonuna ekler. */
export function mergeOrder(order, onlineIds) {
  const list = Array.isArray(order) ? order.filter(Boolean) : [];
  const seen = new Set(list);
  for (const id of onlineIds || []) if (!seen.has(id)) { list.push(id); seen.add(id); }
  return list;
}

/** history düğümünü tur sırasına göre diziye çevirir. */
export function historyList(history) {
  // RTDB ardışık sayısal anahtarlı düğümü diziye çevirir; boş gözler olabilir.
  return Object.entries(history || {})
    .filter(([, h]) => h && typeof h === 'object')
    .map(([idx, h]) => ({ index: Number(idx), ...h }))
    .sort((a, b) => a.index - b.index);
}

export function totalScore(history) {
  return historyList(history).reduce((sum, h) => sum + (Number(h.points) || 0), 0);
}

/**
 * Turda kullanılacak spektrumu seçer. Daha önce çıkanlar elenir;
 * hepsi tükendiyse liste sıfırlanmış sayılır.
 * @param {{id:string}[]} pool
 * @param {Record<string,true>} used
 */
export function pickSpectrum(pool, used = {}, rng = Math.random) {
  if (!Array.isArray(pool) || !pool.length) return null;
  let candidates = pool.filter(s => !used[s.id]);
  const exhausted = candidates.length === 0;
  if (exhausted) candidates = pool;
  const chosen = candidates[Math.floor(rng() * candidates.length)];
  return { spectrum: chosen, exhausted };
}

/* ══════════ Kilitleme ══════════ */

/**
 * Bu turda kilitlemesi beklenen oyuncular: psişik dışındaki ÇEVRİMİÇİ herkes.
 * Bağlantısı kopan beklenmez, yoksa tur kilitlenip kalır.
 */
export function activeGuessers(players, psychicUid) {
  return Object.entries(players || {})
    .filter(([id, p]) => p && p.online && id !== psychicUid)
    .map(([id]) => id);
}

/**
 * Bu turda kilitlemiş oyuncular.
 *
 * Kilit, basıldığı andaki ibre DEĞERİYLE saklanır. Ortak modda `dialValue`
 * verildiğinde yalnızca o değere denk gelen kilitler sayılır — yani biri
 * ibreyi oynattığında eski onaylar kendiliğinden geçersizleşir. Böylece
 * "A 50'yi onaylamıştı ama tur 80'de kapandı" durumu oluşmaz ve kilitleri
 * silmek için kimsenin başkasının verisine yazması gerekmez.
 *
 * @param {Record<string, number>} roundLocks uid -> kilitlenen ibre değeri
 * @param {string[]} guesserIds beklenen oyuncular
 * @param {number|null} dialValue ortak modda güncel ibre; bireysel modda null
 */
export function lockedGuessers(roundLocks, guesserIds, dialValue = null) {
  const locks = roundLocks || {};
  return (guesserIds || []).filter((id) => {
    const v = locks[id];
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    return dialValue == null || Math.abs(v - dialValue) < 0.05;
  });
}

/** Beklenen herkes kilitledi mi? En az bir kişi gerekir. */
export function allLocked(roundLocks, guesserIds, dialValue = null) {
  const ids = guesserIds || [];
  return ids.length > 0 &&
    lockedGuessers(roundLocks, ids, dialValue).length === ids.length;
}

/* ══════════ Bireysel mod puanlaması ══════════ */

/**
 * Her tahmincinin kendi ibresine göre puanı.
 * @param {number} target
 * @param {Record<string, number>} guesses uid -> ibre değeri
 * @returns {Record<string, number>} uid -> puan
 */
export function soloScores(target, guesses) {
  const out = {};
  for (const [id, value] of Object.entries(guesses || {})) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    out[id] = scoreFor(target, value);
  }
  return out;
}

/**
 * Psişiğin puanı: tahmincilerin ortalaması, en yakın tam sayıya yuvarlanır.
 * Kimse tahmin etmediyse 0.
 */
export function psychicAverage(pointsByUid) {
  const vals = Object.values(pointsByUid || {}).filter(Number.isFinite);
  if (!vals.length) return 0;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/**
 * Bireysel modda oyuncu başına toplam puan.
 * Bir turda tahminci kendi puanını, psişik ortalamasını alır.
 * @returns {Record<string, number>}
 */
export function soloTotals(history) {
  const totals = {};
  const add = (id, n) => { if (id) totals[id] = (totals[id] || 0) + (Number(n) || 0); };
  for (const h of historyList(history)) {
    for (const [id, pts] of Object.entries(h.points || {})) add(id, pts);
    add(h.psychicUid, h.psychicPoints);
  }
  return totals;
}

/** Sıralama tablosu: puana göre azalan, eşitlikte isme göre. */
export function rankings(totals, players) {
  return Object.keys(players || {})
    .map(id => ({ id, name: players[id]?.name || '—', points: totals[id] || 0 }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'tr'));
}
