// Firebase kurulumu ve tüm veritabanı yardımcılarının tek giriş noktası.
// Diğer modüller doğrudan CDN'den import etmez; buradan alır.
//
// "firebase/app" gibi sade adlar tarayıcıda index.html'deki import map ile
// CDN'e, Node altındaki testlerde node_modules'a çözülür — böylece uçtan uca
// testler tarayıcıdakiyle BİREBİR aynı kodu çalıştırır.

import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, connectAuthEmulator } from 'firebase/auth';
import {
  getDatabase, ref, get, set, update, remove, push, onValue,
  runTransaction, serverTimestamp, onDisconnect, child, connectDatabaseEmulator,
  query, orderByValue, endAt, limitToFirst,
} from 'firebase/database';

import { firebaseConfig } from './config.js';

export {
  ref, get, set, update, remove, push, onValue,
  runTransaction, serverTimestamp, onDisconnect, child,
  query, orderByValue, endAt, limitToFirst,
};

const isBrowser = typeof window !== 'undefined';

/** localhost'ta (ve Node testlerinde) gerçek projeye değil emülatöre bağlanırız. */
export const USE_EMULATOR = isBrowser
  ? ['localhost', '127.0.0.1', '::1'].includes(location.hostname)
  : true;

const EMULATOR_CONFIG = {
  apiKey: 'demo-key',
  authDomain: 'demo-frekans.firebaseapp.com',
  databaseURL: 'https://demo-frekans-default-rtdb.firebaseio.com',
  projectId: 'demo-frekans',
  appId: 'demo-app',
};

if (!USE_EMULATOR && firebaseConfig.apiKey === 'REPLACE_ME') {
  throw new Error(
    'Firebase ayarları eksik. public/js/config.js dosyasını doldur (README > Kurulum).');
}

const app = initializeApp(USE_EMULATOR ? EMULATOR_CONFIG : firebaseConfig);

export const auth = getAuth(app);
export const db = getDatabase(app);

if (USE_EMULATOR) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectDatabaseEmulator(db, '127.0.0.1', 9000);
  if (isBrowser) console.info('[Frekans] Emülatör modu — veriler yereldeki emülatörde.');
}

let _uid = null;

// Oturumu auth.js açar; burada yalnızca güncel uid izlenir.
onAuthStateChanged(auth, (user) => { _uid = user ? user.uid : null; });

/** Oturum açıldıktan sonra senkron erişim için. */
export function uid() { return _uid; }

export const dbRef = (path) => ref(db, path);

// Telefon saatleri birbirini tutmaz; geri sayımı sunucu saatine göre
// hesaplamak için RTDB'nin bildirdiği farkı takip ederiz.
let _timeOffset = 0;
onValue(ref(db, '.info/serverTimeOffset'), (snap) => {
  const v = snap.val();
  if (typeof v === 'number') _timeOffset = v;
});

/** Sunucu saatine göre "şimdi" (ms). */
export function serverNow() { return Date.now() + _timeOffset; }

/** Bağlantı durumu (RTDB'nin kendi sinyali). */
export function onConnectionChange(cb) {
  return onValue(ref(db, '.info/connected'), (snap) => cb(snap.val() === true));
}
