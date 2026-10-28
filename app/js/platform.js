/*
 * Platform layer: talks to the TV through the TVDeck service and TizenBrew.
 * Falls back to mock data when opened in a desktop browser, so the UI can be
 * developed without a TV.
 *
 * TizenBrew serves modules over http, and the TV does not expose the `tizen`
 * API to such pages. So on the TV, app listing, launching, links and exit go
 * through the TVDeck service (service/service.js), which does have `tizen`.
 * Direct `tizen` calls are kept for when it is present.
 *
 * Keep to ES5 (older Tizen engines): no optional chaining, no `??`.
 */
var Platform = (function () {
  'use strict';

  var HAS_TIZEN = typeof tizen !== 'undefined' && !!tizen.application;
  var IS_TV = HAS_TIZEN || /Tizen|SMART-TV/i.test(navigator.userAgent);
  var SELF_PACKAGE = 'tvdeck';
  var SELF_NPM_PACKAGE = '@malek.bsaissa/tvdeck';
  var TB_SOCKET = 'ws://localhost:8081';
  var TB_EVENTS = { GetModules: 4, LaunchModule: 5, ModuleAction: 10 };

  // A Samsung TV reports ~370 apps, mostly system components. Store apps
  // have ids like "IkWsFHtOY9.Stremio" (10-character package + name); the
  // few built-ins people actually open are listed by id.
  var STORE_APP_ID = /^[A-Za-z0-9]{10}\.[A-Za-z0-9_-]+$/;
  var BUILT_IN_APPS = {
    'org.tizen.netflix-app': true,
    'com.samsung.tv.cobalt-yt': true,
    'org.tizen.primevideo': true,
    'org.tizen.browser': true,
    'com.samsung.tv.store': true,
    'com.samsung.tv.gallery': true
  };
  var NEVER_SHOW = { 'xvvl3S1bvH.TizenBrewStandalone': true }; // TizenBrew itself

  // Desktop-only artwork. The TV still uses the icons reported by installed apps.
  function demoArt(name) {
    return (window.TVDECK_BASE || '') + 'img/demo/' + name + '.png';
  }

  var MOCK_APPS = [
    { id: '3201907018807', name: 'Netflix', icon: demoArt('netflix') },
    { id: '111299001912', name: 'YouTube', icon: demoArt('youtube') },
    { id: '3201910019365', name: 'Prime Video', icon: demoArt('prime-video') },
    { id: '3201901017640', name: 'Disney+', icon: demoArt('disney-plus') },
    { id: '3201606009684', name: 'Spotify', icon: demoArt('spotify') },
    { id: '3202306031311', name: 'Stremio', icon: demoArt('stremio') },
    { id: '3201807016597', name: 'Apple TV', icon: demoArt('apple-tv') },
    { id: 'com.samsung.tv.store', name: 'Apps' },
    { id: 'org.tizen.browser', name: 'Internet', icon: demoArt('internet') },
    { id: 'mock.anghami', name: 'Anghami' },
    { id: 'mock.dazn', name: 'DAZN', icon: demoArt('dazn') },
    { id: 'mock.bein', name: 'beIN SPORTS' },
    { id: 'mock.twitch', name: 'Twitch', icon: demoArt('twitch') },
    { id: 'mock.geforce', name: 'GeForce NOW', icon: demoArt('geforce-now') },
    { id: 'mock.aljazeera', name: 'Al Jazeera' },
    { id: 'mock.smartthings', name: 'SmartThings', icon: demoArt('smartthings') },
    { id: 'mock.gallery', name: 'Gallery', icon: demoArt('gallery') }
  ];

  var MOCK_MODULES = [
    { fullName: 'npm/@foxreis/tizentube', appName: 'TizenTube', appPath: '#', keys: [], packageType: 'mods' },
    { fullName: 'npm/@gforceweb/smarttv-twitch-hls', appName: 'Twitch', appPath: '#', keys: [], packageType: 'app' }
  ];

  function isUserApp(info) {
    if (NEVER_SHOW[info.id]) return false;
    if (BUILT_IN_APPS[info.id]) return true;
    return info.show !== false && STORE_APP_ID.test(info.id);
  }

  // "Spotify - Music and Podcasts" -> "Spotify", "TF1+ : Streaming…" -> "TF1+"
  function shortName(name) {
    return name.split(/\s+[-:\u2013|]\s+/)[0].trim();
  }

  var appsError = null;   // why the app list is empty on the TV, if it is

  function tidyApps(infos) {
    return infos
      .filter(function (info) { return info.name && isUserApp(info); })
      .map(function (info) {
        return { id: info.id, name: shortName(info.name), icon: info.iconPath || info.icon || '', categories: info.categories || [] };
      })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  function listApps() {
    if (!IS_TV) return Promise.resolve(MOCK_APPS.slice());
    if (HAS_TIZEN) {
      return new Promise(function (resolve) {
        tizen.application.getAppsInfo(function (infos) { appsError = null; resolve(tidyApps(infos)); },
          function () { resolve([]); });
      });
    }
    return service('/api/apps').then(function (res) {
      appsError = null;
      return tidyApps(res.apps);
    }, function () {
      appsError = 'service';
      return [];
    });
  }

  function launchApp(id) {
    // Some TVs expose YouTube under the Cobalt ID but accept another ID
    // when launching. Only try these alternatives for that specific app.
    var alternatives = id === 'com.samsung.tv.cobalt-yt'
      ? ['111299001912', '9Ur5IzDKqV.TizenYouTube'] : [];
    function attempt(appId) {
      return launchOne(appId).catch(function (error) {
        if (!alternatives.length) throw error;
        return attempt(alternatives.shift());
      });
    }
    return attempt(id);
  }

  function launchOne(id) {
    if (!IS_TV) {
      console.log('[mock] launch app', id);
      return Promise.resolve();
    }
    if (HAS_TIZEN) {
      return new Promise(function (resolve, reject) {
        tizen.application.launch(id, resolve, reject);
      });
    }
    return service('/api/launch', { id: id });
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
      return Promise.resolve();
    }
    registerKeys(mod.keys || []);
    return new Promise(function (resolve, reject) {
      var socket;
      var done = false;
      function finish(error) {
        if (done) return;
        done = true;
        if (error) reject(error); else resolve();
      }
      try { socket = new WebSocket(TB_SOCKET); }
      catch (error) { return finish(error); }
      socket.onopen = function () {
        try {
          socket.send(JSON.stringify({ type: TB_EVENTS.LaunchModule, payload: mod }));
          if (!mod.evaluateScriptOnDocumentStart) location.href = mod.appPath;
          finish();
        } catch (error) { finish(error); }
      };
      socket.onerror = function () { finish(new Error('TizenBrew did not connect')); };
      setTimeout(function () { if (!done) { try { socket.close(); } catch (e) {} finish(new Error('TizenBrew timed out')); } }, 5000);
    });
  }

  function openUrl(url) {
    location.href = url;
  }

  // Opens a URL in the TV's own browser app.
  function openInBrowser(url) {
    if (!IS_TV) {
      window.open(url, '_blank');
      return Promise.resolve();
    }
    if (HAS_TIZEN) {
      return new Promise(function (resolve, reject) {
        var control = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', url);
        tizen.application.launchAppControl(control, 'org.tizen.browser', resolve, reject);
      });
    }
    return service('/api/open', { url: url });
  }

  /* ---------- TVDeck service (service/service.js) ---------- */

  // Read the manifest belonging to the same build that supplied this page's
  // scripts. This works for both TizenBrew's module proxy and pinned builds.
  function appVersion() {
    return fetch((window.TVDECK_BASE || '') + '../package.json').then(function (res) {
      if (!res.ok) throw new Error('TVDeck manifest unavailable');
      return res.json();
    }).then(function (manifest) {
      if (!manifest || typeof manifest.version !== 'string' || !manifest.version.trim()) {
        throw new Error('TVDeck version unavailable');
      }
      return manifest.version.trim();
    });
  }

  // When the service is unavailable, the TV browser can still report its
  // platform version in the user agent. Desktop previews do not invent one.
  function tizenVersionFromUserAgent() {
    if (!IS_TV) return null;
    var match = /\bTizen[\s/]([0-9]+(?:\.[0-9]+)*)/i.exec(navigator.userAgent);
    return match ? match[1] : null;
  }

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
    // On the TV, icons can only be read by the service (file:// is blocked).
    return IS_TV || serviceUp ? SERVICE + '/api/icon?path=' + encodeURIComponent(path) : 'file://' + path;
  }

  /* ---------- TizenBrew auto-launch ---------- */

  // e.g. "npm/@malek.bsaissa/tvdeck" or "gh/user/tvdeck", from the module URL.
  function selfModuleName() {
    var match = /\/module\/([^/]+)\//.exec(location.pathname);
    return match ? decodeURIComponent(match[1]) : 'npm/' + SELF_NPM_PACKAGE;
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

  // Only possible with the tizen API. TizenBrew registers the keys listed in
  // package.json before it opens the module, so the page still gets them.
  function registerKeys(keys) {
    if (!HAS_TIZEN || !tizen.tvinputdevice) return;
    keys.forEach(function (key) {
      try { tizen.tvinputdevice.registerKey(key); } catch (e) { /* unsupported key */ }
    });
  }

  // Ask the TV to close the app. If an HTTP-served module cannot close its
  // window, return to TizenBrew's own UI instead of leaving the user stuck.
  function exit() {
    if (HAS_TIZEN) {
      tizen.application.getCurrentApplication().exit();
      return Promise.resolve();
    }
    if (!IS_TV) return Promise.resolve();
    try { window.close(); } catch (e) { /* fall through to TizenBrew */ }
    return new Promise(function (resolve) { setTimeout(resolve, 600); }).then(function () {
      window.location.replace('/tizenbrew-ui/dist/index.html');
    });
  }

  return {
    isTV: IS_TV,
    appsError: function () { return appsError; },
    listApps: listApps,
    launchApp: launchApp,
    listModules: listModules,
    launchModule: launchModule,
    openUrl: openUrl,
    openInBrowser: openInBrowser,
    appVersion: appVersion,
    tizenVersionFromUserAgent: tizenVersionFromUserAgent,
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
