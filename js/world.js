// ===========================================================
// world.js — procedural infinite sky world.
//   - Sky / sun / atmosphere
//   - Floating islands (smooth Genshin-like aesthetic, NOT cubic)
//   - Star clouds, far mountains, ocean, light shafts
// ===========================================================

import * as THREE from 'three';
import { rand, randInt, choose, clamp, lerp } from './utils.js';

const ISLAND_PALETTES = [
  { rock: 0x6f5b8d, grass: 0x65d394, glow: 0x7df9ff, accent: 0xb388ff }, // dawn lavender
  { rock: 0x8b6f4e, grass: 0x9cd86a, glow: 0xffd86b, accent: 0xff9b6e }, // sunset
  { rock: 0x4a5d8c, grass: 0x60c0d4, glow: 0x7df9ff, accent: 0x6ec0ff }, // azure
  { rock: 0x6e4b6e, grass: 0xff95c8, glow: 0xff6ec7, accent: 0xb388ff }  // sakura
];

export class World {
  constructor(scene, quality = 'med') {
    this.scene = scene;
    this.quality = quality;

    // ----- root containers -----
    this.root = new THREE.Group();
    this.scene.add(this.root);

    // chunks queue (each chunk is a Group)
    this.chunks = [];
    this.chunkLength = 220;     // world units
    this.aheadChunks = quality === 'high' ? 8 : quality === 'med' ? 6 : 5;
    this.behindChunks = 1;
    this.spawnZ = 0;            // next chunk z
    this.travelled = 0;

    // setup environment
    this._setupSky();
    this._setupLights();
    this._setupOcean();
    this._setupStars();
  }

  // -----------------------------------------------------------
  _setupSky() {
    // Big gradient sphere
    const geo = new THREE.SphereGeometry(2200, 32, 16);
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
        varying vec3 vWorld;
        varying vec3 vN;
        void main(){
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vN = normalize(position);
          gl_Position = projectionMatrix * viewMatrix * wp;
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
          // sun
          float sd = max(dot(vN, sunDir), 0.0);
          col += sunColor * pow(sd, 320.0) * 1.6;       // sun disk
          col += sunColor * pow(sd, 8.0) * 0.18;         // soft halo
          // subtle banding
          col += 0.025 * sin(vN.y * 60.0 + time * 0.05);
          gl_FragColor = vec4(col, 1.0);
        }
      `
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    // fog gives depth
    this.scene.fog = new THREE.FogExp2(0xa48fff, 0.0017);
  }

  _setupLights() {
    const hemi = new THREE.HemisphereLight(0xc0d6ff, 0xff9fb8, 0.85);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xfff2cc, 1.2);
    dir.position.set(80, 130, -60);
    this.scene.add(dir);
    this.sunLight = dir;

    // rim accent
    const fill = new THREE.DirectionalLight(0x7df9ff, 0.45);
    fill.position.set(-60, 30, 60);
    this.scene.add(fill);
  }

  _setupOcean() {
    // Far stylized "sea of clouds" plane below
    const geo = new THREE.PlaneGeometry(6000, 6000, 60, 60);
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
          float w = sin(p.x*0.012 + time*0.4) * cos(p.y*0.014 + time*0.3) * 18.0
                  + sin(p.x*0.04 + time*0.9) * 4.0;
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
          col = mix(col, c3, smoothstep(-15.0, 20.0, vH) * 0.55);
          float a = 0.55 + 0.25 * smoothstep(-15.0, 22.0, vH);
          gl_FragColor = vec4(col, a);
        }
      `
    });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = -120;
    m.frustumCulled = false;
    this.scene.add(m);
    this.ocean = m;
  }

  _setupStars() {
    // Distant glowing particles like fireflies / stardust
    const COUNT = this.quality === 'high' ? 800 : this.quality === 'med' ? 500 : 300;
    const positions = new Float32Array(COUNT * 3);
    const colors    = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      const r = 600 + Math.random() * 800;
      const a = Math.random() * Math.PI * 2;
      const b = (Math.random() - 0.5) * Math.PI * 0.6;
      positions[i * 3 + 0] = Math.cos(a) * Math.cos(b) * r;
      positions[i * 3 + 1] = Math.sin(b) * r * 0.6 + 80;
      positions[i * 3 + 2] = Math.sin(a) * Math.cos(b) * r;
      const c = new THREE.Color().setHSL(rand(0.5, 0.85), 0.7, 0.7);
      colors[i*3+0] = c.r; colors[i*3+1] = c.g; colors[i*3+2] = c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
      size: 4.2, sizeAttenuation: true,
      vertexColors: true, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending,
      map: this._makeSpriteTexture(), opacity: 0.9
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
  // CHUNK GENERATION
  // -----------------------------------------------------------
  prime() {
    // pre-spawn enough chunks ahead to cover the player's view
    for (let i = 0; i < this.aheadChunks; i++) this._spawnChunk();
  }

  _spawnChunk() {
    const z = this.spawnZ - this.chunkLength;
    const chunk = new THREE.Group();
    chunk.position.z = z;
    chunk.userData = {
      z,
      pickups: [],
      hazards: [],
      rings: [],
      crystals: []
    };

    const palette = choose(ISLAND_PALETTES);
    const variation = (this.travelled + Math.abs(z)) / 5000;

    // 2..4 islands per chunk in different lateral lanes
    const n = randInt(2, 4);
    for (let i = 0; i < n; i++) {
      const x = rand(-90, 90);
      const y = rand(-30, 50);
      const lz = rand(-this.chunkLength + 20, -20);
      this._spawnIsland(chunk, x, y, lz, palette, variation);
    }

    // rings: spawn 3..5 along the path
    const rings = randInt(3, 5);
    for (let i = 0; i < rings; i++) {
      const t = (i + rand(0.1, 0.9)) / rings;
      const lz = -t * this.chunkLength;
      const lx = Math.sin((Math.abs(z) * 0.002) + i * 1.7) * 35;
      const ly = Math.cos((Math.abs(z) * 0.003) + i * 2.3) * 20 + 8;
      this._spawnRing(chunk, lx, ly, lz);
    }

    // crystals (smaller pickups), more numerous
    const crystals = randInt(6, 10);
    for (let i = 0; i < crystals; i++) {
      const t = (i + rand(0.05, 0.95)) / crystals;
      const lz = -t * this.chunkLength;
      const lx = rand(-60, 60);
      const ly = rand(-20, 35);
      this._spawnCrystal(chunk, lx, ly, lz);
    }

    // hazards: storm clouds / asteroids — increase with travelled
    const hazardChance = clamp(0.25 + variation * 0.3, 0.25, 0.85);
    const haz = randInt(1, 3 + Math.floor(variation * 2));
    for (let i = 0; i < haz; i++) {
      if (Math.random() > hazardChance) continue;
      const lx = rand(-70, 70);
      const ly = rand(-15, 30);
      const lz = rand(-this.chunkLength + 10, -10);
      if (Math.random() < 0.55) this._spawnStorm(chunk, lx, ly, lz);
      else this._spawnRock(chunk, lx, ly, lz);
    }

    this.root.add(chunk);
    this.chunks.push(chunk);
    this.spawnZ = z;
  }

  // ---------- Smooth island (low-poly but rounded, NOT cubic) ----------
  _spawnIsland(parent, x, y, z, palette, variation) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    grp.rotation.y = rand(0, Math.PI * 2);

    // base rock (rounded blob using IcosahedronGeometry + noise)
    const radius = rand(8, 16);
    const baseGeo = new THREE.IcosahedronGeometry(radius, this.quality === 'high' ? 3 : 2);
    const pos = baseGeo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = (Math.sin(v.x * 0.4) + Math.cos(v.z * 0.5) + Math.sin(v.y * 0.6)) * 0.6;
      v.multiplyScalar(1 + n * 0.06);
      // squash bottom into a teardrop
      if (v.y < 0) v.y *= 1.5 + Math.random() * 0.5;
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    baseGeo.computeVertexNormals();

    const rockMat = new THREE.MeshStandardMaterial({
      color: palette.rock,
      roughness: 0.85, metalness: 0.05,
      flatShading: false
    });
    const base = new THREE.Mesh(baseGeo, rockMat);
    base.castShadow = false;
    grp.add(base);

    // grassy top cap
    const capGeo = new THREE.SphereGeometry(radius * 0.95, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.5);
    const capMat = new THREE.MeshStandardMaterial({
      color: palette.grass, roughness: 0.7, metalness: 0.0,
      emissive: new THREE.Color(palette.grass).multiplyScalar(0.05)
    });
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.y = radius * 0.05;
    cap.scale.set(1.02, 0.55, 1.02);
    grp.add(cap);

    // glow ring underneath (magic floating effect)
    const ringGeo = new THREE.TorusGeometry(radius * 1.2, 0.4, 12, 48);
    const ringMat = new THREE.MeshBasicMaterial({
      color: palette.glow, transparent: true, opacity: 0.45,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -radius * 0.6;
    grp.add(ring);

    // add some "trees" / spires
    const spires = randInt(2, 5);
    for (let i = 0; i < spires; i++) {
      const sh = rand(2.5, 5.5);
      const sg = new THREE.ConeGeometry(rand(0.6, 1.2), sh, 10);
      const sm = new THREE.MeshStandardMaterial({
        color: palette.accent,
        emissive: new THREE.Color(palette.accent).multiplyScalar(0.25),
        roughness: 0.4, metalness: 0.1
      });
      const s = new THREE.Mesh(sg, sm);
      const a = rand(0, Math.PI * 2);
      const r = rand(radius * 0.3, radius * 0.85);
      s.position.set(Math.cos(a) * r, radius * 0.4 + sh * 0.5, Math.sin(a) * r);
      grp.add(s);
    }

    // small floating crystals around island for feel
    if (Math.random() < 0.6) {
      const fc = new THREE.Mesh(
        new THREE.OctahedronGeometry(rand(0.8, 1.4)),
        new THREE.MeshStandardMaterial({
          color: palette.glow, emissive: palette.glow,
          emissiveIntensity: 0.9, roughness: 0.2, metalness: 0.4,
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

  // ---------- Ring pickup ----------
  _spawnRing(parent, x, y, z) {
    const radius = 7;
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    grp.rotation.y = rand(-0.3, 0.3);
    grp.rotation.x = rand(-0.15, 0.15);

    const geo = new THREE.TorusGeometry(radius, 0.55, 14, 64);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x7df9ff,
      emissive: 0x7df9ff, emissiveIntensity: 1.4,
      roughness: 0.3, metalness: 0.5,
      transparent: true, opacity: 0.95
    });
    const ring = new THREE.Mesh(geo, mat);
    grp.add(ring);

    // outer glow halo
    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(radius + 0.4, 1.4, 14, 64),
      new THREE.MeshBasicMaterial({
        color: 0x7df9ff, transparent: true, opacity: 0.18,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    grp.add(halo);

    // inner faint plate
    const inner = new THREE.Mesh(
      new THREE.CircleGeometry(radius - 0.7, 32),
      new THREE.MeshBasicMaterial({
        color: 0xb388ff, transparent: true, opacity: 0.08,
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

  // ---------- Crystal pickup ----------
  _spawnCrystal(parent, x, y, z) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    const geo = new THREE.OctahedronGeometry(1.2, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xff6ec7,
      emissive: 0xff6ec7, emissiveIntensity: 1.3,
      roughness: 0.15, metalness: 0.7,
      transparent: true, opacity: 0.95
    });
    const c = new THREE.Mesh(geo, mat);
    c.scale.y = 1.6;
    grp.add(c);
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(2.4, 12, 8),
      new THREE.MeshBasicMaterial({
        color: 0xff6ec7, transparent: true, opacity: 0.2,
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

  // ---------- Storm cloud hazard ----------
  _spawnStorm(parent, x, y, z) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    const radius = rand(8, 14);
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x441a3a, emissive: 0xff3b6b, emissiveIntensity: 0.45,
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

  // ---------- Rock asteroid hazard ----------
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
    // Move world rather than the player. Each chunk has fixed world Z.
    // Player always near origin; we move chunks toward +z.
    // -> But here we keep player moving in -z direction; we recycle chunks.
    this.travelled = -playerZ;
    if (this.sky.material.uniforms) this.sky.material.uniforms.time.value = time;
    if (this.ocean.material.uniforms) this.ocean.material.uniforms.time.value = time;

    // animate stars (slow rotation)
    this.stars.rotation.y += dt * 0.005;

    // bob islands & spin pickups
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

    // sky follows player horizontally so it always looks "infinite"
    this.sky.position.set(0, 0, playerZ);
    this.ocean.position.z = playerZ;
    this.stars.position.z = playerZ;

    // recycle chunks behind the player; spawn new ones ahead
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

  // gather all active pickups/hazards near player for collision
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
    // item.obj is local to chunk
    return new THREE.Vector3().addVectors(item.parent.position, item.obj.position);
  }
}
