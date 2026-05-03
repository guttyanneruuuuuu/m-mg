// ===========================================================
// upgrades.js — STARFORGE meta-progression system (v2)
//   - Permanent stat upgrades (HANGAR shop)
//   - Pilot level / XP gained from kills (auto soft-progression)
//   - Equipment loadout: 3 slots (PRIMARY / SECONDARY / MODULE)
//     + per-slot inventory of dropped items with rarities
//   - Ship skins (decorative, unlocked at milestones)
//   - Achievements + daily missions
//   - All deposited at run-end like Vampire Survivors / Dada-Survivors.
// ===========================================================

import { Storage, clamp } from './utils.js';

// ====================== STAT UPGRADES ======================
export const UPGRADES = {
  hp: {
    id: 'hp', name: 'シールド容量', desc: '最大HPを増加',
    icon: '🛡️', max: 15, category: 'defense',
    cost: lvl => Math.round(80 * Math.pow(1.45, lvl)),
    effect: lvl => ({ hp: 3 + lvl })
  },
  damage: {
    id: 'damage', name: 'プラズマ威力', desc: '主砲のダメージ',
    icon: '💥', max: 18, category: 'offense',
    cost: lvl => Math.round(60 * Math.pow(1.42, lvl)),
    effect: lvl => ({ damage: 1 + lvl * 0.6 })
  },
  fireRate: {
    id: 'fireRate', name: '連射速度', desc: '主砲の発射レート',
    icon: '⚡', max: 14, category: 'offense',
    cost: lvl => Math.round(70 * Math.pow(1.40, lvl)),
    effect: lvl => ({ fireRate: 1 + lvl * 0.18 })
  },
  multishot: {
    id: 'multishot', name: 'マルチショット', desc: '同時発射する弾数 +1',
    icon: '🎯', max: 6, category: 'offense',
    cost: lvl => Math.round(220 * Math.pow(1.85, lvl)),
    effect: lvl => ({ multishot: 1 + lvl })
  },
  pierce: {
    id: 'pierce', name: '貫通', desc: '弾が敵を貫通する回数',
    icon: '➡️', max: 5, category: 'offense',
    cost: lvl => Math.round(280 * Math.pow(1.95, lvl)),
    effect: lvl => ({ pierce: lvl })
  },
  speed: {
    id: 'speed', name: 'エンジン出力', desc: '機動速度',
    icon: '🚀', max: 12, category: 'mobility',
    cost: lvl => Math.round(50 * Math.pow(1.36, lvl)),
    effect: lvl => ({ speed: 1 + lvl * 0.06 })
  },
  agility: {
    id: 'agility', name: '応答性', desc: '操舵レスポンス向上 (回頭が速い)',
    icon: '🌀', max: 8, category: 'mobility',
    cost: lvl => Math.round(110 * Math.pow(1.46, lvl)),
    effect: lvl => ({ agility: 1 + lvl * 0.10 })
  },
  missiles: {
    id: 'missiles', name: '誘導ミサイル', desc: '装弾数 + 弾着AOE',
    icon: '🚀', max: 10, category: 'offense',
    cost: lvl => Math.round(180 * Math.pow(1.6, lvl)),
    effect: lvl => ({
      missileAmmo: lvl,
      missileDamage: 6 + lvl * 1.5,
      missileRegen: 0.10 + lvl * 0.02
    })
  },
  salvageBoost: {
    id: 'salvageBoost', name: '回収率', desc: '取得サルベージ +20%/Lv',
    icon: '💎', max: 10, category: 'utility',
    cost: lvl => Math.round(120 * Math.pow(1.55, lvl)),
    effect: lvl => ({ salvageMul: 1 + lvl * 0.20 })
  },
  shieldRegen: {
    id: 'shieldRegen', name: 'シールド再生', desc: '被弾後の自動回復',
    icon: '♻️', max: 10, category: 'defense',
    cost: lvl => Math.round(150 * Math.pow(1.50, lvl)),
    effect: lvl => ({
      shieldRegenRate: 0.10 + lvl * 0.07,
      shieldRegenDelay: Math.max(2.0, 6.0 - lvl * 0.5)
    })
  },
  aimAssist: {
    id: 'aimAssist', name: 'エイムアシスト', desc: '弾が敵に少し吸い寄せられる',
    icon: '🎯', max: 6, category: 'utility',
    cost: lvl => Math.round(140 * Math.pow(1.55, lvl)),
    effect: lvl => ({ aimAssist: lvl * 0.06 })
  },
  critChance: {
    id: 'critChance', name: 'クリティカル率', desc: '一定確率で 2.0倍ダメージ',
    icon: '✨', max: 8, category: 'offense',
    cost: lvl => Math.round(200 * Math.pow(1.62, lvl)),
    effect: lvl => ({ critChance: lvl * 0.06, critMul: 2.0 })
  }
};

export const UPGRADE_ORDER = [
  'hp', 'shieldRegen',
  'damage', 'fireRate', 'multishot', 'pierce', 'critChance',
  'speed', 'agility', 'aimAssist',
  'missiles', 'salvageBoost'
];

export const CATEGORIES = {
  offense:  { label: '攻撃',   color: '#ff6ec7', icon: '⚔' },
  defense:  { label: '防御',   color: '#7df9ff', icon: '🛡' },
  mobility: { label: '機動',   color: '#88ffd6', icon: '🚀' },
  utility:  { label: 'ユーティリティ', color: '#ffd86b', icon: '⚙' }
};

// ====================== EQUIPMENT (drops) ======================
// Items drop from boss kills and rare elites. Each item has a slot,
// rarity, and additive stat-mod bundle.

export const RARITIES = {
  common:    { label: 'コモン',     color: '#9aa8c2', mul: 1.0,  weight: 60 },
  rare:      { label: 'レア',       color: '#7df9ff', mul: 1.6,  weight: 26 },
  epic:      { label: 'エピック',   color: '#b388ff', mul: 2.4,  weight: 11 },
  legendary: { label: 'レジェンド', color: '#ffd86b', mul: 3.6,  weight: 3  }
};

// Each "blueprint" describes a possible piece of gear. Roll picks a blueprint
// then scales its bundle by rarity multiplier.
export const BLUEPRINTS = {
  // ---- PRIMARY (main cannon) ----
  cannon_burst: {
    id: 'cannon_burst', slot: 'primary', name: 'バースト・キャノン',
    icon: '🔫', baseDesc: '連射 +x%, ダメージ +x%',
    bundle: r => ({ fireRate: 0.10 * r, damage: 0.05 * r })
  },
  cannon_heavy: {
    id: 'cannon_heavy', slot: 'primary', name: 'ヘビー・ランス',
    icon: '🗡', baseDesc: '威力 +x%, 弾速 +x%',
    bundle: r => ({ damage: 0.20 * r, bulletSpeed: 0.15 * r })
  },
  cannon_sweeper: {
    id: 'cannon_sweeper', slot: 'primary', name: 'スイーパー',
    icon: '🌐', baseDesc: 'マルチショット +1, 弾広がり +x%',
    bundle: r => ({ flatMultishot: 1, spread: 0.04 * r })
  },
  cannon_railgun: {
    id: 'cannon_railgun', slot: 'primary', name: 'レールガン',
    icon: '⚡', baseDesc: '貫通 +1, ダメージ +x%',
    bundle: r => ({ flatPierce: 1, damage: 0.12 * r })
  },

  // ---- SECONDARY (missile / sub) ----
  missile_swarm: {
    id: 'missile_swarm', slot: 'secondary', name: 'スウォーム・ポッド',
    icon: '🎆', baseDesc: 'ミサイル装弾 +x, 再生 +x%',
    bundle: r => ({ flatMissileAmmo: Math.round(1 * r), missileRegen: 0.05 * r })
  },
  missile_nuke: {
    id: 'missile_nuke', slot: 'secondary', name: 'ニュークリア',
    icon: '💣', baseDesc: 'ミサイル威力 +x%, AOE拡大',
    bundle: r => ({ missileDamage: 0.30 * r, missileAoe: 0.20 * r })
  },
  flak_shield: {
    id: 'flak_shield', slot: 'secondary', name: 'フラッシュ・シールド',
    icon: '🛡', baseDesc: '被弾無敵時間 +x%',
    bundle: r => ({ invulnTime: 0.18 * r })
  },
  drone_pulse: {
    id: 'drone_pulse', slot: 'secondary', name: 'パルス・ドローン',
    icon: '🤖', baseDesc: '自動で周辺の敵にパルス攻撃',
    bundle: r => ({ droneDps: 1.5 * r, droneRange: 8 + 2 * r })
  },

  // ---- MODULE (passive tech) ----
  mod_overcharge: {
    id: 'mod_overcharge', slot: 'module', name: 'オーバーチャージャー',
    icon: '🔋', baseDesc: 'ダメージ +x%, 連射 +x%',
    bundle: r => ({ damage: 0.10 * r, fireRate: 0.08 * r })
  },
  mod_shieldcell: {
    id: 'mod_shieldcell', slot: 'module', name: 'シールド・セル',
    icon: '💠', baseDesc: '最大HP +x, 自動回復 +x%',
    bundle: r => ({ flatHp: Math.round(1 * r), shieldRegenRate: 0.08 * r })
  },
  mod_thrusters: {
    id: 'mod_thrusters', slot: 'module', name: 'マグ・スラスタ',
    icon: '💨', baseDesc: '機動 +x%, 応答 +x%',
    bundle: r => ({ speed: 0.06 * r, agility: 0.10 * r })
  },
  mod_magnet: {
    id: 'mod_magnet', slot: 'module', name: 'マグネット・コア',
    icon: '🧲', baseDesc: '💎吸引範囲 +x%, 取得量 +x%',
    bundle: r => ({ magnetRadius: 8 * r, salvageMul: 0.10 * r })
  },
  mod_focus: {
    id: 'mod_focus', slot: 'module', name: 'ターゲット・フォーカス',
    icon: '🎯', baseDesc: 'エイムアシスト +x%, クリティカル +x%',
    bundle: r => ({ aimAssist: 0.08 * r, critChance: 0.06 * r })
  },
  mod_chrono: {
    id: 'mod_chrono', slot: 'module', name: 'クロノ・コア',
    icon: '⏱', baseDesc: 'ニアミス時に短時間スローモー',
    bundle: r => ({ chronoTrigger: 0.12 + 0.08 * r, chronoStrength: 0.5 + 0.15 * r })
  }
};

export const SLOT_LABELS = {
  primary:   { label: 'プライマリ', icon: '🔫', desc: '主砲モジュール' },
  secondary: { label: 'セカンダリ', icon: '🚀', desc: '副兵装・支援' },
  module:    { label: 'モジュール', icon: '⚙',  desc: 'パッシブ補助' }
};

// ---------- Skins ----------
export const SKINS = {
  default: {
    id: 'default', name: 'インターセプター', desc: 'デフォルト',
    hull: 0x1a1f2e, accent: 0x7df9ff, trim: 0xff6ec7,
    unlock: () => true
  },
  ace: {
    id: 'ace', name: 'エース・カラー', desc: '5機を撃墜したパイロット',
    hull: 0x2c1a40, accent: 0xff6ec7, trim: 0xb388ff,
    unlock: bank => bank.totalKills >= 50
  },
  veteran: {
    id: 'veteran', name: 'ベテラン', desc: 'ステージ10到達',
    hull: 0x1b2a3f, accent: 0x88ffd6, trim: 0x7df9ff,
    unlock: bank => bank.bestStage >= 10
  },
  inferno: {
    id: 'inferno', name: 'インフェルノ', desc: '500機撃墜',
    hull: 0x2a1a1a, accent: 0xff7d3a, trim: 0xffd86b,
    unlock: bank => bank.totalKills >= 500
  },
  voidlord: {
    id: 'voidlord', name: 'ヴォイドロード', desc: '100ステージ制覇',
    hull: 0x0a0a18, accent: 0xc06bff, trim: 0xff5fa2,
    unlock: bank => bank.bestStage >= 100
  },
  prism: {
    id: 'prism', name: 'プリズム', desc: '5レジェンド装備を所有',
    hull: 0xf5f5ff, accent: 0x7df9ff, trim: 0xff6ec7,
    unlock: bank => bank.legendaryCount() >= 5
  }
};

// ====================== ACHIEVEMENTS ======================
export const ACHIEVEMENTS = [
  { id: 'first_blood', name: '初撃墜',   desc: '敵艦を1機撃墜',   icon: '🎯',
    check: b => b.totalKills >= 1, reward: { salvage: 30 } },
  { id: 'kill_50',     name: '掃討者',   desc: '50機撃墜',        icon: '⚔',
    check: b => b.totalKills >= 50, reward: { salvage: 200 } },
  { id: 'kill_500',    name: '殲滅者',   desc: '500機撃墜',       icon: '💀',
    check: b => b.totalKills >= 500, reward: { salvage: 1500 } },
  { id: 'stage_10',    name: '宇宙の盾', desc: 'ステージ10到達',  icon: '🛡',
    check: b => b.bestStage >= 10, reward: { salvage: 500 } },
  { id: 'stage_50',    name: '銀河の覇者', desc: 'ステージ50到達', icon: '👑',
    check: b => b.bestStage >= 50, reward: { salvage: 3000 } },
  { id: 'stage_100',   name: '伝説',     desc: 'ステージ100到達', icon: '🏆',
    check: b => b.bestStage >= 100, reward: { salvage: 9999 } },
  { id: 'maxed_one',   name: '専門家',   desc: '何かをMAX強化',   icon: '✨',
    check: b => Object.entries(b.levels).some(([id, lv]) => UPGRADES[id] && lv >= UPGRADES[id].max),
    reward: { salvage: 800 } },
  { id: 'legend_drop', name: '神話を手に', desc: 'レジェンド装備を入手', icon: '🌟',
    check: b => b.legendaryCount() >= 1, reward: { salvage: 600 } }
];

// ====================== DAILY MISSIONS ======================
export const MISSION_POOL = [
  { id: 'kill_25',    desc: '1ランで25機撃墜',           reward: 200, key: 'killsRun', target: 25 },
  { id: 'kill_60',    desc: '1ランで60機撃墜',           reward: 500, key: 'killsRun', target: 60 },
  { id: 'salvage_500',desc: '1ランで500💎収集',          reward: 250, key: 'salvageRun', target: 500 },
  { id: 'salvage_1500',desc: '1ランで1500💎収集',        reward: 600, key: 'salvageRun', target: 1500 },
  { id: 'boss_3',     desc: '3体のボスを倒す (累積)',     reward: 400, key: 'bossKills', target: 3 },
  { id: 'no_damage',  desc: 'ボスをノーダメージで撃破',   reward: 800, key: 'bossNoDmg', target: 1 },
  { id: 'reach_5',    desc: 'ステージ+5まで進む',         reward: 350, key: 'stagesRun', target: 5 }
];

// ====================== PILOT LEVEL ======================
export function xpForLevel(lvl) {
  return Math.round(60 * Math.pow(1.20, lvl - 1));
}

// Each pilot level gives +1 attribute point and a small stat bonus
export function pilotPassive(level) {
  return {
    hp: Math.floor(level / 5),       // +1 HP every 5 levels
    damage: level * 0.02,            // +2% per level
    fireRate: level * 0.015,
    speed: level * 0.01,
    salvageMul: level * 0.01
  };
}

// ====================== BANK ======================
export class UpgradeBank {
  constructor() {
    const s = Storage.load();
    this.salvage = s.salvage || 0;
    this.stage = s.stage || 1;
    this.bestStage = s.bestStage || 1;
    this.bestScore = s.bestScore || 0;
    this.totalKills = s.totalKills || 0;
    this.totalRuns = s.totalRuns || 0;
    this.bossKills = s.bossKills || 0;
    this.levels = s.levels || {};
    for (const id of UPGRADE_ORDER) if (this.levels[id] === undefined) this.levels[id] = 0;

    // pilot
    this.pilotLevel = s.pilotLevel || 1;
    this.pilotXp = s.pilotXp || 0;

    // equipment
    this.inventory = s.inventory || [];     // array of item objects
    this.loadout = s.loadout || { primary: null, secondary: null, module: null };

    // skin
    this.skin = s.skin || 'default';

    // unlocked achievements (ids)
    this.unlockedAchievements = s.unlockedAchievements || [];

    // daily missions
    this.dailyMissions = s.dailyMissions || null; // {date, missions: [{id, progress, claimed}]}
    this.refreshDailyMissions();
  }

  save() {
    Storage.patch({
      salvage: this.salvage, stage: this.stage,
      bestStage: this.bestStage, bestScore: this.bestScore,
      totalKills: this.totalKills, totalRuns: this.totalRuns,
      bossKills: this.bossKills,
      levels: this.levels,
      pilotLevel: this.pilotLevel, pilotXp: this.pilotXp,
      inventory: this.inventory, loadout: this.loadout,
      skin: this.skin,
      unlockedAchievements: this.unlockedAchievements,
      dailyMissions: this.dailyMissions
    });
  }

  level(id) { return this.levels[id] || 0; }
  costNext(id) {
    const u = UPGRADES[id];
    const lvl = this.level(id);
    if (lvl >= u.max) return Infinity;
    return u.cost(lvl);
  }
  canUpgrade(id) {
    const c = this.costNext(id);
    return Number.isFinite(c) && this.salvage >= c;
  }
  upgrade(id) {
    if (!this.canUpgrade(id)) return false;
    this.salvage -= this.costNext(id);
    this.levels[id] = (this.levels[id] || 0) + 1;
    this.save();
    return true;
  }

  // ---- equipment helpers ----
  legendaryCount() {
    return this.inventory.filter(it => it.rarity === 'legendary').length;
  }
  equippedItems() {
    const out = [];
    for (const slot of ['primary', 'secondary', 'module']) {
      const id = this.loadout[slot];
      if (!id) continue;
      const it = this.inventory.find(x => x.uid === id);
      if (it) out.push(it);
    }
    return out;
  }
  equip(slot, uid) {
    const it = this.inventory.find(x => x.uid === uid);
    if (!it || it.slot !== slot) return false;
    this.loadout[slot] = uid;
    this.save();
    return true;
  }
  unequip(slot) {
    this.loadout[slot] = null;
    this.save();
  }
  scrapItem(uid) {
    const idx = this.inventory.findIndex(x => x.uid === uid);
    if (idx < 0) return 0;
    const it = this.inventory[idx];
    // refund based on rarity
    const refund = Math.round({ common: 30, rare: 90, epic: 240, legendary: 700 }[it.rarity]);
    this.inventory.splice(idx, 1);
    for (const slot of ['primary','secondary','module']) {
      if (this.loadout[slot] === uid) this.loadout[slot] = null;
    }
    this.salvage += refund;
    this.save();
    return refund;
  }

  // Roll a random item for a drop. Higher stage = better rarity weights.
  rollItem(stage = 1, forceRarity = null) {
    let rarity = forceRarity;
    if (!rarity) {
      // weight pool, slightly biased by stage
      const rs = Object.entries(RARITIES);
      const stageBoost = clamp(stage * 0.5, 0, 25);
      let total = 0;
      const ws = rs.map(([k, v]) => {
        let w = v.weight;
        if (k === 'rare') w += stageBoost * 0.6;
        if (k === 'epic') w += stageBoost * 0.4;
        if (k === 'legendary') w += stageBoost * 0.15;
        total += w; return [k, w];
      });
      let r = Math.random() * total;
      for (const [k, w] of ws) { if ((r -= w) < 0) { rarity = k; break; } }
      if (!rarity) rarity = 'common';
    }
    const ids = Object.keys(BLUEPRINTS);
    const bpId = ids[Math.floor(Math.random() * ids.length)];
    const bp = BLUEPRINTS[bpId];
    const mul = RARITIES[rarity].mul;
    const bundle = bp.bundle(mul);
    const uid = 'it_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const item = {
      uid, bp: bpId, slot: bp.slot, rarity, mul,
      bundle, name: bp.name, icon: bp.icon
    };
    return item;
  }

  addItem(item) {
    this.inventory.push(item);
    if (this.inventory.length > 60) {
      // FIFO trim — oldest common first
      const idx = this.inventory.findIndex(x => x.rarity === 'common');
      if (idx >= 0) this.inventory.splice(idx, 1);
      else this.inventory.shift();
    }
    this.save();
  }

  // Compose all stat effects into single stats obj (upgrades + pilot + equipment)
  composeStats() {
    const stats = {
      hp: 3, damage: 1, fireRate: 1, multishot: 1, pierce: 0,
      speed: 1, agility: 1, salvageMul: 1, missileAmmo: 0,
      missileDamage: 6, missileRegen: 0.10, missileAoe: 0,
      shieldRegenRate: 0.10, shieldRegenDelay: 6.0,
      bulletSpeed: 1, spread: 0.025, aimAssist: 0,
      critChance: 0, critMul: 2.0,
      magnetRadius: 6, invulnTime: 1.4,
      droneDps: 0, droneRange: 0,
      chronoTrigger: 0, chronoStrength: 0
    };

    // 1) base upgrade levels
    for (const id of UPGRADE_ORDER) {
      const u = UPGRADES[id];
      const lvl = this.level(id);
      const eff = u.effect(lvl);
      for (const [k, v] of Object.entries(eff)) {
        // hp/missileAmmo etc — additive (not multiplicative); but values
        // returned by `effect` already incorporate base, so override.
        stats[k] = v;
      }
    }

    // 2) pilot passive
    const pp = pilotPassive(this.pilotLevel);
    stats.hp += pp.hp;
    stats.damage *= (1 + pp.damage);
    stats.fireRate *= (1 + pp.fireRate);
    stats.speed *= (1 + pp.speed);
    stats.salvageMul *= (1 + pp.salvageMul);

    // 3) equipped items
    for (const it of this.equippedItems()) {
      const b = it.bundle || {};
      // multipliers
      if (b.damage) stats.damage *= (1 + b.damage);
      if (b.fireRate) stats.fireRate *= (1 + b.fireRate);
      if (b.bulletSpeed) stats.bulletSpeed *= (1 + b.bulletSpeed);
      if (b.spread) stats.spread *= (1 + b.spread);
      if (b.missileDamage) stats.missileDamage *= (1 + b.missileDamage);
      if (b.missileRegen) stats.missileRegen += b.missileRegen;
      if (b.missileAoe) stats.missileAoe += b.missileAoe;
      if (b.shieldRegenRate) stats.shieldRegenRate += b.shieldRegenRate;
      if (b.salvageMul) stats.salvageMul *= (1 + b.salvageMul);
      if (b.speed) stats.speed *= (1 + b.speed);
      if (b.agility) stats.agility *= (1 + b.agility);
      if (b.aimAssist) stats.aimAssist += b.aimAssist;
      if (b.critChance) stats.critChance += b.critChance;
      if (b.invulnTime) stats.invulnTime *= (1 + b.invulnTime);
      // flat bonuses
      if (b.flatHp) stats.hp += b.flatHp;
      if (b.flatMultishot) stats.multishot += b.flatMultishot;
      if (b.flatPierce) stats.pierce += b.flatPierce;
      if (b.flatMissileAmmo) stats.missileAmmo += b.flatMissileAmmo;
      if (b.magnetRadius) stats.magnetRadius += b.magnetRadius;
      if (b.droneDps) stats.droneDps += b.droneDps;
      if (b.droneRange) stats.droneRange = Math.max(stats.droneRange, b.droneRange);
      if (b.chronoTrigger) stats.chronoTrigger = Math.max(stats.chronoTrigger, b.chronoTrigger);
      if (b.chronoStrength) stats.chronoStrength = Math.max(stats.chronoStrength, b.chronoStrength);
    }

    return stats;
  }

  addSalvage(n) {
    this.salvage += Math.max(0, Math.floor(n));
    this.save();
  }
  setStage(s) {
    this.stage = s;
    if (s > this.bestStage) this.bestStage = s;
    this.save();
  }

  // ---- Pilot XP ----
  addXp(n) {
    this.pilotXp += Math.max(0, Math.floor(n));
    let levelsGained = 0;
    while (this.pilotXp >= xpForLevel(this.pilotLevel)) {
      this.pilotXp -= xpForLevel(this.pilotLevel);
      this.pilotLevel++;
      levelsGained++;
      if (this.pilotLevel >= 99) { this.pilotXp = 0; break; }
    }
    if (levelsGained) this.save();
    return levelsGained;
  }
  xpToNext() { return xpForLevel(this.pilotLevel); }

  // ---- Achievements ----
  checkAchievements() {
    const newly = [];
    for (const a of ACHIEVEMENTS) {
      if (this.unlockedAchievements.includes(a.id)) continue;
      if (a.check(this)) {
        this.unlockedAchievements.push(a.id);
        if (a.reward?.salvage) this.salvage += a.reward.salvage;
        newly.push(a);
      }
    }
    if (newly.length) this.save();
    return newly;
  }

  // ---- Daily missions ----
  todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
  }
  refreshDailyMissions() {
    const today = this.todayKey();
    if (!this.dailyMissions || this.dailyMissions.date !== today) {
      // pick 3 missions
      const pool = [...MISSION_POOL].sort(() => Math.random() - 0.5).slice(0, 3);
      this.dailyMissions = {
        date: today,
        missions: pool.map(m => ({ id: m.id, progress: 0, claimed: false }))
      };
      this.save();
    }
  }
  missionDef(id) { return MISSION_POOL.find(m => m.id === id); }
  recordMissionProgress(stats) {
    // stats = { killsRun, salvageRun, stagesRun, bossNoDmg }
    for (const m of this.dailyMissions.missions) {
      if (m.claimed) continue;
      const def = this.missionDef(m.id);
      if (!def) continue;
      if (def.key === 'bossKills') {
        m.progress = this.bossKills;
      } else if (stats[def.key] != null) {
        m.progress = Math.max(m.progress, stats[def.key]);
      }
    }
    this.save();
  }
  claimMission(id) {
    const m = this.dailyMissions.missions.find(x => x.id === id);
    if (!m || m.claimed) return 0;
    const def = this.missionDef(id);
    if (!def || m.progress < def.target) return 0;
    m.claimed = true;
    this.salvage += def.reward;
    this.save();
    return def.reward;
  }

  // ---- Skins ----
  isSkinUnlocked(id) {
    const sk = SKINS[id];
    if (!sk) return false;
    return sk.unlock(this);
  }
  setSkin(id) {
    if (!SKINS[id]) return false;
    if (!this.isSkinUnlocked(id)) return false;
    this.skin = id;
    this.save();
    return true;
  }
  currentSkin() { return SKINS[this.skin] || SKINS.default; }

  reset() {
    this.salvage = 0;
    this.stage = 1;
    this.bestStage = 1;
    this.bestScore = 0;
    this.totalKills = 0;
    this.totalRuns = 0;
    this.bossKills = 0;
    for (const id of UPGRADE_ORDER) this.levels[id] = 0;
    this.pilotLevel = 1; this.pilotXp = 0;
    this.inventory = [];
    this.loadout = { primary: null, secondary: null, module: null };
    this.skin = 'default';
    this.unlockedAchievements = [];
    this.dailyMissions = null;
    this.refreshDailyMissions();
    this.save();
  }
}
