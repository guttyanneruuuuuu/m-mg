// ===========================================================
// effects.js — particle bursts for combat
//   - explosions (small / big), hits, salvage pickups, muzzle, levelup
// ===========================================================

import * as THREE from 'three';
import { rand, clamp } from './utils.js';

class Burst {
  constructor(scene, color, count = 24, life = 0.8, speedMul = 1) {
    this.scene = scene;
    this.life = life;
    this.t = 0;
    const positions = new Float32Array(count * 3);
    const vels = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const dir = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
      const sp = rand(8, 22) * speedMul;
      vels[i*3+0] = dir.x * sp;
      vels[i*3+1] = dir.y * sp;
      vels[i*3+2] = dir.z * sp;
    }
    this.vels = vels;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color, size: 0.7, sizeAttenuation: true,
      transparent: true, opacity: 1.0,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    this.points = new THREE.Points(geo, mat);
    this.scene.add(this.points);
  }
  setOrigin(p) {
    const arr = this.points.geometry.attributes.position.array;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] = p.x; arr[i+1] = p.y; arr[i+2] = p.z;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
  update(dt) {
    this.t += dt;
    const arr = this.points.geometry.attributes.position.array;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i]   += this.vels[i]   * dt;
      arr[i+1] += this.vels[i+1] * dt;
      arr[i+2] += this.vels[i+2] * dt;
      this.vels[i]   *= 0.94;
      this.vels[i+1] *= 0.94;
      this.vels[i+2] *= 0.94;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.material.opacity = clamp(1 - this.t / this.life, 0, 1);
    return this.t < this.life;
  }
  dispose() {
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}

// Expanding shockwave ring for big explosions
class ShockRing {
  constructor(scene, color, life = 0.6, maxScale = 12) {
    this.scene = scene;
    this.life = life;
    this.maxScale = maxScale;
    this.t = 0;
    const geo = new THREE.RingGeometry(0.5, 0.7, 32);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 1.0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.scene.add(this.mesh);
  }
  setOrigin(p, lookCam) {
    this.mesh.position.copy(p);
    if (lookCam) this.mesh.lookAt(lookCam);
  }
  update(dt) {
    this.t += dt;
    const k = this.t / this.life;
    const s = 1 + k * this.maxScale;
    this.mesh.scale.set(s, s, s);
    this.mesh.material.opacity = clamp(1 - k, 0, 1);
    return this.t < this.life;
  }
  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

// Sphere flash
class Flash {
  constructor(scene, color, life = 0.35, maxScale = 4) {
    this.scene = scene;
    this.life = life;
    this.maxScale = maxScale;
    this.t = 0;
    const geo = new THREE.SphereGeometry(0.6, 14, 10);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 1.0,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.scene.add(this.mesh);
  }
  setOrigin(p) { this.mesh.position.copy(p); }
  update(dt) {
    this.t += dt;
    const k = this.t / this.life;
    const s = 1 + k * this.maxScale;
    this.mesh.scale.set(s, s, s);
    this.mesh.material.opacity = clamp(1 - k * 1.2, 0, 1);
    return this.t < this.life;
  }
  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

export class Effects {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.bursts = [];
  }
  setCamera(cam) { this.camera = cam; }
  spawnPickup(pos, color = 0x88ffd6) {
    const b = new Burst(this.scene, color, 22, 0.7, 1);
    b.setOrigin(pos);
    this.bursts.push(b);
  }
  spawnHit(pos, color = 0x88ffff) {
    const b = new Burst(this.scene, color, 14, 0.4, 1);
    b.setOrigin(pos);
    this.bursts.push(b);
    const f = new Flash(this.scene, color, 0.2, 2);
    f.setOrigin(pos);
    this.bursts.push(f);
  }
  spawnExplosion(pos, big = false) {
    const c1 = big ? 0xffd86b : 0xff9b6e;
    const c2 = big ? 0xff6ec7 : 0xff5fa2;
    const b1 = new Burst(this.scene, c1, big ? 60 : 30, big ? 1.4 : 0.9, big ? 1.6 : 1.2);
    b1.setOrigin(pos);
    this.bursts.push(b1);
    const b2 = new Burst(this.scene, c2, big ? 48 : 22, big ? 1.2 : 0.7, big ? 2.0 : 1.4);
    b2.setOrigin(pos);
    this.bursts.push(b2);
    const f = new Flash(this.scene, big ? 0xfff2c8 : 0xffd86b, big ? 0.45 : 0.25, big ? 8 : 4);
    f.setOrigin(pos);
    this.bursts.push(f);
    if (big) {
      const r = new ShockRing(this.scene, 0xff9b6e, 0.7, 18);
      r.setOrigin(pos, this.camera ? this.camera.position : null);
      this.bursts.push(r);
    }
  }
  spawnPlayerHit(pos) {
    const b = new Burst(this.scene, 0xff3b6b, 36, 1.0, 1.5);
    b.setOrigin(pos);
    this.bursts.push(b);
    const f = new Flash(this.scene, 0xff3b6b, 0.3, 3);
    f.setOrigin(pos);
    this.bursts.push(f);
  }
  spawnLevelUp(pos) {
    const b = new Burst(this.scene, 0xffd86b, 50, 1.2, 1.8);
    b.setOrigin(pos);
    this.bursts.push(b);
    const r = new ShockRing(this.scene, 0xffd86b, 0.7, 8);
    r.setOrigin(pos, this.camera ? this.camera.position : null);
    this.bursts.push(r);
  }
  update(dt) {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const alive = this.bursts[i].update(dt);
      if (!alive) {
        this.bursts[i].dispose();
        this.bursts.splice(i, 1);
      }
    }
  }
}
