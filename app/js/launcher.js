/*
 * TVDeck launcher: rows of tiles driven by the TV remote.
 *
 * Remote keys (desktop keyboard equivalents in brackets):
 *   Arrows / Enter        move / open
 *   Back       [Esc]      close panel, cancel move
 *   Red        [R]        pin / unpin to Favorites
 *   Green      [G]        settings
 *   Yellow     [Y]        reorder (in Favorites) or hide app
 *   Blue       [B]        refresh everything
 *   CH+ / CH-  [PgUp/Dn]  jump between rows
 */
(function () {
  'use strict';

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
    BACK: 10009, ESC: 27,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    CH_UP: 427, CH_DOWN: 428, PG_UP: 33, PG_DOWN: 34,
    IME_DONE: 65376, IME_CANCEL: 65385
  };
  var DESKTOP_ALIASES = { 82: KEY.RED, 71: KEY.GREEN, 89: KEY.YELLOW, 66: KEY.BLUE, 27: KEY.BACK, 33: KEY.CH_UP, 34: KEY.CH_DOWN };

  var MAX_RECENT = 10;
  var PINNABLE = { app: true, mod: true, web: true, key: true };
  var HA_ACTIONABLE = ['light', 'switch', 'fan', 'input_boolean', 'scene', 'script', 'button', 'media_player', 'cover', 'lock'];
  var DESKTOP_INPUTS = [
    { name: 'HDMI 1', key: 'KEY_HDMI1' }, { name: 'HDMI 2', key: 'KEY_HDMI2' },
    { name: 'HDMI 3', key: 'KEY_HDMI3' }, { name: 'Live TV', key: 'KEY_TV' }
  ];


  var els = {
    rows: document.getElementById('rows'),
    clock: document.getElementById('clock'),
    date: document.getElementById('date'),
    page: document.getElementById('page'),
    weather: document.getElementById('weather'),
    weatherTemp: document.getElementById('weather-temp'),
    weatherLabel: document.getElementById('weather-label'),
    hints: document.getElementById('hints'),
    toast: document.getElementById('toast'),
    settings: document.getElementById('settings'),
    settingsList: document.getElementById('settings-list'),
    overlay: document.getElementById('overlay'),
    overlayCard: document.getElementById('overlay-card'),
    ticker: document.getElementById('ticker'),
    ambient: document.getElementById('ambient'),
    ambientClock: document.getElementById('ambient-clock'),
    ambientDate: document.getElementById('ambient-date'),
    ambientLine: document.getElementById('ambient-line'),
    shelfInfo: document.querySelector('.shelf-info'),
    shelfKind: document.getElementById('shelf-kind'),
    shelfTitle: document.getElementById('shelf-title'),
    shelfMeta: document.getElementById('shelf-meta'),
    washes: document.querySelectorAll('.wash'),
    settingsGlyph: document.getElementById('settings-glyph')
  };

  var data = { apps: [], modules: [], inputs: [], calendar: null, ha: [], tizenbrew: null };
  var rows = [];            // [{ id, title, items, col, el, trackEl }]
  var rowIndex = 0;
  var scrollY = 0;
  var loaded = false;       // first app/module list received
  var moving = false;       // reordering a favorite
  var mode = 'home';        // 'home' | 'settings' | 'overlay'
  var overlay = null;       // { type: 'phone' } | { type: 'message', item }
  var messages = [];        // queued phone messages
  var settingsItems = [];
  var settingsIndex = 0;
  var toastTimer = null;
  var glanceSignature = '';
  var IDLE_MS = 2500;               // focused tile starts its idle shimmer
  var AMBIENT_MS = 5 * 60 * 1000;   // whole screen goes ambient
  if (!Platform.isTV && /[?&]ambient\b/.test(location.search)) AMBIENT_MS = 4000; // desktop preview

  /* ---------- Items ---------- */

  function catalog() {
    var items = {};
    data.apps.forEach(function (app) {
      items['app:' + app.id] = { key: 'app:' + app.id, kind: 'app', name: app.name, icon: app.icon, ref: app,
        category: Categories.categorize(app) };
    });
    data.modules.forEach(function (mod) {
      items['mod:' + mod.fullName] = { key: 'mod:' + mod.fullName, kind: 'mod', name: mod.appName || mod.name, badge: 'Module', ref: mod };
    });
    Store.get('webLinks').forEach(function (link) {
      items['web:' + link.url] = { key: 'web:' + link.url, kind: 'web', name: link.name, badge: 'Web', ref: link };
    });
    data.inputs.forEach(function (input) {
      items['key:' + input.key] = { key: 'key:' + input.key, kind: 'key', name: input.name, badge: 'Input', ref: input };
    });
    return items;
  }

  function glanceItems() {
    var list = [];
    if (data.calendar && data.calendar.configured) {
      list.push({ key: 'glance:calendar', kind: 'calendar', name: 'Calendar', events: data.calendar.events });
    }
    data.ha.forEach(function (entity) {
      var media = entity.domain === 'media_player';
      if (media && (entity.state === 'off' || entity.state === 'unavailable')) return;
      list.push({ key: 'ha:' + entity.id, kind: media ? 'media' : 'ha', name: entity.name, ref: entity });
    });
    return list;
  }

  function buildRows() {
    var items = catalog();
    var hidden = Store.get('hiddenApps');
    function lookup(keys) {
      return keys.map(function (key) { return items[key]; }).filter(Boolean);
    }

    var next = [
      { id: 'favorites', title: 'Favorites', featured: true, items: lookup(Store.get('favorites')),
        empty: 'Press RED on any tile to pin it to the dock' },
      { id: 'glance', title: 'At a glance', glance: true, items: glanceItems() },
      { id: 'recent', title: 'Recent', items: Store.get('showRecent') ? lookup(Store.get('recent')) : [] },
      { id: 'inputs', title: 'Inputs', items: data.inputs.map(function (input) { return items['key:' + input.key]; }) },
    ].concat(appRows(items, hidden), [
      { id: 'modules', title: 'TizenBrew modules', items: data.modules
          .map(function (mod) { return items['mod:' + mod.fullName]; }) },
      { id: 'web', title: 'Web', items: Store.get('webLinks')
          .map(function (link) { return items['web:' + link.url]; }) },
      { id: 'tools', title: 'TVDeck', items: [
          { key: 'tool:phone', kind: 'tool', name: 'Send from phone', ref: 'phone' },
          { key: 'tool:settings', kind: 'tool', name: 'Settings', ref: 'settings' }
        ] }
    ]).filter(function (row) { return row.items.length || row.empty; });

    // Keep each row's horizontal position across rebuilds.
    var old = {};
    rows.forEach(function (row) { old[row.id] = row; });
    next.forEach(function (row) {
      var prev = old[row.id] || {};
      row.col = Math.min(prev.col || 0, Math.max(0, row.items.length - 1));
      row.shift = prev.shift || 0;
    });

    var activeId = rows[rowIndex] ? rows[rowIndex].id : null;
    rows = next;
    rowIndex = 0;
    rows.forEach(function (row, i) { if (row.id === activeId) rowIndex = i; });
    if (!rows[rowIndex].items.length) rowIndex = firstFocusableRow(rowIndex, 1);
  }

  // One row per category, or a single "Apps" row when grouping is off.
  function appRows(items, hidden) {
    var visible = data.apps.filter(function (app) { return hidden.indexOf(app.id) === -1; });
    function toItems(apps) {
      return apps.map(function (app) { return items['app:' + app.id]; });
    }
    if (!Store.get('groupApps')) return [{ id: 'apps', title: 'Apps', apps: true, items: toItems(visible) }];
    return Categories.group(visible).map(function (group) {
      return { id: 'cat:' + group.name, title: group.name, apps: true, items: toItems(group.apps) };
    });
  }

  function firstFocusableRow(from, step) {
    for (var i = from; i >= 0 && i < rows.length; i += step) {
      if (rows[i].items.length) return i;
    }
    return rowIndex;
  }

  /* ---------- Rendering ---------- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // App art when there is an icon (caption shows on focus, like tvOS);
  // otherwise a line icon with the name inside the tile.
  function renderTile(item) {
    var tile = el('div', 'tile');
    var art = el('div', 'tile-art');
    tile.appendChild(art);

    function showGlyph() {
      tile.classList.remove('has-art');
      art.innerHTML = '<div class="tile-glyph">' + Icons.svg(Icons.glyphFor(item)) + '</div>';
      art.appendChild(el('div', 'tile-label', item.name));
    }

    var src = Platform.iconUrl(item.icon);
    if (src) {
      tile.classList.add('has-art');
      var img = el('img', 'tile-icon');
      img.alt = '';
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        var color = Icons.sample(img);
        item.img = img;
        item.color = color;
        if (color && color.fullBleed) tile.classList.add('full-bleed');
        else if (color) art.style.backgroundColor = Icons.tileBackground(color);
        if (currentItem() === item) updateShelf();
      };
      img.onerror = showGlyph;
      img.src = src;
      art.appendChild(img);
    } else {
      showGlyph();
    }

    art.appendChild(el('div', 'tile-shine'));
    tile.appendChild(el('div', 'tile-caption', item.name));
    return tile;
  }

  var DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function eventWhen(event) {
    var d = new Date(event.start);
    var today = new Date();
    var tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    var day = d.toDateString() === today.toDateString() ? 'Today'
      : d.toDateString() === tomorrow.toDateString() ? 'Tomorrow' : DAY_SHORT[d.getDay()];
    return event.allDay ? day : day + ' ' + formatTime(d);
  }

  function renderGlance(item) {
    var card = el('div', 'tile glance-card glance-' + item.kind);
    if (item.kind === 'calendar') {
      card.appendChild(el('div', 'glance-title', 'Next 7 days'));
      var list = el('div', 'glance-events');
      if (!item.events.length) list.appendChild(el('div', 'glance-dim', 'Nothing in the next 7 days'));
      item.events.slice(0, 3).forEach(function (event) {
        var line = el('div', 'glance-event');
        line.appendChild(el('span', 'glance-when', eventWhen(event)));
        line.appendChild(el('span', 'glance-what', event.title));
        list.appendChild(line);
      });
      card.appendChild(list);
    } else if (item.kind === 'media') {
      var entity = item.ref;
      card.appendChild(el('div', 'glance-title', (entity.state === 'playing' ? 'Playing · ' : 'Paused · ') + entity.name));
      card.appendChild(el('div', 'glance-big', entity.mediaTitle || entity.state));
      card.appendChild(el('div', 'glance-dim', entity.mediaArtist));
    } else {
      var e = item.ref;
      var on = e.state === 'on' || e.state === 'open' || e.state === 'unlocked';
      card.classList.toggle('is-on', on);
      card.appendChild(el('div', 'glance-title', e.name));
      card.appendChild(el('div', 'glance-big', e.state + (e.unit ? ' ' + e.unit : '')));
      if (HA_ACTIONABLE.indexOf(e.domain) !== -1) card.appendChild(el('div', 'glance-dim', 'OK to toggle'));
    }
    return card;
  }

  function render() {
    var inner = document.createDocumentFragment();

    rows.forEach(function (row, r) {
      var rowEl = el('section', 'row' + (row.featured ? ' dock' : '') + (row.glance ? ' glance' : ''));
      rowEl.style.setProperty('--r', Math.min(r, 4));
      if (!row.featured) rowEl.appendChild(el('h2', 'row-title', row.title));

      row.trackEl = null;
      if (!row.items.length) {
        rowEl.appendChild(el('div', 'row-empty', row.empty));
      } else {
        var track = el('div', 'row-track');
        row.items.forEach(function (item, i) {
          var tile = row.glance ? renderGlance(item) : renderTile(item);
          tile.style.setProperty('--i', Math.min(i, 6));
          track.appendChild(tile);
        });
        rowEl.appendChild(track);
        row.trackEl = track;
      }

      row.el = rowEl;
      inner.appendChild(rowEl);
    });

    els.rows.innerHTML = '';
    els.rows.appendChild(inner);
    els.rendered = true;
    updateFocus();
  }

  function updateFocus() {
    rows.forEach(function (row, r) {
      var active = r === rowIndex && mode === 'home';
      row.el.classList.toggle('active', active);
      if (!row.trackEl) return;
      var tiles = row.trackEl.children;
      for (var i = 0; i < tiles.length; i++) {
        tiles[i].classList.toggle('focused', active && i === row.col);
        tiles[i].classList.toggle('moving', active && moving && i === row.col);
      }
      // Slide the row only when the focused tile would leave the screen.
      var focusedTile = tiles[row.col];
      if (focusedTile) {
        var visible = row.trackEl.clientWidth - 2 * parseFloat(getComputedStyle(row.trackEl).paddingLeft);
        var left = focusedTile.offsetLeft - tiles[0].offsetLeft;
        var right = left + focusedTile.offsetWidth;
        row.shift = row.shift || 0;
        if (left < row.shift) row.shift = left;
        else if (right > row.shift + visible) row.shift = right - visible;
        row.trackEl.style.transform = 'translateX(' + (-row.shift) + 'px)';
      }
    });

    // The dock row shows the whole Top Shelf; further rows scroll it away,
    // in whole rows, only as far as needed to show the active row.
    var activeRow = rows[rowIndex];
    if (activeRow && els.rendered) {
      var pageTop = els.page.getBoundingClientRect().top;
      var topOf = function (r) { return rows[r].el.getBoundingClientRect().top - pageTop; };
      var margin = window.innerHeight * 0.07;
      var viewH = window.innerHeight - els.hints.offsetHeight;
      var rowTop = topOf(rowIndex);
      var rowBottom = rowTop + activeRow.el.offsetHeight;
      if (rowIndex === 0) {
        scrollY = 0;
      } else if (rowTop - margin < scrollY) {
        scrollY = rowTop - margin;
      } else if (rowBottom > scrollY + viewH) {
        for (var r = 1; r <= rowIndex; r++) {
          var top = topOf(r) - margin;
          if (rowBottom - top <= viewH) { scrollY = top; break; }
        }
      }
      els.page.style.transform = 'translateY(' + (-scrollY) + 'px)';
      document.body.classList.toggle('scrolled', scrollY > 0);
    }
    updateShelf();
    renderHints();
  }

  /* ---------- Top Shelf ---------- */

  function hostOf(url) {
    return url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
  }

  function describe(item) {
    switch (item.kind) {
      case 'app': return item.category === 'Other' ? 'App' : item.category;
      case 'mod': return 'TizenBrew module';
      case 'web': return hostOf(item.ref.url);
      case 'key': return item.ref.key === 'KEY_TV' ? 'Broadcast TV' : 'Input · ' + item.ref.key.replace('KEY_', '');
      case 'tool': return item.ref === 'phone' ? 'Scan a code to send links from your phone' : 'Startup, widgets and layout';
      case 'calendar': return 'Your calendar';
      case 'media': return item.ref.mediaTitle ? item.ref.mediaTitle + (item.ref.mediaArtist ? ' · ' + item.ref.mediaArtist : '') : item.ref.state;
      case 'ha': return item.ref.state + (item.ref.unit ? ' ' + item.ref.unit : '');
    }
    return '';
  }

  var washIndex = 0;
  var washKey = null;

  // Paints a gradient from the focused art's average color into a 16x9
  // canvas; upscaled to full screen it is a soft wash for almost no GPU cost.
  function setWash(item) {
    var key = item && item.color ? item.key : null;
    if (key === washKey) return;
    washKey = key;
    var next = els.washes[1 - washIndex];
    var ctx = next.getContext('2d');
    ctx.clearRect(0, 0, 16, 9);
    if (key) {
      var c = item.color;
      var gradient = ctx.createLinearGradient(0, 0, 16, 9);
      gradient.addColorStop(0, 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')');
      gradient.addColorStop(0.55, Icons.tileBackground(c));
      gradient.addColorStop(1, Icons.shiftHue(c, 38, 0.5));
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 16, 9);
    }
    next.style.opacity = key ? '1' : '0';
    els.washes[washIndex].style.opacity = '0';
    washIndex = 1 - washIndex;
  }

  /* ---------- Motion helpers ---------- */

  // Restarts a CSS animation class on an element.
  function replay(node, className) {
    node.classList.remove(className);
    void node.offsetWidth; // force reflow so the animation starts over
    node.classList.add(className);
  }

  // Shows a layer, then lets its CSS transition run from the .is-out state.
  function animateIn(node) {
    clearTimeout(node.outTimer);
    node.hidden = false;
    node.classList.add('is-out');
    void node.offsetWidth;
    node.classList.remove('is-out');
  }

  function animateOut(node, ms) {
    node.classList.add('is-out');
    clearTimeout(node.outTimer);
    node.outTimer = setTimeout(function () {
      node.hidden = true;
      node.classList.remove('is-out');
    }, ms || 320);
  }

  function focusedTile() {
    var row = rows[rowIndex];
    return row && row.trackEl ? row.trackEl.children[row.col] : null;
  }

  // Focus arriving from a direction carries a little momentum; hitting the
  // end of a row or the top/bottom bumps against it.
  var MOTION_CLASSES = ['nudge-left', 'nudge-right', 'nudge-up', 'nudge-down',
    'bump-left', 'bump-right', 'bump-up', 'bump-down'];

  function playMotion(name) {
    var tile = focusedTile();
    if (!tile) return;
    MOTION_CLASSES.forEach(function (c) { tile.classList.remove(c); });
    replay(tile, name);
  }

  function nudge(dir) { playMotion('nudge-' + dir); }
  function bump(dir) { playMotion('bump-' + dir); }

  function pressFocused() {
    var tile = focusedTile();
    if (!tile) return;
    tile.classList.add('pressed');
    setTimeout(function () { tile.classList.remove('pressed'); }, 120);
  }

  function updateShelf() {
    if (mode !== 'home' || document.body.classList.contains('ambient-on')) return;
    var row = rows[rowIndex];
    var item = currentItem();
    var title = item ? item.name : 'TVDeck';
    if (els.shelfTitle.textContent !== title) replay(els.shelfInfo, 'swap');
    els.shelfKind.textContent = row ? row.title : '';
    els.shelfTitle.textContent = title;
    els.shelfMeta.textContent = item ? describe(item) : 'Press RED on any tile to pin it to the dock';
    setWash(item);
  }

  function hint(color, text) {
    return '<span class="hint"><span class="key ' + color + '"></span>' + text + '</span>';
  }

  function plainHint(text) {
    return '<span class="hint">' + text + '</span>';
  }

  function renderHints() {
    var row = rows[rowIndex];
    var item = currentItem();
    var parts = [];
    if (mode === 'settings') {
      parts.push(plainHint('OK to change · Back to close'));
    } else if (mode === 'overlay' && overlay.type === 'message') {
      parts.push(plainHint(overlay.item.type === 'url' ? 'OK to open in browser' : 'OK to dismiss'));
      if (overlay.item.type === 'url') parts.push(hint('yellow', 'Open in TVDeck'));
      parts.push(plainHint('Back to dismiss'));
    } else if (mode === 'overlay') {
      parts.push(plainHint('Back to close'));
    } else if (moving) {
      parts.push(plainHint('Left and right to move · OK to drop'));
    } else {
      if (item && PINNABLE[item.kind]) {
        var pinned = Store.get('favorites').indexOf(item.key) !== -1;
        parts.push(hint('red', pinned ? 'Unpin' : 'Pin to Favorites'));
      }
      parts.push(hint('green', 'Settings'));
      if (row && row.id === 'favorites' && row.items.length > 1) parts.push(hint('yellow', 'Reorder'));
      if (row && row.apps && item) parts.push(hint('yellow', 'Hide app'));
      parts.push(hint('blue', 'Refresh'));
    }
    els.hints.innerHTML = parts.join('');
  }

  function currentItem() {
    var row = rows[rowIndex];
    return row && row.items.length ? row.items[row.col] : null;
  }

  function toast(text) {
    els.toast.textContent = text;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove('show'); }, 2400);
  }

  /* ---------- Actions ---------- */

  function rememberRecent(item) {
    var recent = Store.get('recent').filter(function (key) { return key !== item.key; });
    recent.unshift(item.key);
    Store.set('recent', recent.slice(0, MAX_RECENT));
  }

  function open(item) {
    if (PINNABLE[item.kind]) rememberRecent(item);
    switch (item.kind) {
      case 'app':
        Platform.launchApp(item.ref.id).catch(function () { toast('Could not open ' + item.name); });
        break;
      case 'mod':
        Platform.launchModule(item.ref);
        break;
      case 'web':
        Platform.openUrl(item.ref.url);
        break;
      case 'key':
        Platform.sendKey(item.ref.key)
          .then(function () { toast('Switching to ' + item.name); })
          .catch(function () { toast('TVDeck service not running'); });
        break;
      case 'ha':
      case 'media':
        if (HA_ACTIONABLE.indexOf(item.ref.domain) === -1) break;
        Platform.service('/api/ha/action', { entity_id: item.ref.id })
          .then(function () { setTimeout(loadGlance, 600); })
          .catch(function (err) { toast(err.message); });
        break;
      case 'tool':
        if (item.ref === 'phone') showOverlay({ type: 'phone' });
        else openSettings();
        break;
    }
    if (PINNABLE[item.kind]) {
      buildRows();
      render();
    }
  }

  function togglePin(item) {
    if (!PINNABLE[item.kind]) return;
    var pinned = Store.toggleIn('favorites', item.key);
    toast(pinned ? 'Pinned ' + item.name : 'Unpinned ' + item.name);
    buildRows();
    render();
  }

  function hideApp(item) {
    Store.toggleIn('hiddenApps', item.ref.id);
    toast('Hid ' + item.name + ' · restore it in Settings');
    buildRows();
    render();
  }

  function moveFavorite(step) {
    var row = rows[rowIndex];
    var to = row.col + step;
    if (to < 0 || to >= row.items.length) return;
    var favorites = row.items.map(function (item) { return item.key; });
    var moved = favorites.splice(row.col, 1)[0];
    favorites.splice(to, 0, moved);
    Store.set('favorites', favorites);
    row.col = to;
    buildRows();
    render();
  }

  /* ---------- Data loading ---------- */

  function ignore() { return null; }

  function loadInputs() {
    return Platform.service('/api/inputs').then(function (res) {
      return res.inputs;
    }, function () {
      return Platform.isTV ? [] : DESKTOP_INPUTS;
    });
  }

  function loadGlance() {
    return Promise.all([
      Platform.service('/api/calendar').catch(ignore),
      Platform.service('/api/ha/states').catch(ignore)
    ]).then(function (results) {
      data.calendar = results[0];
      data.ha = results[1] ? results[1].entities : [];
      var signature = JSON.stringify([data.calendar, data.ha]);
      if (signature === glanceSignature) return;
      glanceSignature = signature;
      if (loaded && mode !== 'settings') {
        buildRows();
        render();
      }
    });
  }

  function refresh(announce) {
    lastRefresh = Date.now();
    return Promise.all([
      Platform.listApps(),
      Platform.listModules(),
      loadInputs(),
      Platform.service('/api/tizenbrew').catch(ignore)
    ]).then(function (results) {
      data.apps = results[0];
      data.modules = results[1];
      data.inputs = results[2];
      data.tizenbrew = results[3];
      buildRows();
      if (!loaded) {
        loaded = true;
        rowIndex = firstFocusableRow(0, 1);
        setTimeout(function () { document.body.classList.remove('booting'); }, 1800);
      }
      render();
      loadGlance();
      if (announce) toast('Refreshed');
    });
  }

  // Phone messages arrive through the service; poll slowly when it is down.
  function pollInbox() {
    Platform.service('/api/inbox').then(function (res) {
      res.items.forEach(function (item) { messages.push(item); });
      showNextMessage();
      setTimeout(pollInbox, 2000);
    }, function () {
      setTimeout(pollInbox, 15000);
    });
  }

  /* ---------- Overlays ---------- */

  function showNextMessage() {
    if (mode !== 'home' || !messages.length) return;
    showOverlay({ type: 'message', item: messages.shift() });
  }

  function qrSvg(text) {
    var qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }

  function showOverlay(next) {
    overlay = next;
    mode = 'overlay';
    var card = els.overlayCard;
    card.innerHTML = '';

    if (next.type === 'phone') {
      card.appendChild(el('h2', '', 'Send from your phone'));
      var body = el('div', 'phone-body');
      var qrBox = el('div', 'qr');
      var info = el('div', 'phone-info');
      body.appendChild(qrBox);
      body.appendChild(info);
      card.appendChild(body);
      info.appendChild(el('p', '', 'Connecting to the TVDeck service…'));

      Platform.service('/api/info').then(function (svc) {
        info.innerHTML = '';
        if (!svc.phoneUrl) throw new Error('No network address yet');
        qrBox.innerHTML = qrSvg(svc.phoneUrl);
        info.appendChild(el('p', '', 'Scan with your phone camera on the same Wi-Fi, or open'));
        info.appendChild(el('p', 'phone-url', svc.phoneUrl.replace(/^http:\/\//, '').replace(/\/?\?.*/, '')));
        info.appendChild(el('p', '', 'PIN'));
        info.appendChild(el('p', 'phone-pin', svc.pin));
        info.appendChild(el('p', '', 'Send links to the TV, rename inputs, and set up the calendar and Home Assistant.'));
      }).catch(function () {
        qrBox.hidden = true;
        info.innerHTML = '';
        info.appendChild(el('p', '', 'The TVDeck service is not running.'));
        info.appendChild(el('p', '', 'Reopen TVDeck from TizenBrew to start it.'));
      });
    } else {
      var item = next.item;
      card.appendChild(el('h2', '', item.type === 'url' ? 'Link from your phone' : 'Message from your phone'));
      card.appendChild(el('p', item.type === 'url' ? 'message-url' : 'message-text', item.value));
    }

    animateIn(els.overlay);
    updateFocus();
  }

  function closeOverlay() {
    animateOut(els.overlay, 280);
    overlay = null;
    mode = 'home';
    updateFocus();
    showNextMessage();
  }

  function handleOverlayKey(key) {
    if (overlay.type === 'message') {
      var item = overlay.item;
      if (key === KEY.ENTER) {
        closeOverlay();
        if (item.type === 'url') Platform.openInBrowser(item.value);
      } else if (key === KEY.YELLOW && item.type === 'url') {
        closeOverlay();
        Platform.openUrl(item.value);
      } else if (key === KEY.BACK) {
        closeOverlay();
      }
      return;
    }
    if (key === KEY.BACK || key === KEY.ENTER) closeOverlay();
  }

  /* ---------- Settings ---------- */

  function settingRow(label, value, action) {
    return { type: 'row', label: label, value: value, action: action };
  }

  function buildSettings() {
    var items = [{ type: 'section', label: 'General' }];
    items.push(settingRow('Clock', Store.get('use24h') ? '24-hour' : '12-hour', function () {
      Store.set('use24h', !Store.get('use24h'));
      tickClock();
    }));
    items.push(settingRow('Weather', Store.get('showWeather') ? 'On' : 'Off', function () {
      Store.set('showWeather', !Store.get('showWeather'));
      loadWeather();
    }));
    items.push({ type: 'input', label: 'City', value: Store.get('city'), onSave: function (value) {
      if (!value) return;
      Store.set('city', value);
      loadWeather();
    } });

    items.push({ type: 'section', label: 'Startup' });
    var tb = data.tizenbrew;
    var self = Platform.selfModuleName();
    var autoOpen = !!tb && tb.autoLaunchModule === self;
    var autoService = !!tb && tb.autoLaunchServiceList.indexOf(Platform.serviceModuleName()) !== -1;
    items.push(settingRow('Open TVDeck with TizenBrew', tb ? (autoOpen ? 'On' : 'Off') : 'Unavailable', function () {
      if (!tb) return toast('Needs the TVDeck service');
      Platform.setAutoLaunch(!autoOpen);
      tb.autoLaunchModule = autoOpen ? '' : self;
    }));
    items.push(settingRow('Start phone service at boot', tb ? (autoService ? 'On' : 'Off') : 'Unavailable', function () {
      if (!tb) return toast('Needs the TVDeck service');
      Platform.setServiceAutoLaunch(!autoService, tb.autoLaunchServiceList);
      var name = Platform.serviceModuleName();
      tb.autoLaunchServiceList = tb.autoLaunchServiceList.filter(function (n) { return n !== name; });
      if (!autoService) tb.autoLaunchServiceList.push(name);
    }));

    items.push({ type: 'section', label: 'Phone & widgets' });
    items.push(settingRow('Set up from your phone', 'QR code', function () {
      closeSettings();
      showOverlay({ type: 'phone' });
      return true;
    }));

    items.push({ type: 'section', label: 'Web shortcuts' });
    Store.get('webLinks').forEach(function (link, i) {
      items.push(settingRow(link.name, 'Remove', function () {
        var links = Store.get('webLinks').slice();
        links.splice(i, 1);
        Store.set('webLinks', links);
        Store.set('favorites', Store.get('favorites').filter(function (key) { return key !== 'web:' + link.url; }));
        toast('Removed ' + link.name);
      }));
    });
    var draft = { name: '', url: '' };
    items.push({ type: 'input', label: 'New name', value: '', onSave: function (v) { draft.name = v; } });
    items.push({ type: 'input', label: 'New URL', value: '', placeholder: 'https://', onSave: function (v) { draft.url = v; } });
    items.push(settingRow('Add shortcut', '+', function () {
      var url = draft.url.trim();
      if (!url) return toast('Enter a URL first');
      if (!/^https?:\/\//.test(url)) url = 'https://' + url;
      var name = draft.name.trim() || url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
      Store.set('webLinks', Store.get('webLinks').concat([{ name: name, url: url }]));
      toast('Added ' + name);
    }));

    items.push({ type: 'section', label: 'Layout' });
    items.push(settingRow('Group apps by category', Store.get('groupApps') ? 'On' : 'Off', function () {
      Store.set('groupApps', !Store.get('groupApps'));
    }));
    items.push(settingRow('Ambient screen when idle', Store.get('ambient') ? 'On' : 'Off', function () {
      Store.set('ambient', !Store.get('ambient'));
      noteActivity();
    }));
    items.push(settingRow('Recent row', Store.get('showRecent') ? 'On' : 'Off', function () {
      Store.set('showRecent', !Store.get('showRecent'));
    }));
    items.push(settingRow('Clear recent', Store.get('recent').length ? 'Clear' : 'Empty', function () {
      Store.set('recent', []);
      toast('Recent cleared');
    }));
    var hiddenCount = Store.get('hiddenApps').length;
    items.push(settingRow('Hidden apps', hiddenCount ? 'Show ' + hiddenCount : 'None', function () {
      Store.set('hiddenApps', []);
      toast('All apps visible');
    }));
    items.push(settingRow('Reset everything', 'Reset', function () {
      Store.reset();
      tickClock();
      loadWeather();
      toast('Settings reset');
    }));
    return items;
  }

  function renderSettings() {
    settingsItems = buildSettings();
    els.settingsList.innerHTML = '';
    settingsItems.forEach(function (item) {
      var node;
      if (item.type === 'section') {
        node = el('div', 'setting-section', item.label);
      } else {
        node = el('div', 'setting');
        node.style.setProperty('--i', Math.min(els.settingsList.children.length, 14));
        node.appendChild(el('span', '', item.label));
        if (item.type === 'input') {
          var input = document.createElement('input');
          input.type = item.label.indexOf('URL') !== -1 ? 'url' : 'text';
          input.value = item.value;
          input.placeholder = item.placeholder || '';
          input.addEventListener('change', function () { item.onSave(input.value.trim()); });
          node.appendChild(input);
          item.input = input;
        } else {
          node.appendChild(el('span', 'setting-value', item.value));
        }
      }
      item.el = node;
      els.settingsList.appendChild(node);
    });
    if (!isSelectable(settingsIndex)) settingsIndex = nextSelectable(-1, 1);
    focusSetting();
  }

  function isSelectable(i) {
    return settingsItems[i] && settingsItems[i].type !== 'section';
  }

  function nextSelectable(from, step) {
    for (var i = from + step; i >= 0 && i < settingsItems.length; i += step) {
      if (isSelectable(i)) return i;
    }
    return from;
  }

  function focusSetting() {
    settingsItems.forEach(function (item, i) {
      if (item.el) item.el.classList.toggle('focused', i === settingsIndex);
    });
    var node = settingsItems[settingsIndex] && settingsItems[settingsIndex].el;
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
  }

  function openSettings() {
    mode = 'settings';
    settingsIndex = 0;
    animateIn(els.settings);
    replay(els.settings, 'opening');
    clearTimeout(els.settings.openTimer);
    els.settings.openTimer = setTimeout(function () { els.settings.classList.remove('opening'); }, 1000);
    renderSettings();
    updateFocus();
  }

  function closeSettings() {
    mode = 'home';
    animateOut(els.settings, 320);
    buildRows();
    render();
    showNextMessage();
  }

  function activateSetting() {
    var item = settingsItems[settingsIndex];
    if (!item) return;
    if (item.type === 'input') {
      item.input.focus();
      return;
    }
    // An action returning true has left the settings panel.
    if (item.action() !== true) renderSettings();
  }

  /* ---------- Clock & weather ---------- */

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function formatTime(date) {
    var h = date.getHours();
    if (Store.get('use24h')) return pad(h) + ':' + pad(date.getMinutes());
    return (h % 12 || 12) + ':' + pad(date.getMinutes()) + (h < 12 ? ' AM' : ' PM');
  }

  function tickClock() {
    var now = new Date();
    els.clock.textContent = formatTime(now);
    els.date.textContent = DAYS[now.getDay()] + ', ' + now.getDate() + ' ' + MONTHS[now.getMonth()];
    els.ambientClock.textContent = els.clock.textContent;
    els.ambientDate.textContent = els.date.textContent;
  }

  function loadWeather() {
    if (!Store.get('showWeather')) {
      els.weather.hidden = true;
      return;
    }
    Weather.fetchCurrent(Store.get('city')).then(function (w) {
      els.weatherTemp.textContent = w.temp + '°';
      els.weatherLabel.textContent = w.label;
      data.weather = w;
      els.weather.hidden = false;
    }).catch(function () {
      els.weather.hidden = true;
    });
  }

  /* ---------- Living details: shelf ticker, idle shimmer, ambient ---------- */

  function greeting() {
    var h = new Date().getHours();
    return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }

  function tickerLines() {
    var lines = [];
    var next = data.calendar && data.calendar.events[0];
    if (next) lines.push(eventWhen(next) + ' · ' + next.title);
    data.ha.forEach(function (e) {
      if (e.domain === 'media_player' && e.state === 'playing' && e.mediaTitle) {
        lines.push('Playing · ' + e.mediaTitle + (e.mediaArtist ? ' — ' + e.mediaArtist : ''));
      }
    });
    if (data.weather) lines.push(data.weather.place + ' · ' + data.weather.label);
    lines.push(greeting());
    return lines;
  }

  var tickerIndex = 0;

  // Cycles the small status line under the clock, cross-fading each change.
  function rotateTicker() {
    var lines = tickerLines();
    tickerIndex = (tickerIndex + 1) % lines.length;
    var text = lines[tickerIndex];
    if (els.ticker.textContent !== text) {
      els.ticker.textContent = text;
      replay(els.ticker, 'tick');
    }
    els.ambientLine.textContent = lines[0];
  }

  var idleTimer = null;
  var ambientTimer = null;

  function noteActivity() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    clearTimeout(ambientTimer);
    idleTimer = setTimeout(function () { document.body.classList.add('idle'); }, IDLE_MS);
    if (Store.get('ambient')) ambientTimer = setTimeout(enterAmbient, AMBIENT_MS);
  }

  // Ambient: hide the launcher, show a large clock, and let the wash drift
  // through the colors of the dock's apps.
  var ambientCycle = null;

  function enterAmbient() {
    if (mode !== 'home') return noteActivity();
    // Only art with real color makes a good wash; skip near-black/white logos.
    var colored = [];
    rows.forEach(function (row) {
      row.items.forEach(function (item) {
        var c = item.color;
        if (!c || colored.indexOf(item) !== -1) return;
        if (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) > 40) colored.push(item);
      });
    });
    var i = 0;
    function nextColor() {
      if (colored.length) setWash(colored[i++ % colored.length]);
    }
    animateIn(els.ambient);
    document.body.classList.add('ambient-on');
    rotateTicker();
    nextColor();
    clearInterval(ambientCycle);
    ambientCycle = setInterval(nextColor, 10000);
  }

  function exitAmbient() {
    clearInterval(ambientCycle);
    document.body.classList.remove('ambient-on');
    animateOut(els.ambient, 600);
    updateShelf();
    noteActivity();
  }

  /* ---------- Input ---------- */

  function handleInputKey(e, key) {
    // Typing in a settings field: only intercept keys that leave the field.
    if (key === KEY.ENTER || key === KEY.BACK || key === KEY.IME_DONE || key === KEY.IME_CANCEL) {
      e.preventDefault();
      document.activeElement.blur();
      return true;
    }
    if (key === KEY.UP || key === KEY.DOWN) {
      document.activeElement.blur();
      return false;
    }
    return true;
  }

  function handleHomeKey(key) {
    var row = rows[rowIndex];
    var item = currentItem();

    if (moving) {
      if (key === KEY.LEFT) moveFavorite(-1);
      else if (key === KEY.RIGHT) moveFavorite(1);
      else if (key === KEY.ENTER || key === KEY.YELLOW || key === KEY.BACK) {
        moving = false;
        updateFocus();
      }
      return;
    }

    var before = rowIndex;
    switch (key) {
      case KEY.LEFT:
        if (row.col > 0) { row.col--; updateFocus(); nudge('left'); } else bump('left');
        break;
      case KEY.RIGHT:
        if (row.col < row.items.length - 1) { row.col++; updateFocus(); nudge('right'); } else bump('right');
        break;
      case KEY.UP:
      case KEY.CH_UP:
        rowIndex = firstFocusableRow(rowIndex - 1, -1);
        if (rowIndex === before) { bump('up'); break; }
        updateFocus();
        nudge('up');
        break;
      case KEY.DOWN:
      case KEY.CH_DOWN:
        rowIndex = firstFocusableRow(rowIndex + 1, 1);
        if (rowIndex === before) { bump('down'); break; }
        updateFocus();
        nudge('down');
        break;
      case KEY.ENTER:
        if (item) {
          pressFocused();
          setTimeout(function () { open(item); }, 140);
        }
        break;
      case KEY.RED:
        if (item) togglePin(item);
        break;
      case KEY.GREEN:
        openSettings();
        break;
      case KEY.YELLOW:
        if (row.id === 'favorites' && row.items.length > 1) {
          moving = true;
          updateFocus();
        } else if (row.apps && item) {
          hideApp(item);
        }
        break;
      case KEY.BLUE:
        refresh(true);
        break;
    }
  }

  function handleSettingsKey(key) {
    switch (key) {
      case KEY.UP:
        settingsIndex = nextSelectable(settingsIndex, -1);
        focusSetting();
        break;
      case KEY.DOWN:
        settingsIndex = nextSelectable(settingsIndex, 1);
        focusSetting();
        break;
      case KEY.ENTER:
        activateSetting();
        break;
      case KEY.BACK:
      case KEY.GREEN:
        closeSettings();
        break;
    }
  }

  document.addEventListener('keydown', function (e) {
    // Any key wakes the ambient screen and is swallowed.
    if (document.body.classList.contains('ambient-on')) {
      e.preventDefault();
      exitAmbient();
      return;
    }
    noteActivity();
    var key = e.keyCode;
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT';

    if (typing) {
      if (key === KEY.ESC) key = KEY.BACK;
      if (handleInputKey(e, key)) return;
    } else if (!Platform.isTV && DESKTOP_ALIASES[key]) {
      key = DESKTOP_ALIASES[key];
    }

    if (key === KEY.BACK) e.preventDefault();
    if (mode === 'settings') handleSettingsKey(key);
    else if (mode === 'overlay') handleOverlayKey(key);
    else handleHomeKey(key);
  });

  window.addEventListener('resize', function () {
    if (els.rendered) updateFocus();
  });

  // Pick up newly installed apps when coming back from another app,
  // at most every 15 s (visibility can flicker while the TV switches apps).
  var lastRefresh = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    tickClock();
    noteActivity();
    if (Date.now() - lastRefresh > 15000) refresh(false);
  });

  /* ---------- Boot ---------- */

  els.settingsGlyph.innerHTML = Icons.svg('settings');
  Platform.registerKeys(['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'ChannelUp', 'ChannelDown']);
  tickClock();
  setInterval(tickClock, 5000);
  loadWeather();
  setInterval(loadWeather, 30 * 60 * 1000);
  setInterval(loadGlance, 30 * 1000);
  setInterval(rotateTicker, 6000);
  noteActivity();
  // Probe the service first so app icons can be served through it.
  Platform.service('/api/info').catch(ignore).then(function () {
    refresh(false).then(rotateTicker);
    pollInbox();
  });
})();
