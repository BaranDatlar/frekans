// Yarım daire kadran: SVG çizimi + dokunma/fare ile sürükleme.
// Firebase'den haberi yok; sadece değer alır, değer bildirir.

import { bandsFor, clampValue } from './scoring.js';

const CX = 200, CY = 200;
const R_OUT = 190, R_IN = 112;   // ana yay
const R_BAND_OUT = 190, R_BAND_IN = 112;

/** value (0-100) -> radyan (0 = sağ, PI = sol) */
function theta(v) { return Math.PI * (1 - v / 100); }

/** value + yarıçap -> [x, y] */
function pt(v, rad) {
  const t = theta(v);
  return [CX + rad * Math.cos(t), CY - rad * Math.sin(t)];
}

/** a'dan b'ye (a < b) halka dilimi yolu */
function sectorPath(a, b, ro, ri) {
  const [x1, y1] = pt(a, ro);
  const [x2, y2] = pt(b, ro);
  const [x3, y3] = pt(b, ri);
  const [x4, y4] = pt(a, ri);
  // dış yay soldan sağa = ekranda saat yönü (sweep 1), iç yay geri dönüş (sweep 0)
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${ro} ${ro} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)} ` +
         `L${x3.toFixed(2)} ${y3.toFixed(2)} A${ri} ${ri} 0 0 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const BAND_FILL = { 4: 'var(--p4)', 3: 'var(--p3)', 2: 'var(--p2)' };

export class Dial {
  /**
   * @param {HTMLElement} root
   * @param {{onInput?:(v:number)=>void, onCommit?:(v:number)=>void}} handlers
   */
  constructor(root, { onInput, onCommit } = {}) {
    this.root = root;
    this.onInput = onInput || (() => {});
    this.onCommit = onCommit || (() => {});
    this.value = 50;
    this.interactive = false;
    /** Kendi parmağımız kadranın üstündeyken uzaktan gelen değeri yok sayarız —
     *  yoksa ibre elimizin altından geri zıplar. */
    this.dragging = false;
    this._build();
  }

  _build() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 400 214');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Tahmin kadranı');

    svg.innerHTML = `
      <defs>
        <linearGradient id="dialGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stop-color="#2b3a55"/>
          <stop offset="100%" stop-color="#4a3c2e"/>
        </linearGradient>
      </defs>
      <path d="${sectorPath(0, 100, R_OUT, R_IN)}" fill="url(#dialGrad)"/>
      <g class="bands"></g>
      <g class="ticks"></g>
      <path d="${sectorPath(0, 100, R_OUT, R_IN)}" fill="none" stroke="#2a3242" stroke-width="2"/>
      <g class="needle">
        <line x1="${CX}" y1="${CY}" x2="${CX}" y2="${CY - R_OUT + 4}"
              stroke="#e7ecf3" stroke-width="4" stroke-linecap="round"/>
        <circle cx="${CX}" cy="${CY}" r="13" fill="#e7ecf3"/>
        <circle cx="${CX}" cy="${CY}" r="6" fill="#0d1117"/>
      </g>
    `;

    // ondalık çizgiler
    const ticks = svg.querySelector('.ticks');
    for (let v = 0; v <= 100; v += 10) {
      const [x1, y1] = pt(v, R_IN + 4);
      const [x2, y2] = pt(v, R_IN + (v % 50 === 0 ? 16 : 10));
      const ln = document.createElementNS(SVG_NS, 'line');
      ln.setAttribute('x1', x1.toFixed(2)); ln.setAttribute('y1', y1.toFixed(2));
      ln.setAttribute('x2', x2.toFixed(2)); ln.setAttribute('y2', y2.toFixed(2));
      ln.setAttribute('stroke', '#3c465c');
      ln.setAttribute('stroke-width', v % 50 === 0 ? 3 : 2);
      ticks.appendChild(ln);
    }

    this.svg = svg;
    this.bandsGroup = svg.querySelector('.bands');
    this.needle = svg.querySelector('.needle');
    this.root.appendChild(svg);

    svg.addEventListener('pointerdown', (e) => this._down(e));
    svg.addEventListener('pointermove', (e) => this._move(e));
    svg.addEventListener('pointerup', (e) => this._up(e));
    svg.addEventListener('pointercancel', (e) => this._up(e));

    this.setValue(50, { animate: false });
  }

  /** Ekran koordinatını viewBox koordinatına çevirip değere dönüştürür. */
  _valueFromEvent(e) {
    const ctm = this.svg.getScreenCTM();
    if (!ctm) return this.value;
    const p = this.svg.createSVGPoint();
    p.x = e.clientX; p.y = e.clientY;
    const { x, y } = p.matrixTransform(ctm.inverse());
    const dx = x - CX;
    const dy = CY - y;               // yukarı pozitif
    if (dy <= 0) return dx >= 0 ? 100 : 0;   // yarım dairenin altı: en yakın uca kırp
    const t = Math.atan2(dy, dx);            // 0..PI
    return clampValue((1 - t / Math.PI) * 100);
  }

  _down(e) {
    if (!this.interactive) return;
    this.dragging = true;
    this.svg.setPointerCapture(e.pointerId);
    const v = this._valueFromEvent(e);
    this.setValue(v, { animate: false });
    this.onInput(v);
  }

  _move(e) {
    if (!this.dragging) return;
    e.preventDefault();
    const v = this._valueFromEvent(e);
    this.setValue(v, { animate: false });
    this.onInput(v);
  }

  _up(e) {
    if (!this.dragging) return;
    this.dragging = false;
    try { this.svg.releasePointerCapture(e.pointerId); } catch { /* zaten bırakılmış */ }
    this.onCommit(this.value);
  }

  /** @param {boolean} on kadran sürüklenebilir mi */
  setInteractive(on) {
    this.interactive = on;
    this.root.classList.toggle('interactive', on);
    if (!on) this.dragging = false;
  }

  /** Uzaktan gelen güncelleme için: sürükleme sırasında yok sayılır. */
  setRemoteValue(v) {
    if (this.dragging) return;
    this.setValue(v, { animate: true });
  }

  setValue(v, { animate = true } = {}) {
    this.value = clampValue(v);
    this.needle.classList.toggle('smooth', animate);
    this.needle.style.transform = `rotate(${((this.value - 50) * 1.8).toFixed(2)}deg)`;
  }

  /** target null ise bantlar gizlenir, değilse 2-3-4-3-2 bandı çizilir. */
  setTarget(target) {
    this.bandsGroup.innerHTML = '';
    if (target == null || !Number.isFinite(target)) {
      this.bandsGroup.classList.remove('shown');
      return;
    }
    for (const b of bandsFor(target)) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', sectorPath(
        clampValue(b.from), clampValue(b.to), R_BAND_OUT, R_BAND_IN));
      path.setAttribute('fill', BAND_FILL[b.points]);
      path.setAttribute('class', 'band');
      this.bandsGroup.appendChild(path);
    }
    // görünürlüğü bir sonraki frame'de aç ki CSS geçişi tetiklensin
    requestAnimationFrame(() => this.bandsGroup.classList.add('shown'));
  }
}
