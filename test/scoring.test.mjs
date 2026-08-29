import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BAND, HALF_TARGET, MIN_TARGET, MAX_TARGET,
  randomTarget, bandsFor, scoreFor, clampValue, verdict, shuffle,
} from '../public/js/scoring.js';

test('hedef her zaman kenardan taşmayacak aralıkta üretilir', () => {
  for (const r of [0, 0.0001, 0.5, 0.9999, 1]) {
    const t = randomTarget(() => r);
    assert.ok(t >= MIN_TARGET - 1e-9, `${t} >= ${MIN_TARGET}`);
    assert.ok(t <= MAX_TARGET + 1e-9, `${t} <= ${MAX_TARGET}`);
    const bands = bandsFor(t);
    assert.ok(bands[0].from >= -1e-9, 'sol bant 0 altına taşmamalı');
    assert.ok(bands[4].to <= 100 + 1e-9, 'sağ bant 100 üstüne taşmamalı');
  }
});

test('1000 rastgele hedefte de taşma yok', () => {
  for (let i = 0; i < 1000; i++) {
    const t = randomTarget();
    assert.ok(t >= MIN_TARGET && t <= MAX_TARGET);
  }
});

test('tam isabet 4 puan', () => {
  assert.equal(scoreFor(50, 50), 4);
});

test('bant sınırları: 4/3/2/0 geçişleri', () => {
  const t = 50;
  const eps = 1e-6;
  assert.equal(scoreFor(t, t + 0.5 * BAND - eps), 4);
  assert.equal(scoreFor(t, t + 0.5 * BAND), 4, 'sınır üstteki banda dahil');
  assert.equal(scoreFor(t, t + 0.5 * BAND + eps), 3);
  assert.equal(scoreFor(t, t + 1.5 * BAND), 3);
  assert.equal(scoreFor(t, t + 1.5 * BAND + eps), 2);
  assert.equal(scoreFor(t, t + 2.5 * BAND), 2);
  assert.equal(scoreFor(t, t + 2.5 * BAND + eps), 0);
});

test('puanlama simetrik', () => {
  const t = 37.4;
  for (const d of [0.1, 1, 2, 3.2, 5, 8, 12, 40]) {
    assert.equal(scoreFor(t, t - d), scoreFor(t, t + d), `mesafe ${d}`);
  }
});

test('uzak ibre 0 puan', () => {
  assert.equal(scoreFor(20, 80), 0);
  assert.equal(scoreFor(50, 0), 0);
  assert.equal(scoreFor(50, 100), 0);
});

test('bandsFor toplam genişliği hedef alanının iki katı yarısı kadar', () => {
  const bands = bandsFor(50);
  assert.equal(bands.length, 5);
  assert.equal(bands[0].from, 50 - HALF_TARGET);
  assert.equal(bands[4].to, 50 + HALF_TARGET);
  assert.deepEqual(bands.map(b => b.points), [2, 3, 4, 3, 2]);
  // bantlar bitişik ve boşluksuz
  for (let i = 1; i < bands.length; i++) {
    assert.ok(Math.abs(bands[i].from - bands[i - 1].to) < 1e-9);
  }
});

test('bandsFor ile scoreFor birbiriyle tutarlı', () => {
  for (let i = 0; i < 200; i++) {
    const t = randomTarget();
    const bands = bandsFor(t);
    for (const b of bands) {
      const mid = (b.from + b.to) / 2;
      assert.equal(scoreFor(t, mid), b.points, `hedef ${t}, bant ortası ${mid}`);
    }
  }
});

test('clampValue', () => {
  assert.equal(clampValue(-5), 0);
  assert.equal(clampValue(105), 100);
  assert.equal(clampValue(42.5), 42.5);
  assert.equal(clampValue(NaN), 50);
  assert.equal(clampValue(undefined), 50);
});

test('verdict sınırları', () => {
  assert.equal(verdict(40, 10).title, 'Aynı frekanstasınız');
  assert.equal(verdict(36, 10).title, 'Aynı frekanstasınız');
  assert.equal(verdict(35, 10).title, 'Çok iyi anlaşıyorsunuz');
  assert.equal(verdict(0, 10).title, 'Farklı frekanslardasınız');
  assert.equal(verdict(0, 0).title, 'Farklı frekanslardasınız', 'sıfır tura bölme hatası olmamalı');
});

test('shuffle elemanları korur', () => {
  const src = ['a', 'b', 'c', 'd', 'e'];
  const out = shuffle(src);
  assert.deepEqual(out.slice().sort(), src.slice().sort());
  assert.deepEqual(src, ['a', 'b', 'c', 'd', 'e'], 'kaynak dizi değişmemeli');
});
