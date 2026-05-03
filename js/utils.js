// ===========================================================
// utils.js — small helpers, math, smoothing, signals
// ===========================================================

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp  = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, t) => {
  t = clamp((t - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const choose = (arr) => arr[Math.floor(Math.random() * arr.length)];

// One-Euro filter — produces buttery-smooth tracking signals.
// Used to smooth raw mediapipe landmark positions.
export class OneEuro {
  constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
    this.t = null;
  }
  alpha(rate, cutoff) {
    const r = 2 * Math.PI * cutoff / rate;
    return r / (r + 1);
  }
  filter(x, t) {
    if (this.t === null) { this.t = t; this.x = x; return x; }
    const dt = Math.max(1 / 240, (t - this.t));
    const rate = 1 / dt;
    const dx = (x - this.x) / dt;
    const aD = this.alpha(rate, this.dCutoff);
    this.dx = aD * dx + (1 - aD) * this.dx;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = this.alpha(rate, cutoff);
    this.x = a * x + (1 - a) * this.x;
    this.t = t;
    return this.x;
  }
  reset() { this.x = null; this.dx = 0; this.t = null; }
}

export class Smoother {
  constructor(initial = 0, lambda = 8) { this.v = initial; this.lambda = lambda; }
  to(target, dt) { this.v = damp(this.v, target, this.lambda, dt); return this.v; }
  set(v) { this.v = v; return v; }
  get() { return this.v; }
}

// micro signal/event bus
export class Signal {
  constructor(){ this.subs = new Set(); }
  on(fn){ this.subs.add(fn); return () => this.subs.delete(fn); }
  emit(...a){ for (const fn of this.subs) fn(...a); }
}

export const isMobile = () =>
  /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints && navigator.maxTouchPoints > 1 && window.matchMedia('(pointer:coarse)').matches);

export const supportsTouch = () =>
  ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

// Persisted settings/state
const KEY = 'skyrift::v1';
export const Storage = {
  load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); }
    catch { return {}; }
  },
  save(obj) {
    try { localStorage.setItem(KEY, JSON.stringify(obj)); } catch {}
  },
  patch(partial) {
    const cur = Storage.load();
    const next = { ...cur, ...partial };
    Storage.save(next);
    return next;
  }
};
