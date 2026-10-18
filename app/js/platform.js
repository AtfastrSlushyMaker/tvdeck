/*
 * Platform layer: talks to the Tizen web APIs and the TizenBrew service.
 * Falls back to mock data when opened in a desktop browser, so the UI can be
 * developed without a TV.
 *
 * Tizen 6 ships an old Chromium: no optional chaining, no `??`.
 */
var Platform = (function () {
  'use strict';

  var IS_TV = typeof tizen !== 'undefined' && !!tizen.application;
  var SELF_PACKAGE = 'tvdeck';
  var TB_SOCKET = 'ws://localhost:8081';
  var TB_EVENTS = { GetModules: 4, LaunchModule: 5, ModuleAction: 10 };

  // Apps that clutter the list on Samsung TVs and are never launched by hand.
  var HIDDEN_APP_PATTERNS = [
    /^org\.tizen\./,
    /^com\.samsung\.tv\.(?!store)/,
    /widget/i,
    /service$/i
  ];

  var MOCK_APPS = [
    { id: '3201907018807', name: 'Netflix' },
    { id: '111299001912', name: 'YouTube' },
    { id: '3201910019365', name: 'Prime Video' },
    { id: '3201901017640', name: 'Disney+' },
    { id: '3201606009684', name: 'Spotify' },
    { id: '3202010022079', name: 'Stremio' },
    { id: '3201807016597', name: 'Apple TV' },
    { id: 'com.samsung.tv.store', name: 'Apps' },
    { id: 'org.tizen.browser', name: 'Internet' }
  ];

  var MOCK_MODULES = [
    { fullName: 'npm/@foxreis/tizentube', appName: 'TizenTube', appPath: 'https://www.youtube.com/tv', keys: [], packageType: 'mods' },
    { fullName: 'npm/@gforceweb/smarttv-twitch-hls', appName: 'Twitch', appPath: '#', keys: [], packageType: 'app' }
  ];

  function isHiddenApp(info) {
    if (info.show === false) return true;
    for (var i = 0; i < HIDDEN_APP_PATTERNS.length; i++) {
      if (HIDDEN_APP_PATTERNS[i].test(info.id)) return true;
    }
    return false;
  }

  function listApps() {
    if (!IS_TV) return Promise.resolve(MOCK_APPS.slice());
    return new Promise(function (resolve) {
      tizen.application.getAppsInfo(function (infos) {
        var apps = infos
          .filter(function (info) { return info.name && !isHiddenApp(info); })
          .map(function (info) {
            return { id: info.id, name: info.name, icon: info.iconPath || '' };
          })
          .sort(function (a, b) { return a.name.localeCompare(b.name); });
        resolve(apps);
      }, function () { resolve([]); });
    });
  }

  function launchApp(id) {
    if (!IS_TV) {
      console.log('[mock] launch app', id);
      return Promise.resolve();
    }
    return new Promise(function (resolve, reject) {
      tizen.application.launch(id, resolve, reject);
    });
  }

  // TizenBrew's service answers GetModules with null until it has fetched
  // every module's package.json, so retry until we get a list.
  function listModules() {
    if (!IS_TV) return Promise.resolve(MOCK_MODULES.slice());
    return new Promise(function (resolve) {
      var socket;
      var settled = false;
      function finish(modules) {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch (e) { /* already closed */ }
        resolve(modules);
      }
      try {
        socket = new WebSocket(TB_SOCKET);
      } catch (e) {
        return resolve([]);
      }
      socket.onopen = function () {
        socket.send(JSON.stringify({ type: TB_EVENTS.GetModules }));
      };
      socket.onmessage = function (event) {
        var data = JSON.parse(event.data);
        if (data.type !== TB_EVENTS.GetModules) return;
        if (data.payload === null) {
          setTimeout(function () {
            if (!settled) socket.send(JSON.stringify({ type: TB_EVENTS.GetModules }));
          }, 500);
          return;
        }
        finish(data.payload.filter(function (mod) {
          return mod.appPath && mod.fullName.indexOf(SELF_PACKAGE) === -1;
        }));
      };
      socket.onerror = function () { finish([]); };
      setTimeout(function () { finish([]); }, 8000);
    });
  }

  // Mirrors TizenBrew's own Modules.jsx launch flow.
  function launchModule(mod) {
    if (!IS_TV) {
      console.log('[mock] launch module', mod.fullName);
      return;
    }
    (mod.keys || []).forEach(function (key) {
      try { tizen.tvinputdevice.registerKey(key); } catch (e) { /* unsupported key */ }
    });
    var socket = new WebSocket(TB_SOCKET);
    socket.onopen = function () {
      socket.send(JSON.stringify({ type: TB_EVENTS.LaunchModule, payload: mod }));
      if (!mod.evaluateScriptOnDocumentStart) location.href = mod.appPath;
    };
  }

  function openUrl(url) {
    location.href = url;
  }

  // Opens a URL in the TV's own browser app, falling back to this page.
  function openInBrowser(url) {
    if (!IS_TV || !tizen.application.launchAppControl) {
      window.open(url, '_blank');
      return;
    }
    try {
      var control = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', url);
      tizen.application.launchAppControl(control, 'org.tizen.browser', null, function () { openUrl(url); });
    } catch (e) {
      openUrl(url);
    }
  }

  /* ---------- TVDeck service (service/service.js) ---------- */

  var SERVICE = 'http://127.0.0.1:8085';
  var serviceUp = false;

  function service(path, body) {
    var options = body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' }, // avoids a CORS preflight
      body: JSON.stringify(body)
    };
    return fetch(SERVICE + path, options).then(function (res) {
      serviceUp = true;
      return res.json().then(function (json) {
        if (!res.ok) throw new Error(json.error || 'HTTP ' + res.status);
        return json;
      });
    }, function (err) {
      serviceUp = false;
      throw err;
    });
  }

  function sendKey(key) {
    return service('/api/key', { key: key });
  }

  function iconUrl(path) {
    if (!path) return '';
    if (path.indexOf('/') !== 0) return path;
    return serviceUp ? SERVICE + '/api/icon?path=' + encodeURIComponent(path) : 'file://' + path;
  }

  /* ---------- TizenBrew auto-launch ---------- */

  // e.g. "npm/tvdeck" or "gh/user/tvdeck", from /module/<encoded name>/app/index.html
  function selfModuleName() {
    var match = /\/module\/([^/]+)\//.exec(location.pathname);
    return match ? decodeURIComponent(match[1]) : 'npm/' + SELF_PACKAGE;
  }

  function tizenbrewAction(action, module) {
    if (!IS_TV) {
      console.log('[mock] TizenBrew', action, module);
      return;
    }
    var socket = new WebSocket(TB_SOCKET);
    socket.onopen = function () {
      socket.send(JSON.stringify({ type: TB_EVENTS.ModuleAction, payload: { action: action, module: module } }));
      setTimeout(function () { socket.close(); }, 500);
    };
  }

  function setAutoLaunch(enabled) {
    tizenbrewAction('autolaunch', enabled ? selfModuleName() : '');
  }

  // TizenBrew matches services by module name without the "npm/" prefix,
  // and the action replaces the whole list.
  function setServiceAutoLaunch(enabled, currentList) {
    var name = serviceModuleName();
    var list = (currentList || []).filter(function (n) { return n !== name; });
    if (enabled) list.push(name);
    tizenbrewAction('autolaunchService', list);
  }

  function serviceModuleName() {
    var self = selfModuleName();
    return self.slice(self.indexOf('/') + 1);
  }

  function registerKeys(keys) {
    if (!IS_TV || !tizen.tvinputdevice) return;
    keys.forEach(function (key) {
      try { tizen.tvinputdevice.registerKey(key); } catch (e) { /* unsupported key */ }
    });
  }

  function exit() {
    if (IS_TV) tizen.application.getCurrentApplication().hide();
  }

  return {
    isTV: IS_TV,
    listApps: listApps,
    launchApp: launchApp,
    listModules: listModules,
    launchModule: launchModule,
    openUrl: openUrl,
    openInBrowser: openInBrowser,
    service: service,
    sendKey: sendKey,
    iconUrl: iconUrl,
    setAutoLaunch: setAutoLaunch,
    setServiceAutoLaunch: setServiceAutoLaunch,
    selfModuleName: selfModuleName,
    serviceModuleName: serviceModuleName,
    registerKeys: registerKeys,
    exit: exit
  };
})();
