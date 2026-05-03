// ===========================================================
// world.js — STARFORGE: deep space combat arena
//   - Procedural starfield, nebula clouds, distant planets
//   - Asteroid hazards (destructible -> drop salvage points)
//   - Drifting space debris / abandoned stations as set pieces
//   - Power capsules (shield / energy / mega salvage)
//   - Enemy spawning is delegated to main.js / EnemyManager,
//     but world-scale background is fully space-themed.
// ===========================================================

import * as THREE from 'three';
import { rand, randInt, choose, clamp, lerp } from './utils.js';

const NEBULA_PALETTES = [
  { c1: 0x4a1f6b, c2: 0x1f4a8b, c3: 0xff5fa2, name: 'violet rift' },
  { c1: 0x0a2a55, c2: 0x6b1f4a, c3: 0x7df9ff, name: 'azure storm' },
  { c1: 0x2a0a3a, c2: 0x4a1f1f, c3: 0xff7d3a, name: 'crimson cluster' },
  { c1: 0x1a3a5a, c2: 0x2a1a5a, c3: 0x88ffd6, name: 'cyan frontier' },
  { c1: 0x3a1a4a, c2: 0x1a3a3a, c3: 0xc4b5ff, name: 'amethyst veil' },
];

export class World {
  constructor(scene, quality = 'med') {
    this.scene = scene;
    this.quality = quality;

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.chunks = [];
    this.chunkLength = 240;
    this.aheadChunks = quality === 'high' ? 8 : quality === 'med' ? 6 : 5;
    this.behindChunks = 1;
    this.spawnZ = 0;
    this.travelled = 0;
    this.stage = 1;
    this.palette = choose(NEBULA_PALETTES);

    this._setupSpace();
    this._setupLights();
    this._setupStarfield();
    this._setupNebula();
    this._setupDistantPlanets();
  }

  setStage(stage) {
    this.stage = stage;
    // shift palette every few stages
    const idx = Math.floor((stage - 1) / 3) % NEBULA_PALETTES.length;
    const p = NEBULA_PALETTES[idx];
    this.palette = p;
    if (this.nebulaA) {
      this.nebulaA.material.uniforms.c1.value.set(p.c1);
      this.nebulaA.material.uniforms.c2.value.set(p.c2);
      this.nebulaA.material.uniforms.c3.value.set(p.c3);
    }
  }

  // -----------------------------------------------------------
  _setupSpace() {
    // Deep starry void backdrop with subtle nebula color
    const geo = new THREE.SphereGeometry(2800, 48, 24);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x010109) },
        midColor: { value: new THREE.Color(0x0a0822) },
        botColor: { value: new THREE.Color(0x05030f) },
        time:     { value: 0 }
      },
      vertexShader: `
        varying vec3 vN;
        void main(){
          vN = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 midColor;
        uniform vec3 botColor;
        uniform float time;
        varying vec3 vN;
        // hash-based subtle nebula tint
        float hash(vec3 p){
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x*p.y*p.z*(p.x+p.y+p.z));
        }
        void main(){
          float h = clamp((vN.y + 1.0) * 0.5, 0.0, 1.0);
          vec3 col = mix(botColor, midColor, smoothstep(0.0, 0.6, h));
          col = mix(col, topColor, smoothstep(0.6, 1.0, h));
          // ultra-faint nebula tint
          float n = hash(floor(vN * 8.0));
          col += vec3(0.03, 0.02, 0.06) * n;
          gl_FragColor = vec4(col, 1.0);
        }
      `
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    this.scene.fog = new THREE.FogExp2(0x05030f, 0.0010);
  }

  _setupLights() {
    const hemi = new THREE.HemisphereLight(0x6080ff, 0x110024, 0.45);
    this.scene.add(hemi);

    // distant blue-white star (key light)
    const dir = new THREE.DirectionalLight(0xb6d8ff, 0.95);
    dir.position.set(60, 80, -100);
    this.scene.add(dir);
    this.starLight = dir;

    // magenta rim from a red-giant nearby
    const rim = new THREE.DirectionalLight(0xff5fa2, 0.55);
    rim.position.set(-100, -20, -40);
    this.scene.add(rim);

    // cyan fill
    const fill = new THREE.DirectionalLight(0x7df9ff, 0.25);
    fill.position.set(20, 40, 80);
    this.scene.add(fill);
  }

  _setupStarfield() {
    // Three layers of stars (near/mid/far) for parallax depth
    this.starLayers = [];
    const counts = this.quality === 'high'
      ? [1500, 900, 400]
      : this.quality === 'med' ? [900, 600, 280] : [600, 360, 180];
    const radii = [800, 1400, 2100];
    const sizes = [3.2, 5.5, 7.0];
    const tex = this._makeSpriteTexture();
    for (let li = 0; li < 3; li++) {
      const COUNT = counts[li];
      const positions = new Float32Array(COUNT * 3);
      const colors    = new Float32Array(COUNT * 3);
      for (let i = 0; i < COUNT; i++) {
        const r = radii[li] * (0.6 + Math.random() * 0.8);
        const a = Math.random() * Math.PI * 2;
        const b = (Math.random() - 0.5) * Math.PI;
        positions[i*3+0] = Math.cos(a) * Math.cos(b) * r;
        positions[i*3+1] = Math.sin(b) * r;
        positions[i*3+2] = Math.sin(a) * Math.cos(b) * r;
        const hueR = Math.random();
        let c;
        if (hueR < 0.7) c = new THREE.Color().setHSL(0.58, 0.1, rand(0.7, 1.0)); // white-blue
        else if (hueR < 0.88) c = new THREE.Color().setHSL(rand(0.55, 0.65), 0.6, 0.8); // cyan
        else if (hueR < 0.96) c = new THREE.Color().setHSL(rand(0.85, 0.95), 0.8, 0.7); // magenta
        else                  c = new THREE.Color().setHSL(rand(0.05, 0.10), 0.8, 0.7); // amber
        colors[i*3+0] = c.r; colors[i*3+1] = c.g; colors[i*3+2] = c.b;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.PointsMaterial({
        size: sizes[li], sizeAttenuation: true,
        vertexColors: true, transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending,
        map: tex, opacity: 0.95
      });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      this.scene.add(pts);
      this.starLayers.push({ pts, parallax: 0.2 + li * 0.25 });
    }
  }

  _makeSpriteTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.3, 'rgba(255,255,255,0.6)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _setupNebula() {
    // big additive plane behind everything that paints nebula clouds
    const geo = new THREE.SphereGeometry(2200, 48, 24);
    const p = this.palette;
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      transparent: true,
      blending: THREE.AdditiveBlending,
      uniforms: {
        c1: { value: new THREE.Color(p.c1) },
        c2: { value: new THREE.Color(p.c2) },
        c3: { value: new THREE.Color(p.c3) },
        time: { value: 0 }
      },
      vertexShader: `
        varying vec3 vN;
        void main(){
          vN = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 c1; uniform vec3 c2; uniform vec3 c3;
        uniform float time;
        varying vec3 vN;

        // simple 3D noise
        float hash(vec3 p){
          p = fract(p*0.3183099+0.1); p*=17.0;
          return fract(p.x*p.y*p.z*(p.x+p.y+p.z));
        }
        float noise(vec3 p){
          vec3 i = floor(p);
          vec3 f = fract(p);
          f = f*f*(3.0-2.0*f);
          float n000 = hash(i+vec3(0,0,0));
          float n100 = hash(i+vec3(1,0,0));
          float n010 = hash(i+vec3(0,1,0));
          float n110 = hash(i+vec3(1,1,0));
          float n001 = hash(i+vec3(0,0,1));
          float n101 = hash(i+vec3(1,0,1));
          float n011 = hash(i+vec3(0,1,1));
          float n111 = hash(i+vec3(1,1,1));
          float nx00 = mix(n000,n100,f.x);
          float nx10 = mix(n010,n110,f.x);
          float nx01 = mix(n001,n101,f.x);
          float nx11 = mix(n011,n111,f.x);
          float nxy0 = mix(nx00,nx10,f.y);
          float nxy1 = mix(nx01,nx11,f.y);
          return mix(nxy0,nxy1,f.z);
        }
        float fbm(vec3 p){
          float a = 0.5; float v = 0.0;
          for(int i=0;i<5;i++){
            v += a*noise(p);
            p *= 2.0; a *= 0.5;
          }
          return v;
        }
        void main(){
          vec3 q = vN * 2.5;
          q.x += time*0.005;
          float n = fbm(q);
          float n2 = fbm(q*1.8 + 4.0);
          vec3 col = mix(c1, c2, n);
          col = mix(col, c3, smoothstep(0.45, 0.85, n2));
          float a = smoothstep(0.25, 0.85, n) * 0.55;
          gl_FragColor = vec4(col*a, a);
        }
      `
    });
    this.nebulaA = new THREE.Mesh(geo, mat);
    this.nebulaA.frustumCulled = false;
    this.scene.add(this.nebulaA);
  }

  _setupDistantPlanets() {
    const grp = new THREE.Group();
    const COUNT = this.quality === 'high' ? 4 : 3;
    const planetTypes = [
      { color: 0x6e7dff, ring: false, glow: 0xb388ff },
      { color: 0xff8a4a, ring: true,  glow: 0xffb547 },
      { color: 0x8effb5, ring: false, glow: 0x88ffd6 },
      { color: 0xffd86b, ring: true,  glow: 0xff7d3a },
      { color: 0xc06bff, ring: false, glow: 0xff5fa2 },
    ];
    for (let i = 0; i < COUNT; i++) {
      const t = choose(planetTypes);
      const r = rand(60, 130);
      const planet = new THREE.Mesh(
        new THREE.SphereGeometry(r, 28, 20),
        new THREE.MeshStandardMaterial({
          color: t.color, roughness: 0.85, metalness: 0.1,
          emissive: t.glow, emissiveIntensity: 0.08
        })
      );
      const a = rand(0, Math.PI * 2);
      const dist = rand(900, 1500);
      planet.position.set(Math.cos(a) * dist, rand(-200, 250), Math.sin(a) * dist - 200);
      grp.add(planet);

      // halo
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(r * 1.18, 24, 16),
        new THREE.MeshBasicMaterial({
          color: t.glow, transparent: true, opacity: 0.10,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide
        })
      );
      halo.position.copy(planet.position);
      grp.add(halo);

      if (t.ring) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(r * 1.5, r * 2.4, 64),
          new THREE.MeshBasicMaterial({
            color: t.glow, transparent: true, opacity: 0.45,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
          })
        );
        ring.rotation.x = rand(0.7, 1.4);
        ring.rotation.y = rand(0, Math.PI);
        ring.position.copy(planet.position);
        grp.add(ring);
      }
      planet.userData.spinSpeed = rand(0.005, 0.02);
    }
    this.planets = grp;
    this.scene.add(grp);
  }

  // -----------------------------------------------------------
  // CHUNKS — asteroid fields, debris, capsules, set pieces
  // -----------------------------------------------------------
  prime() {
    for (let i = 0; i < this.aheadChunks; i++) this._spawnChunk();
  }

  _spawnChunk() {
    const z = this.spawnZ - this.chunkLength;
    const chunk = new THREE.Group();
    chunk.position.z = z;
    chunk.userData = { z, hazards: [], crystals: [], rings: [] };

    // ASTEROIDS — destructible. dense in some chunks (asteroid fields)
    const fieldDense = Math.random() < 0.35;
    const asteroidCount = fieldDense ? randInt(8, 14) : randInt(3, 6);
    for (let i = 0; i < asteroidCount; i++) {
      const lx = rand(-90, 90);
      const ly = rand(-50, 50);
      const lz = rand(-this.chunkLength + 10, -10);
      this._spawnAsteroid(chunk, lx, ly, lz);
    }

    // SALVAGE CRYSTALS (regular score pickups)
    const crystals = randInt(5, 9);
    for (let i = 0; i < crystals; i++) {
      const t = (i + rand(0.05, 0.95)) / crystals;
      const lz = -t * this.chunkLength;
      const lx = rand(-70, 70);
      const ly = rand(-35, 35);
      this._spawnSalvage(chunk, lx, ly, lz);
    }

    // POWER CAPSULES — rare
    if (Math.random() < 0.55) {
      const lz = rand(-this.chunkLength + 20, -20);
      const lx = rand(-60, 60);
      const ly = rand(-25, 25);
      const kinds = ['shield', 'energy', 'mega'];
      this._spawnPower(chunk, lx, ly, lz, choose(kinds));
    }

    // DERELICT — rare big set piece
    if (Math.random() < 0.18) {
      const lx = rand(-80, 80);
      const ly = rand(-40, 40);
      const lz = rand(-this.chunkLength + 40, -40);
      this._spawnDerelict(chunk, lx, ly, lz);
    }

    this.root.add(chunk);
    this.chunks.push(chunk);
    this.spawnZ = z;
  }

  _spawnAsteroid(parent, x, y, z) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    const r = rand(2.2, 5.5);
    const geo = new THREE.IcosahedronGeometry(r, 1);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      v.multiplyScalar(1 + (Math.random() - 0.4) * 0.35);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x4a4658, roughness: 0.95, metalness: 0.15,
      emissive: 0x221a35, emissiveIntensity: 0.3,
      flatShading: true
    });
    const m = new THREE.Mesh(geo, mat);
    grp.add(m);

    // glowing crystals embedded in the rock
    const crystalCount = randInt(0, 2);
    for (let i = 0; i < crystalCount; i++) {
      const cg = new THREE.Mesh(
        new THREE.OctahedronGeometry(rand(0.3, 0.6)),
        new THREE.MeshBasicMaterial({ color: 0x88ffd6, transparent: true, opacity: 0.85 })
      );
      const a = rand(0, Math.PI * 2);
      const b = rand(-0.4, 0.4);
      cg.position.set(Math.cos(a) * Math.cos(b) * r * 0.95, Math.sin(b) * r * 0.95, Math.sin(a) * Math.cos(b) * r * 0.95);
      grp.add(cg);
    }

    grp.userData.kind = 'asteroid';
    grp.userData.radius = r * 1.05;
    grp.userData.alive = true;
    grp.userData.hp = Math.ceil(r * 1.4);   // bigger = more hp
    grp.userData.maxHp = grp.userData.hp;
    grp.userData.spin = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1));
    grp.userData.salvageReward = Math.ceil(r * 5);
    grp.userData.scoreReward = Math.ceil(r * 30);
    parent.add(grp);
    parent.userData.hazards.push(grp);
  }

  _spawnSalvage(parent, x, y, z) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    const geo = new THREE.OctahedronGeometry(0.9, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x88ffd6, emissive: 0x88ffd6, emissiveIntensity: 1.0,
      roughness: 0.15, metalness: 0.8,
      transparent: true, opacity: 0.95
    });
    const c = new THREE.Mesh(geo, mat);
    c.scale.set(1, 1.6, 1);
    grp.add(c);
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1.8, 12, 8),
      new THREE.MeshBasicMaterial({
        color: 0x88ffd6, transparent: true, opacity: 0.25,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    grp.add(halo);
    grp.userData.kind = 'crystal';
    grp.userData.radius = 1.4;
    grp.userData.alive = true;
    grp.userData.spinT = rand(0, Math.PI * 2);
    parent.add(grp);
    parent.userData.crystals.push(grp);
  }

  _spawnPower(parent, x, y, z, kind) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);

    const colors = {
      shield: 0x7df9ff,
      energy: 0xb388ff,
      mega:   0xffd86b
    };
    const color = colors[kind];

    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.4, 1),
      new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: 1.0,
        roughness: 0.18, metalness: 0.6,
        transparent: true, opacity: 0.95
      })
    );
    grp.add(core);

    const shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.1, 1),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.55, wireframe: true
      })
    );
    grp.add(shell);

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(2.8, 16, 12),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.18,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    grp.add(halo);

    grp.userData.kind = 'power';
    grp.userData.power = kind;
    grp.userData.radius = 2.4;
    grp.userData.alive = true;
    grp.userData.spinT = rand(0, Math.PI * 2);
    grp.userData.shell = shell;
    grp.userData.core = core;
    parent.add(grp);
    parent.userData.crystals.push(grp);
  }

  _spawnDerelict(parent, x, y, z) {
    // a long abandoned cruiser hull — pure decoration but cool
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    grp.rotation.set(rand(-0.3, 0.3), rand(0, Math.PI * 2), rand(-0.3, 0.3));

    const hull = new THREE.Mesh(
      new THREE.CylinderGeometry(2.4, 1.4, 24, 12),
      new THREE.MeshStandardMaterial({
        color: 0x3a3a4e, roughness: 0.9, metalness: 0.4,
        emissive: 0x110015, emissiveIntensity: 0.3
      })
    );
    hull.rotation.z = Math.PI / 2;
    grp.add(hull);

    // tail flare
    const tail = new THREE.Mesh(
      new THREE.ConeGeometry(2.4, 6, 12),
      hull.material
    );
    tail.rotation.z = -Math.PI / 2;
    tail.position.x = -15;
    grp.add(tail);

    // wings
    for (const s of [-1, 1]) {
      const w = new THREE.Mesh(
        new THREE.BoxGeometry(8, 0.5, 4),
        hull.material
      );
      w.position.set(0, 0, s * 3.5);
      grp.add(w);
    }

    // flickering emergency lights
    const light = new THREE.Mesh(
      new THREE.SphereGeometry(0.4, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff3b6b })
    );
    light.position.set(8, 1, 0);
    grp.add(light);
    grp.userData.flickerLight = light;

    grp.userData.kind = 'derelict';
    grp.userData.radius = 14;
    grp.userData.spinT = rand(0, Math.PI * 2);
    parent.add(grp);
  }

  // -----------------------------------------------------------
  update(dt, time, playerZ) {
    this.travelled = -playerZ;
    if (this.sky.material.uniforms) this.sky.material.uniforms.time.value = time;
    if (this.nebulaA && this.nebulaA.material.uniforms) this.nebulaA.material.uniforms.time.value = time;

    // star layer parallax
    for (const layer of this.starLayers) {
      layer.pts.position.z = playerZ * (1 - layer.parallax);
      layer.pts.rotation.y += dt * 0.002 * layer.parallax;
    }

    // distant planets follow camera (parallax)
    if (this.planets) {
      this.planets.position.z = playerZ - 100;
      for (const p of this.planets.children) {
        if (p.userData.spinSpeed) p.rotation.y += dt * p.userData.spinSpeed;
      }
    }

    // chunks
    for (const chunk of this.chunks) {
      for (const cr of chunk.userData.crystals) {
        if (!cr.userData.alive) continue;
        cr.userData.spinT += dt;
        cr.rotation.y += dt * 1.6;
        cr.rotation.x += dt * 0.7;
        cr.position.y += Math.sin(cr.userData.spinT * 2.0) * dt * 0.4;
        if (cr.userData.kind === 'power' && cr.userData.shell) {
          cr.userData.shell.rotation.y -= dt * 1.2;
          cr.userData.shell.rotation.z += dt * 0.7;
          const s = 1 + Math.sin(cr.userData.spinT * 3.5) * 0.08;
          cr.userData.shell.scale.setScalar(s);
        }
      }
      for (const h of chunk.userData.hazards) {
        if (h.userData.kind === 'asteroid' && h.userData.spin) {
          h.rotation.x += h.userData.spin.x * dt * 0.4;
          h.rotation.y += h.userData.spin.y * dt * 0.4;
          h.rotation.z += h.userData.spin.z * dt * 0.4;
        }
      }
      // derelict flicker
      for (const c of chunk.children) {
        if (c.userData?.flickerLight) {
          c.userData.spinT = (c.userData.spinT || 0) + dt;
          const v = (Math.sin(c.userData.spinT * 5.0) + Math.sin(c.userData.spinT * 11.3)) * 0.5 + 0.5;
          c.userData.flickerLight.material.opacity = 0.4 + v * 0.6;
        }
      }
    }

    this.sky.position.set(0, 0, playerZ);
    this.nebulaA.position.set(0, 0, playerZ);

    while (this.chunks.length && this.chunks[0].position.z > playerZ + this.chunkLength * this.behindChunks) {
      const old = this.chunks.shift();
      this._disposeChunk(old);
    }
    while (this.spawnZ > playerZ - this.chunkLength * this.aheadChunks) {
      this._spawnChunk();
    }
  }

  _disposeChunk(chunk) {
    this.root.remove(chunk);
    chunk.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
        else o.material.dispose();
      }
    });
  }

  gatherNear(playerZ, range = 240) {
    const crystals = [], hazards = [];
    for (const chunk of this.chunks) {
      const dz = Math.abs(chunk.position.z - playerZ);
      if (dz > range + this.chunkLength) continue;
      for (const c of chunk.userData.crystals) if (c.userData.alive) crystals.push({ obj: c, parent: chunk });
      for (const h of chunk.userData.hazards)  if (h.userData.alive) hazards.push({ obj: h, parent: chunk });
    }
    return { crystals, hazards, rings: [] };
  }
}
