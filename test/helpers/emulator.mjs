// Emülatöre bağlı test istemcileri. Uygulama modüllerinden bağımsızdır ki
// aynı süreçte birden fazla "oyuncu" oluşturabilelim.

import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, signInAnonymously, connectAuthEmulator } from 'firebase/auth';
import { getDatabase, connectDatabaseEmulator, ref, get, set, update, remove } from 'firebase/database';

export const CONFIG = {
  apiKey: 'demo-key',
  authDomain: 'demo-frekans.firebaseapp.com',
  databaseURL: 'https://demo-frekans-default-rtdb.firebaseio.com',
  projectId: 'demo-frekans',
  appId: 'demo-app',
};

export const DB_HOST = '127.0.0.1';
export const DB_PORT = 9000;

// Emülatörün REST ucu da güvenlik kurallarına tabidir; "owner" belirteci
// yönetici erişimi verir (yalnızca emülatörde geçerlidir).
const ADMIN = { headers: { Authorization: 'Bearer owner' } };
// Emülatör güvenlik kurallarını YALNIZCA projenin varsayılan namespace'inde
// uygular; başka bir ns kullanmak kuralları sessizce devre dışı bırakır.
const NS = 'demo-frekans-default-rtdb';
const restUrl = (path = '') => `http://${DB_HOST}:${DB_PORT}/${path}.json?ns=${NS}`;

/** Emülatör ayakta mı? Değilse testler atlanır. */
export async function emulatorUp() {
  try {
    const res = await fetch(restUrl(), ADMIN);
    return res.ok;
  } catch { return false; }
}

let seq = 0;

/** Kendi anonim kullanıcısı olan bağımsız bir istemci. */
export async function makeClient(label = `c${++seq}`) {
  const app = initializeApp(CONFIG, `test-${label}-${Date.now()}-${++seq}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getDatabase(app);
  connectDatabaseEmulator(db, DB_HOST, DB_PORT);
  const cred = await signInAnonymously(auth);
  return {
    label,
    uid: cred.user.uid,
    db,
    ref: (p) => ref(db, p),
    get: (p) => get(ref(db, p)),
    set: (p, v) => set(ref(db, p), v),
    update: (p, v) => update(ref(db, p), v),
    remove: (p) => remove(ref(db, p)),
    close: () => deleteApp(app),
  };
}

/** Emülatörün tüm verisini siler (yönetici REST çağrısı, kurallar atlanır). */
export async function wipe() {
  const res = await fetch(restUrl(), { method: 'DELETE', ...ADMIN });
  if (!res.ok) throw new Error(`Emülatör temizlenemedi: ${res.status} ${await res.text()}`);
}

/** Testin gerçekten temiz başladığını doğrulamak için. */
export async function dump(path = '') {
  const res = await fetch(restUrl(path), ADMIN);
  return res.json();
}

/** İzin reddi bekleyen yardımcı: reddedildiyse true. */
export async function denied(promise) {
  try { await promise; return false; }
  catch (e) { return String(e.code || e.message).toLowerCase().includes('permission'); }
}
