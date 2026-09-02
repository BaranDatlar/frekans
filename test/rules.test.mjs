// Güvenlik kuralları testi — emülatöre karşı çalışır.
// Oyunun gizli verileri (hedef ve tahmin ibreleri) ile kişiye ait setlerin
// gerçekten korunduğunu, arayüzden bağımsız olarak doğrular.
// Emülatör kapalıysa tüm testler atlanır (npm run emu).

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeClient, wipe, denied, emulatorUp } from './helpers/emulator.mjs';

const up = await emulatorUp();
const opts = up ? {} : { skip: 'Emülatör çalışmıyor (npm run emu)' };

const ROOM = 'TEST';
const P = (s) => `rooms/${ROOM}/${s}`;
const DAY = 24 * 60 * 60 * 1000;

/** İki oyunculu bir oda kurar; A kurucu ve psişik olur. */
async function setupRoom(A, B, phase = 'clue', mode = 'solo', expiresAt = Date.now() + DAY) {
  await wipe();
  await A.set(P('meta'), { createdAt: Date.now(), expiresAt, hostUid: A.uid });
  await A.set(P('state'), {
    phase, mode, roundIndex: 0, totalRounds: 10,
    order: [A.uid, B.uid], psychicUid: A.uid,
    spectrum: { id: 'b0', left: 'Soğuk', right: 'Sıcak' }, clue: 'ılık',
  });
  await A.set(P(`players/${A.uid}`), { name: 'Ali', online: true, joinedAt: Date.now() });
  await B.set(P(`players/${B.uid}`), { name: 'Beste', online: true, joinedAt: Date.now() });
}

/* ══════════ Gizli hedef ══════════ */

test('gizli hedef: sadece psişik okur, açılışta herkes okur', opts, async () => {
  const A = await makeClient('psychic');
  const B = await makeClient('guesser');
  try {
    await setupRoom(A, B, 'clue');
    await A.set(P('secret/target'), 42.5);
    assert.equal((await A.get(P('secret/target'))).val(), 42.5, 'psişik kendi hedefini okur');

    assert.ok(await denied(B.get(P('secret/target'))),
      'tahminci ipucu fazında hedefi okuyamamalı');
    await A.update(P('state'), { phase: 'guess' });
    assert.ok(await denied(B.get(P('secret/target'))),
      'tahminci tahmin fazında da hedefi okuyamamalı');

    await B.update(P('state'), { phase: 'reveal' });
    assert.equal((await B.get(P('secret/target'))).val(), 42.5,
      'reveal fazında herkes hedefi görür');
  } finally { await A.close(); await B.close(); }
});

test('gizli hedefi psişik olmayan yazamaz, aralık dışı değer geçmez', opts, async () => {
  const A = await makeClient('psychic');
  const B = await makeClient('guesser');
  try {
    await setupRoom(A, B, 'clue');
    assert.ok(await denied(B.set(P('secret/target'), 10)));
    await assert.rejects(() => A.set(P('secret/target'), 150));
    await assert.rejects(() => A.set(P('secret/target'), 'yarım'));
  } finally { await A.close(); await B.close(); }
});

/* ══════════ Tahmin ibreleri ══════════ */

test('tahminciler birbirinin ibresini okuyamaz, psişik hepsini görür', opts, async () => {
  const A = await makeClient('psychic');
  const B = await makeClient('guesser1');
  const C = await makeClient('guesser2');
  try {
    await setupRoom(A, B, 'guess');
    await C.set(P(`players/${C.uid}`), { name: 'Can', online: true, joinedAt: Date.now() });

    await B.set(P(`guesses/0/${B.uid}`), 30);
    await C.set(P(`guesses/0/${C.uid}`), 70);

    assert.equal((await B.get(P(`guesses/0/${B.uid}`))).val(), 30, 'kendi ibresini okur');
    assert.ok(await denied(C.get(P(`guesses/0/${B.uid}`))),
      'tahminci başkasının ibresini okuyamamalı');
    assert.ok(await denied(C.get(P('guesses/0'))),
      'tahminci tüm ibre listesini okuyamamalı');

    assert.deepEqual((await A.get(P('guesses/0'))).val(), { [B.uid]: 30, [C.uid]: 70 },
      'psişik canlı görmeli');

    await B.update(P('state'), { phase: 'reveal' });
    assert.deepEqual((await C.get(P('guesses/0'))).val(), { [B.uid]: 30, [C.uid]: 70 },
      'açılışta herkes görür');
  } finally { await A.close(); await B.close(); await C.close(); }
});

test('başkasının ibresi yazılamaz, tahmin fazı dışında yazılamaz', opts, async () => {
  const A = await makeClient('psychic');
  const B = await makeClient('guesser1');
  const C = await makeClient('guesser2');
  try {
    await setupRoom(A, B, 'guess');
    assert.ok(await denied(C.set(P(`guesses/0/${B.uid}`), 99)));
    await assert.rejects(() => B.set(P(`guesses/0/${B.uid}`), 150), 'aralık dışı');

    await B.update(P('state'), { phase: 'reveal' });
    assert.ok(await denied(B.set(P(`guesses/0/${B.uid}`), 10)),
      'açılıştan sonra ibre değiştirilememeli — yoksa cihazlar farklı puan hesaplar');
  } finally { await A.close(); await B.close(); await C.close(); }
});

test('kilitler herkese açık ama başkası adına basılamaz', opts, async () => {
  const A = await makeClient('psychic');
  const B = await makeClient('guesser1');
  const C = await makeClient('guesser2');
  try {
    await setupRoom(A, B, 'guess');
    await B.set(P(`locks/0/${B.uid}`), 42);
    assert.equal((await C.get(P('locks/0'))).val()[B.uid], 42, 'kim kilitledi herkes görür');
    assert.ok(await denied(C.set(P(`locks/0/${B.uid}`), 10)));
    await assert.rejects(() => B.set(P(`locks/0/${B.uid}`), true), 'kilit ibre değeri olmalı');
  } finally { await A.close(); await B.close(); await C.close(); }
});

/* ══════════ Oyuncu kaydı ══════════ */

test('oyuncu kaydını başkası değiştiremez, fazladan alan geçmez', opts, async () => {
  const A = await makeClient('a');
  const B = await makeClient('b');
  try {
    await setupRoom(A, B);
    assert.ok(await denied(B.update(P(`players/${A.uid}`), { name: 'Sahte' })));
    await assert.rejects(() => B.update(P(`players/${B.uid}`), { puan: 999 }));
    await assert.rejects(() => B.update(P(`players/${B.uid}`), { name: 'x'.repeat(30) }));
    await B.update(P(`players/${B.uid}`), { name: 'Beste2' });
    assert.equal((await A.get(P(`players/${B.uid}/name`))).val(), 'Beste2');
  } finally { await A.close(); await B.close(); }
});

/* ══════════ Kişisel setler ══════════ */

test('setler yalnızca sahibine açık', opts, async () => {
  const A = await makeClient('a');
  const B = await makeClient('b');
  try {
    await wipe();
    const pack = { name: 'Ofis', cards: [{ l: 'A', r: 'B' }], updatedAt: Date.now() };
    await A.set(`users/${A.uid}/packs/p1`, pack);

    assert.equal((await A.get(`users/${A.uid}/packs/p1/name`)).val(), 'Ofis');
    assert.ok(await denied(B.get(`users/${A.uid}/packs/p1`)),
      'başkasının setleri okunamamalı');
    assert.ok(await denied(B.get(`users/${A.uid}`)));
    assert.ok(await denied(B.set(`users/${A.uid}/packs/p2`, pack)),
      'başkasının hesabına set yazılamamalı');
  } finally { await A.close(); await B.close(); }
});

test('set içeriği doğrulanır', opts, async () => {
  const A = await makeClient('a');
  try {
    await wipe();
    const base = `users/${A.uid}/packs/p1`;
    await assert.rejects(() => A.set(base, { name: 'Ofis' }), 'kartlar zorunlu');
    await assert.rejects(() => A.set(base, { name: '', cards: [{ l: 'A', r: 'B' }] }), 'ad boş olamaz');
    await assert.rejects(() => A.set(base, {
      name: 'Ofis', cards: [{ l: 'x'.repeat(40), r: 'B' }],
    }), 'çok uzun metin');
    await assert.rejects(() => A.set(base, {
      name: 'Ofis', cards: [{ l: 'A', r: 'B', gizli: true }],
    }), 'bilinmeyen alan');
    await A.set(base, { name: 'Ofis', cards: [{ l: 'A', r: 'B' }], updatedAt: Date.now() });
  } finally { await A.close(); }
});

test('misafir hesap set kaydedemez ama odaya katılabilir', opts, async () => {
  const host = await makeClient('kurucu');
  const guest = await makeClient('misafir', { guest: true });
  try {
    await setupRoom(host, guest);
    assert.ok(await denied(guest.set(`users/${guest.uid}/packs/p1`, {
      name: 'Set', cards: [{ l: 'A', r: 'B' }],
    })), 'misafir set kaydedememeli');

    // Oyuncu kaydı yazabilmeli (odaya katılmak için gerekir)
    await guest.update(P(`players/${guest.uid}`), { name: 'Misafir' });
    assert.equal((await host.get(P(`players/${guest.uid}/name`))).val(), 'Misafir');
  } finally { await host.close(); await guest.close(); }
});

test('misafir oda kuramaz', opts, async () => {
  const guest = await makeClient('misafir', { guest: true });
  try {
    await wipe();
    assert.ok(await denied(guest.set('rooms/GUES/meta', {
      createdAt: Date.now(), expiresAt: Date.now() + DAY, hostUid: guest.uid,
    })), 'misafir oda kuramamalı');
  } finally { await guest.close(); }
});

/* ══════════ Deste ══════════ */

test('desteyi yalnızca kurucu, yalnızca lobide değiştirebilir', opts, async () => {
  const A = await makeClient('kurucu');
  const B = await makeClient('konuk');
  try {
    await setupRoom(A, B, 'lobby');
    await A.set(P('deck'), { source: 'custom', name: 'Ofis', cards: [{ l: 'A', r: 'B' }] });
    assert.equal((await B.get(P('deck/name'))).val(), 'Ofis', 'deste herkese görünür');

    assert.ok(await denied(B.set(P('deck'), { source: 'builtin' })),
      'kurucu olmayan desteyi değiştirememeli');

    await A.update(P('state'), { phase: 'clue' });
    assert.ok(await denied(A.set(P('deck'), { source: 'builtin' })),
      'oyun başladıktan sonra deste değişmemeli');
  } finally { await A.close(); await B.close(); }
});

test('deste kartları doğrulanır', opts, async () => {
  const A = await makeClient('kurucu');
  const B = await makeClient('konuk');
  try {
    await setupRoom(A, B, 'lobby');
    await assert.rejects(() => A.set(P('deck'), {
      source: 'custom', cards: [{ l: 'x'.repeat(40), r: 'B' }],
    }));
    await assert.rejects(() => A.set(P('deck'), {
      source: 'custom', cards: [{ l: 'A', r: 'B', not: 'x' }],
    }));
  } finally { await A.close(); await B.close(); }
});

/* ══════════ Oda ömrü ve silinmesi ══════════ */

test('odayı yalnızca kuran kişi kapatabilir', opts, async () => {
  const A = await makeClient('kurucu');
  const B = await makeClient('konuk');
  try {
    await setupRoom(A, B);
    assert.ok(await denied(B.remove(`rooms/${ROOM}`)), 'konuk odayı silememeli');
    assert.equal(await denied(A.remove(`rooms/${ROOM}`)), false, 'kurucu silebilmeli');
    assert.equal((await A.get(P('meta'))).val(), null, 'oda gerçekten silinmeli');
  } finally { await A.close(); await B.close(); }
});

test('süresi dolmuş odayı herkes silebilir', opts, async () => {
  const A = await makeClient('kurucu');
  const B = await makeClient('yabanci');
  try {
    await setupRoom(A, B, 'clue', 'solo', Date.now() - 1000);   // ömrü dolmuş
    assert.equal(await denied(B.remove(`rooms/${ROOM}`)), false,
      'süresi dolmuş odayı yabancı da silebilmeli');
    assert.equal((await A.get(P('meta'))).val(), null);
  } finally { await A.close(); await B.close(); }
});

test('kurucu bile odanın üstüne veri yazamaz, sadece silebilir', opts, async () => {
  const A = await makeClient('kurucu');
  const B = await makeClient('konuk');
  try {
    await setupRoom(A, B);
    assert.ok(await denied(A.set(`rooms/${ROOM}`, { meta: { createdAt: 1 } })));
  } finally { await A.close(); await B.close(); }
});

test('bayat oda devralınırken TÜM kalıntılar silinebilir', opts, async () => {
  // createRoom bayat bir odanın üstüne yazarken her düğümü siler; birinde izin
  // yoksa oda kurma tamamen permission_denied ile düşer.
  const A = await makeClient('eski');
  const B = await makeClient('yeni');
  try {
    await wipe();
    const R = (s) => `rooms/OLDR/${s}`;
    await A.set(R('meta'), { createdAt: Date.now() - 25 * 3600 * 1000, expiresAt: Date.now() - 3600 * 1000, hostUid: A.uid });
    await A.set(R('state'), { phase: 'guess', mode: 'solo', psychicUid: A.uid, roundIndex: 0 });
    await A.set(R('secret/target'), 42);
    await A.set(R(`players/${A.uid}`), { name: 'Eski', online: true, joinedAt: 1 });
    await A.set(R(`locks/0/${A.uid}`), 20);
    await A.set(R(`guesses/0/${A.uid}`), 20);
    await A.set(R('history/0'), { clue: 'x' });
    await A.set(R('usedSpectrumIds/b1'), true);

    for (const node of ['players', 'state', 'history', 'secret',
      'usedSpectrumIds', 'locks', 'guesses']) {
      assert.equal(await denied(B.remove(R(node))), false,
        `devralan oyuncu "${node}" düğümünü silebilmeli`);
    }
  } finally { await A.close(); await B.close(); }
});

test('oda dizini okunur ve yazılır (süpürücü için)', opts, async () => {
  const A = await makeClient('a');
  const B = await makeClient('b');
  try {
    await wipe();
    await A.set('roomIndex/ABCD', Date.now() + DAY);
    assert.ok((await B.get('roomIndex/ABCD')).val(), 'dizin herkese okunur');
    await assert.rejects(() => A.set('roomIndex/ABCD', 'yarın'), 'sayı olmalı');
    assert.equal(await denied(B.remove('roomIndex/ABCD')), false,
      'süpürücü dizin kaydını silebilmeli');
  } finally { await A.close(); await B.close(); }
});

/* ══════════ Kaldırılan havuz ══════════ */

test('eski ortak spektrum havuzu artık yok', opts, async () => {
  const A = await makeClient('a');
  try {
    await wipe();
    assert.ok(await denied(A.get('spectrums')), '/spectrums okunamamalı');
    assert.ok(await denied(A.set('spectrums/x', { left: 'A', right: 'B' })),
      '/spectrums yazılamamalı — kimse hazır seti bozamaz');
  } finally { await A.close(); }
});

test('kök dizin okunamaz', opts, async () => {
  const A = await makeClient('a');
  try {
    assert.ok(await denied(A.get('/')));
  } finally { await A.close(); }
});
