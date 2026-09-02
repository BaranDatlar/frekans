import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE, MAX_CARDS, MAX_SIDE,
  normalizeSide, normalizeCards, normalizePackName, validatePack,
  resolveDeck, deckLabel, isExpired,
} from '../public/js/deck.js';

const BUILTIN = [
  { l: 'Soğuk', r: 'Sıcak' },
  { l: 'Ucuz', r: 'Pahalı' },
  { l: 'Küçük', r: 'Büyük' },
];
const CUSTOM = [{ l: 'Ali', r: 'Veli' }, { l: 'Dün', r: 'Yarın' }];

test('normalizeSide boşlukları toparlar ve sınırı uygular', () => {
  assert.equal(normalizeSide('  çok   boşluklu  '), 'çok boşluklu');
  assert.equal(normalizeSide('x'.repeat(50)).length, MAX_SIDE);
  assert.equal(normalizeSide(null), '');
  assert.equal(normalizeSide(undefined), '');
});

test('normalizeCards iki biçimi de kabul eder', () => {
  assert.deepEqual(normalizeCards([{ l: 'A', r: 'B' }]), [{ l: 'A', r: 'B' }]);
  assert.deepEqual(normalizeCards([{ left: 'A', right: 'B' }]), [{ l: 'A', r: 'B' }]);
});

test('normalizeCards bozuk kayıtları atar', () => {
  const out = normalizeCards([
    { l: 'A', r: 'B' },
    { l: 'A' },                     // eksik uç
    { l: '  ', r: 'B' },            // boş uç
    { l: 'Aynı', r: 'aynı' },       // iki uç aynı (büyük/küçük harf farkı sayılmaz)
    null, 'metin', 42,
  ]);
  assert.deepEqual(out, [{ l: 'A', r: 'B' }]);
  assert.deepEqual(normalizeCards(null), []);
  assert.deepEqual(normalizeCards('dizi değil'), []);
});

test('normalizeCards tekrarları eler', () => {
  const out = normalizeCards([
    { l: 'Soğuk', r: 'Sıcak' },
    { l: 'soğuk', r: 'SICAK' },
    { l: 'Sıcak', r: 'Soğuk' },     // ters çevrilmiş: farklı kart sayılır
  ]);
  assert.equal(out.length, 2);
});

test('normalizeCards kart sınırını uygular', () => {
  const many = Array.from({ length: MAX_CARDS + 50 }, (_, i) => ({ l: `s${i}`, r: `r${i}` }));
  assert.equal(normalizeCards(many).length, MAX_CARDS);
});

test('validatePack ad ve asgari kart sayısı ister', () => {
  assert.throws(() => validatePack({ name: '  ', cards: CUSTOM }), /ad ver/i);
  assert.throws(() => validatePack({ name: 'Set', cards: [{ l: 'A', r: 'B' }] }), /en az 3/i);
  assert.throws(() => validatePack(), /ad ver/i);
  const ok = validatePack({ name: '  Benim  Setim ', cards: [...CUSTOM, { l: 'X', r: 'Y' }] });
  assert.equal(ok.name, 'Benim Setim');
  assert.equal(ok.cards.length, 3);
});

test('validatePack set adını kırpar', () => {
  const p = validatePack({ name: 'a'.repeat(80), cards: [...CUSTOM, { l: 'X', r: 'Y' }] });
  assert.equal(p.name.length, 32);
});

test('resolveDeck: hazır set', () => {
  const d = resolveDeck({ source: SOURCE.BUILTIN }, BUILTIN);
  assert.deepEqual(d.map(c => c.id), ['b0', 'b1', 'b2']);
  assert.equal(d[0].left, 'Soğuk');
  assert.equal(d[0].right, 'Sıcak');
});

test('resolveDeck: yalnızca özel set', () => {
  const d = resolveDeck({ source: SOURCE.CUSTOM, cards: CUSTOM }, BUILTIN);
  assert.deepEqual(d.map(c => c.id), ['c0', 'c1']);
  assert.equal(d[0].left, 'Ali');
});

test('resolveDeck: karışık destede id çakışmaz', () => {
  const d = resolveDeck({ source: SOURCE.MIXED, cards: CUSTOM }, BUILTIN);
  assert.equal(d.length, 5);
  assert.equal(new Set(d.map(c => c.id)).size, 5, 'her kartın id\'si benzersiz olmalı');
});

test('resolveDeck: bilinmeyen/eksik tanım hazır sete düşer', () => {
  assert.equal(resolveDeck(null, BUILTIN).length, 3);
  assert.equal(resolveDeck({}, BUILTIN).length, 3);
  assert.equal(resolveDeck({ source: 'saçma' }, BUILTIN).length, 3);
});

test('resolveDeck: özel set boşsa oyun kilitlenmesin diye hazıra düşer', () => {
  assert.equal(resolveDeck({ source: SOURCE.CUSTOM, cards: [] }, BUILTIN).length, 3);
  assert.equal(resolveDeck({ source: SOURCE.CUSTOM }, BUILTIN).length, 3);
});

test('resolveDeck hazır set yoksa çökmez', () => {
  assert.deepEqual(resolveDeck({ source: SOURCE.BUILTIN }, null), []);
  assert.equal(resolveDeck({ source: SOURCE.CUSTOM, cards: CUSTOM }, null).length, 2);
});

test('deckLabel okunabilir ad verir', () => {
  assert.equal(deckLabel({ source: SOURCE.BUILTIN }), 'Hazır set');
  assert.equal(deckLabel({ source: SOURCE.CUSTOM, name: 'Ofis' }), 'Ofis');
  assert.equal(deckLabel({ source: SOURCE.MIXED, name: 'Ofis' }), 'Hazır + Ofis');
  assert.equal(deckLabel(null), 'Hazır set');
});

test('isExpired', () => {
  const now = 1_000_000;
  assert.equal(isExpired(now - 1, now), true);
  assert.equal(isExpired(now + 1, now), false);
  assert.equal(isExpired(now, now), false, 'tam sınırda henüz dolmamış sayılır');
  assert.equal(isExpired(null, now), false, 'süresi yoksa dolmuş sayılmaz');
  assert.equal(isExpired(undefined, now), false);
  assert.equal(isExpired('yarın', now), false);
});
