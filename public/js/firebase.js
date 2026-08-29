// Firebase kurulumu ve tüm veritabanı yardımcılarının tek giriş noktası.
// Diğer modüller doğrudan CDN'den import etmez; buradan alır.
//
// "firebase/app" gibi sade adlar tarayıcıda index.html'deki import map ile
// CDN'e, Node altındaki testlerde node_modules'a çözülür — böylece uçtan uca
// testler tarayıcıdakiyle BİREBİR aynı kodu çalıştırır.

import { initializeApp } from 'firebase/app';
import {
  getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator,
} from 'firebase/auth';
import {
  getDatabase, ref, get, set, update, remove, push, onValue,
  runTransaction, serverTimestamp, onDisconnect, child, connectDatabaseEmulator,
} from 'firebase/database';

import { firebaseConfig } from './config.js';

export {
  ref, get, set, update, remove, push, onValue,
  runTransaction, serverTimestamp, onDisconnect, child,
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
/** Anonim oturum açıldıktan sonra çözülen promise; uid döner. */
export const authReady = new Promise((resolve, reject) => {
  onAuthStateChanged(auth, (user) => {
    if (user) { _uid = user.uid; resolve(user.uid); }
  }, reject);
  signInAnonymously(auth).catch(reject);
});

/** Oturum açıldıktan sonra senkron erişim için. */
export function uid() { return _uid; }

export const dbRef = (path) => ref(db, path);

/** Bağlantı durumu (RTDB'nin kendi sinyali). */
export function onConnectionChange(cb) {
  return onValue(ref(db, '.info/connected'), (snap) => cb(snap.val() === true));
}
