// Saf oyun matematiği. Firebase'e, DOM'a, tarayıcıya bağımlılığı yok —
// hem tarayıcıda hem `node --test` altında aynı şekilde çalışır.

/** Tek bir puan bandının genişliği (0-100 skalasında). */
export const BAND = 3.2;

/** Hedef alanının merkezden yarı genişliği: 2.5 bant = 8 birim. */
export const HALF_TARGET = BAND * 2.5;

/** Hedef merkezi bu aralıkta üretilir ki hedef alanı kenardan taşmasın. */
export const MIN_TARGET = HALF_TARGET;
export const MAX_TARGET = 100 - HALF_TARGET;

/**
 * 0-100 arası gizli hedef merkezi üretir.
 * @param {() => number} rng test edilebilirlik için enjekte edilebilir
 */
export function randomTarget(rng = Math.random) {
  const v = MIN_TARGET + rng() * (MAX_TARGET - MIN_TARGET);
  return Math.round(v * 100) / 100;
}

/**
 * Hedef merkezine göre 5 bandı soldan sağa döndürür: 2-3-4-3-2.
 * @returns {{from:number,to:number,points:number}[]}
 */
export function bandsFor(target) {
  const b = BAND;
  return [
    { points: 2, from: target - 2.5 * b, to: target - 1.5 * b },
    { points: 3, from: target - 1.5 * b, to: target - 0.5 * b },
    { points: 4, from: target - 0.5 * b, to: target + 0.5 * b },
    { points: 3, from: target + 0.5 * b, to: target + 1.5 * b },
    { points: 2, from: target + 1.5 * b, to: target + 2.5 * b },
  ];
}

/**
 * İbrenin hedefe göre kazandırdığı puan. Bant sınırı üstteki (yüksek) banda dahil.
 * Her cihaz bunu kendi başına çalıştırır; deterministik olması şart.
 */
export function scoreFor(target, dial) {
  const d = Math.abs(dial - target);
  // EPS: 50 + 0.5*3.2 gibi ifadeler kayan noktada 1.6000000000000014 verir;
  // bant sınırına tam oturan ibre epsilonsuz bir alt banda düşerdi.
  const EPS = 1e-9;
  if (d <= 0.5 * BAND + EPS) return 4;
  if (d <= 1.5 * BAND + EPS) return 3;
  if (d <= 2.5 * BAND + EPS) return 2;
  return 0;
}

/** 0-100 aralığına kırp. */
export function clampValue(v) {
  if (!Number.isFinite(v)) return 50;
  return Math.min(100, Math.max(0, v));
}

/** Oyun sonu değerlendirmesi. maxPoints = oynanan tur sayısı × 4. */
export function verdict(total, roundsPlayed) {
  const max = Math.max(1, roundsPlayed * 4);
  const ratio = total / max;
  if (ratio >= 0.9) return { ratio, title: 'Aynı frekanstasınız', note: 'Bu kadarı telepati sayılır.' };
  if (ratio >= 0.75) return { ratio, title: 'Çok iyi anlaşıyorsunuz', note: 'Birbirinizi fena okumuyorsunuz.' };
  if (ratio >= 0.55) return { ratio, title: 'Fena değil', note: 'Sinyal var ama parazit de var.' };
  if (ratio >= 0.35) return { ratio, title: 'Zayıf sinyal', note: 'Bazı turlarda tamamen kaybolmuşsunuz.' };
  return { ratio, title: 'Farklı frekanslardasınız', note: 'Birbirinizi hiç tanımıyorsunuz galiba.' };
}

/** Fisher-Yates. rng enjekte edilebilir. */
export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
