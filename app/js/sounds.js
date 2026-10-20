/*
 * UI sounds, synthesized with Web Audio (no audio files).
 *
 * Instead of plain beeps, each sound "strikes" tuned resonators (high-Q
 * band-pass filters excited by a tiny impulse), so it rings like glass or
 * wood, then passes through a gentle low-pass and a short room tail.
 *
 * Styles: soft (default), glass, wood. On by default; Settings can turn
 * sounds off or change the style.
 */
var Sounds = (function () {
  'use strict';

  // A voice is one tap: modes [frequency Hz, Q, level], an optional low body
  // [start Hz, end Hz, level, seconds], and a gain. A voice can instead be a
  // sequence of taps: { sequence: [[voice, delay seconds], ...] }.

  // Glass taps. Enter and Back reuse the move tap so they sound related.
  var GLASS_TAP = { modes: [[1400, 24, 1], [2800, 30, 0.35]], body: [420, 300, 0.35, 0.05], gain: 1 };
  var GLASS_LOW = { modes: [[1050, 24, 1], [2100, 30, 0.35]], body: [315, 225, 0.45, 0.06], gain: 1 };
  var GLASS_LOW_SOFT = { modes: GLASS_LOW.modes, body: GLASS_LOW.body, gain: 0.75 };
  var GLASS_TAP_SOFT = { modes: GLASS_TAP.modes, body: GLASS_TAP.body, gain: 0.7 };

  var STYLES = {
    soft: {
      move: { modes: [[1650, 6, 1]], gain: 1 },
      select: { modes: [[880, 5, 1]], body: [230, 160, 0.6, 0.09], gain: 1 },
      edge: { modes: [[260, 4, 1]], gain: 1 },
      back: { modes: [[520, 5, 1]], gain: 1 }
    },
    glass: {
      move: GLASS_TAP,
      // Rising pair = confirm; falling pair = dismiss.
      select: { sequence: [[GLASS_LOW, 0], [GLASS_TAP_SOFT, 0.045]] },
      back: { sequence: [[GLASS_TAP, 0], [GLASS_LOW_SOFT, 0.045]] },
      edge: { modes: [[430, 12, 1], [860, 16, 0.3]], body: [160, 100, 0.5, 0.08], gain: 1 }
    },
    wood: {
      move: { modes: [[1560, 13, 1], [3400, 16, 0.4]], gain: 1 },
      select: { modes: [[540, 9, 1], [1220, 12, 0.55], [2600, 14, 0.2]], body: [180, 110, 0.4, 0.08], gain: 1 },
      edge: { modes: [[320, 7, 1]], gain: 1 },
      back: { modes: [[980, 11, 1], [2100, 13, 0.35]], gain: 1 }
    }
  };

  // Target peak per tap. calibrate() measures each tap offline and stores
  // tap.norm so every tap plays at these levels, whatever its filters do.
  // TV speakers need more level than headphones; peaks stay well under 1.
  var LEVEL = { move: 0.28, select: 0.3, edge: 0.24, back: 0.26 };

  var ctx = null;
  var master = null;
  var enabled = false;
  var style = 'soft';

  // Shared output chain: low-pass (takes the edge off) + short room tail.
  function chain(ac) {
    var input = ac.createGain();
    var tone = ac.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 7000;
    var room = ac.createConvolver();
    room.buffer = roomImpulse(ac, 0.45);
    var wet = ac.createGain();
    wet.gain.value = 0.17;
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
      // gain carries the tap's normalization; undo it so the plain sine body
      // keeps its own level.
      var peak = Math.max(0.0002, b[2] * gain * voice.gain / (voice.norm || 1));
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

  function taps(voice) {
    return voice.sequence || [[voice, 0]];
  }

  function play(kind) {
    if (!enabled) return;
    // Key repeat can fire faster than a tick should sound.
    var now = Date.now();
    if (kind === 'move' && now - last < 55) return;
    last = now;
    var ac = context();
    var voice = STYLES[style][kind];
    if (!ac || !voice) return;
    var t = ac.currentTime;
    taps(voice).forEach(function (tap) {
      strike(ac, master, tap[0], LEVEL[kind] * (tap[0].norm || 1), t + tap[1]);
    });
  }

  // Renders the resonant part of every tap offline and stores tap.norm, the
  // factor that brings its peak to 1, so LEVEL alone sets loudness.
  function calibrate() {
    var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return;
    var seen = [];
    Object.keys(STYLES).forEach(function (name) {
      Object.keys(STYLES[name]).forEach(function (kind) {
        taps(STYLES[name][kind]).forEach(function (tap) {
          var voice = tap[0];
          if (seen.indexOf(voice) !== -1) return;
          seen.push(voice);
          var off = new Offline(1, 8820, 22050);
          strike(off, off.destination, { modes: voice.modes, gain: voice.gain }, 1, 0);
          var done = function (buffer) {
            var data = buffer.getChannelData(0);
            var peak = 0;
            for (var i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
            // Softer variants share modes: normalize to the gain-1 peak.
            voice.norm = peak > 0 ? voice.gain / peak : 1;
          };
          var result = off.startRendering();
          if (result && result.then) result.then(done);
          else off.oncomplete = function (e) { done(e.renderedBuffer); };
        });
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

  return { play: play, setEnabled: setEnabled, setStyle: setStyle, styles: Object.keys(STYLES), voices: STYLES };
})();
