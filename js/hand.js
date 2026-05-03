// ===========================================================
// hand.js — STARFORGE: MediaPipe Hands tracking
//   - Continues to provide roll/pitch/yaw + fistness/openness
//   - Adds: pinchDist, pointing, thumbsUp for fire-gesture detection
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

    this.fRoll  = new OneEuro(1.4, 0.018, 1.0);
    this.fPitch = new OneEuro(1.4, 0.018, 1.0);
    this.fYaw   = new OneEuro(1.4, 0.018, 1.0);
    this.fFist  = new OneEuro(0.9, 0.006, 1.0);
    this.fOpen  = new OneEuro(0.9, 0.006, 1.0);
    this.fPinch = new OneEuro(1.0, 0.008, 1.0);
    this.fPoint = new OneEuro(0.9, 0.006, 1.0);
    this.fThumb = new OneEuro(0.9, 0.006, 1.0);

    this.calib = { rollOffset: 0, pitchOffset: 0, yawOffset: 0, locked: false, samples: 0, stillFrames: 0, lastRaw: null };

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

    const lm = res.landmarks[0];
    const wrist  = lm[0];
    const thumbT = lm[4];
    const thumbIP = lm[3];
    const indexT = lm[8];
    const indexB = lm[5];
    const indexPIP = lm[6];
    const midT   = lm[12];
    const midB   = lm[9];
    const midPIP = lm[10];
    const ringT  = lm[16];
    const ringB  = lm[13];
    const ringPIP = lm[14];
    const pinkyT = lm[20];
    const pinkyB = lm[17];
    const pinkyPIP = lm[18];

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

    // ROLL
    const rollRaw = Math.atan2(pinkyB.y - indexB.y, pinkyB.x - indexB.x);
    let roll = rollRaw / (Math.PI * 0.5);
    let pitch = (cy - 0.5) * 2.0;
    let yaw = (cx - 0.5) * 2.0;

    // Palm size for normalisation
    const palmSize = Math.hypot(indexB.x - pinkyB.x, indexB.y - pinkyB.y) + 1e-6;

    // FIST / OPEN
    const tips = [indexT, midT, ringT, pinkyT];
    let dSum = 0;
    for (const t of tips) dSum += Math.hypot(t.x - cx, t.y - cy);
    const meanDist = (dSum / tips.length) / palmSize;
    const fistness = clamp(1 - (meanDist - 0.55) / 0.7, 0, 1);
    const openness = clamp((meanDist - 0.95) / 0.65, 0, 1);

    // PINCH (thumb tip to index tip)
    const pinchDist = Math.hypot(thumbT.x - indexT.x, thumbT.y - indexT.y) / palmSize;

    // POINTING (index extended, others curled)
    const indexExt = Math.hypot(indexT.x - indexB.x, indexT.y - indexB.y) / palmSize;
    const midExt   = Math.hypot(midT.x - midB.x,     midT.y - midB.y) / palmSize;
    const ringExt  = Math.hypot(ringT.x - ringB.x,   ringT.y - ringB.y) / palmSize;
    const pinkyExt = Math.hypot(pinkyT.x - pinkyB.x, pinkyT.y - pinkyB.y) / palmSize;
    // pointing if index well-extended AND others curled
    let pointing = 0;
    if (indexExt > 1.05 && midExt < 0.75 && ringExt < 0.75 && pinkyExt < 0.75) pointing = 1;
    pointing = clamp(pointing, 0, 1);

    // THUMBS UP (thumb extended upward, fingers curled)
    const thumbExt = Math.hypot(thumbT.x - wrist.x, thumbT.y - wrist.y) / palmSize;
    const thumbUp = thumbT.y < indexB.y - 0.05;     // thumb tip above index base
    let thumbsUp = 0;
    if (thumbUp && thumbExt > 1.0 && indexExt < 0.75 && midExt < 0.75 && ringExt < 0.75 && pinkyExt < 0.75) thumbsUp = 1;

    // CALIBRATION
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
      this.calib.rollOffset  = lerp(this.calib.rollOffset,  roll,  0.10);
      this.calib.pitchOffset = lerp(this.calib.pitchOffset, pitch, 0.10);
      this.calib.yawOffset   = lerp(this.calib.yawOffset,   yaw,   0.10);
      this.calib.samples++;
      if (this.calib.samples > 20 && this.calib.stillFrames > 12) this.calib.locked = true;
    } else if (this.calib.stillFrames > 90) {
      this.calib.rollOffset  = lerp(this.calib.rollOffset,  roll,  0.04);
      this.calib.pitchOffset = lerp(this.calib.pitchOffset, pitch, 0.04);
      this.calib.yawOffset   = lerp(this.calib.yawOffset,   yaw,   0.04);
    }

    roll  -= this.calib.rollOffset;
    pitch -= this.calib.pitchOffset;
    yaw   -= this.calib.yawOffset;

    const tSec = time / 1000;
    roll  = this.fRoll.filter(roll, tSec);
    pitch = this.fPitch.filter(pitch, tSec);
    yaw   = this.fYaw.filter(yaw, tSec);
    const fistS = this.fFist.filter(fistness, tSec);
    const openS = this.fOpen.filter(openness, tSec);
    const pinchS = this.fPinch.filter(pinchDist, tSec);
    const pointS = this.fPoint.filter(pointing, tSec);
    const thumbS = this.fThumb.filter(thumbsUp, tSec);

    const dz = (v, z) => Math.abs(v) < z ? 0 : Math.sign(v) * (Math.abs(v) - z) / (1 - z);
    roll  = dz(roll, 0.07);
    pitch = dz(pitch, 0.09);
    yaw   = dz(yaw, 0.09);

    // status: reflect detected fire gesture
    let label = '✓ TRACKING';
    if (!this.calib.locked) label = 'キャリブレ中… 手を真っ直ぐ';
    else {
      const fg = this.input.fireGesture;
      if (fg === 'pinch'    && pinchS < 0.45)  label = '🤏 FIRE';
      else if (fg === 'point'    && pointS > 0.6) label = '☝️ FIRE';
      else if (fg === 'thumbsup' && thumbS > 0.6) label = '👍 FIRE';
      else if (fg === 'fistHold' && fistS > 0.7) label = '✊ FIRE';
      else if (fistS > 0.7)  label = '✊ BOOST';
      else if (openS > 0.6)  label = '🖐️ BRAKE';
    }
    this.setStatus(label, this.calib.locked ? 'ok' : 'calibrating');

    this.input.feedHand({
      present: true, time,
      roll: clamp(roll, -1.5, 1.5),
      pitch: clamp(pitch, -1.5, 1.5),
      yaw: clamp(yaw, -1.5, 1.5),
      fistness: fistS,
      openness: openS,
      pinchDist: pinchS,
      pointing: pointS,
      thumbsUp: thumbS,
      confidence: this.confidence
    });

    let tone = 'rgba(179,136,255,0.92)';
    const fg = this.input.fireGesture;
    const isFiring =
      (fg === 'pinch' && pinchS < 0.45) ||
      (fg === 'point' && pointS > 0.6) ||
      (fg === 'thumbsup' && thumbS > 0.6) ||
      (fg === 'fistHold' && fistS > 0.7);
    if (isFiring) tone = 'rgba(255,180,90,0.95)';
    else if (fistS > 0.7) tone = 'rgba(255,110,199,0.95)';
    else if (openS > 0.6) tone = 'rgba(125,249,255,0.95)';
    this._drawSkeleton(lm, fistS, openS, tone);
    this._drawGuide(true);
  }

  _drawGuide(ok, warn = false) {
    const w = this.canvas.width, h = this.canvas.height;
    const ctx = this.ctx;
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
