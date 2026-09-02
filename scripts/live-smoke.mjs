// Canlı yayına karşı duman testi. Emülatör değil, gerçek proje.
//
// Google girişi otomatikleştirilemez (gerçek OAuth), o yüzden oyuncular
// MİSAFİR olarak girer. Misafirler oda kuramadığı için test odası yönetici
// REST çağrısıyla kurulur; oynanışın tamamı gerçek istemci üzerinden gider.
//
// Kullanım: npm run smoke

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

// Uygulama authDomain ile aynı origin'de çalışmak zorunda (giriş akışı için).
const BASE = 'https://frekans-f3067.firebaseapp.com';
const SHORT = 'https://frekans-f3067.web.app';
const DB = 'https://frekans-f3067-default-rtdb.europe-west1.firebasedatabase.app';
const CODE = 'SMOK';

const token = JSON.parse(readFileSync(
  `${homedir()}/.config/configstore/firebase-tools.json`, 'utf8')).tokens.access_token;
const admin = (path, init = {}) => fetch(`${DB}/${path}.json`, {
  ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
});

async function setupRoom() {
  const now = Date.now();
  await admin(`rooms/${CODE}`, { method: 'DELETE' });
  await admin(`rooms/${CODE}/meta`, {
    method: 'PUT',
    body: JSON.stringify({ createdAt: now, expiresAt: now + 3600e3, hostUid: 'smoke-host' }),
  });
  await admin(`rooms/${CODE}/state`, {
    method: 'PUT',
    body: JSON.stringify({
      phase: 'lobby', mode: 'solo', roundIndex: 0, totalRounds: 10,
    }),
  });
  await admin(`rooms/${CODE}/deck`, { method: 'PUT', body: JSON.stringify({ source: 'builtin' }) });
  await admin(`roomIndex/${CODE}`, { method: 'PUT', body: JSON.stringify(now + 3600e3) });
}

async function cleanup() {
  await admin(`rooms/${CODE}`, { method: 'DELETE' });
  await admin(`roomIndex/${CODE}`, { method: 'DELETE' });
}

// Kök adresin önbellek başlığı: `/` yolu "**/*.html" kalıbına uymadığı için
// bir kez 1 saat önbelleklenmiş ve eski HTML yeni JS ile eşleşip uygulamayı
// çökertmişti. Aynı hataya bir daha düşmeyelim.
for (const path of ['/', '/index.html', '/js/main.js']) {
  const res = await fetch(BASE + path, { cache: 'no-store' });
  const cc = res.headers.get('cache-control') || '';
  assert.match(cc, /no-cache/, `${path} önbelleklenmemeli, gelen: "${cc}"`);
}
console.log('✔ önbellek başlıkları doğru (kök dahil)');

// Giriş akışının çalışması için OAuth yönlendirme adresi bu origin'de olmalı
assert.ok((await fetch(`${BASE}/__/auth/handler`)).ok, 'auth handler aynı origin\'de olmalı');
const cfg = await (await fetch(`${BASE}/js/config.js`)).text();
assert.match(cfg, new RegExp(`authDomain: "${new URL(BASE).hostname}"`),
  'authDomain uygulamanın origin\'i ile aynı olmalı');
console.log('✔ authDomain ve auth handler aynı origin\'de');

await setupRoom();
console.log('test odası kuruldu:', CODE);

const browser = await chromium.launch({ channel: 'chrome' });
const errors = [];
const pages = [];
for (const name of ['Ali', 'Beste', 'Can']) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  p.on('console', m => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  await p.goto(BASE + '/');
  await p.waitForSelector('#screen-login.active', { timeout: 30000 });
  pages.push(p);
}
console.log('✔ giriş ekranı açıldı');

for (const [i, p] of pages.entries()) {
  await p.click('#btn-guest');
  await p.waitForSelector('#screen-home.active', { timeout: 30000 });
  if (i === 0) {
    assert.equal(await p.locator('#btn-create').isDisabled(), true,
      'misafir oda kuramamalı');
    console.log('✔ misafir girişi çalışıyor, oda kurma kapalı');
  }
  await p.fill('#input-name', ['Ali', 'Beste', 'Can'][i]);
  await p.fill('#input-code', CODE);
  await p.click('#btn-join');
  await p.waitForSelector('#screen-lobby.active', { timeout: 30000 });
}
for (const p of pages) {
  await p.waitForFunction(() => document.querySelectorAll('#lobby-players li').length === 3);
}
console.log('✔ üç oyuncu lobide');

// Lobide kurucu olmadığı için başlatmayı yönetici olarak tetikliyoruz
const uids = await pages[0].evaluate(() =>
  [...document.querySelectorAll('#lobby-players li')].length);
assert.equal(uids, 3);
const players = await (await admin(`rooms/${CODE}/players`)).json();
const order = Object.keys(players);
await admin(`rooms/${CODE}/state`, {
  method: 'PATCH',
  body: JSON.stringify({ phase: 'clue', roundIndex: 0, order, psychicUid: order[0] }),
});

await Promise.race(pages.map(p => p.waitForSelector('#clue-input', { timeout: 30000 })));
let psychic = null;
for (const p of pages) if (await p.locator('#clue-input').count()) psychic = p;
const guessers = pages.filter(p => p !== psychic);
await psychic.waitForFunction(() => document.querySelectorAll('#dial .bands path').length === 5);
for (const g of guessers) {
  assert.equal(await g.locator('#dial .bands path').count(), 0, 'tahminci hedefi GÖRMEMELİ');
}
console.log('✔ gizlilik: hedef aralığı sadece psişikte');

await psychic.fill('#clue-input', 'canlı deneme');
await psychic.click('#btn-clue-send');
for (const p of pages) {
  await p.waitForFunction(() =>
    document.querySelector('.clue-box .what')?.textContent === 'canlı deneme',
    null, { timeout: 30000 });
}
console.log('✔ ipucu üç cihazda');

const setDial = async (page, value) => {
  const box = await page.locator('#dial svg').boundingBox();
  const s = box.width / 400, th = Math.PI * (1 - value / 100), r = 150;
  await page.mouse.move(box.x + (200 + r * Math.cos(th)) * s, box.y + (200 - r * Math.sin(th)) * s);
  await page.mouse.down(); await page.mouse.up();
};
await setDial(guessers[0], 30);
await setDial(guessers[1], 70);
for (const g of guessers) {
  assert.equal(await g.locator('#dial .ghost').count(), 0, 'tahminci diğerini görmemeli');
}
await psychic.waitForFunction(() => document.querySelectorAll('#dial .ghost').length === 2,
  null, { timeout: 30000 });
console.log('✔ psişik iki ibreyi de canlı görüyor, tahminciler birbirini görmüyor');

await guessers[0].click('#btn-lock');
for (const p of pages) {
  await p.waitForFunction(() =>
    document.querySelector('#lock-status')?.textContent.includes('1/2'),
    null, { timeout: 30000 });
}
assert.equal(await guessers[1].locator('.points-burst').count(), 0,
  'tek kilitle tur açılmamalı');
console.log('✔ tek kilit turu açmıyor');

await guessers[1].click('#btn-lock');
for (const p of pages) await p.waitForSelector('.points-burst .num', { timeout: 30000 });
const tables = await Promise.all(pages.map(p =>
  p.locator('.stage .rank-list li').allTextContents()));
assert.equal(new Set(tables.map(t => t.join('|'))).size, 1,
  `puan tablosu herkeste aynı olmalı: ${JSON.stringify(tables)}`);
console.log('✔ puan tablosu üç cihazda aynı');

if (errors.length) console.log('konsol hataları:', errors);
assert.deepEqual(errors, []);

await browser.close();
await cleanup();
console.log('\n✅ CANLI DOĞRULAMA GEÇTİ —', BASE);
