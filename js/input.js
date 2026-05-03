// ===========================================================
// input.js — STARFORGE unified input system (v2)
//   - Easier hand control:
//     * Wider dead zones, gentler input curves, adaptive sensitivity
//     * Auto-fire toggle (hand: pinch can latch fire on/off)
//     * Steady fire while ANY of 3 detection modes triggers (combined)
//     * Calibration shortcut on simple gesture (open palm 1 sec)
//   - More reliable gesture detection w/ hysteresis (debouncing)
//   - Returns aimAssist info forwarded to bullets
// ===========================================================

import { clamp, damp, lerp, OneEuro, isMobile, supportsTouch, Storage } from './utils.js';

// gentler curve so small hand tilts move the ship clearly
const curve = (x, k = 1.4) => Math.sign(x) * Math.pow(Math.abs(x), k);

export const FIRE_GESTURES = {
  pinch:    { label: '🤏 ピンチ',    desc: '親指と人差指をくっつけて発射' },
  point:    { label: '☝️ ポイント',  desc: '人差指を伸ばすと自動連射' },
  thumbsup: { label: '👍 サムズアップ', desc: '親指を立てて発射' },
  fistHold: { label: '✊ 拳',         desc: '拳を握って発射 (ブースト無効)' },
  auto:     { label: '🤖 オート',    desc: '敵を捕捉中は自動連射 (簡単モード)' }
};

export class InputManager {
  constructor() {
    this.target = { roll: 0, pitch: 0, yaw: 0, boost: 0, brake: 0, fire: 0 };
    this.value  = { roll: 0, pitch: 0, yaw: 0, boost: 0, brake: 0, fire: 0 };
    this.action = false;
    this.mode   = 'keyboard';
    this.mouseSens = 1.0;
    this.handSens  = 1.2;
    this.touchSens = 1.0;
    this.mirror    = true;
    this.invertY   = false;
    this.tiltAssist = false;
    this.dampLambda = 12;
    this.lastBarrel = 0;
    this.barrelRoll = 0;

    // fire state
    this.fireGesture = (Storage.load().fireGesture) || 'pinch';
    this.fireDown = false;
    this.missilePulse = false;

    // === EASE features ===
    // simplified mode: applies extra dead zone & smoothing on hand input
    this.simplifiedMode = Storage.load().simplifiedMode !== false;  // default ON
    // auto-fire latch: a light tap can keep auto fire ON until tapped again
    this.autoFireLatch = Storage.load().autoFireLatch || false;
    this.autoFireOn = false;

    // gesture hysteresis state to avoid flicker
    this._fireOnState = false;
    this._fireOnT = 0;     // last toggle timestamp

    // calibration request via open palm hold
    this.openPalmHoldT = 0;
    this.calibrateRequested = false;

    // keyboard
    this.keys = new Set();
    this._installKeyboard();

    // mouse
    this._mouseX = 0; this._mouseY = 0;
    this._mouseDown = false;
    this._installMouse();

    // touch
    this.joy = { active: false, dx: 0, dy: 0, baseX: 0, baseY: 0, startX: 0, startY: 0 };
    this.touchBoost = 0;
    this.touchBrake = 0;
    this.touchFire  = 0;
    this.touchMissile = false;
    this._lastTapTime = 0;
    this._tapBoostUntil = 0;
    this._installTouch();

    // tilt
    this.tilt = { gamma: 0, beta: 0, calibG: null, calibB: null };
    this._installTilt();

    // hand
    this.hand = null;
    this._lastHandSeen = 0;
    this._handFreshness = 0;

    // target detection (for auto-fire and aim-assist hint)
    this.hasTarget = false;
    this.targetCenterness = 0;   // 0..1 (1 = aim is right on a target)

    if (supportsTouch() && isMobile()) this.mode = 'touch';
  }

  setMode(m){ this.mode = m; }
  setFireGesture(g) {
    if (FIRE_GESTURES[g]) {
      this.fireGesture = g;
      Storage.patch({ fireGesture: g });
    }
  }
  setSimplified(v) {
    this.simplifiedMode = !!v;
    Storage.patch({ simplifiedMode: this.simplifiedMode });
  }
  setAutoFireLatch(v) {
    this.autoFireLatch = !!v;
    Storage.patch({ autoFireLatch: this.autoFireLatch });
  }
  setTargetState(hasTarget, centerness) {
    this.hasTarget = !!hasTarget;
    this.targetCenterness = clamp(centerness || 0, 0, 1);
  }

  // ----------------- KEYBOARD -----------------
  _installKeyboard() {
    window.addEventListener('keydown', e => {
      this.keys.add(e.code);
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
      if (e.code === 'KeyM' || e.code === 'KeyX') this.missilePulse = true;
    }, { passive: false });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  _installMouse() {
    window.addEventListener('mousemove', e => {
      this._mouseX = (e.clientX / window.innerWidth) * 2 - 1;
      this._mouseY = (e.clientY / window.innerHeight) * 2 - 1;
    });
    window.addEventListener('mousedown', e => {
      if (e.button === 0) this._mouseDown = true;
      if (e.button === 2) this.missilePulse = true;
    });
    window.addEventListener('mouseup', e => {
      if (e.button === 0) this._mouseDown = false;
    });
    window.addEventListener('contextmenu', e => {
      if (this.mode === 'keyboard' || this.mode === 'hand') e.preventDefault();
    });
  }

  // ----------------- TOUCH JOYSTICK -----------------
  _installTouch() {
    const zone = document.getElementById('joyZone');
    const base = zone?.querySelector('.joystick-base');
    const knob = document.getElementById('joyKnob');
    const boostBtn = document.getElementById('btnBoost');
    const brakeBtn = document.getElementById('btnBrake');
    const fireBtn  = document.getElementById('btnFire');
    const missileBtn = document.getElementById('btnMissile');
    if (!zone) return;

    const MAX = 70;
    const setKnob = (dx, dy) => {
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      const len = Math.hypot(dx, dy) / MAX;
      knob.style.boxShadow = `0 0 ${18 + len * 18}px rgba(125,249,255,${0.7 + len * 0.3})`;
    };
    const resetKnob = () => {
      knob.style.transform = 'translate(-50%, -50%)';
      knob.style.boxShadow = '0 0 18px rgba(125,249,255,0.7)';
    };

    const start = (e) => {
      const t = e.touches ? e.touches[0] : e;
      const rect = zone.getBoundingClientRect();
      const localX = clamp(t.clientX - rect.left, 80, rect.width - 80);
      const localY = clamp(t.clientY - rect.top,  80, rect.height - 80);
      base.style.left = (localX - 75) + 'px';
      base.style.bottom = '';
      base.style.top  = (localY - 75) + 'px';
      base.style.opacity = '1';
      base.style.transform = 'scale(1.05)';
      const r2 = base.getBoundingClientRect();
      this.joy.baseX  = r2.left + r2.width / 2;
      this.joy.baseY  = r2.top  + r2.height / 2;
      this.joy.startX = t.clientX;
      this.joy.startY = t.clientY;
      this.joy.active = true;
      move(e);
    };
    const move = (e) => {
      if (!this.joy.active) return;
      const t = e.touches ? e.touches[0] : e;
      let dx = t.clientX - this.joy.baseX;
      let dy = t.clientY - this.joy.baseY;
      const len = Math.hypot(dx, dy);
      if (len > MAX) { dx = dx / len * MAX; dy = dy / len * MAX; }
      this.joy.dx = dx / MAX;
      this.joy.dy = dy / MAX;
      setKnob(dx, dy);
    };
    const end = () => {
      this.joy.active = false;
      this.joy.dx = 0; this.joy.dy = 0;
      base.style.left = '30px'; base.style.top = ''; base.style.bottom = '30px';
      base.style.transform = 'scale(1)';
      base.style.opacity = '0.85';
      resetKnob();
    };

    zone.addEventListener('touchstart', e => {
      e.preventDefault();
      const now = performance.now();
      if (now - this._lastTapTime < 280) {
        this._tapBoostUntil = now + 700;
      }
      this._lastTapTime = now;
      start(e);
    }, { passive: false });
    zone.addEventListener('touchmove',  e => { e.preventDefault(); move(e); },  { passive: false });
    zone.addEventListener('touchend',   e => { e.preventDefault(); end();   },  { passive: false });
    zone.addEventListener('touchcancel',e => { e.preventDefault(); end();   },  { passive: false });
    zone.addEventListener('mousedown', e => {
      start(e);
      const onMove = ev => move(ev);
      const onUp = () => { end(); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    const press = (el, on, off) => {
      el.addEventListener('touchstart', e => { e.preventDefault(); on(); el.classList.add('active'); }, { passive:false });
      el.addEventListener('touchend',   e => { e.preventDefault(); off(); el.classList.remove('active'); }, { passive:false });
      el.addEventListener('touchcancel',e => { e.preventDefault(); off(); el.classList.remove('active'); }, { passive:false });
      el.addEventListener('mousedown', () => { on(); el.classList.add('active'); });
      el.addEventListener('mouseup',   () => { off(); el.classList.remove('active'); });
      el.addEventListener('mouseleave',() => { off(); el.classList.remove('active'); });
    };
    if (boostBtn) press(boostBtn, () => { this.touchBoost = 1; }, () => this.touchBoost = 0);
    if (brakeBtn) press(brakeBtn, () => { this.touchBrake = 1; }, () => this.touchBrake = 0);
    if (fireBtn)  press(fireBtn,  () => { this.touchFire  = 1; }, () => this.touchFire  = 0);
    if (missileBtn) {
      missileBtn.addEventListener('touchstart', e => {
        e.preventDefault();
        this.touchMissile = true;
        this.missilePulse = true;
        missileBtn.classList.add('active');
      }, { passive: false });
      missileBtn.addEventListener('touchend', e => {
        e.preventDefault();
        this.touchMissile = false;
        missileBtn.classList.remove('active');
      }, { passive: false });
      missileBtn.addEventListener('click', () => {
        this.missilePulse = true;
      });
    }
  }

  _installTilt() {
    const handler = (e) => {
      if (e.gamma == null || e.beta == null) return;
      if (this.tilt.calibG == null) { this.tilt.calibG = e.gamma; this.tilt.calibB = e.beta; }
      this.tilt.gamma = lerp(this.tilt.gamma, e.gamma - this.tilt.calibG, 0.18);
      this.tilt.beta  = lerp(this.tilt.beta,  e.beta  - this.tilt.calibB, 0.18);
    };
    window.addEventListener('deviceorientation', handler, true);
  }

  async requestTiltPermission() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        return r === 'granted';
      }
    } catch {}
    return true;
  }

  feedHand(state) {
    this.hand = state;
    if (state && state.present) this._lastHandSeen = performance.now();
  }

  isHandFresh() {
    return this.hand && (performance.now() - this._lastHandSeen) < 280;
  }

  consumeCalibrate() {
    const v = this.calibrateRequested;
    this.calibrateRequested = false;
    return v;
  }

  // ----------------- UPDATE -----------------
  update(dt) {
    let r = 0, p = 0, y = 0, boost = 0, brake = 0, fire = 0;

    // ---------- HAND ----------
    if (this.mode === 'hand' && this.isHandFresh()) {
      const h = this.hand;
      // adaptive sens: tighter when not centered (stops drift)
      const k = this.handSens;
      this._handFreshness = lerp(this._handFreshness, 1, 0.18);

      // SIMPLIFIED dead-zones make centering easy
      const dz = this.simplifiedMode ? 0.10 : 0.06;
      const dzApply = (v) => Math.abs(v) < dz ? 0 : Math.sign(v) * (Math.abs(v) - dz) / (1 - dz);
      let rRaw = dzApply(h.roll);
      let pRaw = dzApply(h.pitch);
      let yRaw = dzApply(h.yaw);

      // gentler curve in simplified mode (k=1.2), stronger in expert (k=1.5)
      const ck = this.simplifiedMode ? 1.20 : 1.45;

      r = clamp(curve(rRaw, ck) * 1.5 * k, -1, 1);
      p = clamp(curve(pRaw, ck) * 1.6 * k, -1, 1);
      y = clamp(curve(yRaw, ck) * 1.3 * k, -1, 1);
      if (this.mirror) y = -y;
      if (this.invertY) p = -p;

      if (this.fireGesture !== 'fistHold') {
        boost = clamp((h.fistness - 0.55) * 2.5, 0, 1);
      }
      brake = clamp((h.openness - 0.78) * 3.2, 0, 1);

      // ===== FIRE: combined detection w/ hysteresis =====
      let fireRaw = 0;
      const fg = this.fireGesture;
      if (fg === 'auto') {
        // auto: shoot when any reasonable gesture or centered target
        const anyGesture =
          (h.pinchDist != null && h.pinchDist < 0.55) ||
          (h.pointing > 0.55) ||
          (h.thumbsUp > 0.6);
        // Or simply: target centered enough
        if (anyGesture || this.targetCenterness > 0.55) fireRaw = 1;
      } else if (fg === 'pinch') {
        // smoother pinch: use hysteresis (open at >0.55, close at <0.45)
        if (this._fireOnState) fireRaw = (h.pinchDist < 0.55) ? 1 : 0;
        else fireRaw = (h.pinchDist < 0.42) ? 1 : 0;
      } else if (fg === 'point') {
        fireRaw = (this._fireOnState ? (h.pointing > 0.45 ? 1 : 0) : (h.pointing > 0.62 ? 1 : 0));
      } else if (fg === 'thumbsup') {
        fireRaw = (this._fireOnState ? (h.thumbsUp > 0.45 ? 1 : 0) : (h.thumbsUp > 0.6 ? 1 : 0));
      } else if (fg === 'fistHold') {
        fireRaw = (this._fireOnState ? (h.fistness > 0.55 ? 1 : 0) : (h.fistness > 0.7 ? 1 : 0));
      }
      // debounce — minimum 80ms hold to flip
      const now = performance.now();
      if (fireRaw !== (this._fireOnState ? 1 : 0)) {
        if (now - this._fireOnT > 60) {
          this._fireOnState = !!fireRaw;
          this._fireOnT = now;
        }
      } else {
        this._fireOnT = now;
      }
      fire = this._fireOnState ? 1 : 0;

      // auto-fire latch — pinch tap toggles latched auto-fire
      if (this.autoFireLatch && fg === 'pinch') {
        if (this._lastFireOn !== this._fireOnState) {
          if (this._fireOnState) {
            this._latchToggleStart = now;
          } else if (now - (this._latchToggleStart || 0) < 220) {
            // short tap toggles latch
            this.autoFireOn = !this.autoFireOn;
          }
        }
        this._lastFireOn = this._fireOnState;
        if (this.autoFireOn) fire = 1;
      } else {
        this.autoFireOn = false;
      }

      // ===== Open palm hold (>1s) -> calibrate request =====
      if (h.openness > 0.85 && Math.abs(h.roll) < 0.20 && Math.abs(h.pitch) < 0.20) {
        this.openPalmHoldT += dt;
        if (this.openPalmHoldT > 1.0) {
          this.calibrateRequested = true;
          this.openPalmHoldT = -2.0;   // cooldown
        }
      } else {
        this.openPalmHoldT = Math.max(0, this.openPalmHoldT - dt * 0.5);
      }
    } else if (this.mode === 'hand') {
      this._handFreshness = lerp(this._handFreshness, 0, 0.08);
    }

    // ---------- KEYBOARD ----------
    let keyboardActive = false;
    if (this.keys.size) {
      keyboardActive = true;
      let kr = 0, kp = 0, ky = 0;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft'))  kr = -1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) kr =  1;
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp'))    kp = -1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown'))  kp =  1;
      if (this.keys.has('KeyQ')) ky = -1;
      if (this.keys.has('KeyE')) ky =  1;
      if (kr) r = kr;
      if (kp) p = kp;
      if (ky) y = ky;
      if (this.keys.has('Space') || this.keys.has('ShiftLeft')) boost = 1;
      if (this.keys.has('KeyC') || this.keys.has('ControlLeft')) brake = 1;
      if (this.keys.has('KeyJ') || this.keys.has('KeyZ') || this.keys.has('Enter')) fire = 1;
    } else if (this.mode === 'keyboard' && !keyboardActive) {
      r = clamp(this._mouseX * this.mouseSens, -1, 1);
      p = clamp(this._mouseY * this.mouseSens, -1, 1);
    }
    if (this._mouseDown) fire = 1;

    // ---------- TOUCH ----------
    if (this.mode === 'touch') {
      const jx = this.joy.dx;
      const jy = this.joy.dy;
      r = clamp(curve(jx, 1.3) * 1.15 * this.touchSens, -1, 1);
      p = clamp(curve(jy, 1.3) * 1.15 * this.touchSens, -1, 1);
      boost = Math.max(boost, this.touchBoost);
      brake = Math.max(brake, this.touchBrake);
      fire  = Math.max(fire,  this.touchFire);

      if (performance.now() < this._tapBoostUntil) {
        boost = Math.max(boost, 1.0);
      }

      if (this.tiltAssist && this.tilt.calibG != null) {
        const tiltR = clamp(this.tilt.gamma / 35, -0.6, 0.6);
        const tiltP = clamp(this.tilt.beta  / 35, -0.6, 0.6);
        r = clamp(r + tiltR * 0.45, -1, 1);
        p = clamp(p + tiltP * 0.4, -1, 1);
      }

      if (Math.abs(jx) < 0.04 && Math.abs(jy) < 0.04) {
        r *= 0.0; p *= 0.0;
      }
    }

    this.target.roll  = r;
    this.target.pitch = p;
    this.target.yaw   = y;
    this.target.boost = boost;
    this.target.brake = brake;
    this.target.fire  = fire;

    // smoother damping when in simplified mode
    const lambda = this.simplifiedMode ? this.dampLambda * 0.85 : this.dampLambda;
    const stickL = (cur, tgt, fastL, slowL) => {
      const same = Math.sign(cur) === Math.sign(tgt) || tgt === 0;
      return same ? fastL : slowL;
    };
    this.value.roll  = damp(this.value.roll,  this.target.roll,  stickL(this.value.roll,  this.target.roll,  lambda, lambda * 0.55), dt);
    this.value.pitch = damp(this.value.pitch, this.target.pitch, stickL(this.value.pitch, this.target.pitch, lambda, lambda * 0.55), dt);
    this.value.yaw   = damp(this.value.yaw,   this.target.yaw,   lambda * 0.65, dt);
    this.value.boost = damp(this.value.boost, this.target.boost, 18, dt);
    this.value.brake = damp(this.value.brake, this.target.brake, 18, dt);
    this.value.fire  = damp(this.value.fire,  this.target.fire,  22, dt);

    const now2 = performance.now() / 1000;
    if (this.target.boost > 0.85 && Math.abs(this.target.roll) > 0.75 && now2 - this.lastBarrel > 1.2) {
      this.lastBarrel = now2;
      this.barrelRoll = Math.sign(this.target.roll);
    }
  }

  consumeBarrel() {
    const v = this.barrelRoll;
    this.barrelRoll = 0;
    return v;
  }

  consumeMissile() {
    const v = this.missilePulse;
    this.missilePulse = false;
    return v;
  }

  isFiring() {
    return this.value.fire > 0.55 || this.target.fire > 0.55;
  }
}
