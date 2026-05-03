// ===========================================================
// hand.js — MediaPipe Hands integration with smoothing.
//   Uses @mediapipe/tasks-vision (HandLandmarker, GPU)
//   Outputs a continuous control state to InputManager.
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

    // smoothing per axis
    this.fRoll  = new OneEuro(1.2, 0.012, 1.0);
    this.fPitch = new OneEuro(1.2, 0.012, 1.0);
    this.fYaw   = new OneEuro(1.2, 0.012, 1.0);
    this.fFist  = new OneEuro(0.8, 0.005, 1.0);
    this.fOpen  = new OneEuro(0.8, 0.005, 1.0);

    this.calib = { rollOffset: 0, pitchOffset: 0, yawOffset: 0, locked: false, samples: 0 };
  }

  setStatus(s, kind = 'info') {
    if (this.statusEl) this.statusEl.textContent = s;
    this.preview.classList.toggle('tracking', kind === 'ok');
    this.preview.classList.toggle('lost',     kind === 'lost' || kind === 'warn');
  }

  async start() {
    if (this.running) return;
    this.preview.classList.remove('hidden');
    this.setStatus('カメラ準備中…');

    // 1) load mediapipe (tasks-vision)
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

    // 2) request camera
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width:  { ideal: 640 },
          height: { ideal: 480 },
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

    // size canvas
    const resize = () => {
      this.canvas.width  = this.preview.clientWidth;
      this.canvas.height = this.preview.clientHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    this.setStatus('手を画面の真ん中にかざしてください');
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
      try {
        res = this.landmarker.detectForVideo(v, t);
      } catch (e) { /* ignore */ }
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
      this.setStatus('手が見えません — カメラに手を向けて', 'lost');
      this.input.feedHand({ present: false, time });
      return;
    }

    const lm = res.landmarks[0]; // 21 points, normalized 0..1
    // Key landmarks
    const wrist = lm[0];
    const thumb = lm[4];
    const indexT = lm[8];
    const middleT = lm[12];
    const ringT = lm[16];
    const pinkyT = lm[20];
    const indexB = lm[5];
    const pinkyB = lm[17];
    const middleB = lm[9];

    // ==== ROLL: angle of the line indexBase -> pinkyBase ====
    const rollRaw = Math.atan2(pinkyB.y - indexB.y, pinkyB.x - indexB.x);
    // when palm faces camera, this is roughly 0; tilting hand changes it.
    let roll = (rollRaw / (Math.PI * 0.5)); // normalize ~ -1..1

    // ==== PITCH: y position of wrist relative to palm center ====
    // pitch = palm height in frame (lower = pull up)
    const palmY = (indexB.y + pinkyB.y + wrist.y) / 3;
    let pitch = (palmY - 0.5) * 2.0;     // -1 (top) .. 1 (bottom)

    // ==== YAW: x position of palm center ====
    const palmX = (indexB.x + pinkyB.x + wrist.x) / 3;
    let yaw = (palmX - 0.5) * 2.0;

    // ==== FIST / OPENNESS: average finger-tip distance from palm ====
    const palmCx = palmX;
    const palmCy = palmY;
    const palmSize = Math.hypot(indexB.x - pinkyB.x, indexB.y - pinkyB.y) + 1e-6;
    const tips = [indexT, middleT, ringT, pinkyT];
    let dSum = 0;
    for (const t of tips) {
      dSum += Math.hypot(t.x - palmCx, t.y - palmCy);
    }
    const meanDist = (dSum / tips.length) / palmSize; // ~0.6 = closed fist, ~1.6 = wide open
    // map closeness:
    const fistness = clamp(1 - (meanDist - 0.6) / 0.7, 0, 1);   // 1 = closed fist
    const openness = clamp((meanDist - 0.9) / 0.7, 0, 1);        // 1 = wide open

    // ==== Auto-calibration (first ~30 stable frames -> capture origin) ====
    if (!this.calib.locked) {
      this.calib.rollOffset  = lerp(this.calib.rollOffset,  roll,  0.06);
      this.calib.pitchOffset = lerp(this.calib.pitchOffset, pitch, 0.06);
      this.calib.yawOffset   = lerp(this.calib.yawOffset,   yaw,   0.06);
      this.calib.samples++;
      if (this.calib.samples > 28) this.calib.locked = true;
    }
    roll  -= this.calib.rollOffset;
    pitch -= this.calib.pitchOffset;
    yaw   -= this.calib.yawOffset;

    // smooth
    const tSec = time / 1000;
    roll  = this.fRoll.filter(roll, tSec);
    pitch = this.fPitch.filter(pitch, tSec);
    yaw   = this.fYaw.filter(yaw, tSec);
    const fistS = this.fFist.filter(fistness, tSec);
    const openS = this.fOpen.filter(openness, tSec);

    // dead-zone for tiny jitter
    const dz = (v, z) => Math.abs(v) < z ? 0 : Math.sign(v) * (Math.abs(v) - z) / (1 - z);
    roll  = dz(roll, 0.08);
    pitch = dz(pitch, 0.10);
    yaw   = dz(yaw, 0.10);

    // status
    this.setStatus(
      fistS > 0.7 ? 'BOOST!' :
      openS > 0.6 ? 'BRAKE'  :
      'OK — 手で操縦中',
      'ok'
    );

    // emit
    this.input.feedHand({
      present: true, time,
      roll: clamp(roll, -1.5, 1.5),
      pitch: clamp(pitch, -1.5, 1.5),
      yaw: clamp(yaw, -1.5, 1.5),
      fistness: fistS,
      openness: openS
    });

    // ==== draw skeleton on preview canvas ====
    this._draw(lm, fistS, openS);
  }

  _draw(lm, fist, open) {
    const w = this.canvas.width, h = this.canvas.height;
    const ctx = this.ctx;
    // mirror coords (selfie)
    const X = x => (1 - x) * w;
    const Y = y => y * h;

    const conns = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [5,9],[9,10],[10,11],[11,12],
      [9,13],[13,14],[14,15],[15,16],
      [13,17],[17,18],[18,19],[19,20],
      [0,17]
    ];

    ctx.lineWidth = 2.4;
    ctx.strokeStyle = fist > 0.7
      ? 'rgba(255,110,199,0.95)'
      : open > 0.7
        ? 'rgba(125,249,255,0.95)'
        : 'rgba(179,136,255,0.85)';
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 8;
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
  }
}
