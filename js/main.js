// ===========================================================
// main.js — STARFORGE: hand-controlled space combat survivor
//   - Wave/stage progression with bosses
//   - Persistent meta-upgrades (Dada Survivor / Vampire Survivors style)
//   - Salvage currency dropped by enemies / asteroids / pickups
//   - 100-stage clear target with curve scaling
// ===========================================================

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass }from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }     from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass }     from 'three/addons/postprocessing/ShaderPass.js';
import { ChromaShader }   from './postfx.js';

import { InputManager, FIRE_GESTURES } from './input.js';
import { HandTracker }  from './hand.js';
import { World }        from './world.js';
import { Player }       from './player.js';
import { Effects }      from './effects.js';
import { AudioEngine }  from './audio.js';
import { EnemyManager, ProjectileManager } from './enemies.js';
import { UpgradeBank, UPGRADES, UPGRADE_ORDER } from './upgrades.js';
import { clamp, damp, lerp, Storage, isMobile, supportsTouch, choose } from './utils.js';

const $ = (id) => document.getElementById(id);

const ui = {
  loading: $('loadingScreen'),
  loaderFill: $('loaderFill'),
  loaderStatus: $('loaderStatus'),
  title: $('titleScreen'),
  howto: $('howtoScreen'),
  settings: $('settingsScreen'),
  hangar: $('hangarScreen'),
  hud: $('hud'),
  pause: $('pauseOverlay'),
  gameover: $('gameoverScreen'),
  stageClear: $('stageClearScreen'),
  victory: $('victoryScreen'),

  hudScore: $('hudScore'),
  hudSalvage: $('hudSalvage'),
  hudStage: $('hudStage'),
  hudWave: $('hudWave'),
  hudSpeed: $('hudSpeed'),
  hudHpFill: $('hudHpFill'),
  hudHpText: $('hudHpText'),
  hudBossBar: $('hudBossBar'),
  hudBossFill: $('hudBossFill'),
  hudMissile: $('hudMissile'),
  fpsPill:  $('fpsPill'),
  modePill: $('modePill'),
  bigMsg:   $('bigMsg'),
  comboFlash: $('comboFlash'),
  boostRing: $('boostRing'),

  speedLines: $('speedLines'),
  damageFlash:$('damageFlash'),
  camPreview: $('camPreview'),
  touchUI:   $('touchUI'),

  goScore: $('goScore'),
  goStage: $('goStage'),
  goSalvage: $('goSalvage'),
  goKills: $('goKills'),
};

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
  bestScore: Storage.load().bestScore || 0,
  quality: Storage.load().quality || (isMobile() ? 'med' : 'high'),
  mouseSens: Storage.load().mouseSens || 1.0,
  handSens: Storage.load().handSens || 1.2,
  mirror: Storage.load().mirror !== false,
  bgmVol: Storage.load().bgmVol ?? 0.45,
  sfxVol: Storage.load().sfxVol ?? 0.7,

  stage: 1,
  runKills: 0,
  runSalvage: 0,
  bossWarned: false,
  stageStartZ: 0,
  stageDistanceTarget: 200,
  salvageMul: 1,

  timeScale: 1.0,
  timeScaleTarget: 1.0,
};

const bank = new UpgradeBank();

// =============== Three.js setup ===============
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, powerPreference: 'high-performance', alpha: false
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, state.quality === 'high' ? 2 : 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 4000);
camera.position.set(0, 4, 14);

let composer = null;
let bloomPass = null;
let chromaPass = null;

function setupPost() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bs = state.quality === 'high' ? 0.50 : state.quality === 'med' ? 0.32 : 0.20;
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    bs, 0.6, 0.55
  );
  composer.addPass(bloomPass);

  chromaPass = new ShaderPass(ChromaShader);
  chromaPass.uniforms.vignette.value = state.quality === 'low' ? 0.30 : 0.5;
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

let world, player, fx, enemyMgr, projMgr;

// =============== Boot ===============
async function bootSequence() {
  setLoader(0.05, 'システムを起動中…');
  await new Promise(r => setTimeout(r, 200));
  setLoader(0.25, 'シェーダーを構築中…');
  setupPost();
  await new Promise(r => setTimeout(r, 200));
  setLoader(0.55, '宇宙空間を生成中…');
  world = new World(scene, state.quality);
  world.prime();
  await new Promise(r => setTimeout(r, 200));
  setLoader(0.8, '機体を整備中…');
  player = new Player(scene, bank.composeStats());
  fx = new Effects(scene, camera);
  enemyMgr = new EnemyManager(scene);
  projMgr = new ProjectileManager(scene);
  await new Promise(r => setTimeout(r, 200));
  setLoader(1.0, '準備完了');
  await new Promise(r => setTimeout(r, 250));
  ui.loading.classList.add('hidden');
  ui.title.classList.remove('hidden');
  refreshTitleStats();

  requestAnimationFrame(loop);
}

function refreshTitleStats() {
  $('titleStage').textContent = bank.bestStage;
  $('titleSalvage').textContent = bank.salvage.toLocaleString();
  $('titleScore').textContent = bank.bestScore.toLocaleString();
}

// =============== Game flow ===============
function startGame(mode) {
  state.mode = mode;
  input.setMode(mode);
  state.score = 0;
  state.runKills = 0;
  state.runSalvage = 0;
  state.bossWarned = false;
  state.timeScale = 1; state.timeScaleTarget = 1;
  state.stage = bank.stage;       // continue from where you left off (capped at 100)
  if (state.stage > 100) state.stage = 100;

  // dispose old player
  if (player) {
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
  if (enemyMgr) enemyMgr.cleanup();
  if (projMgr) projMgr.cleanup();

  // build player from upgrade stats
  const stats = bank.composeStats();
  state.salvageMul = stats.salvageMul || 1;
  player = new Player(scene, stats);
  // apply shield-regen tuning
  if (stats.shieldRegenRate)  player.shieldRegenRate  = stats.shieldRegenRate;
  if (stats.shieldRegenDelay) player.shieldRegenDelay = stats.shieldRegenDelay;
  player.missileMax = stats.missileAmmo || 0;
  player.missileAmmo = player.missileMax;          // start full

  fx = new Effects(scene, camera);
  world.setStage(state.stage);
  world.prime();
  enemyMgr.setStage(state.stage, player.pos.z);
  state.stageStartZ = player.pos.z;
  state.stageDistanceTarget = 180 + state.stage * 6;   // longer in later stages

  ui.title.classList.add('hidden');
  ui.gameover.classList.add('hidden');
  ui.pause.classList.add('hidden');
  ui.hangar.classList.add('hidden');
  ui.stageClear.classList.add('hidden');
  ui.victory.classList.add('hidden');
  ui.hud.classList.remove('hidden');
  ui.modePill.textContent = `${mode === 'hand' ? 'HAND' : mode === 'touch' ? 'TOUCH' : 'KEYBOARD'}`;
  ui.camPreview.classList.toggle('hidden', mode !== 'hand');
  ui.touchUI.classList.toggle('hidden',   mode !== 'touch');
  recalBtn.classList.toggle('hidden', mode !== 'hand');
  ui.hudBossBar.classList.add('hidden');
  updateHpUI();
  updateMissileUI();
  flashMsg(`STAGE ${state.stage}`);

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
      ui.modePill.textContent = fb.toUpperCase();
      ui.camPreview.classList.add('hidden');
      ui.touchUI.classList.toggle('hidden', fb !== 'touch');
      recalBtn.classList.add('hidden');
    });
  } else {
    handTracker.stop();
    if (mode === 'touch' && isMobile()) {
      input.requestTiltPermission().then(granted => {
        input.tiltAssist = granted;
      });
    }
  }
}

function endGame() {
  state.running = false;
  audio.gameover();
  audio.stopMusic();
  // bank salvage from this run
  bank.addSalvage(state.runSalvage);
  bank.totalKills += state.runKills;
  bank.totalRuns += 1;
  if (state.score > bank.bestScore) bank.bestScore = state.score;
  bank.save();

  ui.goScore.textContent = state.score.toLocaleString();
  ui.goStage.textContent = state.stage;
  ui.goSalvage.textContent = state.runSalvage.toLocaleString();
  ui.goKills.textContent = state.runKills;

  setTimeout(() => {
    ui.gameover.classList.remove('hidden');
  }, 700);
  handTracker.stop();
  recalBtn.classList.add('hidden');
}

function quitToTitle() {
  if (state.running) {
    // bank salvage on quit too
    bank.addSalvage(state.runSalvage);
    bank.totalKills += state.runKills;
    bank.save();
  }
  state.running = false;
  audio.stopMusic();
  handTracker.stop();
  ui.hud.classList.add('hidden');
  ui.gameover.classList.add('hidden');
  ui.pause.classList.add('hidden');
  ui.hangar.classList.add('hidden');
  ui.stageClear.classList.add('hidden');
  ui.victory.classList.add('hidden');
  ui.title.classList.remove('hidden');
  refreshTitleStats();
  recalBtn.classList.add('hidden');
}

// stage clear flow
function onStageClear() {
  state.running = false;
  audio.stageClear();
  audio.stopMusic();
  // reward at stage end
  const stageBonus = 1000 * state.stage;
  state.score += stageBonus;
  const salvageBonus = Math.floor(80 * state.stage * state.salvageMul);
  state.runSalvage += salvageBonus;

  bank.addSalvage(state.runSalvage);
  bank.totalKills += state.runKills;
  state.runSalvage = 0; state.runKills = 0;
  if (state.score > bank.bestScore) bank.bestScore = state.score;
  bank.bossKills += 1;

  // advance stage (cap at 100)
  state.stage++;
  if (state.stage > 100) {
    bank.setStage(100);
    bank.save();
    showVictory();
    return;
  }
  bank.setStage(state.stage);

  $('scStage').textContent = state.stage - 1;
  $('scNextStage').textContent = state.stage;
  $('scBonusScore').textContent = stageBonus.toLocaleString();
  $('scBonusSalvage').textContent = salvageBonus.toLocaleString();
  $('scTotalSalvage').textContent = bank.salvage.toLocaleString();
  ui.stageClear.classList.remove('hidden');
  handTracker.stop();
}

function showVictory() {
  ui.hud.classList.add('hidden');
  ui.stageClear.classList.add('hidden');
  $('vScore').textContent = bank.bestScore.toLocaleString();
  $('vRuns').textContent = bank.totalRuns;
  $('vKills').textContent = bank.totalKills.toLocaleString();
  ui.victory.classList.remove('hidden');
  audio.stopMusic();
  handTracker.stop();
}

// continue to next stage (without regenerating world)
function continueToNextStage() {
  ui.stageClear.classList.add('hidden');
  // refresh world palette for new stage
  world.setStage(state.stage);
  enemyMgr.setStage(state.stage, player.pos.z);
  state.stageStartZ = player.pos.z;
  state.stageDistanceTarget = 180 + state.stage * 6;
  state.bossWarned = false;
  state.runKills = 0; state.runSalvage = 0;
  ui.hudBossBar.classList.add('hidden');
  // top up shields by 50%
  player.shields = Math.min(player.maxShields, player.shields + Math.ceil(player.maxShields * 0.5));
  player.invuln = 1.4;
  updateHpUI();
  flashMsg(`STAGE ${state.stage}`);
  state.running = true;
  state.paused = false;
  audio.startMusic();
  if (state.mode === 'hand') {
    handTracker.start().catch(() => {});
  }
}

// =============== UI bindings ===============
$('btnHandMode').addEventListener('click', () => {
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
  $('setFireGesture').value = input.fireGesture;
  ui.settings.classList.remove('hidden');
});
$('btnSettingsClose').addEventListener('click', () => {
  state.quality = $('setQuality').value;
  state.mouseSens = parseFloat($('setMouseSens').value);
  state.handSens  = parseFloat($('setHandSens').value);
  state.mirror    = $('setMirror').checked;
  state.bgmVol    = parseFloat($('setBgm').value);
  state.sfxVol    = parseFloat($('setSfx').value);
  input.setFireGesture($('setFireGesture').value);
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
    const bs = state.quality === 'high' ? 0.50 : state.quality === 'med' ? 0.32 : 0.20;
    bloomPass.strength = bs;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, state.quality === 'high' ? 2 : 1.5));
  resize();
  ui.settings.classList.add('hidden');
});

$('btnHangar').addEventListener('click', () => openHangar());
$('btnHangarClose').addEventListener('click', () => ui.hangar.classList.add('hidden'));
$('btnHangarReset').addEventListener('click', () => {
  if (confirm('セーブデータを完全リセットします。よろしい？')) {
    bank.reset();
    refreshHangar();
    refreshTitleStats();
  }
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
$('btnGoTitle2').addEventListener('click', quitToTitle);
$('btnGoTitle3').addEventListener('click', quitToTitle);
$('btnGoHangarFromGO').addEventListener('click', () => openHangar(true));
$('btnGoHangarFromSC').addEventListener('click', () => openHangar(true));
$('btnContinueStage').addEventListener('click', () => continueToNextStage());

// recalibrate button (created at runtime)
const recalBtn = document.createElement('button');
recalBtn.id = 'btnRecal';
recalBtn.className = 'hud-pill mini btn-pause hidden';
recalBtn.textContent = '⟳ 再キャリブ';
ui.hud.querySelector('.hud-bottom').appendChild(recalBtn);
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

// =============== HANGAR (upgrade screen) ===============
function openHangar(fromOverlay = false) {
  refreshHangar();
  ui.hangar.classList.remove('hidden');
}

function refreshHangar() {
  $('hangarSalvage').textContent = bank.salvage.toLocaleString();
  $('hangarStage').textContent = bank.bestStage;
  const list = $('hangarList');
  list.innerHTML = '';
  for (const id of UPGRADE_ORDER) {
    const u = UPGRADES[id];
    const lvl = bank.level(id);
    const cost = bank.costNext(id);
    const maxed = lvl >= u.max;
    const can = bank.canUpgrade(id);

    const card = document.createElement('div');
    card.className = 'upgrade-card' + (maxed ? ' maxed' : (can ? ' affordable' : ''));
    card.innerHTML = `
      <div class="upgrade-head">
        <div class="upgrade-icon">${u.icon}</div>
        <div class="upgrade-name">
          <div class="upgrade-title">${u.name}</div>
          <div class="upgrade-desc">${u.desc}</div>
        </div>
        <div class="upgrade-lvl">${lvl}<span class="upgrade-lvl-max">/${u.max}</span></div>
      </div>
      <div class="upgrade-bar"><div class="upgrade-bar-fill" style="width:${(lvl/u.max*100).toFixed(0)}%"></div></div>
      <button class="upgrade-buy ${maxed ? 'maxed' : (can ? 'affordable' : '')}" ${maxed || !can ? 'disabled' : ''}>
        ${maxed ? 'MAX' : `+1 LV  💎 ${cost.toLocaleString()}`}
      </button>
    `;
    const btn = card.querySelector('.upgrade-buy');
    btn.addEventListener('click', () => {
      if (bank.upgrade(id)) {
        audio.unlock().then(() => audio.levelUp());
        refreshHangar();
        refreshTitleStats();
      }
    });
    list.appendChild(card);
  }
}

// =============== Helpers ===============
function flashMsg(txt) {
  ui.bigMsg.textContent = txt;
  ui.bigMsg.classList.remove('show');
  void ui.bigMsg.offsetWidth;
  ui.bigMsg.classList.add('show');
}
function flashCombo(n) {
  ui.comboFlash.textContent = `+${n}`;
  ui.comboFlash.classList.remove('show');
  void ui.comboFlash.offsetWidth;
  ui.comboFlash.classList.add('show');
}
function updateHpUI() {
  const f = clamp(player.shields / player.maxShields, 0, 1);
  ui.hudHpFill.style.width = (f * 100).toFixed(1) + '%';
  ui.hudHpText.textContent = `${Math.ceil(player.shields)} / ${player.maxShields}`;
}
function updateMissileUI() {
  if (!ui.hudMissile) return;
  if (player.missileMax > 0) {
    ui.hudMissile.classList.remove('hidden');
    ui.hudMissile.querySelector('.missile-count').textContent = Math.floor(player.missileAmmo);
    ui.hudMissile.querySelector('.missile-max').textContent = '/' + player.missileMax;
  } else {
    ui.hudMissile.classList.add('hidden');
  }
}
function damageFlash() {
  ui.damageFlash.classList.remove('hit');
  void ui.damageFlash.offsetWidth;
  ui.damageFlash.classList.add('hit');
}

// =============== Camera follow ===============
const camOffset = new THREE.Vector3(0, 3.6, 12);
const camLookAhead = new THREE.Vector3(0, 1.2, -16);
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
let camShake = 0;
let camRollSmooth = 0;

function updateCamera(dt) {
  if (!player) return;
  _tmp.copy(camOffset).applyQuaternion(player.root.quaternion).add(player.root.position);
  const speedNorm = clamp((player.speed - player.minSpeed) / (player.maxSpeed - player.minSpeed), 0, 1);
  const followL = lerp(6.5, 9.5, speedNorm);
  camera.position.lerp(_tmp, 1 - Math.exp(-followL * dt));

  _tmp2.copy(camLookAhead).applyQuaternion(player.root.quaternion).add(player.root.position);
  camera.lookAt(_tmp2);

  const targetRoll = player.rollVisual * 0.45;
  camRollSmooth = damp(camRollSmooth, targetRoll, 5, dt);
  camera.rotation.z += camRollSmooth;

  const targetFov = 70 + speedNorm * 20 + (player.boostActive ? 8 : 0);
  camera.fov = damp(camera.fov, targetFov, 4, dt);
  camera.updateProjectionMatrix();

  if (camShake > 0) {
    camera.position.x += (Math.random() - 0.5) * camShake;
    camera.position.y += (Math.random() - 0.5) * camShake;
    camShake *= 0.86;
    if (camShake < 0.01) camShake = 0;
  }
}

// =============== Combat & Collisions ===============
const _wp = new THREE.Vector3();

function processCollisions(dt) {
  if (!player.alive) return;
  const playerPos = player.pos;
  const near = world.gatherNear(playerPos.z, 240);

  // crystals (salvage / power)
  for (const item of near.crystals) {
    _wp.copy(item.parent.position).add(item.obj.position);
    const isPower = item.obj.userData.kind === 'power';
    const hitR = isPower ? 4.0 : 3.0;
    if (_wp.distanceTo(playerPos) < hitR) {
      if (isPower) {
        applyPower(item.obj.userData.power, _wp);
      } else {
        const baseScore = 80, baseSalvage = 4;
        addScore(baseScore);
        addSalvage(baseSalvage);
        fx.spawnPickup(_wp.clone(), 0x88ffd6);
        audio.pickup();
      }
      item.obj.userData.alive = false;
      item.parent.remove(item.obj);
    }
  }

  // asteroid contact damage (and asteroids can be shot)
  for (const item of near.hazards) {
    _wp.copy(item.parent.position).add(item.obj.position);
    const r = item.obj.userData.radius * 0.9 + 1.5;
    const d = _wp.distanceTo(playerPos);
    if (d < r) {
      const took = player.damage(1);
      if (took) {
        camShake = 0.7;
        damageFlash();
        fx.spawnPlayerHit(playerPos.clone());
        audio.hit();
        updateHpUI();
        if (!player.alive) endGame();
      }
      // also damage the asteroid
      item.obj.userData.hp = Math.max(0, (item.obj.userData.hp || 1) - 2);
      if (item.obj.userData.hp <= 0) {
        item.obj.userData.alive = false;
        fx.spawnExplosion(_wp.clone(), false);
        audio.explosion(false);
        addSalvage(item.obj.userData.salvageReward || 5);
        addScore(item.obj.userData.scoreReward || 30);
        item.parent.remove(item.obj);
      }
    }
  }

  // enemy contact damage
  for (const e of enemyMgr.all()) {
    const d = e.root.position.distanceTo(playerPos);
    if (d < e.radius + 1.4) {
      // both take damage (player gets 1 hit)
      const took = player.damage(e.contactDamage);
      if (took) {
        camShake = 0.7;
        damageFlash();
        fx.spawnPlayerHit(playerPos.clone());
        audio.hit();
        updateHpUI();
        if (!player.alive) { endGame(); return; }
      }
      // ram hurts the enemy a lot
      const dead = e.takeDamage(3);
      if (dead) onEnemyKilled(e);
    }
  }
}

// player projectile + enemy events from projMgr
function processProjectileEvents(events) {
  for (const ev of events) {
    if (ev.kind === 'enemyHit') {
      const e = ev.enemy;
      const dead = e.takeDamage(ev.damage);
      fx.spawnHit(ev.pos, 0x88ffff);
      if (dead) onEnemyKilled(e);
    } else if (ev.kind === 'playerHit') {
      const took = player.damage(ev.damage);
      if (took) {
        camShake = 0.5;
        damageFlash();
        fx.spawnPlayerHit(ev.pos);
        audio.hit();
        updateHpUI();
        if (!player.alive) endGame();
      }
    } else if (ev.kind === 'explosion') {
      fx.spawnExplosion(ev.pos, !!ev.big);
      audio.explosion(!!ev.big);
      camShake = Math.max(camShake, ev.big ? 0.6 : 0.3);
    }
  }
}

function onEnemyKilled(e) {
  fx.spawnExplosion(e.root.position.clone(), e.kind === 'boss');
  audio.explosion(e.kind === 'boss');
  state.runKills += 1;
  addScore(e.scoreReward);
  addSalvage(e.salvageReward);
  if (e.kind === 'boss') {
    flashMsg('BOSS DOWN');
    onStageClear();
  }
}

function applyPower(kind, pos) {
  fx.spawnPickup(pos.clone(), kind === 'shield' ? 0x7df9ff : kind === 'energy' ? 0xb388ff : 0xffd86b);
  audio.combo(4);
  if (kind === 'shield') {
    if (player.shields < player.maxShields) {
      player.shields = Math.min(player.maxShields, player.shields + Math.ceil(player.maxShields / 3));
      updateHpUI();
      flashMsg('+SHIELD');
    } else {
      addScore(800);
      flashMsg('SHIELD MAX  +800');
    }
  } else if (kind === 'energy') {
    state.timeScaleTarget = 0.45;
    setTimeout(() => state.timeScaleTarget = 1, 2200);
    flashMsg('TIME SLOW');
    // also refill missile by 1 if applicable
    if (player.missileMax > 0) player.missileAmmo = Math.min(player.missileMax, player.missileAmmo + 2);
    updateMissileUI();
  } else if (kind === 'mega') {
    addScore(2000);
    addSalvage(50);
    player.boostFuel = 1;
    flashMsg('MEGA  +2000  💎+50');
  }
}

function addScore(base) {
  state.score += Math.floor(base);
  scorePopup(Math.floor(base), '');
}
function addSalvage(amount) {
  const a = Math.max(1, Math.floor(amount * state.salvageMul));
  state.runSalvage += a;
  scorePopup('💎 ' + a, 'gold');
}

function scorePopup(amount, color = '') {
  const layer = $('scorePopups');
  if (!layer) return;
  const el = document.createElement('div');
  el.className = 'score-popup ' + color;
  el.textContent = typeof amount === 'string' ? amount : ('+' + amount.toLocaleString());
  const v = player.pos.clone().project(camera);
  const x = (v.x * 0.5 + 0.5) * window.innerWidth;
  const y = (1 - (v.y * 0.5 + 0.5)) * window.innerHeight;
  const jx = (Math.random() - 0.5) * 80;
  el.style.left = (x + jx) + 'px';
  el.style.top  = (y - 40) + 'px';
  layer.appendChild(el);
  setTimeout(() => el.remove(), 1100);
}

// =============== HUD ===============
let fpsAcc = 0, fpsFrames = 0;
function updateHud(dt) {
  ui.hudScore.textContent = state.score.toLocaleString();
  ui.hudSalvage.textContent = state.runSalvage.toLocaleString();
  ui.hudStage.textContent = state.stage;
  ui.hudSpeed.textContent = String(Math.floor(player.speed * 1.6)).padStart(3, '0');

  // wave/distance progress
  const distInStage = state.stageStartZ - player.pos.z;
  const waveP = clamp(distInStage / state.stageDistanceTarget, 0, 1);
  ui.hudWave.style.width = (waveP * 100).toFixed(0) + '%';

  const off = (1 - player.boostFuel) * 289;
  ui.boostRing.setAttribute('stroke-dashoffset', off.toFixed(1));
  ui.boostRing.setAttribute('stroke', player.boostActive ? '#ff6ec7' : '#7df9ff');

  const sNorm = clamp((player.speed - player.minSpeed) / (player.maxSpeed - player.minSpeed), 0, 1);
  ui.speedLines.classList.toggle('boost', sNorm > 0.7 || player.boostActive);

  // boss bar
  if (enemyMgr.boss && enemyMgr.boss.alive) {
    ui.hudBossBar.classList.remove('hidden');
    const f = clamp(enemyMgr.boss.hp / enemyMgr.boss.maxHp, 0, 1);
    ui.hudBossFill.style.width = (f * 100).toFixed(1) + '%';
  } else {
    ui.hudBossBar.classList.add('hidden');
  }

  // missile indicator
  updateMissileUI();
  // boss warning when entering range
  const distInStage2 = state.stageStartZ - player.pos.z;
  if (!state.bossWarned && distInStage2 > state.stageDistanceTarget * 0.85) {
    state.bossWarned = true;
    flashMsg('⚠ BOSS APPROACHING ⚠');
    audio.bossWarning();
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
  if (rawDt <= 0 || !isFinite(rawDt)) rawDt = 1 / 60;
  if (rawDt > 0.1) rawDt = 0.1;
  const time = now / 1000;

  state.timeScale = damp(state.timeScale, state.timeScaleTarget, 8, rawDt);
  const dt = rawDt * state.timeScale;

  if (chromaPass && player) {
    const sNorm = clamp((player.speed - player.minSpeed) / (player.maxSpeed - player.minSpeed), 0, 1);
    const target = (player.boostActive ? 0.012 : 0.003) + sNorm * 0.012;
    chromaPass.uniforms.amount.value = damp(chromaPass.uniforms.amount.value, target, 6, rawDt);
    chromaPass.uniforms.radius.value = damp(chromaPass.uniforms.radius.value, sNorm * 0.025, 4, rawDt);
    chromaPass.uniforms.time.value = time;
  }

  input.update(rawDt);

  if (state.running && !state.paused) {
    player.update(dt, input, time);

    // FIRE primary
    if (input.isFiring()) {
      const bullets = player.tryFire();
      if (bullets) {
        for (const b of bullets) projMgr.spawnPlayerBullet(b);
        audio.laser();
      }
    }
    // FIRE missile
    if (input.consumeMissile()) {
      const m = player.tryFireMissile();
      if (m) {
        projMgr.spawnMissile(m);
        audio.missile();
      }
    }

    world.update(dt, time, player.pos.z);
    enemyMgr.update(dt, time, player.pos, (enemySpec) => {
      projMgr.spawnEnemyBullet(enemySpec);
      // enemy shot SFX (subtle)
      audio.enemyShot();
    });

    // build collision-target list for projectiles
    const enemyArr = [];
    for (const e of enemyMgr.all()) enemyArr.push(e);
    const events = projMgr.update(dt, enemyArr, player);
    processProjectileEvents(events);

    processCollisions(dt);
    fx.update(dt);

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

window.__STARFORGE__ = { state, bank, input, audio, scene, camera, renderer };
