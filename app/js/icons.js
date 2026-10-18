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
  canvas.width = canvas.height = 8;
  var ctx = canvas.getContext('2d');

  // Average color of the opaque pixels, and whether the art is full-bleed
  // (opaque corners) or a logo on transparency. Returns null if the image
  // cannot be read (cross-origin without CORS).
  function sample(img) {
    try {
      ctx.clearRect(0, 0, 8, 8);
      ctx.drawImage(img, 0, 0, 8, 8);
      var px = ctx.getImageData(0, 0, 8, 8).data;
      var r = 0, g = 0, b = 0, n = 0;
      for (var i = 0; i < px.length; i += 4) {
        if (px[i + 3] < 128) continue;
        r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
      }
      var corners = [0, 7, 56, 63].every(function (p) { return px[p * 4 + 3] > 200; });
      if (!n) return null;
      return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), fullBleed: corners };
    } catch (e) {
      return null;
    }
  }

  // A logo's average color, darkened so white marks stay readable on it.
  function tileBackground(color) {
    var k = 0.55;
    return 'rgb(' + Math.round(color.r * k) + ',' + Math.round(color.g * k) + ',' + Math.round(color.b * k) + ')';
  }

  return { svg: svg, glyphFor: glyphFor, sample: sample, tileBackground: tileBackground };
})();
