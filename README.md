<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/tvdeck-wordmark.png">
    <img src="assets/brand/tvdeck-wordmark-dark.png" alt="TVDeck" width="420">
  </picture>
</p>

A fast, ad-free home launcher for Samsung Tizen TVs. It runs as a
[TizenBrew](https://github.com/reisxd/TizenBrew) app module, so no Samsung
certificate or Tizen Studio is needed to install it.

TVDeck is an independent project and is not affiliated with TizenBrew or Samsung.

## Features

- **Top bar**: Settings and Send from phone are one press of Up away from the dock, and the time and weather stay pinned while you scroll.
- **Favorites row**: pin any app, input, TizenBrew module or web shortcut, and reorder them.
- **Recent row**: the last things you opened, most recent first.
- **Inputs**: switch to HDMI 1–3 or Live TV from the launcher. Rename them or add more from your phone.
- **All installed TV apps**: read straight from the TV and launched natively, with their real icons. Hide the ones you never use.
- **Auto categories**: apps are sorted into Streaming, Video, Music, Sports, Kids, Games, News, Lifestyle and Utilities rows (by name, then Tizen's own category data). Turn it off in Settings for a single Apps row.
- **Feels alive**: the backdrop takes its color from the focused app and slowly drifts; focus carries momentum, bumps at row edges, and idles with a soft float and glint; the status line under the clock rotates through your next event, what's playing and the weather.
- **Polished motion**: exits accelerate away (ease-in) faster than entrances arrive; holding an arrow switches to quick, simple motion; logos fade in once and parallax slightly against their tiles; hints step aside after a few idle seconds.
- **UI sounds** (on by default): modeled taps that ring like glass or wood, with a short room tail, synthesized with Web Audio (no audio files). Soft is the default; pick Soft, Glass or Wood with the selector in Settings → General, and each one previews as you move to it.
- **Ambient screen**: after 5 idle minutes the launcher fades to a large clock over a wash that cycles through your apps' colors. Any key wakes it.
- **TizenBrew modules**: open your other modules (TizenTube, Twitch…) from the same screen.
- **Send from phone**: scan the QR code, paste a link, and the TV offers to open it.
- **At a glance**: upcoming events from any iCal feed (Google, iCloud, Outlook) and Home Assistant entities: toggle lights or switches, and see what's playing on media players.
- **Web shortcuts**: add your own sites from Settings.
- **Clock and weather**: weather comes from [Open-Meteo](https://open-meteo.com) (no API key, no tracking).
- **Auto-start**: open TVDeck when TizenBrew starts, and start the phone service at boot.
- **Guided settings**: a short menu of pages; options that can't be used yet are shown disabled with the reason and what unlocks them, and destructive actions ask for a second OK in place.
- **Updates & diagnostics**: see the launcher and service build when known, check service connectivity and check GitHub for a newer launcher. Restart TVDeck to load a checked update; service updates happen on service restart.
- **Personal categories**: Settings → App categories lets you override each app's automatic category or return it to Auto.
- **Phone favorites**: with TVDeck open, scan its phone QR code to add, rename, remove and reorder favorite shortcuts or pin installed apps and inputs. Changes are sent to the running launcher; stale edits must be reloaded before saving.
- **No ads, no telemetry**. The only outside requests are the weather lookup and the calendar and Home Assistant you configure.

## How it works

```
TV ─ TizenBrew ─┬─ app/        launcher UI (served via jsDelivr)
                └─ service/    Node.js service, port 8085
                     ├─ phone page + link inbox (PIN protected)
                     ├─ remote keys → TV's own control API (wss://127.0.0.1:8002)
                     ├─ app icons from the TV filesystem
                     └─ calendar / Home Assistant proxy (keeps the token off the page)
```

The service starts when TVDeck is opened from TizenBrew, or at boot if enabled in Settings.
The first time it sends a remote key, the TV asks to allow "TVDeck". Accept it once.

## Requirements

- TizenBrew needs the TV's **Developer IP set to `127.0.0.1`**. If you pointed
  Developer Mode at a computer to sideload something, set it back, or
  TizenBrew modules like TizenTube can't start.

## Remote controls

| Key | Action |
|---|---|
| Arrows / OK | Move / open |
| 🔴 Red | Pin or unpin the focused tile to Favorites |
| 🟢 Green | Settings |
| 🟡 Yellow | Reorder (in Favorites) or hide an app (in Apps) |
| 🔵 Blue | Refresh everything |
| CH+ / CH− | Jump between rows |
| Up (from the dock) | Top bar: Settings, Send from phone |
| Back | Close a panel, return to the dock, then asks before leaving TVDeck |

## Install on your TV

1. Install TizenBrew on the TV (Developer Mode on).
2. Open TizenBrew → **Module Manager** → **Add module**.
3. Enter `tvdeck` (npm), or `gh/<user>/tvdeck` to load straight from GitHub.
4. Optional: set TVDeck as TizenBrew's **auto-launch** module so it opens when TizenBrew starts.

## Brand

Source artwork lives in `assets/brand/` (not shipped to the TV): the master
icon, transparent and white marks, the wordmark (white text for dark
backgrounds, `-dark` for light), and the unused concepts.
`app/img/` holds the small optimized copies the launcher uses, and the
phone page's icon is embedded in `service/service.js`.

## Development

The UI runs in a desktop browser with mock data:

```bash
npm run dev
```

Then open <http://localhost:5173> (add `?ambient` to see the ambient screen after 4 seconds). Keyboard: arrows, Enter, Esc (Back),
R/G/Y/B (color keys), PgUp/PgDn (channel up/down).

To develop the phone page, widgets and inputs, run the service too:

```bash
TV_HOST=192.168.1.10 npm run service
```

With `TV_HOST` set, input tiles send **real** remote keys to that TV. The
service saves its settings to `.tvdeck.json` (git-ignored) when run off the TV.

Notes:

- Target is the Chromium build on Tizen 6 (2021 TVs, Chromium 76). Avoid
  optional chaining, `??`, flexbox `gap` and `inset`.
- TizenBrew serves module files through jsDelivr, so use **relative** asset
  paths only.
- `app/js/platform.js` is the only file that talks to Tizen/TizenBrew APIs.
- `service/service.js` runs on the TV's Node (as old as v4 on Tizen 3): ES5 only.
- `app/vendor/qrcode.js` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 (MIT).

## Publish

```bash
npm publish
```

jsDelivr caches packages, so a new version can take a few minutes to reach the TV.

## License

MIT
