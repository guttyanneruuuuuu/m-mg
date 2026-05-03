// ===========================================================
// enemies.js — enemy ships, projectiles, boss
//   - EnemyManager spawns enemies in waves ahead of the player
//   - Multiple enemy types (scout, fighter, gunship, bomber)
//   - Boss appears at end of each stage (every 200 stage-distance)
//   - ProjectileManager handles bullets & missiles for both
//     player and enemies, with simple physics + collisions.
// ===========================================================

import * as THREE from 'three';
import { rand, randInt, choose, clamp, lerp } from './utils.js';

// ---------------- ENEMY ARCHETYPES ----------------
// Stats scale with stage. baseHp/baseDmg are at stage 1.
const ARCHETYPES = {
  scout: {
    baseHp: 2, baseDmg: 1, speed: 60, fireRate: 0.6, fireRange: 110, color: 0xff6e7d,
    salvage: 6, score: 80, weight: 5, xpForKill: 1
  },
  fighter: {
    baseHp: 4, baseDmg: 1, speed: 50, fireRate: 0.9, fireRange: 130, color: 0xffb547,
    salvage: 12, score: 160, weight: 4, xpForKill: 2
  },
  gunship: {
    baseHp: 8, baseDmg: 2, speed: 32, fireRate: 1.6, fireRange: 150, color: 0xff5fa2,
    salvage: 22, score: 320, weight: 2, xpForKill: 3
  },
  bomber: {
    baseHp: 12, baseDmg: 2, speed: 26, fireRate: 0.5, fireRange: 160, color: 0xb388ff,
    salvage: 32, score: 480, weight: 1, xpForKill: 4
  }
};

function pickArchetype(stage) {
  // weight pool — gunship/bomber show up more in later stages
  const w = {
    scout: ARCHETYPES.scout.weight + Math.max(0, 5 - stage),
    fighter: ARCHETYPES.fighter.weight,
    gunship: ARCHETYPES.gunship.weight + Math.min(stage * 0.3, 6),
    bomber: ARCHETYPES.bomber.weight + Math.min(stage * 0.18, 4)
  };
  const total = w.scout + w.fighter + w.gunship + w.bomber;
  let r = Math.random() * total;
  if ((r -= w.scout) < 0) return 'scout';
  if ((r -= w.fighter) < 0) return 'fighter';
  if ((r -= w.gunship) < 0) return 'gunship';
  return 'bomber';
}

export class Enemy {
  constructor(scene, kind, stage, spawnPos) {
    this.scene = scene;
    this.kind = kind;
    const arch = ARCHETYPES[kind];
    // scaling: ~ +18% hp and +12% dmg per stage
    const hpScale  = Math.pow(1.18, stage - 1);
    const dmgScale = Math.pow(1.10, stage - 1);
    const speedScale = 1 + (stage - 1) * 0.04;
    this.hp = Math.ceil(arch.baseHp * hpScale);
    this.maxHp = this.hp;
    this.contactDamage = arch.baseDmg;
    this.shotDamage = Math.max(1, Math.round(arch.baseDmg * dmgScale));
    this.speed = arch.speed * speedScale;
    this.fireRate = arch.fireRate;
    this.fireRange = arch.fireRange;
    this.fireCd = rand(0.5, 1.5);
    this.color = arch.color;
    this.salvageReward = Math.ceil(arch.salvage * (1 + (stage - 1) * 0.06));
    this.scoreReward   = Math.ceil(arch.score   * (1 + (stage - 1) * 0.08));
    this.xpForKill = arch.xpForKill;

    this.alive = true;
    this.t = 0;
    this.bobPhase = rand(0, Math.PI * 2);

    this.root = new THREE.Group();
    this.root.position.copy(spawnPos);
    this._build();
    this.scene.add(this.root);

    this.radius = this.kind === 'bomber' ? 3.4
                : this.kind === 'gunship' ? 2.8
                : this.kind === 'fighter' ? 2.0 : 1.6;
  }

  _build() {
    const c = this.color;
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x16161e, emissive: c, emissiveIntensity: 0.25,
      metalness: 0.85, roughness: 0.35
    });
    const glowMat = new THREE.MeshBasicMaterial({
      color: c, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending
    });

    if (this.kind === 'scout') {
      // small dart
      const body = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.8, 10), baseMat);
      body.rotation.x = Math.PI / 2;
      this.root.add(body);
      const wing = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.1, 0.7), baseMat);
      wing.position.set(0, 0, 0.3);
      this.root.add(wing);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), glowMat);
      eye.position.set(0, 0.0, -0.9);
      this.root.add(eye);
      this.eye = eye;
    } else if (this.kind === 'fighter') {
      // X-wing-ish
      const body = new THREE.Mesh(new THREE.OctahedronGeometry(0.7, 0), baseMat);
      body.scale.set(0.7, 0.5, 1.5);
      this.root.add(body);
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.1, 0.5), baseMat);
        w.position.set(sx * 0.95, sy * 0.45, 0.5);
        w.rotation.z = sx * sy * 0.15;
        this.root.add(w);
        // tip lights
        const tl = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), glowMat);
        tl.position.set(sx * 1.6, sy * 0.5, 0.6);
        this.root.add(tl);
      }
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), glowMat);
      eye.position.set(0, 0.05, -0.9);
      this.root.add(eye);
      this.eye = eye;
    } else if (this.kind === 'gunship') {
      // wider, twin-cannons
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 2.4), baseMat);
      this.root.add(body);
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.45, 1.2), baseMat);
      top.position.y = 0.5;
      this.root.add(top);
      for (const s of [-1, 1]) {
        const cannon = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 1.4, 8), baseMat);
        cannon.rotation.x = Math.PI / 2;
        cannon.position.set(s * 0.85, -0.15, -0.7);
        this.root.add(cannon);
      }
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.15, 0.05), glowMat);
      eye.position.set(0, 0.4, -1.15);
      this.root.add(eye);
      this.eye = eye;
    } else { // bomber
      const body = new THREE.Mesh(new THREE.IcosahedronGeometry(1.8, 1), baseMat);
      body.scale.set(1.4, 0.7, 1.6);
      this.root.add(body);
      // hanging bombs
      for (const s of [-1, 1]) {
        const bomb = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), baseMat);
        bomb.position.set(s * 1.0, -0.6, 0.1);
        this.root.add(bomb);
      }
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), glowMat);
      eye.position.set(0, 0.0, -1.6);
      this.root.add(eye);
      this.eye = eye;
    }

    // engine glow back
    const engine = new THREE.Mesh(
      new THREE.CircleGeometry(0.45, 18),
      new THREE.MeshBasicMaterial({
        color: c, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    engine.position.z = 1.2;
    engine.rotation.y = Math.PI;
    this.root.add(engine);
    this.engineGlow = engine;

    // halo
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(this.kind === 'bomber' ? 2.6 : this.kind === 'gunship' ? 2.0 : 1.4, 14, 10),
      new THREE.MeshBasicMaterial({
        color: c, transparent: true, opacity: 0.15,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    this.root.add(halo);
  }

  // -----------------------------------------------------------
  // AI: maintain a position relative to the player, occasionally fire
  // -----------------------------------------------------------
  update(dt, time, playerPos, fireCallback) {
    if (!this.alive) return;
    this.t += dt;
    this.fireCd -= dt;
    this.bobPhase += dt;

    // move strategy: stay ahead of player but not too close, sway side-to-side
    const toPlayer = playerPos.clone().sub(this.root.position);
    const dz = toPlayer.z; // -ve = enemy is ahead of player (smaller z)
    const distXY = Math.hypot(toPlayer.x, toPlayer.y);
    const distAll = toPlayer.length();

    // desired offset relative to player: ~ -50..-90 z (in front), with sway
    const desiredZ = playerPos.z - 60 - Math.sin(this.bobPhase * 0.6) * 18;
    const desiredX = playerPos.x + Math.sin(this.bobPhase * 0.9 + this.maxHp) * 30;
    const desiredY = playerPos.y + Math.cos(this.bobPhase * 0.7 + this.maxHp) * 18;

    // velocity
    const dx = desiredX - this.root.position.x;
    const dy = desiredY - this.root.position.y;
    const dzd = desiredZ - this.root.position.z;
    const len = Math.hypot(dx, dy, dzd) + 1e-5;
    const sp = this.speed;
    this.root.position.x += (dx / len) * sp * dt;
    this.root.position.y += (dy / len) * sp * dt;
    this.root.position.z += (dzd / len) * sp * dt;

    // face the player softly
    const faceTarget = new THREE.Vector3(playerPos.x, playerPos.y, playerPos.z);
    this.root.lookAt(faceTarget);

    // engine glow pulse
    if (this.engineGlow) {
      this.engineGlow.scale.setScalar(0.85 + Math.sin(time * 12 + this.maxHp) * 0.1);
    }
    if (this.eye) {
      // pulse when about to fire
      const cd = clamp(1 - Math.max(0, this.fireCd) / 1.6, 0, 1);
      this.eye.material.opacity = 0.5 + cd * 0.5;
    }

    // fire?
    if (this.fireCd <= 0 && distAll < this.fireRange && fireCallback) {
      // aim forward toward player
      const dir = new THREE.Vector3()
        .subVectors(playerPos, this.root.position)
        .normalize();
      const muzzlePos = this.root.position.clone().add(dir.clone().multiplyScalar(1.4));
      fireCallback({
        pos: muzzlePos,
        dir,
        speed: 80 + Math.random() * 18,
        damage: this.shotDamage,
        life: 2.4,
        color: this.color,
        enemy: true
      });
      this.fireCd = (1 / this.fireRate) * (0.8 + Math.random() * 0.6);
    }

    // dispose if too far behind player (out of bounds)
    if (this.root.position.z > playerPos.z + 80) this.alive = false;
  }

  takeDamage(d) {
    this.hp -= d;
    if (this.hp <= 0) {
      this.alive = false;
      return true;
    }
    return false;
  }

  dispose() {
    this.scene.remove(this.root);
    this.root.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
        else o.material.dispose();
      }
    });
  }
}

// ---------------- BOSS ----------------
export class Boss extends Enemy {
  constructor(scene, stage, spawnPos) {
    // hijack constructor: build manually
    super(scene, 'gunship', stage, spawnPos); // still uses gunship base for code reuse
    // override visuals + stats
    this.scene.remove(this.root);
    this.root = new THREE.Group();
    this.root.position.copy(spawnPos);
    this.kind = 'boss';
    this.color = 0xff3b6b;

    // Boss HP scales heavily
    this.maxHp = 70 + stage * 30;
    this.hp = this.maxHp;
    this.contactDamage = 2;
    this.shotDamage = 2 + Math.floor(stage * 0.4);
    this.speed = 22 + stage * 0.3;
    this.fireRate = 1.6 + Math.min(stage * 0.05, 1.5);
    this.fireRange = 240;
    this.fireCd = 1.2;
    this.salvageReward = 200 + stage * 60;
    this.scoreReward = 5000 + stage * 1500;
    this.xpForKill = 30 + stage * 5;
    this.radius = 8;

    this._buildBoss(stage);
    this.scene.add(this.root);

    this.firePhase = 0;
  }

  _buildBoss(stage) {
    const c = 0xff3b6b;
    const accent = 0xff9b6e;
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a14, emissive: c, emissiveIntensity: 0.35,
      metalness: 0.9, roughness: 0.3
    });
    const glow = new THREE.MeshBasicMaterial({
      color: c, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending
    });
    const accentGlow = new THREE.MeshBasicMaterial({
      color: accent, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending
    });

    // huge core
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(3.4, 1), baseMat);
    core.scale.set(1.5, 0.8, 1.7);
    this.root.add(core);
    this.coreMesh = core;

    // 4 wing pylons in cross
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 6.0), baseMat);
      arm.position.set(Math.cos(a) * 4, Math.sin(a) * 4 * 0.5, 0);
      arm.rotation.z = a;
      this.root.add(arm);
      // tip cannon
      const cannon = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 1.6, 12), baseMat);
      cannon.rotation.x = Math.PI / 2;
      cannon.position.set(Math.cos(a) * 6.6, Math.sin(a) * 6.6 * 0.5, -1);
      this.root.add(cannon);
      const tipLight = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 8), glow);
      tipLight.position.set(Math.cos(a) * 6.6, Math.sin(a) * 6.6 * 0.5, -1.8);
      this.root.add(tipLight);
    }

    // spinning energy ring
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(5.5, 0.3, 14, 64),
      accentGlow
    );
    this.root.add(ring);
    this.bossRing = ring;

    // central evil eye
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 12), glow);
    eye.position.set(0, 0, -2.5);
    this.root.add(eye);
    this.eye = eye;

    // halo
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(8, 18, 14),
      new THREE.MeshBasicMaterial({
        color: c, transparent: true, opacity: 0.18,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    this.root.add(halo);

    // engine
    const engine = new THREE.Mesh(
      new THREE.CircleGeometry(2.0, 22),
      new THREE.MeshBasicMaterial({
        color: c, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    engine.position.z = 3.5;
    engine.rotation.y = Math.PI;
    this.root.add(engine);
    this.engineGlow = engine;
  }

  update(dt, time, playerPos, fireCallback) {
    if (!this.alive) return;
    this.t += dt;
    this.fireCd -= dt;
    this.firePhase += dt;
    this.bobPhase += dt;

    // boss orbits around a forward pivot point
    const desiredZ = playerPos.z - 90 + Math.sin(this.t * 0.4) * 12;
    const desiredX = playerPos.x + Math.sin(this.t * 0.6) * 50;
    const desiredY = playerPos.y + Math.cos(this.t * 0.5) * 30;

    const dx = desiredX - this.root.position.x;
    const dy = desiredY - this.root.position.y;
    const dz = desiredZ - this.root.position.z;
    const len = Math.hypot(dx, dy, dz) + 1e-5;
    const sp = this.speed;
    this.root.position.x += (dx / len) * sp * dt;
    this.root.position.y += (dy / len) * sp * dt;
    this.root.position.z += (dz / len) * sp * dt;

    // spin ring + face player
    if (this.bossRing) this.bossRing.rotation.z += dt * 1.5;
    if (this.coreMesh) this.coreMesh.rotation.y += dt * 0.4;

    const faceT = playerPos.clone();
    this.root.lookAt(faceT);

    if (this.fireCd <= 0 && fireCallback) {
      // boss fires a spread of 4-6 bullets
      const dir = new THREE.Vector3().subVectors(playerPos, this.root.position).normalize();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.root.quaternion).normalize();
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.root.quaternion).normalize();
      const N = 5;
      for (let i = 0; i < N; i++) {
        const ang = (i - (N - 1) / 2) * 0.10;
        const d = dir.clone().addScaledVector(right, ang).normalize();
        fireCallback({
          pos: this.root.position.clone().add(d.clone().multiplyScalar(2.0)),
          dir: d,
          speed: 95,
          damage: this.shotDamage,
          life: 3.0,
          color: 0xff3b6b,
          enemy: true,
          big: true
        });
      }
      this.fireCd = 1.0 / this.fireRate;
    }
  }
}

// ---------------- ENEMY MANAGER ----------------
export class EnemyManager {
  constructor(scene) {
    this.scene = scene;
    this.enemies = [];
    this.boss = null;
    this.stage = 1;
    this.waveIndex = 0;
    this.spawnTimer = 0;
    this.spawnInterval = 2.0;
    this.distanceForBoss = 200;     // travelled distance for boss to appear in current stage
    this.stageStartZ = 0;
    this.bossSpawned = false;
    this.bossDefeated = false;
    this.maxAlive = 6;
  }

  setStage(stage, playerZ) {
    this.stage = stage;
    this.waveIndex = 0;
    this.bossSpawned = false;
    this.bossDefeated = false;
    this.stageStartZ = playerZ;
    this.spawnTimer = 1.5;
    // tighter spawn interval per stage (faster waves)
    this.spawnInterval = Math.max(0.7, 2.2 - stage * 0.04);
    this.maxAlive = Math.min(12, 5 + Math.floor(stage / 4));
  }

  cleanup() {
    for (const e of this.enemies) e.dispose();
    this.enemies = [];
    if (this.boss) { this.boss.dispose(); this.boss = null; }
  }

  spawnEnemy(playerPos) {
    if (this.enemies.length >= this.maxAlive) return;
    const kind = pickArchetype(this.stage);
    // spawn far ahead of player, with random offset
    const angle = rand(0, Math.PI * 2);
    const radius = rand(20, 60);
    const offsetX = Math.cos(angle) * radius;
    const offsetY = Math.sin(angle) * radius * 0.6;
    const offsetZ = rand(-180, -120);
    const pos = new THREE.Vector3(
      playerPos.x + offsetX,
      playerPos.y + offsetY,
      playerPos.z + offsetZ
    );
    const e = new Enemy(this.scene, kind, this.stage, pos);
    this.enemies.push(e);
  }

  spawnBoss(playerPos) {
    if (this.bossSpawned) return;
    this.bossSpawned = true;
    const pos = new THREE.Vector3(
      playerPos.x,
      playerPos.y + 10,
      playerPos.z - 200
    );
    this.boss = new Boss(this.scene, this.stage, pos);
  }

  update(dt, time, playerPos, fireCallback) {
    // spawn waves
    if (!this.bossSpawned) {
      const distInStage = this.stageStartZ - playerPos.z;
      // stop spawning fodder once close to boss arrival
      if (distInStage > this.distanceForBoss) {
        this.spawnBoss(playerPos);
      } else {
        this.spawnTimer -= dt;
        if (this.spawnTimer <= 0) {
          this.spawnEnemy(playerPos);
          this.spawnTimer = this.spawnInterval * (0.8 + Math.random() * 0.5);
        }
      }
    }

    // update enemies
    for (const e of this.enemies) e.update(dt, time, playerPos, fireCallback);
    // boss
    if (this.boss && this.boss.alive) this.boss.update(dt, time, playerPos, fireCallback);

    // cleanup dead
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (!this.enemies[i].alive) {
        this.enemies[i].dispose();
        this.enemies.splice(i, 1);
      }
    }
    if (this.boss && !this.boss.alive) {
      this.boss.dispose();
      this.boss = null;
      this.bossDefeated = true;
    }
  }

  // Iterate all enemies + boss for collision tests
  *all() {
    for (const e of this.enemies) if (e.alive) yield e;
    if (this.boss && this.boss.alive) yield this.boss;
  }
}

// ---------------- PROJECTILES ----------------
export class ProjectileManager {
  constructor(scene) {
    this.scene = scene;
    this.playerBullets = [];
    this.enemyBullets = [];
    this.missiles = [];

    // pre-built materials
    this.playerMat = new THREE.MeshBasicMaterial({
      color: 0x88ffff, transparent: true, opacity: 1.0,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    this.playerGeo = new THREE.CylinderGeometry(0.07, 0.07, 1.5, 6);
    this.playerGeo.rotateX(Math.PI / 2);

    this.enemyMat = new THREE.MeshBasicMaterial({
      color: 0xff6e7d, transparent: true, opacity: 1.0,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    this.enemyGeo = new THREE.CylinderGeometry(0.10, 0.10, 1.4, 6);
    this.enemyGeo.rotateX(Math.PI / 2);

    this.missileGeo = new THREE.ConeGeometry(0.25, 1.2, 8);
    this.missileGeo.rotateX(-Math.PI / 2);
    this.missileMat = new THREE.MeshStandardMaterial({
      color: 0xfff2c8, emissive: 0xffd86b, emissiveIntensity: 1.4,
      metalness: 0.6, roughness: 0.3
    });
  }

  cleanup() {
    for (const b of this.playerBullets) this.scene.remove(b.mesh);
    for (const b of this.enemyBullets)  this.scene.remove(b.mesh);
    for (const m of this.missiles)      this.scene.remove(m.mesh);
    this.playerBullets = [];
    this.enemyBullets = [];
    this.missiles = [];
  }

  spawnPlayerBullet(spec) {
    const m = new THREE.Mesh(this.playerGeo, this.playerMat.clone());
    m.position.copy(spec.pos);
    // orient along dir
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), spec.dir.clone().normalize());
    m.quaternion.copy(q);
    this.scene.add(m);
    // halo
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.35, 10, 8),
      new THREE.MeshBasicMaterial({
        color: 0x88ffff, transparent: true, opacity: 0.65,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    halo.position.copy(spec.pos);
    this.scene.add(halo);

    // crit-tinted bullets are bigger
    if (spec.crit) {
      m.scale.setScalar(1.6);
      halo.scale.setScalar(1.5);
      m.material.color.setHex(0xffd86b);
      halo.material.color.setHex(0xffd86b);
    }
    this.playerBullets.push({
      mesh: m, halo, dir: spec.dir.clone(), speed: spec.speed || 220,
      damage: spec.damage || 1, life: spec.life || 2.0,
      pierce: spec.pierce || 0, hits: new Set(),
      aimAssist: spec.aimAssist || 0,
      crit: !!spec.crit
    });
  }

  spawnEnemyBullet(spec) {
    const matC = spec.color ?? 0xff6e7d;
    const mat = new THREE.MeshBasicMaterial({
      color: matC, transparent: true, opacity: 1.0,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    const m = new THREE.Mesh(this.enemyGeo, mat);
    if (spec.big) m.scale.set(1.5, 1.5, 1.5);
    m.position.copy(spec.pos);
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), spec.dir.clone().normalize());
    m.quaternion.copy(q);
    this.scene.add(m);
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(spec.big ? 0.55 : 0.4, 10, 8),
      new THREE.MeshBasicMaterial({
        color: matC, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    halo.position.copy(spec.pos);
    this.scene.add(halo);

    this.enemyBullets.push({
      mesh: m, halo, dir: spec.dir.clone(), speed: spec.speed || 80,
      damage: spec.damage || 1, life: spec.life || 2.4
    });
  }

  spawnMissile(spec) {
    const m = new THREE.Mesh(this.missileGeo, this.missileMat.clone());
    m.position.copy(spec.pos);
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), spec.dir.clone().normalize());
    m.quaternion.copy(q);
    this.scene.add(m);
    // trail flame
    const flame = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 10, 8),
      new THREE.MeshBasicMaterial({
        color: 0xffd86b, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    flame.position.copy(spec.pos);
    this.scene.add(flame);

    this.missiles.push({
      mesh: m, flame, dir: spec.dir.clone(), speed: spec.speed || 90,
      damage: spec.damage || 6, life: spec.life || 4.0,
      target: null, homing: spec.homing,
      aoe: spec.aoe || 8
    });
  }

  // returns array of damage events: { kind: 'enemyHit', enemy, damage } or 'playerHit'
  update(dt, enemies, player) {
    const events = [];

    // player bullets
    for (let i = this.playerBullets.length - 1; i >= 0; i--) {
      const b = this.playerBullets[i];
      b.life -= dt;

      // ===== Aim assist: gently steer the bullet toward the closest enemy
      // within a forward cone. Strength comes from upgrades / equipment.
      if (b.aimAssist > 0) {
        let best = null, bestScore = -1;
        for (const e of enemies) {
          if (b.hits.has(e)) continue;
          const to = e.root.position.clone().sub(b.mesh.position);
          const dist = to.length();
          if (dist < 1 || dist > 80) continue;
          to.normalize();
          const dot = to.dot(b.dir);
          if (dot < 0.85) continue; // only enemies within ~32° forward cone
          const score = dot * (1 / (1 + dist * 0.04));
          if (score > bestScore) { bestScore = score; best = { e, to, dist }; }
        }
        if (best) {
          const t = clamp(b.aimAssist * 1.2, 0, 0.35);
          b.dir.lerp(best.to, t).normalize();
          // re-orient mesh
          const q = new THREE.Quaternion();
          q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), b.dir);
          b.mesh.quaternion.copy(q);
        }
      }

      const step = b.dir.clone().multiplyScalar(b.speed * dt);
      b.mesh.position.add(step);
      b.halo.position.copy(b.mesh.position);

      let consumed = false;
      // collide with enemies
      for (const e of enemies) {
        if (b.hits.has(e)) continue;
        const d = b.mesh.position.distanceTo(e.root.position);
        if (d < e.radius + 0.6) {
          events.push({ kind: 'enemyHit', enemy: e, damage: b.damage, pos: b.mesh.position.clone(), crit: b.crit });
          b.hits.add(e);
          if (b.pierce > 0) { b.pierce--; }
          else { consumed = true; }
          break;
        }
      }

      if (consumed || b.life <= 0) {
        this.scene.remove(b.mesh); this.scene.remove(b.halo);
        b.mesh.material.dispose();
        b.halo.material.dispose(); b.halo.geometry.dispose();
        this.playerBullets.splice(i, 1);
      }
    }

    // enemy bullets
    for (let i = this.enemyBullets.length - 1; i >= 0; i--) {
      const b = this.enemyBullets[i];
      b.life -= dt;
      const step = b.dir.clone().multiplyScalar(b.speed * dt);
      b.mesh.position.add(step);
      b.halo.position.copy(b.mesh.position);

      let consumed = false;
      // collide with player
      if (player.alive) {
        const d = b.mesh.position.distanceTo(player.pos);
        if (d < 1.6) {
          events.push({ kind: 'playerHit', damage: b.damage, pos: b.mesh.position.clone() });
          consumed = true;
        }
      }

      if (consumed || b.life <= 0) {
        this.scene.remove(b.mesh); this.scene.remove(b.halo);
        b.mesh.material.dispose();
        b.halo.material.dispose(); b.halo.geometry.dispose();
        this.enemyBullets.splice(i, 1);
      }
    }

    // missiles — homing on nearest enemy
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.life -= dt;
      // pick target
      if (m.homing) {
        let best = null, bestD = 200;
        for (const e of enemies) {
          const d = m.mesh.position.distanceTo(e.root.position);
          if (d < bestD) { best = e; bestD = d; }
        }
        if (best) {
          const desired = new THREE.Vector3().subVectors(best.root.position, m.mesh.position).normalize();
          m.dir.lerp(desired, 0.08).normalize();
          const q = new THREE.Quaternion();
          q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), m.dir);
          m.mesh.quaternion.copy(q);
        }
      }
      m.speed += dt * 30; // accelerate
      const step = m.dir.clone().multiplyScalar(m.speed * dt);
      m.mesh.position.add(step);
      m.flame.position.copy(m.mesh.position);
      m.flame.material.opacity = 0.6 + Math.random() * 0.4;
      m.flame.scale.setScalar(0.9 + Math.random() * 0.4);

      let consumed = false;
      // collide with enemies (AOE)
      const aoe = m.aoe || 8;
      for (const e of enemies) {
        const d = m.mesh.position.distanceTo(e.root.position);
        if (d < e.radius + 1.0) {
          // splash: hit nearby enemies too
          for (const e2 of enemies) {
            const d2 = m.mesh.position.distanceTo(e2.root.position);
            if (d2 < aoe) {
              const falloff = clamp(1 - d2 / aoe, 0.3, 1);
              events.push({ kind: 'enemyHit', enemy: e2, damage: m.damage * falloff, pos: m.mesh.position.clone() });
            }
          }
          events.push({ kind: 'explosion', pos: m.mesh.position.clone(), big: true });
          consumed = true;
          break;
        }
      }

      if (consumed || m.life <= 0) {
        this.scene.remove(m.mesh); this.scene.remove(m.flame);
        m.mesh.material.dispose();
        m.flame.material.dispose(); m.flame.geometry.dispose();
        this.missiles.splice(i, 1);
      }
    }

    return events;
  }
}
