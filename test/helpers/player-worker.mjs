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
    players: s.players, game: s.game, history: s.history,
  };
}

let busy = false;
room.subscribe(async (s) => {
  parentPort.postMessage({ type: 'state', state: snapshot(s) });
  if (busy) return;
  busy = true;
  try {
    const { changed, error } = await game.runSideEffects();
    if (error) parentPort.postMessage({ type: 'appError', error });
    if (changed) parentPort.postMessage({ type: 'state', state: snapshot(room.state) });
  } finally { busy = false; }
});

const actions = {
  uid: () => fb.uid(),
  create: ({ name }) => room.createRoom(name),
  join: ({ code, name }) => room.joinRoom(code, name),
  leave: () => room.leaveRoom(),
  setRounds: ({ n }) => game.setTotalRounds(n),
  start: () => game.startGame(),
  clue: ({ text }) => game.submitClue(text),
  dial: ({ value }) => { game.pushDial(value); game.flushDial(); },
  lock: () => game.lockGuess(),
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
    parentPort.postMessage({ type: 'result', id, value: value ?? null });
  } catch (err) {
    parentPort.postMessage({ type: 'result', id, error: err?.message || String(err) });
  }
});

parentPort.postMessage({ type: 'ready', uid: fb.uid() });
