/*
 * UI sounds, synthesized with Web Audio (no audio files).
 *
 * Instead of plain beeps, each sound "strikes" tuned resonators (high-Q
 * band-pass filters excited by a tiny impulse), so it rings like glass or
 * wood, then passes through a gentle low-pass and a short room tail.
 *
 * Styles: glass (default), wood, soft. On by default; Settings can turn
 * sounds off or change the style.
 */
var Sounds = (function () {
  'use strict';

  // Each voice: modes [frequency Hz, Q, level], optional low body
  // [start Hz, end Hz, level, seconds], and an overall gain.
  var STYLES = {
    glass: {
      move: { modes: [[2650, 34, 1], [5300, 40, 0.35]], gain: 1 },
      select: { modes: [[1320, 26, 1], [2640, 30, 0.45], [3960, 34, 0.2]], body: [240, 150, 0.5, 0.09], gain: 1 },
      edge: { modes: [[760, 14, 1]], gain: 1 },
      back: { modes: [[1980, 30, 1], [3960, 36, 0.3]], gain: 1 }
    },
    wood: {
      move: { modes: [[1560, 13, 1], [3400, 16, 0.4]], gain: 1 },
      select: { modes: [[540, 9, 1], [1220, 12, 0.55], [2600, 14, 0.2]], body: [180, 110, 0.4, 0.08], gain: 1 },
      edge: { modes: [[320, 7, 1]], gain: 1 },
      back: { modes: [[980, 11, 1], [2100, 13, 0.35]], gain: 1 }
    },
    soft: {
      move: { modes: [[1650, 6, 1]], gain: 1 },
      select: { modes: [[880, 5, 1]], body: [230, 160, 0.6, 0.09], gain: 1 },
      edge: { modes: [[260, 4, 1]], gain: 1 },
      back: { modes: [[520, 5, 1]], gain: 1 }
    }
  };

  // Target peak per voice. calibrate() measures each voice offline so every
  // style plays at these levels, whatever its filters do to the energy.
  var LEVEL = { move: 0.11, select: 0.2, edge: 0.13, back: 0.12 };
  var NORMALIZE = {};

  var ctx = null;
  var master = null;
  var enabled = false;
  var style = 'glass';

  // Shared output chain: low-pass (takes the edge off) + short room tail.
  function chain(ac) {
    var input = ac.createGain();
    var tone = ac.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 7000;
    var room = ac.createConvolver();
    room.buffer = roomImpulse(ac, 0.35);
    var wet = ac.createGain();
    wet.gain.value = 0.14;
    input.connect(tone);
    tone.connect(ac.destination);
    tone.connect(room);
    room.connect(wet);
    wet.connect(ac.destination);
    return input;
  }

  // Exponentially decaying stereo noise: a small, soft room.
  function roomImpulse(ac, seconds) {
    var length = Math.floor(ac.sampleRate * seconds);
    var buffer = ac.createBuffer(2, length, ac.sampleRate);
    for (var ch = 0; ch < 2; ch++) {
      var data = buffer.getChannelData(ch);
      for (var i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 4);
    }
    return buffer;
  }

  // A 2 ms click with a fast decay: the "strike" that excites the modes.
  function impulse(ac) {
    var length = Math.max(2, Math.floor(ac.sampleRate * 0.002));
    var buffer = ac.createBuffer(1, length, ac.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2);
    return buffer;
  }

  function strike(ac, out, voice, gain, at) {
    var t = at || ac.currentTime;
    var hit = ac.createBufferSource();
    hit.buffer = impulse(ac);
    voice.modes.forEach(function (mode) {
      var filter = ac.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = mode[0];
      filter.Q.value = mode[1];
      var level = ac.createGain();
      level.gain.value = mode[2] * gain * voice.gain;
      hit.connect(filter);
      filter.connect(level);
      level.connect(out);
    });
    hit.start(t);

    if (voice.body) {
      var b = voice.body;
      var osc = ac.createOscillator();
      var amp = ac.createGain();
      var peak = Math.max(0.0002, b[2] * gain * (voice.bodyScale || 1));
      osc.type = 'sine';
      osc.frequency.setValueAtTime(b[0], t);
      osc.frequency.exponentialRampToValueAtTime(b[1], t + b[3]);
      amp.gain.setValueAtTime(0.0001, t);
      amp.gain.exponentialRampToValueAtTime(peak, t + 0.004);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + b[3]);
      osc.connect(amp);
      amp.connect(out);
      osc.start(t);
      osc.stop(t + b[3] + 0.02);
    }
  }

  function context() {
    if (!ctx) {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      ctx = new AudioCtx();
      master = chain(ctx);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  var last = 0;

  function play(kind) {
    if (!enabled) return;
    // Key repeat can fire faster than a tick should sound.
    var now = Date.now();
    if (kind === 'move' && now - last < 55) return;
    last = now;
    var ac = context();
    var voice = STYLES[style][kind];
    if (!ac || !voice) return;
    var norm = (NORMALIZE[style] && NORMALIZE[style][kind]) || 1;
    strike(ac, master, voice, LEVEL[kind] * norm);
  }

  // Renders the resonant part of every voice offline and stores a factor that
  // brings its peak to 1, so LEVEL alone sets loudness. Runs once at startup.
  function calibrate() {
    var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return;
    Object.keys(STYLES).forEach(function (name) {
      NORMALIZE[name] = {};
      Object.keys(STYLES[name]).forEach(function (kind) {
        var voice = STYLES[name][kind];
        var resonant = { modes: voice.modes, gain: voice.gain };
        var off = new Offline(1, 8820, 22050);
        strike(off, off.destination, resonant, 1, 0);
        var done = function (buffer) {
          var data = buffer.getChannelData(0);
          var peak = 0;
          for (var i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
          var factor = peak > 0 ? 1 / peak : 1;
          NORMALIZE[name][kind] = factor;
          // The body is a plain sine: undo the factor so it stays at its own level.
          voice.bodyScale = 1 / factor;
        };
        var result = off.startRendering();
        if (result && result.then) result.then(done);
        else off.oncomplete = function (e) { done(e.renderedBuffer); };
      });
    });
  }

  function setEnabled(on) {
    enabled = !!on;
    if (enabled) context();
  }

  function setStyle(name) {
    if (STYLES[name]) style = name;
  }

  calibrate();

  return { play: play, setEnabled: setEnabled, setStyle: setStyle, styles: Object.keys(STYLES), normalize: NORMALIZE };
})();
