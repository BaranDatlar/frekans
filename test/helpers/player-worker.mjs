// Tek bir oyuncuyu canlandıran worker. Uygulamanın GERÇEK modüllerini
// (room.js / game.js) çalıştırır; her worker kendi Firebase oturumuna sahiptir.

import { parentPort } from 'node:worker_threads';

const fb = await import('../../public/js/firebase.js');
const room = await import('../../public/js/room.js');
const game = await import('../../public/js/game.js');

await fb.authReady;

function snapshot(s) {
  return {
    code: s.code, me: s.me, connected: s.connected,
    players: s.players, game: s.game, history: s.history, locks: s.locks,
    meta: s.meta,
    // türetilmiş: testlerin uygulamanın kendi görüşünü doğrulaması için
    view: s.game ? {
      mode: game.mode(),
      target: game.knownTarget(),
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
  addSpectrums: async ({ items }) => {
    const spec = await import('../../public/js/spectrums.js');
    return spec.addMany(items);
  },
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
