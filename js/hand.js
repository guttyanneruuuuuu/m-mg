// ===========================================================
// hand.js — MediaPipe Hands integration with smoothing.   (v2)
//   - Uses @mediapipe/tasks-vision (HandLandmarker, GPU)
//   - Robust calibration (recenters anytime hand is held still)
//   - Confidence-weighted smoothing (jitter-free)
//   - Detection guide (red/yellow/green frame & overlay tip)
//   - Outputs continuous control state to InputManager
// ===========================================================

import { OneEuro, clamp, lerp } from './utils.js';

const TASKS_VISION_VERSION = '0.10.14';

export class HandTracker {
  constructor(input) {
    this.input = input;
    this.video = document.getElementById('camVideo');
    this.canvas = document.getElementById('handCanvas');
    this.preview = document.getElementById('camPreview');
    this.statusEl = document.getElementById('camStatus');
    this.ctx = this.canvas.getContext('2d');
    this.landmarker = null;
    this.lastVideoTime = -1;
    this.running = false;
    this.stream = null;
    this.failed = false;

    // smoothing per axis — One-Euro filters tuned for buttery feel
    this.fRoll  = new OneEuro(1.4, 0.018, 1.0);
    this.fPitch = new OneEuro(1.4, 0.018, 1.0);
    this.fYaw   = new OneEuro(1.4, 0.018, 1.0);
    this.fFist  = new OneEuro(0.9, 0.006, 1.0);
    this.fOpen  = new OneEuro(0.9, 0.006, 1.0);

    // calibration: locked after stable frames, but can be re-locked any time
    this.calib = { rollOffset: 0, pitchOffset: 0, yawOffset: 0, locked: false, samples: 0, stillFrames: 0, lastRaw: null };

    // visibility + confidence
    this.confidence = 0;
  }

  setStatus(s, kind = 'info') {
    if (this.statusEl) this.statusEl.textContent = s;
    this.preview.classList.toggle('tracking', kind === 'ok');
    this.preview.classList.toggle('lost', kind === 'lost' || kind === 'warn');
    this.preview.classList.toggle('calibrating', kind === 'calibrating');
  }

  recalibrate() {
    this.calib = { rollOffset: 0, pitchOffset: 0, yawOffset: 0, locked: false, samples: 0, stillFrames: 0, lastRaw: null };
  }

  async start() {
    if (this.running) return;
    this.preview.classList.remove('hidden');
    this.setStatus('カメラ起動中…', 'calibrating');

    // 1) load mediapipe
    try {
      const vision = await import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}`);
      const filesetResolver = await vision.FilesetResolver.forVisionTasks(
        `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`
      );
      this.landmarker = await vision.HandLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate: 'GPU'
        },
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        runningMode: 'VIDEO'
      });
    } catch (err) {
      console.error('[hand] failed to load mediapipe', err);
      this.failed = true;
      this.setStatus('ハンド機能ロード失敗', 'warn');
      throw err;
    }

    // 2) request camera — prefer good resolution but cap for perf
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width:  { ideal: 720, max: 1280 },
          height: { ideal: 540, max: 720 },
          frameRate: { ideal: 30, max: 60 }
        }
      });
      this.video.srcObject = this.stream;
      await this.video.play();
    } catch (err) {
      console.error('[hand] camera error', err);
      this.failed = true;
      this.setStatus('カメラを使用できません', 'warn');
      throw err;
    }

    const resize = () => {
      this.canvas.width  = this.preview.clientWidth;
      this.canvas.height = this.preview.clientHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    this.setStatus('手をカメラの中央へ', 'calibrating');
    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    this.preview.classList.add('hidden');
  }

  _loop() {
    if (!this.running) return;
    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime;
      const t = performance.now();
      let res = null;
      try { res = this.landmarker.detectForVideo(v, t); } catch (e) {}
      this._process(res, t);
    }
    requestAnimationFrame(() => this._loop());
  }

  _process(res, time) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.ctx.clearRect(0, 0, w, h);

    const present = res && res.landmarks && res.landmarks.length > 0;
    if (!present) {
      this.confidence = lerp(this.confidence, 0, 0.1);
      this._drawGuide(false);
      this.setStatus('✋ 手を画面の中央に', 'lost');
      this.input.feedHand({ present: false, time });
      return;
    }

    const lm = res.landmarks[0]; // 21 normalized [0,1]
    // landmarks of interest
    const wrist  = lm[0];
    const thumbT = lm[4];
    const indexT = lm[8];
    const midT   = lm[12];
    const ringT  = lm[16];
    const pinkyT = lm[20];
    const indexB = lm[5];
    const midB   = lm[9];
    const ringB  = lm[13];
    const pinkyB = lm[17];

    // ==== validate hand is well within frame ====
    const cx = (indexB.x + pinkyB.x + wrist.x) / 3;
    const cy = (indexB.y + pinkyB.y + wrist.y) / 3;
    const inFrame = cx > 0.08 && cx < 0.92 && cy > 0.10 && cy < 0.92;
    if (!inFrame) {
      this.confidence = lerp(this.confidence, 0.3, 0.2);
      this._drawSkeleton(lm, 0.5, 0.5, 'rgba(255,181,71,0.85)');
      this._drawGuide(false, true);
      this.setStatus('もう少し中央へ', 'warn');
      this.input.feedHand({ present: false, time });
      return;
    }

    this.confidence = lerp(this.confidence, 1, 0.18);

    // ==== ROLL: angle of indexBase -> pinkyBase ====
    const rollRaw = Math.atan2(pinkyB.y - indexB.y, pinkyB.x - indexB.x);
    let roll = rollRaw / (Math.PI * 0.5);

    // ==== PITCH: y of palm center ====
    let pitch = (cy - 0.5) * 2.0;

    // ==== YAW: x of palm center ====
    let yaw = (cx - 0.5) * 2.0;

    // ==== FIST / OPENNESS ====
    const palmSize = Math.hypot(indexB.x - pinkyB.x, indexB.y - pinkyB.y) + 1e-6;
    const tips = [indexT, midT, ringT, pinkyT];
    let dSum = 0;
    for (const t of tips) dSum += Math.hypot(t.x - cx, t.y - cy);
    const meanDist = (dSum / tips.length) / palmSize; // ~0.6 closed, ~1.6 open
    const fistness = clamp(1 - (meanDist - 0.55) / 0.7, 0, 1);
    const openness = clamp((meanDist - 0.95) / 0.65, 0, 1);

    // ==== CALIBRATION ====
    // detect "still" hand: low velocity for ~1 second -> capture origin
    const raw = { r: roll, p: pitch, y: yaw };
    if (this.calib.lastRaw) {
      const d = Math.hypot(
        (raw.r - this.calib.lastRaw.r),
        (raw.p - this.calib.lastRaw.p),
        (raw.y - this.calib.lastRaw.y)
      );
      if (d < 0.012) this.calib.stillFrames++;
      else this.calib.stillFrames = Math.max(0, this.calib.stillFrames - 2);
    }
    this.calib.lastRaw = raw;

    if (!this.calib.locked) {
      // initial soft calibration — pull origin toward current pose
      this.calib.rollOffset  = lerp(this.calib.rollOffset,  roll,  0.10);
      this.calib.pitchOffset = lerp(this.calib.pitchOffset, pitch, 0.10);
      this.calib.yawOffset   = lerp(this.calib.yawOffset,   yaw,   0.10);
      this.calib.samples++;
      if (this.calib.samples > 20 && this.calib.stillFrames > 12) this.calib.locked = true;
    } else if (this.calib.stillFrames > 90) {
      // user has held the hand still for ~3 sec -> RE-LOCK origin (drift correction)
      this.calib.rollOffset  = lerp(this.calib.rollOffset,  roll,  0.04);
      this.calib.pitchOffset = lerp(this.calib.pitchOffset, pitch, 0.04);
      this.calib.yawOffset   = lerp(this.calib.yawOffset,   yaw,   0.04);
    }

    roll  -= this.calib.rollOffset;
    pitch -= this.calib.pitchOffset;
    yaw   -= this.calib.yawOffset;

    // smooth (One-Euro)
    const tSec = time / 1000;
    roll  = this.fRoll.filter(roll, tSec);
    pitch = this.fPitch.filter(pitch, tSec);
    yaw   = this.fYaw.filter(yaw, tSec);
    const fistS = this.fFist.filter(fistness, tSec);
    const openS = this.fOpen.filter(openness, tSec);

    // dead-zone
    const dz = (v, z) => Math.abs(v) < z ? 0 : Math.sign(v) * (Math.abs(v) - z) / (1 - z);
    roll  = dz(roll, 0.07);
    pitch = dz(pitch, 0.09);
    yaw   = dz(yaw, 0.09);

    // status line
    let label = 'OK';
    if (!this.calib.locked) label = 'キャリブレ中… 手を真っ直ぐ';
    else if (fistS > 0.7)  label = '✊ BOOST';
    else if (openS > 0.6)  label = '🖐️ BRAKE';
    else                   label = '✓ TRACKING';
    this.setStatus(label, this.calib.locked ? 'ok' : 'calibrating');

    // emit
    this.input.feedHand({
      present: true, time,
      roll: clamp(roll, -1.5, 1.5),
      pitch: clamp(pitch, -1.5, 1.5),
      yaw: clamp(yaw, -1.5, 1.5),
      fistness: fistS,
      openness: openS,
      confidence: this.confidence
    });

    // draw
    const tone = fistS > 0.7
      ? 'rgba(255,110,199,0.95)'
      : openS > 0.6
        ? 'rgba(125,249,255,0.95)'
        : 'rgba(179,136,255,0.92)';
    this._drawSkeleton(lm, fistS, openS, tone);
    this._drawGuide(true);
  }

  _drawGuide(ok, warn = false) {
    const w = this.canvas.width, h = this.canvas.height;
    const ctx = this.ctx;
    // central guide ring fades out once locked
    const alpha = this.calib.locked ? 0.2 : 0.55;
    const stroke = warn ? '#ffb547' : ok ? '#7df9ff' : '#ff6ec7';
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.ellipse(w/2, h/2, w * 0.32, h * 0.36, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  _drawSkeleton(lm, fist, open, color) {
    const w = this.canvas.width, h = this.canvas.height;
    const ctx = this.ctx;
    const X = x => (1 - x) * w; // mirrored
    const Y = y => y * h;

    const conns = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [5,9],[9,10],[10,11],[11,12],
      [9,13],[13,14],[14,15],[15,16],
      [13,17],[17,18],[18,19],[19,20],
      [0,17]
    ];

    ctx.lineWidth = 2.6;
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 9;
    ctx.beginPath();
    for (const [a, b] of conns) {
      ctx.moveTo(X(lm[a].x), Y(lm[a].y));
      ctx.lineTo(X(lm[b].x), Y(lm[b].y));
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#fff';
    for (const p of lm) {
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // emphasize fingertips when fist/open active
    if (fist > 0.7 || open > 0.6) {
      const tipIdx = [4, 8, 12, 16, 20];
      ctx.fillStyle = fist > 0.7 ? '#ff6ec7' : '#7df9ff';
      for (const i of tipIdx) {
        ctx.beginPath();
        ctx.arc(X(lm[i].x), Y(lm[i].y), 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
