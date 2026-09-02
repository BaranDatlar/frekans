// İnce başlatıcı.
//
// İki işi var:
//  1. Sayfa ile betiklerin sürümü uyuşmuyorsa (tarayıcı eski HTML'i
//     önbellekten, yeni JS'i ağdan almışsa) kendini bir kez tazeler.
//  2. Asıl uygulamayı dinamik import eder ki Firebase ayarları eksikse
//     beyaz ekran yerine anlaşılır bir mesaj çıksın.

const RELOAD_FLAG = 'frekans.reloaded';

/** Yeni sürümde olması gereken düğümler. Yoksa sayfa bayattır. */
const REQUIRED = ['#screen-login', '#btn-google', '#btn-guest', '#screen-packs', '#team-picker'];

function pageIsStale() {
  return REQUIRED.some(sel => !document.querySelector(sel));
}

function showBootError(msg) {
  const box = document.querySelector('#boot-status');
  if (box) { box.textContent = msg; box.classList.add('error'); }
  document.querySelector('#screen-boot .spinner')?.remove();
}

document.querySelector('#screen-boot')?.classList.add('active');

// Giriş akışının çalışması için uygulama, config.js'teki authDomain ile AYNI
// origin'de olmalı. Farklı alan adından açıldıysa (ör. .web.app ile
// .firebaseapp.com) doğru adrese taşınırız — yol ve sorgu korunur.
async function ensureCanonicalHost() {
  const host = location.hostname;
  if (!/\.(web\.app|firebaseapp\.com)$/.test(host)) return false;   // yerel/özel alan adı
  try {
    const { firebaseConfig } = await import('./config.js');
    const want = firebaseConfig?.authDomain;
    if (!want || host === want) return false;
    const url = new URL(location.href);
    url.hostname = want;
    location.replace(url.toString());
    return true;
  } catch { return false; }
}

if (await ensureCanonicalHost()) {
  // sayfa taşınıyor; başlatmaya devam etme
} else

if (pageIsStale()) {
  // Eski sayfa + yeni betik: aynı adresi tekrar istemek önbellekten dönebilir,
  // bu yüzden sorgu parametresiyle taze bir adres isteriz. Döngüye girmemek
  // için sekme başına bir kez.
  if (sessionStorage.getItem(RELOAD_FLAG)) {
    showBootError('Sayfa güncellenemedi. Tarayıcıyı kapatıp tekrar aç ya da sayfayı sert yenile.');
  } else {
    try { sessionStorage.setItem(RELOAD_FLAG, '1'); } catch { /* depolama kapalı */ }
    const url = new URL(location.href);
    url.searchParams.set('v', Date.now().toString(36));
    location.replace(url.toString());
  }
} else {
  try { sessionStorage.removeItem(RELOAD_FLAG); } catch { /* yoksay */ }
  try {
    const { start } = await import('./main.js');
    await start();
  } catch (err) {
    console.error(err);
    showBootError(err?.message || 'Uygulama başlatılamadı.');
  }
}
