// Tek bir oyuncuyu canlandıran worker. Uygulamanın GERÇEK modüllerini
// (room.js / game.js) çalıştırır; her worker kendi Firebase oturumuna sahiptir.

import { parentPort, workerData } from 'node:worker_threads';

const fb = await import('../../public/js/firebase.js');
const auth = await import('../../public/js/auth.js');
const room = await import('../../public/js/room.js');
const game = await import('../../public/js/game.js');
const packs = await import('../../public/js/packs.js');

// Testler gerçek Google popup'ını açamaz; Auth emülatörü imzasız kimlik
// belirtecini kabul ettiği için hesap oturumu böyle kurulur. Misafir
// oyuncular için `guest: true` verilir.
await auth.initAuth();
if (workerData?.guest) await auth.signInGuest();
else await auth.signInFakeGoogle({ sub: workerData.sub, name: workerData.name });

function snapshot(s) {
  return {
    code: s.code, me: s.me, connected: s.connected,
    players: s.players, game: s.game, history: s.history, locks: s.locks,
    meta: s.meta, deck: s.deck,
    // türetilmiş: testlerin uygulamanın kendi görüşünü doğrulaması için
    view: s.game ? {
      mode: game.mode(),
      target: game.knownTarget(),
      myTeam: game.myTeam(),
      teams: game.teamState(),
      deckSize: game.deckCards().length,
      deckSource: s.deck?.source ?? null,
      iLocked: game.iLocked(),
      myGuess: game.myGuess(),
      visibleGuesses: game.visibleGuesses(),
      everyoneLocked: game.everyoneLocked(),
      expected: game.expectedGuessers(),
      iAmOwner: room.iAmOwner(),
      ownerId: room.ownerId(),
    } : null,
  };
}

room.subscribe(async (s) => {
  parentPort.postMessage({ type: 'state', state: snapshot(s) });
  const { changed, error } = await game.runSideEffects();
  if (error) parentPort.postMessage({ type: 'appError', error });
  if (changed) parentPort.postMessage({ type: 'state', state: snapshot(room.state) });
});

const actions = {
  uid: () => fb.uid(),
  create: ({ name }) => room.createRoom(name),
  join: ({ code, name }) => room.joinRoom(code, name),
  leave: () => room.leaveRoom(),
  close: () => room.closeRoom(),
  setRounds: ({ n }) => game.setTotalRounds(n),
  setMode: ({ m }) => game.setMode(m),
  setTeam: ({ t }) => game.setMyTeam(t),
  shuffleTeams: () => game.shuffleTeams(),
  setDeck: ({ deck }) => game.setDeck(deck),
  savePack: ({ pack }) => packs.savePack(pack),
  loadPacks: () => packs.loadPacks(),
  sweep: () => room.sweepExpiredRooms(),
  isGuest: () => auth.isGuest(),
  start: () => game.startGame(),
  clue: ({ text }) => game.submitClue(text),
  dial: ({ value }) => { game.pushDial(value); game.flushDial(); },
  lock: () => game.lockGuess(),
  unlock: () => game.unlockGuess(),
  readTarget: () => game.fetchTarget(),
  next: () => game.nextRound(),
  skip: () => game.skipPsychic(),
  restart: () => game.restart(),
  knownTarget: () => game.knownTarget(),
  snapshot: () => snapshot(room.state),
};

parentPort.on('message', async ({ id, action, args }) => {
  try {
    const value = await actions[action](args || {});
    // Bazı işlemler (kendi ibreni çevirmek gibi) veritabanı aboneliğini
    // tetiklemez; ana sürece güncel durumu yine de bildir.
    parentPort.postMessage({ type: 'state', state: snapshot(room.state) });
    parentPort.postMessage({ type: 'result', id, value: value ?? null });
  } catch (err) {
    parentPort.postMessage({ type: 'result', id, error: err?.message || String(err) });
  }
});

parentPort.postMessage({ type: 'ready', uid: fb.uid() });
