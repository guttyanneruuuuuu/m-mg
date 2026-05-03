// ===========================================================
// player.js — STARFORGE space fighter (v2)
//   - More detailed, realistic interceptor mesh
//   - PBR-ish materials with environment-mapped panels
//   - Multi-color skinning (hull / accent / trim)
//   - Equipment-aware visual mounts (missile pods, drones)
//   - Improved control feel: agility-driven response, banking,
//     auto-roll-leveling, easier yaw blending.
//   - Tracer crit effects, tighter weapon timing, drone helper.
// ===========================================================

import * as THREE from 'three';
import { clamp, damp, lerp, rand } from './utils.js';

export class Player {
  constructor(scene, stats = {}, opts = {}) {
    this.scene = scene;
    this.skin = opts.skin || { hull: 0x1a1f2e, accent: 0x7df9ff, trim: 0xff6ec7 };
    this.equippedItems = opts.equippedItems || [];

    // ---------- root + visual mesh ----------
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.mesh = new THREE.Group();
    this.root.add(this.mesh);

    this.dynamicLights = [];
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
    const fireR  = stats.fireRate ?? 1.0;
    const spd    = stats.speed ?? 1.0;
    this.agilityMul = stats.agility ?? 1.0;

    // speeds
    this.cruiseSpeed = 60 * spd;
    this.maxSpeed    = 200 * spd;
    this.minSpeed    = 28 * spd;
    this.speed       = this.cruiseSpeed;
    this.boostFuel   = 1.0;
    this.boostActive = false;

    // shields/HP system
    this.maxShields = baseHP;
    this.shields = baseHP;
    this.shieldRegenT = 0;
    this.shieldRegenDelay = stats.shieldRegenDelay ?? 6.0;
    this.shieldRegenRate  = stats.shieldRegenRate  ?? 0.10;
    this.invulnTime = stats.invulnTime ?? 1.4;
    this.invuln  = 0;
    this.alive = true;

    // weapons
    this.fireCooldown = 0;
    this.fireRateMul = fireR;
    this.bulletDamage = dmg;
    this.bulletSpeed  = 230 * (stats.bulletSpeed ?? 1);
    this.multishot = stats.multishot ?? 1;
    this.spread = stats.spread ?? 0.025;
    this.pierce = stats.pierce ?? 0;
    // crit
    this.critChance = stats.critChance ?? 0;
    this.critMul    = stats.critMul ?? 2.0;
    // aim assist (fed back to projMgr through bullet spec)
    this.aimAssist = stats.aimAssist ?? 0;
    // missiles
    this.missileAmmo = stats.missileAmmo ?? 0;
    this.missileMax = stats.missileAmmo ?? 0;
    this.missileRegen = stats.missileRegen ?? 0.10;
    this.missileDamage = stats.missileDamage ?? 6;
    this.missileAoe = stats.missileAoe ?? 0;

    // utility
    this.magnetRadius = stats.magnetRadius ?? 6;
    this.salvageMul = stats.salvageMul ?? 1;
    this.chronoTrigger = stats.chronoTrigger ?? 0;
    this.chronoStrength = stats.chronoStrength ?? 0;

    // drone
    this.droneDps = stats.droneDps ?? 0;
    this.droneRange = stats.droneRange ?? 0;
    this.droneAngle = 0;

    // visual flicker
    this.invulnFlicker = 0;
    this.muzzleAlt = 0;

    // trails
    this._initTrails();

    // attach equipment-specific visuals
    this._attachEquipmentVisuals();
  }

  // -----------------------------------------------------------
  _buildShip() {
    const skin = this.skin;
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
    const hullMat   = M(skin.hull,    { roughness: 0.30, metalness: 0.96, emissive: 0x05060f, emi: 0.18 });
    const panelMat  = M(skin.hull,    { roughness: 0.55, metalness: 0.85, emissive: 0x080814, emi: 0.10 });
    const accentMat = M(skin.accent,  { roughness: 0.18, metalness: 0.92, emissive: skin.accent, emi: 0.55 });
    const trimMat   = M(skin.trim,    { roughness: 0.22, metalness: 0.85, emissive: skin.trim, emi: 0.55 });

    // main fuselage — elongated diamond + bottom slab to look like a real hull
    const fuse = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.9, 1),
      hullMat
    );
    fuse.scale.set(0.72, 0.42, 2.3);
    this.mesh.add(fuse);

    // belly slab (gives more "ship" silhouette)
    const belly = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.18, 3.2),
      panelMat
    );
    belly.position.set(0, -0.34, 0.05);
    this.mesh.add(belly);

    // upper spine
    const spine = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.20, 2.7),
      panelMat
    );
    spine.position.set(0, 0.32, 0.4);
    this.mesh.add(spine);

    // panel seams (thin emissive lines)
    const seamMat = new THREE.MeshBasicMaterial({
      color: skin.accent, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending
    });
    for (const z of [-1.2, -0.4, 0.5, 1.3]) {
      const seam = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.025, 0.06), seamMat);
      seam.position.set(0, -0.24, z);
      this.mesh.add(seam);
    }

    // forward spear (nose cone)
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.34, 1.7, 18),
      accentMat
    );
    nose.position.z = -2.0;
    nose.rotation.x = -Math.PI / 2;
    this.mesh.add(nose);

    // nose tip energy gem
    const noseTip = new THREE.Mesh(
      new THREE.SphereGeometry(0.20, 14, 10),
      new THREE.MeshBasicMaterial({ color: skin.accent })
    );
    noseTip.position.z = -2.85;
    this.mesh.add(noseTip);
    this.noseTip = noseTip;

    // nose chin sensor
    const sensor = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.10, 0.4),
      M(0x0c0c14, { metalness: 0.95, roughness: 0.18, emissive: skin.trim, emi: 0.7 })
    );
    sensor.position.set(0, -0.33, -2.05);
    this.mesh.add(sensor);

    // cockpit dome (tinted glass)
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(0.46, 28, 18, 0, Math.PI*2, 0, Math.PI*0.55),
      new THREE.MeshPhysicalMaterial({
        color: 0x06122a, roughness: 0.04, metalness: 0.2,
        transparent: true, opacity: 0.85,
        clearcoat: 1.0, clearcoatRoughness: 0.04,
        emissive: 0x223388, emissiveIntensity: 0.55,
        envMapIntensity: 1.5
      })
    );
    dome.position.set(0, 0.34, -0.45);
    dome.scale.set(1.32, 0.72, 1.78);
    this.mesh.add(dome);
    // cockpit frame
    const frame = new THREE.Mesh(
      new THREE.TorusGeometry(0.55, 0.04, 8, 24, Math.PI),
      panelMat
    );
    frame.rotation.x = -Math.PI / 2;
    frame.position.set(0, 0.34, -0.45);
    frame.scale.set(1.0, 1.0, 1.4);
    this.mesh.add(frame);

    // ===== Wings — angular swept-back =====
    const wingMat = M(skin.hull, { roughness: 0.28, metalness: 0.88, emissive: 0x0a1530, emi: 0.35 });
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0, 0);
    wingShape.lineTo(3.8, -1.3);
    wingShape.lineTo(3.1, -1.85);
    wingShape.lineTo(0.5, -0.85);
    wingShape.lineTo(0, 0);
    const wingGeo = new THREE.ExtrudeGeometry(wingShape, {
      depth: 0.18, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.05, bevelSegments: 3
    });
    wingGeo.center();
    const wL = new THREE.Mesh(wingGeo, wingMat);
    wL.position.set(-1.7, -0.10, 0.55);
    wL.rotation.set(0, 0, 0.13);
    this.mesh.add(wL);
    const wR = wL.clone();
    wR.scale.x = -1;
    wR.position.x = 1.7;
    wR.rotation.z = -0.13;
    this.mesh.add(wR);

    // wing pylons (hard-points underneath)
    const pylonMat = M(0x12141c, { metalness: 0.95, roughness: 0.25 });
    this.hardpoints = [];
    for (const sx of [-1, 1]) {
      const pylon = new THREE.Mesh(
        new THREE.BoxGeometry(0.18, 0.22, 0.9),
        pylonMat
      );
      pylon.position.set(sx * 1.1, -0.30, 0.2);
      this.mesh.add(pylon);
      const hp = new THREE.Object3D();
      hp.position.set(sx * 1.1, -0.50, 0.2);
      this.mesh.add(hp);
      this.hardpoints.push(hp);
    }

    // ===== Glowing wing edges (energy lines) =====
    const edgeMat = new THREE.MeshBasicMaterial({
      color: skin.accent, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending
    });
    for (const s of [-1, 1]) {
      const edge = new THREE.Mesh(
        new THREE.BoxGeometry(2.7, 0.06, 0.10),
        edgeMat
      );
      edge.position.set(s * 1.95, -0.05, 0.05);
      edge.rotation.z = -s * 0.20;
      this.mesh.add(edge);
      // tip nav light (red-port / green-starboard inspired)
      const tipColor = s > 0 ? skin.accent : skin.trim;
      const tip = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 12, 10),
        new THREE.MeshBasicMaterial({ color: tipColor })
      );
      tip.position.set(s * 3.20, -0.32, 0.1);
      this.mesh.add(tip);
      tip.userData.blink = { phase: rand(0, Math.PI * 2), color: tipColor };
      this.dynamicLights.push(tip);

      // small canard fin under wing
      const canard = new THREE.Mesh(
        new THREE.BoxGeometry(0.4, 0.06, 0.7),
        wingMat
      );
      canard.position.set(s * 2.4, -0.32, -0.05);
      canard.rotation.z = -s * 0.20;
      this.mesh.add(canard);
    }

    // ===== Weapon barrels (twin cannons under wings) =====
    this.barrels = [];
    for (const s of [-1, 1]) {
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.13, 0.10, 1.6, 12),
        M(0x16161e, { metalness: 0.95, roughness: 0.25, emissive: 0x111122, emi: 0.4 })
      );
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(s * 1.4, -0.14, -0.6);
      this.mesh.add(barrel);
      // muzzle ring
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.13, 0.025, 8, 16),
        accentMat
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.set(s * 1.4, -0.14, -1.42);
      this.mesh.add(ring);
      // muzzle anchor
      const muzzle = new THREE.Object3D();
      muzzle.position.set(s * 1.4, -0.14, -1.45);
      this.mesh.add(muzzle);
      this.barrels.push(muzzle);

      // muzzle flash mesh
      const flash = new THREE.Mesh(
        new THREE.SphereGeometry(0.36, 12, 10),
        new THREE.MeshBasicMaterial({
          color: skin.accent, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false
        })
      );
      flash.position.copy(muzzle.position);
      this.mesh.add(flash);
      muzzle.userData.flash = flash;
    }

    // ===== Engine cluster (back) — 3 nozzles =====
    const engineMat = M(0x0e0e16, { metalness: 0.96, roughness: 0.18 });
    this.engineGlows = [];
    const noz = [
      [0,    0.0,  1.65, 0.50],
      [-0.62,-0.1, 1.55, 0.34],
      [0.62, -0.1, 1.55, 0.34]
    ];
    for (const [x, y, z, r] of noz) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(r, 0.075, 12, 22),
        engineMat
      );
      ring.position.set(x, y, z);
      ring.rotation.y = Math.PI / 2;
      this.mesh.add(ring);
      // outer cowl
      const cowl = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 1.1, r * 0.9, 0.4, 14, 1, true),
        engineMat
      );
      cowl.rotation.x = Math.PI / 2;
      cowl.position.set(x, y, z - 0.18);
      this.mesh.add(cowl);
      // glow disk
      const glow = new THREE.Mesh(
        new THREE.CircleGeometry(r * 0.78, 24),
        new THREE.MeshBasicMaterial({
          color: skin.accent, transparent: true, opacity: 0.95,
          blending: THREE.AdditiveBlending, depthWrite: false
        })
      );
      glow.position.set(x, y, z + 0.05);
      glow.rotation.y = Math.PI;
      this.mesh.add(glow);
      this.engineGlows.push(glow);

      // inner core
      const core = new THREE.Mesh(
        new THREE.CircleGeometry(r * 0.45, 18),
        new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0.95,
          blending: THREE.AdditiveBlending, depthWrite: false
        })
      );
      core.position.set(x, y, z + 0.06);
      core.rotation.y = Math.PI;
      this.mesh.add(core);
    }

    // outer halo (boost flare)
    this.boostHalo = new THREE.Mesh(
      new THREE.SphereGeometry(1.3, 18, 12),
      new THREE.MeshBasicMaterial({
        color: skin.trim, transparent: true, opacity: 0.0,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    this.boostHalo.position.set(0, 0, 2.4);
    this.mesh.add(this.boostHalo);

    // tail fin (vertical stabilizer)
    const fin = new THREE.Mesh(
      new THREE.BoxGeometry(0.10, 1.0, 1.3),
      M(skin.hull, { emissive: 0x4477ff, emi: 0.4, metalness: 0.85, roughness: 0.3 })
    );
    fin.position.set(0, 0.7, 1.0);
    this.mesh.add(fin);
    const finStripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.06, 1.05),
      new THREE.MeshBasicMaterial({ color: skin.accent, transparent: true, opacity: 0.95 })
    );
    finStripe.position.set(0, 1.1, 1.0);
    this.mesh.add(finStripe);

    // small tail nav-light (blinking)
    const tailLight = new THREE.Mesh(
      new THREE.SphereGeometry(0.10, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    tailLight.position.set(0, 1.18, 1.55);
    this.mesh.add(tailLight);
    tailLight.userData.blink = { phase: 0, color: 0xffffff, fast: true };
    this.dynamicLights.push(tailLight);

    // shield bubble
    this.shieldBubble = new THREE.Mesh(
      new THREE.SphereGeometry(2.7, 28, 20),
      new THREE.MeshBasicMaterial({
        color: skin.accent, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide
      })
    );
    this.mesh.add(this.shieldBubble);

    // ship inner light (cockpit glow)
    const pl = new THREE.PointLight(skin.accent, 1.6, 22, 2.0);
    pl.position.set(0, 0.4, 0);
    this.mesh.add(pl);
    this.shipLight = pl;

    // a soft underglow that brightens under boost
    const underGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(4.5, 3.0),
      new THREE.MeshBasicMaterial({
        color: skin.trim, transparent: true, opacity: 0.0,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    underGlow.position.set(0, -0.6, 0);
    underGlow.rotation.x = -Math.PI / 2;
    this.mesh.add(underGlow);
    this.underGlow = underGlow;
  }

  _attachEquipmentVisuals() {
    if (!this.hardpoints || !this.hardpoints.length) return;
    let leftUsed = false, rightUsed = false;
    for (const it of this.equippedItems) {
      if (it.slot !== 'secondary') continue;
      const target = leftUsed ? this.hardpoints[1] : this.hardpoints[0];
      if (leftUsed) rightUsed = true; else leftUsed = true;
      const mat = new THREE.MeshStandardMaterial({
        color: 0x141420, metalness: 0.9, roughness: 0.3,
        emissive: 0xffd86b, emissiveIntensity: 0.25
      });
      let meshGroup = new THREE.Group();
      if (it.bp.startsWith('missile')) {
        const pod = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.25, 0.9), mat);
        meshGroup.add(pod);
        for (let i = -1; i <= 1; i++) {
          const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.55, 8), mat);
          tube.rotation.x = Math.PI / 2;
          tube.position.set(i * 0.10, -0.18, 0.1);
          meshGroup.add(tube);
        }
      } else if (it.bp === 'flak_shield') {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.30, 0.05, 8, 16),
          new THREE.MeshBasicMaterial({ color: 0x7df9ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending })
        );
        ring.rotation.x = Math.PI / 2;
        meshGroup.add(ring);
      } else if (it.bp === 'drone_pulse') {
        // drone is positioned dynamically — but show a hangar bay
        const bay = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, 0.5), mat);
        meshGroup.add(bay);
      }
      target.add(meshGroup);
    }
    // Drone helper if any
    if (this.droneDps > 0) {
      const drone = new THREE.Group();
      const core = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.28, 0),
        new THREE.MeshStandardMaterial({
          color: 0x0a0a14, metalness: 0.9, roughness: 0.25,
          emissive: this.skin.accent, emissiveIntensity: 0.6
        })
      );
      drone.add(core);
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.45, 12, 10),
        new THREE.MeshBasicMaterial({
          color: this.skin.accent, transparent: true, opacity: 0.30,
          blending: THREE.AdditiveBlending, depthWrite: false
        })
      );
      drone.add(glow);
      this.mesh.add(drone);
      this.drone = drone;
    }
  }

  _initTrails() {
    const MAX = 80;
    this.trails = [];
    for (const offset of [
      new THREE.Vector3(-0.62, -0.1, 1.55),
      new THREE.Vector3( 0.62, -0.1, 1.55),
      new THREE.Vector3( 0.0,   0.0, 1.7)
    ]) {
      const positions = new Float32Array(MAX * 3);
      const colors    = new Float32Array(MAX * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      this.scene.add(line);
      this.trails.push({ line, positions, colors, offset, history: [], max: MAX });
    }
  }

  _updateTrails(dt) {
    const accent = new THREE.Color(this.skin.accent);
    const trim   = new THREE.Color(this.skin.trim);
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
        const r = lerp(accent.r, trim.r, boostMix);
        const g = lerp(accent.g, trim.g, boostMix);
        const b = lerp(accent.b, trim.b, boostMix);
        c[i*3+0] = r * a;
        c[i*3+1] = g * a;
        c[i*3+2] = b * a;
      }
      t.line.geometry.attributes.position.needsUpdate = true;
      t.line.geometry.attributes.color.needsUpdate = true;
    }
  }

  // -----------------------------------------------------------
  update(dt, input, time) {
    if (!this.alive) {
      this.root.position.addScaledVector(this.vel, dt);
      this.vel.y -= 18 * dt;
      this.mesh.rotation.x += dt * 1.6;
      this.mesh.rotation.z += dt * 2.4;
      this._updateTrails(dt);
      return;
    }

    const v = input.value;
    const ag = this.agilityMul;

    const targetYawRate   = (-v.roll * 1.45 + v.yaw * 1.0) * ag;
    const targetPitchRate = (-v.pitch * 1.30) * ag;
    const targetRollVis   = -v.roll * 1.05;

    // higher agility -> faster damping
    const yawL = 7.0 + (ag - 1) * 4;
    const pitL = 7.5 + (ag - 1) * 4;
    const rolL = 8.0 + (ag - 1) * 3;
    this.yawRate    = damp(this.yawRate,    targetYawRate,    yawL, dt);
    this.pitchRate  = damp(this.pitchRate,  targetPitchRate,  pitL, dt);
    this.rollVisual = damp(this.rollVisual, targetRollVis,    rolL, dt);

    this.yaw   += this.yawRate * dt;
    this.pitch += this.pitchRate * dt;
    this.pitch = clamp(this.pitch, -0.95, 0.95);

    // ---- auto roll-leveling: when no roll input, gently drift back to 0 ----
    if (Math.abs(v.roll) < 0.05 && Math.abs(this.barrelRollAngle) < 0.001) {
      this.rollVisual = damp(this.rollVisual, 0, 3.5, dt);
    }

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
    const accent = new THREE.Color(this.skin.accent);
    const trim   = new THREE.Color(this.skin.trim);
    for (const g of this.engineGlows) {
      g.scale.setScalar(0.85 + sNorm * 1.7 + Math.sin(time * 30) * 0.05);
      g.material.opacity = 0.75 + sNorm * 0.25;
      g.material.color.copy(wantBoost ? trim : accent);
    }
    this.boostHalo.material.opacity = wantBoost ? 0.65 + Math.sin(time * 25) * 0.14 : 0;
    this.boostHalo.scale.setScalar(0.95 + sNorm * 1.3);
    this.shipLight.intensity = 1.4 + sNorm * 1.8;
    if (this.underGlow) this.underGlow.material.opacity = (wantBoost ? 0.30 : 0.10) + sNorm * 0.18;

    // nav light blinks
    for (const lt of this.dynamicLights) {
      const b = lt.userData.blink;
      b.phase += dt * (b.fast ? 6.5 : 2.6);
      const v2 = (Math.sin(b.phase) > 0.55) ? 1 : 0.15;
      lt.material.color.setHex(b.color);
      lt.material.opacity = v2;
      if (lt.material.transparent !== true) {
        lt.material.transparent = true;
      }
    }

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

    // shield bubble
    if (this.invuln > 0) {
      this.shieldBubble.material.opacity = 0.18 + Math.sin(time * 30) * 0.10;
    } else {
      this.shieldBubble.material.opacity = damp(this.shieldBubble.material.opacity, 0, 6, dt);
    }

    // weapon cooldown ticking
    if (this.fireCooldown > 0) this.fireCooldown -= dt;

    // drone helper position
    if (this.drone) {
      this.droneAngle += dt * 2.2;
      this.drone.position.set(
        Math.cos(this.droneAngle) * 2.2,
        0.6 + Math.sin(this.droneAngle * 1.5) * 0.2,
        Math.sin(this.droneAngle) * 2.2
      );
      this.drone.rotation.y = this.droneAngle;
    }

    this._updateTrails(dt);

    if (this.invuln > 0) {
      this.invuln = Math.max(0, this.invuln - dt);
      this.mesh.visible = (Math.floor(time * 18) % 2) === 0;
    } else {
      this.mesh.visible = true;
    }

    this.pos.copy(this.root.position);
  }

  // ---------- Weapons ----------
  tryFire() {
    if (!this.alive) return null;
    if (this.fireCooldown > 0) return null;
    this.fireCooldown = 1 / (5 * this.fireRateMul);

    // muzzle flash
    for (const m of this.barrels) {
      if (m.userData.flash) m.userData.flash.material.opacity = 1.0;
    }

    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.root.quaternion).normalize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.root.quaternion).normalize();

    // alternate between barrels for less spam-feel
    this.muzzleAlt ^= 1;

    const bullets = [];
    for (let i = 0; i < this.barrels.length; i++) {
      const m = this.barrels[i];
      const muzzleWorld = new THREE.Vector3();
      m.getWorldPosition(muzzleWorld);
      for (let s = 0; s < this.multishot; s++) {
        const offsetIdx = (s - (this.multishot - 1) / 2);
        const dir = fwd.clone().addScaledVector(right, offsetIdx * this.spread).normalize();
        // crit roll
        const crit = Math.random() < this.critChance;
        const dmg = this.bulletDamage * (crit ? this.critMul : 1);
        bullets.push({
          pos: muzzleWorld.clone(),
          dir,
          speed: this.bulletSpeed,
          damage: dmg,
          life: 2.0,
          pierce: this.pierce,
          aimAssist: this.aimAssist,
          crit
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
      aoe: 8 + this.missileAoe * 8
    };
  }

  damage(amount = 1) {
    if (this.invuln > 0 || !this.alive) return false;
    this.shields = Math.max(0, this.shields - amount);
    this.invuln = this.invulnTime;
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
