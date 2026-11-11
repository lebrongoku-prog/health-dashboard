# Health Command Center

Persönliches Health-Dashboard als installierbare **PWA** (iPhone-Homescreen).
Visualisiert Apple-Health-Daten: Schlaf, Herz (Ruhepuls/HRV), Training und VO₂max.
Oberfläche durchgehend auf Deutsch.

**Live:** https://lebrongoku-prog.github.io/health-dashboard/

## Funktionsumfang

Vier Tabs, jeder mit eigener Akzentfarbe. **Ein** Zeitfilter für die ganze App sitzt
als Zeitleiste am unteren Rand (7T / 1M / 3M / 6M / 12M / 24M / Y, dazu Jahresvergleich
„YoY" und einzelne Kalenderjahre) samt Blätterpfeilen und „Heute":

| Tab | Inhalt |
| --- | --- |
| **Übersicht** | Zielkarte (Wochenbilanz bzw. Zeitraum mit Tages-/Abschnittsdetail), Diagramm „Zielerreichung", Belastungswarnung, Muster & Zusammenhänge |
| **Herz** | Ruhepuls & HRV, Einordnungen, Herz-Kreislauf-Einordnung gegen die 30-Tage-Baseline, Einblicke |
| **Schlaf** | Schlafdauer gegen 7,5 h Ziel, Verteilung, Schlafschuld, Schlafphasen, Einblicke |
| **Training** | Laufstrecke, Trainingszeit, Pace, VO₂max, Einblicke (Rekorde, Gewohnheiten, Entwicklung) |

Einstellungen (Daten-Stand, Google-Anmeldung, „Daten aktualisieren",
„App-Version aktualisieren") liegen auf einer eigenen Seite hinter dem Zahnrad der
Übersicht. Die App startet aus einer lokalen Kopie des letzten Stands und lädt
dahinter nach.

## Technik

- **Vanilla JS**, keine Frameworks, **kein Build-Step** — Dateien werden direkt editiert
- **Chart.js 4.5.0** über CDN
- **PWA**: Service Worker (`sw.js`, Cache-First-Shell) + `manifest.json`
- **Daten**: Google Sheets, befüllt über Google Apps Script (Zeitplan alle 6 Stunden
  und auf Zuruf aus der App); Auth per Google OAuth, die App liest nur

## Struktur

```
index.html        Shell: Bottom-Nav, .screen-Sections, PWA-Meta
app.js            gesamte App-Logik (eine IIFE)
style.css         Styles
sw.js             Service Worker — enthält die Cache-Version
manifest.json     PWA-Manifest
icons/            icon.svg + 8 PNGs (32 – 1024 px)
_apps-script/     Apps-Script-Backend (Referenz, nicht Teil des Deploys)
CLAUDE.md         Projektkontext für die Arbeit mit Claude Code
```

> [!NOTE]
> GitHub Pages überspringt Ordner, die mit `_` oder `.` beginnen. Deshalb liegen das
> Apps-Script-Backend und die Entwicklungshilfen (`.claude/`) in solchen Ordnern:
> versioniert, aber nicht über die Website abrufbar.

## Deploy

GitHub Pages liefert den `main`-Branch aus — ein `git push` genügt.

> [!IMPORTANT]
> Wird eine gecachte Datei geändert (`index.html`, `app.js`, `style.css`,
> `manifest.json`, `sw.js` oder etwas unter `icons/`), **muss** `CACHE` in
> [`sw.js`](sw.js) hochgezählt werden (`hcc-vNN` → `NN+1`). Sonst behalten bereits
> installierte PWAs die alte Version. Bei Icon-Änderungen zusätzlich die
> `?v=N`-Query der Icon-Links in `index.html` erhöhen — iOS cacht
> Homescreen-Icons hartnäckig.

## Lokal testen

```bash
python3 .claude/devserver.py
```

Startet einen Server auf http://localhost:8124, der `Cache-Control: no-store` mitschickt —
sonst liefert der Browser beim Prüfen einer Änderung weiter die alte `app.js` aus.
Google-OAuth funktioniert lokal nicht (die `REDIRECT_URI` zeigt fest auf die Pages-URL),
unter `/` bleibt es also beim Login-Screen. Die Oberfläche selbst prüft der
Render-Prüfstand mit erfundenen Daten: http://localhost:8124/.claude/_render-test.html
(Szenarien und Schalter stehen im Kopf der Datei). Ein Build-Schritt, ein
Testframework oder Node.js werden nicht benötigt.

Weitere Konventionen und Architekturdetails stehen in [`CLAUDE.md`](CLAUDE.md).
