// Takım modu mantığı — saf fonksiyonlar, `node --test` altında test edilir.

import { shuffle } from './scoring.js';

/** İki sabit takım. */
export const TEAM_IDS = ['a', 'b'];

export const TEAM_META = {
  a: { name: 'Mavi', color: '#7aa2f7' },
  b: { name: 'Turuncu', color: '#f2a65a' },
};

/** Takım modunun oynanabilmesi için her takımda gereken en az kişi. */
export const MIN_PER_TEAM = 2;

export const isTeamId = (t) => t === 'a' || t === 'b';

export function teamOf(teams, uid) {
  const t = teams?.[uid];
  return isTeamId(t) ? t : null;
}

export function teamName(teamId) {
  return TEAM_META[teamId]?.name ?? '—';
}

/** @returns {{a:string[], b:string[], none:string[]}} */
export function teamMembers(teams, ids) {
  const out = { a: [], b: [], none: [] };
  for (const id of ids || []) {
    const t = teamOf(teams, id);
    out[t || 'none'].push(id);
  }
  return out;
}

/** Oyuncuları iki takıma eşit böler. */
export function assignRandom(ids, rng = Math.random) {
  const list = shuffle((ids || []).filter(Boolean), rng);
  const out = {};
  list.forEach((id, i) => { out[id] = i % 2 === 0 ? 'a' : 'b'; });
  return out;
}

/**
 * Psişik sırasını takımlar arasında dönüşümlü kurar (a, b, a, b…).
 * Yoksa kalabalık takım daha çok psişik sırası alıp avantaj kazanır.
 * Takımı olmayanlar (oyun başladıktan sonra katılanlar) sona eklenir.
 */
export function interleaveOrder(teams, ids, rng = Math.random) {
  const { a, b, none } = teamMembers(teams, ids);
  const qa = shuffle(a, rng);
  const qb = shuffle(b, rng);
  const order = [];
  // Kalabalık takım baştan başlasın ki fazlalıkları sona yığılmasın
  let [first, second] = qa.length >= qb.length ? [qa, qb] : [qb, qa];
  for (let i = 0; i < Math.max(first.length, second.length); i++) {
    if (i < first.length) order.push(first[i]);
    if (i < second.length) order.push(second[i]);
  }
  return order.concat(shuffle(none, rng));
}

/** Takım modu başlatılabilir mi? */
export function teamsBalanced(teams, ids) {
  const { a, b } = teamMembers(teams, ids);
  return {
    a: a.length,
    b: b.length,
    even: a.length === b.length,
    playable: a.length >= MIN_PER_TEAM && b.length >= MIN_PER_TEAM,
  };
}

/**
 * Takım modunda psişiğin puanı: YALNIZCA kendi takımdaşlarının ortalaması.
 * Rakibin iyi bilmesi psişiğe yaramaz — yarışma mantığı böyle korunur.
 * @param {Record<string,number>} points uid -> tahmincinin puanı
 * @param {Record<string,string>} teams  uid -> takım
 */
export function psychicTeamAverage(points, teams, psychicUid) {
  const own = teamOf(teams, psychicUid);
  if (!own) return 0;
  const vals = Object.entries(points || {})
    .filter(([id]) => teamOf(teams, id) === own && id !== psychicUid)
    .map(([, p]) => Number(p))
    .filter(Number.isFinite);
  if (!vals.length) return 0;
  return Math.round(vals.reduce((x, y) => x + y, 0) / vals.length);
}

/**
 * Takım toplamları. Her tur kendi takım dağılımını (`h.teams`) taşıdığı için
 * biri sonradan takım değiştirse bile geçmiş turlar kaymaz.
 * @returns {{a:number, b:number}}
 */
export function teamTotals(history) {
  const totals = { a: 0, b: 0 };
  const rounds = Object.values(history || {}).filter(h => h && typeof h === 'object');
  for (const h of rounds) {
    const teams = h.teams || {};
    for (const [id, pts] of Object.entries(h.points || {})) {
      const t = teamOf(teams, id);
      if (t) totals[t] += Number(pts) || 0;
    }
    const pt = teamOf(teams, h.psychicUid);
    if (pt) totals[pt] += Number(h.psychicPoints) || 0;
  }
  return totals;
}

/** @returns {{winner:'a'|'b'|null, tie:boolean}} */
export function teamWinner(totals) {
  const a = totals?.a ?? 0;
  const b = totals?.b ?? 0;
  if (a === b) return { winner: null, tie: true };
  return { winner: a > b ? 'a' : 'b', tie: false };
}
