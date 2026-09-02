// Deste ve kişisel set mantığı — saf fonksiyonlar.
// Firebase'e ve DOM'a bağımlı değil, `node --test` altında doğrudan test edilir.

/** Odanın destesi nereden geliyor. */
export const SOURCE = {
  /** Uygulamayla gelen 86 hazır kart. */
  BUILTIN: 'builtin',
  /** Yalnızca odaya yüklenen özel set. */
  CUSTOM: 'custom',
  /** Hazır kartlar + yüklenen set. */
  MIXED: 'mixed',
};

export const MAX_CARDS = 500;      // bir set en fazla bu kadar kart tutar
export const MAX_SIDE = 28;        // bir ucun karakter sınırı
export const MAX_PACK_NAME = 32;

const asSource = (s) =>
  s === SOURCE.CUSTOM || s === SOURCE.MIXED ? s : SOURCE.BUILTIN;

/** Boşlukları toparlar, sınırı aşan metni keser. */
export function normalizeSide(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_SIDE);
}

/**
 * Ham kart listesini temizler: geçersizleri atar, tekrarları eler, sınırı uygular.
 * Hem `{l,r}` hem `{left,right}` biçimini kabul eder (JSON içe aktarma için).
 * @returns {{l:string, r:string}[]}
 */
export function normalizeCards(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const l = normalizeSide(item.l ?? item.left);
    const r = normalizeSide(item.r ?? item.right);
    if (!l || !r) continue;
    if (l.toLocaleLowerCase('tr') === r.toLocaleLowerCase('tr')) continue;
    const key = `${l.toLocaleLowerCase('tr')}|${r.toLocaleLowerCase('tr')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ l, r });
    if (out.length >= MAX_CARDS) break;
  }
  return out;
}

export function normalizePackName(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_PACK_NAME);
}

/**
 * Kaydedilmeye hazır set. Geçersizse anlaşılır bir hata fırlatır.
 * @returns {{name:string, cards:{l:string,r:string}[]}}
 */
export function validatePack({ name, cards } = {}) {
  const cleanName = normalizePackName(name);
  if (!cleanName) throw new Error('Sete bir ad ver.');
  const cleanCards = normalizeCards(cards);
  if (cleanCards.length < 3) {
    throw new Error('Bir sette en az 3 kart olmalı.');
  }
  return { name: cleanName, cards: cleanCards };
}

/**
 * Odanın deste tanımını oynanabilir kart listesine çevirir.
 * Hazır kartlar `b0…`, özel kartlar `c0…` id'si alır; karışık destede
 * çakışma olmaz. Kart metni zaten `state.spectrum`'a kopyalandığı için
 * bu listeyi yalnızca o turun psişiği okur.
 *
 * @param {{source?:string, cards?:{l,r}[]}|null} deck  rooms/{kod}/deck
 * @param {{l:string,r:string}[]} builtin               public/data/builtin.json
 * @returns {{id:string,left:string,right:string}[]}
 */
export function resolveDeck(deck, builtin) {
  const source = asSource(deck?.source);
  const base = Array.isArray(builtin) ? builtin : [];
  const custom = normalizeCards(deck?.cards);

  const fromBuiltin = base.map((c, i) => ({ id: `b${i}`, left: c.l, right: c.r }));
  const fromCustom = custom.map((c, i) => ({ id: `c${i}`, left: c.l, right: c.r }));

  if (source === SOURCE.CUSTOM) return fromCustom.length ? fromCustom : fromBuiltin;
  if (source === SOURCE.MIXED) return [...fromBuiltin, ...fromCustom];
  return fromBuiltin;
}

/** Deste seçiminin arayüzde gösterilecek adı. */
export function deckLabel(deck) {
  const source = asSource(deck?.source);
  if (source === SOURCE.CUSTOM) return deck?.name || 'Özel set';
  if (source === SOURCE.MIXED) return `Hazır + ${deck?.name || 'özel set'}`;
  return 'Hazır set';
}

/** Odanın ömrü doldu mu? */
export function isExpired(expiresAt, now = Date.now()) {
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && now > expiresAt;
}
