# Health Command Center

Persönliches Health-Dashboard als installierbare **PWA** (iPhone-Homescreen).
Visualisiert Apple-Health-Daten: Schlaf, Herz (Ruhepuls/HRV), Schritte & Kalorien,
Training und VO₂max. Oberfläche durchgehend auf Deutsch.

**Live:** https://lebrongoku-prog.github.io/health-dashboard/

## Funktionsumfang

Fünf Tabs, jeder mit eigener Akzentfarbe und eigenem Zeitfilter
(heute / 7 T / 1 M / 3 M / 6 M / 12 M / 24 M) samt Datumsnavigation:

| Tab | Inhalt |
| --- | --- |
| **Übersicht** | Gewichteter Health-Score (Schlaf 35 / HRV 30 / Ruhepuls 20 / Schritte 15), Tagesempfehlung, Warnsignale, Muster-Insights |
| **Herz** | Ruhepuls und HRV mit Baseline-Abweichung und Einordnung |
| **Schlaf** | Dauer, Schlafschuld gegen 7,5 h Ziel, Einschlaf-/Aufwachzeiten, Regelmässigkeit |
| **Schritte** | Schritte, Kalorien, Serien (Streaks) |
| **Training** | Workouts, Trainingskalender, Pace, Laufumfang, Leistungstrend, VO₂max |

## Technik

- **Vanilla JS**, keine Frameworks, **kein Build-Step** — Dateien werden direkt editiert
- **Chart.js 4.5.0** über CDN
- **PWA**: Service Worker (`sw.js`, Cache-First-Shell) + `manifest.json`
- **Daten**: Google Sheets, befüllt über Google Apps Script; Auth per Google OAuth

## Struktur

```
index.html        Shell: Bottom-Nav, .screen-Sections, PWA-Meta
app.js            gesamte App-Logik (eine IIFE)
style.css         Styles
sw.js             Service Worker — enthält die Cache-Version
manifest.json     PWA-Manifest
icons/            icon.svg + 8 PNGs (32 – 1024 px)
Code.gs           Apps-Script-Backend (Referenz, nicht Teil des Deploys)
Maintenance.gs    Apps-Script-Wartung (Referenz, nicht Teil des Deploys)
CLAUDE.md         Projektkontext für die Arbeit mit Claude Code
```

## Deploy

GitHub Pages liefert den `main`-Branch aus — ein `git push` genügt.

> [!IMPORTANT]
> Wird eine gecachte Datei geändert (`index.html`, `app.js`, `style.css`,
> `manifest.json`, `sw.js` oder etwas unter `icons/`), **muss** `CACHE` in
> [`sw.js`](sw.js) hochgezählt werden (`hcc-vNN` → `NN+1`). Sonst behalten bereits
> installierte PWAs die alte Version. Bei Icon-Änderungen zusätzlich die
> `?v=N`-Query der Icon-Links in `index.html` erhöhen — iOS cacht
> Homescreen-Icons hartnäckig.

Vor jedem Deploy: `node --check app.js`.

Weitere Konventionen und Architekturdetails stehen in [`CLAUDE.md`](CLAUDE.md).
