// Ortak spektrum havuzu: okuma, ekleme, silme, JSON aktarımı.
// Havuz tüm odalar için ortaktır (rooms'un dışında, /spectrums altında).

import { dbRef, get, set, update, remove, push, onValue, uid, serverTimestamp } from './firebase.js';

const POOL = 'spectrums';

/** Ham snapshot'ı diziye çevirir. */
function toList(val) {
  if (!val) return [];
  return Object.entries(val).map(([id, s]) => ({
    id,
    left: String(s.left ?? ''),
    right: String(s.right ?? ''),
    addedBy: s.addedBy ?? null,
    createdAt: s.createdAt ?? 0,
  })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** Havuzu bir kez okur (oyun başında kullanılır). */
export async function loadPool() {
  const snap = await get(dbRef(POOL));
  return toList(snap.val());
}

/** Editör ekranı için canlı abonelik. Aboneliği iptal eden fonksiyon döner. */
export function subscribePool(cb) {
  return onValue(dbRef(POOL), (snap) => cb(toList(snap.val())));
}

function clean(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, 28);
}

/** @returns {Promise<string>} yeni kaydın id'si */
export async function addSpectrum(left, right) {
  const l = clean(left), r = clean(right);
  if (!l || !r) throw new Error('İki uç da dolu olmalı.');
  if (l.toLowerCase() === r.toLowerCase()) throw new Error('İki uç aynı olamaz.');
  const node = push(dbRef(POOL));
  await set(node, { left: l, right: r, addedBy: uid(), createdAt: serverTimestamp() });
  return node.key;
}

export function deleteSpectrum(id) {
  return remove(dbRef(`${POOL}/${id}`));
}

/** Toplu ekleme (JSON içe aktarma / başlangıç seti). Var olanları atlar. */
export async function addMany(items) {
  const existing = await loadPool();
  const seen = new Set(existing.map(s => `${s.left.toLowerCase()}|${s.right.toLowerCase()}`));
  const updates = {};
  let added = 0;
  for (const it of items) {
    const l = clean(it.left), r = clean(it.right);
    if (!l || !r || l.toLowerCase() === r.toLowerCase()) continue;
    const key = `${l.toLowerCase()}|${r.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = push(dbRef(POOL));
    updates[node.key] = { left: l, right: r, addedBy: uid(), createdAt: Date.now() };
    added++;
  }
  // tek update ile yaz — 80 ayrı istek atmak yerine
  if (added) await update(dbRef(POOL), updates);
  return { added, skipped: items.length - added };
}

/** public/seed-spectrums.json içindeki hazır seti havuza ekler. */
export async function loadSeedPack() {
  const res = await fetch('seed-spectrums.json');
  if (!res.ok) throw new Error('Başlangıç seti okunamadı.');
  return addMany(await res.json());
}

/** Havuzu tarayıcıdan JSON dosyası olarak indirir. */
export function exportJson(list) {
  const data = list.map(({ left, right }) => ({ left, right }));
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `frekans-spektrumlar-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Dosyadan okunan JSON'u doğrular. */
export function parseImport(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('JSON bir dizi olmalı.');
  const items = data.filter(d => d && typeof d.left === 'string' && typeof d.right === 'string');
  if (!items.length) throw new Error('Geçerli kayıt bulunamadı.');
  return items;
}
