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

## Structure

```
index.html                 Main map + trip list
inspector.html             Single-trip inspector (3D map + playback)
static/
  favicon.svg
  css/style.css            Main app styles
  css/inspector.css        Inspector styles
  js/app.js                Main app (Leaflet map, trip tree, recent files)
  js/inspector.js          Inspector (MapLibre GL 3D map, charts, playback)
  js/parser-worker.js      Web Worker: parses .dbb/.csv client-side with JSZip
  js/euc-world-export.js   euc.world bookmarklet: exports your tours as a .dbb
  js/source-hints.js       upload-screen "how to export from DarknessBot / euc.world"
```

External libraries (all loaded from CDN):
- Leaflet 1.9.4 (main map)
- MapLibre GL 4.7.1 (inspector 3D map with terrain)
- JSZip 3.10.1 (in worker, unpacks `.dbb` zip archives)
- AWS terrarium DEM tiles (elevation): `s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`

## Data storage

- **IndexedDB** `eucplanet-trip-viewer`, primary storage
  - `recentFiles` store: up to 5 recently uploaded files with their parsed tracks
  - `currentSession` store: last-loaded `allTracks` array (key `"tracks"`)
- **localStorage** `dbb_tracks`, fallback/fast cache for small datasets (silently fails over quota)

The inspector (`inspector.html?i=<index>`) reads from IndexedDB first, then falls back to localStorage.

## Track data shape

Each track object:
```
{
  name, date, dateStart, dateEnd,
  points: [[lat, lon, speed, alt, volt, temp, battery], ...],   // only GPS-bearing rows
  timeseries: [[sec, speed, voltage, temp, battery, altitude, lat, lon], ...],  // max 500 rows
  stats: { points, rows, distanceKm, maxSpeed, avgSpeed, maxAlt, minAlt, maxVoltage, minVoltage, maxTemp }
}
```

## Programmatic integration

The viewer can be embedded in any app (Android, iOS, Electron, iframe). A JavaScript API (`window.loadFileFromBase64`) accepts base64-encoded `.dbb` or `.csv` data and displays it on the map without manual upload. Add `?embedded` to the URL to hide the upload UI on load. See [INTEGRATION.md](INTEGRATION.md) for details and code examples.

## Local development

It's static, so any static file server works:
```
python -m http.server 8000
# then open http://localhost:8000/
```
Note: `inspector.html` uses a Web Worker, which requires serving via `http://` (not `file://`).
