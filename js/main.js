// ===========================================================
// main.js — boots the game, owns the loop, ties modules together.
// ===========================================================

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass }from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }     from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass }     from 'three/addons/postprocessing/ShaderPass.js';

import { InputManager } from './input.js';
import { HandTracker }  from './hand.js';
import { World }        from './world.js';
import { Player }       from './player.js';
import { Effects }      from './effects.js';
import { AudioEngine }  from './audio.js';
import { clamp, damp, lerp, Storage, isMobile, supportsTouch } from './utils.js';

// =============== Boot screens ===============
const $ = (id) => document.getElementById(id);

const ui = {
  loading: $('loadingScreen'),
  loaderFill: $('loaderFill'),
  loaderStatus: $('loaderStatus'),
  title: $('titleScreen'),
  howto: $('howtoScreen'),
  settings: $('settingsScreen'),
  hud: $('hud'),
  pause: $('pauseOverlay'),
  gameover: $('gameoverScreen'),

  hudScore: $('hudScore'),
  hudCombo: $('hudCombo'),
  hudSpeed: $('hudSpeed'),
  hudDist:  $('hudDist'),
  hudBest:  $('hudBest'),
  fpsPill:  $('fpsPill'),
  modePill: $('modePill'),
  comboPill:$('comboPill'),
  bigMsg:   $('bigMsg'),
  comboFlash: $('comboFlash'),
  boostRing: $('boostRing'),

  speedLines: $('speedLines'),
  damageFlash:$('damageFlash'),
  camPreview: $('camPreview'),
  touchUI:   $('touchUI'),

  goScore: $('goScore'),
  goDist:  $('goDist'),
  goCombo: $('goCombo'),

  shieldOrbs: document.querySelectorAll('.shield-orb'),
};

function setLoader(p, msg) {
  ui.loaderFill.style.width = (p * 100).toFixed(0) + '%';
  if (msg) ui.loaderStatus.textContent = msg;
}

// =============== Game state ===============
const state = {
  running: false,
  paused: false,
  mode: 'hand', // 'hand' | 'touch' | 'keyboard'
  score: 0,
  combo: 1,
  comboTimer: 0,
  maxCombo: 1,
  best: Storage.load().best || 0,
  quality: Storage.load().quality || (isMobile() ? 'med' : 'high'),
  mouseSens: Storage.load().mouseSens || 1.0,
  handSens: Storage.load().handSens || 1.2,
  mirror: Storage.load().mirror !== false,
  bgmVol: Storage.load().bgmVol ?? 0.5,
  sfxVol: Storage.load().sfxVol ?? 0.7,
};

// =============== Three.js setup ===============
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, powerPreference: 'high-performance', alpha: false
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, state.quality === 'high' ? 2 : 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 4000);
camera.position.set(0, 4, 14);

// post-processing
let composer = null;
let bloomPass = null;

function setupPost() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bs = state.quality === 'high' ? 0.85 : state.quality === 'med' ? 0.5 : 0.32;
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    bs, 0.7, 0.18
  );
  composer.addPass(bloomPass);

  composer.addPass(new OutputPass());

  resize();
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (composer) composer.setSize(w, h);
  if (bloomPass) bloomPass.setSize(w, h);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));

// =============== Build subsystems ===============
const input = new InputManager();
input.mouseSens = state.mouseSens;
input.handSens  = state.handSens;
input.mirror    = state.mirror;

const audio  = new AudioEngine();
audio.setBgm(state.bgmVol);
audio.setSfx(state.sfxVol);

const handTracker = new HandTracker(input);

let world, player, fx;

// =============== Game flow ===============
async function bootSequence() {
  setLoader(0.05, 'エンジンを起動中…');
  await new Promise(r => setTimeout(r, 200));
  setLoader(0.25, 'シェーダーを構築中…');
  setupPost();
  await new Promise(r => setTimeout(r, 200));
  setLoader(0.55, '世界を生成中…');
  world = new World(scene, state.quality);
  world.prime();
  await new Promise(r => setTimeout(r, 200));
  setLoader(0.8, '機体をチェック中…');
  player = new Player(scene);
  fx = new Effects(scene);
  await new Promise(r => setTimeout(r, 200));
  setLoader(1.0, '準備完了');
  await new Promise(r => setTimeout(r, 250));
  ui.loading.classList.add('hidden');
  ui.title.classList.remove('hidden');
  ui.hudBest.textContent = state.best;

  // Start render loop (idle preview behind title)
  requestAnimationFrame(loop);
}

function startGame(mode) {
  state.mode = mode;
  input.setMode(mode);
  // reset
  state.score = 0;
  state.combo = 1; state.maxCombo = 1; state.comboTimer = 0;
  // recreate fresh world+player to ensure clean state
  if (player) scene.remove(player.root);
  if (world)  { for (const c of world.chunks) world._disposeChunk(c); world.chunks = []; world.spawnZ = 0; world.travelled = 0; }
  player = new Player(scene);
  fx = new Effects(scene);
  world.prime();

  ui.title.classList.add('hidden');
  ui.gameover.classList.add('hidden');
  ui.pause.classList.add('hidden');
  ui.hud.classList.remove('hidden');
  ui.modePill.textContent = `MODE: ${mode === 'hand' ? 'HAND' : mode === 'touch' ? 'TOUCH' : 'KEYBOARD'}`;
  // toggle mode-specific UI
  ui.camPreview.classList.toggle('hidden', mode !== 'hand');
  ui.touchUI.classList.toggle('hidden',   mode !== 'touch');
  updateShieldUI();

  state.running = true;
  state.paused = false;
  audio.unlock().then(() => audio.startMusic());

  if (mode === 'hand') {
    handTracker.start().catch(err => {
      console.warn('hand failed, falling back to touch', err);
      flashMsg('ハンド起動失敗 — タッチに切替');
      input.setMode(supportsTouch() ? 'touch' : 'keyboard');
      state.mode = supportsTouch() ? 'touch' : 'keyboard';
      ui.modePill.textContent = `MODE: ${state.mode.toUpperCase()}`;
      ui.camPreview.classList.add('hidden');
      ui.touchUI.classList.toggle('hidden', state.mode !== 'touch');
    });
  } else {
    handTracker.stop();
  }
}

function endGame() {
  state.running = false;
  audio.gameover();
  audio.stopMusic();
  // best
  const dist = Math.max(0, Math.floor(-player.pos.z));
  if (dist > state.best) { state.best = dist; Storage.patch({ best: dist }); }
  ui.goScore.textContent = state.score.toLocaleString();
  ui.goDist.textContent  = dist.toLocaleString() + ' m';
  ui.goCombo.textContent = 'x' + state.maxCombo;
  ui.hudBest.textContent = state.best;
  setTimeout(() => ui.gameover.classList.remove('hidden'), 700);
  handTracker.stop();
}

function quitToTitle() {
  state.running = false;
  audio.stopMusic();
  handTracker.stop();
  ui.hud.classList.add('hidden');
  ui.gameover.classList.add('hidden');
  ui.pause.classList.add('hidden');
  ui.title.classList.remove('hidden');
}

// =============== UI bindings ===============
$('btnHandMode').addEventListener('click', () => startGame('hand'));
$('btnTouchMode').addEventListener('click', () => startGame(supportsTouch() ? 'touch' : 'keyboard'));
$('btnHowto').addEventListener('click', () => ui.howto.classList.remove('hidden'));
$('btnHowtoClose').addEventListener('click', () => ui.howto.classList.add('hidden'));
$('btnSettings').addEventListener('click', () => {
  // reflect current values
  $('setQuality').value = state.quality;
  $('setMouseSens').value = state.mouseSens;
  $('setHandSens').value = state.handSens;
  $('setMirror').checked = state.mirror;
  $('setBgm').value = state.bgmVol;
  $('setSfx').value = state.sfxVol;
  ui.settings.classList.remove('hidden');
});
$('btnSettingsClose').addEventListener('click', () => {
  state.quality = $('setQuality').value;
  state.mouseSens = parseFloat($('setMouseSens').value);
  state.handSens  = parseFloat($('setHandSens').value);
  state.mirror    = $('setMirror').checked;
  state.bgmVol    = parseFloat($('setBgm').value);
  state.sfxVol    = parseFloat($('setSfx').value);
  Storage.patch({
    quality: state.quality,
    mouseSens: state.mouseSens,
    handSens: state.handSens,
    mirror: state.mirror,
    bgmVol: state.bgmVol,
    sfxVol: state.sfxVol
  });
  input.mouseSens = state.mouseSens;
  input.handSens = state.handSens;
  input.mirror = state.mirror;
  audio.setBgm(state.bgmVol);
  audio.setSfx(state.sfxVol);
  // bloom update
  if (bloomPass) {
    const bs = state.quality === 'high' ? 0.85 : state.quality === 'med' ? 0.5 : 0.32;
    bloomPass.strength = bs;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, state.quality === 'high' ? 2 : 1.5));
  resize();
  ui.settings.classList.add('hidden');
});

$('btnPause').addEventListener('click', () => {
  if (!state.running) return;
  state.paused = !state.paused;
  ui.pause.classList.toggle('hidden', !state.paused);
  if (state.paused) audio.stopMusic(); else audio.startMusic();
});
$('btnResume').addEventListener('click', () => {
  state.paused = false;
  ui.pause.classList.add('hidden');
  audio.startMusic();
});
$('btnQuit').addEventListener('click', quitToTitle);
$('btnRetry').addEventListener('click', () => startGame(state.mode));
$('btnGoTitle').addEventListener('click', quitToTitle);

// keyboard shortcuts
window.addEventListener('keydown', e => {
  if (e.code === 'Escape') {
    if (state.running && !ui.pause.classList.contains('hidden')) {
      $('btnResume').click();
    } else if (state.running) {
      $('btnPause').click();
    }
  }
});

// =============== Helpers ===============
function flashMsg(txt) {
  ui.bigMsg.textContent = txt;
  ui.bigMsg.classList.remove('show');
  void ui.bigMsg.offsetWidth;
  ui.bigMsg.classList.add('show');
}
function flashCombo(n) {
  if (n < 2) return;
  ui.comboFlash.textContent = `x${n}`;
  ui.comboFlash.classList.remove('show');
  void ui.comboFlash.offsetWidth;
  ui.comboFlash.classList.add('show');
  ui.comboPill.classList.remove('flash');
  void ui.comboPill.offsetWidth;
  ui.comboPill.classList.add('flash');
}
function updateShieldUI() {
  ui.shieldOrbs.forEach((el, i) => {
    el.classList.toggle('on',  i < player.shields);
    el.classList.toggle('off', i >= player.shields);
  });
}
function damageFlash() {
  ui.damageFlash.classList.remove('hit');
  void ui.damageFlash.offsetWidth;
  ui.damageFlash.classList.add('hit');
}

// =============== Camera follow ===============
const camOffset = new THREE.Vector3(0, 3.4, 11);
const camLookAhead = new THREE.Vector3(0, 1.0, -14);
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
let camShake = 0;

function updateCamera(dt) {
  if (!player) return;
  // local follow position behind ship
  _tmp.copy(camOffset).applyQuaternion(player.root.quaternion).add(player.root.position);
  // smooth
  camera.position.lerp(_tmp, 1 - Math.exp(-7 * dt));

  // look ahead point
  _tmp2.copy(camLookAhead).applyQuaternion(player.root.quaternion).add(player.root.position);
  camera.lookAt(_tmp2);

  // FOV with speed
  const sNorm = clamp((player.speed - player.minSpeed) / (player.maxSpeed - player.minSpeed), 0, 1);
  const targetFov = 70 + sNorm * 20 + (player.boostActive ? 6 : 0);
  camera.fov = damp(camera.fov, targetFov, 4, dt);
  camera.updateProjectionMatrix();

  // shake
  if (camShake > 0) {
    camera.position.x += (Math.random() - 0.5) * camShake;
    camera.position.y += (Math.random() - 0.5) * camShake;
    camShake *= 0.86;
    if (camShake < 0.01) camShake = 0;
  }
}

// =============== Collisions ===============
const _wp = new THREE.Vector3();

function processCollisions(dt) {
  if (!player.alive) return;
  const playerPos = player.pos;
  const near = world.gatherNear(playerPos.z, 220);

  for (const item of near.rings) {
    _wp.copy(item.parent.position).add(item.obj.position);
    const dz = _wp.z - playerPos.z;
    // rings give bonus when player flies through
    if (dz > -2 && dz < 6) {
      // check radial distance projected onto plane (XY)
      const dx = _wp.x - playerPos.x;
      const dy = _wp.y - playerPos.y;
      const r = Math.hypot(dx, dy);
      if (r < item.obj.userData.radius * 0.85) {
        // perfect-pass bonus if very close to center
        const bonus = r < item.obj.userData.radius * 0.35 ? 500 : 250;
        addScore(bonus, /*combo*/ true);
        flashMsg(r < item.obj.userData.radius * 0.35 ? 'PERFECT!' : 'RING!');
        fx.spawnRing(_wp.clone());
        audio.ringPass();
        // small boost
        player.speed = clamp(player.speed + 30, player.minSpeed, player.maxSpeed);
        item.obj.userData.alive = false;
        item.parent.remove(item.obj);
      }
    }
  }
  for (const item of near.crystals) {
    _wp.copy(item.parent.position).add(item.obj.position);
    if (_wp.distanceTo(playerPos) < 3.4) {
      addScore(120, true);
      fx.spawnPickup(_wp.clone(), 0xff6ec7);
      audio.pickup();
      item.obj.userData.alive = false;
      item.parent.remove(item.obj);
    }
  }
  for (const item of near.hazards) {
    _wp.copy(item.parent.position).add(item.obj.position);
    const r = item.obj.userData.radius * 0.9 + 1.6;
    if (_wp.distanceTo(playerPos) < r) {
      const took = player.damage();
      if (took) {
        camShake = 0.6;
        damageFlash();
        fx.spawnHit(playerPos.clone());
        audio.hit();
        updateShieldUI();
        breakCombo();
        if (!player.alive) endGame();
      }
      // remove hazard so we don't double-hit
      item.obj.userData.alive = false;
      item.parent.remove(item.obj);
    }
  }
}

function addScore(base, combo) {
  const mult = combo ? state.combo : 1;
  const gained = base * mult;
  state.score += gained;
  if (combo) {
    state.comboTimer = 4.0;
    state.combo = Math.min(state.combo + 1, 99);
    state.maxCombo = Math.max(state.maxCombo, state.combo);
    if (state.combo === 5 || state.combo === 10 || state.combo === 20 || state.combo === 50) {
      flashCombo(state.combo);
      audio.combo(Math.floor(state.combo / 5));
    }
  }
}
function breakCombo() {
  state.combo = 1;
  state.comboTimer = 0;
}

// =============== HUD ===============
let fpsAcc = 0, fpsFrames = 0;
function updateHud(dt) {
  ui.hudScore.textContent = state.score.toLocaleString();
  ui.hudCombo.textContent = 'x' + state.combo;
  ui.hudSpeed.textContent = String(Math.floor(player.speed * 1.6)).padStart(3, '0');
  ui.hudDist.textContent  = Math.max(0, Math.floor(-player.pos.z)).toLocaleString();

  // shield
  // (updated in event)

  // boost ring
  const off = (1 - player.boostFuel) * 289;
  ui.boostRing.setAttribute('stroke-dashoffset', off.toFixed(1));
  ui.boostRing.setAttribute('stroke', player.boostActive ? '#ff6ec7' : '#7df9ff');

  // speed lines
  const sNorm = clamp((player.speed - player.minSpeed) / (player.maxSpeed - player.minSpeed), 0, 1);
  ui.speedLines.classList.toggle('boost', sNorm > 0.7 || player.boostActive);

  // fps
  fpsAcc += dt; fpsFrames++;
  if (fpsAcc > 0.5) {
    const fps = fpsFrames / fpsAcc;
    ui.fpsPill.textContent = `${Math.round(fps)} FPS`;
    fpsAcc = 0; fpsFrames = 0;
  }
}

// =============== Loop ===============
let last = performance.now();
function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1;
  const time = now / 1000;

  // input always updates so menus feel alive
  input.update(dt);

  if (state.running && !state.paused) {
    player.update(dt, input, time);
    world.update(dt, time, player.pos.z);
    processCollisions(dt);
    fx.update(dt);

    // combo timer
    if (state.comboTimer > 0) {
      state.comboTimer -= dt;
      if (state.comboTimer <= 0) breakCombo();
    }
    updateHud(dt);
  } else if (world && player) {
    // idle — slowly drift player & world for cinematic title
    player.root.rotation.y += dt * 0.04;
    fx?.update(dt);
    world.update(dt, time, player.pos.z);
  }

  updateCamera(dt);

  if (composer) composer.render();
  else renderer.render(scene, camera);
}

// =============== KICK OFF ===============
bootSequence().catch(err => {
  console.error(err);
  ui.loaderStatus.textContent = '初期化エラー: ' + (err?.message || err);
});

// expose for debugging
window.__SKYRIFT__ = { state, input, audio, scene, camera, renderer };
