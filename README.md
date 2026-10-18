# TVDeck

A fast, ad-free home launcher for Samsung Tizen TVs. It runs as a
[TizenBrew](https://github.com/reisxd/TizenBrew) app module, so no Samsung
certificate or Tizen Studio is needed to install it.

TVDeck is an independent project and is not affiliated with TizenBrew or Samsung.

## Features

- **Favorites row**: pin any app, TizenBrew module or web shortcut, and reorder them.
- **All installed TV apps**: read straight from the TV and launched natively. Hide the ones you never use.
- **TizenBrew modules**: open your other modules (TizenTube, Twitch…) from the same screen.
- **Web shortcuts**: add your own sites from Settings.
- **Clock and weather**: weather comes from [Open-Meteo](https://open-meteo.com) (no API key, no tracking).
- **No ads, no telemetry**, nothing sent anywhere except the weather lookup.

## Remote controls

| Key | Action |
|---|---|
| Arrows / OK | Move / open |
| 🔴 Red | Pin or unpin the focused tile to Favorites |
| 🟢 Green | Settings |
| 🟡 Yellow | Reorder (in Favorites) or hide an app (in Apps) |
| 🔵 Blue | Refresh apps and modules |
| CH+ / CH− | Jump between rows |
| Back | Close settings, cancel a move |

## Install on your TV

1. Install TizenBrew on the TV (Developer Mode on).
2. Open TizenBrew → **Module Manager** → **Add module**.
3. Enter `tvdeck` (npm), or `gh/<user>/tvdeck` to load straight from GitHub.
4. Optional: set TVDeck as TizenBrew's **auto-launch** module so it opens when TizenBrew starts.

## Development

The UI runs in a desktop browser with mock data:

```bash
npm run dev
```

Then open <http://localhost:5173>. Keyboard: arrows, Enter, Esc (Back),
R/G/Y/B (color keys), PgUp/PgDn (channel up/down).

Notes:

- Target is the Chromium build on Tizen 6 (2021 TVs, Chromium 76). Avoid
  optional chaining, `??`, flexbox `gap` and `inset`.
- TizenBrew serves module files through jsDelivr, so use **relative** asset
  paths only.
- `app/js/platform.js` is the only file that talks to Tizen/TizenBrew APIs.

## Publish

```bash
npm publish
```

jsDelivr caches packages, so a new version can take a few minutes to reach the TV.

## License

MIT
