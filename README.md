# STARFORGE — Hand-Controlled Space Combat (Survivor)

> 旧 SKYRIFT を全面リニューアルした、宇宙戦闘＋恒久強化型ローグライト。
> Mediapipe で **手の動き・形** をトラッキングし、戦闘機を操縦＆発射する WebGL ゲームです。

🎮 **Play it:** https://guttyanneruuuuuu.github.io/m-mg/

## ✨ 特徴

- **舞台は深宇宙** — 星雲、星屑、惑星、デレリクト艦が漂う戦場。
- **敵宇宙船との戦闘** — Scout / Fighter / Gunship / Bomber + 各ステージ末のボス。
- **Mediapipe ベースのハンド操作** — 手の傾き・形でロール／ピッチ／ヨーを操縦。
- **発射ジェスチャーをカスタマイズ** — 🤏 ピンチ / ☝️ ポイント / 👍 サムズアップ / ✊ 拳。
- **タッチ／キーボードでも遊べる** — Fire / Boost / Brake / Missile ボタン。
- **DaDa-Survivor 方式の進行** — 負けても回収した💎は永久に残り、`格納庫` で機体強化。
- **約100ステージで世界制覇** — 強化が進むほど勝てるようになる成長バランス。

## 🛠 強化項目（HANGAR）

| Icon | 名前 | 効果 |
|------|------|------|
| 🛡 | シールド容量 | 最大 HP +1 / Lv |
| 💥 | プラズマ威力 | ダメージ +60% / Lv |
| ⚡ | 連射速度 | 発射レート +18% / Lv |
| 🎯 | マルチショット | 同時発射弾数 +1 / Lv |
| ➡️ | 貫通 | 弾の貫通回数 +1 / Lv |
| 🚀 | エンジン出力 | 機動速度 +6% / Lv |
| 🚀 | 誘導ミサイル | 装弾数 + AOE威力 |
| 💎 | 回収率 | サルベージ +20% / Lv |
| ♻️ | シールド再生 | 自動回復が早く＆遅延短縮 |

## 🎮 Controls

### Hand mode (Mediapipe)
- 手のひらを傾ける → ロール／ピッチ／ヨー
- ✊ 拳 → BOOST
- 🖐️ 開く → BRAKE
- 🤏 ピンチ → 主砲発射 (設定で変更可)

### Keyboard
- WASD / Arrow → roll & pitch
- Q / E → yaw
- Space / Shift → BOOST
- C / Ctrl → BRAKE
- J / Z / Enter / Left-click → FIRE
- M / X / Right-click → MISSILE

### Touch (mobile)
- 左ジョイスティック → 操縦
- 右下 BOOST / BRAKE
- 🔫 FIRE / 🚀 MISSILE ボタン

## 🚀 Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## 📁 Project structure

```
m-mg/
├── index.html
├── css/style.css
└── js/
    ├── main.js          ゲームループ + UI / 進行管理
    ├── world.js         宇宙背景・隕石・カプセル
    ├── player.js        プレイヤー戦闘機
    ├── enemies.js       敵宇宙船 + ボス + 弾道
    ├── upgrades.js      恒久強化システム (HANGAR)
    ├── input.js         統合入力 (キーボード/マウス/タッチ/ハンド)
    ├── hand.js          Mediapipe Hands 統合
    ├── effects.js       爆発・衝撃波・ヒット
    ├── audio.js         WebAudio 効果音 + シンセ BGM
    ├── postfx.js        色収差・ヴィネット・グレイン
    └── utils.js         math / OneEuro / Storage
```

## 🧰 Tech stack

- **Three.js 0.160** — WebGL レンダリング
- **@mediapipe/tasks-vision** — 手のランドマーク検出
- **WebAudio API** — 全 SFX/BGM 手続き合成

## 📜 License

MIT
