// Uçtan uca oyun testi: her oyuncu ayrı worker, ayrı Firebase oturumu,
// uygulamanın GERÇEK modülleri (room.js / game.js / packs.js), emülatördeki
// gerçek güvenlik kuralları. Emülatör kapalıysa atlanır (npm run emu).

import test from 'node:test';
import assert from 'node:assert/strict';
import { Player, waitAll } from './helpers/player.mjs';
import { emulatorUp, wipe, makeClient, dump } from './helpers/emulator.mjs';
import { historyList, soloScores, psychicAverage, soloTotals } from '../public/js/logic.js';
import { teamTotals, teamWinner, psychicTeamAverage } from '../public/js/teams.js';
import { BUILTIN_CARDS } from '../public/js/builtin.js';
import { SOURCE } from '../public/js/deck.js';

const up = await emulatorUp();
const opts = up ? {} : { skip: 'Emülatör çalışmıyor (npm run emu)' };

const NAMES = ['Ali', 'Beste', 'Can', 'Deniz', 'Ece', 'Faruk'];

/** Temizliğin gerçekten olduğunu doğrula. */
async function freshStart() {
  await wipe();
  assert.equal(await dump(), null, 'emülatör temiz başlamalı');
}

/**
 * Oda kurup istenen sayıda oyuncuyu içine alır.
 * @param {{players?:number, guestIdx?:number[]}} o
 */
async function makeRoom({ players = 3, guestIdx = [] } = {}) {
  const names = NAMES.slice(0, players);
  const all = await Promise.all(
    names.map((n, i) => Player.spawn(n, { guest: guestIdx.includes(i) })));
  const code = await all[0].send('create', { name: names[0] });
  for (let i = 1; i < all.length; i++) {
    await all[i].send('join', { code, name: names[i] });
  }
  await waitAll(all, s => Object.keys(s.players || {}).length === all.length,
    'herkes odada görünür');
  return { all, code, host: all[0] };
}

function psychicOf(all) {
  const uid = all[0].state.game.psychicUid;
  const psychic = all.find(p => p.uid === uid);
  return { psychic, others: all.filter(p => p !== psychic) };
}

/** Bir turu baştan sona oynar. `valueFor(oyuncu, hedef, digerleri)` ibre değerini verir. */
async function playRound(all, valueFor, clue = 'ipucu') {
  await waitAll(all, s => s.game.phase === 'clue' && s.game.spectrum, 'kart çekildi');
  const { psychic, others } = psychicOf(all);

  // Hedefi yalnızca psişik bilir
  const target = await psychic.send('knownTarget');
  assert.equal(typeof target, 'number', 'psişik hedefi bilmeli');
  for (const o of others) {
    assert.equal(await o.send('knownTarget'), null, `${o.name} hedefi bilmemeli`);
  }

  await psychic.send('clue', { text: clue });
  await waitAll(all, s => s.game.phase === 'guess', 'tahmin fazı');

  for (const o of others) await o.send('dial', { value: valueFor(o, target, others) });
  const idx = psychic.state.game.roundIndex;
  for (const o of others) await o.send('lock');

  await waitAll(all, s => s.game.phase === 'reveal', 'açılış');
  await waitAll(all, s => s.history && s.history[idx], 'tur sonucu kaydedildi');
  return { idx, psychic, others, target };
}

/** Tam isabet / tamamen ışınlanmış tahmin üreten yardımcılar. */
const hit = (_p, t) => t;
const miss = (_p, t) => (t > 50 ? 2 : 98);

/* ══════════════════ Bireysel mod ══════════════════ */

test('bireysel modda üç oyuncu tam bir oyunu bitirir', opts, async (t) => {
  await freshStart();
  const { all, host } = await makeRoom();
  t.after(() => Promise.all(all.map(p => p.close())));

  await host.send('setRounds', { n: 3 });
  await waitAll(all, s => s.game.totalRounds === 3, 'tur sayısı 3');
  assert.equal(all[0].state.view.mode, 'solo', 'varsayılan mod bireysel');

  await host.send('start');
  const seenPsychics = new Set();

  for (let r = 0; r < 3; r++) {
    // Sıradaki tahmincilerden biri tam bilsin, diğeri ışınlansın
    const { idx, psychic, target } = await playRound(
      all, (p, t2, rest) => (p === rest[0] ? hit(p, t2) : miss(p, t2)), `ipucu-${r}`);
    seenPsychics.add(psychic.uid);
    assert.equal(idx, r, 'tur indeksi ilerlemeli');

    const h = all[0].state.history[idx];
    assert.deepEqual(h.points, soloScores(target, h.guesses), 'puanlar saf fonksiyonla aynı');
    assert.equal(h.psychicPoints, psychicAverage(h.points),
      'bireyselde psişik tüm tahmincilerin ortalamasını alır');
    for (const p of all) {
      assert.deepEqual(p.state.history[idx].points, h.points, `${p.name} aynı puanları görmeli`);
    }
    await psychic.send('next');
  }

  await waitAll(all, s => s.game.phase === 'gameover', 'oyun bitti');
  assert.equal(seenPsychics.size, 3, 'her oyuncu bir kez psişik olmalı');
  assert.deepEqual(soloTotals(all[0].state.history), soloTotals(all[2].state.history),
    'tablo herkeste aynı');
  assert.deepEqual(all.flatMap(p => p.errors), []);
});


test('tur ancak herkes kilitleyince açılır', opts, async (t) => {
  await freshStart();
  const { all, host } = await makeRoom();
  t.after(() => Promise.all(all.map(p => p.close())));

  await host.send('setRounds', { n: 3 });
  await host.send('start');
  await waitAll(all, s => s.game.phase === 'clue' && s.game.spectrum, 'kart çekildi');

  const { psychic, others } = psychicOf(all);
  assert.equal(await psychic.send('lock'), false, 'psişik kilitleyememeli');

  await psychic.send('clue', { text: 'birlikte' });
  await waitAll(all, s => s.game.phase === 'guess', 'tahmin fazı');

  await others[0].send('dial', { value: 40 });
  await others[0].send('lock');
  await waitAll(all, s => s.game.lockDeadline != null, 'geri sayım başladı');
  assert.equal(all[0].state.game.phase, 'guess', 'tek kilitle açılmamalı');
  assert.equal(others[0].state.view.everyoneLocked, false);

  await others[1].send('lock');
  await waitAll(all, s => s.game.phase === 'reveal', 'açılış');
  await waitAll(all, s => s.history && s.history[0], 'sonuç kaydedildi');
  assert.equal(historyList(all[0].state.history).length, 1, 'tek kayıt olmalı');
  assert.deepEqual(all.flatMap(p => p.errors), []);
});

test('süre dolunca tur kendiliğinden açılır', opts, async (t) => {
  await freshStart();
  const { all, host, code } = await makeRoom();
  t.after(() => Promise.all(all.map(p => p.close())));

  await host.send('setRounds', { n: 3 });
  await host.send('start');
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

test('bireysel mod: tahminciler birbirinin ibresini görmez', opts, async (t) => {
  await freshStart();
  const { all, host } = await makeRoom();
  t.after(() => Promise.all(all.map(p => p.close())));

  await host.send('setRounds', { n: 3 });
  await host.send('start');
  await waitAll(all, s => s.game.phase === 'clue' && s.game.spectrum, 'kart çekildi');
  const { psychic, others } = psychicOf(all);
  const target = await psychic.send('knownTarget');
  await psychic.send('clue', { text: 'ayrı ayrı' });
  await waitAll(all, s => s.game.phase === 'guess', 'tahmin fazı');

  await others[0].send('dial', { value: target });
  await others[1].send('dial', { value: target > 50 ? 5 : 95 });

  await waitAll([others[0]], s => s.view?.myGuess != null, 'kendi ibrem yazıldı');
  assert.deepEqual(Object.keys(others[0].state.view.visibleGuesses), [others[0].uid],
    'tahminci yalnızca kendi ibresini görmeli');
  await psychic.waitFor(s => Object.keys(s.view?.visibleGuesses).length === 2,
    'psişik iki ibreyi de görür');

  for (const o of others) await o.send('lock');
  await waitAll(all, s => s.game.phase === 'reveal', 'açılış');
  await waitAll(all, s => s.history && s.history[0], 'sonuç kaydedildi');

  const h = all[0].state.history[0];
  assert.equal(h.points[others[0].uid], 4, 'tam isabet 4 puan');
  assert.equal(h.points[others[1].uid], 0, 'uzak tahmin 0 puan');
  assert.equal(h.psychicPoints, 2, '(4+0)/2 = 2');
  for (const p of all) {
    await p.waitFor(s => Object.keys(s.view?.visibleGuesses).length === 2,
      `${p.name} açılışta hepsini görmeli`);
  }
});

/* ══════════════════ Takım modu ══════════════════ */

/** 4 oyuncuyla takım modunda oda kurar: Ali+Beste = a, Can+Deniz = b. */
async function makeTeamRoom() {
  const { all, host, code } = await makeRoom({ players: 4 });
  await host.send('setMode', { m: 'team' });
  await waitAll(all, s => s.game.mode === 'team', 'takım modu');
  await all[0].send('setTeam', { t: 'a' });
  await all[1].send('setTeam', { t: 'a' });
  await all[2].send('setTeam', { t: 'b' });
  await all[3].send('setTeam', { t: 'b' });
  await waitAll(all, s => Object.keys(s.game.teams || {}).length === 4, 'takımlar kuruldu');
  return { all, host, code };
}

test('takım modu: dengesiz takımda oyun başlamaz', opts, async (t) => {
  await freshStart();
  const { all, host } = await makeRoom({ players: 4 });
  t.after(() => Promise.all(all.map(p => p.close())));

  await host.send('setMode', { m: 'team' });
  await all[0].send('setTeam', { t: 'a' });
  await all[1].send('setTeam', { t: 'b' });
  await all[2].send('setTeam', { t: 'b' });
  await all[3].send('setTeam', { t: 'b' });
  await waitAll(all, s => Object.keys(s.game.teams || {}).length === 4, 'takımlar yazıldı');

  await assert.rejects(() => host.send('start'), /en az 2/i,
    '1–3 dağılımıyla başlatılamamalı');
  assert.equal(all[0].state.game.phase, 'lobby');
});

test('takım modu: puanlar takıma yazılır ve kazanan doğru belirlenir', opts, async (t) => {
  await freshStart();
  const { all, host } = await makeTeamRoom();
  t.after(() => Promise.all(all.map(p => p.close())));

  await host.send('setRounds', { n: 4 });
  await host.send('start');
  await waitAll(all, s => s.game.phase === 'clue', 'oyun başladı');

  // "a" takımı hep tam isabet, "b" takımı hep ışınlanıyor
  const teamOfPlayer = (p) => all[0].state.game.teams[p.uid];
  for (let r = 0; r < 4; r++) {
    const { idx, psychic } = await playRound(
      all, (p, t2) => (teamOfPlayer(p) === 'a' ? hit(p, t2) : miss(p, t2)), `tur-${r}`);

    const h = all[0].state.history[idx];
    assert.ok(h.teams, 'tur kendi takım dağılımını taşımalı');
    assert.equal(h.psychicPoints,
      psychicTeamAverage(h.points, h.teams, h.psychicUid),
      'psişik yalnızca takımdaşlarının ortalamasını almalı');
    await psychic.send('next');
  }

  await waitAll(all, s => s.game.phase === 'gameover', 'oyun bitti');
  const totals = teamTotals(all[0].state.history);
  assert.deepEqual(totals, teamTotals(all[3].state.history), 'toplam herkeste aynı');
  assert.ok(totals.a > totals.b, `isabet eden takım kazanmalı: ${JSON.stringify(totals)}`);
  assert.equal(teamWinner(totals).winner, 'a');
  assert.deepEqual(all.flatMap(p => p.errors), []);
});

test('takım modu: psişik rakibin iyi bilmesinden puan almaz', opts, async (t) => {
  await freshStart();
  const { all, host } = await makeTeamRoom();
  t.after(() => Promise.all(all.map(p => p.close())));

  await host.send('setRounds', { n: 3 });
  await host.send('start');
  await waitAll(all, s => s.game.phase === 'clue' && s.game.spectrum, 'kart çekildi');

  const { psychic } = psychicOf(all);
  const teams = all[0].state.game.teams;
  const myTeam = teams[psychic.uid];

  // Psişiğin takımdaşı ışınlanıyor, RAKİPLER tam isabet yapıyor
  const { idx } = await playRound(all,
    (p, t2) => (teams[p.uid] === myTeam ? miss(p, t2) : hit(p, t2)), 'ters');

  const h = all[0].state.history[idx];
  assert.equal(h.psychicPoints, 0,
    'rakipler tam bilse bile psişik puan almamalı');
  const opponents = Object.entries(h.points).filter(([id]) => teams[id] !== myTeam);
  assert.ok(opponents.every(([, p]) => p === 4), 'rakipler gerçekten tam bilmiş olmalı');
});

test('takım modu: sıra iki takım arasında dönüşümlü ilerler', opts, async (t) => {
  await freshStart();
  const { all, host } = await makeTeamRoom();
  t.after(() => Promise.all(all.map(p => p.close())));

  await host.send('setRounds', { n: 4 });
  await host.send('start');

  const seq = [];
  for (let r = 0; r < 4; r++) {
    await waitAll(all, s => s.game.phase === 'clue' && s.game.spectrum, 'kart çekildi');
    const { psychic } = psychicOf(all);
    seq.push(all[0].state.game.teams[psychic.uid]);
    const { psychic: p2 } = await playRound(all, hit, `t${r}`);
    await p2.send('next');
  }
  for (let i = 1; i < seq.length; i++) {
    assert.notEqual(seq[i], seq[i - 1], `psişik sırası dönüşümlü olmalı: ${seq}`);
  }
});

/* ══════════════════ Deste ══════════════════ */

test('kurucu özel set yükler, kartlar o setten gelir', opts, async (t) => {
  await freshStart();
  const { all, host } = await makeRoom();
  t.after(() => Promise.all(all.map(p => p.close())));

  const cards = Array.from({ length: 5 }, (_, i) => ({ l: `Sol${i}`, r: `Sağ${i}` }));
  await host.send('savePack', { pack: { name: 'Deneme seti', cards } });
  const saved = await host.send('loadPacks');
  assert.equal(saved.length, 1, 'set hesaba kaydedilmeli');
  assert.equal(saved[0].cards.length, 5);

  await host.send('setDeck', { deck: { source: SOURCE.CUSTOM, name: 'Deneme seti', cards } });
  await waitAll(all, s => s.deck?.source === SOURCE.CUSTOM, 'deste odaya yazıldı');
  await waitAll(all, s => s.view?.deckSize === 5, 'herkes 5 kartlık desteyi çözmeli');

  await host.send('setRounds', { n: 3 });
  await host.send('start');

  for (let r = 0; r < 3; r++) {
    await waitAll(all, s => s.game.phase === 'clue' && s.game.spectrum, 'kart çekildi');
    const card = all[0].state.game.spectrum;
    assert.match(card.left, /^Sol\d$/, `kart özel setten gelmeli: ${card.left}`);
    const { psychic } = await playRound(all, hit, `t${r}`);
    await psychic.send('next');
  }
});

test('karışık deste hazır kartları da içerir', opts, async (t) => {
  await freshStart();
  const { all, host } = await makeRoom();
  t.after(() => Promise.all(all.map(p => p.close())));

  const cards = [{ l: 'A', r: 'B' }, { l: 'C', r: 'D' }, { l: 'E', r: 'F' }];
  await host.send('setDeck', { deck: { source: SOURCE.MIXED, name: 'Ek', cards } });
  await waitAll(all, s => s.view?.deckSize === BUILTIN_CARDS.length + 3,
    'karışık deste hazır + özel kart sayısı kadar olmalı');
});

test('varsayılan deste hazır settir ve tükenince sıfırlanır', opts, async (t) => {
  await freshStart();
  const { all, host } = await makeRoom();
  t.after(() => Promise.all(all.map(p => p.close())));

  await waitAll(all, s => s.view?.deckSize === BUILTIN_CARDS.length, 'hazır deste yüklü');

  // İki kartlık desteyle üç tur oyna: üçüncü turda liste sıfırlanmalı
  await host.send('setDeck', {
    deck: { source: SOURCE.CUSTOM, name: 'Minik', cards: [{ l: 'A', r: 'B' }, { l: 'C', r: 'D' }] },
  });
  await waitAll(all, s => s.view?.deckSize === 2, 'minik deste');
  await host.send('setRounds', { n: 3 });
  await host.send('start');

  const used = [];
  for (let r = 0; r < 3; r++) {
    await waitAll(all, s => s.game.phase === 'clue' && s.game.spectrum, 'kart çekildi');
    used.push(all[0].state.game.spectrum.id);
    const { psychic } = await playRound(all, hit, `t${r}`);
    await psychic.send('next');
  }
  assert.notEqual(used[0], used[1], 'ilk iki tur farklı kart kullanmalı');
  assert.equal(used.length, 3, 'deste tükense de üçüncü tur oynanabilmeli');
});

/* ══════════════════ Misafir ══════════════════ */

test('misafir odaya katılıp oynar ama oda kuramaz', opts, async (t) => {
  await freshStart();
  const { all, host } = await makeRoom({ players: 3, guestIdx: [2] });
  t.after(() => Promise.all(all.map(p => p.close())));

  const guest = all[2];
  assert.equal(await guest.send('isGuest'), true, 'üçüncü oyuncu misafir olmalı');

  // Kural düzeyinde engellenir: misafir meta yazamaz
  await assert.rejects(() => guest.send('create', { name: 'Misafir' }),
    /permission/i, 'misafir oda kuramamalı');
  // Set de kaydedemez
  await assert.rejects(
    () => guest.send('savePack', { pack: { name: 'x', cards: [
      { l: 'a', r: 'b' }, { l: 'c', r: 'd' }, { l: 'e', r: 'f' }] } }),
    /giriş/i, 'misafir set kaydedememeli');

  // Ama oyun oynayabilir
  await host.send('setRounds', { n: 3 });
  await host.send('start');
  const { idx } = await playRound(all, hit, 'misafir de oynar');
  assert.ok(all[0].state.history[idx], 'tur tamamlanmalı');
  assert.deepEqual(all.flatMap(p => p.errors), []);
});

/* ══════════════════ Oda ömrü ══════════════════ */

test('süresi dolmuş odaya girilemez ve süpürülür', opts, async (t) => {
  await freshStart();
  const { all, code } = await makeRoom({ players: 2 });
  t.after(() => Promise.all(all.map(p => p.close())));

  // Odanın ömrünü geçmişe çek
  const admin = await makeClient('clock');
  const past = Date.now() - 1000;
  await admin.set(`rooms/${code}/meta/expiresAt`, past);
  await admin.set(`roomIndex/${code}`, past);
  await admin.close();

  const late = await Player.spawn('Geç');
  t.after(() => late.close());
  await assert.rejects(() => late.send('join', { code, name: 'Geç' }),
    /süresi dolmuş/i, 'süresi dolmuş odaya girilememeli');

  const swept = await late.send('sweep');
  assert.ok(swept >= 1, 'süpürücü en az bir oda silmeli');
  assert.equal(await dump(`rooms/${code}/meta`), null, 'oda gerçekten silinmeli');
  assert.equal(await dump(`roomIndex/${code}`), null, 'dizin kaydı da silinmeli');
});

test('ömrü dolmamış oda süpürülmez', opts, async (t) => {
  await freshStart();
  const { all, code } = await makeRoom({ players: 2 });
  t.after(() => Promise.all(all.map(p => p.close())));

  const swept = await all[0].send('sweep');
  assert.equal(swept, 0, 'taze oda süpürülmemeli');
  assert.ok(await dump(`rooms/${code}/meta`), 'oda yerinde durmalı');
});

/* ══════════════════ Oda sahipliği ══════════════════ */

test('odayı kuran ayrılınca oda kapanır ve herkes çıkar', opts, async (t) => {
  await freshStart();
  const { all, code } = await makeRoom();
  t.after(() => Promise.all(all.map(p => p.close())));
  const [a, b, c] = all;

  await waitAll(all, s => s.meta?.hostUid === a.uid, 'kurucu kaydedildi');
  assert.equal(a.state.view.iAmOwner, true);
  assert.equal(b.state.view.iAmOwner, false);

  await a.send('setRounds', { n: 3 });
  await a.send('start');
  await waitAll(all, s => s.game.phase === 'clue', 'oyun başladı');

  assert.equal(await a.send('close'), true, 'kurucu odayı kapatabilmeli');
  await waitAll([b, c], s => s.game?.phase === 'closed', 'kapanma sinyali');
  await waitAll([b, c], s => s.meta == null, 'oda silindi');
  await assert.rejects(() => b.send('join', { code, name: 'Beste' }), /oda yok/i);
});

test('kurucu olmayan çıkınca oda açık kalır', opts, async (t) => {
  await freshStart();
  const { all } = await makeRoom();
  t.after(() => Promise.all(all.map(p => p.close())));
  const [a, b, c] = all;

  assert.equal(await b.send('close'), false, 'kurucu olmayan kapatamamalı');
  await b.send('leave');
  await waitAll([a, c], s => s.players[b.uid]?.online === false, 'ayrıldı');
  assert.equal(a.state.meta?.hostUid, a.uid, 'oda ayakta kalmalı');
});

test('kurucu çevrimdışıyken başlatma yetkisi devrolur', opts, async (t) => {
  await freshStart();
  const { all } = await makeRoom();
  t.after(() => Promise.all(all.map(p => p.close())));
  const [a, b, c] = all;

  await a.send('leave');
  await waitAll([b, c], s => s.players[a.uid]?.online === false, 'kurucu çevrimdışı');
  await b.send('start');
  await waitAll([b, c], s => s.game.phase === 'clue', 'oyun başladı');
});

/* ══════════════════ Hedef tutarlılığı ══════════════════ */

test('sıra atlanınca herkes AYNI hedefi görür', opts, async (t) => {
  await freshStart();
  const { all, host } = await makeRoom();
  t.after(() => Promise.all(all.map(p => p.close())));

  await host.send('setRounds', { n: 3 });
  await host.send('start');
  await waitAll(all, s => s.game.phase === 'clue' && s.game.spectrum, 'ilk kart çekildi');

  const first = psychicOf(all);
  const firstTarget = await first.psychic.send('knownTarget');

  await first.others[0].send('skip');
  await waitAll(all, s => s.game.psychicUid !== first.psychic.uid && s.game.spectrum,
    'yeni psişik kart çekti');

  const second = psychicOf(all);
  const secondTarget = await second.psychic.send('knownTarget');
  assert.notEqual(secondTarget, firstTarget, 'yeni tur yeni hedef almalı');

  await second.psychic.send('clue', { text: 'atlandı' });
  await waitAll(all, s => s.game.phase === 'guess', 'tahmin fazı');
  for (const o of second.others) await o.send('lock');
  await waitAll(all, s => s.game.phase === 'reveal', 'açılış');
  await waitAll(all, s => s.view?.target === secondTarget,
    `herkes güncel hedefi görmeli (bayat hedef: ${firstTarget})`);
  await waitAll(all, s => s.history && s.history[0], 'sonuç kaydedildi');
  assert.equal(all[0].state.history[0].target, secondTarget);
});

test('tekrar oynayınca eski turun hedefi taşınmaz', opts, async (t) => {
  await freshStart();
  const { all, host } = await makeRoom();
  t.after(() => Promise.all(all.map(p => p.close())));

  await host.send('setRounds', { n: 3 });
  await host.send('start');
  for (let r = 0; r < 3; r++) {
    const { psychic } = await playRound(all, hit, `oyun1-${r}`);
    await psychic.send('next');
  }
  await waitAll(all, s => s.game.phase === 'gameover', 'oyun bitti');

  await all[2].send('restart');
  await waitAll(all, s => s.game.phase === 'lobby', 'lobiye dönüldü');
  await waitAll(all, s => historyList(s.history).length === 0, 'geçmiş temizlendi');
  await all[0].send('start');
  await waitAll(all, s => s.game.phase === 'clue' && s.game.spectrum, 'kart çekildi');

  const { psychic } = psychicOf(all);
  const target = await psychic.send('knownTarget');
  await psychic.send('clue', { text: 'ikinci oyun' });
  await waitAll(all, s => s.game.phase === 'guess', 'tahmin fazı');
  for (const o of all.filter(p => p !== psychic)) await o.send('lock');
  await waitAll(all, s => s.game.phase === 'reveal', 'açılış');
  await waitAll(all, s => s.view?.target === target, 'herkes yeni oyunun hedefini görmeli');
});
