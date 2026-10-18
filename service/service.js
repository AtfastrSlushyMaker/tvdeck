/*
 * TVDeck background service.
 *
 * TizenBrew runs this file with Node.js inside a vm sandbox on the TV, with
 * TizenBrew's own `require` (express, node-fetch, ws-new/ws-old available).
 * The TV's Node can be old (v4 on Tizen 3), so this file is plain ES5.
 *
 * It can also run on a computer for development:
 *   TV_HOST=192.168.1.10 node service/service.js
 *
 * Listens on PORT (0.0.0.0):
 *   Phone (needs the PIN shown on the TV):
 *     GET  /                     phone companion page
 *     POST /api/send             { pin, url } or { pin, text }
 *     GET  /api/settings?pin=    widget settings (token masked)
 *     POST /api/settings         { pin, ...settings }
 *   Launcher (localhost only):
 *     GET  /api/info             { ip, port, pin, phoneUrl }
 *     GET  /api/inbox            queued phone messages (clears them)
 *     POST /api/key              { key: "KEY_HDMI1" } -> TV remote key
 *     GET  /api/icon?path=       app icon file from the TV filesystem
 *     GET  /api/inputs           configured input tiles
 *     GET  /api/calendar         upcoming events from the ICS feed
 *     GET  /api/ha/states        configured Home Assistant entities
 *     POST /api/ha/action        { entity_id }
 *     GET  /api/tizenbrew        TizenBrew auto-launch config
 */
(function () {
  'use strict';

  var http = require('http');
  var fs = require('fs');
  var pathLib = require('path');

  var PORT = 8085;
  var TV_HOST = (typeof process !== 'undefined' && process.env && process.env.TV_HOST) || '127.0.0.1';
  var ON_TV = TV_HOST === '127.0.0.1';
  var SHARE_DIR = '/home/owner/share';
  var CONFIG_FILE = fs.existsSync(SHARE_DIR) ? SHARE_DIR + '/tvdeck.json' : pathLib.resolve('.tvdeck.json');
  var TIZENBREW_CONFIG = SHARE_DIR + '/tizenbrewConfig.json';
  var ICON_ROOTS = ['/opt/', '/usr/'];
  var ICON_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  var MAX_BODY = 64 * 1024;

  var fetchFn = typeof fetch === 'function' ? fetch : require('node-fetch');
  var WebSocket = loadWebSocket();

  var pin = String(1000 + Math.floor(Math.random() * 9000));
  var pinFailures = { count: 0, lockedUntil: 0 };
  var inbox = [];
  var deviceIP = null;
  var config = readConfig();

  /* ---------- Config ---------- */

  function defaultConfig() {
    return {
      remoteToken: '',
      calendarUrl: '',
      haUrl: '',
      haToken: '',
      haEntities: '',
      inputs: 'HDMI 1=KEY_HDMI1\nHDMI 2=KEY_HDMI2\nHDMI 3=KEY_HDMI3\nLive TV=KEY_TV'
    };
  }

  function readConfig() {
    var cfg = defaultConfig();
    try {
      var saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      Object.keys(cfg).forEach(function (k) { if (typeof saved[k] === 'string') cfg[k] = saved[k]; });
    } catch (e) { /* first run */ }
    return cfg;
  }

  function writeConfig() {
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (e) {
      console.log('[tvdeck] could not save config: ' + e.message);
    }
  }

  function publicSettings() {
    return {
      calendarUrl: config.calendarUrl,
      haUrl: config.haUrl,
      haTokenSet: !!config.haToken,
      haEntities: config.haEntities,
      inputs: config.inputs
    };
  }

  function parseInputs() {
    return config.inputs.split('\n').map(function (line) {
      var parts = line.split('=');
      var name = (parts[0] || '').trim();
      var key = (parts[1] || '').trim().toUpperCase();
      return name && /^KEY_[A-Z0-9_]+$/.test(key) ? { name: name, key: key } : null;
    }).filter(Boolean);
  }

  /* ---------- Device IP ---------- */

  function localInterfaceIP() {
    var nets = require('os').networkInterfaces();
    Object.keys(nets).forEach(function (name) {
      nets[name].forEach(function (net) {
        if (!deviceIP && (net.family === 'IPv4' || net.family === 4) && !net.internal) deviceIP = net.address;
      });
    });
  }

  // On the TV, ask the TV's own REST API; in development, use this machine's IP.
  function loadDeviceIP() {
    if (!ON_TV) return localInterfaceIP();
    fetchFn('http://127.0.0.1:8001/api/v2/')
      .then(function (res) { return res.json(); })
      .then(function (json) { deviceIP = json.device.ip; })
      .catch(localInterfaceIP);
  }

  /* ---------- TV remote keys (wss://:8002) ---------- */

  function loadWebSocket() {
    var names = ['ws-new', 'ws-old', 'ws'];
    for (var i = 0; i < names.length; i++) {
      try { return require(names[i]); } catch (e) { /* try next */ }
    }
    return null;
  }

  var remote = { socket: null, ready: false, queue: [] };

  function remoteUrl() {
    var name = (Buffer.from ? Buffer.from('TVDeck') : new Buffer('TVDeck')).toString('base64');
    var url = 'wss://' + TV_HOST + ':8002/api/v2/channels/samsung.remote.control?name=' + name;
    return config.remoteToken ? url + '&token=' + config.remoteToken : url;
  }

  function connectRemote() {
    if (!WebSocket || remote.socket) return;
    var socket = new WebSocket(remoteUrl(), { rejectUnauthorized: false });
    remote.socket = socket;
    socket.on('message', function (raw) {
      var msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg.event === 'ms.channel.connect') {
        if (msg.data && msg.data.token && msg.data.token !== config.remoteToken) {
          config.remoteToken = String(msg.data.token);
          writeConfig();
        }
        remote.ready = true;
        flushKeys();
      } else if (msg.event === 'ms.channel.unauthorized') {
        socket.close();
      }
    });
    socket.on('close', function () {
      remote.socket = null;
      remote.ready = false;
    });
    socket.on('error', function () { /* close follows */ });
  }

  function flushKeys() {
    while (remote.ready && remote.queue.length) {
      remote.socket.send(JSON.stringify({
        method: 'ms.remote.control',
        params: { Cmd: 'Click', DataOfCmd: remote.queue.shift(), Option: 'false', TypeOfRemote: 'SendRemoteKey' }
      }));
    }
  }

  function sendKey(key) {
    remote.queue.push(key);
    if (remote.ready) flushKeys(); else connectRemote();
  }

  /* ---------- Calendar (ICS) ---------- */

  function unfoldIcs(text) {
    return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  }

  function parseIcsDate(value, params) {
    var m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
    if (!m) return null;
    var y = +m[1], mo = +m[2] - 1, d = +m[3];
    if (!m[4]) return { date: new Date(y, mo, d), allDay: true };
    var date = m[7]
      ? new Date(Date.UTC(y, mo, d, +m[4], +m[5], +m[6]))
      : new Date(y, mo, d, +m[4], +m[5], +m[6]); // TZID times treated as TV local time
    return { date: date, allDay: /VALUE=DATE(?!-)/.test(params) };
  }

  function parseIcs(text) {
    var events = [];
    var current = null;
    unfoldIcs(text).forEach(function (line) {
      if (line === 'BEGIN:VEVENT') { current = { exdates: [] }; return; }
      if (line === 'END:VEVENT') { if (current && current.start) events.push(current); current = null; return; }
      if (!current) return;
      var colon = line.indexOf(':');
      if (colon === -1) return;
      var head = line.slice(0, colon);
      var value = line.slice(colon + 1);
      var name = head.split(';')[0];
      if (name === 'SUMMARY') current.title = value.replace(/\\,/g, ',').replace(/\\n/g, ' ');
      else if (name === 'DTSTART') current.start = parseIcsDate(value, head);
      else if (name === 'RRULE') current.rrule = value;
      else if (name === 'EXDATE') {
        value.split(',').forEach(function (v) {
          var ex = parseIcsDate(v, head);
          if (ex) current.exdates.push(ex.date.getTime());
        });
      }
    });
    return events;
  }

  // Expands DAILY / WEEKLY (with BYDAY) / MONTHLY / YEARLY rules inside [from, to).
  function occurrences(event, from, to) {
    var start = event.start.date;
    if (!event.rrule) return start >= from && start < to ? [start] : [];
    var rule = {};
    event.rrule.split(';').forEach(function (part) {
      var kv = part.split('=');
      rule[kv[0]] = kv[1];
    });
    var interval = +(rule.INTERVAL || 1);
    var until = rule.UNTIL ? parseIcsDate(rule.UNTIL, '') : null;
    var count = rule.COUNT ? +rule.COUNT : Infinity;
    var dayCodes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    var byDay = rule.BYDAY ? rule.BYDAY.split(',').map(function (d) { return dayCodes.indexOf(d.slice(-2)); }) : null;
    var out = [];
    var n = 0;
    var cursor = new Date(start.getTime());
    for (var guard = 0; guard < 3000 && cursor < to && n < count; guard++) {
      if (until && cursor > until.date) break;
      var candidates = [];
      if (rule.FREQ === 'WEEKLY' && byDay) {
        var weekStart = new Date(cursor.getTime());
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        byDay.forEach(function (dow) {
          var c = new Date(weekStart.getTime());
          c.setDate(c.getDate() + dow);
          if (c >= start) candidates.push(c);
        });
        candidates.sort(function (a, b) { return a - b; });
      } else {
        candidates.push(new Date(cursor.getTime()));
      }
      for (var i = 0; i < candidates.length && n < count; i++) {
        var occ = candidates[i];
        if (until && occ > until.date) break;
        n++;
        if (occ >= from && occ < to && event.exdates.indexOf(occ.getTime()) === -1) out.push(occ);
      }
      if (rule.FREQ === 'DAILY') cursor.setDate(cursor.getDate() + interval);
      else if (rule.FREQ === 'WEEKLY') cursor.setDate(cursor.getDate() + 7 * interval);
      else if (rule.FREQ === 'MONTHLY') cursor.setMonth(cursor.getMonth() + interval);
      else if (rule.FREQ === 'YEARLY') cursor.setFullYear(cursor.getFullYear() + interval);
      else break;
    }
    return out;
  }

  var calendarCache = { at: 0, url: '', events: [] };

  function upcomingEvents() {
    if (!config.calendarUrl) return Promise.resolve([]);
    var url = config.calendarUrl.replace(/^webcal:/, 'https:');
    if (calendarCache.url === url && Date.now() - calendarCache.at < 10 * 60 * 1000) {
      return Promise.resolve(calendarCache.events);
    }
    return fetchFn(url).then(function (res) { return res.text(); }).then(function (text) {
      var now = new Date();
      var from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      var to = new Date(from.getTime() + 7 * 86400000);
      var list = [];
      parseIcs(text).forEach(function (event) {
        occurrences(event, from, to).forEach(function (date) {
          if (!event.start.allDay && date < now) return;
          list.push({ title: event.title || '(no title)', start: date.getTime(), allDay: event.start.allDay });
        });
      });
      list.sort(function (a, b) { return a.start - b.start; });
      calendarCache = { at: Date.now(), url: url, events: list.slice(0, 6) };
      return calendarCache.events;
    });
  }

  /* ---------- Home Assistant ---------- */

  function haRequest(path, body) {
    var base = config.haUrl.replace(/\/+$/, '');
    return fetchFn(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + config.haToken, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('Home Assistant HTTP ' + res.status);
      return res.json();
    });
  }

  function haEntityIds() {
    return config.haEntities.split(/[\s,]+/).filter(function (id) { return /^[a-z_]+\.[a-z0-9_]+$/.test(id); });
  }

  function haStates() {
    if (!config.haUrl || !config.haToken) return Promise.resolve([]);
    var ids = haEntityIds();
    return haRequest('/api/states').then(function (states) {
      return states.filter(function (s) { return ids.indexOf(s.entity_id) !== -1; }).map(function (s) {
        var a = s.attributes || {};
        return {
          id: s.entity_id,
          domain: s.entity_id.split('.')[0],
          name: a.friendly_name || s.entity_id,
          state: s.state,
          unit: a.unit_of_measurement || '',
          mediaTitle: a.media_title || '',
          mediaArtist: a.media_artist || a.media_album_name || ''
        };
      }).sort(function (x, y) { return ids.indexOf(x.id) - ids.indexOf(y.id); });
    });
  }

  function haAction(entityId) {
    if (haEntityIds().indexOf(entityId) === -1) return Promise.reject(new Error('Unknown entity'));
    var domain = entityId.split('.')[0];
    var service = {
      media_player: 'media_player/media_play_pause',
      scene: 'scene/turn_on',
      script: 'script/turn_on',
      button: 'button/press'
    }[domain] || 'homeassistant/toggle';
    return haRequest('/api/services/' + service, { entity_id: entityId });
  }

  /* ---------- TizenBrew config ---------- */

  function tizenbrewConfig() {
    try {
      var cfg = JSON.parse(fs.readFileSync(TIZENBREW_CONFIG, 'utf8'));
      return { autoLaunchModule: cfg.autoLaunchModule || '', autoLaunchServiceList: cfg.autoLaunchServiceList || [] };
    } catch (e) {
      return { autoLaunchModule: '', autoLaunchServiceList: [] };
    }
  }

  /* ---------- HTTP ---------- */

  function isLocal(req) {
    var addr = req.socket.remoteAddress || '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  }

  function send(res, status, body, type) {
    var isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, {
      'Content-Type': type || (isJson ? 'application/json' : 'text/html; charset=utf-8'),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    });
    res.end(isJson ? JSON.stringify(body) : body);
  }

  function readBody(req) {
    return new Promise(function (resolve, reject) {
      var chunks = [];
      var size = 0;
      req.on('data', function (chunk) {
        size += chunk.length;
        if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', function () {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); }
      });
    });
  }

  // 4-digit PIN: lock out for a minute after 10 wrong guesses.
  function checkPin(value) {
    if (Date.now() < pinFailures.lockedUntil) return false;
    if (value === pin) { pinFailures.count = 0; return true; }
    if (++pinFailures.count >= 10) {
      pinFailures.count = 0;
      pinFailures.lockedUntil = Date.now() + 60000;
    }
    return false;
  }

  function phoneUrl() {
    return deviceIP ? 'http://' + deviceIP + ':' + PORT + '/?pin=' + pin : '';
  }

  function serveIcon(res, iconPath) {
    var resolved = pathLib.normalize(iconPath || '');
    var type = ICON_TYPES[pathLib.extname(resolved).toLowerCase()];
    var allowed = ICON_ROOTS.some(function (root) { return resolved.indexOf(root) === 0; });
    if (!type || !allowed) return send(res, 400, { error: 'Not an icon' });
    fs.readFile(resolved, function (err, data) {
      if (err) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=86400' });
      res.end(data);
    });
  }

  function fail(res) {
    return function (err) { send(res, 502, { error: err.message }); };
  }

  function handle(req, res) {
    var url = require('url').parse(req.url, true);
    var route = req.method + ' ' + url.pathname;
    var local = isLocal(req);

    if (req.method === 'OPTIONS') return send(res, 204, '');

    // Phone routes
    if (route === 'GET /') return send(res, 200, PHONE_PAGE);
    if (route === 'POST /api/send') {
      return readBody(req).then(function (body) {
        if (!checkPin(body.pin)) return send(res, 403, { error: 'Wrong PIN' });
        var item = body.url ? { type: 'url', value: String(body.url).slice(0, 2000) }
          : body.text ? { type: 'text', value: String(body.text).slice(0, 500) } : null;
        if (!item) return send(res, 400, { error: 'Nothing to send' });
        item.at = Date.now();
        inbox.push(item);
        if (inbox.length > 10) inbox.shift();
        send(res, 200, { ok: true });
      }).catch(fail(res));
    }
    if (route === 'GET /api/settings') {
      if (!checkPin(url.query.pin)) return send(res, 403, { error: 'Wrong PIN' });
      return send(res, 200, publicSettings());
    }
    if (route === 'POST /api/settings') {
      return readBody(req).then(function (body) {
        if (!checkPin(body.pin)) return send(res, 403, { error: 'Wrong PIN' });
        ['calendarUrl', 'haUrl', 'haEntities', 'inputs'].forEach(function (k) {
          if (typeof body[k] === 'string') config[k] = body[k].trim();
        });
        if (typeof body.haToken === 'string' && body.haToken.trim()) config.haToken = body.haToken.trim();
        if (body.clearHaToken) config.haToken = '';
        calendarCache.at = 0;
        writeConfig();
        send(res, 200, publicSettings());
      }).catch(fail(res));
    }

    // Launcher routes: same device only
    if (!local) return send(res, 404, { error: 'Not found' });

    if (route === 'GET /api/info') {
      return send(res, 200, { ip: deviceIP, port: PORT, pin: pin, phoneUrl: phoneUrl() });
    }
    if (route === 'GET /api/inbox') {
      var items = inbox;
      inbox = [];
      return send(res, 200, { items: items });
    }
    if (route === 'POST /api/key') {
      return readBody(req).then(function (body) {
        if (!/^KEY_[A-Z0-9_]+$/.test(body.key || '')) return send(res, 400, { error: 'Bad key' });
        sendKey(body.key);
        send(res, 200, { ok: true });
      }).catch(fail(res));
    }
    if (route === 'GET /api/icon') return serveIcon(res, url.query.path);
    if (route === 'GET /api/inputs') return send(res, 200, { inputs: parseInputs() });
    if (route === 'GET /api/calendar') {
      return upcomingEvents().then(function (events) {
        send(res, 200, { configured: !!config.calendarUrl, events: events });
      }).catch(fail(res));
    }
    if (route === 'GET /api/ha/states') {
      return haStates().then(function (entities) {
        send(res, 200, { configured: !!(config.haUrl && config.haToken), entities: entities });
      }).catch(fail(res));
    }
    if (route === 'POST /api/ha/action') {
      return readBody(req).then(function (body) {
        return haAction(String(body.entity_id || '')).then(function () { send(res, 200, { ok: true }); });
      }).catch(fail(res));
    }
    if (route === 'GET /api/tizenbrew') return send(res, 200, tizenbrewConfig());

    send(res, 404, { error: 'Not found' });
  }

  /* ---------- Phone page ---------- */

  var PHONE_PAGE = [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>TVDeck</title><style>',
    ':root{color-scheme:dark}body{margin:0;font:17px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:#000;color:#fff}',
    'main{max-width:560px;margin:0 auto;padding:28px 16px 48px}h1{font-size:34px;font-weight:700;letter-spacing:-.02em;margin:8px 4px 4px}',
    'h2{font-size:13px;font-weight:400;color:rgba(235,235,245,.6);text-transform:uppercase;letter-spacing:.02em;margin:28px 16px 8px}',
    '.group{background:#1c1c1e;border-radius:12px;padding:4px 16px 16px}',
    'label{display:block;font-size:13px;color:rgba(235,235,245,.6);margin:12px 0 6px}',
    'input,textarea{width:100%;box-sizing:border-box;padding:11px 12px;border:0;border-radius:10px;background:#2c2c2e;color:inherit;font:inherit}',
    'input:focus,textarea:focus{outline:2px solid #0a84ff;outline-offset:0}textarea{min-height:96px}',
    'button{width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;background:#0a84ff;color:#fff;font:600 17px -apple-system,system-ui,sans-serif}',
    'button:active{opacity:.7}.msg{min-height:20px;margin:8px 4px 0;font-size:14px;color:rgba(235,235,245,.6)}',
    '.hint{font-size:13px;color:rgba(235,235,245,.6);margin:8px 0 0}</style></head><body><main>',
    '<h1>TVDeck</h1>',
    '<h2>Send to TV</h2><div class="group">',
    '<label for="link">Link or text</label><input id="link" placeholder="Paste a link or type a message" autocomplete="off">',
    '<button id="send">Send to TV</button></div><div class="msg" id="send-msg"></div>',
    '<h2>Inputs</h2><div class="group">',
    '<label for="inputs">One per line: Name=KEY</label><textarea id="inputs"></textarea>',
    '<p class="hint">Keys: KEY_HDMI1-4, KEY_TV, KEY_SOURCE. Example: PlayStation=KEY_HDMI2</p></div>',
    '<h2>Calendar</h2><div class="group">',
    '<label for="calendarUrl">Secret iCal address (.ics)</label><input id="calendarUrl" placeholder="https://calendar.google.com/calendar/ical/...">',
    '<p class="hint">Google Calendar: Settings, your calendar, Integrate calendar, Secret address in iCal format.</p></div>',
    '<h2>Home Assistant</h2><div class="group">',
    '<label for="haUrl">URL</label><input id="haUrl" placeholder="http://homeassistant.local:8123">',
    '<label for="haToken">Long-lived access token</label><input id="haToken" type="password" placeholder="Leave empty to keep the saved token">',
    '<label for="haEntities">Entities (comma or newline separated)</label><textarea id="haEntities" placeholder="light.living_room, media_player.spotify"></textarea>',
    '</div><button id="save">Save settings</button><div class="msg" id="save-msg"></div>',
    '</main><script>',
    'var pin=new URLSearchParams(location.search).get("pin")||prompt("PIN shown on the TV")||"";',
    'function $(id){return document.getElementById(id)}',
    'function post(path,body){body.pin=pin;return fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||r.status);return j})})}',
    'function fill(s){["calendarUrl","haUrl","haEntities","inputs"].forEach(function(k){$(k).value=s[k]||""});$("haToken").placeholder=s.haTokenSet?"Saved. Leave empty to keep it":"Paste token"}',
    'fetch("/api/settings?pin="+encodeURIComponent(pin)).then(function(r){return r.json()}).then(function(s){if(s.error){$("save-msg").textContent=s.error}else fill(s)});',
    '$("send").onclick=function(){var v=$("link").value.trim();if(!v)return;var isUrl=/^(https?:\\/\\/|www\\.)/i.test(v);',
    'post("/api/send",isUrl?{url:/^www\\./i.test(v)?"https://"+v:v}:{text:v}).then(function(){$("send-msg").textContent="Sent";$("link").value=""}).catch(function(e){$("send-msg").textContent=e.message})};',
    '$("save").onclick=function(){post("/api/settings",{calendarUrl:$("calendarUrl").value,haUrl:$("haUrl").value,haToken:$("haToken").value,haEntities:$("haEntities").value,inputs:$("inputs").value})',
    '.then(function(s){fill(s);$("haToken").value="";$("save-msg").textContent="Saved"}).catch(function(e){$("save-msg").textContent=e.message})};',
    '</script></body></html>'
  ].join('\n');

  /* ---------- Start ---------- */

  loadDeviceIP();
  if (ON_TV) connectRemote();
  http.createServer(function (req, res) {
    try { handle(req, res); } catch (e) { send(res, 500, { error: e.message }); }
  }).listen(PORT, '0.0.0.0', function () {
    console.log('[tvdeck] service listening on :' + PORT + ' (PIN ' + pin + ')');
  });
})();
