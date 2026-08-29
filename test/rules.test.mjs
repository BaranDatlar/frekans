// Güvenlik kuralları testi — emülatöre karşı çalışır.
// Oyunun tek gerçek sırrı hedefin konumu; asıl doğrulanan şey bu.
// Emülatör kapalıysa tüm testler atlanır (npm run emu ile başlat).

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeClient, wipe, denied, emulatorUp } from './helpers/emulator.mjs';

const up = await emulatorUp();
const opts = up ? {} : { skip: 'Emülatör çalışmıyor (npm run emu)' };

const ROOM = 'TEST';
const P = (s) => `rooms/${ROOM}/${s}`;

/** İki oyunculu bir oda kurar; A psişik olur. */
async function setupRoom(A, B, phase = 'clue') {
  await wipe();
  await A.set(P('meta'), { createdAt: Date.now() });
  await A.set(P('state'), {
    phase, roundIndex: 0, totalRounds: 10,
    order: [A.uid, B.uid], psychicUid: A.uid,
    spectrum: { id: 'x', left: 'Soğuk', right: 'Sıcak' },
    clue: 'ılık', dial: { value: 50, by: null, at: 0 }, final: null,
  });
  await A.set(P(`players/${A.uid}`), { name: 'Ali', online: true, joinedAt: Date.now() });
  await B.set(P(`players/${B.uid}`), { name: 'Beste', online: true, joinedAt: Date.now() });
}

test('gizli hedef: sadece psişik okur, açılışta herkes okur', opts, async () => {
  const A = await makeClient('psychic');
  const B = await makeClient('guesser');
  try {
    await setupRoom(A, B, 'clue');

    // Psişik hedefi yazabilir
    await A.set(P('secret/target'), 42.5);
    assert.equal((await A.get(P('secret/target'))).val(), 42.5, 'psişik kendi hedefini okur');

    // Tahminci OKUYAMAZ
    assert.ok(await denied(B.get(P('secret/target'))),
      'tahminci ipucu fazında hedefi okuyamamalı');

    // Tahmin fazında da okuyamaz
    await A.update(P('state'), { phase: 'guess' });
    assert.ok(await denied(B.get(P('secret/target'))),
      'tahminci tahmin fazında da hedefi okuyamamalı');

    // Açılışta okuyabilir
    await B.update(P('state'), { phase: 'reveal' });
    assert.equal((await B.get(P('secret/target'))).val(), 42.5,
      'reveal fazında herkes hedefi görür');
  } finally { await A.close(); await B.close(); }
});

test('gizli hedefi psişik olmayan yazamaz', opts, async () => {
  const A = await makeClient('psychic');
  const B = await makeClient('guesser');
  try {
    await setupRoom(A, B, 'clue');
    assert.ok(await denied(B.set(P('secret/target'), 10)),
      'psişik olmayan hedefi değiştirememeli');
  } finally { await A.close(); await B.close(); }
});

test('hedef 0-100 aralığı dışına yazılamaz', opts, async () => {
  const A = await makeClient('psychic');
  const B = await makeClient('guesser');
  try {
    await setupRoom(A, B, 'clue');
    await assert.rejects(() => A.set(P('secret/target'), 150));
    await assert.rejects(() => A.set(P('secret/target'), 'yarım'));
  } finally { await A.close(); await B.close(); }
});

test('oyuncu kaydını başkası değiştiremez', opts, async () => {
  const A = await makeClient('a');
  const B = await makeClient('b');
  try {
    await setupRoom(A, B);
    assert.ok(await denied(B.update(P(`players/${A.uid}`), { name: 'Sahte' })),
      'başkasının adını değiştirememeli');
    await B.update(P(`players/${B.uid}`), { name: 'Beste2' });   // kendi kaydı serbest
    assert.equal((await A.get(P(`players/${B.uid}/name`))).val(), 'Beste2');
  } finally { await A.close(); await B.close(); }
});

test('oyuncu kaydında beklenmeyen alan reddedilir', opts, async () => {
  const A = await makeClient('a');
  const B = await makeClient('b');
  try {
    await setupRoom(A, B);
    await assert.rejects(() => B.update(P(`players/${B.uid}`), { puan: 999 }));
    await assert.rejects(() => B.update(P(`players/${B.uid}`), { name: 'x'.repeat(30) }));
  } finally { await A.close(); await B.close(); }
});

test('bayat oda devralınırken players toplu silinebilir', opts, async () => {
  const A = await makeClient('a');
  const B = await makeClient('b');
  try {
    await setupRoom(A, B);
    await B.remove(P('players'));      // toplu silme serbest
    assert.equal((await A.get(P('players'))).val(), null);
  } finally { await A.close(); await B.close(); }
});

test('spektrum havuzu: geçerli kayıt kabul, bozuk kayıt reddedilir', opts, async () => {
  const A = await makeClient('a');
  try {
    await wipe();
    await A.set('spectrums/ok1', {
      left: 'Soğuk', right: 'Sıcak', addedBy: A.uid, createdAt: Date.now(),
    });
    assert.equal((await A.get('spectrums/ok1/left')).val(), 'Soğuk');

    await assert.rejects(() => A.set('spectrums/bad1', { left: 'Soğuk' }), 'sağ uç zorunlu');
    await assert.rejects(() => A.set('spectrums/bad2',
      { left: 'x'.repeat(40), right: 'y', addedBy: A.uid, createdAt: 1 }), 'çok uzun metin');
    await assert.rejects(() => A.set('spectrums/bad3',
      { left: 'a', right: 'b', addedBy: A.uid, createdAt: 1, gizli: true }), 'bilinmeyen alan');
  } finally { await A.close(); }
});

test('kök dizin okunamaz', opts, async () => {
  const A = await makeClient('a');
  try {
    assert.ok(await denied(A.get('/')), 'kökte okuma kapalı olmalı');
  } finally { await A.close(); }
});
