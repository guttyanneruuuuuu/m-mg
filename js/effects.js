// ===========================================================
// effects.js — particle systems for pickups, hits, boost trail.
// ===========================================================

import * as THREE from 'three';
import { rand, clamp } from './utils.js';

class Burst {
  constructor(scene, color, count = 24, life = 0.8) {
    this.scene = scene;
    this.life = life;
    this.t = 0;
    const positions = new Float32Array(count * 3);
    const vels = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const dir = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
      const sp = rand(8, 22);
      vels[i*3+0] = dir.x * sp;
      vels[i*3+1] = dir.y * sp;
      vels[i*3+2] = dir.z * sp;
    }
    this.vels = vels;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color, size: 0.6, sizeAttenuation: true,
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

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.bursts = [];
  }
  spawnPickup(pos, color = 0xff6ec7) {
    const b = new Burst(this.scene, color, 22, 0.7);
    b.setOrigin(pos);
    this.bursts.push(b);
  }
  spawnRing(pos) {
    const b = new Burst(this.scene, 0x7df9ff, 36, 0.9);
    b.setOrigin(pos);
    this.bursts.push(b);
  }
  spawnHit(pos) {
    const b = new Burst(this.scene, 0xff3b6b, 40, 1.1);
    b.setOrigin(pos);
    this.bursts.push(b);
  }
  spawnBoost(pos) {
    const b = new Burst(this.scene, 0xb388ff, 18, 0.5);
    b.setOrigin(pos);
    this.bursts.push(b);
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
