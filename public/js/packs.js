// Kişiye ait spektrum setleri.
//
// Setler hesaba bağlı saklanır (/users/{uid}/packs) ve aynı anda cihazda
// önbelleklenir: uygulama açılır açılmaz liste görünür, bağlantı yoksa da
// okunabilir. Yazma her zaman hesaba gider; misafir hesap set kaydedemez.

import { dbRef, get, set, remove, push, onValue, uid } from './firebase.js';
import { validatePack, normalizeCards, normalizePackName } from './deck.js';
import { canSavePacks } from './auth.js';

const cacheKey = (u) => `frekans.packs.${u}`;

function readCache(u) {
  try {
    const raw = localStorage.getItem(cacheKey(u));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function writeCache(u, map) {
  try { localStorage.setItem(cacheKey(u), JSON.stringify(map)); }
  catch { /* depolama dolu/kapalı: önbellek olmadan da çalışır */ }
}

/** Ham düğümü listeye çevirir (en son güncellenen üstte). */
function toList(val) {
  return Object.entries(val || {})
    .filter(([, p]) => p && typeof p === 'object')
    .map(([id, p]) => ({
      id,
      name: String(p.name ?? ''),
      cards: normalizeCards(p.cards),
      updatedAt: Number(p.updatedAt) || 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Anında dönen önbellek — ağ beklemeden liste çizmek için. */
export function cachedPacks() {
  const u = uid();
  return u ? toList(readCache(u)) : [];
}

/** Hesaptaki setleri okur ve önbelleği tazeler. */
export async function loadPacks() {
  const u = uid();
  if (!u) return [];
  try {
    const snap = await get(dbRef(`users/${u}/packs`));
    const val = snap.val() || {};
    writeCache(u, val);
    return toList(val);
  } catch {
    return cachedPacks();   // izin/bağlantı yok: önbellekle idare et
  }
}

/** Setler ekranı için canlı abonelik. */
export function subscribePacks(cb) {
  const u = uid();
  if (!u) { cb([]); return () => {}; }
  return onValue(dbRef(`users/${u}/packs`), (snap) => {
    const val = snap.val() || {};
    writeCache(u, val);
    cb(toList(val));
  }, () => cb(cachedPacks()));
}

/**
 * Set oluşturur veya günceller.
 * @param {{id?:string, name:string, cards:{l,r}[]}} pack
 * @returns {Promise<string>} setin id'si
 */
export async function savePack({ id, name, cards }) {
  if (!canSavePacks()) {
    throw new Error('Set kaydetmek için Google ile giriş yapmalısın.');
  }
  const u = uid();
  const clean = validatePack({ name, cards });
  const packId = id || push(dbRef(`users/${u}/packs`)).key;
  await set(dbRef(`users/${u}/packs/${packId}`), {
    name: clean.name,
    cards: clean.cards,
    updatedAt: Date.now(),
  });
  return packId;
}

export async function deletePack(id) {
  if (!canSavePacks()) throw new Error('Bunun için giriş yapmalısın.');
  const u = uid();
  await remove(dbRef(`users/${u}/packs/${id}`));
}

/** Profil adını hesaba yazar (cihaz değişince ad hatırlansın). */
export async function saveProfileName(name) {
  const clean = String(name || '').trim().slice(0, 14);
  if (!clean || !canSavePacks()) return;
  const u = uid();
  await set(dbRef(`users/${u}/profile`), { name: clean, updatedAt: Date.now() })
    .catch(() => { /* profil kaydı kritik değil */ });
}

export async function loadProfileName() {
  const u = uid();
  if (!u) return '';
  try {
    const snap = await get(dbRef(`users/${u}/profile/name`));
    return snap.val() || '';
  } catch { return ''; }
}

/* ══════════ JSON aktarımı ══════════ */

export function exportPack(pack) {
  const data = { name: pack.name, cards: pack.cards.map(({ l, r }) => ({ l, r })) };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const slug = (pack.name || 'set').replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase();
  a.href = url;
  a.download = `frekans-${slug}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Dosyadan okunan JSON'u sete çevirir. Hem `{name, cards}` nesnesini hem
 * düz kart dizisini kabul eder (eski dışa aktarmalar düz diziydi).
 */
export function parseImport(text, fallbackName = 'İçe aktarılan set') {
  const data = JSON.parse(text);
  const raw = Array.isArray(data) ? data : data?.cards;
  const cards = normalizeCards(raw);
  if (!cards.length) throw new Error('Dosyada geçerli kart bulunamadı.');
  const name = normalizePackName(Array.isArray(data) ? fallbackName : data?.name) || fallbackName;
  return { name, cards };
}
