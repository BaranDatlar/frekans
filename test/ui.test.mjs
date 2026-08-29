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
  await psychic.click('text=İpucunu Gönder');
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
  assert.equal(await psychic.locator('text=Kilitle').count(), 0,
    'psişik kilitleyememeli');

  // ── Kilitle → açılış
  await guessers[1].click('text=Kilitle');
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
  await pages[0].click('text=Sonraki Tur');
  for (const page of pages) {
    await page.waitForFunction(() =>
      document.querySelector('#game-round-label')?.textContent === 'Tur 2/10');
  }

  assert.deepEqual(errors, [], 'konsolda hata olmamalı');
});
