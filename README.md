# 🌌 SKYRIFT — Hand-Controlled Sky Voyage

> 手のひらが操縦桿になる、止まらない空の旅。  
> A revolutionary 3D infinite flight action game controlled by your hand via webcam (MediaPipe), or by touch on mobile.

[**▶ Play in browser**](https://guttyanneruuuuuu.github.io/m-mg/) (after Pages is enabled)

---

## ✨ Features

- **🖐️ Hand-Tracking Flight (MediaPipe Hands)**
  - Tilt your palm → roll & bank
  - Move your hand up/down/left/right → pitch & yaw
  - **Close your fist → BOOST**
  - **Open your hand wide → BRAKE**
  - Auto-calibration centers your "neutral pose" on first frames
  - One-Euro filter smooths every input — buttery, no jitter
- **📱 Touch Mode (mobile)**
  - Floating relative joystick (snaps to where you touch)
  - Big BOOST / BRAKE buttons sized for thumbs
  - Designed for comfortable one-thumb-or-two play
- **⌨️ Keyboard fallback** (WASD / arrows / space-boost / C-brake) — also accepts mouse aim
- **🌅 Cinematic 3D world**
  - Custom sky shader (gradient + sun disk)
  - Sea-of-clouds plane with animated wave shader
  - Smooth, **rounded** floating islands (NOT cubic — a Genshin-like vibe)
  - Procedural infinite chunks: rings, crystals, asteroids, storm clouds
  - HDR bloom + ACES tonemapping + post-processing
- **🎵 Procedural audio engine** — no audio files, instant load. WebAudio synths handle music, pickups, hits, boost.
- **♾️ Endless** — there is no level, no clearing, no end. Just fly further.
- **🪙 Score / Combo / Best distance** persisted in localStorage.

## 🎮 Controls

| Action | Hand | Touch | Keyboard |
|---|---|---|---|
| Roll / Bank | Tilt palm L/R | Joystick L/R | A / D or ←/→ |
| Pitch (up/down) | Move palm up/down | Joystick up/down | W / S or ↑/↓ |
| Yaw | Move palm L/R | (auto via roll) | Q / E |
| Boost | Close fist ✊ | BOOST button | Space / Shift |
| Brake | Open hand wide 🖐️ | BRAKE button | C / Ctrl |
| Pause | — | ⏸ button | Esc |

**Pro tip:** Boost + hard-roll = 🌀 **Barrel Roll** (looks awesome).

## 🚀 Run locally

No build step. Just serve the folder over HTTP (camera/getUserMedia requires HTTPS or localhost).

```bash
# Python
python3 -m http.server 8000
# or Node
npx serve .
```

Then open http://localhost:8000.

## 🧱 Project structure

```
.
├── index.html          # main entry, loads ES modules
├── css/style.css       # full UI + HUD styling (glassmorphism / neon)
├── js/
│   ├── main.js         # boot, game loop, scene wiring
│   ├── world.js        # procedural sky/islands/pickups/hazards
│   ├── player.js       # ship mesh, flight model, trails
│   ├── input.js        # unified controls (kbd / touch / hand)
│   ├── hand.js         # MediaPipe Hands + smoothing + drawing
│   ├── effects.js      # particle bursts (rings, hits, pickups)
│   ├── audio.js        # WebAudio procedural music + SFX
│   └── utils.js        # math, smoothing, OneEuro filter, storage
└── assets/             # (currently empty — everything is procedural)
```

## 🛠️ Tech

- [Three.js r160](https://threejs.org/) + EffectComposer (UnrealBloom)
- [@mediapipe/tasks-vision 0.10.x](https://github.com/google-ai-edge/mediapipe) (HandLandmarker, GPU)
- WebAudio API (procedural)
- Pure ES Modules + import maps. No bundler. No build.

## 📐 Performance

- Adaptive pixel ratio + bloom strength based on Quality setting (省エネ / Standard / Cinematic)
- Procedural chunked world with recycle behind player
- Default ~6 chunks ahead (≈1.3 km of generated world at any time)

## 🪪 License

MIT. Made for fun.
