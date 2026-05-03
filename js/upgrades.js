// ===========================================================
// upgrades.js — STARFORGE persistent upgrade system
//   - Each upgrade has level (0..MAX) and a cost curve
//   - Player stats are computed from upgrade levels
//   - Salvage (currency) earned in run is deposited to bank
//     when run ends (regardless of win/lose) — Vampire Survivors
//     / Dada-Survivors style meta progression.
// ===========================================================

import { Storage, clamp } from './utils.js';

export const UPGRADES = {
  hp: {
    id: 'hp',
    name: 'シールド容量',
    desc: '最大HPを増加',
    icon: '🛡️',
    max: 12,
    cost: lvl => Math.round(80 * Math.pow(1.45, lvl)),
    effect: lvl => ({ hp: 3 + lvl })       // base 3
  },
  damage: {
    id: 'damage',
    name: 'プラズマ威力',
    desc: '主砲のダメージ',
    icon: '💥',
    max: 15,
    cost: lvl => Math.round(60 * Math.pow(1.42, lvl)),
    effect: lvl => ({ damage: 1 + lvl * 0.6 })
  },
  fireRate: {
    id: 'fireRate',
    name: '連射速度',
    desc: '主砲の発射レート',
    icon: '⚡',
    max: 12,
    cost: lvl => Math.round(70 * Math.pow(1.40, lvl)),
    effect: lvl => ({ fireRate: 1 + lvl * 0.18 })
  },
  multishot: {
    id: 'multishot',
    name: 'マルチショット',
    desc: '同時発射する弾数 +1',
    icon: '🎯',
    max: 5,
    cost: lvl => Math.round(220 * Math.pow(1.85, lvl)),
    effect: lvl => ({ multishot: 1 + lvl })
  },
  pierce: {
    id: 'pierce',
    name: '貫通',
    desc: '弾が敵を貫通する回数',
    icon: '➡️',
    max: 4,
    cost: lvl => Math.round(280 * Math.pow(1.95, lvl)),
    effect: lvl => ({ pierce: lvl })
  },
  speed: {
    id: 'speed',
    name: 'エンジン出力',
    desc: '機動速度',
    icon: '🚀',
    max: 10,
    cost: lvl => Math.round(50 * Math.pow(1.36, lvl)),
    effect: lvl => ({ speed: 1 + lvl * 0.06 })
  },
  missiles: {
    id: 'missiles',
    name: '誘導ミサイル',
    desc: '装弾数 + 弾着AOE',
    icon: '🚀',
    max: 8,
    cost: lvl => Math.round(180 * Math.pow(1.6, lvl)),
    effect: lvl => ({
      missileAmmo: lvl,                  // 0 if none
      missileDamage: 6 + lvl * 1.5,
      missileRegen: 0.10 + lvl * 0.02
    })
  },
  salvageBoost: {
    id: 'salvageBoost',
    name: '回収率',
    desc: '取得サルベージ +20%/Lv',
    icon: '💎',
    max: 8,
    cost: lvl => Math.round(120 * Math.pow(1.55, lvl)),
    effect: lvl => ({ salvageMul: 1 + lvl * 0.20 })
  },
  shieldRegen: {
    id: 'shieldRegen',
    name: 'シールド再生',
    desc: '被弾後の自動回復が早い',
    icon: '♻️',
    max: 8,
    cost: lvl => Math.round(150 * Math.pow(1.50, lvl)),
    effect: lvl => ({
      shieldRegenRate: 0.10 + lvl * 0.07,
      shieldRegenDelay: Math.max(2.5, 6.0 - lvl * 0.5)
    })
  },
};

export const UPGRADE_ORDER = [
  'hp', 'damage', 'fireRate', 'multishot', 'pierce',
  'speed', 'missiles', 'salvageBoost', 'shieldRegen'
];

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
  }

  save() {
    Storage.patch({
      salvage: this.salvage, stage: this.stage,
      bestStage: this.bestStage, bestScore: this.bestScore,
      totalKills: this.totalKills, totalRuns: this.totalRuns,
      bossKills: this.bossKills,
      levels: this.levels
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

  // Compose all stat effects into single stats obj
  composeStats() {
    const stats = {};
    for (const id of UPGRADE_ORDER) {
      const u = UPGRADES[id];
      const lvl = this.level(id);
      const eff = u.effect(lvl);
      Object.assign(stats, eff);
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

  reset() {
    this.salvage = 0;
    this.stage = 1;
    this.bestStage = 1;
    this.bestScore = 0;
    this.totalKills = 0;
    this.totalRuns = 0;
    this.bossKills = 0;
    for (const id of UPGRADE_ORDER) this.levels[id] = 0;
    this.save();
  }
}
