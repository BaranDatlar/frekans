import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPsychic, mergeOrder, historyList, totalScore, pickSpectrum } from '../public/js/logic.js';

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
