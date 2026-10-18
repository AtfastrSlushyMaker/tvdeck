/*
 * Current weather from Open-Meteo (free, no API key, no tracking).
 * Results are cached for 30 minutes.
 */
var Weather = (function () {
  'use strict';

  var CACHE_KEY = 'tvdeck:weather';
  var TTL_MS = 30 * 60 * 1000;

  // WMO weather codes -> [label, glyph]
  var CODES = {
    0: ['Clear', '☀'], 1: ['Mostly clear', '🌤'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁'],
    45: ['Fog', '🌫'], 48: ['Fog', '🌫'],
    51: ['Drizzle', '🌦'], 53: ['Drizzle', '🌦'], 55: ['Drizzle', '🌦'],
    61: ['Rain', '🌧'], 63: ['Rain', '🌧'], 65: ['Heavy rain', '🌧'],
    71: ['Snow', '🌨'], 73: ['Snow', '🌨'], 75: ['Heavy snow', '🌨'],
    80: ['Showers', '🌦'], 81: ['Showers', '🌦'], 82: ['Heavy showers', '⛈'],
    95: ['Thunderstorm', '⛈'], 96: ['Thunderstorm', '⛈'], 99: ['Thunderstorm', '⛈']
  };

  function getJSON(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function readCache(city) {
    try {
      var cached = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (cached && cached.city === city && Date.now() - cached.at < TTL_MS) return cached.data;
    } catch (e) { /* ignore */ }
    return null;
  }

  function writeCache(city, data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ city: city, at: Date.now(), data: data }));
    } catch (e) { /* ignore */ }
  }

  function fetchCurrent(city) {
    var cached = readCache(city);
    if (cached) return Promise.resolve(cached);

    var geoUrl = 'https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(city);
    return getJSON(geoUrl).then(function (geo) {
      if (!geo.results || !geo.results.length) throw new Error('City not found');
      var place = geo.results[0];
      var url = 'https://api.open-meteo.com/v1/forecast?current=temperature_2m,weather_code' +
        '&latitude=' + place.latitude + '&longitude=' + place.longitude;
      return getJSON(url).then(function (forecast) {
        var code = forecast.current.weather_code;
        var info = CODES[code] || ['', '🌡'];
        var data = {
          place: place.name,
          temp: Math.round(forecast.current.temperature_2m),
          label: info[0],
          glyph: info[1]
        };
        writeCache(city, data);
        return data;
      });
    });
  }

  return { fetchCurrent: fetchCurrent };
})();
