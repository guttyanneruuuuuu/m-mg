// ===========================================================
// audio.js — procedural audio engine using WebAudio
// (No external audio files needed — keeps load instant)
// ===========================================================

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.musicNodes = [];
    this.musicPlaying = false;
    this.unlocked = false;
    this.bgmVol = 0.5;
    this.sfxVol = 0.7;
  }

  async ensure() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 1.0;
    this.master.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = this.bgmVol;
    this.musicGain.connect(this.master);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = this.sfxVol;
    this.sfxGain.connect(this.master);
  }

  async unlock() {
    await this.ensure();
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch {}
    }
    this.unlocked = true;
  }

  setBgm(v) { this.bgmVol = v; if (this.musicGain) this.musicGain.gain.value = v; }
  setSfx(v) { this.sfxVol = v; if (this.sfxGain) this.sfxGain.gain.value = v; }

  // ----------------------- SFX -----------------------
  blip(freq = 880, dur = 0.15, type = 'sine', vol = 0.3) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfxGain);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  pickup() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(880, t);
    o.frequency.exponentialRampToValueAtTime(1760, t + 0.18);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.32, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g).connect(this.sfxGain);
    o.start(t); o.stop(t + 0.25);
  }

  ringPass() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [0, 0.06].forEach((d, i) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(440 * (i + 1), t + d);
      o.frequency.exponentialRampToValueAtTime(1320 * (i + 1), t + d + 0.18);
      g.gain.setValueAtTime(0, t + d);
      g.gain.linearRampToValueAtTime(0.18, t + d + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.25);
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 2400;
      o.connect(f).connect(g).connect(this.sfxGain);
      o.start(t + d); o.stop(t + d + 0.3);
    });
  }

  hit() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // noise burst
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.4, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1200, t);
    f.frequency.exponentialRampToValueAtTime(120, t + 0.4);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.6, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    src.connect(f).connect(g).connect(this.sfxGain);
    src.start(t);
    // tonal thud
    const o = this.ctx.createOscillator();
    const og = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.3);
    og.gain.setValueAtTime(0.5, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(og).connect(this.sfxGain);
    o.start(t); o.stop(t + 0.35);
  }

  boostStart() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(880, t + 0.4);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 800; f.Q.value = 6;
    o.connect(f).connect(g).connect(this.sfxGain);
    o.start(t); o.stop(t + 0.5);
  }

  gameover() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [880, 660, 440, 330].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(f, t + i * 0.12);
      g.gain.setValueAtTime(0, t + i * 0.12);
      g.gain.linearRampToValueAtTime(0.22, t + i * 0.12 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.3);
      o.connect(g).connect(this.sfxGain);
      o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.32);
    });
  }

  combo(level = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const base = 660 + level * 80;
    [0, 0.05, 0.1].forEach((d, i) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(base * (1 + i * 0.25), t + d);
      g.gain.setValueAtTime(0, t + d);
      g.gain.linearRampToValueAtTime(0.1, t + d + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.12);
      o.connect(g).connect(this.sfxGain);
      o.start(t + d); o.stop(t + d + 0.15);
    });
  }

  // ----------------------- MUSIC -----------------------
  // Procedural ambient/synthwave loop. Arpeggio on a pad.
  startMusic() {
    if (!this.ctx || this.musicPlaying) return;
    this.musicPlaying = true;
    const ctx = this.ctx;

    // Pad: two detuned saws through a slow lowpass sweep, with reverb-ish delay
    const padGain = ctx.createGain();
    padGain.gain.value = 0.18;

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 600;
    filt.Q.value = 2;

    const delay = ctx.createDelay();
    delay.delayTime.value = 0.42;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    delay.connect(fb).connect(delay);
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    delay.connect(wet);

    padGain.connect(filt);
    filt.connect(this.musicGain);
    filt.connect(delay);
    wet.connect(this.musicGain);

    const baseFreqs = [
      [220, 277.18, 329.63], // A minor
      [196, 246.94, 293.66], // G
      [174.61, 220, 261.63], // F
      [246.94, 311.13, 369.99] // B dim-ish
    ];

    const oscs = [];
    for (let i = 0; i < 6; i++) {
      const o = ctx.createOscillator();
      o.type = i % 2 ? 'sawtooth' : 'triangle';
      o.frequency.value = 220;
      o.detune.value = (i % 2 ? 7 : -7) * (1 + (i >> 1));
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g).connect(padGain);
      o.start();
      oscs.push({ o, g });
    }

    let chordIdx = 0;
    const t0 = ctx.currentTime;

    const tick = () => {
      if (!this.musicPlaying) return;
      const now = ctx.currentTime;
      const chord = baseFreqs[chordIdx % baseFreqs.length];
      for (let i = 0; i < oscs.length; i++) {
        const f = chord[i % chord.length] * (i < 3 ? 1 : 2);
        oscs[i].o.frequency.setTargetAtTime(f, now, 0.4);
        oscs[i].g.gain.setTargetAtTime(0.5 / oscs.length, now, 0.6);
      }
      // gentle filter sweep
      filt.frequency.setTargetAtTime(500 + Math.sin((now - t0) * 0.3) * 350, now, 0.5);
      chordIdx++;
    };
    tick();
    this._musicInterval = setInterval(tick, 4000);

    // arp lead
    const arpGain = ctx.createGain();
    arpGain.gain.value = 0.07;
    arpGain.connect(this.musicGain);
    arpGain.connect(delay);

    const arpO = ctx.createOscillator();
    arpO.type = 'square';
    const arpG = ctx.createGain();
    arpG.gain.value = 0;
    arpO.connect(arpG).connect(arpGain);
    arpO.start();

    let step = 0;
    this._arpInterval = setInterval(() => {
      if (!this.musicPlaying) return;
      const now = ctx.currentTime;
      const chord = baseFreqs[chordIdx % baseFreqs.length];
      const note = chord[step % chord.length] * 2;
      arpO.frequency.setValueAtTime(note, now);
      arpG.gain.cancelScheduledValues(now);
      arpG.gain.setValueAtTime(0.0001, now);
      arpG.gain.exponentialRampToValueAtTime(0.6, now + 0.01);
      arpG.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
      step++;
    }, 240);

    this.musicNodes = [padGain, filt, delay, fb, wet, arpGain, arpO, arpG, ...oscs.map(x => x.o)];
  }

  stopMusic() {
    this.musicPlaying = false;
    clearInterval(this._musicInterval);
    clearInterval(this._arpInterval);
    try { this.musicNodes.forEach(n => { try { n.stop && n.stop(); } catch {} try { n.disconnect && n.disconnect(); } catch {} }); } catch {}
    this.musicNodes = [];
  }
}
