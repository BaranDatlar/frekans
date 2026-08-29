// Uçtan uca oyun testi: üç ayrı worker, üç ayrı Firebase oturumu,
// uygulamanın gerçek room.js / game.js modülleri, emülatördeki gerçek kurallar.
// Emülatör kapalıysa atlanır (npm run emu).

import test from 'node:test';
import assert from 'node:assert/strict';
import { Player, waitAll } from './helpers/player.mjs';
import { emulatorUp, wipe, makeClient, dump } from './helpers/emulator.mjs';
import { scoreFor } from '../public/js/scoring.js';
import { totalScore, historyList } from '../public/js/logic.js';

const up = await emulatorUp();
const opts = up ? {} : { skip: 'Emülatör çalışmıyor (npm run emu)' };

const SPECTRUMS = Array.from({ length: 12 }, (_, i) => ({ left: `Sol${i}`, right: `Sağ${i}` }));

/** Temizliğin gerçekten olduğunu doğrula — sessizce çalışmayan bir wipe
 *  testleri birbirinin verisiyle kirletir. */
async function freshStart() {
  await wipe();
  assert.equal(await dump(), null, 'emülatör temiz başlamalı');
}

async function seedSpectrums() {
  const c = await makeClient('seed');
  const updates = {};
  SPECTRUMS.forEach((s, i) => {
    updates[`s${i}`] = { left: s.left, right: s.right, addedBy: c.uid, createdAt: Date.now() };
  });
  await c.update('spectrums', updates);
  await c.close();
}

async function trio() {
  const [a, b, c] = await Promise.all([
    Player.spawn('Ali'), Player.spawn('Beste'), Player.spawn('Can'),
  ]);
  const code = await a.send('create', { name: 'Ali' });
  await b.send('join', { code, name: 'Beste' });
  await c.send('join', { code, name: 'Can' });
  const all = [a, b, c];
  await waitAll(all, s => Object.keys(s.players || {}).length === 3, 'üç oyuncu da görünür');
  return { a, b, c, all, code };
}

function psychicOf(all) {
  const uid = all[0].state.game.psychicUid;
  const psychic = all.find(p => p.uid === uid);
  return { psychic, others: all.filter(p => p !== psychic) };
}

/** Bir turu baştan sona oynar. Tur indeksini ve o turun psişiğini döner. */
async function playRound(all, dialValue, clue = 'ipucu') {
  // Psişiği okumadan ÖNCE yeni turun durumunun herkese ulaşmasını bekle,
  // yoksa bir önceki turun psişiği okunur.
  await waitAll(all, s => s.game.phase === 'clue' && s.game.spectrum, 'kart çekildi');
  const { psychic, others } = psychicOf(all);

  // Hedefi sadece psişik bilir
  assert.equal(typeof await psychic.send('knownTarget'), 'number', 'psişik hedefi bilmeli');
  for (const o of others) {
    assert.equal(await o.send('knownTarget'), null, `${o.name} hedefi bilmemeli`);
  }

  await psychic.send('clue', { text: clue });
  await waitAll(all, s => s.game.phase === 'guess', 'tahmin fazı');

  await others[0].send('dial', { value: dialValue });
  await waitAll(all, s => Math.abs((s.game.dial?.value ?? -1) - dialValue) < 0.05,
    'ibre herkeste eşitlendi');

  const idx = psychic.state.game.roundIndex;
  assert.ok(await others[1].send('lock'), 'kilit başarılı olmalı');
  await waitAll(all, s => s.game.phase === 'reveal', 'açılış fazı');
  await waitAll(all, s => s.history && s.history[idx], 'tur sonucu kaydedildi');
  return { idx, psychic };
}

test('üç oyuncu tam bir oyunu bitirir', opts, async (t) => {
  await freshStart();
  await seedSpectrums();
  const { a, b, c, all } = await trio();
  t.after(() => Promise.all(all.map(p => p.close())));

  await a.send('setRounds', { n: 3 });
  await waitAll(all, s => s.game.totalRounds === 3, 'tur sayısı 3');

  await a.send('start');
  await waitAll(all, s => s.game.phase === 'clue', 'oyun başladı');

  const seenPsychics = new Set();
  const dials = [50, 12.5, 88];

  for (let r = 0; r < 3; r++) {
    const { idx, psychic } = await playRound(all, dials[r], `ipucu-${r}`);
    seenPsychics.add(psychic.uid);
    assert.equal(idx, r, 'tur indeksi ilerlemeli');

    // Puan üç cihazda da aynı ve hedefe göre doğru
    const target = await psychic.send('knownTarget');
    const expected = scoreFor(target, all[0].state.game.final);
    for (const p of all) {
      assert.equal(p.state.history[idx].points, expected,
        `${p.name} aynı puanı görmeli`);
    }
    assert.equal(historyList(all[0].state.history).length, r + 1,
      'her tur için tek kayıt olmalı');

    await psychic.send('next');
  }

  await waitAll(all, s => s.game.phase === 'gameover', 'oyun bitti');
  assert.equal(seenPsychics.size, 3, 'her oyuncu bir kez psişik olmalı');

  const total = totalScore(a.state.history);
  assert.equal(total, totalScore(c.state.history), 'toplam skor herkeste aynı');
  assert.ok(total >= 0 && total <= 12, `toplam 0-12 arasında olmalı, ${total}`);

  // Tekrar oyna: lobiye döner, geçmiş silinir
  await b.send('restart');
  await waitAll(all, s => s.game.phase === 'lobby', 'lobiye dönüldü');
  await waitAll(all, s => historyList(s.history).length === 0, 'geçmiş temizlendi');

  assert.deepEqual(all.flatMap(p => p.errors), [], 'uygulama hatası olmamalı');
});

test('aynı anda iki kilit tek sonuç üretir', opts, async (t) => {
  await freshStart();
  await seedSpectrums();
  const { a, all } = await trio();
  t.after(() => Promise.all(all.map(p => p.close())));

  await a.send('setRounds', { n: 3 });
  await a.send('start');
  await waitAll(all, s => s.game.phase === 'clue' && s.game.spectrum, 'kart çekildi');

  const { psychic, others } = psychicOf(all);
  await psychic.send('clue', { text: 'çift kilit' });
  await waitAll(all, s => s.game.phase === 'guess', 'tahmin fazı');
  await others[0].send('dial', { value: 40 });
  await waitAll(all, s => s.game.dial?.value === 40, 'ibre eşitlendi');

  const results = await Promise.all([others[0].send('lock'), others[1].send('lock')]);
  assert.equal(results.filter(Boolean).length, 1, 'kilit tam olarak bir kez işlemeli');

  await waitAll(all, s => s.game.phase === 'reveal', 'açılış');
  await waitAll(all, s => s.history && s.history[0], 'sonuç kaydedildi');
  assert.equal(historyList(all[0].state.history).length, 1, 'tek kayıt olmalı');
  assert.equal(all[0].state.game.final, 40, 'kilitlenen değer ibrenin son değeri');
});

test('psişik düşerse sıra atlanır ve tur kaybolmaz', opts, async (t) => {
  await freshStart();
  await seedSpectrums();
  const { a, all } = await trio();
  t.after(() => Promise.all(all.map(p => p.close())));

  await a.send('setRounds', { n: 3 });
  await a.send('start');
  await waitAll(all, s => s.game.phase === 'clue' && s.game.spectrum, 'kart çekildi');

  const { psychic, others } = psychicOf(all);
  const before = others[0].state.game.roundIndex;

  await psychic.send('leave');
  await waitAll(others, s => s.players[psychic.uid]?.online === false, 'psişik çevrimdışı');

  await others[0].send('skip');
  await waitAll(others, s => s.game.psychicUid !== psychic.uid, 'sıra devredildi');
  assert.equal(others[0].state.game.roundIndex, before, 'tur numarası korunmalı');
  assert.equal(others[0].state.game.phase, 'clue', 'ipucu fazında kalınmalı');

  // Yeni psişik kartı çeker ve oyun devam eder
  await waitAll(others, s => s.game.spectrum != null, 'yeni kart çekildi');
  assert.deepEqual(others.flatMap(p => p.errors), [], 'uygulama hatası olmamalı');
});

test('spektrumlar tekrar etmez ve tükenince sıfırlanır', opts, async (t) => {
  await freshStart();
  const c = await makeClient('few');
  await c.update('spectrums', {
    x1: { left: 'A', right: 'B', addedBy: c.uid, createdAt: 1 },
    x2: { left: 'C', right: 'D', addedBy: c.uid, createdAt: 2 },
  });
  await c.close();

  const { a, all } = await trio();
  t.after(() => Promise.all(all.map(p => p.close())));

  await a.send('setRounds', { n: 3 });
  await a.send('start');

  const used = [];
  for (let r = 0; r < 3; r++) {
    await waitAll(all, s => s.game.phase === 'clue' && s.game.spectrum, 'kart çekildi');
    used.push(all[0].state.game.spectrum.id);
    const { idx, psychic } = await playRound(all, 50, `t${r}`);
    await psychic.send('next');
    if (r < 2) await waitAll(all, s => s.game.roundIndex === idx + 1, 'sonraki tur');
  }

  assert.notEqual(used[0], used[1], 'ilk iki tur farklı kart kullanmalı');
  assert.equal(used.length, 3, 'havuz tükense de üçüncü tur oynanabilmeli');
});
