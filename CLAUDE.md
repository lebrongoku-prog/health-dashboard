# Health Command Center — Projektkontext

## Was ist das
Persönliches Health-Dashboard als **PWA** (installierbar auf dem iPhone-Homescreen).
Zeigt Schlaf, Herz (Ruhepuls/HRV), Schritte/Kalorien, Training und VO₂max aus
Apple-Health-Daten. Läuft als statische Seite auf **GitHub Pages**. UI durchgehend **Deutsch**.

## Tech-Stack
- **Vanilla JS**, keine Frameworks, **kein Build-Step**. `app.js` ist eine große IIFE.
- **Chart.js 4.5.0** via CDN (in `index.html`, `defer`).
- **PWA**: Service Worker (`sw.js`, Cache-First-Shell) + `manifest.json`.
- **Daten**: Google Sheets, befüllt/aktualisiert über **Google Apps Script**
  (`_apps-script/`). Auth: **Google OAuth**, Token in `localStorage`. `REFRESH_URL` stößt
  Drive→Sheet-Refresh an. (Kein Silent-Refresh, kein Apps-Script-Daten-Proxy — bewusst.)

## Deploy
Git-Repo: `https://github.com/lebrongoku-prog/health-dashboard` (Remote `origin`, Branch `main`).
Live via GitHub Pages aus `main` / `/ (root)`: **https://lebrongoku-prog.github.io/health-dashboard/**
Deploy = `git push` (Auth per Personal Access Token im macOS-Keychain).
Ausgeliefert werden `index.html`, `style.css`, `app.js`, `manifest.json`, `sw.js` und `icons/`.
Wichtig: **`sw.js` immer mitcommitten** — sie löst den Cache-Refresh aus.

## Dateistruktur
- `index.html` — Shell: Bottom-Nav (5 Tabs), `.screen`-Sections, Icon-Links mit
  `?v=N`-Cachebust, `theme-color`-Meta.
- `app.js` (~2740 Z.) — gesamte App-Logik (siehe Architektur).
- `style.css` (~780 Z.) — Styles.
- `sw.js` — Service Worker; `const CACHE='hcc-vNN'` + `ASSETS`-Liste. Beim Umzug: `hcc-v57`.
- `manifest.json` — PWA-Manifest (Name, Icons, `theme_color`/`background_color` `#0891B2`).
- `icons/` — `icon.svg` + 8 PNGs (32/120/152/167/180/192/512/1024), EKG/Puls-Logo in Teal.
- `_apps-script/Code.gs`, `_apps-script/Maintenance.gs` — Apps-Script-Backend (**Referenz**,
  NICHT Teil des Web-Deploys). Der Unterstrich im Ordnernamen ist Absicht: GitHub Pages
  überspringt Ordner, die mit `_` oder `.` beginnen. Vorher lagen die Dateien im Wurzel-
  verzeichnis und waren damit öffentlich herunterladbar — samt `SECRET` und Backend-Logik.
  **Neue Referenz-/Hilfsdateien deshalb nie ins Wurzelverzeichnis legen.**
- `.claude/devserver.py` — lokaler Test-Server ohne Caching (`python3 .claude/devserver.py`,
  Port 8124). Nötig, weil der Browser sonst beim Prüfen weiter die alte `app.js` ausliefert.
- `.claude/_render-test.html` — Render-Prüfstand: ersetzt OAuth und Sheets-API durch erfundene
  Daten, damit sich die Oberfläche lokal ohne Anmeldung prüfen lässt. Szenarien per
  `?scenario=normal|nodata|woerror|stale`. Nur Entwicklung, nicht Teil der App.
  Jeder vierte Lauf ist dort ein **Indoor-Lauf**: `runSpeed` leer, Workout-Speed
  vorhanden — der Fall, in dem die Pace früher fehlte.
  Zusätzlich `?raf=timer`: ersetzt `requestAnimationFrame` durch einen Timer. Nötig,
  weil der verdeckte Vorschau-Pane nicht zeichnet — dort feuert weder `rAF` noch ein
  `scroll`-Event, und framegebundene Logik (Auto-Hide der Nav, Blickanker) liesse sich
  sonst nicht prüfen. Scroll-Events im Test selbst auslösen (`dispatchEvent`); und
  `currentScreen` folgt dem Scroll des `#tab-container`, der ebenfalls angestossen
  werden muss, sonst hält die App weiter den alten Tab für aktiv.
- **Cruft (bereits in `.gitignore`):** `archive/` (alte Versionen), `.DS_Store`,
  `.claude/settings.local.json`.

## Pflicht-Workflow bei JEDER Änderung
1. **SW-Cache bumpen:** Sobald eine gecachte Datei (`app.js`/`style.css`/`index.html`/
   `manifest.json`/`sw.js`/`icons/`) geändert wird → `CACHE` in `sw.js` hochzählen
   (`hcc-vNN` → `NN+1`). Sonst ziehen installierte PWAs die alte Version.
2. **Bei Icon-Änderungen zusätzlich:** die `?v=N`-Query aller Icon-Links in `index.html`
   hochzählen (iOS cached Homescreen-Icons hartnäckig).
3. **Verifizieren vor Abschluss:**
   - **`node` ist auf dem Rechner NICHT installiert** — statt `node --check app.js` die App über
     `.claude/devserver.py` im Browser laden und die Konsole auf Fehler prüfen (das deckt auch
     Laufzeitfehler ab). Beim Testen vorher Service Worker + Caches löschen, sonst läuft alter Code.
     Google-OAuth greift lokal nicht (`REDIRECT_URI` zeigt fest auf die Pages-URL) — es bleibt beim
     Login-Screen. Syntax- und Ladefehler stehen trotzdem sofort in der Konsole.
   - CSS-Klammerbalance: `python3 -c "s=open('style.css').read(); print(s.count('{'), s.count('}'))"`
     (beide Zahlen müssen gleich sein)
   - Nach dem Entfernen von Code per grep auf verwaiste Referenzen prüfen.
4. **Deployen:** geänderte Dateien nach GitHub Pages (Git-Push bzw. GitHub-Web).
   Updates greifen erst nach dem **zweiten** App-Neustart (1. Start installiert den neuen SW,
   2. Start aktiviert ihn).

## Kern-Architektur (app.js)
- **Globaler State:** `timeRange` (`heute`/`7d`/`1m`/`3m`/`6m`/`12m`/`24m`) + `referenceDate`.
  `filtered()` liefert die Zeilen des Fensters. `timeDim(D,…)` liefert
  `{labels, align, alignSum, hasData}` und aggregiert je nach Range täglich/wöchentlich/monatlich.
- **Daten:** `allData` = Tageszeilen (aus Sheet), **pro Datum genau eine Zeile** — doppelte
  Datumszeilen werden beim Einlesen zusammengeführt (das Apps-Script schreibt beim Refresh
  die letzten Tage neu und kann Dubletten erzeugen; ungefiltert zählte so ein Tag in jeden
  Durchschnitt doppelt). `workoutData` = nach Datum gekeyt, dadurch von Haus aus eindeutig.
- **Rendering:** `_renderTab(name)` → Seiten-Funktion `pgOverview`/`pgHerz`/`pgSchlaf`/
  `pgAktivitaet`/`pgTraining` setzt `#screen-<name>`.innerHTML und erzeugt Charts via
  `mkC(id,cfg)`; danach `_injectTopbar(name)` → `_injectChartFilters` + `updateNavUI`.
- **Chart-Registry:** `charts` (Instanzen nach Canvas-ID), `tabCharts` (IDs pro Tab, für
  Destroy beim Re-Render).
- **Navigation:** `TAB_ORDER = ['overview','herz','schlaf','laufplan','training']` (5 Tabs).
  Horizontaler Snap-Scroller (`#tab-container`). Hintergrund-Crossfade via `THEME_GRADIENTS`
  + zwei `bg-fade`-Layer.
- **Übersicht (`pgOverview`):** Zielstatus-Zeile → Tageswert-Kacheln → Verlaufs-Chart →
  Muster-Insights → App-Karte (installierte Version + Update-Knopf). Gesundheits-Score und Trend-Karte wurden auf Wunsch entfernt; mit ihnen
  entfielen `computeHealthScore`/`scoreCat`, `sparkSVG`, `zielBadge` und `trendKlasse`.
- **Events:** Delegation auf `document.body` für `.nav-prev`/`.nav-next`/`.nav-today`/
  `.refresh-btn`/`.dark-toggle` (click) und `.range-select` (change). Jede State-Änderung
  → `_refreshAfterStateChange()`.

## UI-/Namens-Konventionen
- **Keine IDs in wiederholten Komponenten** — Klassen nutzen (bis zu 5 Screen-Instanzen im
  DOM). State-Updates iterieren per `querySelectorAll().forEach`.
- **Bedienelemente:** 🌙 Dark-Toggle liegt rechtsbündig auf der `pg-banner`-Titelzeile
  (`pgBanner()`), im Laufplan-Tab davor der `＋`-Knopf für einen neuen Plan. Das
  Neuladen der Daten sitzt **nicht** mehr dort, sondern als Knopf „Daten aktualisieren"
  in der App-Karte der Übersicht — zusammen mit „App-Version aktualisieren" darunter,
  jeder mit eigener Erklärung. Beide tragen Text statt Symbol; `refreshData` wechselt
  deshalb die Beschriftung auf „Lädt…" statt den Knopf zu drehen. Der Zeitfilter (Heute + Dropdown + `‹ ›`) sitzt
  **in jeder Diagramm-Karte**, verteilt auf **zwei Zeilen**: `filterTitelTeil()` setzt
  „Heute" + Zeitraum rechts in die **Titelzeile**, `filterLegendenTeil()` das Dropdown
  + `‹ ›` rechts in die **Legendenzeile** (`legendeMitFilter`). Karten ohne Legende
  bekommen den zweiten Teil als eigene Zeile. Alles zusammen in einer Zeile ging nicht —
  dort belegte es zwei Drittel der Breite und schnitt den Titel ab. Die Legendeneinträge
  stehen in einem eigenen `.cl-items`-Block: reicht die Breite nicht (2 der 11
  Diagramme), rutschen die **Bedienelemente** in die zweite Zeile und die Legende bleibt
  einzeilig — nie umgekehrt. Der Zeitraum erscheint erst ab **1M** (`zeitraumText()`,
  z. B. `Jun–Aug 26`); bei Heute/7T steht das Datum auf der Zeitachse.
- **Emojis nur an drei Stellen:** Tab-Titel (`pgBanner`), Minikacheln der Übersicht und
  die Karten unter „Muster & Zusammenhänge". Titel, Überschriften, Status- und
  Warnzeilen tragen keine. Ausgenommen bleiben die beiden Banner-Knöpfe (🔄/🌙) — ohne
  Symbol wären sie leer.
- **Ø-Werte gehören in die Fusszeile, nicht ins Diagramm.** Die gestrichelten Ø-Linien
  sind aus Ruhepuls & HRV, Schlafdauer, Schritte, Kalorien und VO₂max entfernt und
  stehen dort als erste Fusszeile (beim Schlaf als zweite, unter der Ziel-Zeile).
  Ziellinien bleiben. Auch aus den Legenden ist der Ø-Wert raus — er stünde sonst
  doppelt und machte die Legende zu breit für die gemeinsame Zeile mit der Leiste.
- **Legendenmarker:** `.cl-dot` (Punkt) und `.cl-line` (Strich); `.cl-line.cl-strich`
  ist die gestrichelte Variante für Ø-Linien. Ihre Farbe kommt inline als **`color`**,
  nicht als `background` — der Verlauf liest sie über `currentColor`. Die Regel muss
  **nach** `.cl-line` stehen, sonst gewinnt dessen `background`.
- **Legendentexte kurz halten.** Neben der Leiste bleiben rund 140 px. Einheiten gehören
  auf die Achse, nicht in die Legende (`Puls` statt `Ruhepuls · Ø 57 bpm`). Ab drei
  Einträgen wird es eng, ab vier passt es nicht mehr: allein Punkte und Abstände
  belegen dann ~70 px. Zweizeilig sind deshalb Wochenverlauf, Schlafdauer und
  Schlafphasen — dort fehlen 31–46 px.
- **Wochentrenner statt Wochenend-Tönung:** `wochentrennerPlugin` zieht **nur im
  1M-Fenster** einen feinen Strich (`ACHSEN_COLOR`) auf die linke Kante jeder
  Montagsspalte — die Grenze Sonntag/Montag. Die früher grau getönten Wochenendspalten
  sind entfallen: sie legten eine zweite Fläche unter die Daten, wo ohnehin Ziel- und
  Markierungsflächen liegen. Bei 7T liegt der Montag auf Index 0 (dort steht die
  Achse), ab 3M gibt es keine Tagesschlüssel — in beiden Fällen erscheint nichts.
- **Zeitachse:** bei Tagesauflösung (7T/1M) zweizeilige Labels via `tagLabel()` —
  Wochentag über dem Datum. Monats-/Wochenbereiche unverändert.
- **Bottom-Nav-Ausblenden:** Runterscrollen blendet die Leiste aus
  (`initScrollHideNav`). Scrollen blendet sie **nie wieder ein** — auch nicht beim
  Zurückscrollen und nicht am Seitenanfang. Zurück kommt sie nur über einen Tipp auf
  den freien Kartenhintergrund. Die letzte Scrollposition wird **pro Tab** gemerkt:
  eine gemeinsame Variable täuschte beim Tabwechsel einen Sprung vor (Tab A bei 800,
  Tab B bei 0) und blendete bei der ersten Bewegung im neuen Tab aus. Solange nur das
  Zurückscrollen wieder einblendete, fiel das nicht auf.
- **Zeitraum-Schlüssel:** jedes Diagramm meldet über `cfg.__keys` + `cfg.__keyTyp`
  (`tag`/`woche`/`monat`), welcher Zeitraum hinter welcher Säule steckt. Ohne das
  funktionieren Wochentrenner und Markierung nicht. `timeDim` liefert beides mit;
  Diagramme mit eigener Achse (Training) setzen es selbst.
- **Markierung:** Tipp auf eine Säule hebt sie in **allen** Diagrammen der App hervor —
  synchronisiert über das **Datum**, nicht über die Position (die 3. Säule im Trainings-
  diagramm ist ein anderer Tag als im Schlafdiagramm). Monatsdiagramme markieren den
  Monat, der den Tag enthält. Abschalten nur durch erneuten Tipp auf denselben Punkt —
  ein Tipp **neben** ein Diagramm löscht bewusst NICHT, damit Vergleiche über Tabs
  hinweg bestehen bleiben. Das Zurücktreten der übrigen Säulen ist ein Schleier ÜBER
  den Daten (`markierungPlugin.afterDatasetsDraw`), kein Eingriff in die Farben der
  zwölf unterschiedlich gebauten Diagramme. Die Markierung selbst ist **nur** die
  getönte Spaltenfläche — keine senkrechten Randlinien. Zusätzlich wird der **Tooltip** des
  markierten Punkts in allen Diagrammen dauerhaft eingeblendet
  (`_tooltipAnMarkierung`) — mit **allen** Datensätzen der Säule, sonst zeigt der
  Modus `index` nur eine Zeile. Dafür ist `Chart.defaults.plugins.tooltip.animation`
  **aus**: mit Animator berechnet Chart.js Position und Grösse erst über mehrere
  Frames, wodurch ein programmgesteuertes Einblenden unzuverlässig wird.
  Ebenso ist `Chart.defaults.events = []` — Chart.js reagiert auf **kein** Ereignis
  selbst. Sonst blendete es sein Tooltip beim Berühren zusätzlich eigenständig ein
  und holte es nach dem Abschalten sofort zurück: Auf dem iPhone folgt einem
  Fingertipp ein Maus-Ereignis an derselben Stelle, und ein `mouseout` gibt es dort
  nie. Der Tipp läuft über einen eigenen `click`-Listener am Canvas
  (`zeichneDiagramm`) und ist davon unberührt.
- **Fusszeilen der Diagramme:** `.stats-list.diagramm-fuss` (Trennlinie oben). Der Wert
  ist genauso gesetzt wie sein Label — gleiches Grau, gleiche Schriftstärke. Nur Werte
  mit eigener Aussage bekommen über `statZeile(…, farbe)` eine **Signalfarbe**; sie
  tragen dann ein `style`-Attribut und bleiben farbig und fett, woran man sie erkennt.
  Deshalb dort **nie** `var(--txt2)` als Farbe übergeben: Grau ist bereits der Standard,
  die Angabe machte den Wert nur unnötig fett. Gleiches gilt für den Fall „kein
  Signal" — dann `null` übergeben, nicht eine graue Farbe.
- **Zielwerte:** `ZIELE` ist die **einzige** Quelle für Soll-Werte (Wert, Richtung,
  Anzeigeform). Zugehörig: `zielErfuellt` / `zielText` / `zielLinie` und die
  Statuszeile `zielUebersichtHTML()` oben auf der Übersicht. Neue Schwellen gehören dorthin,
  nicht in die Seitenfunktionen — vorher lagen sie an acht Stellen, teils widersprüchlich.
  **Schlafdauer- und Schritte-Diagramm:** dort färbt die Zielerreichung den **ganzen** Balken —
  kräftig wenn Nacht bzw. Tag das Ziel erreicht, hell wenn nicht (`_slFarbe`/`_stFarbe`). Die
  gestapelte Struktur bleibt nur wegen der runden Ecke bestehen, beide Segmente
  tragen dieselbe Farbe. Den Zielwert markiert die grüne Linie, nicht mehr eine
  Farbnaht. Die Legende heisst deshalb „Ziel erreicht / verfehlt".
  Bei Monatsauflösung bezieht sich die Farbe auf den **Monatsdurchschnitt** — die
  Fusszeile zählt daneben die echten Nächte (24M: 4 kräftige Balken, 69 von 120).
  Das Ziel muss dabei im Sichtbereich bleiben, sonst liegt die Naht ausserhalb und alle
  Balken sehen einfarbig aus: beim Schlaf über `min = Ziel − 0.5`, bei den Schritten über
  `suggestedMax = Ziel × 1.05` (die Achse startet dort bei 0, die Gefahr liegt oben).
  Hilfslinien in diesen beiden brauchen `stack:'ziel'` (bzw. einen eigenen Stapelnamen)
  — ohne eigenen Stapel addiert Chart.js sie auf die gestapelten Balken und sie lägen
  beim Schlaf bei 15h statt 7h30. Beim Schlaf markiert eine **durchgezogene grüne**
  Linie (`#10B981`, dasselbe Grün wie erreichte Ziele in den Fusszeilen) den Zielwert,
  dazu eine gestrichelte Ø-Linie in Balkenfarbe. Bei den Schritten gibt es **keine**
  Ziellinie mehr — nur die gestrichelte Ø-Linie in Balkenfarbe.
  Im Diagramm **Ruhepuls & HRV** stehen statt der beiden grauen Ziellinien die
  **Ø-Linien in der Farbe ihrer Reihe** (rot/blau): zwei gleich graue Hilfslinien
  liessen sich bei zwei Kurven auf einer Skala nicht zuordnen. Die früher getönte
  Fläche oberhalb des Ziels (`zielBand`-Plugin) ist auf Wunsch entfallen.
- **Farbe bedeutet Bewertung, nie Richtung.** Ob eine Abweichung gut oder schlecht ist, kommt
  aus `ZIELE[key].richtung` — ein sinkender Ruhepuls ist grün, obwohl der Wert fällt. Reine
  Beschreibungen (z. B. „Differenz Wochentag/Wochenende") bleiben neutral grau.
- **Keine Kunst-Einheiten:** Tagesdurchschnitte heissen `Ø 57 bpm`, nicht `57 bpm/d`
  („Schläge pro Minute pro Tag" ergibt keinen Sinn).
- **Kennzahlen erklären:** `infoI('key')` setzt ein antippbares ⓘ mit Text aus `ERKLAERUNG`,
  `infoMini('key')` das Gegenstück für die Minikacheln der Übersicht (`ERKLAERUNG_MINI`,
  erklärt das Lesen des Werts **im Verhältnis zum Ø**). Jede Erklärung nennt *was es ist*
  **und** *welche Richtung gut ist* — ohne die zweite Angabe lässt sich weder Farbe noch
  Pfeil deuten. Der Kasten ist ein eigenes `.info-tt`-Element (kein `::after`), damit
  `openTooltip` ihn am Bildschirmrand einklemmen kann.
- **Charts:** Canvas in `.chart-wrap` (`overflow:hidden`), Erzeugung über `mkC(id,cfg)`.
  **Nur waagrechte Gitterlinien** — `gx` setzt `grid:{display:false}`; die senkrechten
  trennten nur Kategorien, die die Achsenbeschriftung ohnehin trennt.
  Gitter und Achsen tragen **verschiedene** Farben: `GRID_COLOR` (10 %) für die
  Hilfslinien, `ACHSEN_COLOR` (38 %, via `Chart.defaults.borderColor`) für die Achsen.
  Mit einer gemeinsamen Farbe war die Begrenzung des Datenbereichs nicht von den
  Hilfslinien zu unterscheiden. Beide stehen ganz oben, **vor** dem ersten
  `Chart.defaults`-Zugriff — `const` wird nicht hochgezogen.
- **Blickposition beim Navigieren:** ein Klick auf `‹ ›` baut den Tab neu auf. Ändert
  sich dabei die Gesamthöhe, klemmt der Browser die Scrollposition und die Ansicht
  springt — am stärksten beim untersten Diagramm. `blickAnkerMerken()` merkt sich die
  auslösende Karte, `blickAnkerWiederherstellen()` setzt sie in `_injectTopbar` zurück
  an dieselbe Stelle. Bewusst **synchron**: `getBoundingClientRect` erzwingt ohnehin ein
  Layout, und in einer nicht gezeichneten Seite feuert `requestAnimationFrame` nie.
  Hilfslinien (Ø-Linie, Ziellinie) gehören nicht in die Tooltips — Filter `nurMesswerte`.
- **Wisch-Animation:** `navslide`-Chart.js-Plugin verschiebt beim Datums-Navigieren nur die
  Datenfläche (auf `chartArea` geclippt) — Achsen bleiben fix.
- **Diagrammhöhen:** stehen als `--h` am `.chart-wrap` (nicht als feste `height`).
  Das CSS staffelt sie nach Orientierung: im Querformat die volle Höhe, im Hochformat
  **70 %**. Grund ist das Seitenverhältnis, nicht die Höhe an sich — im Hochformat ist
  die Karte nur halb so breit, dieselbe Höhe lässt das Diagramm fast quadratisch
  wirken. Der Faktor steht an **einer** Stelle (`@media (orientation: portrait)`).
  Alle Diagramm-Karten stehen einzeln untereinander — das frühere dreispaltige
  Raster im Training-Tab (`three-col`) und die Klasse `.chart-wrap-flex` sind mit
  der Neusortierung entfallen.
- **Farbe pro Tab:** Übersicht Teal, Herz Rot, Schlaf Violett, Schritte Grün, Training Orange.
- **Tooltips:** ein zentrales System für Maus **und** Fingertipp. Neue Tooltip-Anker gehören in
  `TT_TAP_SELECTOR`; `openTooltip()`/`closeTooltips()` regeln den Rest. Reine CSS-`:hover`-
  Tooltips brauchen zusätzlich eine `.tt-open`-Regel, sonst sind sie am iPhone unerreichbar.
- **Einordnungs-Karten (`.chart-card.split2`):** linke Spalte `.goal-list` (Balken),
  rechte Spalte `.stats-list` (Werte). Beide sind ein Raster aus **vier gleich hohen
  Zeilen** — sonst bestimmt jede Liste ihre Zeilenhöhe selbst (Balken- vs. Textzeile)
  und die Spalten laufen nach unten auseinander. Der Wert rechts bleibt `nowrap`;
  bei Platzmangel wird das Label gekürzt, denn ein umgebrochener Wert macht die
  Zeile zweizeilig und hebt die Höhengleichheit wieder auf. Die Kartenhöhe ist auf
  Wunsch **123 px** (Herz-Karten mit Ø-Zeile 145 px) — Abstände und Zeilenhöhe
  entsprechen den übrigen Karten, hier also nichts eigens straffen.
  Schriftgrößen stehen im **Type Scale** (`.stat-lbl`/`.goal-lbl`/… mit
  `!important`) und nur dort; Angaben im `split2`-Block wären wirkungslos.
  Auch die Zeilenhöhe setzt der Type Scale direkt auf den Labels — eine Angabe
  an der Zeile wird nicht geerbt.
- **Minikacheln der Übersicht (`.ti-metric`):** Inhalte waagrecht **und** senkrecht
  zentriert. Das ⓘ steht dabei im Textfluss hinter der Beschriftung — absolut in der
  Ecke liesse sich der Inhalt nicht zentrieren, weil die Abweichungszeile dann einen
  einseitigen Rand als Ausgleich bräuchte. Dass es dabei auf eine zweite Zeile
  rutschen kann, ist unkritisch: die Kacheln sind Grid-Zellen und ohnehin gleich hoch.
- **Bezugszeitraum:** Kacheln, die dem globalen Zeitfilter **nicht** folgen, tragen ein
  `scopeBadge('…')` (z. B. `heute`, `letzte 14 Nächte`, `gesamter Datenbestand`).
- **Namensgebung:** ausgeschriebene Namen statt Kürzel — `mittel()` statt `av()`,
  `zahl()` statt `fn()`, `zeichneDiagramm()` statt `mkC()`, `alsStdMin()` statt `toHM()`,
  `prozentDiff()` statt `pct()`, `monatsMittel`/`wochenSumme` statt `mAvg`/`wSum`.
- **Gemeinsame Helfer statt Copy-Paste:** `statZeile(label, wert, farbe)` (Label links,
  Wert rechts — 44 Stellen), `splitWeekWknd(rows)` (Wochentag/Wochenende),
  `fmtPace`/`paceFromSpeed` (Pace), `dataStandHTML()` (Daten-Stand im Banner).
- **`esc()` bei jedem Fremdtext — nicht verhandelbar.** Alles, was NICHT aus diesem Code
  stammt und als **Text** angezeigt wird (Sheet-Zellen, Google-Fehlermeldungen), muss durch
  `esc()`. Die Seiten entstehen per `innerHTML`; ohne `esc()` würde Auszeichnungscode in
  einer Zelle ausgeführt statt angezeigt — und käme damit an den Google-Token im
  `localStorage`, also an die Sheets. Zahlen und Datumsangaben sind ausgenommen, die
  werden beim Einlesen geprüft (Datum: `/^\d{4}-\d{2}-\d{2}$/` in **beiden** Sheets).
  Betrifft besonders neue Anzeigen von Textfeldern wie der Trainingsart (`typeRaw`).
- **Kartenreihenfolge je Tab** (auf Wunsch festgelegt, nicht umsortieren):
  **Herz** Ruhepuls & HRV → Ruhepuls-Einordnung → HRV-Einordnung → Herz-Kreislauf-
  Einordnung. **Schlaf** Schlaf-Score-Kachel → Schlafdauer → Schlafschuld →
  Schlafphasen-Verlauf → Schlafqualität-Verteilung → Schlaf-Score-Verlauf.
  **Schritte** Anzahl Schritte → Aktive Kalorien → Schritteziel-Erreichung.
  **Training** Trainingskalender → Trainingszeit → Vergleich → Laufstrecke →
  Leistungs-Trend → Pace → VO₂max. Überall gilt: erst die Verläufe, dann die
  Einordnung — erst die Zahlen, dann deren Deutung.
- **Vergleichsdiagramm (`c-kombi`, im Training-Tab nach Kalender und Trainingszeit):** vier Reihen —
  Trainingszeit (Balken), Puls, Laufstrecke, Pace (Linien). `KOMBI_REIHEN` ist die
  **einzige** Quelle für Farbe, Einheit, Achse und Format; die Legende, die Datensätze
  und die Fusszeilen werden daraus erzeugt. Die Legendeneinträge sind `<button>` —
  sonst würde der Hintergrund-Tipp die Bottom-Nav umschalten. Die Auswahl liegt in
  `_kombiAktiv` **ausserhalb** von `pgTraining`, sonst wäre sie nach jedem Re-Render
  zurückgesetzt; die letzte aktive Reihe lässt sich nicht abschalten.
  **Zwei Achsen nach Grössenordnung:** links Minuten + bpm, rechts km + min/km. Eine
  Achse erscheint nur, wenn eine ihrer Reihen aktiv ist.
  **Ab 3M zeigen Zeit UND Strecke den Ø pro Training**, nicht die Summe — als Summen
  (500+ min, 100+ km) drückten sie Puls und Pace auf derselben Achse platt. Die
  Fusszeile `Total` nennt weiterhin die echte Summe, eine `chart-note` sagt es an.
  **Fusszeilen:** `Total` überspringt Puls und Pace (`summierbar:false`) und entfällt
  ganz, wenn keine summierbare Reihe aktiv ist; die Ø-Zeilen zeigen alle aktiven
  Reihen, getrennt durch `|`.
- **Laufplan-Tab (`pgLaufplan`):** ersetzt seit 29.08.2026 den früheren Schritte-Tab
  (Farbe Grün beibehalten; `pgAktivitaet` samt `c-steps`/`c-cals` ist entfernt — die
  Schritte-Kachel und der Wochenverlauf der **Übersicht** bleiben davon unberührt).
  Aufbau: Jahreskalender (53 Wochen à 7 Kästchen, waagrecht scrollbar, springt beim
  Rendern zur laufenden Woche) → Wochenumfang gegen `ZIELE.laufKm` → Bestleistungen →
  Liste der Einheiten. Kalendertag und Listeneintrag sind antippbar, erneuter Tipp
  klappt zu; die Auswahl liegt in `_lpAuswahl` **ausserhalb** der Seitenfunktion.
  **Datenquellen:** `laufEinheit(datum)` setzt eine Einheit aus beiden Sheets zusammen.
  Die **Strecke kommt immer aus dem Workout-Sheet** (`distanceKm`) — genau wie im
  Training-Tab. Das Health-Sheet führt unter `distKm` einen abweichenden Tageswert;
  beide Tabs zeigten dadurch unterschiedliche Kilometer für denselben Lauf. Die Pace
  nimmt weiterhin `runSpeed` und greift nur ersatzweise auf die Workout-Geschwindigkeit
  zurück (GPS schlägt die Schätzung der Uhr). Trainingszeit, Ø-Puls und Höhenmeter gibt es **nur** im
  Workout-Sheet. Kalorien ebenfalls von dort (`Energy (kJ)` ÷ 4.184) — `activeCal` im
  Health-Sheet ist der Tagesverbrauch, nicht der des Laufs (Leonard-Entscheidung).
  `LAUF_ARTEN` ist die einzige Quelle für Laufart-Farben; `istLauf()` filtert die
  Workout-Zeilen per Stichwort, weil Apple je nach Sprache andere Namen liefert.
- **Laufplan-Tab: zwei Seiten** über einen Segment-Umschalter (`.seg-toggle`, Layout aus
  FitTrack übernommen). `_lpSeite` merkt die Wahl über Re-Render hinweg.
  **Aktueller Laufplan** = Kalender, laufender Plan, Wochenumfang, Bestleistungen,
  Einheitenliste. **Laufplanverwaltung** = Liste der Pläne, jede Karte aufklappbar zur
  Detailansicht (Name, Notizen, Start, Ende, Wochen, Lauftage) und darunter Woche für
  Woche die Lauftage mit Strecke, Zeit und Herzzone. Archivierte Pläne stehen unter
  einer eigenen Überschrift.
  Die **Dauer in Wochen** wird aus Start und Ende gerechnet (`_lpWochenAus`, ab dem
  Montag der Startwoche und in ganzen Tagen — sonst wird ein mitten in der Woche
  begonnener Plan zu kurz und die Zeitumstellung kippt das Ergebnis). Das Feld ist
  reine Anzeige und bestimmt zugleich die Zahl der Wochenblöcke.
  Mehrere Wochen bleiben **gleichzeitig** offen (`_lpOffeneWochen` ist ein Set).
  Der Inhalt jedes Wochenblocks steht **immer** im DOM und wird nur ein-/ausgeblendet;
  das Auf- und Zuklappen läuft ohne `_renderTab`. Beides zusammen ist Bedingung:
  baut das Aufklappen die Seite neu, verlieren die Kopffelder darüber (Name, Notizen,
  Datum, Lauftage) ihre noch nicht gespeicherten Eingaben.
  **Alle Schreibvorgänge laufen durch EINE Kette** (`_lpKette`) und damit nacheinander.
  Vorher stand dort ein Riegel, der jeden Aufruf verwarf, welcher während eines
  laufenden startete — tippte man mehrere Felder zügig, kam nur das erste an.
  Ein Plan trägt optional ein **Wettkampfdatum** (Spalte `Wettkampf`); dieser Tag
  bekommt im Kalender einen Ring in `#D97706` und in der Tagesansicht eine Marke.
  Die Einheiten **sichern sich selbst** beim Verlassen eines Feldes und **ohne**
  Re-Render: Ein Neuaufbau nähme dem Nutzer Fokus und halb getippte Werte, und beim
  Aufklappen einer anderen Woche gingen die Eingaben verloren. Grüne Umrandung
  bestätigt, rote meldet den Fehlschlag. Der `＋`-Knopf im Banner erscheint **nur** im Laufplan-Tab
  (`_currentRenderingTab` in `pgBanner`).
- **Laufpläne im Sheet:** zwei weitere Blätter im Workout-Spreadsheet, damit der Plan
  dort von Hand lesbar bleibt: **`Laufplaene`** (ID, Name, Notizen, Start, Ende, Wochen,
  Lauftage, Archiviert) und **`Laufplan-Einheiten`** (PlanID, Woche, Wochentag, Datum,
  Strecke, Zeit, Herzzone). Geschrieben wird wie bei den Einzelterminen ausschliesslich
  über das Apps Script (`laufplanEndpunkt`), gelesen mit dem Nur-Lese-Scope.
  `geplanteTage()` führt Planeinheiten **und** freie Einzeltermine zusammen — beide
  erscheinen im Kalender als „geplant". Das Datum einer Planeinheit rechnet
  `_lpDatumAus` aus Startwoche + Wochennummer + Wochentag, es muss also nicht im Sheet
  stehen.
- **Planverwaltung (einzelne Termine):** Blatt **`Laufplan`** im Workout-Spreadsheet
  (`Date | Distance (km) | Note`). Gelesen wird es mit dem normalen Nur-Lese-Scope über
  `_fetchSheet(id, blattName)` — die Funktion nahm vorher immer `sheets[0]`.
  **Geschrieben wird ausschliesslich über das Apps Script** (`doPost` → `planEndpunkt`),
  damit der OAuth-Scope `spreadsheets.readonly` bleiben kann. Das Script legt das Blatt
  beim ersten Speichern selbst an und sortiert nach Datum.
  `mode:'no-cors'` liefert keine auswertbare Antwort, deshalb liest `_planSenden` den
  Plan nach 1.2 s **neu aus dem Sheet** — die Anzeige zeigt also immer den Sheet-Stand,
  nie die blosse Eingabe. Im Kalender ist ein geplanter Tag ein Ring (`.geplant`), ein
  gelaufener der gefüllte Kern; beides zusammen ist möglich.
- **Training-Tab-Daten:** ausschließlich `workoutData`; Ausnahmen: Pace-Chart primär aus
  `runSpeed` mit Rückgriff auf `workoutData[d].avgSpeedKph`, VO₂max-Sektion (zuunterst)
  aus `r.vo2max`. Der Rückgriff ist nötig, weil `runSpeed` GPS-gestützt ist und bei
  Indoor-Läufen fehlt — ohne ihn blieb dort jeder Punkt leer, obwohl der Trainingstag
  selbst (aus dem Workout-Sheet) erkannt wurde.

- **App-Version:** `versionAnzeigen()` liest die laufende Version aus den Namen der
  Caches (`hcc-vNN`) — `sw.js` löscht beim Aktivieren alle fremden, es bleibt genau
  einer übrig. Sortierung **numerisch**, sonst stünde `v9` über `v126`.
  `jetztAktualisieren()` meldet den Service Worker ab, leert die Caches und lädt neu.
  Der Google-Token liegt im `localStorage` und bleibt unberührt — kein neuer Login.

## Gotchas
- **Cache-Bump nicht vergessen** — häufigste Fehlerquelle.
- **NIE `toISOString()` für Datums-Strings.** Es rechnet nach UTC um; in der Schweiz
  (UTC+1/+2) kommt dabei der Vortag heraus. Immer `toLocalDateStr(dt)` bzw. `addDays(ds,n)`
  nutzen. Dieser Fehler steckte einmal an sechs Stellen und verfälschte Muster-Insights
  und Trainingskalender.
- **Kein erfundener Platzhalter für fehlende Messwerte.** Fehlt ein Wert, zeigt die App
  „—" statt eines geschätzten Ersatzwerts. Gilt überall.
- **Testen nur nach SW-Abmeldung.** Ein früher registrierter Service Worker liefert sonst
  die alte `app.js` aus — auch auf `localhost`.
- **iOS-PWA:** `viewport-fit=cover`, Status-Bar `black-translucent`, `env(safe-area-inset-*)`.
  **Kein** Body-Gradient mit `background-attachment:fixed` (friert auf iOS ein) — soliden Body
  + `.screen`-Safe-Areas nutzen.
- **Kein Build/Bundler** — Dateien direkt editieren, Chart.js kommt vom CDN.
- **Beim Entfernen von Code** grep-Check auf verwaiste Referenzen.

## Nützliche Befehle
```bash
python3 .claude/devserver.py                                                  # Dev-Server, Port 8124
python3 -c "s=open('style.css').read(); print(s.count('{'), s.count('}'))"    # CSS-Klammerbalance
grep -n "hcc-v" sw.js                                                         # aktuelle Cache-Version
```
Kein Test-Framework, kein Build-Prozess, kein `node` auf dem Rechner.
