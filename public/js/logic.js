// Saf oyun akışı yardımcıları — Firebase'e ve DOM'a bağımlı değil,
// bu yüzden `node --test` altında doğrudan test edilebilir.

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
