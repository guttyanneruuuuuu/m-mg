// ===========================================================
// main.js — boots the game, owns the loop, ties modules.   (v2)
//   - cinematic camera follow with shake / FOV / banking
//   - time-slow on near-misses
//   - missions / objectives system (rotating goals = endless variety)
//   - improved boot sequence and adaptive renderer scaling
// ===========================================================

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass }from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }     from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass }     from 'three/addons/postprocessing/ShaderPass.js';
import { ChromaShader }   from './postfx.js';

import { InputManager } from './input.js';
import { HandTracker }  from './hand.js';
import { World }        from './world.js';
import { Player }       from './player.js';
import { Effects }      from './effects.js';
import { AudioEngine }  from './audio.js';
import { clamp, damp, lerp, Storage, isMobile, supportsTouch, choose } from './utils.js';

// =============== Element shortcuts ===============
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

// =============== Mission Banner (added dynamically) ===============
const missionBanner = document.createElement('div');
missionBanner.id = 'missionBanner';
missionBanner.className = 'mission-banner hidden';
missionBanner.innerHTML = `
  <div class="mission-icon">🎯</div>
  <div class="mission-text">
    <div class="mission-label">MISSION</div>
    <div class="mission-desc" id="missionDesc">—</div>
    <div class="mission-bar"><div class="mission-bar-fill" id="missionBarFill"></div></div>
  </div>
  <div class="mission-progress" id="missionProgress">0 / 5</div>
`;
ui.hud.appendChild(missionBanner);
const missionDesc  = $('missionDesc');
const missionBarFill = $('missionBarFill');
const missionProgress = $('missionProgress');

// recalibrate button (shown only in hand mode)
const recalBtn = document.createElement('button');
recalBtn.id = 'btnRecal';
recalBtn.className = 'hud-pill mini btn-pause hidden';
recalBtn.textContent = '⟳ 再キャリブ';
ui.hud.querySelector('.hud-bottom').appendChild(recalBtn);

function setLoader(p, msg) {
  ui.loaderFill.style.width = (p * 100).toFixed(0) + '%';
  if (msg) ui.loaderStatus.textContent = msg;
}

// =============== Game state ===============
const state = {
  running: false,
  paused: false,
  mode: 'hand',
  score: 0,
  combo: 1,
  comboTimer: 0,
  maxCombo: 1,
  best: Storage.load().best || 0,
  bestScore: Storage.load().bestScore || 0,
  quality: Storage.load().quality || (isMobile() ? 'med' : 'high'),
  mouseSens: Storage.load().mouseSens || 1.0,
  handSens: Storage.load().handSens || 1.2,
  mirror: Storage.load().mirror !== false,
  bgmVol: Storage.load().bgmVol ?? 0.5,
  sfxVol: Storage.load().sfxVol ?? 0.7,

  // missions
  mission: null,           // { id, label, target, progress, kind, reward }
  missionStreak: 0,

  // effects
  timeScale: 1.0,
  timeScaleTarget: 1.0,
};

// =============== Three.js setup ===============
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, powerPreference: 'high-performance', alpha: false
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, state.quality === 'high' ? 2 : 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 4000);
camera.position.set(0, 4, 14);

let composer = null;
let bloomPass = null;
let chromaPass = null;

function setupPost() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bs = state.quality === 'high' ? 0.95 : state.quality === 'med' ? 0.55 : 0.35;
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    bs, 0.7, 0.18
  );
  composer.addPass(bloomPass);

  // chromatic aberration + vignette + grain (custom shader)
  chromaPass = new ShaderPass(ChromaShader);
  chromaPass.uniforms.vignette.value = state.quality === 'low' ? 0.30 : 0.45;
  chromaPass.uniforms.grain.value    = state.quality === 'low' ? 0.02 : 0.05;
  composer.addPass(chromaPass);

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

// =============== Boot ===============
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
  const tb = $('titleBest'); if (tb) tb.textContent = state.best.toLocaleString();

  requestAnimationFrame(loop);
}

// =============== Missions ===============
const MISSION_TEMPLATES = [
  { kind: 'rings',    target: 5,  label: 'リングを {n} 個くぐれ',    reward: 1000 },
  { kind: 'rings',    target: 10, label: 'リングを {n} 個くぐれ',    reward: 2500 },
  { kind: 'crystals', target: 15, label: '結晶を {n} 個集めよ',     reward: 1500 },
  { kind: 'crystals', target: 25, label: '結晶を {n} 個集めよ',     reward: 3000 },
  { kind: 'distance', target: 1500, label: '{n} m 飛行せよ',        reward: 2000 },
  { kind: 'combo',    target: 10, label: 'コンボ x{n} を達成',      reward: 2500 },
  { kind: 'boost',    target: 12, label: 'ブーストで {n} 秒飛行',   reward: 2000 },
  { kind: 'noHit',    target: 800, label: '無傷で {n} m 飛行',      reward: 3500 }
];

function pickMission() {
  const tpl = choose(MISSION_TEMPLATES);
  return {
    kind: tpl.kind,
    target: tpl.target,
    progress: 0,
    label: tpl.label.replace('{n}', tpl.target),
    reward: tpl.reward,
    startPos: player ? player.pos.z : 0,
    startedAt: performance.now() / 1000
  };
}

function setMission(m) {
  state.mission = m;
  missionDesc.textContent = m.label;
  missionProgress.textContent = `0 / ${m.target}`;
  missionBarFill.style.width = '0%';
  missionBanner.classList.remove('hidden');
  missionBanner.classList.remove('done');
  flashMsg('NEW MISSION');
}

function progressMission(deltaProgress) {
  if (!state.mission) return;
  state.mission.progress += deltaProgress;
  const m = state.mission;
  const p = clamp(m.progress / m.target, 0, 1);
  missionBarFill.style.width = (p * 100).toFixed(0) + '%';
  missionProgress.textContent = `${Math.floor(m.progress).toLocaleString()} / ${m.target.toLocaleString()}`;
  if (m.progress >= m.target) {
    addScore(m.reward, false);
    missionBanner.classList.add('done');
    flashMsg(`MISSION CLEAR  +${m.reward}`);
    audio.combo(5);
    state.missionStreak++;
    setTimeout(() => setMission(pickMission()), 1500);
  }
}

// =============== Game flow ===============
function startGame(mode) {
  state.mode = mode;
  input.setMode(mode);
  state.score = 0;
  state.combo = 1; state.maxCombo = 1; state.comboTimer = 0;
  state.missionStreak = 0;
  state.timeScale = 1; state.timeScaleTarget = 1;

  if (player) {
    // dispose old trails
    for (const t of player.trails || []) {
      scene.remove(t.line);
      t.line.geometry.dispose();
      t.line.material.dispose();
    }
    scene.remove(player.root);
  }
  if (world) {
    for (const c of world.chunks) world._disposeChunk(c);
    world.chunks = []; world.spawnZ = 0; world.travelled = 0;
  }
  player = new Player(scene);
  fx = new Effects(scene);
  world.prime();

  ui.title.classList.add('hidden');
  ui.gameover.classList.add('hidden');
  ui.pause.classList.add('hidden');
  ui.hud.classList.remove('hidden');
  ui.modePill.textContent = `MODE: ${mode === 'hand' ? 'HAND' : mode === 'touch' ? 'TOUCH' : 'KEYBOARD'}`;
  ui.camPreview.classList.toggle('hidden', mode !== 'hand');
  ui.touchUI.classList.toggle('hidden',   mode !== 'touch');
  recalBtn.classList.toggle('hidden', mode !== 'hand');
  updateShieldUI();

  setMission(pickMission());

  state.running = true;
  state.paused = false;
  audio.unlock().then(() => audio.startMusic());

  if (mode === 'hand') {
    handTracker.start().catch(err => {
      console.warn('hand failed, falling back', err);
      flashMsg('ハンド起動失敗 — フォールバック');
      const fb = supportsTouch() ? 'touch' : 'keyboard';
      input.setMode(fb);
      state.mode = fb;
      ui.modePill.textContent = `MODE: ${fb.toUpperCase()}`;
      ui.camPreview.classList.add('hidden');
      ui.touchUI.classList.toggle('hidden', fb !== 'touch');
      recalBtn.classList.add('hidden');
    });
  } else {
    handTracker.stop();
    if (mode === 'touch' && isMobile()) {
      input.requestTiltPermission().then(granted => {
        input.tiltAssist = granted; // gentle tilt assist
      });
    }
  }
}

function endGame() {
  state.running = false;
  audio.gameover();
  audio.stopMusic();
  const dist = Math.max(0, Math.floor(-player.pos.z));
  const newDistRecord  = dist > state.best;
  const newScoreRecord = state.score > state.bestScore;
  if (newDistRecord)  { state.best = dist; Storage.patch({ best: dist }); }
  if (newScoreRecord) { state.bestScore = state.score; Storage.patch({ bestScore: state.score }); }
  ui.goScore.textContent = state.score.toLocaleString();
  ui.goDist.textContent  = dist.toLocaleString() + ' m';
  ui.goCombo.textContent = 'x' + state.maxCombo;
  ui.hudBest.textContent = state.best;
  // mark fields as record-breaking
  document.querySelectorAll('.go-stats > div').forEach(el => el.classList.remove('record'));
  if (newScoreRecord) document.querySelectorAll('.go-stats > div')[0]?.classList.add('record');
  if (newDistRecord)  document.querySelectorAll('.go-stats > div')[1]?.classList.add('record');
  setTimeout(() => {
    ui.gameover.classList.remove('hidden');
    if (newDistRecord || newScoreRecord) flashMsg('NEW RECORD!');
  }, 700);
  handTracker.stop();
  recalBtn.classList.add('hidden');
}

function quitToTitle() {
  state.running = false;
  audio.stopMusic();
  handTracker.stop();
  ui.hud.classList.add('hidden');
  ui.gameover.classList.add('hidden');
  ui.pause.classList.add('hidden');
  ui.title.classList.remove('hidden');
  recalBtn.classList.add('hidden');
}

// =============== UI bindings ===============
$('btnHandMode').addEventListener('click', () => {
  // show intro modal first time, then start
  $('handIntroScreen').classList.remove('hidden');
});
$('btnStartHand').addEventListener('click', () => {
  $('handIntroScreen').classList.add('hidden');
  startGame('hand');
});
$('btnHandCancel').addEventListener('click', () => {
  $('handIntroScreen').classList.add('hidden');
  startGame(supportsTouch() ? 'touch' : 'keyboard');
});
$('btnTouchMode').addEventListener('click', () => startGame(supportsTouch() ? 'touch' : 'keyboard'));
$('btnHowto').addEventListener('click', () => ui.howto.classList.remove('hidden'));
$('btnHowtoClose').addEventListener('click', () => ui.howto.classList.add('hidden'));
$('btnSettings').addEventListener('click', () => {
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
    quality: state.quality, mouseSens: state.mouseSens, handSens: state.handSens,
    mirror: state.mirror, bgmVol: state.bgmVol, sfxVol: state.sfxVol
  });
  input.mouseSens = state.mouseSens;
  input.handSens  = state.handSens;
  input.mirror    = state.mirror;
  audio.setBgm(state.bgmVol);
  audio.setSfx(state.sfxVol);
  if (bloomPass) {
    const bs = state.quality === 'high' ? 0.95 : state.quality === 'med' ? 0.55 : 0.35;
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

recalBtn.addEventListener('click', () => {
  handTracker.recalibrate();
  flashMsg('再キャリブ中…');
});

window.addEventListener('keydown', e => {
  if (e.code === 'Escape') {
    if (state.running && !ui.pause.classList.contains('hidden')) $('btnResume').click();
    else if (state.running) $('btnPause').click();
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

// =============== Camera follow (banking, smooth) ===============
const camOffset = new THREE.Vector3(0, 3.6, 12);
const camLookAhead = new THREE.Vector3(0, 1.2, -16);
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
let camShake = 0;
let camRollSmooth = 0;

function updateCamera(dt) {
  if (!player) return;
  // follow position behind ship
  _tmp.copy(camOffset).applyQuaternion(player.root.quaternion).add(player.root.position);
  // smooth (faster catch up at high speed)
  const speedNorm = clamp((player.speed - player.minSpeed) / (player.maxSpeed - player.minSpeed), 0, 1);
  const followL = lerp(6.5, 9.5, speedNorm);
  camera.position.lerp(_tmp, 1 - Math.exp(-followL * dt));

  // look ahead point
  _tmp2.copy(camLookAhead).applyQuaternion(player.root.quaternion).add(player.root.position);
  camera.lookAt(_tmp2);

  // bank camera slightly with player roll for cinematic feel
  const targetRoll = player.rollVisual * 0.45;
  camRollSmooth = damp(camRollSmooth, targetRoll, 5, dt);
  camera.rotation.z += camRollSmooth;

  // FOV with speed
  const targetFov = 70 + speedNorm * 22 + (player.boostActive ? 8 : 0);
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
  const near = world.gatherNear(playerPos.z, 240);

  // detect near misses with hazards (for time-slow effect)
  let nearMiss = false;

  for (const item of near.rings) {
    _wp.copy(item.parent.position).add(item.obj.position);
    const dz = _wp.z - playerPos.z;
    if (dz > -2 && dz < 6) {
      const dx = _wp.x - playerPos.x;
      const dy = _wp.y - playerPos.y;
      const r = Math.hypot(dx, dy);
      const isGate = item.obj.userData.kind === 'gate';
      const hitR = isGate ? item.obj.userData.radius * 0.95 : item.obj.userData.radius * 0.85;
      const verticalOK = !isGate || Math.abs(dy) < (item.obj.userData.halfHeight || 7);
      if (r < hitR && verticalOK) {
        if (isGate) {
          addScore(800, true);
          flashMsg('GATE BONUS!');
          fx.spawnRing(_wp.clone());
          fx.spawnPickup(_wp.clone(), 0xffd86b);
          audio.combo(3);
          // gates also bump combo by extra
          state.combo = Math.min(state.combo + 2, 99);
          state.maxCombo = Math.max(state.maxCombo, state.combo);
          state.comboTimer = 5.0;
        } else {
          const perfect = r < item.obj.userData.radius * 0.35;
          const bonus = perfect ? 500 : 250;
          addScore(bonus, true);
          flashMsg(perfect ? 'PERFECT!' : 'RING!');
          fx.spawnRing(_wp.clone());
          audio.ringPass();
          player.speed = clamp(player.speed + 32, player.minSpeed, player.maxSpeed);
          if (state.mission?.kind === 'rings') progressMission(1);
        }
        item.obj.userData.alive = false;
        item.parent.remove(item.obj);
      }
    }
  }
  for (const item of near.crystals) {
    _wp.copy(item.parent.position).add(item.obj.position);
    const isPower = item.obj.userData.kind === 'power';
    const hitR = isPower ? 4.0 : 3.6;
    if (_wp.distanceTo(playerPos) < hitR) {
      if (isPower) {
        applyPower(item.obj.userData.power, _wp);
      } else {
        addScore(120, true);
        fx.spawnPickup(_wp.clone(), 0xff6ec7);
        audio.pickup();
        if (state.mission?.kind === 'crystals') progressMission(1);
      }
      item.obj.userData.alive = false;
      item.parent.remove(item.obj);
    }
  }
  for (const item of near.hazards) {
    _wp.copy(item.parent.position).add(item.obj.position);
    const r = item.obj.userData.radius * 0.9 + 1.6;
    const d = _wp.distanceTo(playerPos);
    if (d < r) {
      const took = player.damage();
      if (took) {
        camShake = 0.7;
        damageFlash();
        fx.spawnHit(playerPos.clone());
        audio.hit();
        updateShieldUI();
        breakCombo();
        if (state.mission?.kind === 'noHit') {
          // reset noHit progress
          state.mission.progress = 0;
          state.mission.startPos = player.pos.z;
          missionBarFill.style.width = '0%';
          missionProgress.textContent = `0 / ${state.mission.target.toLocaleString()}`;
        }
        if (!player.alive) endGame();
      }
      item.obj.userData.alive = false;
      item.parent.remove(item.obj);
    } else if (d < r * 2.4 && Math.abs(_wp.z - playerPos.z) < 8) {
      nearMiss = true;
    }
  }

  // time-slow on near miss for 0.4s
  if (nearMiss) {
    state.timeScaleTarget = 0.55;
    setTimeout(() => state.timeScaleTarget = 1, 350);
  }
}

function scorePopup(amount, color = '') {
  const layer = $('scorePopups');
  if (!layer) return;
  const el = document.createElement('div');
  el.className = 'score-popup ' + color;
  el.textContent = '+' + amount.toLocaleString();
  // project player position to screen for source point
  const v = player.pos.clone().project(camera);
  const x = (v.x * 0.5 + 0.5) * window.innerWidth;
  const y = (1 - (v.y * 0.5 + 0.5)) * window.innerHeight;
  // jitter so multiple don't overlap
  const jx = (Math.random() - 0.5) * 80;
  el.style.left = (x + jx) + 'px';
  el.style.top  = (y - 40) + 'px';
  layer.appendChild(el);
  setTimeout(() => el.remove(), 1100);
}

function applyPower(kind, pos) {
  fx.spawnPickup(pos.clone(), kind === 'shield' ? 0x7df9ff : kind === 'slowmo' ? 0xb388ff : 0xffd86b);
  fx.spawnRing(pos.clone());
  audio.combo(4);
  if (kind === 'shield') {
    if (player.shields < 3) {
      player.shields++;
      updateShieldUI();
      flashMsg('+SHIELD');
    } else {
      addScore(800, true);
      flashMsg('SHIELD MAX  +800');
    }
  } else if (kind === 'slowmo') {
    state.timeScaleTarget = 0.45;
    setTimeout(() => state.timeScaleTarget = 1, 2200);
    flashMsg('TIME SLOW');
  } else if (kind === 'mega') {
    addScore(2000, true);
    player.boostFuel = 1;
    flashMsg('MEGA  +2000');
  }
}

function addScore(base, combo) {
  const mult = combo ? state.combo : 1;
  const gained = base * mult;
  state.score += gained;
  // popup color cue
  const c = base >= 1000 ? 'gold' : base >= 500 ? 'violet' : base >= 200 ? 'pink' : '';
  scorePopup(gained, c);
  if (combo) {
    state.comboTimer = 4.0;
    state.combo = Math.min(state.combo + 1, 99);
    state.maxCombo = Math.max(state.maxCombo, state.combo);
    if (state.combo === 5 || state.combo === 10 || state.combo === 20 || state.combo === 50) {
      flashCombo(state.combo);
      audio.combo(Math.floor(state.combo / 5));
    }
    if (state.mission?.kind === 'combo' && state.combo > state.mission.progress) {
      state.mission.progress = state.combo;
      const p = clamp(state.combo / state.mission.target, 0, 1);
      missionBarFill.style.width = (p * 100).toFixed(0) + '%';
      missionProgress.textContent = `${state.combo} / ${state.mission.target}`;
      if (state.combo >= state.mission.target) progressMission(0);
    }
  }
}
function breakCombo() {
  state.combo = 1;
  state.comboTimer = 0;
}

// =============== HUD ===============
let fpsAcc = 0, fpsFrames = 0;
let _lastDistMission = 0;
function updateHud(dt) {
  ui.hudScore.textContent = state.score.toLocaleString();
  ui.hudCombo.textContent = 'x' + state.combo;
  ui.hudSpeed.textContent = String(Math.floor(player.speed * 1.6)).padStart(3, '0');
  ui.hudDist.textContent  = Math.max(0, Math.floor(-player.pos.z)).toLocaleString();

  const off = (1 - player.boostFuel) * 289;
  ui.boostRing.setAttribute('stroke-dashoffset', off.toFixed(1));
  ui.boostRing.setAttribute('stroke', player.boostActive ? '#ff6ec7' : '#7df9ff');

  const sNorm = clamp((player.speed - player.minSpeed) / (player.maxSpeed - player.minSpeed), 0, 1);
  ui.speedLines.classList.toggle('boost', sNorm > 0.7 || player.boostActive);

  // mission distance / boost progress
  if (state.mission) {
    const m = state.mission;
    const dist = -player.pos.z - (m.startPos || 0);
    if (m.kind === 'distance' && dist > m.progress) {
      m.progress = Math.floor(dist);
      const p = clamp(m.progress / m.target, 0, 1);
      missionBarFill.style.width = (p * 100).toFixed(0) + '%';
      missionProgress.textContent = `${m.progress.toLocaleString()} / ${m.target.toLocaleString()} m`;
      if (m.progress >= m.target) progressMission(0);
    } else if (m.kind === 'noHit') {
      m.progress = Math.max(0, Math.floor(dist));
      const p = clamp(m.progress / m.target, 0, 1);
      missionBarFill.style.width = (p * 100).toFixed(0) + '%';
      missionProgress.textContent = `${m.progress.toLocaleString()} / ${m.target.toLocaleString()} m`;
      if (m.progress >= m.target) progressMission(0);
    } else if (m.kind === 'boost') {
      if (player.boostActive) {
        m.progress += dt;
        const p = clamp(m.progress / m.target, 0, 1);
        missionBarFill.style.width = (p * 100).toFixed(0) + '%';
        missionProgress.textContent = `${m.progress.toFixed(1)} / ${m.target} s`;
        if (m.progress >= m.target) progressMission(0);
      }
    }
  }

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
  let rawDt = (now - last) / 1000;
  last = now;
  if (rawDt > 0.1) rawDt = 0.1;
  const time = now / 1000;

  // smooth time scale (for near-miss time-slow effect)
  state.timeScale = damp(state.timeScale, state.timeScaleTarget, 8, rawDt);
  const dt = rawDt * state.timeScale;

  // chroma/vignette amount tied to speed & boost
  if (chromaPass && player) {
    const sNorm = clamp((player.speed - player.minSpeed) / (player.maxSpeed - player.minSpeed), 0, 1);
    const target = (player.boostActive ? 0.012 : 0.003) + sNorm * 0.012;
    chromaPass.uniforms.amount.value = damp(chromaPass.uniforms.amount.value, target, 6, rawDt);
    chromaPass.uniforms.radius.value = damp(chromaPass.uniforms.radius.value, sNorm * 0.025, 4, rawDt);
    chromaPass.uniforms.time.value = time;
  }

  input.update(rawDt); // input always real-time

  if (state.running && !state.paused) {
    player.update(dt, input, time);
    world.update(dt, time, player.pos.z);
    processCollisions(dt);
    fx.update(dt);

    if (state.comboTimer > 0) {
      state.comboTimer -= dt;
      if (state.comboTimer <= 0) breakCombo();
    }
    updateHud(rawDt);
  } else if (world && player) {
    // idle title scene
    player.root.rotation.y += rawDt * 0.04;
    fx?.update(rawDt);
    world.update(rawDt, time, player.pos.z);
  }

  updateCamera(rawDt);

  if (composer) composer.render();
  else renderer.render(scene, camera);
}

bootSequence().catch(err => {
  console.error(err);
  ui.loaderStatus.textContent = '初期化エラー: ' + (err?.message || err);
});

window.__SKYRIFT__ = { state, input, audio, scene, camera, renderer };
