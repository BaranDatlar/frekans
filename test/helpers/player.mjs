// Worker'ı saran ince istemci: komut gönderir, durum bekler.

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./player-worker.mjs', import.meta.url));

let spawnSeq = 0;

export class Player {
  constructor(name) {
    this.name = name;
    this.state = null;
    this.errors = [];
    this._seq = 0;
    this._waiting = new Map();
    this._watchers = new Set();
  }

  /** @param {{guest?:boolean}} opts */
  static async spawn(name, opts = {}) {
    const p = new Player(name);
    p.guest = !!opts.guest;
    p.worker = new Worker(WORKER, {
      workerData: {
        guest: p.guest,
        name,
        sub: `${name}-${Date.now()}-${++spawnSeq}`,
      },
    });
    await new Promise((resolve, reject) => {
      p.worker.on('error', reject);
      p.worker.on('message', (msg) => {
        if (msg.type === 'ready') { p.uid = msg.uid; resolve(); }
        else if (msg.type === 'state') { p.state = msg.state; p._notify(); }
        else if (msg.type === 'appError') { p.errors.push(msg.error); }
        else if (msg.type === 'result') {
          const w = p._waiting.get(msg.id);
          if (w) { p._waiting.delete(msg.id); msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.value); }
        }
      });
    });
    return p;
  }

  _notify() { for (const fn of [...this._watchers]) fn(); }

  send(action, args) {
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      this._waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, action, args });
    });
  }

  /** Durum verilen koşulu sağlayana kadar bekler. */
  waitFor(predicate, label = 'koşul', timeout = 8000) {
    if (this.state && predicate(this.state)) return Promise.resolve(this.state);
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.state && predicate(this.state)) { cleanup(); resolve(this.state); }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${this.name}: "${label}" için zaman aşımı. Son durum: ` +
          JSON.stringify(this.state?.game)));
      }, timeout);
      const cleanup = () => { clearTimeout(timer); this._watchers.delete(check); };
      this._watchers.add(check);
      check();
    });
  }

  phase() { return this.state?.game?.phase ?? null; }
  close() { return this.worker.terminate(); }
}

export const waitAll = (players, predicate, label, timeout) =>
  Promise.all(players.map(p => p.waitFor(predicate, label, timeout)));
