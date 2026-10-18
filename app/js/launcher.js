/*
 * TVDeck launcher: rows of tiles driven by the TV remote.
 *
 * Remote keys (desktop keyboard equivalents in brackets):
 *   Arrows / Enter        move / open
 *   Back       [Esc]      close panel, cancel move
 *   Red        [R]        pin / unpin to Favorites
 *   Green      [G]        settings
 *   Yellow     [Y]        reorder (in Favorites) or hide app
 *   Blue       [B]        refresh app and module lists
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
    [/plex/i, '#c98a07', '#3d2a02']
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
    settingsList: document.getElementById('settings-list')
  };

  var data = { apps: [], modules: [] };
  var rows = [];            // [{ id, title, items, col, el, trackEl }]
  var rowIndex = 0;
  var scrollY = 0;
  var loaded = false;       // first app/module list received
  var moving = false;       // reordering a favorite
  var mode = 'home';        // 'home' | 'settings'
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
    Store.get('webLinks').forEach(function (link, i) {
      items['web:' + link.url] = { key: 'web:' + link.url, kind: 'web', name: link.name, badge: 'Web', ref: link, index: i };
    });
    return items;
  }

  function buildRows() {
    var items = catalog();
    var hidden = Store.get('hiddenApps');
    var favorites = Store.get('favorites')
      .map(function (key) { return items[key]; })
      .filter(Boolean);

    var next = [
      { id: 'favorites', title: 'Favorites', featured: true, items: favorites,
        empty: 'Press RED on any tile to pin it here' },
      { id: 'apps', title: 'Apps', items: data.apps
          .filter(function (app) { return hidden.indexOf(app.id) === -1; })
          .map(function (app) { return items['app:' + app.id]; }) },
      { id: 'modules', title: 'TizenBrew modules', items: data.modules
          .map(function (mod) { return items['mod:' + mod.fullName]; }) },
      { id: 'web', title: 'Web', items: Store.get('webLinks')
          .map(function (link) { return items['web:' + link.url]; }) }
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
    var tile = document.createElement('div');
    tile.className = 'tile';
    var colors = tileColors(item.name);
    tile.style.setProperty('--tile-bg', 'linear-gradient(135deg,' + colors[0] + ',' + colors[1] + ')');

    var letter = document.createElement('div');
    letter.className = 'tile-letter';
    letter.textContent = item.name.charAt(0).toUpperCase();
    tile.appendChild(letter);

    if (item.icon) {
      var img = document.createElement('img');
      img.className = 'tile-icon';
      img.alt = '';
      img.onload = function () { letter.hidden = true; };
      img.onerror = function () { img.remove(); };
      img.src = item.icon.indexOf('/') === 0 ? 'file://' + item.icon : item.icon;
      tile.appendChild(img);
    }

    if (item.badge) {
      var badge = document.createElement('div');
      badge.className = 'tile-badge';
      badge.textContent = item.badge;
      tile.appendChild(badge);
    }

    var name = document.createElement('div');
    name.className = 'tile-name';
    name.textContent = item.name;
    tile.appendChild(name);
    return tile;
  }

  function render() {
    var inner = document.createElement('div');
    inner.className = 'rows-inner';

    rows.forEach(function (row) {
      var rowEl = document.createElement('section');
      rowEl.className = 'row' + (row.featured ? ' featured' : '');

      var title = document.createElement('h2');
      title.className = 'row-title';
      title.textContent = row.title;
      rowEl.appendChild(title);

      if (!row.items.length) {
        var empty = document.createElement('div');
        empty.className = 'row-empty';
        empty.textContent = row.empty;
        rowEl.appendChild(empty);
      } else {
        var track = document.createElement('div');
        track.className = 'row-track';
        row.items.forEach(function (item) { track.appendChild(renderTile(item)); });
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

  function renderHints() {
    var row = rows[rowIndex];
    var item = currentItem();
    var parts = [];
    if (mode === 'settings') {
      parts.push('<span class="hint">OK to change · Back to close</span>');
    } else if (moving) {
      parts.push('<span class="hint">◀ ▶ to move · OK to drop</span>');
    } else {
      if (item) {
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

  function open(item) {
    if (item.kind === 'app') {
      Platform.launchApp(item.ref.id).catch(function () { toast('Could not open ' + item.name); });
    } else if (item.kind === 'mod') {
      Platform.launchModule(item.ref);
    } else if (item.kind === 'web') {
      Platform.openUrl(item.ref.url);
    }
  }

  function togglePin(item) {
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

  function refresh(announce) {
    return Promise.all([Platform.listApps(), Platform.listModules()]).then(function (results) {
      data.apps = results[0];
      data.modules = results[1];
      buildRows();
      if (!loaded) {
        loaded = true;
        rowIndex = firstFocusableRow(0, 1);
      }
      render();
      if (announce) toast('Refreshed');
    });
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
      var el;
      if (item.type === 'section') {
        el = document.createElement('div');
        el.className = 'setting-section';
        el.textContent = item.label;
      } else {
        el = document.createElement('div');
        el.className = 'setting';
        var label = document.createElement('span');
        label.textContent = item.label;
        el.appendChild(label);
        if (item.type === 'input') {
          var input = document.createElement('input');
          input.type = item.label.indexOf('URL') !== -1 ? 'url' : 'text';
          input.value = item.value;
          input.placeholder = item.placeholder || '';
          input.addEventListener('change', function () { item.onSave(input.value.trim()); });
          el.appendChild(input);
          item.input = input;
        } else {
          var value = document.createElement('span');
          value.className = 'setting-value';
          value.textContent = item.value;
          el.appendChild(value);
        }
      }
      item.el = el;
      els.settingsList.appendChild(el);
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
    var el = settingsItems[settingsIndex] && settingsItems[settingsIndex].el;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
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
  }

  function activateSetting() {
    var item = settingsItems[settingsIndex];
    if (!item) return;
    if (item.type === 'input') {
      item.input.focus();
      return;
    }
    item.action();
    renderSettings();
  }

  /* ---------- Clock & weather ---------- */

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function tickClock() {
    var now = new Date();
    var h = now.getHours();
    var suffix = '';
    if (!Store.get('use24h')) {
      suffix = h < 12 ? ' AM' : ' PM';
      h = h % 12 || 12;
    }
    els.clock.textContent = (Store.get('use24h') ? pad(h) : h) + ':' + pad(now.getMinutes()) + suffix;
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
  refresh(false);
})();
