// Oda yaşam döngüsü: kurma, katılma, varlık (presence) ve canlı abonelikler.
// Buradaki `state` uygulamanın tek doğruluk kaynağıdır; her değişimde
// abone olan render fonksiyonu çağrılır.

import {
  dbRef, get, set, update, remove, onValue, runTransaction,
  onDisconnect, uid, onConnectionChange,
} from './firebase.js';

const ALPHABET = 'ABCDEFGHJKLMNPRSTUVYZ';   // I/O/Q gibi karışanlar yok
const CODE_LEN = 4;
const STALE_MS = 24 * 60 * 60 * 1000;       // 24 saatten eski oda devralınabilir

export const state = {
  code: null,
  me: null,
  name: '',
  players: {},        // uid -> { name, joinedAt, online }
  game: null,         // rooms/{code}/state düğümü
  history: {},        // roundIndex -> kayıt
  locks: {},          // roundIndex -> { uid: kilitlenen ibre değeri }
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
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = randomCode();
    const metaRef = dbRef(`rooms/${code}/meta`);
    let takeover = false;
    const res = await runTransaction(metaRef, (cur) => {
      if (cur && Date.now() - (cur.createdAt || 0) < STALE_MS) return;  // iptal: dolu
      takeover = !!cur;
      return { createdAt: Date.now() };
    });
    if (!res.committed) continue;

    if (takeover) {
      // bayat odanın kalıntılarını temizle
      await Promise.all(['players', 'state', 'history', 'secret', 'usedSpectrumIds']
        .map(k => remove(dbRef(`rooms/${code}/${k}`))));
    }
    await set(dbRef(`rooms/${code}/state`), {
      phase: 'lobby', mode: 'shared', roundIndex: 0, totalRounds: 10,
      order: null, psychicUid: null, spectrum: null, clue: null,
      dial: { value: 50, by: null, at: 0 }, final: null, lockDeadline: null,
    });
    await enterRoom(code, name);
    return code;
  }
  throw new Error('Boş oda kodu bulunamadı, tekrar dene.');
}

/** Var olan odaya katılır. */
export async function joinRoom(code, name) {
  const c = normalizeCode(code);
  if (c.length !== CODE_LEN) throw new Error('Oda kodu 4 harf olmalı.');
  const snap = await get(dbRef(`rooms/${c}/meta`));
  if (!snap.exists()) throw new Error('Böyle bir oda yok.');
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
}

/** Dinleyicileri kapatır; odayı terk etmez. */
function detach() {
  unsubs.forEach(fn => { try { fn(); } catch { /* yoksay */ } });
  unsubs = [];
  if (unsubConn) { try { unsubConn(); } catch { /* yoksay */ } unsubConn = null; }
}

/** Odadan çık: çevrimdışı işaretle ve her şeyi bırak. */
export async function leaveRoom() {
  const { code, me } = state;
  detach();
  if (code && me) {
    try {
      await onDisconnect(dbRef(`rooms/${code}/players/${me}/online`)).cancel();
      await update(dbRef(`rooms/${code}/players/${me}`), { online: false });
    } catch { /* yoksay */ }
  }
  state.code = null; state.game = null;
  state.players = {}; state.history = {}; state.locks = {};
  emit();
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

/** Lobide "Başlat" düğmesi kimde: en erken katılan çevrimiçi oyuncu. */
export function hostId() {
  const list = onlinePlayers();
  return list.length ? list[0].id : null;
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
