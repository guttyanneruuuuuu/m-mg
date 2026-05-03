// ===========================================================
// player.js — flier mesh + flight model + camera follow.   (v2)
//   Aesthetic: sleek glider with glowing energy wings.
//   Physics: Newtonian-ish with proper banking, inertia, and
//            auto-orient-to-velocity feel for arcade smoothness.
// ===========================================================

import * as THREE from 'three';
import { clamp, damp, lerp } from './utils.js';

export class Player {
  constructor(scene) {
    this.scene = scene;

    // ---------- root + visual mesh ----------
    this.root = new THREE.Group();   // worldspace transform
    this.scene.add(this.root);
    this.mesh = new THREE.Group();   // visual-only tilt (separate so collisions etc are clean)
    this.root.add(this.mesh);
    this._buildShip();

    // ---------- flight state ----------
    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3(0, 0, 0);

    // We control orientation via yaw/pitch on the root, and visual roll on .mesh
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;

    // angular velocities (smooth rate accumulators)
    this.yawRate = 0;
    this.pitchRate = 0;
    this.rollVisual = 0;

    this.barrelRollAngle = 0;
    this.barrelRollDir = 0;

    // speeds
    this.cruiseSpeed = 78;
    this.maxSpeed    = 240;
    this.minSpeed    = 36;
    this.speed       = this.cruiseSpeed;
    this.boostFuel   = 1.0;
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
      mat(0xeaf2ff, { roughness: 0.22, metalness: 0.92, emissive: 0x223355, emi: 0.18 })
    );
    body.rotation.x = Math.PI / 2;
    body.scale.set(1, 1, 1.4);
    this.mesh.add(body);

    // nose cone
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.55, 1.8, 18),
      mat(0x7df9ff, { emissive: 0x7df9ff, emi: 0.7, metalness: 0.4, roughness: 0.18 })
    );
    nose.position.z = -2.0;
    nose.rotation.x = -Math.PI / 2;
    this.mesh.add(nose);

    // cockpit dome
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 24, 16, 0, Math.PI*2, 0, Math.PI*0.55),
      new THREE.MeshPhysicalMaterial({
        color: 0x152040, roughness: 0.10, metalness: 0.1,
        transparent: true, opacity: 0.78,
        clearcoat: 1.0, clearcoatRoughness: 0.04,
        emissive: 0x1b3a8a, emissiveIntensity: 0.5
      })
    );
    dome.position.set(0, 0.45, -0.3);
    dome.scale.set(1.2, 0.7, 1.6);
    this.mesh.add(dome);

    // wings — swept
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0, 0);
    wingShape.lineTo(3.4, -0.8);
    wingShape.lineTo(3.0, -1.4);
    wingShape.lineTo(0.0, -0.4);
    wingShape.lineTo(0, 0);
    const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.18, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.04, bevelSegments: 2 });
    wingGeo.center();
    const wingMat = mat(0xb388ff, { emissive: 0xb388ff, emi: 0.4, roughness: 0.28, metalness: 0.6 });
    const wL = new THREE.Mesh(wingGeo, wingMat);
    wL.position.set(-1.4, -0.05, 0.4);
    wL.rotation.set(0, 0, 0.05);
    this.mesh.add(wL);
    const wR = wL.clone();
    wR.scale.x = -1;
    wR.position.x = 1.4;
    this.mesh.add(wR);

    // wing edge glow stripes
    const stripeMat = new THREE.MeshBasicMaterial({ color: 0x7df9ff, transparent: true, opacity: 0.95 });
    for (const s of [-1, 1]) {
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(2.4, 0.04, 0.08),
        stripeMat
      );
      stripe.position.set(s * 1.7, -0.05, 0.0);
      stripe.rotation.z = -s * 0.18;
      this.mesh.add(stripe);
    }

    // tail fin
    const fin = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.9, 1.0),
      mat(0x7df9ff, { emissive: 0x7df9ff, emi: 0.6 })
    );
    fin.position.set(0, 0.7, 1.4);
    this.mesh.add(fin);

    // glowing trim
    const trim = new THREE.Mesh(
      new THREE.TorusGeometry(0.7, 0.04, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0x7df9ff, transparent: true, opacity: 0.9 })
    );
    trim.rotation.x = Math.PI / 2;
    trim.position.z = 0.3;
    this.mesh.add(trim);

    // engine glow plates (back)
    const engineGlow = new THREE.Mesh(
      new THREE.CircleGeometry(0.5, 24),
      new THREE.MeshBasicMaterial({ color: 0x7df9ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    engineGlow.position.set(0, 0, 1.85);
    engineGlow.rotation.y = Math.PI;
    this.engineGlow = engineGlow;
    this.mesh.add(engineGlow);

    // outer halo (boost flare)
    this.boostHalo = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xff6ec7, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    this.boostHalo.position.set(0, 0, 2.4);
    this.mesh.add(this.boostHalo);

    // small light on the ship
    const pl = new THREE.PointLight(0x7df9ff, 1.6, 22, 2.0);
    pl.position.set(0, 0.4, 0);
    this.mesh.add(pl);
    this.shipLight = pl;
  }

  _initTrails() {
    const MAX = 100;
    this.trails = [];
    for (const offset of [new THREE.Vector3(-2.6, -0.1, 0.4), new THREE.Vector3(2.6, -0.1, 0.4)]) {
      const positions = new Float32Array(MAX * 3);
      const colors    = new Float32Array(MAX * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      this.scene.add(line);
      this.trails.push({ line, positions, colors, offset, history: [], max: MAX });
    }
  }

  _updateTrails(dt) {
    for (const t of this.trails) {
      const wp = this.mesh.localToWorld(t.offset.clone());
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
  // FLIGHT MODEL  (v2 — banking turn, inertial)
  // -----------------------------------------------------------
  update(dt, input, time) {
    if (!this.alive) {
      this.root.position.addScaledVector(this.vel, dt);
      this.vel.y -= 35 * dt;
      this.mesh.rotation.x += dt * 1.6;
      this.mesh.rotation.z += dt * 2.4;
      this._updateTrails(dt);
      return;
    }

    const v = input.value;

    // ---- target rotation rates (rad/sec) ----
    // Roll input -> ALSO drives yaw rate (banking turns) — feels natural
    const targetYawRate   = (-v.roll * 1.35 + v.yaw * 1.0); // banking + explicit yaw
    const targetPitchRate = -v.pitch * 1.25;
    const targetRollVis   = -v.roll * 0.95;                   // visual bank

    // smooth angular acceleration (gives weight)
    this.yawRate    = damp(this.yawRate,    targetYawRate,    7.0, dt);
    this.pitchRate  = damp(this.pitchRate,  targetPitchRate,  7.5, dt);
    this.rollVisual = damp(this.rollVisual, targetRollVis,    8.0, dt);

    // integrate
    this.yaw   += this.yawRate * dt;
    this.pitch += this.pitchRate * dt;
    // clamp pitch to avoid full flip
    this.pitch = clamp(this.pitch, -0.95, 0.95);

    // barrel roll (visual-only spin around forward axis)
    const queued = input.consumeBarrel();
    if (queued !== 0 && Math.abs(this.barrelRollAngle) < 0.001) {
      this.barrelRollDir = queued;
      this.barrelRollAngle = 0.0001 * queued;
    }
    if (Math.abs(this.barrelRollAngle) > 0) {
      const sp = 10 * this.barrelRollDir;
      this.barrelRollAngle += sp * dt;
      if (Math.abs(this.barrelRollAngle) >= Math.PI * 2) {
        this.barrelRollAngle = 0;
        this.barrelRollDir = 0;
      }
    }

    // ---- speed control ----
    const wantBoost = v.boost > 0.55 && this.boostFuel > 0.05;
    const wantBrake = v.brake > 0.5;
    this.boostActive = wantBoost;

    let target;
    if (wantBoost) target = this.maxSpeed;
    else if (wantBrake) target = this.minSpeed;
    else target = this.cruiseSpeed + (this.maxSpeed - this.cruiseSpeed) * 0.18;

    // gravity feel: dive faster, climb slower
    target += -this.pitch * 28;

    this.speed = damp(this.speed, target, wantBoost ? 3.6 : (wantBrake ? 4.5 : 2.6), dt);
    this.speed = clamp(this.speed, this.minSpeed * 0.7, this.maxSpeed);

    // boost fuel
    if (wantBoost) this.boostFuel = clamp(this.boostFuel - dt * 0.32, 0, 1);
    else           this.boostFuel = clamp(this.boostFuel + dt * 0.20, 0, 1);

    // ---- compose forward direction from yaw/pitch ----
    const forward = new THREE.Vector3(0, 0, -1);
    const e = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
    forward.applyEuler(e);
    forward.normalize();

    this.vel.copy(forward).multiplyScalar(this.speed);
    this.root.position.addScaledVector(this.vel, dt);

    // soft world bounds (vertical especially, so player can't fly into ground/sky)
    if (this.root.position.y < -55) {
      this.root.position.y = -55; this.pitch = Math.max(this.pitch, 0); this.pitchRate = Math.max(this.pitchRate, 0);
    }
    if (this.root.position.y > 95) {
      this.root.position.y = 95; this.pitch = Math.min(this.pitch, 0); this.pitchRate = Math.min(this.pitchRate, 0);
    }
    this.root.position.x = clamp(this.root.position.x, -140, 140);

    // ---- assemble visual orientation ----
    // Root carries yaw + pitch (so trails / camera follow real orientation)
    const rootEuler = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
    this.root.quaternion.setFromEuler(rootEuler);
    // mesh carries visual-only roll + barrel
    this.mesh.rotation.set(0, 0, this.rollVisual + this.barrelRollAngle);

    // engine glow scale by speed
    const sNorm = clamp((this.speed - this.minSpeed) / (this.maxSpeed - this.minSpeed), 0, 1);
    this.engineGlow.scale.setScalar(0.85 + sNorm * 1.7 + Math.sin(time * 30) * 0.06);
    this.engineGlow.material.opacity = 0.75 + sNorm * 0.25;
    this.boostHalo.material.opacity = wantBoost ? 0.65 + Math.sin(time * 25) * 0.14 : 0;
    this.boostHalo.scale.setScalar(0.95 + sNorm * 1.3);
    this.shipLight.intensity = 1.4 + sNorm * 1.8;

    this._updateTrails(dt);

    // invuln decay + flicker
    if (this.invuln > 0) {
      this.invuln = Math.max(0, this.invuln - dt);
      this.mesh.visible = (Math.floor(time * 18) % 2) === 0;
    } else {
      this.mesh.visible = true;
    }

    this.pos.copy(this.root.position);
  }

  damage() {
    if (this.invuln > 0 || !this.alive) return false;
    this.shields = Math.max(0, this.shields - 1);
    this.invuln = 1.6;
    if (this.shields <= 0) this.alive = false;
    return true;
  }

  getForward() {
    const f = new THREE.Vector3(0, 0, -1);
    f.applyQuaternion(this.root.quaternion);
    return f;
  }
}
