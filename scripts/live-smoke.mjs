// Canlı yayına karşı duman testi. Emülatör değil, gerçek proje.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = 'https://frekans-f3067.web.app';
const browser = await chromium.launch({ channel: 'chrome' });
const errors = [];
const pages = [];
for (const name of ['Ali', 'Beste', 'Can']) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  await page.goto(BASE + '/');
  pages.push(page);
}
const [p1, p2, p3] = pages;

await p1.fill('#input-name', 'Ali');
await p1.click('#btn-create');
await p1.waitForSelector('#screen-lobby.active', { timeout: 20000 });
const code = (await p1.textContent('#lobby-code')).trim();
console.log('oda kodu:', code);
assert.match(code, /^[A-Z]{4}$/);

for (const [p, n] of [[p2, 'Beste'], [p3, 'Can']]) {
  await p.fill('#input-name', n); await p.fill('#input-code', code); await p.click('#btn-join');
  await p.waitForSelector('#screen-lobby.active', { timeout: 20000 });
}
for (const p of pages) await p.waitForFunction(() => document.querySelectorAll('#lobby-players li').length === 3);
console.log('✔ üç oyuncu lobide');

// Havuzu doldur (ilk kurulum)
await p1.click('#btn-lobby-spectrums');
await p1.waitForSelector('#screen-spectrums.active');
await p1.waitForFunction(() => document.querySelectorAll('#spec-list li').length > 0,
  null, { timeout: 20000 });                      // havuz okuması dönsün
if (await p1.locator('#spec-list .btn').count()) {
  await p1.click('#spec-list .btn');
  await p1.waitForFunction(() => document.querySelectorAll('#spec-list li').length > 50, null, { timeout: 40000 });
}
console.log('✔ havuz:', await p1.locator('#spec-list li').count(), 'spektrum');
await p1.click('#btn-close-spectrums');
await p1.waitForFunction(() => document.querySelector('#btn-start')?.disabled === false, null, { timeout: 15000 });

await p1.click('#btn-start');
await Promise.race(pages.map(p => p.waitForSelector('#clue-input', { timeout: 25000 })));
let psychic = null;
for (const p of pages) if (await p.locator('#clue-input').count()) psychic = p;
const guessers = pages.filter(p => p !== psychic);
await psychic.waitForFunction(() => document.querySelectorAll('#dial .bands path').length === 5);
for (const g of guessers) assert.equal(await g.locator('#dial .bands path').count(), 0,
  'tahminci hedefi GÖRMEMELİ');
console.log('✔ gizlilik: hedef sadece psişikte');

await psychic.fill('#clue-input', 'canlı deneme');
await psychic.click('#btn-clue-send');
for (const p of pages) await p.waitForFunction(() =>
  document.querySelector('.clue-box .what')?.textContent === 'canlı deneme', null, { timeout: 20000 });
console.log('✔ ipucu üç cihazda');

const box = await guessers[0].locator('#dial svg').boundingBox();
const s = box.width / 400, th = Math.PI * (1 - 0.3), r = 150;
await guessers[0].mouse.move(box.x + (200 + r * Math.cos(th)) * s, box.y + (200 - r * Math.sin(th)) * s);
await guessers[0].mouse.down(); await guessers[0].mouse.up();
for (const p of pages.filter(x => x !== guessers[0])) {
  await p.waitForFunction(() => {
    const m = /rotate\(([-\d.]+)deg\)/.exec(document.querySelector('#dial .needle').style.transform);
    return m && Math.abs(Number(m[1]) / 1.8 + 50 - 30) < 3;
  }, null, { timeout: 20000 });
}
console.log('✔ ibre senkronu');

// Tek kilit turu açmamalı, herkes onaylayınca açılır
await guessers[0].click('#btn-lock');
for (const p of pages) await p.waitForFunction(() =>
  document.querySelector('#lock-status')?.textContent.includes('1/2'), null, { timeout: 20000 });
assert.equal(await guessers[1].locator('.points-burst').count(), 0,
  'bir kişinin kilidiyle tur açılmamalı');
console.log('✔ tek kilit turu açmıyor');
await guessers[1].click('#btn-lock');
const scores = [];
for (const p of pages) { await p.waitForSelector('.points-burst .num', { timeout: 20000 });
  scores.push(await p.textContent('.points-burst .num')); }
assert.equal(new Set(scores).size, 1, `puan farklı: ${scores}`);
console.log('✔ puan üç cihazda aynı:', scores[0]);

await pages[0].click('#btn-next');
for (const p of pages) await p.waitForFunction(() =>
  document.querySelector('#game-round-label')?.textContent === 'Tur 2/10', null, { timeout: 20000 });
console.log('✔ sonraki tur');

if (errors.length) console.log('konsol hataları:', errors);
assert.deepEqual(errors, []);
console.log('\n✅ CANLI DOĞRULAMA GEÇTİ —', BASE);
await browser.close();
