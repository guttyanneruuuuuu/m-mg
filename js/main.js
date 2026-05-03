// ===========================================================
// main.js — STARFORGE: hand-controlled space combat survivor (v2)
//   - Pilot level / XP system, equipment drops, ship skins
//   - Daily missions + achievements integration
//   - Radar minimap, damage direction, combo meter
//   - Auto-fire target hint forwarded to InputManager
//   - Realistic environment lighting tweaks (tone mapping/exposure)
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
import {
  UpgradeBank, UPGRADES, UPGRADE_ORDER, CATEGORIES,
  RARITIES, BLUEPRINTS, SLOT_LABELS, SKINS,
  ACHIEVEMENTS, MISSION_POOL, xpForLevel
} from './upgrades.js';
import { clamp, damp, lerp, Storage, isMobile, supportsTouch } from './utils.js';

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
  hudPilot: $('hudPilot'),
  hudXp: $('hudXp'),
  hudHpFill: $('hudHpFill'),
  hudHpText: $('hudHpText'),
  hudBossBar: $('hudBossBar'),
  hudBossFill: $('hudBossFill'),
  hudBossName: $('hudBossName'),
  hudMissile: $('hudMissile'),
  hudCombo:    $('hudCombo'),
  hudComboNum: $('hudComboNum'),
  hudComboFill:$('hudComboFill'),
  fpsPill:  $('fpsPill'),
  modePill: $('modePill'),
  bigMsg:   $('bigMsg'),
  comboFlash: $('comboFlash'),
  boostRing: $('boostRing'),
  lockIndicator: $('lockIndicator'),
  radar: $('radar'),

  dmgUp: $('dmgDirUp'),
  dmgDown: $('dmgDirDown'),
  dmgLeft: $('dmgDirLeft'),
  dmgRight: $('dmgDirRight'),

  speedLines: $('speedLines'),
  damageFlash:$('damageFlash'),
  camPreview: $('camPreview'),
  touchUI:   $('touchUI'),

  toastLayer: $('toastLayer'),

  goScore: $('goScore'),
  goStage: $('goStage'),
  goSalvage: $('goSalvage'),
  goKills: $('goKills'),
  goXp: $('goXp'),
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
  runXp: 0,
  bossWarned: false,
  bossNoDmg: true,         // tracks if took dmg during boss fight
  stageStartZ: 0,
  stageDistanceTarget: 200,
  salvageMul: 1,

  // combo
  comboCount: 0,
  comboTimer: 0,
  comboMax: 0,

  // chrono (slow motion proximity trigger)
  chronoCd: 0,

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
renderer.toneMappingExposure = 0.95;
renderer.physicallyCorrectLights = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 4000);
camera.position.set(0, 4, 14);

let composer = null;
let bloomPass = null;
let chromaPass = null;

function setupPost() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bs = state.quality === 'high' ? 0.62 : state.quality === 'med' ? 0.40 : 0.22;
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    bs, 0.7, 0.55
  );
  composer.addPass(bloomPass);

  chromaPass = new ShaderPass(ChromaShader);
  chromaPass.uniforms.vignette.value = state.quality === 'low' ? 0.30 : 0.55;
  chromaPass.uniforms.grain.value    = state.quality === 'low' ? 0.02 : 0.045;
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
  const skin = bank.currentSkin();
  player = new Player(scene, bank.composeStats(), { skin, equippedItems: bank.equippedItems() });
  fx = new Effects(scene, camera);
  enemyMgr = new EnemyManager(scene);
  projMgr = new ProjectileManager(scene);
  await new Promise(r => setTimeout(r, 200));
  setLoader(1.0, '準備完了');
  await new Promise(r => setTimeout(r, 250));
  ui.loading.classList.add('hidden');
  ui.title.classList.remove('hidden');
  refreshTitleStats();
  refreshTitleMiniMissions();

  requestAnimationFrame(loop);
}

function refreshTitleStats() {
  $('titleStage').textContent = bank.bestStage;
  $('titleSalvage').textContent = bank.salvage.toLocaleString();
  $('titleScore').textContent = bank.bestScore.toLocaleString();
  // pilot level/xp on title
  const lvl = bank.pilotLevel;
  const xp  = bank.pilotXp;
  const need = bank.xpToNext();
  $('titlePilotLvl').textContent = lvl;
  $('titlePilotXp').style.width = ((xp / need) * 100).toFixed(1) + '%';
  $('titlePilotXpText').textContent = `${xp} / ${need} XP`;
}

function refreshTitleMiniMissions() {
  const layer = $('titleMiniMissions');
  if (!layer) return;
  layer.innerHTML = '';
  bank.refreshDailyMissions();
  for (const m of bank.dailyMissions.missions) {
    const def = bank.missionDef(m.id);
    if (!def) continue;
    const ready = m.progress >= def.target && !m.claimed;
    const claimed = m.claimed;
    const el = document.createElement('div');
    el.className = 'title-mini-mission' + (ready ? ' ready' : '') + (claimed ? ' claimed' : '');
    el.innerHTML = `
      <span class="mm-icon">${claimed ? '✅' : ready ? '🎁' : '📋'}</span>
      <span class="mm-desc">${def.desc}</span>
      <span class="mm-prog">${Math.min(m.progress, def.target)} / ${def.target}</span>
      <span class="mm-rew">💎 ${def.reward}</span>
    `;
    layer.appendChild(el);
  }
}

// =============== Game flow ===============
function startGame(mode) {
  state.mode = mode;
  input.setMode(mode);
  state.score = 0;
  state.runKills = 0;
  state.runSalvage = 0;
  state.runXp = 0;
  state.bossWarned = false;
  state.bossNoDmg = true;
  state.timeScale = 1; state.timeScaleTarget = 1;
  state.comboCount = 0; state.comboTimer = 0; state.comboMax = 0;
  state.chronoCd = 0;
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

  // build player from upgrade stats + skin + equip
  const stats = bank.composeStats();
  state.salvageMul = stats.salvageMul || 1;
  const skin = bank.currentSkin();
  player = new Player(scene, stats, { skin, equippedItems: bank.equippedItems() });
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
  state.stageDistanceTarget = 180 + state.stage * 6;

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
  if (ui.hudCombo) ui.hudCombo.classList.add('hidden');
  updateHpUI();
  updateMissileUI();
  updatePilotHudUI();
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

  // bank rewards
  bank.addSalvage(state.runSalvage);
  bank.totalKills += state.runKills;
  bank.totalRuns += 1;
  if (state.score > bank.bestScore) bank.bestScore = state.score;
  // pilot xp
  const xpGained = state.runXp + Math.floor(state.score / 200);
  bank.addXp(xpGained);
  // mission progress
  bank.recordMissionProgress({
    killsRun: state.runKills, salvageRun: state.runSalvage,
    stagesRun: 0, bossNoDmg: 0
  });
  const newAch = bank.checkAchievements();
  bank.save();

  ui.goScore.textContent = state.score.toLocaleString();
  ui.goStage.textContent = state.stage;
  ui.goSalvage.textContent = state.runSalvage.toLocaleString();
  ui.goKills.textContent = state.runKills;
  if (ui.goXp) ui.goXp.textContent = xpGained.toLocaleString();

  for (const a of newAch) toast(`実績解除: ${a.name}  💎+${a.reward.salvage || 0}`, 'gold');

  setTimeout(() => {
    ui.gameover.classList.remove('hidden');
  }, 700);
  handTracker.stop();
  recalBtn.classList.add('hidden');
}

function quitToTitle() {
  if (state.running) {
    bank.addSalvage(state.runSalvage);
    bank.totalKills += state.runKills;
    bank.addXp(state.runXp);
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
  refreshTitleMiniMissions();
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
  // bonus XP for clearing the stage
  const xpBonus = 30 + state.stage * 5;
  state.runXp += xpBonus;

  bank.addSalvage(state.runSalvage);
  bank.totalKills += state.runKills;
  state.runSalvage = 0; state.runKills = 0;
  if (state.score > bank.bestScore) bank.bestScore = state.score;
  bank.bossKills += 1;

  // boss drop — guaranteed item (rarity scales with stage, no-damage = +tier)
  let forceRarity = null;
  if (state.bossNoDmg) forceRarity = state.stage >= 30 ? 'legendary' : state.stage >= 12 ? 'epic' : 'rare';
  const drop = bank.rollItem(state.stage, forceRarity);
  bank.addItem(drop);

  // also pilot XP from boss
  const xpGained = state.runXp + Math.floor(state.score / 200);
  bank.addXp(xpGained);
  bank.recordMissionProgress({
    killsRun: state.runKills, salvageRun: state.runSalvage,
    stagesRun: 1, bossNoDmg: state.bossNoDmg ? 1 : 0
  });
  const newAch = bank.checkAchievements();

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
  if ($('scBonusXp')) $('scBonusXp').textContent = xpGained.toLocaleString();
  $('scTotalSalvage').textContent = bank.salvage.toLocaleString();

  // drop UI
  const dropBox = $('scDropBox');
  if (dropBox) {
    dropBox.classList.remove('hidden');
    const rar = RARITIES[drop.rarity];
    dropBox.innerHTML = `
      <div class="sc-drop-tag" style="color:${rar.color}">${rar.label} DROP</div>
      <div class="sc-drop-card" style="border-color:${rar.color}; box-shadow:0 0 30px ${rar.color}55;">
        <div class="sc-drop-icon">${drop.icon}</div>
        <div class="sc-drop-body">
          <div class="sc-drop-name" style="color:${rar.color}">${drop.name}</div>
          <div class="sc-drop-slot">${SLOT_LABELS[drop.slot].icon} ${SLOT_LABELS[drop.slot].label}</div>
          <div class="sc-drop-stats">${formatBundle(drop.bundle)}</div>
        </div>
      </div>
    `;
  }

  for (const a of newAch) toast(`実績解除: ${a.name}  💎+${a.reward.salvage || 0}`, 'gold');

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
  state.bossNoDmg = true;
  state.runKills = 0; state.runSalvage = 0; state.runXp = 0;
  state.comboCount = 0; state.comboTimer = 0;
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
  // simplified mode toggle pulled from intro
  const introToggle = $('setSimplifiedIntro');
  if (introToggle) input.setSimplified(introToggle.checked);
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
  if ($('setFireGesture')) $('setFireGesture').value = input.fireGesture;
  if ($('setSimplified')) $('setSimplified').checked = input.simplifiedMode;
  ui.settings.classList.remove('hidden');
});
$('btnSettingsClose').addEventListener('click', () => {
  state.quality = $('setQuality').value;
  state.mouseSens = parseFloat($('setMouseSens').value);
  state.handSens  = parseFloat($('setHandSens').value);
  state.mirror    = $('setMirror').checked;
  state.bgmVol    = parseFloat($('setBgm').value);
  state.sfxVol    = parseFloat($('setSfx').value);
  if ($('setFireGesture')) input.setFireGesture($('setFireGesture').value);
  if ($('setSimplified')) input.setSimplified($('setSimplified').checked);
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
    const bs = state.quality === 'high' ? 0.62 : state.quality === 'med' ? 0.40 : 0.22;
    bloomPass.strength = bs;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, state.quality === 'high' ? 2 : 1.5));
  resize();
  ui.settings.classList.add('hidden');
});

$('btnHangar').addEventListener('click', () => openHangar());
$('btnHangarClose').addEventListener('click', () => {
  ui.hangar.classList.add('hidden');
  refreshTitleStats();
  refreshTitleMiniMissions();
});
$('btnHangarReset').addEventListener('click', () => {
  if (confirm('セーブデータを完全リセットします。よろしい？')) {
    bank.reset();
    refreshHangar();
    refreshTitleStats();
    refreshTitleMiniMissions();
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

// =============== HANGAR (tabbed: upgrade / loadout / skin / missions / stats) ===============
let hangarTab = 'upgrade';
let hangarCat = 'all';

function openHangar(_fromOverlay = false) {
  refreshHangar();
  ui.hangar.classList.remove('hidden');
}

document.querySelectorAll('.hangar-tab').forEach(b => {
  b.addEventListener('click', () => {
    hangarTab = b.dataset.tab;
    document.querySelectorAll('.hangar-tab').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.hangar-pane').forEach(p => p.classList.add('hidden'));
    const map = { upgrade:'paneUpgrade', loadout:'paneLoadout', skin:'paneSkin', missions:'paneMissions', stats:'paneStats' };
    $(map[hangarTab]).classList.remove('hidden');
    refreshHangar();
  });
});

function refreshHangar() {
  $('hangarSalvage').textContent = bank.salvage.toLocaleString();
  $('hangarStage').textContent = bank.bestStage;
  if ($('hangarPilot')) $('hangarPilot').textContent = `LV ${bank.pilotLevel}`;
  if (hangarTab === 'upgrade')    refreshHangarUpgrade();
  if (hangarTab === 'loadout')    refreshHangarLoadout();
  if (hangarTab === 'skin')       refreshHangarSkin();
  if (hangarTab === 'missions')   refreshHangarMissions();
  if (hangarTab === 'stats')      refreshHangarStats();
}

function refreshHangarUpgrade() {
  // category filter row
  const catRow = $('hangarCats');
  if (catRow) {
    const cats = [['all', { label: 'ALL', color: '#ffffff', icon: '★' }]]
      .concat(Object.entries(CATEGORIES));
    catRow.innerHTML = cats.map(([k, c]) =>
      `<button class="cat-btn ${hangarCat === k ? 'active' : ''}" data-cat="${k}"
         style="--cat-c:${c.color}">${c.icon} ${c.label}</button>`
    ).join('');
    catRow.querySelectorAll('.cat-btn').forEach(b => {
      b.addEventListener('click', () => { hangarCat = b.dataset.cat; refreshHangarUpgrade(); });
    });
  }

  const list = $('hangarList');
  list.innerHTML = '';
  for (const id of UPGRADE_ORDER) {
    const u = UPGRADES[id];
    if (hangarCat !== 'all' && u.category !== hangarCat) continue;
    const lvl = bank.level(id);
    const cost = bank.costNext(id);
    const maxed = lvl >= u.max;
    const can = bank.canUpgrade(id);
    const cat = CATEGORIES[u.category] || { color: '#7df9ff' };

    const card = document.createElement('div');
    card.className = 'upgrade-card' + (maxed ? ' maxed' : (can ? ' affordable' : ''));
    card.style.setProperty('--cat-c', cat.color);
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

function refreshHangarLoadout() {
  const slotsEl = $('loadoutSlots');
  if (!slotsEl) return;
  slotsEl.innerHTML = '';
  for (const slot of ['primary', 'secondary', 'module']) {
    const lbl = SLOT_LABELS[slot];
    const id = bank.loadout[slot];
    const it = id ? bank.inventory.find(x => x.uid === id) : null;
    const rar = it ? RARITIES[it.rarity] : null;
    const div = document.createElement('div');
    div.className = 'loadout-slot' + (it ? ' filled' : ' empty');
    div.innerHTML = `
      <div class="loadout-slot-label">${lbl.icon} ${lbl.label}</div>
      ${it ? `
        <div class="loadout-slot-item" style="border-color:${rar.color}; box-shadow:0 0 18px ${rar.color}55;">
          <div class="ls-icon">${it.icon}</div>
          <div class="ls-body">
            <div class="ls-name" style="color:${rar.color}">${it.name}</div>
            <div class="ls-stats">${formatBundle(it.bundle)}</div>
          </div>
          <button class="ls-unequip">外す</button>
        </div>
      ` : `<div class="loadout-slot-empty">— 未装備 —</div>`}
    `;
    slotsEl.appendChild(div);
    const unq = div.querySelector('.ls-unequip');
    if (unq) unq.addEventListener('click', () => { bank.unequip(slot); refreshHangar(); });
  }

  // inventory
  const inv = $('loadoutInv');
  if (!inv) return;
  inv.innerHTML = '';
  if (bank.inventory.length === 0) {
    inv.innerHTML = `<div class="loadout-empty">ボスを倒すと装備がドロップします。</div>`;
    return;
  }
  // sort: rarity desc, then slot
  const order = ['legendary', 'epic', 'rare', 'common'];
  const sorted = [...bank.inventory].sort((a,b) => order.indexOf(a.rarity) - order.indexOf(b.rarity));
  for (const it of sorted) {
    const rar = RARITIES[it.rarity];
    const lbl = SLOT_LABELS[it.slot];
    const equipped = bank.loadout[it.slot] === it.uid;
    const card = document.createElement('div');
    card.className = 'inv-card' + (equipped ? ' equipped' : '');
    card.style.setProperty('--rar-c', rar.color);
    card.innerHTML = `
      <div class="inv-head">
        <div class="inv-icon">${it.icon}</div>
        <div class="inv-name">
          <div class="inv-title" style="color:${rar.color}">${it.name}</div>
          <div class="inv-slot">${lbl.icon} ${lbl.label} · <span style="color:${rar.color}">${rar.label}</span></div>
        </div>
        <button class="inv-scrap" title="売却">✕</button>
      </div>
      <div class="inv-stats">${formatBundle(it.bundle)}</div>
      ${equipped ? `<div class="inv-tag-equipped">装備中</div>` : ''}
    `;
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('inv-scrap')) return;
      if (bank.equip(it.slot, it.uid)) refreshHangar();
    });
    card.querySelector('.inv-scrap').addEventListener('click', (e) => {
      e.stopPropagation();
      const refund = bank.scrapItem(it.uid);
      if (refund) toast(`売却 +💎${refund}`, 'gold');
      refreshHangar();
    });
    inv.appendChild(card);
  }
}

function refreshHangarSkin() {
  const grid = $('skinGrid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const [id, sk] of Object.entries(SKINS)) {
    const unlocked = bank.isSkinUnlocked(id);
    const active = bank.skin === id;
    const div = document.createElement('div');
    div.className = 'skin-card' + (unlocked ? '' : ' locked') + (active ? ' active' : '');
    const hullHex = '#' + sk.hull.toString(16).padStart(6, '0');
    const accHex = '#' + sk.accent.toString(16).padStart(6, '0');
    const trimHex = '#' + sk.trim.toString(16).padStart(6, '0');
    div.innerHTML = `
      <div class="skin-preview" style="background:linear-gradient(135deg, ${hullHex} 0%, ${accHex} 70%, ${trimHex} 100%);">
        ${unlocked ? '' : '<div class="skin-lock">🔒</div>'}
      </div>
      <div class="skin-info">
        <div class="skin-name">${sk.name}</div>
        <div class="skin-desc">${sk.desc}</div>
        ${active ? '<div class="skin-active">✔ 着用中</div>' : (unlocked ? '<button class="skin-equip">適用</button>' : '<div class="skin-locked-tag">未解放</div>')}
      </div>
    `;
    const eq = div.querySelector('.skin-equip');
    if (eq) eq.addEventListener('click', () => { bank.setSkin(id); refreshHangar(); });
    grid.appendChild(div);
  }
}

function refreshHangarMissions() {
  bank.refreshDailyMissions();
  const list = $('missionList');
  if (!list) return;
  list.innerHTML = '';
  for (const m of bank.dailyMissions.missions) {
    const def = bank.missionDef(m.id);
    if (!def) continue;
    const ready = m.progress >= def.target && !m.claimed;
    const claimed = m.claimed;
    const pct = clamp(m.progress / def.target, 0, 1);
    const row = document.createElement('div');
    row.className = 'mission-row' + (claimed ? ' claimed' : ready ? ' ready' : '');
    row.innerHTML = `
      <div class="mission-icon">${claimed ? '✅' : ready ? '🎁' : '📋'}</div>
      <div class="mission-body">
        <div class="mission-desc">${def.desc}</div>
        <div class="mission-bar"><div class="mission-bar-fill" style="width:${(pct*100).toFixed(1)}%"></div></div>
        <div class="mission-prog">${Math.min(m.progress, def.target)} / ${def.target}</div>
      </div>
      <div class="mission-rew">💎 ${def.reward}</div>
      <button class="mission-claim" ${ready ? '' : 'disabled'}>${claimed ? '受領済' : ready ? '受け取る' : '進行中'}</button>
    `;
    row.querySelector('.mission-claim').addEventListener('click', () => {
      const r = bank.claimMission(m.id);
      if (r) toast(`ミッション報酬 +💎${r}`, 'gold');
      refreshHangar();
      refreshTitleStats();
      refreshTitleMiniMissions();
    });
    list.appendChild(row);
  }

  // achievements
  const ach = $('achievementList');
  if (!ach) return;
  ach.innerHTML = '';
  for (const a of ACHIEVEMENTS) {
    const got = bank.unlockedAchievements.includes(a.id);
    const div = document.createElement('div');
    div.className = 'achievement-row' + (got ? ' got' : '');
    div.innerHTML = `
      <div class="ach-icon">${got ? a.icon : '🔒'}</div>
      <div class="ach-body">
        <div class="ach-name">${a.name}</div>
        <div class="ach-desc">${a.desc}</div>
      </div>
      <div class="ach-rew">💎 ${a.reward.salvage}</div>
    `;
    ach.appendChild(div);
  }
}

function refreshHangarStats() {
  const grid = $('statsGrid');
  if (!grid) return;
  const stats = bank.composeStats();
  const rows = [
    ['🛡 シールド最大', `${Math.floor(stats.hp)}`],
    ['💥 ダメージ', `${stats.damage.toFixed(2)}`],
    ['⚡ 連射倍率', `x${stats.fireRate.toFixed(2)}`],
    ['🎯 マルチショット', `${stats.multishot}`],
    ['➡ 貫通', `${stats.pierce}`],
    ['✨ クリ率', `${(stats.critChance*100).toFixed(0)}%`],
    ['🚀 速度倍率', `x${stats.speed.toFixed(2)}`],
    ['🌀 応答性', `x${stats.agility.toFixed(2)}`],
    ['🚀 ミサイル装弾', `${stats.missileAmmo}`],
    ['💎 取得倍率', `x${stats.salvageMul.toFixed(2)}`],
    ['♻ 回復', `${stats.shieldRegenRate.toFixed(2)} /s (delay ${stats.shieldRegenDelay.toFixed(1)}s)`],
    ['🎯 エイムアシスト', `${(stats.aimAssist*100).toFixed(0)}%`],
    ['🧲 マグネット', `${stats.magnetRadius.toFixed(0)}m`],
    ['👨‍✈️ パイロット LV', `${bank.pilotLevel}`],
    ['💀 累計撃墜', `${bank.totalKills.toLocaleString()}`],
    ['🏆 ベストステージ', `${bank.bestStage}`],
    ['🎮 累計ラン', `${bank.totalRuns}`],
  ];
  grid.innerHTML = rows.map(([k,v]) => `<div class="stat-row"><span>${k}</span><b>${v}</b></div>`).join('');
}

function formatBundle(b) {
  const out = [];
  const fmt = (k, v) => {
    if (v == null || v === 0) return null;
    const pct = Math.round(v * 100);
    const m = {
      damage: `+${pct}% ダメージ`,
      fireRate: `+${pct}% 連射`,
      bulletSpeed: `+${pct}% 弾速`,
      spread: `+${pct}% 広がり`,
      missileDamage: `+${pct}% ミサイル威力`,
      missileRegen: `+${v.toFixed(2)} ミサイル再生`,
      missileAoe: `+${pct}% AOE`,
      shieldRegenRate: `+${v.toFixed(2)} 回復`,
      salvageMul: `+${pct}% 💎`,
      speed: `+${pct}% 速度`,
      agility: `+${pct}% 応答`,
      aimAssist: `+${pct}% エイム`,
      critChance: `+${pct}% クリ率`,
      invulnTime: `+${pct}% 無敵`,
      flatHp: `+${v} HP`,
      flatMultishot: `+${v} マルチ`,
      flatPierce: `+${v} 貫通`,
      flatMissileAmmo: `+${v} ミサイル`,
      magnetRadius: `+${v.toFixed(0)} 吸引`,
      droneDps: `+${v.toFixed(1)} ドローンDPS`,
      droneRange: `+${v.toFixed(0)} ドローン範囲`,
      chronoTrigger: `${(v*100).toFixed(0)}% スロー`,
      chronoStrength: `${(v*100).toFixed(0)}% 強度`,
    };
    return m[k] || `${k}: ${v}`;
  };
  for (const [k,v] of Object.entries(b || {})) {
    const s = fmt(k, v);
    if (s) out.push(`<span class="stat-pill">${s}</span>`);
  }
  return out.join('');
}

// =============== Helpers ===============
function flashMsg(txt) {
  ui.bigMsg.textContent = txt;
  ui.bigMsg.classList.remove('show');
  void ui.bigMsg.offsetWidth;
  ui.bigMsg.classList.add('show');
}
function flashCombo(n) {
  ui.comboFlash.textContent = `x${n} COMBO!`;
  ui.comboFlash.classList.remove('show');
  void ui.comboFlash.offsetWidth;
  ui.comboFlash.classList.add('show');
}
function toast(txt, kind = '') {
  if (!ui.toastLayer) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = txt;
  ui.toastLayer.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 2600);
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
function updatePilotHudUI() {
  if (!ui.hudPilot) return;
  ui.hudPilot.textContent = bank.pilotLevel;
  if (ui.hudXp) {
    const need = bank.xpToNext();
    ui.hudXp.style.width = ((bank.pilotXp / need) * 100).toFixed(1) + '%';
  }
}
function damageFlash() {
  ui.damageFlash.classList.remove('hit');
  void ui.damageFlash.offsetWidth;
  ui.damageFlash.classList.add('hit');
}

// damage direction: figure out which side took the hit (camera-relative)
const _dirTmp = new THREE.Vector3();
function showDamageDirection(srcPos) {
  if (!srcPos || !player) return;
  _dirTmp.copy(srcPos).sub(player.pos);
  _dirTmp.applyQuaternion(player.root.quaternion.clone().invert());
  // _dirTmp is now in player local space: -Z forward, +X right, +Y up
  const ax = Math.abs(_dirTmp.x), ay = Math.abs(_dirTmp.y), az = Math.abs(_dirTmp.z);
  let el = null;
  if (az >= ax && az >= ay) {
    el = _dirTmp.z > 0 ? ui.dmgDown : ui.dmgUp;
  } else if (ay >= ax) {
    el = _dirTmp.y > 0 ? ui.dmgUp : ui.dmgDown;
  } else {
    el = _dirTmp.x > 0 ? ui.dmgRight : ui.dmgLeft;
  }
  if (!el) return;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
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

  // crystals (salvage / power) — magnet pickup radius
  const magnet = player.magnetRadius || 6;
  for (const item of near.crystals) {
    _wp.copy(item.parent.position).add(item.obj.position);
    const isPower = item.obj.userData.kind === 'power';
    const hitR = isPower ? 4.0 : 3.0;
    const dist = _wp.distanceTo(playerPos);
    if (dist < hitR) {
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
    } else if (!isPower && dist < magnet) {
      // pull crystal toward player
      const pull = item.obj.position;
      const dir = playerPos.clone().sub(_wp).normalize();
      pull.addScaledVector(dir, dt * (12 + (magnet - dist) * 4));
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
        showDamageDirection(_wp);
        fx.spawnPlayerHit(playerPos.clone());
        audio.hit();
        updateHpUI();
        breakCombo();
        if (enemyMgr.boss && enemyMgr.boss.alive) state.bossNoDmg = false;
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
      const took = player.damage(e.contactDamage);
      if (took) {
        camShake = 0.7;
        damageFlash();
        showDamageDirection(e.root.position);
        fx.spawnPlayerHit(playerPos.clone());
        audio.hit();
        updateHpUI();
        breakCombo();
        if (enemyMgr.boss && enemyMgr.boss.alive) state.bossNoDmg = false;
        if (!player.alive) { endGame(); return; }
      }
      const dead = e.takeDamage(3);
      if (dead) onEnemyKilled(e);
    }
  }

  // chrono near-miss trigger (slow time when an enemy bullet barely misses)
  if (player.chronoTrigger > 0 && state.chronoCd <= 0) {
    for (const b of projMgr.enemyBullets || []) {
      const dx = b.mesh.position.x - playerPos.x;
      const dy = b.mesh.position.y - playerPos.y;
      const dz = b.mesh.position.z - playerPos.z;
      const dd = dx*dx + dy*dy + dz*dz;
      if (dd < 9 /* 3m */) {
        state.timeScaleTarget = 1 - clamp(player.chronoStrength, 0.2, 0.7);
        setTimeout(() => state.timeScaleTarget = 1, 700);
        state.chronoCd = 4;
        flashMsg('CHRONO!');
        break;
      }
    }
  }
  if (state.chronoCd > 0) state.chronoCd -= dt;

  // drone passive damage to nearest enemy
  if (player.droneDps > 0 && player.drone) {
    let nearest = null, nd = player.droneRange;
    for (const e of enemyMgr.all()) {
      const dd = e.root.position.distanceTo(playerPos);
      if (dd < nd) { nd = dd; nearest = e; }
    }
    if (nearest) {
      const dead = nearest.takeDamage(player.droneDps * dt);
      // pulse beam visual every ~0.3s
      if (Math.random() < dt * 3) {
        fx.spawnHit(nearest.root.position.clone(), 0xc06bff);
      }
      if (dead) onEnemyKilled(nearest);
    }
  }
}

// player projectile + enemy events from projMgr
function processProjectileEvents(events) {
  for (const ev of events) {
    if (ev.kind === 'enemyHit') {
      const e = ev.enemy;
      const dead = e.takeDamage(ev.damage);
      fx.spawnHit(ev.pos, ev.crit ? 0xffd86b : 0x88ffff);
      if (dead) onEnemyKilled(e);
    } else if (ev.kind === 'playerHit') {
      const took = player.damage(ev.damage);
      if (took) {
        camShake = 0.5;
        damageFlash();
        showDamageDirection(ev.pos);
        fx.spawnPlayerHit(ev.pos);
        audio.hit();
        updateHpUI();
        breakCombo();
        if (enemyMgr.boss && enemyMgr.boss.alive) state.bossNoDmg = false;
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
  // combo bumps for non-boss kills
  bumpCombo();
  const comboMul = 1 + Math.min(state.comboCount * 0.04, 1.0);
  addScore(Math.round(e.scoreReward * comboMul));
  addSalvage(e.salvageReward);
  // pilot xp
  const xp = e.xpForKill || 4;
  state.runXp += xp;
  // rare in-run drop from non-boss elite (very small chance)
  if (e.kind !== 'boss' && Math.random() < 0.005 + state.stage * 0.0005) {
    const drop = bank.rollItem(state.stage, 'rare');
    bank.addItem(drop);
    toast(`💠 RARE DROP: ${drop.name}`, 'gold');
  }
  if (e.kind === 'boss') {
    flashMsg('BOSS DOWN');
    onStageClear();
  }
}

function bumpCombo() {
  state.comboCount += 1;
  state.comboTimer = 3.5;
  if (state.comboCount > state.comboMax) state.comboMax = state.comboCount;
  if (state.comboCount >= 5 && state.comboCount % 5 === 0) {
    flashCombo(state.comboCount);
    audio.combo(Math.min(state.comboCount, 30));
  }
}
function breakCombo() {
  if (state.comboCount > 5) {
    // small dampening, don't fully reset
    state.comboCount = Math.floor(state.comboCount / 2);
  } else {
    state.comboCount = 0;
  }
  state.comboTimer = 0;
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

// =============== Auto-fire target hint (for InputManager auto/aimAssist) ===============
const _aimDir = new THREE.Vector3();
const _toEnemy = new THREE.Vector3();
function updateAutoFireTargetHint() {
  if (!player) return;
  _aimDir.set(0, 0, -1).applyQuaternion(player.root.quaternion).normalize();
  let bestDot = -1;
  let bestDist = 1e9;
  for (const e of enemyMgr.all()) {
    _toEnemy.copy(e.root.position).sub(player.pos);
    const d = _toEnemy.length();
    if (d < 4 || d > 220) continue;
    _toEnemy.normalize();
    const dot = _toEnemy.dot(_aimDir);
    if (dot > 0.985 && d < bestDist) {
      bestDist = d; bestDot = dot;
    }
  }
  const has = bestDot > 0;
  const center = clamp((bestDot - 0.985) / 0.015, 0, 1);
  input.setTargetState(has, center);
  // lock indicator
  if (ui.lockIndicator) ui.lockIndicator.classList.toggle('show', has);
}

// =============== Radar minimap ===============
function drawRadar() {
  if (!ui.radar) return;
  const c = ui.radar;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  // background
  ctx.fillStyle = 'rgba(8, 12, 22, 0.7)';
  ctx.fillRect(0, 0, W, H);
  // grid rings
  ctx.strokeStyle = 'rgba(125, 249, 255, 0.18)';
  ctx.lineWidth = 1;
  for (let r = 0.25; r <= 1; r += 0.25) {
    ctx.beginPath(); ctx.arc(W/2, H/2, (W/2 - 4) * r, 0, Math.PI*2); ctx.stroke();
  }
  // forward axis
  ctx.strokeStyle = 'rgba(125, 249, 255, 0.25)';
  ctx.beginPath(); ctx.moveTo(W/2, H/2); ctx.lineTo(W/2, 4); ctx.stroke();

  // self
  ctx.fillStyle = '#7df9ff';
  ctx.beginPath(); ctx.arc(W/2, H/2, 3, 0, Math.PI*2); ctx.fill();

  if (!player) return;
  const RADAR_RANGE = 220;
  // enemies
  const fwd = new THREE.Vector3(0,0,-1).applyQuaternion(player.root.quaternion);
  const right = new THREE.Vector3(1,0,0).applyQuaternion(player.root.quaternion);
  const tmp = new THREE.Vector3();
  for (const e of enemyMgr.all()) {
    tmp.copy(e.root.position).sub(player.pos);
    const dx = tmp.dot(right);
    const dz = -tmp.dot(fwd);  // forward = up on radar
    const ddist = Math.hypot(dx, dz);
    if (ddist > RADAR_RANGE) continue;
    const px = W/2 + (dx / RADAR_RANGE) * (W/2 - 4);
    const py = H/2 + (dz / RADAR_RANGE) * (H/2 - 4);
    ctx.fillStyle = e.kind === 'boss' ? '#ff3b6b' : '#ff6ec7';
    ctx.beginPath(); ctx.arc(px, py, e.kind === 'boss' ? 4.5 : 2.5, 0, Math.PI*2); ctx.fill();
  }
  // crystals (salvage)
  const near = world.gatherNear(player.pos.z, RADAR_RANGE);
  for (const item of near.crystals) {
    if (item.obj.userData.kind === 'power') continue;
    tmp.copy(item.parent.position).add(item.obj.position).sub(player.pos);
    const dx = tmp.dot(right);
    const dz = -tmp.dot(fwd);
    const ddist = Math.hypot(dx, dz);
    if (ddist > RADAR_RANGE) continue;
    const px = W/2 + (dx / RADAR_RANGE) * (W/2 - 4);
    const py = H/2 + (dz / RADAR_RANGE) * (H/2 - 4);
    ctx.fillStyle = 'rgba(136, 255, 214, 0.85)';
    ctx.fillRect(px-1, py-1, 2, 2);
  }
}

// =============== HUD ===============
let fpsAcc = 0, fpsFrames = 0;
function updateHud(dt) {
  ui.hudScore.textContent = state.score.toLocaleString();
  ui.hudSalvage.textContent = state.runSalvage.toLocaleString();
  ui.hudStage.textContent = state.stage;
  ui.hudSpeed.textContent = String(Math.floor(player.speed * 1.6)).padStart(3, '0');

  updatePilotHudUI();

  const distInStage = state.stageStartZ - player.pos.z;
  const waveP = clamp(distInStage / state.stageDistanceTarget, 0, 1);
  ui.hudWave.style.width = (waveP * 100).toFixed(0) + '%';

  const off = (1 - player.boostFuel) * 289;
  ui.boostRing.setAttribute('stroke-dashoffset', off.toFixed(1));
  ui.boostRing.setAttribute('stroke', player.boostActive ? '#ff6ec7' : '#7df9ff');

  const sNorm = clamp((player.speed - player.minSpeed) / (player.maxSpeed - player.minSpeed), 0, 1);
  ui.speedLines.classList.toggle('boost', sNorm > 0.7 || player.boostActive);

  if (enemyMgr.boss && enemyMgr.boss.alive) {
    ui.hudBossBar.classList.remove('hidden');
    const f = clamp(enemyMgr.boss.hp / enemyMgr.boss.maxHp, 0, 1);
    ui.hudBossFill.style.width = (f * 100).toFixed(1) + '%';
    if (ui.hudBossName) ui.hudBossName.textContent = `STAGE ${state.stage} BOSS`;
  } else {
    ui.hudBossBar.classList.add('hidden');
  }

  // combo meter
  if (state.comboTimer > 0) {
    state.comboTimer -= dt;
    if (state.comboTimer <= 0) state.comboCount = 0;
  }
  if (ui.hudCombo) {
    if (state.comboCount >= 3) {
      ui.hudCombo.classList.remove('hidden');
      ui.hudComboNum.textContent = `x${state.comboCount}`;
      ui.hudComboFill.style.width = ((state.comboTimer / 3.5) * 100).toFixed(0) + '%';
    } else {
      ui.hudCombo.classList.add('hidden');
    }
  }

  updateMissileUI();

  const distInStage2 = state.stageStartZ - player.pos.z;
  if (!state.bossWarned && distInStage2 > state.stageDistanceTarget * 0.85) {
    state.bossWarned = true;
    flashMsg('⚠ BOSS APPROACHING ⚠');
    audio.bossWarning();
  }

  // radar (every other frame to save cost)
  drawRadar();

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

  // hand calibration trigger
  if (input.consumeCalibrate && input.consumeCalibrate()) {
    handTracker.recalibrate?.();
    flashMsg('再キャリブ中…');
  }

  input.update(rawDt);

  if (state.running && !state.paused) {
    // forward target hint to input manager (auto-fire & aim assist)
    updateAutoFireTargetHint();

    player.update(dt, input, time);

    if (input.isFiring()) {
      const bullets = player.tryFire();
      if (bullets) {
        for (const b of bullets) projMgr.spawnPlayerBullet(b);
        audio.laser();
      }
    }
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
      audio.enemyShot();
    });

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
