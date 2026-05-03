// ===========================================================
// world.js — procedural infinite sky world.   (v2)
//   - Sky / sun / atmosphere shader
//   - Volumetric-ish layered clouds
//   - Floating islands (smooth Genshin-like aesthetic, NOT cubic)
//   - Star clouds, pickup rings, crystals, hazards
//   - Light shafts streaming through clouds
// ===========================================================

import * as THREE from 'three';
import { rand, randInt, choose, clamp, lerp } from './utils.js';

const ISLAND_PALETTES = [
  { rock: 0x6f5b8d, grass: 0x65d394, glow: 0x7df9ff, accent: 0xb388ff }, // dawn lavender
  { rock: 0x8b6f4e, grass: 0x9cd86a, glow: 0xffd86b, accent: 0xff9b6e }, // sunset
  { rock: 0x4a5d8c, grass: 0x60c0d4, glow: 0x7df9ff, accent: 0x6ec0ff }, // azure
  { rock: 0x6e4b6e, grass: 0xff95c8, glow: 0xff6ec7, accent: 0xb388ff }, // sakura
  { rock: 0x3a4a6e, grass: 0x8ad8ff, glow: 0xc4b5ff, accent: 0xffffff }  // arctic dream
];

export class World {
  constructor(scene, quality = 'med') {
    this.scene = scene;
    this.quality = quality;

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.chunks = [];
    this.chunkLength = 220;
    this.aheadChunks = quality === 'high' ? 8 : quality === 'med' ? 6 : 5;
    this.behindChunks = 1;
    this.spawnZ = 0;
    this.travelled = 0;

    this._setupSky();
    this._setupLights();
    this._setupOcean();
    this._setupClouds();
    this._setupStars();
    this._setupGodRays();
  }

  // -----------------------------------------------------------
  // God-rays / light shafts streaming from the sun
  _setupGodRays() {
    const COUNT = this.quality === 'high' ? 14 : this.quality === 'med' ? 9 : 6;
    const grp = new THREE.Group();
    const tex = this._makeRayTexture();
    for (let i = 0; i < COUNT; i++) {
      const m = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex,
        color: i % 3 === 0 ? 0xfff2c8 : 0xffd6a0,
        transparent: true,
        depthWrite: false,
        opacity: 0.0,                         // fade in over time
        blending: THREE.AdditiveBlending,
        rotation: rand(-0.3, 0.3)
      }));
      const a = rand(0, Math.PI * 2);
      const r = rand(220, 360);
      m.position.set(Math.cos(a) * r, rand(40, 120), -260 - Math.random() * 200);
      const w = rand(80, 160), h = rand(280, 420);
      m.scale.set(w, h, 1);
      m.userData = { baseOpacity: rand(0.06, 0.22), phase: rand(0, Math.PI * 2) };
      grp.add(m);
    }
    this.scene.add(grp);
    this.godRays = grp;
  }

  _makeRayTexture() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 256;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(32, 0, 32, 256);
    grd.addColorStop(0,    'rgba(255,255,255,0)');
    grd.addColorStop(0.4,  'rgba(255,255,255,0.55)');
    grd.addColorStop(1,    'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 256);
    // soft horizontal falloff
    const grd2 = g.createLinearGradient(0, 0, 64, 0);
    grd2.addColorStop(0, 'rgba(0,0,0,1)');
    grd2.addColorStop(0.5,'rgba(0,0,0,0)');
    grd2.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = grd2;
    g.fillRect(0, 0, 64, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // -----------------------------------------------------------
  _setupSky() {
    const geo = new THREE.SphereGeometry(2400, 48, 24);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x0a1238) },
        midColor: { value: new THREE.Color(0x9c5fff) },
        botColor: { value: new THREE.Color(0xff8fb1) },
        sunDir:   { value: new THREE.Vector3(0.3, 0.45, -0.85).normalize() },
        sunColor: { value: new THREE.Color(0xfff2c8) },
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
        uniform vec3 sunDir;
        uniform vec3 sunColor;
        uniform float time;
        varying vec3 vN;
        void main(){
          float h = clamp((vN.y + 0.2) * 0.7, 0.0, 1.0);
          vec3 col = mix(botColor, midColor, smoothstep(0.0, 0.5, h));
          col = mix(col, topColor, smoothstep(0.45, 1.0, h));
          float sd = max(dot(vN, sunDir), 0.0);
          col += sunColor * pow(sd, 320.0) * 1.8;
          col += sunColor * pow(sd, 12.0) * 0.14;
          // aurora-ish bands
          float band = sin((vN.y + time * 0.02) * 30.0) * 0.5 + 0.5;
          col += vec3(0.05, 0.10, 0.18) * band * smoothstep(0.4, 0.9, h);
          gl_FragColor = vec4(col, 1.0);
        }
      `
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    this.scene.fog = new THREE.FogExp2(0xa48fff, 0.0016);
  }

  _setupLights() {
    const hemi = new THREE.HemisphereLight(0xc0d6ff, 0xff9fb8, 0.65);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xfff2cc, 1.4);
    dir.position.set(80, 130, -60);
    this.scene.add(dir);
    this.sunLight = dir;

    const fill = new THREE.DirectionalLight(0x7df9ff, 0.55);
    fill.position.set(-60, 30, 60);
    this.scene.add(fill);

    // accent rim
    const rim = new THREE.DirectionalLight(0xff6ec7, 0.25);
    rim.position.set(20, -40, 100);
    this.scene.add(rim);
  }

  _setupOcean() {
    const geo = new THREE.PlaneGeometry(7000, 7000, 80, 80);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: {
        time: { value: 0 },
        c1: { value: new THREE.Color(0xffd6f3) },
        c2: { value: new THREE.Color(0xb388ff) },
        c3: { value: new THREE.Color(0x7df9ff) }
      },
      vertexShader: `
        uniform float time;
        varying vec2 vUv;
        varying float vH;
        void main(){
          vUv = uv;
          vec3 p = position;
          float w = sin(p.x*0.012 + time*0.4) * cos(p.y*0.014 + time*0.3) * 22.0
                  + sin(p.x*0.04 + time*0.9) * 5.0
                  + cos(p.y*0.03 + time*0.6) * 4.0;
          p.z += w;
          vH = w;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 c1; uniform vec3 c2; uniform vec3 c3;
        varying vec2 vUv;
        varying float vH;
        void main(){
          vec3 col = mix(c1, c2, vUv.y);
          col = mix(col, c3, smoothstep(-15.0, 22.0, vH) * 0.6);
          float a = 0.55 + 0.30 * smoothstep(-15.0, 26.0, vH);
          gl_FragColor = vec4(col, a);
        }
      `
    });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = -130;
    m.frustumCulled = false;
    this.scene.add(m);
    this.ocean = m;
  }

  _setupClouds() {
    // Soft puffy clouds as billboards. 3 layers for parallax depth.
    const tex = this._makeCloudTexture();
    this.cloudLayers = [];
    const counts = this.quality === 'high' ? [40, 30, 20] : this.quality === 'med' ? [28, 22, 14] : [18, 14, 8];
    const distances = [180, 320, 520];
    const sizes = [40, 70, 120];

    for (let layer = 0; layer < 3; layer++) {
      const grp = new THREE.Group();
      for (let i = 0; i < counts[layer]; i++) {
        const m = new THREE.Sprite(new THREE.SpriteMaterial({
          map: tex,
          color: new THREE.Color().setHSL(rand(0.7, 0.95), 0.4, rand(0.7, 0.95)),
          transparent: true,
          depthWrite: false,
          opacity: rand(0.45, 0.9),
          blending: THREE.NormalBlending
        }));
        const a = rand(0, Math.PI * 2);
        const r = rand(distances[layer] * 0.4, distances[layer]);
        m.position.set(Math.cos(a) * r, rand(-30, 60), Math.sin(a) * r);
        const s = rand(sizes[layer] * 0.7, sizes[layer]);
        m.scale.set(s, s * 0.5, 1);
        grp.add(m);
      }
      this.scene.add(grp);
      this.cloudLayers.push({ grp, parallax: 0.4 + layer * 0.25 });
    }
  }

  _makeCloudTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    // soft radial gradient with slight noise
    const grd = g.createRadialGradient(128, 128, 10, 128, 128, 128);
    grd.addColorStop(0,   'rgba(255,255,255,1)');
    grd.addColorStop(0.4, 'rgba(255,255,255,0.7)');
    grd.addColorStop(0.7, 'rgba(255,255,255,0.25)');
    grd.addColorStop(1,   'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
    // splotch pattern for organic shape
    g.globalAlpha = 0.5;
    for (let i = 0; i < 25; i++) {
      const x = 128 + (Math.random() - 0.5) * 120;
      const y = 128 + (Math.random() - 0.5) * 60;
      const r = 30 + Math.random() * 40;
      const g2 = g.createRadialGradient(x, y, 0, x, y, r);
      g2.addColorStop(0, 'rgba(255,255,255,0.9)');
      g2.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = g2;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _setupStars() {
    const COUNT = this.quality === 'high' ? 900 : this.quality === 'med' ? 550 : 320;
    const positions = new Float32Array(COUNT * 3);
    const colors    = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      const r = 700 + Math.random() * 900;
      const a = Math.random() * Math.PI * 2;
      const b = (Math.random() - 0.5) * Math.PI * 0.6;
      positions[i * 3 + 0] = Math.cos(a) * Math.cos(b) * r;
      positions[i * 3 + 1] = Math.sin(b) * r * 0.6 + 100;
      positions[i * 3 + 2] = Math.sin(a) * Math.cos(b) * r;
      const c = new THREE.Color().setHSL(rand(0.5, 0.9), 0.7, 0.75);
      colors[i*3+0] = c.r; colors[i*3+1] = c.g; colors[i*3+2] = c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
      size: 4.4, sizeAttenuation: true,
      vertexColors: true, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending,
      map: this._makeSpriteTexture(), opacity: 0.95
    });
    this.stars = new THREE.Points(geo, mat);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  _makeSpriteTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.3, 'rgba(255,255,255,0.7)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // -----------------------------------------------------------
  // CHUNKS
  // -----------------------------------------------------------
  prime() {
    for (let i = 0; i < this.aheadChunks; i++) this._spawnChunk();
  }

  _spawnChunk() {
    const z = this.spawnZ - this.chunkLength;
    const chunk = new THREE.Group();
    chunk.position.z = z;
    chunk.userData = { z, pickups: [], hazards: [], rings: [], crystals: [] };

    const palette = choose(ISLAND_PALETTES);
    const variation = (this.travelled + Math.abs(z)) / 5000;

    const n = randInt(2, 4);
    for (let i = 0; i < n; i++) {
      const x = rand(-90, 90);
      const y = rand(-30, 50);
      const lz = rand(-this.chunkLength + 20, -20);
      this._spawnIsland(chunk, x, y, lz, palette, variation);
    }

    const rings = randInt(3, 5);
    for (let i = 0; i < rings; i++) {
      const t = (i + rand(0.1, 0.9)) / rings;
      const lz = -t * this.chunkLength;
      const lx = Math.sin((Math.abs(z) * 0.002) + i * 1.7) * 38;
      const ly = Math.cos((Math.abs(z) * 0.003) + i * 2.3) * 22 + 8;
      this._spawnRing(chunk, lx, ly, lz);
    }

    const crystals = randInt(6, 11);
    for (let i = 0; i < crystals; i++) {
      const t = (i + rand(0.05, 0.95)) / crystals;
      const lz = -t * this.chunkLength;
      const lx = rand(-65, 65);
      const ly = rand(-22, 38);
      this._spawnCrystal(chunk, lx, ly, lz);
    }

    // Special pickups (rare): shield, time-slow, mega-coin
    if (Math.random() < 0.55) {
      const lz = rand(-this.chunkLength + 20, -20);
      const lx = rand(-50, 50);
      const ly = rand(-15, 30);
      const kinds = ['shield', 'slowmo', 'mega'];
      this._spawnPower(chunk, lx, ly, lz, choose(kinds));
    }

    // Score gates — narrow lit gates worth big points + multiplier
    if (Math.random() < 0.35) {
      const lz = rand(-this.chunkLength + 30, -30);
      const lx = rand(-30, 30);
      const ly = rand(-10, 25);
      this._spawnGate(chunk, lx, ly, lz);
    }

    const hazardChance = clamp(0.25 + variation * 0.3, 0.25, 0.85);
    const haz = randInt(1, 3 + Math.floor(variation * 2));
    for (let i = 0; i < haz; i++) {
      if (Math.random() > hazardChance) continue;
      const lx = rand(-72, 72);
      const ly = rand(-15, 32);
      const lz = rand(-this.chunkLength + 10, -10);
      if (Math.random() < 0.55) this._spawnStorm(chunk, lx, ly, lz);
      else this._spawnRock(chunk, lx, ly, lz);
    }

    this.root.add(chunk);
    this.chunks.push(chunk);
    this.spawnZ = z;
  }

  _spawnIsland(parent, x, y, z, palette, variation) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    grp.rotation.y = rand(0, Math.PI * 2);

    const radius = rand(8, 16);
    const baseGeo = new THREE.IcosahedronGeometry(radius, this.quality === 'high' ? 3 : 2);
    const pos = baseGeo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = (Math.sin(v.x * 0.4) + Math.cos(v.z * 0.5) + Math.sin(v.y * 0.6)) * 0.6;
      v.multiplyScalar(1 + n * 0.06);
      if (v.y < 0) v.y *= 1.5 + Math.random() * 0.5;
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    baseGeo.computeVertexNormals();

    const rockMat = new THREE.MeshStandardMaterial({
      color: palette.rock, roughness: 0.85, metalness: 0.05, flatShading: false
    });
    const base = new THREE.Mesh(baseGeo, rockMat);
    grp.add(base);

    const capGeo = new THREE.SphereGeometry(radius * 0.95, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.5);
    const capMat = new THREE.MeshStandardMaterial({
      color: palette.grass, roughness: 0.7, metalness: 0.0,
      emissive: new THREE.Color(palette.grass).multiplyScalar(0.06)
    });
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.y = radius * 0.05;
    cap.scale.set(1.02, 0.55, 1.02);
    grp.add(cap);

    const ringGeo = new THREE.TorusGeometry(radius * 1.2, 0.4, 12, 56);
    const ringMat = new THREE.MeshBasicMaterial({
      color: palette.glow, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -radius * 0.6;
    grp.add(ring);

    const spires = randInt(2, 5);
    for (let i = 0; i < spires; i++) {
      const sh = rand(2.5, 5.5);
      const sg = new THREE.ConeGeometry(rand(0.6, 1.2), sh, 12);
      const sm = new THREE.MeshStandardMaterial({
        color: palette.accent,
        emissive: new THREE.Color(palette.accent).multiplyScalar(0.3),
        roughness: 0.4, metalness: 0.1
      });
      const s = new THREE.Mesh(sg, sm);
      const a = rand(0, Math.PI * 2);
      const r = rand(radius * 0.3, radius * 0.85);
      s.position.set(Math.cos(a) * r, radius * 0.4 + sh * 0.5, Math.sin(a) * r);
      grp.add(s);
    }

    if (Math.random() < 0.7) {
      const fc = new THREE.Mesh(
        new THREE.OctahedronGeometry(rand(0.8, 1.4)),
        new THREE.MeshStandardMaterial({
          color: palette.glow, emissive: palette.glow,
          emissiveIntensity: 1.0, roughness: 0.2, metalness: 0.4,
          transparent: true, opacity: 0.95
        })
      );
      fc.position.set(rand(-radius, radius) * 0.7, radius + rand(2, 6), rand(-radius, radius) * 0.7);
      fc.userData.float = { y0: fc.position.y, t: rand(0, 6) };
      grp.add(fc);
    }

    grp.userData.bobT = rand(0, Math.PI * 2);
    grp.userData.bobAmp = rand(0.4, 1.2);
    parent.add(grp);
  }

  _spawnRing(parent, x, y, z) {
    const radius = 7;
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    grp.rotation.y = rand(-0.3, 0.3);
    grp.rotation.x = rand(-0.15, 0.15);

    const geo = new THREE.TorusGeometry(radius, 0.55, 16, 72);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x7df9ff,
      emissive: 0x7df9ff, emissiveIntensity: 0.9,
      roughness: 0.25, metalness: 0.5,
      transparent: true, opacity: 0.95
    });
    const ring = new THREE.Mesh(geo, mat);
    grp.add(ring);

    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(radius + 0.4, 1.6, 14, 72),
      new THREE.MeshBasicMaterial({
        color: 0x7df9ff, transparent: true, opacity: 0.2,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    grp.add(halo);

    const inner = new THREE.Mesh(
      new THREE.CircleGeometry(radius - 0.7, 32),
      new THREE.MeshBasicMaterial({
        color: 0xb388ff, transparent: true, opacity: 0.10,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
      })
    );
    grp.add(inner);

    grp.userData.kind = 'ring';
    grp.userData.radius = radius;
    grp.userData.alive = true;
    parent.add(grp);
    parent.userData.rings.push(grp);
  }

  _spawnCrystal(parent, x, y, z) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    const geo = new THREE.OctahedronGeometry(1.2, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xff6ec7,
      emissive: 0xff6ec7, emissiveIntensity: 0.85,
      roughness: 0.15, metalness: 0.7,
      transparent: true, opacity: 0.95
    });
    const c = new THREE.Mesh(geo, mat);
    c.scale.y = 1.6;
    grp.add(c);
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(2.4, 12, 8),
      new THREE.MeshBasicMaterial({
        color: 0xff6ec7, transparent: true, opacity: 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    grp.add(halo);
    grp.userData.kind = 'crystal';
    grp.userData.radius = 1.6;
    grp.userData.alive = true;
    grp.userData.spinT = rand(0, Math.PI * 2);
    parent.add(grp);
    parent.userData.crystals.push(grp);
  }

  _spawnStorm(parent, x, y, z) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    const radius = rand(8, 14);
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x441a3a, emissive: 0xff3b6b, emissiveIntensity: 0.55,
      roughness: 0.95, transparent: true, opacity: 0.92
    });
    for (let i = 0; i < 5; i++) {
      const r = radius * rand(0.5, 1.0);
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), baseMat);
      m.position.set(rand(-radius, radius) * 0.4, rand(-radius, radius) * 0.3, rand(-radius, radius) * 0.4);
      grp.add(m);
    }
    grp.userData.kind = 'storm';
    grp.userData.radius = radius;
    grp.userData.alive = true;
    parent.add(grp);
    parent.userData.hazards.push(grp);
  }

  _spawnPower(parent, x, y, z, kind) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);

    const colors = {
      shield: 0x7df9ff,
      slowmo: 0xb388ff,
      mega:   0xffd86b
    };
    const color = colors[kind];

    // glowing core orb
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.5, 1),
      new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: 1.0,
        roughness: 0.18, metalness: 0.6,
        transparent: true, opacity: 0.95
      })
    );
    grp.add(core);

    // outer wireframe shell
    const shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.2, 1),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.55, wireframe: true
      })
    );
    grp.add(shell);

    // halo
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(3.0, 16, 12),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.18,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    grp.add(halo);

    grp.userData.kind = 'power';
    grp.userData.power = kind;
    grp.userData.radius = 2.6;
    grp.userData.alive = true;
    grp.userData.spinT = rand(0, Math.PI * 2);
    grp.userData.shell = shell;
    grp.userData.core = core;
    parent.add(grp);
    parent.userData.crystals.push(grp);
  }

  _spawnGate(parent, x, y, z) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);

    // two vertical pillars + top arch
    const pillarGeo = new THREE.CylinderGeometry(0.4, 0.6, 14, 14);
    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0xffd86b, emissive: 0xffd86b, emissiveIntensity: 0.8,
      roughness: 0.3, metalness: 0.6
    });
    const pl = new THREE.Mesh(pillarGeo, pillarMat);
    pl.position.set(-7, 0, 0);
    grp.add(pl);
    const pr = pl.clone();
    pr.position.x = 7;
    grp.add(pr);

    // crossbar
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(15, 0.6, 0.6),
      pillarMat
    );
    bar.position.y = 7;
    grp.add(bar);

    // light plane filling the gate
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 14),
      new THREE.MeshBasicMaterial({
        color: 0xffd86b, transparent: true, opacity: 0.18,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
      })
    );
    plane.position.y = 0;
    grp.add(plane);

    grp.userData.kind = 'gate';
    grp.userData.radius = 7;
    grp.userData.halfHeight = 7;
    grp.userData.alive = true;
    parent.add(grp);
    parent.userData.rings.push(grp); // gates use ring collision logic
  }

  _spawnRock(parent, x, y, z) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    const r = rand(3, 6);
    const geo = new THREE.IcosahedronGeometry(r, 1);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      v.multiplyScalar(1 + Math.random() * 0.18);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x49405a, roughness: 0.85, metalness: 0.2,
      emissive: 0xff6ec7, emissiveIntensity: 0.05
    });
    const m = new THREE.Mesh(geo, mat);
    grp.add(m);
    grp.userData.kind = 'rock';
    grp.userData.radius = r;
    grp.userData.alive = true;
    grp.userData.spin = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1));
    parent.add(grp);
    parent.userData.hazards.push(grp);
  }

  // -----------------------------------------------------------
  // UPDATE
  // -----------------------------------------------------------
  update(dt, time, playerZ) {
    this.travelled = -playerZ;
    if (this.sky.material.uniforms) this.sky.material.uniforms.time.value = time;
    if (this.ocean.material.uniforms) this.ocean.material.uniforms.time.value = time;

    this.stars.rotation.y += dt * 0.005;

    // god-rays: gentle pulsing + parallax follow
    if (this.godRays) {
      this.godRays.position.z = playerZ - 200;
      for (const r of this.godRays.children) {
        r.userData.phase += dt * 0.5;
        r.material.opacity = r.userData.baseOpacity * (0.7 + Math.sin(r.userData.phase) * 0.3);
      }
    }

    // clouds parallax
    for (const layer of this.cloudLayers) {
      layer.grp.position.z = playerZ * (1 - layer.parallax);
      layer.grp.rotation.y += dt * 0.005 * layer.parallax;
    }

    for (const chunk of this.chunks) {
      for (const c of chunk.children) {
        if (c.userData?.bobT !== undefined) {
          c.userData.bobT += dt;
          c.position.y += Math.sin(c.userData.bobT * 0.6) * dt * 0.3 * c.userData.bobAmp;
          c.rotation.y += dt * 0.03;
        }
      }
      for (const r of chunk.userData.rings) {
        if (!r.userData.alive) continue;
        r.rotation.z += dt * 0.6;
      }
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
        if (h.userData.kind === 'rock' && h.userData.spin) {
          h.rotation.x += h.userData.spin.x * dt * 0.4;
          h.rotation.y += h.userData.spin.y * dt * 0.4;
          h.rotation.z += h.userData.spin.z * dt * 0.4;
        } else if (h.userData.kind === 'storm') {
          h.rotation.y += dt * 0.2;
        }
      }
    }

    this.sky.position.set(0, 0, playerZ);
    this.ocean.position.z = playerZ;
    this.stars.position.z = playerZ;

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

  gatherNear(playerZ, range = 200) {
    const rings = [], crystals = [], hazards = [];
    for (const chunk of this.chunks) {
      const dz = Math.abs(chunk.position.z - playerZ);
      if (dz > range + this.chunkLength) continue;
      for (const r of chunk.userData.rings)    if (r.userData.alive) rings.push({ obj: r, parent: chunk });
      for (const c of chunk.userData.crystals) if (c.userData.alive) crystals.push({ obj: c, parent: chunk });
      for (const h of chunk.userData.hazards)  if (h.userData.alive) hazards.push({ obj: h, parent: chunk });
    }
    return { rings, crystals, hazards };
  }

  worldPos(item) {
    return new THREE.Vector3().addVectors(item.parent.position, item.obj.position);
  }
}
