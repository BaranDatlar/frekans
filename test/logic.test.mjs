import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nextPsychic, mergeOrder, historyList, totalScore, pickSpectrum,
  MODE, isMode, activeGuessers, lockedGuessers, allLocked,
  soloScores, psychicAverage, soloTotals, rankings,
} from '../public/js/logic.js';

const ORDER = ['a', 'b', 'c', 'd'];

test('nextPsychic sırayı takip eder', () => {
  assert.equal(nextPsychic(ORDER, 'a', ORDER), 'b');
  assert.equal(nextPsychic(ORDER, 'd', ORDER), 'a', 'başa sarar');
});

test('nextPsychic çevrimdışı oyuncuları atlar', () => {
  assert.equal(nextPsychic(ORDER, 'a', ['a', 'c', 'd']), 'c');
  assert.equal(nextPsychic(ORDER, 'b', ['a']), 'a');
});

test('nextPsychic kimse çevrimiçi değilse bile kilitlenmez', () => {
  assert.equal(nextPsychic(ORDER, 'a', []), 'b');
  assert.equal(nextPsychic(ORDER, 'd', []), 'a');
});

test('nextPsychic bilinmeyen/boş girdilerde çökmez', () => {
  assert.equal(nextPsychic(ORDER, 'zzz', ['c']), 'c', 'listede olmayan psişikten sonra ilk çevrimiçi');
  assert.equal(nextPsychic([], null, ['x']), 'x');
  assert.equal(nextPsychic(null, null, []), null);
});

test('mergeOrder yeni gelenleri sona ekler, tekrar etmez', () => {
  assert.deepEqual(mergeOrder(['a', 'b'], ['b', 'c', 'a', 'd']), ['a', 'b', 'c', 'd']);
  assert.deepEqual(mergeOrder(null, ['x']), ['x']);
  assert.deepEqual(mergeOrder(['a'], null), ['a']);
});

test('historyList tur sırasına göre sıralar', () => {
  const h = { 2: { points: 3 }, 0: { points: 4 }, 1: { points: 0 } };
  assert.deepEqual(historyList(h).map(x => x.index), [0, 1, 2]);
  assert.deepEqual(historyList(h).map(x => x.points), [4, 0, 3]);
});

test('totalScore toplar, boş history 0 verir', () => {
  assert.equal(totalScore({ 0: { points: 4 }, 1: { points: 2 } }), 6);
  assert.equal(totalScore({}), 0);
  assert.equal(totalScore(null), 0);
  assert.equal(totalScore({ 0: { points: undefined } }), 0);
});

test('pickSpectrum kullanılmışları eler', () => {
  const pool = [{ id: '1' }, { id: '2' }, { id: '3' }];
  const r = pickSpectrum(pool, { 1: true, 2: true }, () => 0);
  assert.equal(r.spectrum.id, '3');
  assert.equal(r.exhausted, false);
});

test('pickSpectrum hepsi tükenince listeyi sıfırlar', () => {
  const pool = [{ id: '1' }, { id: '2' }];
  const r = pickSpectrum(pool, { 1: true, 2: true }, () => 0);
  assert.equal(r.exhausted, true);
  assert.ok(['1', '2'].includes(r.spectrum.id));
});

test('pickSpectrum boş havuzda null döner', () => {
  assert.equal(pickSpectrum([], {}), null);
  assert.equal(pickSpectrum(null, {}), null);
});

test('pickSpectrum rng üst sınırda taşmaz', () => {
  const pool = [{ id: '1' }, { id: '2' }];
  const r = pickSpectrum(pool, {}, () => 0.999999);
  assert.equal(r.spectrum.id, '2');
});

/* ══════════ Kilitleme ══════════ */

const PLAYERS = {
  psi: { name: 'Psi', online: true },
  a:   { name: 'Ali', online: true },
  b:   { name: 'Beste', online: true },
  off: { name: 'Kayıp', online: false },
};

test('activeGuessers: psişik ve çevrimdışılar beklenmez', () => {
  assert.deepEqual(activeGuessers(PLAYERS, 'psi').sort(), ['a', 'b']);
  assert.deepEqual(activeGuessers(PLAYERS, 'a').sort(), ['b', 'psi']);
  assert.deepEqual(activeGuessers({}, 'psi'), []);
  assert.deepEqual(activeGuessers(null, 'psi'), []);
});

test('allLocked: herkes kilitleyince true', () => {
  const ids = ['a', 'b'];
  assert.equal(allLocked({}, ids), false);
  assert.equal(allLocked({ a: 40 }, ids), false);
  assert.equal(allLocked({ a: 40, b: 40 }, ids), true);
});

test('allLocked: çevrimdışı olanın kilidi beklenenleri etkilemez', () => {
  assert.equal(allLocked({ a: 40, b: 40, off: 40 }, ['a', 'b']), true);
});

test('allLocked: kimse beklenmiyorsa false (tur boşuna açılmasın)', () => {
  assert.equal(allLocked({ a: 40 }, []), false);
});

test('ortak modda ibre oynayınca eski kilitler sayılmaz', () => {
  const ids = ['a', 'b'];
  const locks = { a: 40, b: 40 };
  assert.equal(allLocked(locks, ids, 40), true, 'ibre kilitlenen yerdeyken geçerli');
  assert.equal(allLocked(locks, ids, 55), false, 'ibre oynayınca onaylar düşmeli');
  assert.deepEqual(lockedGuessers({ a: 40, b: 55 }, ids, 55), ['b'],
    'yalnızca güncel değere kilitleyen sayılır');
});

test('bireysel modda ibre değeri karşılaştırılmaz', () => {
  assert.equal(allLocked({ a: 12, b: 90 }, ['a', 'b'], null), true);
});

test('lockedGuessers yalnızca beklenenleri ve geçerli sayıları sayar', () => {
  assert.deepEqual(lockedGuessers({ a: 30, off: 30 }, ['a', 'b']), ['a']);
  assert.deepEqual(lockedGuessers({ a: true, b: 'x' }, ['a', 'b']), [],
    'sayı olmayan kilit geçersiz');
  assert.deepEqual(lockedGuessers(null, ['a']), []);
});

/* ══════════ Bireysel mod puanlaması ══════════ */

test('soloScores her tahmincinin kendi puanını verir', () => {
  // BAND = 3.2 → 4 puan ±1.6, 3 puan ±4.8, 2 puan ±8.0
  const pts = soloScores(50, { a: 50, b: 53, c: 56, d: 10 });
  assert.deepEqual(pts, { a: 4, b: 3, c: 2, d: 0 });
});

test('soloScores bozuk değerleri atlar', () => {
  assert.deepEqual(soloScores(50, { a: 50, b: null, c: 'x', d: NaN }), { a: 4 });
  assert.deepEqual(soloScores(50, {}), {});
  assert.deepEqual(soloScores(50, null), {});
});

test('psychicAverage ortalamayı yuvarlar', () => {
  assert.equal(psychicAverage({ a: 4, b: 3, c: 0 }), 2, '7/3 = 2.33 → 2');
  assert.equal(psychicAverage({ a: 4, b: 4 }), 4);
  assert.equal(psychicAverage({ a: 3, b: 4 }), 4, '3.5 → 4');
  assert.equal(psychicAverage({ a: 0 }), 0);
  assert.equal(psychicAverage({}), 0, 'kimse tahmin etmediyse 0');
  assert.equal(psychicAverage(null), 0);
});

test('soloTotals tahminci ve psişik puanlarını birleştirir', () => {
  const history = {
    0: { psychicUid: 'psi', points: { a: 4, b: 2 }, psychicPoints: 3 },
    1: { psychicUid: 'a',   points: { psi: 3, b: 0 }, psychicPoints: 2 },
  };
  assert.deepEqual(soloTotals(history), { a: 4 + 2, b: 2 + 0, psi: 3 + 3 });
});

test('soloTotals boş/eksik veriyle çökmez', () => {
  assert.deepEqual(soloTotals({}), {});
  assert.deepEqual(soloTotals(null), {});
  assert.deepEqual(soloTotals({ 0: { psychicUid: 'p' } }), { p: 0 });
});

test('rankings puana göre sıralar, eşitlikte isme göre', () => {
  const players = { a: { name: 'Zeynep' }, b: { name: 'Ali' }, c: { name: 'Can' } };
  const r = rankings({ a: 5, b: 9, c: 5 }, players);
  assert.deepEqual(r.map(x => x.id), ['b', 'c', 'a'], 'Can (5) Zeynep(5)ten önce gelmeli');
  assert.deepEqual(r.map(x => x.points), [9, 5, 5]);
});

test('rankings puanı olmayan oyuncuyu 0 ile listeler', () => {
  const r = rankings({}, { a: { name: 'Ali' } });
  assert.deepEqual(r, [{ id: 'a', name: 'Ali', points: 0 }]);
});

test('MODE / isMode güvenli varsayılan verir', () => {
  assert.equal(isMode('solo'), MODE.SOLO);
  assert.equal(isMode('shared'), MODE.SHARED);
  assert.equal(isMode(undefined), MODE.SHARED, 'eski odalar ortak moda düşmeli');
  assert.equal(isMode('saçma'), MODE.SHARED);
});
