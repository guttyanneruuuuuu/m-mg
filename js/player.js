// ===========================================================
// player.js — STARFORGE space fighter
//   - Fully redesigned space fighter mesh (sleek interceptor)
//   - Weapons: primary cannon (auto), missiles (charged)
//   - Stats driven by upgrade levels (passed in via opts)
//   - Shields with regen, energy bar for boost & alt-fire
// ===========================================================

import * as THREE from 'three';
import { clamp, damp, lerp, rand } from './utils.js';

export class Player {
  constructor(scene, stats = {}) {
    this.scene = scene;

    // ---------- root + visual mesh ----------
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.mesh = new THREE.Group();
    this.root.add(this.mesh);
    this._buildShip();

    // ---------- flight state ----------
    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3(0, 0, 0);

    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;

    this.yawRate = 0;
    this.pitchRate = 0;
    this.rollVisual = 0;

    this.barrelRollAngle = 0;
    this.barrelRollDir = 0;

    // base stats — modified by upgrade stats
    const baseHP = stats.hp ?? 3;
    const dmg    = stats.damage ?? 1;
    const fireR  = stats.fireRate ?? 1.0;       // shots per sec multiplier
    const spd    = stats.speed ?? 1.0;
    const energyCap = stats.energy ?? 1.0;

    // speeds
    this.cruiseSpeed = 60 * spd;
    this.maxSpeed    = 200 * spd;
    this.minSpeed    = 28 * spd;
    this.speed       = this.cruiseSpeed;
    this.boostFuel   = 1.0;
    this.boostActive = false;
    this.energyMax   = energyCap;

    // shields/HP system
    this.maxShields = baseHP;
    this.shields = baseHP;
    this.shieldRegenT = 0;
    this.shieldRegenDelay = 6.0;        // sec since last hit before regen begins
    this.shieldRegenRate = 0.10 / 1;    // hp/sec when regenerating
    this.invuln  = 0;
    this.alive = true;

    // weapons
    this.fireCooldown = 0;
    this.fireRateMul = fireR;     // multiplies base RoF
    this.bulletDamage = dmg;
    this.bulletSpeed  = 230;
    this.multishot = stats.multishot ?? 1;     // number of bullets per fire
    this.spread = stats.spread ?? 0.025;
    this.pierce = stats.pierce ?? 0;
    // missiles
    this.missileAmmo = stats.missileAmmo ?? 0; // unlocks at upgrade level >= 1
    this.missileCharge = 0;
    this.missileMax = stats.missileAmmo ?? 0;
    this.missileRegen = stats.missileRegen ?? 0.10; // per sec
    this.missileDamage = stats.missileDamage ?? 6;

    // visual flicker
    this.invulnFlicker = 0;

    // trails
    this._initTrails();
  }

  // -----------------------------------------------------------
  _buildShip() {
    const M = (color, opts={}) => {
      const { emissive, emi, ...rest } = opts;
      return new THREE.MeshStandardMaterial({
        color, roughness: 0.42, metalness: 0.85,
        emissive: emissive ?? 0x000000,
        emissiveIntensity: emi ?? 0,
        ...rest
      });
    };

    // ===== Hull (dark titanium core) =====
    const hullMat = M(0x1a1f2e, { roughness: 0.32, metalness: 0.95, emissive: 0x0a0a18, emi: 0.3 });

    // main fuselage — elongated diamond
    const fuse = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.85, 1),
      hullMat
    );
    fuse.scale.set(0.7, 0.45, 2.2);
    this.mesh.add(fuse);

    // forward spear (nose cone)
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.32, 1.6, 14),
      M(0xeaf2ff, { roughness: 0.18, metalness: 0.95, emissive: 0x88aaff, emi: 0.4 })
    );
    nose.position.z = -2.0;
    nose.rotation.x = -Math.PI / 2;
    this.mesh.add(nose);

    // nose tip energy gem
    const noseTip = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x7df9ff })
    );
    noseTip.position.z = -2.8;
    this.mesh.add(noseTip);
    this.noseTip = noseTip;

    // cockpit dome (tinted glass)
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(0.45, 24, 16, 0, Math.PI*2, 0, Math.PI*0.55),
      new THREE.MeshPhysicalMaterial({
        color: 0x05122a, roughness: 0.05, metalness: 0.2,
        transparent: true, opacity: 0.85,
        clearcoat: 1.0, clearcoatRoughness: 0.04,
        emissive: 0x223388, emissiveIntensity: 0.55
      })
    );
    dome.position.set(0, 0.32, -0.4);
    dome.scale.set(1.3, 0.7, 1.7);
    this.mesh.add(dome);

    // ===== Wings — angular swept-back =====
    const wingMat = M(0x222a3f, { roughness: 0.32, metalness: 0.85, emissive: 0x0a1530, emi: 0.4 });
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0, 0);
    wingShape.lineTo(3.6, -1.2);
    wingShape.lineTo(3.0, -1.7);
    wingShape.lineTo(0.5, -0.8);
    wingShape.lineTo(0, 0);
    const wingGeo = new THREE.ExtrudeGeometry(wingShape, {
      depth: 0.16, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.04, bevelSegments: 2
    });
    wingGeo.center();
    const wL = new THREE.Mesh(wingGeo, wingMat);
    wL.position.set(-1.6, -0.10, 0.5);
    wL.rotation.set(0, 0, 0.12);
    this.mesh.add(wL);
    const wR = wL.clone();
    wR.scale.x = -1;
    wR.position.x = 1.6;
    wR.rotation.z = -0.12;
    this.mesh.add(wR);

    // ===== Glowing wing edges (energy lines) =====
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0x7df9ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending });
    for (const s of [-1, 1]) {
      // long leading edge
      const edge = new THREE.Mesh(
        new THREE.BoxGeometry(2.6, 0.06, 0.10),
        edgeMat
      );
      edge.position.set(s * 1.85, -0.05, 0.05);
      edge.rotation.z = -s * 0.20;
      this.mesh.add(edge);
      // tip light
      const tip = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 10, 8),
        new THREE.MeshBasicMaterial({ color: s > 0 ? 0x7df9ff : 0xff6ec7 })
      );
      tip.position.set(s * 3.05, -0.3, 0.1);
      this.mesh.add(tip);
    }

    // ===== Weapon barrels (twin cannons under wings) =====
    this.barrels = [];
    for (const s of [-1, 1]) {
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.10, 1.4, 10),
        M(0x2a2a3a, { metalness: 0.95, roughness: 0.25, emissive: 0x111122, emi: 0.4 })
      );
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(s * 1.4, -0.12, -0.5);
      this.mesh.add(barrel);
      // muzzle flare anchor
      const muzzle = new THREE.Object3D();
      muzzle.position.set(s * 1.4, -0.12, -1.3);
      this.mesh.add(muzzle);
      this.barrels.push(muzzle);

      // muzzle flash mesh (hidden by default)
      const flash = new THREE.Mesh(
        new THREE.SphereGeometry(0.32, 10, 8),
        new THREE.MeshBasicMaterial({
          color: 0x88ffff, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false
        })
      );
      flash.position.copy(muzzle.position);
      this.mesh.add(flash);
      muzzle.userData.flash = flash;
    }

    // ===== Engine cluster (back) — 3 nozzles =====
    const engineMat = M(0x14141e, { metalness: 0.95, roughness: 0.18 });
    this.engineGlows = [];
    const noz = [
      [0,    0.0,  1.55, 0.45],
      [-0.55,-0.1, 1.45, 0.30],
      [0.55, -0.1, 1.45, 0.30]
    ];
    for (const [x, y, z, r] of noz) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(r, 0.06, 8, 18),
        engineMat
      );
      ring.position.set(x, y, z);
      ring.rotation.y = Math.PI / 2;
      this.mesh.add(ring);
      const glow = new THREE.Mesh(
        new THREE.CircleGeometry(r * 0.78, 22),
        new THREE.MeshBasicMaterial({
          color: 0x7df9ff, transparent: true, opacity: 0.95,
          blending: THREE.AdditiveBlending, depthWrite: false
        })
      );
      glow.position.set(x, y, z + 0.04);
      glow.rotation.y = Math.PI;
      this.mesh.add(glow);
      this.engineGlows.push(glow);
    }

    // outer halo (boost flare)
    this.boostHalo = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0xff6ec7, transparent: true, opacity: 0.0,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    this.boostHalo.position.set(0, 0, 2.3);
    this.mesh.add(this.boostHalo);

    // tail fin (vertical stabilizer)
    const fin = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.95, 1.3),
      M(0x202838, { emissive: 0x4477ff, emi: 0.4, metalness: 0.85, roughness: 0.3 })
    );
    fin.position.set(0, 0.65, 1.0);
    this.mesh.add(fin);
    // glow stripe on fin
    const finStripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.06, 1.0),
      new THREE.MeshBasicMaterial({ color: 0x7df9ff, transparent: true, opacity: 0.95 })
    );
    finStripe.position.set(0, 1.0, 1.0);
    this.mesh.add(finStripe);

    // shield bubble (visible briefly when hit)
    this.shieldBubble = new THREE.Mesh(
      new THREE.SphereGeometry(2.6, 24, 18),
      new THREE.MeshBasicMaterial({
        color: 0x7df9ff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
        wireframe: false
      })
    );
    this.mesh.add(this.shieldBubble);

    // small light on the ship
    const pl = new THREE.PointLight(0x7df9ff, 1.6, 22, 2.0);
    pl.position.set(0, 0.4, 0);
    this.mesh.add(pl);
    this.shipLight = pl;
  }

  _initTrails() {
    const MAX = 80;
    this.trails = [];
    for (const offset of [
      new THREE.Vector3(-0.55, -0.1, 1.5),
      new THREE.Vector3( 0.55, -0.1, 1.5),
      new THREE.Vector3( 0.0,   0.0, 1.6)
    ]) {
      const positions = new Float32Array(MAX * 3);
      const colors    = new Float32Array(MAX * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
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
  update(dt, input, time) {
    if (!this.alive) {
      this.root.position.addScaledVector(this.vel, dt);
      this.vel.y -= 18 * dt;          // gentler in zero-g
      this.mesh.rotation.x += dt * 1.6;
      this.mesh.rotation.z += dt * 2.4;
      this._updateTrails(dt);
      return;
    }

    const v = input.value;

    const targetYawRate   = (-v.roll * 1.35 + v.yaw * 1.0);
    const targetPitchRate = -v.pitch * 1.25;
    const targetRollVis   = -v.roll * 0.95;

    this.yawRate    = damp(this.yawRate,    targetYawRate,    7.0, dt);
    this.pitchRate  = damp(this.pitchRate,  targetPitchRate,  7.5, dt);
    this.rollVisual = damp(this.rollVisual, targetRollVis,    8.0, dt);

    this.yaw   += this.yawRate * dt;
    this.pitch += this.pitchRate * dt;
    this.pitch = clamp(this.pitch, -0.95, 0.95);

    // barrel roll
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
    else target = this.cruiseSpeed + (this.maxSpeed - this.cruiseSpeed) * 0.10;

    // no gravity — but slight pitch acceleration for arcade feel
    target += -this.pitch * 14;

    this.speed = damp(this.speed, target, wantBoost ? 3.6 : (wantBrake ? 4.5 : 2.6), dt);
    this.speed = clamp(this.speed, this.minSpeed * 0.6, this.maxSpeed);

    if (wantBoost) this.boostFuel = clamp(this.boostFuel - dt * 0.30, 0, 1);
    else           this.boostFuel = clamp(this.boostFuel + dt * 0.22, 0, 1);

    // forward direction
    const forward = new THREE.Vector3(0, 0, -1);
    const e = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
    forward.applyEuler(e);
    forward.normalize();

    this.vel.copy(forward).multiplyScalar(this.speed);
    this.root.position.addScaledVector(this.vel, dt);

    // soft world bounds (much wider in space)
    if (this.root.position.y < -120) {
      this.root.position.y = -120; this.pitch = Math.max(this.pitch, 0); this.pitchRate = Math.max(this.pitchRate, 0);
    }
    if (this.root.position.y > 120) {
      this.root.position.y = 120; this.pitch = Math.min(this.pitch, 0); this.pitchRate = Math.min(this.pitchRate, 0);
    }
    this.root.position.x = clamp(this.root.position.x, -180, 180);

    const rootEuler = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
    this.root.quaternion.setFromEuler(rootEuler);
    this.mesh.rotation.set(0, 0, this.rollVisual + this.barrelRollAngle);

    // engine glow scale by speed
    const sNorm = clamp((this.speed - this.minSpeed) / (this.maxSpeed - this.minSpeed), 0, 1);
    for (const g of this.engineGlows) {
      g.scale.setScalar(0.85 + sNorm * 1.7 + Math.sin(time * 30) * 0.05);
      g.material.opacity = 0.75 + sNorm * 0.25;
      g.material.color.setHex(wantBoost ? 0xff6ec7 : 0x7df9ff);
    }
    this.boostHalo.material.opacity = wantBoost ? 0.65 + Math.sin(time * 25) * 0.14 : 0;
    this.boostHalo.scale.setScalar(0.95 + sNorm * 1.3);
    this.shipLight.intensity = 1.4 + sNorm * 1.8;

    // muzzle flash decay
    for (const m of this.barrels) {
      if (m.userData.flash) {
        m.userData.flash.material.opacity *= Math.pow(0.001, dt);
        if (m.userData.flash.material.opacity < 0.005) m.userData.flash.material.opacity = 0;
      }
    }

    // shield regen
    this.shieldRegenT += dt;
    if (this.shieldRegenT >= this.shieldRegenDelay && this.shields < this.maxShields) {
      this.shields = Math.min(this.maxShields, this.shields + this.shieldRegenRate * dt);
    }

    // missile regen
    if (this.missileMax > 0 && this.missileAmmo < this.missileMax) {
      this.missileAmmo = Math.min(this.missileMax, this.missileAmmo + this.missileRegen * dt);
    }

    // shield bubble visualization
    if (this.invuln > 0) {
      this.shieldBubble.material.opacity = 0.18 + Math.sin(time * 30) * 0.10;
    } else {
      this.shieldBubble.material.opacity = damp(this.shieldBubble.material.opacity, 0, 6, dt);
    }

    // weapon cooldown ticking
    if (this.fireCooldown > 0) this.fireCooldown -= dt;

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

  // ---------- Weapons ----------
  /** Returns array of bullet specs to spawn, or empty if can't fire. */
  tryFire() {
    if (!this.alive) return null;
    if (this.fireCooldown > 0) return null;
    // base: 5 shots/sec multiplied
    this.fireCooldown = 1 / (5 * this.fireRateMul);

    // muzzle flash
    for (const m of this.barrels) {
      if (m.userData.flash) m.userData.flash.material.opacity = 1.0;
    }

    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.root.quaternion).normalize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.root.quaternion).normalize();

    const bullets = [];
    for (let i = 0; i < this.barrels.length; i++) {
      const m = this.barrels[i];
      const muzzleWorld = new THREE.Vector3();
      m.getWorldPosition(muzzleWorld);
      // multishot: spread bullets fanned slightly
      for (let s = 0; s < this.multishot; s++) {
        const offsetIdx = (s - (this.multishot - 1) / 2);
        const dir = fwd.clone().addScaledVector(right, offsetIdx * this.spread).normalize();
        bullets.push({
          pos: muzzleWorld.clone(),
          dir,
          speed: this.bulletSpeed,
          damage: this.bulletDamage,
          life: 2.0,
          pierce: this.pierce,
        });
      }
    }
    return bullets;
  }

  tryFireMissile() {
    if (!this.alive || this.missileMax <= 0) return null;
    if (this.missileAmmo < 1) return null;
    this.missileAmmo -= 1;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.root.quaternion).normalize();
    const muzzle = new THREE.Vector3();
    this.mesh.getWorldPosition(muzzle);
    return {
      pos: muzzle.clone(),
      dir: fwd,
      speed: 90,
      damage: this.missileDamage,
      life: 4.0,
      homing: true,
    };
  }

  damage(amount = 1) {
    if (this.invuln > 0 || !this.alive) return false;
    this.shields = Math.max(0, this.shields - amount);
    this.invuln = 1.4;
    this.shieldRegenT = 0;
    if (this.shields <= 0.001) {
      this.shields = 0;
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
