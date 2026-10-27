# EUC Planet Trip Viewer

[![License: MIT](https://img.shields.io/github/license/eried/eucviewer)](LICENSE)
[![Live](https://img.shields.io/badge/Live-eucviewer.ried.no-39d98a)](https://eucviewer.ried.no)
[![App: EUC Planet](https://img.shields.io/badge/App-EUC_Planet-3DDC84?logo=googleplay&logoColor=white)](https://github.com/eried/eucplanet)
[![Stats](https://img.shields.io/badge/Web-Stats-39d98a)](https://github.com/eried/eucstats)
[![Telegram](https://img.shields.io/badge/Telegram-EUCPlanetApp-26A5E4?logo=telegram&logoColor=white)](https://t.me/EUCPlanetApp)
[![Donate](https://img.shields.io/badge/Donate-PayPal-00457C?logo=paypal&logoColor=white)](https://www.paypal.com/donate/?hosted_button_id=AEB2RPZHNRTKG)

Drag-and-drop web viewer for EUC trip logs (`.dbb`, `.csv`, `.gpx`, `.xlsx`): a 3D
map with terrain, playback, and charts, all client-side. No backend, no upload to
anyone's server. Your files are parsed in your browser and never leave it.

Pairs with the [EUC Planet](https://github.com/eried/eucplanet) app, which records
the logs directly, but exports from DarknessBot or euc.world work too.

If it's useful to you, a [PayPal donation](https://www.paypal.com/donate/?hosted_button_id=AEB2RPZHNRTKG) keeps it going.

## Why does this exist?

- I wanted to look at my own rides without uploading them to somebody else's cloud first,
- the trip viewers that exist are mostly dead, ad-stuffed, or want a login,
- a 3D map beats a spreadsheet.

## What it does

**Map and library.** Drop a file, or several. Trips are grouped into a tree, can be
renamed, assigned to a wheel, filtered, and exported back out as `.csv` or `.dbb`.
The trace can be coloured by any metric (speed, PWM, current, torque, …) with a
choice of palettes.

**Trip inspector.** A 3D terrain map with playback, a live dashboard, and a stack of
charts you can reorder, hide, or combine into your own overlays. Pinch or use **Trim**
to pick a section; **Compare** rides a second trip alongside the first, lined up by a
time offset that it can work out for you.

**Wheel forensics.** Whole-history analysis: estimated range from battery delta, Wh/km,
an internal-resistance proxy from the voltage sag slope, temperature rise, and trend
charts binned by month, quarter, year, or cumulative distance. Range can be normalised
to 20 °C using ambient temperatures fetched from the free Open-Meteo archive. Prints to
a PDF with a sensible filename.

**Dropbox sync.** Optional. A scoped app-folder connection that keeps `/trips` in step
with the library, with archive, upload, and a stop button for long runs.

**Video Overlay Studio.** Composites telemetry over ride footage in the browser and
renders out an MP4 via WebCodecs. An optional Dragy `.vbo` adds GPS speed.

## Structure

```
index.html                 Main map + trip library
inspector.html             Single-trip inspector (3D map, playback, charts, compare)
analytics.html             Wheel forensics (whole-history analysis + print)
video.html                 Video Overlay Studio
storage.html               Storage explorer (what is in IndexedDB / localStorage)
wheel-check.html           Wheel sync check
static/
  favicon.svg
  img/telemetry-icons/     Overlay icons for the video studio
  css/style.css            Main app styles
  css/inspector.css        Inspector styles
  css/analytics.css        Forensics styles (incl. print rules)
  css/video.css            Video studio styles
  js/app.js                Main app (Leaflet map, trip tree, recent files, Dropbox UI)
  js/inspector.js          Inspector (MapLibre GL 3D map, charts, playback, compare)
  js/analytics.js          Forensics metrics, trend charts, weather normalisation
  js/parser-worker.js      Web Worker: parses .dbb/.csv/.gpx/.xlsx with JSZip + SheetJS
  js/dropbox-source.js     Dropbox scoped app (PKCE OAuth, app folder)
  js/euc-world-export.js   euc.world bookmarklet: exports your tours as a .dbb
  js/source-hints.js       Upload-screen "how to export from DarknessBot / euc.world"
  js/video-editor.js       Video studio (WebCodecs render, mp4-muxer)
  js/euc-game.js           Minigame on the load screen (hold the logo, or #skills)
serve.cmd                  python -m http.server 8000
```

External libraries (all from CDN, pinned):
- Leaflet 1.9.4 (main map)
- MapLibre GL 4.7.1 (inspector 3D map with terrain)
- JSZip 3.10.1 (in the worker, unpacks `.dbb` zip archives)
- SheetJS (xlsx) 0.18.5 (lazy-loaded in the worker on the first `.xlsx`)
- mp4-muxer 5.2.1 (video studio export)
- AWS terrarium DEM tiles (elevation): `s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`

No build step. Commit and push; GitHub Pages serves `main` from the root.

## Data storage

- **IndexedDB** `eucplanet-trip-viewer` (version 3), primary storage
  - `recentFiles`: up to 5 recently uploaded files with their parsed tracks
  - `currentSession`: last-loaded `allTracks` array (key `"tracks"`)
  - `weatherCache`: daily ambient temperatures from Open-Meteo, keyed by
    `"{lat}|{lon}"` rounded to 0.1°
- **localStorage** `dbb_tracks`, fallback for small datasets (silently fails over quota)

The inspector (`inspector.html?i=<index>`) and the forensics page read IndexedDB
first, then fall back to localStorage. `<index>` is the position in `allTracks`
*after* sorting newest first.

## Track data shape

Each track object:
```
{
  name, date, dateStart, dateEnd,
  points:     [[lat, lon, speed, alt, volt, temp, battery, pwm, current, power,
                gpsSpeed, torque, phaseCurrent], ...],          // GPS-bearing rows
  timeseries: [[sec, speed, voltage, temp, battery, altitude, lat, lon, mileageKm,
                pwm, current, power, gpsSpeed, gForce, gForceX, gForceY,
                torque, phaseCurrent], ...],                    // downsampled to <= 500
  stats: { points, rows, distanceKm, maxSpeed, avgSpeed, maxAlt, minAlt,
           maxVoltage, minVoltage, maxTemp }
}
```

Columns are **append-only**, so every reader guards for `undefined`: tracks cached by
an older version simply lack the trailing fields. `gpsSpeed` and the `gForce*` columns
come from newer EUC Planet exports; `torque` and `phaseCurrent` from 0.19+. A wheel
that does not report one of these logs a constant `0`, so an **all-zero column is
treated as absent** rather than drawn as a flat line at zero.

## Programmatic integration

The viewer can be embedded in any app (Android, iOS, Electron, iframe). A JavaScript
API (`window.loadFileFromBase64`) accepts base64-encoded `.dbb` or `.csv` data and
displays it on the map without manual upload. Add `?embedded` to the URL to hide the
upload UI on load. See [INTEGRATION.md](INTEGRATION.md) for details and code examples.

## Local development

It's static, so any static file server works:
```
serve.cmd            # or: python -m http.server 8000
# then open http://localhost:8000/
```
Web Workers and IndexedDB require `http://`, not `file://`.
