// Lightweight synthesized sound effects via the Web Audio API — no asset files,
// no downloads. Muteable; the preference is persisted.

let ctx = null;
function getCtx() {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) ctx = new AC();
  }
  // Browsers start the context suspended until a user gesture.
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

let muted = (() => {
  try {
    return localStorage.getItem('coinludo-muted') === '1';
  } catch {
    return false;
  }
})();

export function isMuted() {
  return muted;
}

export function toggleMuted() {
  muted = !muted;
  try {
    localStorage.setItem('coinludo-muted', muted ? '1' : '0');
  } catch {
    /* ignore */
  }
  return muted;
}

function tone(freq, start, dur, type = 'sine', gain = 0.14) {
  const ac = getCtx();
  if (!ac) return;
  const t0 = ac.currentTime + start;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

function noise(start, dur, gain = 0.1) {
  const ac = getCtx();
  if (!ac) return;
  const t0 = ac.currentTime + start;
  const buffer = ac.createBuffer(1, Math.max(1, Math.floor(ac.sampleRate * dur)), ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const g = ac.createGain();
  g.gain.setValueAtTime(gain, t0);
  src.connect(g).connect(ac.destination);
  src.start(t0);
}

export const sfx = {
  roll() {
    if (muted) return;
    noise(0, 0.18, 0.08);
    tone(200, 0.04, 0.12, 'square', 0.05);
  },
  move() {
    if (muted) return;
    tone(440, 0, 0.08, 'triangle', 0.08);
  },
  capture() {
    if (muted) return;
    tone(300, 0, 0.1, 'sawtooth', 0.11);
    tone(170, 0.08, 0.16, 'sawtooth', 0.09);
  },
  home() {
    if (muted) return;
    tone(523, 0, 0.1, 'sine', 0.12);
    tone(784, 0.1, 0.15, 'sine', 0.12);
  },
  yourTurn() {
    if (muted) return;
    tone(660, 0, 0.09, 'sine', 0.07);
  },
  win() {
    if (muted) return;
    [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.18, 'sine', 0.12));
  },
  lose() {
    if (muted) return;
    [440, 349, 262].forEach((f, i) => tone(f, i * 0.14, 0.22, 'triangle', 0.09));
  },
};
