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

  var BRAND_COLORS = [
    [/netflix/i, '#b20710', '#4a0306'],
    [/youtube|tizentube/i, '#d11a1a', '#4d0909'],
    [/prime/i, '#0f79af', '#08334d'],
    [/disney/i, '#1238a8', '#0a1440'],
    [/spotify/i, '#1aa34a', '#0a3d1c'],
    [/twitch/i, '#7a3cf0', '#2c1260'],
    [/apple/i, '#4a4d55', '#16171a'],
    [/stremio/i, '#6a4bd6', '#241750'],
    [/jellyfin/i, '#7b3fbf', '#1d3a6b'],
    [/plex/i, '#c98a07', '#3d2a02'],
    [/^hdmi|live tv|input/i, '#2f3a52', '#151b28']
  ];

  var els = {
    rows: document.getElementById('rows'),
    clock: document.getElementById('clock'),
    date: document.getElementById('date'),
    weather: document.getElementById('weather'),
    weatherIcon: document.getElementById('weather-icon'),
    weatherTemp: document.getElementById('weather-temp'),
    weatherLabel: document.getElementById('weather-label'),
    hints: document.getElementById('hints'),
    toast: document.getElementById('toast'),
    settings: document.getElementById('settings'),
    settingsList: document.getElementById('settings-list'),
    overlay: document.getElementById('overlay'),
    overlayCard: document.getElementById('overlay-card')
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

  /* ---------- Items ---------- */

  function catalog() {
    var items = {};
    data.apps.forEach(function (app) {
      items['app:' + app.id] = { key: 'app:' + app.id, kind: 'app', name: app.name, icon: app.icon, ref: app };
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
        empty: 'Press RED on any tile to pin it here' },
      { id: 'glance', title: 'At a glance', glance: true, items: glanceItems() },
      { id: 'recent', title: 'Recent', items: Store.get('showRecent') ? lookup(Store.get('recent')) : [] },
      { id: 'inputs', title: 'Inputs', items: data.inputs.map(function (input) { return items['key:' + input.key]; }) },
      { id: 'apps', title: 'Apps', items: data.apps
          .filter(function (app) { return hidden.indexOf(app.id) === -1; })
          .map(function (app) { return items['app:' + app.id]; }) },
      { id: 'modules', title: 'TizenBrew modules', items: data.modules
          .map(function (mod) { return items['mod:' + mod.fullName]; }) },
      { id: 'web', title: 'Web', items: Store.get('webLinks')
          .map(function (link) { return items['web:' + link.url]; }) },
      { id: 'tools', title: 'TVDeck', items: [
          { key: 'tool:phone', kind: 'tool', name: 'Send from phone', badge: 'QR', ref: 'phone' },
          { key: 'tool:settings', kind: 'tool', name: 'Settings', ref: 'settings' }
        ] }
    ].filter(function (row) { return row.items.length || row.empty; });

    // Keep each row's horizontal position across rebuilds.
    var oldCols = {};
    rows.forEach(function (row) { oldCols[row.id] = row.col; });
    next.forEach(function (row) {
      row.col = Math.min(oldCols[row.id] || 0, Math.max(0, row.items.length - 1));
    });

    var activeId = rows[rowIndex] ? rows[rowIndex].id : null;
    rows = next;
    rowIndex = 0;
    rows.forEach(function (row, i) { if (row.id === activeId) rowIndex = i; });
    if (!rows[rowIndex].items.length) rowIndex = firstFocusableRow(rowIndex, 1);
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

  function tileColors(name) {
    for (var i = 0; i < BRAND_COLORS.length; i++) {
      if (BRAND_COLORS[i][0].test(name)) return [BRAND_COLORS[i][1], BRAND_COLORS[i][2]];
    }
    var hash = 0;
    for (var j = 0; j < name.length; j++) hash = (hash * 31 + name.charCodeAt(j)) | 0;
    var hue = Math.abs(hash) % 360;
    return ['hsl(' + hue + ',50%,36%)', 'hsl(' + ((hue + 40) % 360) + ',55%,18%)'];
  }

  function renderTile(item) {
    var tile = el('div', 'tile');
    var colors = tileColors(item.name);
    tile.style.setProperty('--tile-bg', 'linear-gradient(135deg,' + colors[0] + ',' + colors[1] + ')');

    var glyph = item.kind === 'key' ? '⎆' : item.ref === 'phone' ? '📱' : item.ref === 'settings' ? '⚙' : item.name.charAt(0).toUpperCase();
    var letter = el('div', 'tile-letter', glyph);
    tile.appendChild(letter);

    var src = Platform.iconUrl(item.icon);
    if (src) {
      var img = el('img', 'tile-icon');
      img.alt = '';
      img.onload = function () { letter.hidden = true; };
      img.onerror = function () { img.parentNode && img.parentNode.removeChild(img); };
      img.src = src;
      tile.appendChild(img);
    }

    if (item.badge) tile.appendChild(el('div', 'tile-badge', item.badge));
    tile.appendChild(el('div', 'tile-name', item.name));
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
      card.appendChild(el('div', 'glance-title', 'Calendar'));
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
      card.appendChild(el('div', 'glance-title', (entity.state === 'playing' ? '▶ ' : '❚❚ ') + entity.name));
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
    var inner = el('div', 'rows-inner');

    rows.forEach(function (row) {
      var rowEl = el('section', 'row' + (row.featured ? ' featured' : '') + (row.glance ? ' glance' : ''));
      rowEl.appendChild(el('h2', 'row-title', row.title));

      row.trackEl = null;
      if (!row.items.length) {
        rowEl.appendChild(el('div', 'row-empty', row.empty));
      } else {
        var track = el('div', 'row-track');
        row.items.forEach(function (item) {
          track.appendChild(row.glance ? renderGlance(item) : renderTile(item));
        });
        rowEl.appendChild(track);
        row.trackEl = track;
      }

      row.el = rowEl;
      inner.appendChild(rowEl);
    });

    els.rows.innerHTML = '';
    els.rows.appendChild(inner);
    els.inner = inner;
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
      // Keep the focused tile in view, two tiles in from the left edge.
      var anchor = tiles[Math.max(0, row.col - 2)];
      var shift = anchor ? anchor.offsetLeft - tiles[0].offsetLeft : 0;
      row.trackEl.style.transform = 'translateX(' + (-shift) + 'px)';
    });

    // Scroll vertically in whole rows, only as far as needed to show the active row.
    var activeRow = rows[rowIndex];
    if (activeRow && els.inner) {
      var base = rows[0].el.offsetTop;
      var rowTop = activeRow.el.offsetTop - base;
      var rowBottom = rowTop + activeRow.el.offsetHeight;
      var viewH = els.rows.clientHeight;
      if (rowTop < scrollY) {
        scrollY = rowTop;
      } else if (rowBottom > scrollY + viewH) {
        for (var r = 0; r <= rowIndex; r++) {
          var top = rows[r].el.offsetTop - base;
          if (rowBottom - top <= viewH) { scrollY = top; break; }
        }
      }
      els.inner.style.transform = 'translateY(' + (-scrollY) + 'px)';
    }
    renderHints();
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
      parts.push(plainHint('◀ ▶ to move · OK to drop'));
    } else {
      if (item && PINNABLE[item.kind]) {
        var pinned = Store.get('favorites').indexOf(item.key) !== -1;
        parts.push(hint('red', pinned ? 'Unpin' : 'Pin to Favorites'));
      }
      parts.push(hint('green', 'Settings'));
      if (row && row.id === 'favorites' && row.items.length > 1) parts.push(hint('yellow', 'Reorder'));
      if (row && row.id === 'apps' && item) parts.push(hint('yellow', 'Hide app'));
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
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, 2200);
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
      if (loaded && mode !== 'settings') {
        buildRows();
        render();
      }
    });
  }

  function refresh(announce) {
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
      info.appendChild(el('p', 'glance-dim', 'Connecting to the TVDeck service…'));

      Platform.service('/api/info').then(function (svc) {
        info.innerHTML = '';
        if (!svc.phoneUrl) throw new Error('No network address yet');
        qrBox.innerHTML = qrSvg(svc.phoneUrl);
        info.appendChild(el('p', '', 'Scan with your phone camera (same Wi-Fi), or open:'));
        info.appendChild(el('p', 'phone-url', svc.phoneUrl.replace(/\?.*/, '')));
        info.appendChild(el('p', '', 'PIN: ' + svc.pin));
        info.appendChild(el('p', 'glance-dim', 'Send links to the TV, rename inputs, and set up the calendar and Home Assistant widgets.'));
      }).catch(function () {
        info.innerHTML = '';
        info.appendChild(el('p', '', 'The TVDeck service is not running.'));
        info.appendChild(el('p', 'glance-dim', 'Reopen TVDeck from TizenBrew to start it.'));
      });
    } else {
      var item = next.item;
      card.appendChild(el('h2', '', item.type === 'url' ? 'Link from your phone' : 'Message from your phone'));
      card.appendChild(el('p', item.type === 'url' ? 'message-url' : 'message-text', item.value));
    }

    els.overlay.hidden = false;
    updateFocus();
  }

  function closeOverlay() {
    els.overlay.hidden = true;
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
    els.settings.hidden = false;
    renderSettings();
    updateFocus();
  }

  function closeSettings() {
    mode = 'home';
    els.settings.hidden = true;
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
  }

  function loadWeather() {
    if (!Store.get('showWeather')) {
      els.weather.hidden = true;
      return;
    }
    Weather.fetchCurrent(Store.get('city')).then(function (w) {
      els.weatherIcon.textContent = w.glyph;
      els.weatherTemp.textContent = w.temp + '°';
      els.weatherLabel.textContent = w.label + ' · ' + w.place;
      els.weather.hidden = false;
    }).catch(function () {
      els.weather.hidden = true;
    });
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

    switch (key) {
      case KEY.LEFT:
        if (row.col > 0) { row.col--; updateFocus(); }
        break;
      case KEY.RIGHT:
        if (row.col < row.items.length - 1) { row.col++; updateFocus(); }
        break;
      case KEY.UP:
      case KEY.CH_UP:
        rowIndex = firstFocusableRow(rowIndex - 1, -1);
        updateFocus();
        break;
      case KEY.DOWN:
      case KEY.CH_DOWN:
        rowIndex = firstFocusableRow(rowIndex + 1, 1);
        updateFocus();
        break;
      case KEY.ENTER:
        if (item) open(item);
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
        } else if (row.id === 'apps' && item) {
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
    if (els.inner) updateFocus();
  });

  // Pick up newly installed apps when coming back from another app.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      tickClock();
      refresh(false);
    }
  });

  /* ---------- Boot ---------- */

  Platform.registerKeys(['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'ChannelUp', 'ChannelDown']);
  tickClock();
  setInterval(tickClock, 5000);
  loadWeather();
  setInterval(loadWeather, 30 * 60 * 1000);
  setInterval(loadGlance, 30 * 1000);
  // Probe the service first so app icons can be served through it.
  Platform.service('/api/info').catch(ignore).then(function () {
    refresh(false);
    pollInbox();
  });
})();
