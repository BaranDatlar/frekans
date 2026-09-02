import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEAM_META, MIN_PER_TEAM, isTeamId, teamOf, teamName, teamMembers,
  assignRandom, interleaveOrder, teamsBalanced,
  psychicTeamAverage, teamTotals, teamWinner,
} from '../public/js/teams.js';

const T = { p1: 'a', p2: 'a', p3: 'b', p4: 'b' };
const IDS = ['p1', 'p2', 'p3', 'p4'];

test('takım kimliği doğrulama', () => {
  assert.equal(isTeamId('a'), true);
  assert.equal(isTeamId('c'), false);
  assert.equal(teamOf(T, 'p1'), 'a');
  assert.equal(teamOf(T, 'yok'), null);
  assert.equal(teamOf(null, 'p1'), null);
  assert.equal(teamOf({ x: 'z' }, 'x'), null, 'geçersiz takım değeri null sayılır');
  assert.equal(teamName('a'), TEAM_META.a.name);
  assert.equal(teamName('yok'), '—');
});

test('teamMembers takımsızları ayırır', () => {
  const m = teamMembers({ p1: 'a', p3: 'b' }, ['p1', 'p2', 'p3']);
  assert.deepEqual(m, { a: ['p1'], b: ['p3'], none: ['p2'] });
  assert.deepEqual(teamMembers(null, null), { a: [], b: [], none: [] });
});

test('assignRandom eşit böler', () => {
  for (const n of [2, 4, 6, 8]) {
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const m = teamMembers(assignRandom(ids), ids);
    assert.equal(m.a.length, n / 2, `${n} kişide eşit bölünmeli`);
    assert.equal(m.b.length, n / 2);
  }
});

test('assignRandom tek sayıda en fazla bir fark bırakır', () => {
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];
  const m = teamMembers(assignRandom(ids), ids);
  assert.equal(Math.abs(m.a.length - m.b.length), 1);
  assert.equal(m.none.length, 0, 'herkes bir takıma girmeli');
});

test('assignRandom boş listede çökmez', () => {
  assert.deepEqual(assignRandom([]), {});
  assert.deepEqual(assignRandom(null), {});
});

test('interleaveOrder takımları dönüşümlü sıralar', () => {
  const order = interleaveOrder(T, IDS);
  const seq = order.map(id => T[id]);
  assert.equal(order.length, 4);
  assert.deepEqual([...order].sort(), [...IDS].sort(), 'kimse kaybolmamalı');
  for (let i = 1; i < seq.length; i++) {
    assert.notEqual(seq[i], seq[i - 1], `sıra dönüşümlü olmalı: ${seq}`);
  }
});

test('interleaveOrder dengesiz takımda fazlalıkları sona yığmaz', () => {
  // a: 3 kişi, b: 1 kişi  → a b a a  (kalabalık takım baştan başlar)
  const teams = { x1: 'a', x2: 'a', x3: 'a', y1: 'b' };
  const order = interleaveOrder(teams, Object.keys(teams));
  const seq = order.map(id => teams[id]);
  assert.equal(order.length, 4);
  assert.equal(seq[0], 'a');
  assert.equal(seq[1], 'b', 'küçük takım en baştaki turlardan birini almalı');
});

test('interleaveOrder takımsızları sona ekler', () => {
  const teams = { p1: 'a', p2: 'b' };
  const order = interleaveOrder(teams, ['p1', 'p2', 'yeni']);
  assert.equal(order[2], 'yeni');
});

test('teamsBalanced oynanabilirliği söyler', () => {
  assert.deepEqual(teamsBalanced(T, IDS), { a: 2, b: 2, even: true, playable: true });
  const az = teamsBalanced({ p1: 'a', p2: 'b', p3: 'b' }, ['p1', 'p2', 'p3']);
  assert.equal(az.playable, false, `her takımda en az ${MIN_PER_TEAM} kişi gerekir`);
  assert.equal(az.even, false);
  const kalabalik = teamsBalanced({ p1: 'a', p2: 'a', p3: 'b', p4: 'b', p5: 'b' },
    ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.equal(kalabalik.playable, true);
  assert.equal(kalabalik.even, false, 'oynanabilir ama dengesiz');
});

test('psychicTeamAverage yalnızca kendi takımdaşlarını sayar', () => {
  // p1 psişik (a takımı). p2 aynı takımda 4 aldı, rakipler 0 ve 4.
  const points = { p2: 4, p3: 0, p4: 4 };
  assert.equal(psychicTeamAverage(points, T, 'p1'), 4,
    'rakibin puanı psişiğin puanını etkilememeli');
});

test('psychicTeamAverage ortalamayı yuvarlar', () => {
  const teams = { psi: 'a', m1: 'a', m2: 'a', rakip: 'b' };
  assert.equal(psychicTeamAverage({ m1: 4, m2: 3, rakip: 0 }, teams, 'psi'), 4, '3.5 → 4');
  assert.equal(psychicTeamAverage({ m1: 4, m2: 0, rakip: 4 }, teams, 'psi'), 2);
});

test('psychicTeamAverage takımdaşı yoksa 0 verir', () => {
  const teams = { psi: 'a', rakip: 'b' };
  assert.equal(psychicTeamAverage({ rakip: 4 }, teams, 'psi'), 0);
  assert.equal(psychicTeamAverage({}, teams, 'psi'), 0);
  assert.equal(psychicTeamAverage({ m: 4 }, {}, 'psi'), 0, 'takımsız psişik puan almaz');
});

test('teamTotals turların takım dağılımını kullanır', () => {
  const history = {
    0: { psychicUid: 'p1', points: { p2: 4, p3: 0, p4: 2 }, psychicPoints: 4, teams: T },
    1: { psychicUid: 'p3', points: { p1: 3, p2: 1, p4: 4 }, psychicPoints: 4, teams: T },
  };
  // a: tur0 → p2(4) + psişik p1(4) = 8 ; tur1 → p1(3)+p2(1) = 4  → 12
  // b: tur0 → p3(0)+p4(2) = 2 ; tur1 → p4(4) + psişik p3(4) = 8  → 10
  assert.deepEqual(teamTotals(history), { a: 12, b: 10 });
});

test('teamTotals takım değiştiren oyuncunun geçmişini bozmaz', () => {
  const history = {
    0: { psychicUid: 'p1', points: { p2: 4 }, psychicPoints: 4, teams: { p1: 'a', p2: 'a' } },
    1: { psychicUid: 'p1', points: { p2: 4 }, psychicPoints: 0, teams: { p1: 'a', p2: 'b' } },
  };
  assert.deepEqual(teamTotals(history), { a: 8, b: 4 },
    'ilk tur p2 a takımında, ikinci turda b takımında sayılmalı');
});

test('teamTotals eksik veriyle çökmez', () => {
  assert.deepEqual(teamTotals(null), { a: 0, b: 0 });
  assert.deepEqual(teamTotals({}), { a: 0, b: 0 });
  assert.deepEqual(teamTotals({ 0: { points: { x: 4 } } }), { a: 0, b: 0 },
    'takım bilgisi olmayan tur sayılmaz');
  assert.deepEqual(teamTotals({ 0: null, 1: 'bozuk' }), { a: 0, b: 0 });
});

test('teamWinner beraberliği ayırt eder', () => {
  assert.deepEqual(teamWinner({ a: 10, b: 4 }), { winner: 'a', tie: false });
  assert.deepEqual(teamWinner({ a: 4, b: 10 }), { winner: 'b', tie: false });
  assert.deepEqual(teamWinner({ a: 7, b: 7 }), { winner: null, tie: true });
  assert.deepEqual(teamWinner(null), { winner: null, tie: true });
});
