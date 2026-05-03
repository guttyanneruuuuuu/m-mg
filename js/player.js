// ===========================================================
// player.js — flier mesh + flight model + camera follow.
//   Aesthetic: sleek glider with glowing energy wings.
//   Physics: Newtonian-ish but tuned for arcade smoothness.
// ===========================================================

import * as THREE from 'three';
import { clamp, damp, lerp } from './utils.js';

export class Player {
  constructor(scene) {
    this.scene = scene;

    // ---------- root + visual mesh ----------
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this._buildShip();

    // ---------- flight state ----------
    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3(0, 0, 0);

    // orientation as Euler-ish angles we control directly
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;

    this.barrelRollAngle = 0;
    this.barrelRollDir = 0;

    // speeds
    this.cruiseSpeed = 70;
    this.maxSpeed    = 220;
    this.minSpeed    = 32;
    this.speed       = this.cruiseSpeed;
    this.boostFuel   = 1.0;   // 0..1 boost battery
    this.boostActive = false;

    // shields
    this.shields = 3;
    this.invuln  = 0;

    this.alive = true;

    // trails
    this._initTrails();
  }

  // -----------------------------------------------------------
  _buildShip() {
    const mat = (color, opts={}) => {
      const { emissive, emi, ...rest } = opts;
      return new THREE.MeshStandardMaterial({
        color, roughness: 0.35, metalness: 0.7,
        emissive: emissive ?? 0x000000,
        emissiveIntensity: emi ?? 0,
        ...rest
      });
    };

    // body — sleek capsule
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.6, 2.4, 12, 24),
      mat(0xeaf2ff, { roughness: 0.25, metalness: 0.9, emissive: 0x223355, emi: 0.15 })
    );
    body.rotation.x = Math.PI / 2;
    body.scale.set(1, 1, 1.4);
    this.root.add(body);

    // nose cone
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.55, 1.6, 18),
      mat(0x7df9ff, { emissive: 0x7df9ff, emi: 0.6, metalness: 0.4, roughness: 0.2 })
    );
    nose.position.z = -2.0;
    nose.rotation.x = -Math.PI / 2;
    this.root.add(nose);

    // cockpit dome
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 24, 16, 0, Math.PI*2, 0, Math.PI*0.55),
      new THREE.MeshPhysicalMaterial({
        color: 0x152040, roughness: 0.15, metalness: 0.1,
        transparent: true, opacity: 0.78,
        clearcoat: 1.0, clearcoatRoughness: 0.05,
        emissive: 0x1b3a8a, emissiveIntensity: 0.4
      })
    );
    dome.position.set(0, 0.45, -0.3);
    dome.scale.set(1.2, 0.7, 1.6);
    this.root.add(dome);

    // wings — swept
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0, 0);
    wingShape.lineTo(3.4, -0.8);
    wingShape.lineTo(3.0, -1.4);
    wingShape.lineTo(0.0, -0.4);
    wingShape.lineTo(0, 0);
    const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.18, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.04, bevelSegments: 2 });
    wingGeo.center();
    const wingMat = mat(0xb388ff, { emissive: 0xb388ff, emi: 0.35, roughness: 0.3, metalness: 0.6 });
    const wL = new THREE.Mesh(wingGeo, wingMat);
    wL.position.set(-1.4, -0.05, 0.4);
    wL.rotation.set(0, 0, 0.05);
    this.root.add(wL);
    const wR = wL.clone();
    wR.scale.x = -1;
    wR.position.x = 1.4;
    this.root.add(wR);

    // tail fin
    const fin = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.9, 1.0),
      mat(0x7df9ff, { emissive: 0x7df9ff, emi: 0.5 })
    );
    fin.position.set(0, 0.7, 1.4);
    this.root.add(fin);

    // glowing trim along body
    const trim = new THREE.Mesh(
      new THREE.TorusGeometry(0.7, 0.04, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0x7df9ff, transparent: true, opacity: 0.9 })
    );
    trim.rotation.x = Math.PI / 2;
    trim.position.z = 0.3;
    this.root.add(trim);

    // engine glow plates (back)
    const engineGlow = new THREE.Mesh(
      new THREE.CircleGeometry(0.45, 24),
      new THREE.MeshBasicMaterial({ color: 0x7df9ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    engineGlow.position.set(0, 0, 1.85);
    engineGlow.rotation.y = Math.PI;
    this.engineGlow = engineGlow;
    this.root.add(engineGlow);

    // outer halo (boost flare)
    this.boostHalo = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xff6ec7, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    this.boostHalo.position.set(0, 0, 2.4);
    this.root.add(this.boostHalo);

    // small light on the ship
    const pl = new THREE.PointLight(0x7df9ff, 1.4, 18, 2.0);
    pl.position.set(0, 0.4, 0);
    this.root.add(pl);
    this.shipLight = pl;
  }

  _initTrails() {
    // wingtip trails as line segments updated each frame
    const MAX = 80;
    this.trails = [];
    for (const offset of [new THREE.Vector3(-2.6, -0.1, 0.4), new THREE.Vector3(2.6, -0.1, 0.4)]) {
      const positions = new Float32Array(MAX * 3);
      const colors    = new Float32Array(MAX * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      this.scene.add(line);
      this.trails.push({ line, positions, colors, offset, history: [] , max: MAX });
    }
  }

  _updateTrails(dt) {
    for (const t of this.trails) {
      const wp = this.root.localToWorld(t.offset.clone());
      t.history.unshift(wp);
      if (t.history.length > t.max) t.history.length = t.max;
      const p = t.line.geometry.attributes.position.array;
      const c = t.line.geometry.attributes.color.array;
      for (let i = 0; i < t.max; i++) {
        const h = t.history[i] || t.history[t.history.length - 1] || wp;
        p[i*3+0] = h.x; p[i*3+1] = h.y; p[i*3+2] = h.z;
        const a = 1 - i / t.max;
        const boostMix = clamp((this.speed - this.cruiseSpeed) / (this.maxSpeed - this.cruiseSpeed), 0, 1);
        c[i*3+0] = lerp(0.49, 1.0, boostMix) * a;
        c[i*3+1] = lerp(0.97, 0.43, boostMix) * a;
        c[i*3+2] = lerp(1.0,  0.78, boostMix) * a;
      }
      t.line.geometry.attributes.position.needsUpdate = true;
      t.line.geometry.attributes.color.needsUpdate = true;
    }
  }

  // -----------------------------------------------------------
  // FLIGHT MODEL
  // -----------------------------------------------------------
  update(dt, input, time) {
    if (!this.alive) {
      // crash drift
      this.root.position.addScaledVector(this.vel, dt);
      this.vel.y -= 30 * dt;
      this.root.rotation.x += dt * 1.5;
      this.root.rotation.z += dt * 2.2;
      this._updateTrails(dt);
      return;
    }

    const v = input.value;

    // ---- target orientation (smooth) ----
    // pitch limited to avoid flipping
    const targetPitch = -v.pitch * 0.7;          // up = pitch up
    const targetRoll  = -v.roll  * 0.95;         // tilt = bank
    const targetYawRate = v.yaw * 0.9 + v.roll * 0.7; // banking turns

    this.pitch = damp(this.pitch, targetPitch, 5.5, dt);
    this.roll  = damp(this.roll,  targetRoll,  6.5, dt);
    this.yaw  += targetYawRate * dt * 0.8;
    // gently re-center yaw drift
    this.yaw = damp(this.yaw, this.yaw, 0.0, dt);

    // barrel roll
    const queued = input.consumeBarrel();
    if (queued !== 0 && Math.abs(this.barrelRollAngle) < 0.001) {
      this.barrelRollDir = queued;
      this.barrelRollAngle = 0.001 * queued;
    }
    if (Math.abs(this.barrelRollAngle) > 0) {
      const sp = 9.0 * this.barrelRollDir;
      this.barrelRollAngle += sp * dt;
      if (Math.abs(this.barrelRollAngle) >= Math.PI * 2) {
        this.barrelRollAngle = 0;
        this.barrelRollDir = 0;
      }
    }

    // ---- speed control ----
    const wantBoost = v.boost > 0.6 && this.boostFuel > 0.05;
    const wantBrake = v.brake > 0.5;
    this.boostActive = wantBoost;
    let target;
    if (wantBoost) target = this.maxSpeed;
    else if (wantBrake) target = this.minSpeed;
    else target = this.cruiseSpeed + (this.maxSpeed - this.cruiseSpeed) * 0.2; // slight cruise+

    // pitch affects natural speed (dive faster)
    target += -this.pitch * 22;

    this.speed = damp(this.speed, target, wantBoost ? 3.2 : 2.4, dt);
    this.speed = clamp(this.speed, this.minSpeed * 0.7, this.maxSpeed);

    // boost fuel
    if (wantBoost) this.boostFuel = clamp(this.boostFuel - dt * 0.35, 0, 1);
    else           this.boostFuel = clamp(this.boostFuel + dt * 0.18, 0, 1);

    // ---- compose forward direction from yaw/pitch ----
    const dir = new THREE.Vector3(0, 0, -1);
    const e = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
    dir.applyEuler(e);
    dir.normalize();

    // movement
    this.vel.copy(dir).multiplyScalar(this.speed);
    this.root.position.addScaledVector(this.vel, dt);

    // soft world bounds
    this.root.position.x = clamp(this.root.position.x, -110, 110);
    this.root.position.y = clamp(this.root.position.y, -55, 80);

    // assemble visual orientation
    const visEuler = new THREE.Euler(this.pitch, this.yaw, this.roll + this.barrelRollAngle, 'YXZ');
    this.root.quaternion.setFromEuler(visEuler);

    // engine glow scale by speed
    const sNorm = clamp((this.speed - this.minSpeed) / (this.maxSpeed - this.minSpeed), 0, 1);
    this.engineGlow.scale.setScalar(0.8 + sNorm * 1.6 + Math.sin(time * 30) * 0.05);
    this.engineGlow.material.opacity = 0.7 + sNorm * 0.3;
    this.boostHalo.material.opacity = wantBoost ? 0.6 + Math.sin(time * 25) * 0.12 : 0;
    this.boostHalo.scale.setScalar(0.9 + sNorm * 1.2);
    this.shipLight.intensity = 1.2 + sNorm * 1.6;

    // update trails
    this._updateTrails(dt);

    // invuln decay
    if (this.invuln > 0) this.invuln = Math.max(0, this.invuln - dt);

    // expose pos for outside
    this.pos.copy(this.root.position);
  }

  damage() {
    if (this.invuln > 0 || !this.alive) return false;
    this.shields = Math.max(0, this.shields - 1);
    this.invuln = 1.5;
    if (this.shields <= 0) {
      this.alive = false;
    }
    return true;
  }

  getForward() {
    const f = new THREE.Vector3(0, 0, -1);
    f.applyQuaternion(this.root.quaternion);
    return f;
  }
}
