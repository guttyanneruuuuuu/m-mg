// ===========================================================
// input.js — unified input system
//   - Keyboard (PC)
//   - Mouse (PC)
//   - Touch joystick (Mobile)
//   - Hand tracking (MediaPipe)
//
//  Outputs a normalized control vector each frame:
//    { roll: -1..1, pitch: -1..1, yaw: -1..1, boost: 0..1, brake: 0..1, action: bool }
// ===========================================================

import { clamp, damp, OneEuro, Smoother, isMobile, supportsTouch } from './utils.js';

export class InputManager {
  constructor() {
    this.target = { roll: 0, pitch: 0, yaw: 0, boost: 0, brake: 0 };
    this.value  = { roll: 0, pitch: 0, yaw: 0, boost: 0, brake: 0 };
    this.action = false;
    this.mode   = 'keyboard'; // keyboard | touch | hand
    this.mouseSens = 1.0;
    this.handSens  = 1.2;
    this.mirror    = true;
    this.dampLambda = 9; // lower = smoother / more inertia, higher = snappier
    this.lastBarrel = 0;
    this.barrelRoll = 0;

    // keyboard state
    this.keys = new Set();
    this._installKeyboard();

    // mouse pointer
    this._mouseX = 0; this._mouseY = 0;
    this._installMouse();

    // touch
    this.joy = { active: false, dx: 0, dy: 0, baseX: 0, baseY: 0 };
    this.touchBoost = 0;
    this.touchBrake = 0;
    this._installTouch();

    // hand
    this.hand = null;       // current smoothed hand state
    this._lastHandSeen = 0;

    // detect default mode
    if (supportsTouch() && isMobile()) this.mode = 'touch';
  }

  setMode(m){ this.mode = m; }

  // ----------------- KEYBOARD -----------------
  _installKeyboard() {
    window.addEventListener('keydown', e => {
      this.keys.add(e.code);
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
    }, { passive: false });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // ----------------- MOUSE -----------------
  _installMouse() {
    window.addEventListener('mousemove', e => {
      this._mouseX = (e.clientX / window.innerWidth) * 2 - 1;
      this._mouseY = (e.clientY / window.innerHeight) * 2 - 1;
    });
  }

  // ----------------- TOUCH JOYSTICK -----------------
  _installTouch() {
    const zone = document.getElementById('joyZone');
    const base = zone?.querySelector('.joystick-base');
    const knob = document.getElementById('joyKnob');
    const boostBtn = document.getElementById('btnBoost');
    const brakeBtn = document.getElementById('btnBrake');
    if (!zone) return;

    const max = 56;

    const setKnob = (dx, dy) => {
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    };
    const resetKnob = () => setKnob(0, 0);

    const start = (e) => {
      const t = e.touches ? e.touches[0] : e;
      const r = base.getBoundingClientRect();
      this.joy.baseX = r.left + r.width / 2;
      this.joy.baseY = r.top + r.height / 2;
      // snap base near touch (relative joystick)
      const rect = zone.getBoundingClientRect();
      const localX = clamp(t.clientX - rect.left, 70, rect.width - 70);
      const localY = clamp(t.clientY - rect.top,  70, rect.height - 70);
      base.style.left = (localX - 65) + 'px';
      base.style.bottom = '';
      base.style.top  = (localY - 65) + 'px';
      const r2 = base.getBoundingClientRect();
      this.joy.baseX = r2.left + r2.width / 2;
      this.joy.baseY = r2.top + r2.height / 2;
      this.joy.active = true;
      move(e);
    };
    const move = (e) => {
      if (!this.joy.active) return;
      const t = e.touches ? e.touches[0] : e;
      let dx = t.clientX - this.joy.baseX;
      let dy = t.clientY - this.joy.baseY;
      const len = Math.hypot(dx, dy);
      if (len > max) { dx = dx / len * max; dy = dy / len * max; }
      this.joy.dx = dx / max;
      this.joy.dy = dy / max;
      setKnob(dx, dy);
    };
    const end = () => {
      this.joy.active = false;
      this.joy.dx = 0; this.joy.dy = 0;
      // restore base position to default (CSS)
      base.style.left = '30px'; base.style.top = ''; base.style.bottom = '30px';
      resetKnob();
    };

    zone.addEventListener('touchstart', e => { e.preventDefault(); start(e); }, { passive: false });
    zone.addEventListener('touchmove',  e => { e.preventDefault(); move(e); },  { passive: false });
    zone.addEventListener('touchend',   e => { e.preventDefault(); end();   },  { passive: false });
    zone.addEventListener('touchcancel',e => { e.preventDefault(); end();   },  { passive: false });
    // also support mouse for testing
    zone.addEventListener('mousedown', e => { start(e); document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); });
    const up = () => { end(); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };

    // boost / brake buttons
    const press = (el, on, off) => {
      el.addEventListener('touchstart', e => { e.preventDefault(); on(); }, { passive:false });
      el.addEventListener('touchend',   e => { e.preventDefault(); off(); }, { passive:false });
      el.addEventListener('touchcancel',e => { e.preventDefault(); off(); }, { passive:false });
      el.addEventListener('mousedown', () => on());
      el.addEventListener('mouseup',   () => off());
      el.addEventListener('mouseleave',() => off());
    };
    if (boostBtn) press(boostBtn, () => this.touchBoost = 1, () => this.touchBoost = 0);
    if (brakeBtn) press(brakeBtn, () => this.touchBrake = 1, () => this.touchBrake = 0);
  }

  // ----------------- HAND TRACKING (called from hand.js) -----------------
  feedHand(state) {
    // state: { roll, pitch, yaw, fistness, openness, present, score, time }
    this.hand = state;
    if (state && state.present) this._lastHandSeen = performance.now();
  }

  isHandFresh() {
    return this.hand && (performance.now() - this._lastHandSeen) < 350;
  }

  // ----------------- UPDATE -----------------
  update(dt) {
    // 1) compute desired targets per mode
    let r = 0, p = 0, y = 0, boost = 0, brake = 0;

    if (this.mode === 'hand' && this.isHandFresh()) {
      const h = this.hand;
      const k = this.handSens;
      // roll: tilt of hand
      r = clamp(h.roll * 1.4 * k, -1, 1);
      // pitch: vertical position of palm
      p = clamp(h.pitch * 1.5 * k, -1, 1);
      // yaw: horizontal palm position
      y = clamp(h.yaw * 1.2 * k, -1, 1);
      if (this.mirror) y = -y; // mirror selfie
      // boost: closed fist
      boost = clamp((h.fistness - 0.55) * 2.6, 0, 1);
      // brake: very open hand
      brake = clamp((h.openness - 0.85) * 3.0, 0, 1);
    }

    // keyboard / mouse fallback (always combinable)
    if (this.keys.size) {
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft'))  r = -1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) r =  1;
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp'))    p = -1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown'))  p =  1;
      if (this.keys.has('KeyQ')) y = -1;
      if (this.keys.has('KeyE')) y =  1;
      if (this.keys.has('Space') || this.keys.has('ShiftLeft')) boost = 1;
      if (this.keys.has('KeyC') || this.keys.has('ControlLeft'))brake = 1;
    } else if (this.mode === 'keyboard') {
      // mouse-aim fallback
      r = clamp(this._mouseX * this.mouseSens, -1, 1);
      p = clamp(this._mouseY * this.mouseSens, -1, 1);
    }

    if (this.mode === 'touch') {
      r = clamp(this.joy.dx * 1.1, -1, 1);
      p = clamp(this.joy.dy * 1.1, -1, 1);
      boost = Math.max(boost, this.touchBoost);
      brake = Math.max(brake, this.touchBrake);
    }

    // 2) write targets, smoothly approach values
    this.target.roll  = r;
    this.target.pitch = p;
    this.target.yaw   = y;
    this.target.boost = boost;
    this.target.brake = brake;

    const lambda = this.dampLambda;
    this.value.roll  = damp(this.value.roll,  this.target.roll,  lambda, dt);
    this.value.pitch = damp(this.value.pitch, this.target.pitch, lambda, dt);
    this.value.yaw   = damp(this.value.yaw,   this.target.yaw,   lambda * 0.7, dt);
    this.value.boost = damp(this.value.boost, this.target.boost, 16, dt);
    this.value.brake = damp(this.value.brake, this.target.brake, 16, dt);

    // 3) barrel roll trigger from rapid fist + roll input
    const now = performance.now() / 1000;
    if (this.target.boost > 0.85 && Math.abs(this.target.roll) > 0.7 && now - this.lastBarrel > 1.4) {
      this.lastBarrel = now;
      this.barrelRoll = Math.sign(this.target.roll); // queue a barrel
    }
  }

  consumeBarrel() {
    const v = this.barrelRoll;
    this.barrelRoll = 0;
    return v;
  }
}
