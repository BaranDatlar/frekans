// Kimlik kapısı. Uygulamanın tek giriş noktası: kimlik çözülmeden hiçbir
// ekran çizilmez, böylece ana ekran bir an parlayıp kaybolmaz.
//
// İki yol var:
//  · Google ile giriş — oda kurabilir, kendi setlerini kaydedebilir.
//  · Misafir (anonim)  — odaya katılıp oynayabilir; oda kuramaz, set kaydedemez.
//    Bu kısıt yalnızca arayüzde değil, güvenlik kurallarında da uygulanır
//    (`auth.token.firebase.sign_in_provider != 'anonymous'`).

import {
  GoogleAuthProvider, OAuthProvider,
  signInWithPopup, signInWithRedirect, getRedirectResult, signInWithCredential,
  signInAnonymously, linkWithPopup, linkWithRedirect, signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
} from 'firebase/auth';
import { auth, USE_EMULATOR } from './firebase.js';

/**
 * Oturum kalıcılığı iki türlü:
 *  · Hesap girişi  → browserLocalPersistence. Tarayıcı kapansa da açık kalır;
 *    kullanıcı çıkış yapmadıkça bir daha giriş ekranı görmez.
 *  · Misafir girişi → browserSessionPersistence. Sekmeye özeldir; siteye
 *    yeniden gelindiğinde giriş ekranı çıkar, kimse farkında olmadan
 *    misafir olarak içeri düşmez.
 */
const EMAIL_KEY = 'frekans.lastEmail';   // sonraki girişte hesap sormamak için
const CHOOSE_KEY = 'frekans.chooseAccount';
const GUEST_KEY = 'frekans.guestSession';

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* depolama kapalı */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* yoksay */ } },
};
const guestMarker = {
  has() { try { return sessionStorage.getItem(GUEST_KEY) === '1'; } catch { return false; } },
  set() { try { sessionStorage.setItem(GUEST_KEY, '1'); } catch { /* yoksay */ } },
  clear() { try { sessionStorage.removeItem(GUEST_KEY); } catch { /* yoksay */ } },
};

/**
 * Açık giriş yöntemleri.
 * Apple kapalı ve düğmesi sayfada yok. Açmak için: Apple Developer hesabıyla
 * Services ID + alan adı doğrulaması yapılır, Firebase'de Apple sağlayıcısı
 * açılır, buradaki bayrak true edilir ve giriş ekranına düğme eklenir
 * (signInApple hazır bekliyor).
 */
export const PROVIDERS = {
  google: true,
  apple: false,
};

let _user = null;
let _ready = false;
const listeners = new Set();

export function currentUser() { return _user; }
export function signedIn() { return !!_user; }
export function isGuest() { return !!_user?.isAnonymous; }
export function canCreateRooms() { return signedIn() && !isGuest(); }
export function canSavePacks() { return canCreateRooms(); }

/** Sağlayıcıdan gelen ad; yoksa e-postanın baş kısmı. */
export function providerName() {
  if (!_user || _user.isAnonymous) return '';
  const n = (_user.displayName || '').trim();
  if (n) return n.slice(0, 14);
  const mail = (_user.email || '').split('@')[0];
  return mail ? mail.slice(0, 14) : '';
}

export function onUser(fn) {
  listeners.add(fn);
  if (_ready) fn(_user);
  return () => listeners.delete(fn);
}

function publish() { for (const fn of [...listeners]) fn(_user); }

function googleProvider() {
  const p = new GoogleAuthProvider();
  // Bir kez giren kişi tekrar hesap seçmek zorunda kalmasın: son kullandığı
  // adres ipucu olarak gönderilir, Google sessizce onunla devam eder.
  // Yalnızca kullanıcı ÇIKIŞ yaptıysa hesap seçtirilir.
  if (ls.get(CHOOSE_KEY)) p.setCustomParameters({ prompt: 'select_account' });
  else {
    const hint = ls.get(EMAIL_KEY);
    if (hint) p.setCustomParameters({ login_hint: hint });
  }
  return p;
}

/** Girişten sonra: bir dahaki sefere hesap sorulmasın. */
function rememberAccount(user) {
  ls.del(CHOOSE_KEY);
  if (user?.email) ls.set(EMAIL_KEY, user.email);
}

const appleProvider = () => new OAuthProvider('apple.com');

/**
 * Açılışta bir kez çağrılır. Yönlendirme dönüşünü işler ve ilk kimlik
 * durumunu bekler.
 * @returns {Promise<import('firebase/auth').User|null>}
 */
export async function initAuth() {
  // Yönlendirmeli girişten dönüldüyse sonucu burada toplanır. Hata olsa bile
  // uygulamanın açılmasını engellemesin.
  const redirect = await getRedirectResult(auth).catch((err) => {
    pendingRedirectError = friendlyAuthError(err);
    return null;
  });

  return new Promise((resolve) => {
    let settled = false;
    const settle = (user) => {
      _user = user;
      _ready = true;
      publish();
      if (!settled) { settled = true; resolve(user); }
    };

    // Yalnızca AÇILIŞTAKİ oturuma bakılır. Bu denetimi her kimlik değişiminde
    // yapmak, sessionStorage'a erişilemeyen ortamlarda (Node, depolaması kapalı
    // tarayıcı) yeni açılan misafir oturumunu da anında düşürürdü.
    let firstCheck = true;
    onAuthStateChanged(auth, async (user) => {
      if (firstCheck) {
        firstCheck = false;
        // Bu sekmeye ait olmayan misafir oturumu (önceki ziyaretten kalmış)
        // kabul edilmez: kimse farkında olmadan misafir olarak içeri düşmesin.
        if (user?.isAnonymous && !guestMarker.has()) {
          try { await signOut(auth); return; }   // sonraki tetikleme null gelir
          catch { /* çıkış yapılamadıysa mevcut oturumla devam */ }
        }
      }
      settle(user);
    }, () => settle(null));

    // Kimlik hiç çözülmezse uygulama açılışta asılı kalmasın
    setTimeout(() => settle(auth.currentUser ?? null), 15000);
    if (redirect?.user) { /* onAuthStateChanged zaten tetiklenecek */ }
  });
}

let pendingRedirectError = null;
/** Yönlendirmeli girişten hata ile dönüldüyse mesajı bir kez verir. */
export function takeRedirectError() {
  const e = pendingRedirectError;
  pendingRedirectError = null;
  return e;
}

/**
 * Google ile giriş. Misafirken çağrılırsa hesap **yükseltilir**: uid korunur,
 * böylece oyunun ortasında kimlik değişip odadan düşülmez.
 */
export async function signInGoogle() {
  return signInWith(googleProvider());
}

export async function signInApple() {
  if (!PROVIDERS.apple) throw new Error('Apple ile giriş şu an kapalı.');
  return signInWith(appleProvider());
}

async function signInWith(provider) {
  const guest = auth.currentUser?.isAnonymous ? auth.currentUser : null;
  // Hesap oturumu kalıcı olsun (misafirinki sekmeye özeldi).
  await setPersistence(auth, browserLocalPersistence).catch(() => {});
  try {
    if (guest) {
      // Misafiri yükselt: aynı uid korunur.
      const res = await linkWithPopup(guest, provider);
      guestMarker.clear();
      rememberAccount(res.user);
      return res.user;
    }
    const res = await signInWithPopup(auth, provider);
    rememberAccount(res.user);
    return res.user;
  } catch (err) {
    const code = err?.code || '';

    // Bu Google hesabı zaten var: misafir kaydı bırakılır, hesaba geçilir.
    if (code === 'auth/credential-already-in-use' ||
        code === 'auth/email-already-in-use') {
      const cred = OAuthProvider.credentialFromError(err)
        || GoogleAuthProvider.credentialFromError(err);
      if (cred) {
        const res = await signInWithCredential(auth, cred);
        guestMarker.clear();
        rememberAccount(res.user);
        return res.user;
      }
    }

    // Popup açılamıyorsa (mobil, uygulama içi tarayıcı) yönlendirmeye düş.
    if (code === 'auth/popup-blocked' ||
        code === 'auth/operation-not-supported-in-this-environment') {
      if (guest) await linkWithRedirect(guest, provider);
      else await signInWithRedirect(auth, provider);
      return null;   // sayfa yönlendiriliyor
    }

    // Yükseltme başarısızsa misafir oturumu yine sekmeye özel kalsın
    if (guest) await setPersistence(auth, browserSessionPersistence).catch(() => {});
    throw new Error(friendlyAuthError(err));
  }
}

/** Misafir girişi. Oturum sekmeye özeldir, siteye dönünce giriş ekranı çıkar. */
export async function signInGuest() {
  try {
    await setPersistence(auth, browserSessionPersistence).catch(() => {});
    guestMarker.set();
    const res = await signInAnonymously(auth);
    return res.user;
  } catch (err) {
    guestMarker.clear();
    throw new Error(friendlyAuthError(err));
  }
}

export async function signOutUser() {
  // Bilerek çıkan kişi bir dahaki girişte hesabını seçebilsin.
  ls.set(CHOOSE_KEY, '1');
  guestMarker.clear();
  await signOut(auth);
}

/**
 * Testlerde kullanılır: Auth emülatörü imzasız kimlik belirtecini kabul eder,
 * böylece gerçek Google popup'ını otomatikleştirmeye gerek kalmaz.
 * Emülatör dışında çalışmaz.
 */
export async function signInFakeGoogle({ sub = 'test-user', email, name = 'Test' } = {}) {
  if (!USE_EMULATOR) throw new Error('Yalnızca emülatörde kullanılabilir.');
  // E-posta da benzersiz olmalı: Firebase varsayılan olarak aynı e-postaya
  // sahip hesapları TEK hesapta birleştirir, farklı sub'lar aynı uid'e düşer.
  const mail = email || `${String(sub).toLowerCase().replace(/[^a-z0-9]+/g, '-')}@ornek.test`;
  const token = JSON.stringify({ sub, email: mail, email_verified: true, name });
  const cred = GoogleAuthProvider.credential(token);
  await setPersistence(auth, browserLocalPersistence).catch(() => {});
  const guest = auth.currentUser?.isAnonymous ? auth.currentUser : null;
  if (guest) {
    try {
      const { linkWithCredential } = await import('firebase/auth');
      const res = await linkWithCredential(guest, cred);
      guestMarker.clear();
      rememberAccount(res.user);
      return res.user;
    } catch (err) {
      if (err?.code !== 'auth/credential-already-in-use') throw err;
    }
  }
  const res = await signInWithCredential(auth, cred);
  guestMarker.clear();
  rememberAccount(res.user);
  return res.user;
}

/** Ham Firebase hatalarını kullanıcının anlayacağı hale getirir. */
export function friendlyAuthError(err) {
  const code = err?.code || '';
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Giriş penceresi kapandı. Tekrar dene.';
    case 'auth/popup-blocked':
      return 'Tarayıcı giriş penceresini engelledi. İzin ver ya da tekrar dene.';
    case 'auth/network-request-failed':
      return 'Bağlantı kurulamadı. İnternetini kontrol et.';
    case 'auth/unauthorized-domain':
      return 'Bu adres Firebase\'de yetkili değil (Authentication → Settings).';
    case 'auth/operation-not-allowed':
      return 'Bu giriş yöntemi Firebase\'de açık değil.';
    case 'auth/too-many-requests':
      return 'Çok fazla deneme. Biraz bekleyip tekrar dene.';
    default:
      return err?.message?.replace(/^Firebase:\s*/, '') || 'Giriş yapılamadı.';
  }
}
