// Uçtan uca oyun testi: üç ayrı worker, üç ayrı Firebase oturumu,
// uygulamanın gerçek room.js / game.js modülleri, emülatördeki gerçek kurallar.
// Emülatör kapalıysa atlanır (npm run emu).

import test from 'node:test';
import assert from 'node:assert/strict';
import { Player, waitAll } from './helpers/player.mjs';
import { emulatorUp, wipe, makeClient, dump } from './helpers/emulator.mjs';
import { scoreFor } from '../public/js/scoring.js';
import {
  totalScore, historyList, soloScores, psychicAverage, soloTotals,
} from '../public/js/logic.js';

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

  // Tek kilit yetmemeli — tur ancak herkes onaylayınca açılır
  assert.ok(await others[0].send('lock'), 'kilit yazılmalı');
  await waitAll(all, s => s.game.lockDeadline != null, 'geri sayım başladı');
  assert.equal(others[1].state.game.phase, 'guess',
    'bir kişinin kilidiyle tur açılmamalı');

  await others[1].send('lock');
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

test('tur ancak herkes kilitleyince açılır', opts, async (t) => {
  await freshStart();
  await seedSpectrums();
  const { a, all } = await trio();
  t.after(() => Promise.all(all.map(p => p.close())));

  await a.send('setRounds', { n: 3 });
  await a.send('start');
  await waitAll(all, s => s.game.phase === 'clue' && s.game.spectrum, 'kart çekildi');

  const { psychic, others } = psychicOf(all);
  await psychic.send('clue', { text: 'birlikte' });
  await waitAll(all, s => s.game.phase === 'guess', 'tahmin fazı');
  await others[0].send('dial', { value: 40 });
  await waitAll(all, s => s.game.dial?.value === 40, 'ibre eşitlendi');

  // Psişik kilitleyemez
  assert.equal(await psychic.send('lock'), false, 'psişik kilitleyememeli');

  await others[0].send('lock');
  await waitAll(all, s => s.view.expected.length === 2, 'iki tahminci bekleniyor');
  await waitAll(others, s => s.locks?.[0]?.[others[0].uid] === 40, 'kilit yazıldı');
  assert.equal(all[0].state.game.phase, 'guess', 'tek kilitle açılmamalı');
  assert.equal(others[0].state.view.everyoneLocked, false);

  // İkinci kilit turu açar
  await others[1].send('lock');
  await waitAll(all, s => s.game.phase === 'reveal', 'açılış');
  await waitAll(all, s => s.history && s.history[0], 'sonuç kaydedildi');
  assert.equal(historyList(all[0].state.history).length, 1, 'tek kayıt olmalı');
  assert.equal(all[0].state.game.final, 40, 'kilitlenen değer ibrenin son değeri');
  assert.deepEqual(all.flatMap(p => p.errors), []);
});

test('ortak modda ibre oynayınca eski onaylar düşer', opts, async (t) => {
  await freshStart();
  await seedSpectrums();
  const { a, all } = await trio();
  t.after(() => Promise.all(all.map(p => p.close())));

  await a.send('setRounds', { n: 3 });
  await a.send('start');
  await waitAll(all, s => s.game.phase === 'clue' && s.game.spectrum, 'kart çekildi');
  const { psychic, others } = psychicOf(all);
  await psychic.send('clue', { text: 'oynak' });
  await waitAll(all, s => s.game.phase === 'guess', 'tahmin fazı');

  await others[0].send('dial', { value: 30 });
  await waitAll(all, s => s.game.dial?.value === 30, 'ibre 30');
  await others[0].send('lock');
  await waitAll(others, s => s.view.iLocked || s.me !== others[0].uid, 'kilit yazıldı');

  // İkinci kişi ibreyi oynatıyor: ilk onay artık geçerli değil
  await others[1].send('dial', { value: 70 });
  await waitAll(all, s => s.game.dial?.value === 70, 'ibre 70');
  await waitAll([others[0]], s => s.view.iLocked === false,
    'ibre oynayınca kendi kilidim düşmeli');
  assert.equal(all[0].state.game.phase, 'guess', 'tur açılmamalı');

  // İkisi de yeni değere kilitleyince açılır
  await others[0].send('lock');
  await others[1].send('lock');
  await waitAll(all, s => s.game.phase === 'reveal', 'açılış');
  assert.equal(all[0].state.game.final, 70, 'son ibre değeriyle kapanmalı');
  assert.deepEqual(all.flatMap(p => p.errors), []);
});

test('süre dolunca tur kendiliğinden açılır', opts, async (t) => {
  await freshStart();
  await seedSpectrums();
  const { a, all, code } = await trio();
  t.after(() => Promise.all(all.map(p => p.close())));

  await a.send('setRounds', { n: 3 });
  await a.send('start');
  await waitAll(all, s => s.game.phase === 'clue' && s.game.spectrum, 'kart çekildi');
  const { psychic, others } = psychicOf(all);
  await psychic.send('clue', { text: 'zaman' });
  await waitAll(all, s => s.game.phase === 'guess', 'tahmin fazı');

  await others[0].send('dial', { value: 60 });
  await others[0].send('lock');                       // yalnızca biri kilitliyor
  await waitAll(all, s => s.game.lockDeadline != null, 'geri sayım başladı');
  assert.equal(all[0].state.game.phase, 'guess', 'süre dolmadan açılmamalı');

  // 20 saniye beklemek yerine son tarihi geçmişe çekiyoruz
  const admin = await makeClient('clock');
  await admin.set(`rooms/${code}/state/lockDeadline`, Date.now() - 1000);
  await admin.close();

  await waitAll(all, s => s.game.phase === 'reveal', 'süre dolunca açıldı', 15000);
  await waitAll(all, s => s.history && s.history[0], 'sonuç kaydedildi');
  assert.deepEqual(all.flatMap(p => p.errors), []);
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

/* ══════════════════ Bireysel mod ══════════════════ */

test('bireysel mod: herkes kendi ibresini çevirir, kendi puanını alır', opts, async (t) => {
  await freshStart();
  await seedSpectrums();
  const { a, all } = await trio();
  t.after(() => Promise.all(all.map(p => p.close())));

  await a.send('setMode', { m: 'solo' });
  await a.send('setRounds', { n: 3 });
  await waitAll(all, s => s.game.mode === 'solo', 'mod bireysel');

  await a.send('start');
  await waitAll(all, s => s.game.phase === 'clue' && s.game.spectrum, 'kart çekildi');
  const { psychic, others } = psychicOf(all);
  await psychic.send('clue', { text: 'ayrı ayrı' });
  await waitAll(all, s => s.game.phase === 'guess', 'tahmin fazı');

  // Hedefi bilen psişik, iki tahminciyi farklı yerlere koyduralım:
  // biri tam isabet, diğeri uzak.
  const target = await psychic.send('knownTarget');
  const exact = target;
  const far = target > 50 ? 5 : 95;

  await others[0].send('dial', { value: exact });
  await others[1].send('dial', { value: far });

  // GİZLİLİK: tahminciler birbirini görmez
  await waitAll([others[0]], s => s.view.myGuess != null, 'kendi ibrem yazıldı');
  assert.deepEqual(Object.keys(others[0].state.view.visibleGuesses), [others[0].uid],
    'tahminci yalnızca kendi ibresini görmeli');
  assert.deepEqual(Object.keys(others[1].state.view.visibleGuesses), [others[1].uid],
    'diğer tahminci de yalnızca kendisini görmeli');

  // Psişik hepsini canlı görür
  await psychic.waitFor(s => Object.keys(s.view.visibleGuesses).length === 2,
    'psişik iki ibreyi de görür');

  await others[0].send('lock');
  assert.equal(all[0].state.game.phase, 'guess', 'tek kilitle açılmamalı');
  await others[1].send('lock');
  await waitAll(all, s => s.game.phase === 'reveal', 'açılış');
  await waitAll(all, s => s.history && s.history[0], 'sonuç kaydedildi');

  const h = all[0].state.history[0];
  const expected = soloScores(target, h.guesses);
  assert.equal(h.points[others[0].uid], 4, 'tam isabet 4 puan');
  assert.equal(h.points[others[1].uid], 0, 'uzak tahmin 0 puan');
  assert.deepEqual(h.points, expected, 'puanlar saf fonksiyonla aynı');
  assert.equal(h.psychicPoints, psychicAverage(h.points), 'psişik ortalamayı alır');
  assert.equal(h.psychicPoints, 2, '(4+0)/2 = 2');

  // Açılışta herkes bütün ibreleri görür
  for (const p of all) {
    await p.waitFor(s => Object.keys(s.view.visibleGuesses).length === 2,
      `${p.name} açılışta hepsini görmeli`);
  }
  assert.deepEqual(all.flatMap(p => p.errors), []);
});

test('bireysel mod: puanlar oyuncu bazında toplanır ve oyun biter', opts, async (t) => {
  await freshStart();
  await seedSpectrums();
  const { a, all } = await trio();
  t.after(() => Promise.all(all.map(p => p.close())));

  await a.send('setMode', { m: 'solo' });
  await a.send('setRounds', { n: 3 });
  await a.send('start');

  for (let r = 0; r < 3; r++) {
    await waitAll(all, s => s.game.phase === 'clue' && s.game.spectrum, 'kart çekildi');
    const { psychic, others } = psychicOf(all);
    const target = await psychic.send('knownTarget');
    await psychic.send('clue', { text: `tur-${r}` });
    await waitAll(all, s => s.game.phase === 'guess', 'tahmin fazı');

    await others[0].send('dial', { value: target });          // 4 puan
    await others[1].send('dial', { value: target > 50 ? 2 : 98 });  // 0 puan
    await others[0].send('lock');
    await others[1].send('lock');
    await waitAll(all, s => s.game.phase === 'reveal', 'açılış');
    await waitAll(all, s => s.history && s.history[r], 'sonuç kaydedildi');
    await psychic.send('next');
  }

  await waitAll(all, s => s.game.phase === 'gameover', 'oyun bitti');

  const totals = soloTotals(all[0].state.history);
  const sum = Object.values(totals).reduce((x, y) => x + y, 0);
  // Her turda: bir tahminci 4, biri 0, psişik ortalama 2 → toplam 6
  assert.equal(sum, 18, `üç turda toplam 18 olmalı, gelen ${sum}`);
  assert.deepEqual(totals, soloTotals(all[2].state.history), 'herkeste aynı tablo');

  // Her oyuncu bir kez psişik olduğu için 2 puanı garanti, iki turda tahminci
  for (const p of all) {
    assert.ok(totals[p.uid] >= 2, `${p.name} en az psişik puanını almalı`);
  }
  assert.deepEqual(all.flatMap(p => p.errors), []);
});

/* ══════════════════ Oda sahipliği ══════════════════ */

test('odayı kuran ayrılınca oda kapanır ve herkes çıkar', opts, async (t) => {
  await freshStart();
  await seedSpectrums();
  const { a, b, c, all, code } = await trio();
  t.after(() => Promise.all(all.map(p => p.close())));

  await waitAll(all, s => s.meta?.hostUid === a.uid, 'kurucu kaydedildi');
  assert.equal(a.state.view.iAmOwner, true, 'kuran kişi sahip olmalı');
  assert.equal(b.state.view.iAmOwner, false);

  // Oyun ortasında bile olsa kapanmalı
  await a.send('setRounds', { n: 3 });
  await a.send('start');
  await waitAll(all, s => s.game.phase === 'clue', 'oyun başladı');

  assert.equal(await a.send('close'), true, 'kurucu odayı kapatabilmeli');

  // Diğerleri önce "kapandı" sinyalini görür, sonra oda silinir
  await waitAll([b, c], s => s.game?.phase === 'closed', 'kapanma sinyali');
  await waitAll([b, c], s => s.meta == null, 'oda silindi');
  assert.equal(a.state.code, null, 'kuran kişi odadan çıkmış olmalı');

  // Kapanan odaya artık girilemez
  await assert.rejects(() => b.send('join', { code, name: 'Beste' }),
    /oda yok/i, 'kapanan odaya katılınamamalı');
});

test('kurucu olmayan çıkınca oda açık kalır', opts, async (t) => {
  await freshStart();
  await seedSpectrums();
  const { a, b, c, all } = await trio();
  t.after(() => Promise.all(all.map(p => p.close())));

  await waitAll(all, s => s.meta?.hostUid === a.uid, 'kurucu kaydedildi');
  assert.equal(await b.send('close'), false, 'kurucu olmayan kapatamamalı');

  await b.send('leave');
  await waitAll([a, c], s => s.players[b.uid]?.online === false, 'ayrıldı');
  assert.equal(a.state.meta?.hostUid, a.uid, 'oda ayakta kalmalı');
  assert.equal(a.state.game?.phase, 'lobby');
});

test('kurucu çevrimdışıyken başlatma yetkisi devrolur', opts, async (t) => {
  await freshStart();
  await seedSpectrums();
  const { a, b, c, all } = await trio();
  t.after(() => Promise.all(all.map(p => p.close())));

  await waitAll(all, s => Object.keys(s.players).length === 3, 'üçü de içeride');
  await a.send('leave');                     // kapatmadan, sadece bağlantıyı bırak
  await waitAll([b, c], s => s.players[a.uid]?.online === false, 'kurucu çevrimdışı');

  // Kalanlar oyunu başlatabilmeli — oda kilitlenmemeli
  await b.send('start');
  await waitAll([b, c], s => s.game.phase === 'clue', 'oyun başladı');
});
