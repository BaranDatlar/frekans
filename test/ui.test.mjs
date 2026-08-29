// Arayüz dumanı testi: gerçek Chrome, üç ayrı tarayıcı bağlamı (üç oyuncu),
// emülatördeki gerçek veritabanı. dial.js / ui.js / main.js bu testle kapsanır.
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

/** Kadranın üstünde verilen değere denk gelen ekran noktasını hesaplar. */
async function dialPoint(page, value) {
  const box = await page.locator('#dial svg').boundingBox();
  const scale = box.width / 400;
  const th = Math.PI * (1 - value / 100);
  const r = 150;
  return {
    x: box.x + (200 + r * Math.cos(th)) * scale,
    y: box.y + (200 - r * Math.sin(th)) * scale,
  };
}

const needleValue = (page) => page.evaluate(() => {
  const m = /rotate\(([-\d.]+)deg\)/.exec(document.querySelector('#dial .needle').style.transform);
  return m ? Number(m[1]) / 1.8 + 50 : null;
});

const bandCount = (page) => page.locator('#dial .bands path').count();

test('üç tarayıcıdan bir tur oynanır', opts, async (t) => {
  await wipe();
  assert.equal(await dump(), null, 'emülatör temiz başlamalı');

  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());

  const errors = [];
  const pages = [];
  for (const name of ['Ali', 'Beste', 'Can']) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await page.goto(BASE + '/');
    pages.push(Object.assign(page, { playerName: name }));
  }
  const [p1, p2, p3] = pages;

  // ── Oda kur / katıl
  await p1.fill('#input-name', 'Ali');
  await p1.click('#btn-create');
  await p1.waitForSelector('#screen-lobby.active');
  const code = (await p1.textContent('#lobby-code')).trim();
  assert.match(code, /^[A-Z]{4}$/, `oda kodu 4 harf olmalı, gelen: ${code}`);

  for (const [page, name] of [[p2, 'Beste'], [p3, 'Can']]) {
    await page.fill('#input-name', name);
    await page.fill('#input-code', code);
    await page.click('#btn-join');
    await page.waitForSelector('#screen-lobby.active');
  }
  for (const page of pages) {
    await page.waitForFunction(() => document.querySelectorAll('#lobby-players li').length === 3);
  }

  // ── Havuz boşken oyun başlatılamamalı
  await p1.waitForFunction(() => document.querySelector('#btn-start').disabled === true);
  assert.match(await p1.textContent('#lobby-hint'), /spektrum/i,
    'boş havuz uyarısı görünmeli');

  // ── Spektrum editörü: hazır seti yükle, ara, ekle, iki adımda sil
  await p1.click('#btn-lobby-spectrums');
  await p1.waitForSelector('#screen-spectrums.active');
  await p1.click('#spec-list .btn');
  await p1.waitForFunction(() => document.querySelectorAll('#spec-list li').length > 50,
    null, { timeout: 20000 });
  const poolSize = await p1.locator('#spec-list li').count();
  assert.ok(poolSize > 50, `havuz dolmalı, gelen: ${poolSize}`);

  await p1.fill('#spec-search', 'Soğuk');
  await p1.waitForFunction(() => document.querySelectorAll('#spec-list li').length < 10);
  await p1.fill('#spec-search', '');

  await p1.fill('#spec-in-left', 'Deneme Sol');
  await p1.fill('#spec-in-right', 'Deneme Sağ');
  await p1.click('#spec-form button[type=submit]');
  const row = p1.locator('#spec-list li', { hasText: 'Deneme Sol' });
  await row.waitFor({ timeout: 10000 });

  await row.locator('.s-del').click();
  assert.equal(await row.locator('.s-del').textContent(), 'Sil?', 'ilk dokunuş onay istemeli');
  assert.equal(await row.count(), 1, 'ilk dokunuşta silinmemeli');
  await row.locator('.s-del').click();
  await row.waitFor({ state: 'detached', timeout: 10000 });

  await p1.click('#btn-close-spectrums');
  await p1.waitForSelector('#screen-lobby.active');

  // ── Havuz dolunca başlatılabilir olmalı
  await p1.waitForFunction(() => document.querySelector('#btn-start').disabled === false,
    null, { timeout: 10000 });

  // ── Başlat
  await p1.click('#btn-start');
  for (const page of pages) await page.waitForSelector('#screen-game.active');

  // ── Psişiği bul: ipucu kutusu sadece onda çıkar
  await Promise.race(pages.map(p => p.waitForSelector('#clue-input', { timeout: 15000 })));
  let psychic = null;
  for (const page of pages) if (await page.locator('#clue-input').count()) psychic = page;
  assert.ok(psychic, 'bir oyuncu psişik olmalı');
  const guessers = pages.filter(p => p !== psychic);

  // ── GİZLİLİK: hedef bantları sadece psişikte çizilmiş olmalı
  await psychic.waitForFunction(() => document.querySelectorAll('#dial .bands path').length === 5);
  assert.equal(await bandCount(psychic), 5, 'psişik hedef bantlarını görmeli');
  for (const g of guessers) {
    assert.equal(await bandCount(g), 0, 'tahminci hedef bantlarını GÖRMEMELİ');
  }

  // ── İpucu
  await psychic.fill('#clue-input', 'ılık çorba');
  await psychic.click('#btn-clue-send');
  for (const page of pages) {
    await page.waitForFunction(() =>
      document.querySelector('.clue-box .what')?.textContent === 'ılık çorba');
  }

  // ── İbreyi sürükle (tahminci), diğerlerinde senkron olsun
  const target = 25;
  const pt = await dialPoint(guessers[0], target);
  await guessers[0].mouse.move(pt.x, pt.y);
  await guessers[0].mouse.down();
  await guessers[0].mouse.move(pt.x + 1, pt.y);
  await guessers[0].mouse.up();

  const local = await needleValue(guessers[0]);
  assert.ok(Math.abs(local - target) < 3, `sürükleyende ibre ~${target} olmalı, ${local}`);

  for (const other of pages.filter(p => p !== guessers[0])) {
    await other.waitForFunction((t) => {
      const m = /rotate\(([-\d.]+)deg\)/.exec(
        document.querySelector('#dial .needle').style.transform);
      return m && Math.abs(Number(m[1]) / 1.8 + 50 - t) < 3;
    }, target, { timeout: 10000 });
  }

  // ── Psişikte kilitleme düğmesi olmamalı
  assert.equal(await psychic.locator('#btn-lock').count(), 0,
    'psişik kilitleyememeli');

  // ── Tek kilit turu açmamalı
  await guessers[0].click('#btn-lock');
  for (const page of pages) {
    await page.waitForFunction(() =>
      document.querySelector('#lock-status')?.textContent.includes('1/2'),
      null, { timeout: 15000 });
  }
  assert.equal(await guessers[1].locator('.points-burst').count(), 0,
    'bir kişinin kilidiyle tur açılmamalı');
  assert.equal(await guessers[0].locator('#btn-unlock').count(), 1,
    'kilitleyen fikrini değiştirebilmeli');

  // ── İkinci kilit → açılış
  await guessers[1].click('#btn-lock');
  for (const page of pages) {
    await page.waitForSelector('.points-burst .num', { timeout: 15000 });
    assert.equal(await bandCount(page), 5, 'açılışta herkes bantları görmeli');
  }
  const scores = await Promise.all(pages.map(p => p.textContent('.points-burst .num')));
  assert.equal(new Set(scores).size, 1, `puan herkeste aynı olmalı, gelen: ${scores}`);
  assert.match(scores[0], /^\+[0-4]$/);

  // Üst bardaki toplam skor da eşleşmeli
  const totals = await Promise.all(pages.map(p => p.textContent('#game-score')));
  assert.equal(new Set(totals).size, 1, 'toplam skor herkeste aynı');
  assert.equal(totals[0], scores[0].slice(1), 'ilk turda toplam = tur puanı');

  // ── Sonraki tur
  await pages[0].click('#btn-next');
  for (const page of pages) {
    await page.waitForFunction(() =>
      document.querySelector('#game-round-label')?.textContent === 'Tur 2/10');
  }

  assert.deepEqual(errors, [], 'konsolda hata olmamalı');
});

test('bireysel modda herkes kendi kadranını çevirir', opts, async (t) => {
  await wipe();
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());

  const errors = [];
  const pages = [];
  for (const name of ['Ali', 'Beste', 'Can']) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await page.goto(BASE + '/');
    pages.push(page);
  }
  const [p1, p2, p3] = pages;

  await p1.fill('#input-name', 'Ali');
  await p1.click('#btn-create');
  await p1.waitForSelector('#screen-lobby.active');
  const code = (await p1.textContent('#lobby-code')).trim();
  for (const [page, name] of [[p2, 'Beste'], [p3, 'Can']]) {
    await page.fill('#input-name', name);
    await page.fill('#input-code', code);
    await page.click('#btn-join');
    await page.waitForSelector('#screen-lobby.active');
  }
  for (const page of pages) {
    await page.waitForFunction(() => document.querySelectorAll('#lobby-players li').length === 3);
  }

  // Havuzu doldur
  await p1.click('#btn-lobby-spectrums');
  await p1.waitForFunction(() => document.querySelectorAll('#spec-list li').length > 0,
    null, { timeout: 20000 });
  if (await p1.locator('#spec-list .btn').count()) {
    await p1.click('#spec-list .btn');
    await p1.waitForFunction(() => document.querySelectorAll('#spec-list li').length > 50,
      null, { timeout: 20000 });
  }
  await p1.click('#btn-close-spectrums');
  await p1.waitForSelector('#screen-lobby.active');

  // ── Mod seçimi: yalnızca kurucu değiştirebilir
  assert.equal(await p2.locator('#mode-picker .mode-opt[data-mode="solo"]').isDisabled(), true,
    'kurucu olmayan modu değiştirememeli');
  await p1.click('#mode-picker .mode-opt[data-mode="solo"]');
  for (const page of pages) {
    await page.waitForFunction(() =>
      document.querySelector('#mode-picker .mode-opt[data-mode="solo"]')
        ?.getAttribute('aria-pressed') === 'true');
  }

  await p1.waitForFunction(() => document.querySelector('#btn-start').disabled === false);
  await p1.click('#btn-start');
  await Promise.race(pages.map(p => p.waitForSelector('#clue-input', { timeout: 20000 })));
  let psychic = null;
  for (const page of pages) if (await page.locator('#clue-input').count()) psychic = page;
  const guessers = pages.filter(p => p !== psychic);

  await psychic.fill('#clue-input', 'ayrı ayrı');
  await psychic.click('#btn-clue-send');
  for (const page of pages) {
    await page.waitForFunction(() =>
      document.querySelector('.clue-box .what')?.textContent === 'ayrı ayrı');
  }

  // ── Her tahminci kendi ibresini farklı yere koyar
  const targets = [22, 78];
  for (let i = 0; i < guessers.length; i++) {
    const g = guessers[i];
    const box = await g.locator('#dial svg').boundingBox();
    const s = box.width / 400, th = Math.PI * (1 - targets[i] / 100), r = 150;
    await g.mouse.move(box.x + (200 + r * Math.cos(th)) * s, box.y + (200 - r * Math.sin(th)) * s);
    await g.mouse.down(); await g.mouse.up();
  }

  // ── GİZLİLİK: tahminci başkasının ibresini görmemeli
  for (const g of guessers) {
    assert.equal(await g.locator('#dial .ghost').count(), 0,
      'tahminci diğerlerinin ibresini görmemeli');
  }
  // Psişik ikisini de görür
  await psychic.waitForFunction(() => document.querySelectorAll('#dial .ghost').length === 2,
    null, { timeout: 15000 });
  assert.equal(await psychic.locator('#dial .needle').isVisible(), false,
    'psişiğin kendi ibresi olmamalı');

  // ── İkisi de kilitleyince açılır
  for (const g of guessers) await g.click('#btn-lock');
  for (const page of pages) await page.waitForSelector('.points-burst .num', { timeout: 20000 });

  // Açılışta herkes iki ibreyi de görür (kendi ibresi beyaz ana ibre)
  await psychic.waitForFunction(() => document.querySelectorAll('#dial .ghost').length === 2);
  for (const g of guessers) {
    await g.waitForFunction(() => document.querySelectorAll('#dial .ghost').length === 1,
      null, { timeout: 15000 });
  }

  // Her cihazda aynı puan tablosu
  const tables = await Promise.all(pages.map(p =>
    p.locator('.stage .rank-list li').allTextContents()));
  assert.equal(new Set(tables.map(t => t.join('|'))).size, 1,
    `puan tablosu herkeste aynı olmalı: ${JSON.stringify(tables)}`);
  assert.equal(tables[0].length, 3, 'iki tahminci + psişik satırı');

  // Renkler ibreleri ayırt etmeye yarıyor: aynı odada çakışmamalı
  const dotColors = await psychic.locator('.stage .rank-list .dot').evaluateAll(
    els => els.map(e => e.style.background));
  assert.equal(new Set(dotColors).size, 3,
    `üç oyuncunun rengi farklı olmalı: ${dotColors}`);

  assert.deepEqual(errors, [], 'konsolda hata olmamalı');
});
