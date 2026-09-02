// Oda yaşam döngüsü: kurma, katılma, varlık (presence) ve canlı abonelikler.
// Buradaki `state` uygulamanın tek doğruluk kaynağıdır; her değişimde
// abone olan render fonksiyonu çağrılır.

import {
  dbRef, get, set, update, remove, onValue, runTransaction,
  onDisconnect, uid, onConnectionChange,
  query, orderByValue, endAt, limitToFirst,
} from './firebase.js';
import { isExpired, SOURCE } from './deck.js';

/** Bir odanın altındaki tüm veri düğümleri (meta hariç). */
const ROOM_NODES = ['players', 'state', 'history', 'secret', 'usedSpectrumIds', 'locks', 'guesses'];

const ALPHABET = 'ABCDEFGHJKLMNPRSTUVYZ';   // I/O/Q gibi karışanlar yok
const CODE_LEN = 4;
/** Oda ömrü. Süresi dolan odaya girilemez ve herkes tarafından silinebilir. */
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

export const state = {
  code: null,
  me: null,
  name: '',
  meta: null,         // { createdAt, hostUid }
  players: {},        // uid -> { name, joinedAt, online }
  game: null,         // rooms/{code}/state düğümü
  history: {},        // roundIndex -> kayıt
  locks: {},          // roundIndex -> { uid: kilitlenen ibre değeri }
  deck: null,         // { source, name?, cards? }
  roomGone: false,    // oda sunucudan silindi (kapatıldı)
  connected: false,
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit() { for (const fn of listeners) fn(state); }

let unsubs = [];
let unsubConn = null;

function randomCode() {
  let c = '';
  for (let i = 0; i < CODE_LEN; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return c;
}

export function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, CODE_LEN);
}

/** Boş (veya bayatlamış) bir oda kodu kapar ve oyuncuyu içine alır. */
export async function createRoom(name) {
  let lastError = null;

  for (let attempt = 0; attempt < 12; attempt++) {
    const code = randomCode();
    try {
      const metaRef = dbRef(`rooms/${code}/meta`);
      const now = Date.now();
      const expiresAt = now + ROOM_TTL_MS;
      let takeover = false;
      const res = await runTransaction(metaRef, (cur) => {
        // Ömrü dolmamış oda meşguldür; dolmuşsa devralınır.
        if (cur && !isExpired(cur.expiresAt ?? (cur.createdAt || 0) + ROOM_TTL_MS, now)) return;
        takeover = !!cur;
        return { createdAt: now, expiresAt, hostUid: uid() };
      });
      if (!res.committed) continue;

      if (takeover) {
        // Bayat odanın bütün kalıntılarını temizle. Listede eksik kalan bir
        // düğüm sonraki oyunu bozar; kurallarda hepsinin toplu silme izni var.
        await Promise.all(ROOM_NODES.map(k => remove(dbRef(`rooms/${code}/${k}`))));
      }

      await set(dbRef(`rooms/${code}/state`), {
        phase: 'lobby', mode: 'solo', roundIndex: 0, totalRounds: 10,
        order: null, psychicUid: null, teams: null,
        drawId: null, spectrum: null, clue: null, lockDeadline: null,
      });
      await set(dbRef(`rooms/${code}/deck`), { source: SOURCE.BUILTIN });
      // Süresi dolmuşları bulmak için dizin (bkz. sweepExpiredRooms)
      await set(dbRef(`roomIndex/${code}`), expiresAt);
      await enterRoom(code, name);
      return code;
    } catch (err) {
      // Tek bir kod yüzünden oda kurma tamamen düşmesin: başka kodla dene.
      lastError = err;
      console.warn(`[Frekans] ${code} kodunda oda kurulamadı:`, err?.message || err);
    }
  }

  throw lastError || new Error('Boş oda kodu bulunamadı, tekrar dene.');
}

/** Var olan odaya katılır. */
export async function joinRoom(code, name) {
  const c = normalizeCode(code);
  if (c.length !== CODE_LEN) throw new Error('Oda kodu 4 harf olmalı.');
  const snap = await get(dbRef(`rooms/${c}/meta`));
  if (!snap.exists()) throw new Error('Böyle bir oda yok.');
  const meta = snap.val();
  if (isExpired(meta?.expiresAt ?? (meta?.createdAt || 0) + ROOM_TTL_MS)) {
    throw new Error('Bu odanın süresi dolmuş.');
  }
  // Kapatılmış oda birkaç yüz milisaniye daha duruyor olabilir; içine düşme.
  const phase = (await get(dbRef(`rooms/${c}/state/phase`))).val();
  if (phase === 'closed') throw new Error('Bu oda kapatıldı.');
  await enterRoom(c, name);
  return c;
}

/** Oyuncu kaydını yazar, presence kurar, dinleyicileri bağlar. */
async function enterRoom(code, name) {
  detach();
  state.code = code;
  state.me = uid();
  state.name = name;

  const pRef = dbRef(`rooms/${code}/players/${state.me}`);
  const existing = await get(pRef);
  if (existing.exists()) {
    await update(pRef, { name, online: true });
  } else {
    await set(pRef, { name, online: true, joinedAt: Date.now() });
  }

  // Bağlantı her kurulduğunda presence'ı yeniden kur (yeniden bağlanma dahil).
  unsubConn = onConnectionChange(async (connected) => {
    state.connected = connected;
    emit();
    if (!connected || state.code !== code) return;
    try {
      await onDisconnect(dbRef(`rooms/${code}/players/${state.me}/online`)).set(false);
      await update(dbRef(`rooms/${code}/players/${state.me}`), { online: true, name: state.name });
    } catch { /* oda silinmiş olabilir */ }
  });

  state.roomGone = false;
  unsubs.push(onValue(dbRef(`rooms/${code}/meta`), (s) => {
    const had = !!state.meta;
    state.meta = s.val();
    // Odayı bir kez görüp sonra kaybettiysek oda silinmiş demektir.
    if (had && !state.meta) state.roomGone = true;
    emit();
  }));
  unsubs.push(onValue(dbRef(`rooms/${code}/players`), (s) => {
    state.players = s.val() || {};
    emit();
  }));
  unsubs.push(onValue(dbRef(`rooms/${code}/state`), (s) => {
    state.game = s.val();
    emit();
  }));
  unsubs.push(onValue(dbRef(`rooms/${code}/history`), (s) => {
    state.history = s.val() || {};
    emit();
  }));
  unsubs.push(onValue(dbRef(`rooms/${code}/locks`), (s) => {
    state.locks = s.val() || {};
    emit();
  }));
  unsubs.push(onValue(dbRef(`rooms/${code}/deck`), (s) => {
    state.deck = s.val();
    emit();
  }));
}

/** Dinleyicileri kapatır; odayı terk etmez. */
function detach() {
  unsubs.forEach(fn => { try { fn(); } catch { /* yoksay */ } });
  unsubs = [];
  if (unsubConn) { try { unsubConn(); } catch { /* yoksay */ } unsubConn = null; }
}

/**
 * Odadan çık: çevrimdışı işaretle ve her şeyi bırak.
 * Oda kapanmışsa (`notify: false`) kayıt geri yazılmaz — yoksa silinmiş
 * odanın altında yetim bir oyuncu düğümü kalır.
 */
export async function leaveRoom({ notify = true } = {}) {
  const { code, me } = state;
  detach();
  if (code && me && notify) {
    try {
      await onDisconnect(dbRef(`rooms/${code}/players/${me}/online`)).cancel();
      await update(dbRef(`rooms/${code}/players/${me}`), { online: false });
    } catch { /* yoksay */ }
  }
  clearRoomState();
  emit();
}

function clearRoomState() {
  state.code = null; state.game = null; state.meta = null; state.deck = null;
  state.players = {}; state.history = {}; state.locks = {}; state.roomGone = false;
}

/* ══════════ Türetilmiş yardımcılar ══════════ */

/** Oyuncuları katılma sırasına göre dizi olarak verir. */
export function playerList() {
  return Object.entries(state.players)
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
}

export function onlinePlayers() {
  return playerList().filter(p => p.online);
}

/** Odayı kuran kişi (oda kapatma yetkisi ondadır). */
export function ownerId() {
  return state.meta?.hostUid || null;
}

export function iAmOwner() {
  return !!state.me && state.me === ownerId();
}

/**
 * Oyunu başlatma/ayar yetkisi kimde: odayı kuran kişi. O çevrimdışıysa
 * en erken katılan çevrimiçi oyuncuya düşer ki oyun kilitlenmesin.
 */
export function hostId() {
  const owner = ownerId();
  if (owner && isOnline(owner)) return owner;
  const list = onlinePlayers();
  return list.length ? list[0].id : null;
}

/**
 * Odayı kapatır. Yalnızca odayı kuran kişi çağırabilir.
 * Önce herkese "kapandı" sinyali verilir, sonra veri silinir — böylece
 * diğerleri boş ekranla değil, açık bir mesajla karşılaşır.
 */
export async function closeRoom() {
  const code = state.code;
  if (!code || !iAmOwner()) return false;
  try {
    await update(dbRef(`rooms/${code}/state`), { phase: 'closed' });
  } catch { /* oda zaten yok olabilir */ }
  detach();
  try {
    await onDisconnect(dbRef(`rooms/${code}/players/${state.me}/online`)).cancel();
  } catch { /* yoksay */ }
  // Diğer cihazlar sinyali alsın diye kısa bir soluk, sonra tamamen sil.
  await new Promise(r => setTimeout(r, 600));
  await remove(dbRef(`roomIndex/${code}`)).catch(() => {});
  try {
    await remove(dbRef(`rooms/${code}`));
  } catch (err) {
    // Sessizce yutmak yerine görünür kıl: burada kalan oda hayalet oda olur.
    console.warn('[Frekans] Oda silinemedi:', err?.code || err?.message || err);
  }
  clearRoomState();
  emit();
  return true;
}

/**
 * Süresi dolmuş odaları siler. Sunucu kodu (Cloud Functions) kullanmadan
 * temizlik: `roomIndex` düğümü kodları bitiş zamanına göre sıralı tutar,
 * güvenlik kuralı da süresi dolmuş odanın herkes tarafından silinmesine
 * izin verir. Uygulama açılışında ve oda kurulurken çağrılır.
 */
export async function sweepExpiredRooms(limit = 10) {
  try {
    const snap = await get(query(
      dbRef('roomIndex'), orderByValue(), endAt(Date.now()), limitToFirst(limit)));
    const expired = Object.keys(snap.val() || {});
    for (const code of expired) {
      await remove(dbRef(`rooms/${code}`)).catch(() => {});
      await remove(dbRef(`roomIndex/${code}`)).catch(() => {});
    }
    return expired.length;
  } catch {
    return 0;   // izin/bağlantı sorunu: temizlik kritik değil, sonra denenir
  }
}

export function playerName(id) {
  return state.players[id]?.name || 'Bilinmeyen';
}

export function isOnline(id) {
  return !!state.players[id]?.online;
}

/**
 * Oyuncu rengi. Katılma sırasındaki konuma göre verilir; liste her cihazda
 * aynı sıralandığı için renkler herkeste aynıdır ve (8 kişiye kadar) çakışmaz.
 * Bireysel modda ibreler renkle ayırt edildiği için çakışmama önemli.
 */
const COLORS = ['#4dd4c4', '#f2a65a', '#7aa2f7', '#e07a9b', '#9ece6a', '#bb9af7', '#e0af68', '#79b8d6'];
export function colorFor(id) {
  const idx = playerList().findIndex(p => p.id === id);
  if (idx >= 0) return COLORS[idx % COLORS.length];
  // Odadan silinmiş biri için (ör. eski tur kaydı) sabit bir yedek
  let h = 0;
  for (let i = 0; i < (id || '').length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}
