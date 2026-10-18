/*
 * Optional UI sounds, synthesized with Web Audio (no audio files):
 * a soft tick when focus moves, a rounder click on select, a muted thud at
 * an edge. Off unless enabled in Settings.
 */
var Sounds = (function () {
  'use strict';

  var ctx = null;
  var enabled = false;

  function context() {
    if (!ctx) {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      ctx = new AudioCtx();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // One short tone with a fast attack and exponential decay.
  function tone(freq, duration, gain, type, delay) {
    var ac = context();
    if (!ac) return;
    var t = ac.currentTime + (delay || 0);
    var osc = ac.createOscillator();
    var amp = ac.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.82, t + duration);
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(amp);
    amp.connect(ac.destination);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  var last = 0;

  function play(kind) {
    if (!enabled) return;
    // Key repeat can fire faster than a tick should sound.
    var now = Date.now();
    if (kind === 'move' && now - last < 55) return;
    last = now;
    if (kind === 'move') tone(1650, 0.035, 0.025, 'sine');
    else if (kind === 'select') { tone(660, 0.09, 0.05, 'sine'); tone(990, 0.07, 0.025, 'sine', 0.012); }
    else if (kind === 'edge') tone(240, 0.07, 0.04, 'triangle');
    else if (kind === 'back') tone(520, 0.06, 0.035, 'sine');
  }

  function setEnabled(on) {
    enabled = !!on;
    if (enabled) context();
  }

  return { play: play, setEnabled: setEnabled };
})();
