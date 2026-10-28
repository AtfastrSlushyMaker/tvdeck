/*
 * Line icons (24x24, 1.5 stroke) for tiles that have no app artwork,
 * plus a small color sampler used for tile backgrounds and the backdrop wash.
 */
var Icons = (function () {
  'use strict';

  var PATHS = {
    input: '<rect x="3" y="7" width="18" height="7" rx="1"/><path d="M6 14v2.5h12V14"/><path d="M7 10.5h10"/>',
    tv: '<rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 17v3"/>',
    module: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
    web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z"/>',
    phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
    settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    app: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'
  };

  function svg(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (PATHS[name] || PATHS.app) + '</svg>';
  }

  function glyphFor(item) {
    if (item.kind === 'key') return item.ref.key === 'KEY_TV' ? 'tv' : 'input';
    if (item.kind === 'mod') return 'module';
    if (item.kind === 'web') return 'web';
    if (item.kind === 'tool') return item.ref;
    return 'app';
  }

  var canvas = document.createElement('canvas');
  var SAMPLE_SIZE = 32;
  canvas.width = canvas.height = SAMPLE_SIZE;
  var ctx = canvas.getContext('2d');

  // A square TV icon can fill a wide tile if the top and bottom that would
  // be cropped contain only background. Keep a small safety margin around
  // any visible artwork; when in doubt, show the entire image instead.
  function canCropBackground(img, pixels) {
    var width = img.naturalWidth;
    var height = img.naturalHeight;
    var tileAspect = 15.9 / 9.55;
    if (!width || !height || width / height >= tileAspect) return false;
    var trim = Math.ceil((1 - (width / height) / tileAspect) * SAMPLE_SIZE / 2) + 1;
    for (var y = 0; y < SAMPLE_SIZE; y++) {
      if (y >= trim && y < SAMPLE_SIZE - trim) continue;
      var left = y * SAMPLE_SIZE * 4;
      var right = (y * SAMPLE_SIZE + SAMPLE_SIZE - 1) * 4;
      for (var x = 0; x < SAMPLE_SIZE; x++) {
        var pixel = (y * SAMPLE_SIZE + x) * 4;
        if (pixels[pixel + 3] < 200) return false;
        for (var c = 0; c < 3; c++) {
          var background = (pixels[left + c] + pixels[right + c]) / 2;
          if (Math.abs(pixels[pixel + c] - background) > 52) return false;
          if (x && Math.abs(pixels[pixel + c] - pixels[pixel - 4 + c]) > 18) return false;
        }
      }
    }
    return true;
  }

  // Average color of the opaque pixels, and whether the art is full-bleed
  // (opaque corners) or a logo on transparency. Returns null if the image
  // cannot be read (cross-origin without CORS).
  function sample(img) {
    try {
      ctx.clearRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      var px = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
      var r = 0, g = 0, b = 0, n = 0;
      for (var i = 0; i < px.length; i += 4) {
        if (px[i + 3] < 128) continue;
        r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
      }
      var cornerPixels = [0, SAMPLE_SIZE - 1, SAMPLE_SIZE * (SAMPLE_SIZE - 1), SAMPLE_SIZE * SAMPLE_SIZE - 1];
      var corners = cornerPixels.every(function (p) { return px[p * 4 + 3] > 200; });
      if (!n) return null;
      var sample = { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), fullBleed: corners };
      if (corners) {
        sample.cropSafe = canCropBackground(img, px);
        sample.edgeStops = [];
        for (var step = 0; step < 8; step++) {
          var y = Math.round(step * (SAMPLE_SIZE - 1) / 7);
          sample.edgeStops.push([0, 1, 2].map(function (channel) {
            return Math.round((px[(y * SAMPLE_SIZE) * 4 + channel] + px[(y * SAMPLE_SIZE + SAMPLE_SIZE - 1) * 4 + channel]) / 2);
          }));
        }
      }
      return sample;
    } catch (e) {
      return null;
    }
  }

  // A logo's average color, darkened so white marks stay readable on it.
  function tileBackground(color) {
    var k = 0.55;
    return 'rgb(' + Math.round(color.r * k) + ',' + Math.round(color.g * k) + ',' + Math.round(color.b * k) + ')';
  }

  // Rotates a color's hue and scales its lightness, for a second wash tone.
  function shiftHue(color, degrees, lightness) {
    var r = color.r / 255, g = color.g / 255, b = color.b / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    h = (h + degrees) % 360;
    l = Math.min(1, l * lightness);
    return 'hsl(' + Math.round(h) + ',' + Math.round(s * 100) + '%,' + Math.round(l * 100) + '%)';
  }

  return { svg: svg, glyphFor: glyphFor, sample: sample, tileBackground: tileBackground, shiftHue: shiftHue };
})();
