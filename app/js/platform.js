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
  var TB_EVENTS = { GetModules: 4, LaunchModule: 5 };

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
    registerKeys: registerKeys,
    exit: exit
  };
})();
