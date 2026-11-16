// Quiet synthesized sounds (Web Audio). No assets to download.

export class Sound {
  constructor() {
    this.ctx = null;
    this.volume = 0.5;
    this.muted = false;
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.master.gain.value = this.muted ? 0 : this.volume * 0.35;
    return this.ctx;
  }

  tone(freq, { at = 0, dur = 0.12, type = 'sine', gain = 0.5, slide = 0 } = {}) {
    const ctx = this.ensure();
    if (!ctx || this.muted || this.volume <= 0) return;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  // Pentatonic so overlapping sounds never clash.
  static NOTES = [261.6, 293.7, 329.6, 392.0, 440.0, 523.3, 587.3, 659.3, 784.0, 880.0];

  lock(hard) { this.tone(hard ? 110 : 140, { dur: 0.09, type: 'triangle', gain: hard ? 0.5 : 0.3, slide: 0.6 }); }
  move() { this.tone(900, { dur: 0.02, type: 'sine', gain: 0.05 }); }
  rotate() { this.tone(1200, { dur: 0.03, type: 'sine', gain: 0.06 }); }
  hold() { this.tone(500, { dur: 0.08, type: 'sine', gain: 0.15, slide: 1.5 }); }
  clear(lines, combo) {
    const base = Math.max(0, combo) % 5;
    for (let i = 0; i < lines; i++) this.tone(Sound.NOTES[base + i], { at: i * 0.06, dur: 0.35, type: 'sine', gain: 0.25 });
  }
  levelUp() { [0, 2, 4, 7].forEach((n, i) => this.tone(Sound.NOTES[n] * 2, { at: i * 0.09, dur: 0.6, gain: 0.18 })); }
  gameOver() { [4, 3, 1, 0].forEach((n, i) => this.tone(Sound.NOTES[n], { at: i * 0.15, dur: 0.5, type: 'triangle', gain: 0.2 })); }
}
