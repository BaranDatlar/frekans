// Arayüz testi: gerçek Chrome, ayrı tarayıcı bağlamları (ayrı oyuncular),
// emülatördeki gerçek veritabanı ve kurallar.
// auth.js / packs.js / dial.js / ui.js / main.js bu testle kapsanır.
// Emülatör (hosting dahil) kapalıysa atlanır.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { wipe, dump } from './helpers/emulator.mjs';

const BASE = 'http://127.0.0.1:5055';

async function hostingUp() {
  try { return (await fetch(BASE + '/index.html')).ok; } catch { return false; }
}
const up = await hostingUp();
const opts = up ? {} : { skip: 'Hosting emülatörü çalışmıyor (npm run emu)' };

let seq = 0;

/** Yeni bir tarayıcı bağlamı: kendi oturumu, kendi localStorage'ı. */
async function newPlayer(browser, name, errors) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(BASE + '/');
  await page.waitForSelector('#screen-login.active', { timeout: 20000 });
  page.playerName = name;
  return page;
}

/** Gerçek Google popup'ı otomatikleştirilemez; emülatörün sahte belirteci. */
async function signInGoogle(page, name) {
  await page.evaluate(async ({ sub, name: n }) => {
    const m = await import('/js/auth.js');
    await m.signInFakeGoogle({ sub, name: n });
  }, { sub: `${name}-${Date.now()}-${++seq}`, name });
  await page.waitForSelector('#screen-home.active', { timeout: 20000 });
}

async function signInGuest(page) {
  await page.click('#btn-guest');
  await page.waitForSelector('#screen-home.active', { timeout: 20000 });
}

async function joinRoom(page, code, name) {
  await page.fill('#input-name', name);
  await page.fill('#input-code', code);
  await page.click('#btn-join');
  await page.waitForSelector('#screen-lobby.active', { timeout: 20000 });
}

/** Kadranda verilen değere denk gelen noktaya dokunur. */
async function setDial(page, value) {
  const box = await page.locator('#dial svg').boundingBox();
  const s = box.width / 400, th = Math.PI * (1 - value / 100), r = 150;
  await page.mouse.move(box.x + (200 + r * Math.cos(th)) * s, box.y + (200 - r * Math.sin(th)) * s);
  await page.mouse.down();
  await page.mouse.up();
}

const bandShape = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#dial .bands path')]
    .map(el => `${el.getAttribute('fill')}@${el.getAttribute('d')}`).join('|'));

/** İpucu kutusu kimde çıktıysa psişik odur. */
async function findPsychic(pages) {
  await Promise.race(pages.map(p => p.waitForSelector('#clue-input', { timeout: 20000 })));
  for (const p of pages) if (await p.locator('#clue-input').count()) return p;
  throw new Error('psişik bulunamadı');
}

/* ══════════════════ Giriş ══════════════════ */

test('giriş ekranı: misafir katılabilir, oda kuramaz', opts, async (t) => {
  await wipe();
  const errors = [];
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());

  const host = await newPlayer(browser, 'Ali', errors);
  const guest = await newPlayer(browser, 'Misafir', errors);

  // Giriş yapılmadan hiçbir oyun ekranı görünmemeli
  assert.equal(await host.locator('#screen-home.active').count(), 0,
    'kimlik çözülmeden ana ekran görünmemeli');
  assert.equal(await host.locator('#btn-apple').isVisible(), false,
    'Apple kapalıyken düğmesi görünmemeli');

  await signInGuest(guest);
  await guest.waitForFunction(() => document.querySelector('#btn-create')?.disabled === true,
    null, { timeout: 10000 });
  assert.match(await guest.textContent('#account-label'), /misafir/i);

  // Misafir Setlerim'e girebilir ama kaydedemez
  await guest.click('#btn-open-packs');
  await guest.waitForSelector('#screen-packs.active');
  assert.equal(await guest.locator('#btn-pack-new').isDisabled(), true,
    'misafir yeni set oluşturamamalı');
  assert.match(await guest.textContent('#packs-list'), /giriş yap/i);
  await guest.click('#btn-close-packs');

  // Hesapla giren oda kurabilir
  await signInGoogle(host, 'Ali');
  assert.equal(await host.locator('#btn-create').isDisabled(), false);
  assert.equal(await host.inputValue('#input-name'), 'Ali', 'ad Google profilinden gelmeli');

  await host.click('#btn-create');
  await host.waitForSelector('#screen-lobby.active', { timeout: 20000 });
  const code = (await host.textContent('#lobby-code')).trim();
  assert.match(code, /^[A-Z]{4}$/);

  await joinRoom(guest, code, 'Misafir');
  await host.waitForFunction(() => document.querySelectorAll('#lobby-players li').length === 2);

  assert.deepEqual(errors, [], 'konsolda hata olmamalı');
});

/* ══════════════════ Setler ve deste ══════════════════ */

test('kendi setini oluşturup lobide deste olarak yükler', opts, async (t) => {
  await wipe();
  const errors = [];
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());

  const p1 = await newPlayer(browser, 'Ali', errors);
  const p2 = await newPlayer(browser, 'Beste', errors);
  const p3 = await newPlayer(browser, 'Can', errors);
  await signInGoogle(p1, 'Ali');
  await signInGoogle(p2, 'Beste');
  await signInGoogle(p3, 'Can');

  // ── Set oluştur
  await p1.click('#btn-open-packs');
  await p1.waitForSelector('#screen-packs.active');
  await p1.click('#btn-pack-new');
  await p1.fill('#pack-name', 'Ofis Seti');
  for (const [l, r] of [['Kısa toplantı', 'Uzun toplantı'], ['Sessiz ofis', 'Gürültülü ofis'],
    ['Kötü kahve', 'İyi kahve']]) {
    await p1.fill('#card-left', l);
    await p1.fill('#card-right', r);
    await p1.click('#card-form button[type=submit]');
  }
  await p1.waitForFunction(() => document.querySelectorAll('#card-list li').length === 3);
  await p1.click('#btn-pack-save');
  await p1.waitForSelector('#packs-list-view:not([hidden])', { timeout: 15000 });
  assert.match(await p1.textContent('#packs-list'), /Ofis Seti/);
  assert.match(await p1.textContent('#packs-list'), /3 kart/);

  // Hesaba yazıldı mı
  const stored = await dump();
  assert.ok(JSON.stringify(stored).includes('Ofis Seti'), 'set veritabanına kaydedilmeli');

  await p1.click('#btn-close-packs');
  await p1.waitForSelector('#screen-home.active');

  // ── Oda kur, desteyi özel sete çevir
  await p1.click('#btn-create');
  await p1.waitForSelector('#screen-lobby.active', { timeout: 20000 });
  const code = (await p1.textContent('#lobby-code')).trim();
  await joinRoom(p2, code, 'Beste');
  await joinRoom(p3, code, 'Can');
  const pages = [p1, p2, p3];
  for (const p of pages) {
    await p.waitForFunction(() => document.querySelectorAll('#lobby-players li').length === 3);
  }

  // Deste bölümü yalnızca kurucuda
  assert.equal(await p2.locator('#deck-field').isVisible(), false,
    'kurucu olmayan deste seçemez');
  await p1.click('#deck-picker .mode-opt[data-deck="custom"]');
  await p1.waitForFunction(() =>
    document.querySelector('#deck-picker .mode-opt[data-deck="custom"]')
      ?.getAttribute('aria-pressed') === 'true');
  await p2.waitForFunction(() =>
    /Ofis Seti/.test(document.querySelector('#deck-info')?.textContent || ''),
    null, { timeout: 15000 });

  // ── Oyna: kartlar özel setten gelmeli
  await p1.click('#btn-start');
  const psychic = await findPsychic(pages);
  await psychic.waitForFunction(() => document.querySelectorAll('#dial .bands path').length === 5);
  const label = await psychic.textContent('#spec-left');
  assert.match(label, /Kısa toplantı|Sessiz ofis|Kötü kahve/, `kart özel setten gelmeli: ${label}`);

  assert.deepEqual(errors, [], 'konsolda hata olmamalı');
});

/* ══════════════════ Bireysel tur ══════════════════ */

test('bireysel modda bir tur: gizlilik, senkron, aynı puan', opts, async (t) => {
  await wipe();
  const errors = [];
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());

  const pages = [];
  for (const n of ['Ali', 'Beste', 'Can']) {
    const p = await newPlayer(browser, n, errors);
    await signInGoogle(p, n);
    pages.push(p);
  }
  const [p1, p2, p3] = pages;
  await p1.click('#btn-create');
  await p1.waitForSelector('#screen-lobby.active', { timeout: 20000 });
  const code = (await p1.textContent('#lobby-code')).trim();
  await joinRoom(p2, code, 'Beste');
  await joinRoom(p3, code, 'Can');
  for (const p of pages) {
    await p.waitForFunction(() => document.querySelectorAll('#lobby-players li').length === 3);
  }

  await p1.click('#btn-start');
  const psychic = await findPsychic(pages);
  const guessers = pages.filter(p => p !== psychic);

  // ── GİZLİLİK: hedef bantları yalnızca psişikte
  await psychic.waitForFunction(() => document.querySelectorAll('#dial .bands path').length === 5);
  for (const g of guessers) {
    assert.equal(await g.locator('#dial .bands path').count(), 0,
      'tahminci hedef aralığını GÖRMEMELİ');
  }
  const psychicBand = await bandShape(psychic);
  assert.equal(await psychic.locator('#dial .needle').isVisible(), false,
    'psişiğin kendi ibresi olmamalı');
  // "Sırayı atla" gizli kalmalı (hidden özniteliği gerçekten uygulanmalı)
  assert.equal(await guessers[0].locator('#btn-skip').isVisible(), false,
    'sıra atlama düğmesi baştan görünmemeli');

  await psychic.fill('#clue-input', 'ılık çorba');
  await psychic.click('#btn-clue-send');
  for (const p of pages) {
    await p.waitForFunction(() =>
      document.querySelector('.clue-box .what')?.textContent === 'ılık çorba');
  }

  // ── Herkes kendi ibresini koyar; kimse diğerini görmez
  await setDial(guessers[0], 25);
  await setDial(guessers[1], 75);
  for (const g of guessers) {
    assert.equal(await g.locator('#dial .ghost').count(), 0,
      'tahminci diğerinin ibresini görmemeli');
  }
  await psychic.waitForFunction(() => document.querySelectorAll('#dial .ghost').length === 2,
    null, { timeout: 15000 });

  // ── Tek kilit yetmez
  await guessers[0].click('#btn-lock');
  for (const p of pages) {
    await p.waitForFunction(() =>
      document.querySelector('#lock-status')?.textContent.includes('1/2'), null, { timeout: 15000 });
  }
  assert.equal(await guessers[1].locator('.points-burst').count(), 0,
    'bir kişinin kilidiyle tur açılmamalı');
  assert.equal(await guessers[0].locator('#btn-unlock').count(), 1,
    'kilitleyen fikrini değiştirebilmeli');

  await guessers[1].click('#btn-lock');
  for (const p of pages) await p.waitForSelector('.points-burst .num', { timeout: 20000 });

  // ── Açılışta herkes aynı aralığı görür
  for (const p of pages) {
    assert.equal(await bandShape(p), psychicBand,
      'psişiğin gördüğü hedef aralığı ile açılıştaki aralık aynı olmalı');
  }
  const tables = await Promise.all(pages.map(p =>
    p.locator('.stage .rank-list li').allTextContents()));
  assert.equal(new Set(tables.map(t => t.join('|'))).size, 1,
    `puan tablosu herkeste aynı olmalı: ${JSON.stringify(tables)}`);

  assert.deepEqual(errors, [], 'konsolda hata olmamalı');
});

/* ══════════════════ Takım modu ══════════════════ */

test('takım modu: takım seçimi, dengesizlikte başlatma kapalı, puan takıma', opts, async (t) => {
  await wipe();
  const errors = [];
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());

  const pages = [];
  for (const n of ['Ali', 'Beste', 'Can', 'Deniz']) {
    const p = await newPlayer(browser, n, errors);
    await signInGoogle(p, n);
    pages.push(p);
  }
  const [p1, p2, p3, p4] = pages;
  await p1.click('#btn-create');
  await p1.waitForSelector('#screen-lobby.active', { timeout: 20000 });
  const code = (await p1.textContent('#lobby-code')).trim();
  for (const [p, n] of [[p2, 'Beste'], [p3, 'Can'], [p4, 'Deniz']]) await joinRoom(p, code, n);
  for (const p of pages) {
    await p.waitForFunction(() => document.querySelectorAll('#lobby-players li').length === 4);
  }

  // Takım modunu seç
  assert.equal(await p1.locator('#teams-field').isVisible(), false,
    'bireysel modda takım bölümü olmamalı');
  await p1.click('#mode-picker .mode-opt[data-mode="team"]');
  for (const p of pages) {
    await p.waitForFunction(() => !document.querySelector('#teams-field').hidden);
  }

  // Herkes takımsızken başlatılamaz
  await p1.waitForFunction(() => document.querySelector('#btn-start').disabled === true);
  assert.match(await p1.textContent('#lobby-hint'), /en az 2/i);

  // Dengesiz dağılım: 1–3
  await p1.click('.team-card[data-team="a"]');
  for (const p of [p2, p3, p4]) await p.click('.team-card[data-team="b"]');
  await p1.waitForFunction(() => document.querySelector('#btn-start').disabled === true);
  assert.match(await p1.textContent('#lobby-hint'), /en az 2/i,
    '1–3 dağılımında başlatma kapalı kalmalı');

  // Dengeli: 2–2
  await p2.click('.team-card[data-team="a"]');
  await p1.waitForFunction(() => document.querySelector('#btn-start').disabled === false,
    null, { timeout: 15000 });

  // Herkes takım etiketlerini görmeli
  for (const p of pages) {
    await p.waitForFunction(() => document.querySelectorAll('#lobby-players .team-tag').length === 4);
  }

  await p1.click('#btn-start');
  const psychic = await findPsychic(pages);
  const guessers = pages.filter(p => p !== psychic);
  await psychic.fill('#clue-input', 'takım denemesi');
  await psychic.click('#btn-clue-send');
  for (const g of guessers) await g.waitForSelector('#btn-lock', { timeout: 20000 });

  for (const g of guessers) await setDial(g, 40);
  for (const g of guessers) await g.click('#btn-lock');
  for (const p of pages) await p.waitForSelector('.points-burst .num', { timeout: 20000 });

  // Tur tablosunda takım etiketleri ve psişik satırı
  const rows = await psychic.locator('.stage .rank-list li').allTextContents();
  assert.equal(rows.length, 4, 'üç tahminci + psişik satırı');
  assert.ok(rows.some(r => /psişik/.test(r)), 'psişik satırı olmalı');
  assert.equal(await psychic.locator('.stage .rank-list .team-tag').count(), 4,
    'her satırda takım etiketi olmalı');

  // Üst bardaki puan takım puanı
  const scores = await Promise.all(pages.map(p => p.textContent('#game-score')));
  assert.ok(scores.every(s => /^\d+$/.test(s)), `takım puanı sayı olmalı: ${scores}`);

  assert.deepEqual(errors, [], 'konsolda hata olmamalı');
});

/* ══════════════════ Oda kapanışı ══════════════════ */

test('odayı kuran çıkınca oda kapanır, diğerleri açığa düşer', opts, async (t) => {
  await wipe();
  const errors = [];
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());

  const p1 = await newPlayer(browser, 'Ali', errors);
  const p2 = await newPlayer(browser, 'Beste', errors);
  await signInGoogle(p1, 'Ali');
  await signInGoogle(p2, 'Beste');

  await p1.click('#btn-create');
  await p1.waitForSelector('#screen-lobby.active', { timeout: 20000 });
  const code = (await p1.textContent('#lobby-code')).trim();
  await joinRoom(p2, code, 'Beste');
  await p1.waitForFunction(() => document.querySelectorAll('#lobby-players li').length === 2);
  assert.match(await p2.textContent('#lobby-players'), /kurucu/);

  // İlk dokunuş yalnızca onay ister
  await p1.click('#btn-leave-lobby');
  await p1.waitForSelector('#toast:not([hidden])', { timeout: 5000 });
  assert.match(await p1.textContent('#toast'), /tekrar dokun/i);
  assert.equal(await p2.locator('#screen-lobby.active').count(), 1, 'diğeri lobide kalmalı');

  await p1.click('#btn-leave-lobby');
  await p1.waitForSelector('#screen-home.active', { timeout: 20000 });
  await p2.waitForSelector('#screen-home.active', { timeout: 20000 });
  assert.match(await p2.textContent('#toast'), /kapat/i);

  await p2.fill('#input-code', code);
  await p2.click('#btn-join');
  await p2.waitForFunction(() =>
    /oda yok|kapatıldı/i.test(document.querySelector('#home-status')?.textContent || ''),
    null, { timeout: 15000 });

  assert.deepEqual(errors, [], 'konsolda hata olmamalı');
});
