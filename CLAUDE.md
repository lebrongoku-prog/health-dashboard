# Health Command Center — Projektkontext

## Was ist das
Persönliches Health-Dashboard als **PWA** (installierbar auf dem iPhone-Homescreen).
Zeigt Schlaf, Herz (Ruhepuls/HRV), Schritte/Kalorien, Training und VO₂max aus
Apple-Health-Daten. Läuft als statische Seite auf **GitHub Pages**. UI durchgehend **Deutsch**.

## Tech-Stack
- **Vanilla JS**, keine Frameworks, **kein Build-Step**. `app.js` ist eine große IIFE.
- **Chart.js 4.5.0** via CDN (in `index.html`, `defer`).
- **PWA**: Service Worker (`sw.js`, Cache-First-Shell) + `manifest.json`.
- **Daten**: Google Sheets, befüllt/aktualisiert über **Google Apps Script** (`Code.gs`,
  `Maintenance.gs`). Auth: **Google OAuth**, Token in `localStorage`. `REFRESH_URL` stößt
  Drive→Sheet-Refresh an. (Kein Silent-Refresh, kein Apps-Script-Daten-Proxy — bewusst.)

## Deploy
Statische Dateien auf **GitHub Pages**. Zu deployen: `index.html`, `style.css`, `app.js`,
`manifest.json`, `sw.js` und der komplette `icons/`-Ordner. Bisher manuell über die
GitHub-Weboberfläche; mit Git-Remote künftig per `git push`.

## Dateistruktur
- `index.html` — Shell: Bottom-Nav (5 Tabs), `.screen`-Sections, Icon-Links mit
  `?v=N`-Cachebust, `theme-color`-Meta.
- `app.js` (~2740 Z.) — gesamte App-Logik (siehe Architektur).
- `style.css` (~780 Z.) — Styles.
- `sw.js` — Service Worker; `const CACHE='hcc-vNN'` + `ASSETS`-Liste. Beim Umzug: `hcc-v57`.
- `manifest.json` — PWA-Manifest (Name, Icons, `theme_color`/`background_color` `#0891B2`).
- `icons/` — `icon.svg` + 8 PNGs (32/120/152/167/180/192/512/1024), EKG/Puls-Logo in Teal.
- `Code.gs`, `Maintenance.gs` — Apps-Script-Backend (**Referenz**, NICHT Teil des Web-Deploys).
- **Cruft (bereits in `.gitignore`):** `archive/` (alte Versionen), `.DS_Store`.

## Pflicht-Workflow bei JEDER Änderung
1. **SW-Cache bumpen:** Sobald eine gecachte Datei (`app.js`/`style.css`/`index.html`/
   `manifest.json`/`sw.js`/`icons/`) geändert wird → `CACHE` in `sw.js` hochzählen
   (`hcc-vNN` → `NN+1`). Sonst ziehen installierte PWAs die alte Version.
2. **Bei Icon-Änderungen zusätzlich:** die `?v=N`-Query aller Icon-Links in `index.html`
   hochzählen (iOS cached Homescreen-Icons hartnäckig).
3. **Verifizieren vor Abschluss:** `node --check app.js` (Syntax). Nach dem Entfernen von
   Code per grep auf verwaiste Referenzen prüfen.
4. **Deployen:** geänderte Dateien nach GitHub Pages (Git-Push bzw. GitHub-Web).

## Kern-Architektur (app.js)
- **Globaler State:** `timeRange` (`heute`/`7d`/`1m`/`3m`/`6m`/`12m`/`24m`) + `referenceDate`.
  `filtered()` liefert die Zeilen des Fensters. `timeDim(D,…)` liefert
  `{labels, align, alignSum, hasData}` und aggregiert je nach Range täglich/wöchentlich/monatlich.
- **Daten:** `allData` = Tageszeilen (aus Sheet). `workoutData` = nach Datum gekeyt (Workout-Sheet).
- **Rendering:** `_renderTab(name)` → Seiten-Funktion `pgOverview`/`pgHerz`/`pgSchlaf`/
  `pgAktivitaet`/`pgTraining` setzt `#screen-<name>`.innerHTML und erzeugt Charts via
  `mkC(id,cfg)`; danach `_injectTopbar(name)` → `_injectChartFilters` + `updateNavUI`.
- **Chart-Registry:** `charts` (Instanzen nach Canvas-ID), `tabCharts` (IDs pro Tab, für
  Destroy beim Re-Render).
- **Navigation:** `TAB_ORDER = ['overview','herz','schlaf','aktivitaet','training']` (5 Tabs).
  Horizontaler Snap-Scroller (`#tab-container`). Hintergrund-Crossfade via `THEME_GRADIENTS`
  + zwei `bg-fade`-Layer.
- **Events:** Delegation auf `document.body` für `.nav-prev`/`.nav-next`/`.nav-today`/
  `.refresh-btn`/`.dark-toggle` (click) und `.range-select` (change). Jede State-Änderung
  → `_refreshAfterStateChange()`.
- **Health-Score-Gewichtung:** Schlaf 35 / HRV 30 / Ruhepuls 20 / Schritte 15.

## UI-/Namens-Konventionen
- **Keine IDs in wiederholten Komponenten** — Klassen nutzen (bis zu 5 Screen-Instanzen im
  DOM). State-Updates iterieren per `querySelectorAll().forEach`.
- **Bedienelemente:** 🔄 Refresh + 🌙 Dark-Toggle liegen rechtsbündig auf der
  `pg-banner`-Titelzeile (`pgBanner()`). Zeitfilter (Dropdown + Datumsnav `‹ Heute ›`) steckt
  in jeder Diagramm-Karte (`chartFilterHTML()` / `_injectChartFilters`).
- **Charts:** Canvas in `.chart-wrap` (`overflow:hidden`), Erzeugung über `mkC(id,cfg)`.
  Durchschnittswerte tragen ein Perioden-Kürzel (Tagesmittel = `/d`).
- **Wisch-Animation:** `navslide`-Chart.js-Plugin verschiebt beim Datums-Navigieren nur die
  Datenfläche (auf `chartArea` geclippt) — Achsen bleiben fix.
- **Farbe pro Tab:** Übersicht Teal, Herz Rot, Schlaf Violett, Schritte Grün, Training Orange.
- **Training-Tab-Daten:** ausschließlich `workoutData`; Ausnahmen: Pace-Chart aus `runSpeed`,
  VO₂max-Sektion (zuunterst) aus `r.vo2max`.

## Gotchas
- **Cache-Bump nicht vergessen** — häufigste Fehlerquelle.
- **iOS-PWA:** `viewport-fit=cover`, Status-Bar `black-translucent`, `env(safe-area-inset-*)`.
  **Kein** Body-Gradient mit `background-attachment:fixed` (friert auf iOS ein) — soliden Body
  + `.screen`-Safe-Areas nutzen.
- **Kein Build/Bundler** — Dateien direkt editieren, Chart.js kommt vom CDN.
- **Beim Entfernen von Code** grep-Check auf verwaiste Referenzen.

## Nützliche Befehle
- `node --check app.js` — Syntaxprüfung (Pflicht vor Abschluss).
- `python3 -m http.server` — statische Vorschau. Achtung: Google-OAuth braucht ggf. eine
  autorisierte Origin, lokal evtl. nicht voll nutzbar.
- Kein Test-Framework, kein Build-Prozess.
