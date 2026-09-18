# Health Command Center — Projektkontext

## Was ist das
Persönliches Health-Dashboard als **PWA** (installierbar auf dem iPhone-Homescreen).
Zeigt Schlaf, Herz (Ruhepuls/HRV), Schritte/Kalorien, Training und VO₂max aus
Apple-Health-Daten. Läuft als statische Seite auf **GitHub Pages**. UI durchgehend **Deutsch**.

## Tech-Stack
- **Vanilla JS**, keine Frameworks, **kein Build-Step**. `app.js` ist eine große IIFE.
- **Chart.js 4.5.0** via CDN (in `index.html`, `defer`).
- **PWA**: Service Worker (`sw.js`, Cache-First-Shell) + `manifest.json`.
- **Daten**: Google Sheets. Auth: **Google OAuth**, Token in `localStorage`, Scope
  `spreadsheets.readonly` — die App **liest nur**. Mit dem Laufplan ist der einzige
  Schreibweg entfallen; ein Zugang, der nicht schreiben kann, kann durch einen Fehler
  auch nichts zerstören. Das **Apps Script** (`_apps-script/`) macht
  nur noch das eine, was die App nicht kann: den Import Drive→Sheet. Der läuft auf
  **zwei** Wegen, beide ohne Geheimnis im Quelltext:
  1. **Von selbst nach Zeitplan** — ein Trigger ruft `writeToSheet` auf,
     Intervall in `IMPORT_INTERVALL_STUNDEN` (seit 06.09.2026 **alle 6 Stunden**,
     vorher stündlich). Eingerichtet wird er ausschliesslich über
     `installiereImportZeitplan()`: die Funktion löscht erst alle bestehenden
     `writeToSheet`-Trigger und legt dann genau einen an. Von Hand im Trigger-Dialog
     angelegt, liefe bei einem übersehenen Alt-Trigger der Import doppelt.
  2. **Auf Zuruf** — „Daten aktualisieren" in der App schickt einen POST an
     `REFRESH_URL` mit dem Google-Token im **Rumpf** (nicht in der Adresse, die
     landet in Server-Protokollen); `doPost` prüft ihn mit `zugangGueltig`. `doGet`
     macht bewusst nichts.
  Weil das Auffrisch-Fenster (2 Tage Health, 30 Tage Workout) deutlich grösser ist
  als der Abstand der Läufe, holt ein späterer Lauf jeden ausgefallenen nach — ein
  verpasster Zeitplan reisst keine Lücke.
  **Der iPhone-Kurzbefehl stösst den Import NICHT an — bewusst.** Er lässt allein
  Health Auto Export nach Drive exportieren; den Rest macht der Zeitplan. Sein alter
  Schritt „Inhalte von …/exec?refresh=true&token=… abrufen" war nach der
  Sicherheitsumstellung wirkungslos (GET tut nichts, und der `token` war das
  entfernte `SECRET`), meldete über die abschliessende Mitteilung aber weiter Erfolg
  — deshalb fiel es lange nicht auf; entfernt am 06.09.2026. Ein Kurzbefehl kann sich
  keinen Google-Zugang beschaffen, ihn auslösen zu lassen ginge also nur über ein
  neues gemeinsames Passwort. Auf Nachfrage **abgelehnt**: der Zeitplan plus „Daten
  aktualisieren" in der App decken den Bedarf, und ein Passwort weniger ist ein
  Angriffsweg weniger. Wer das künftig doch will, braucht POST mit dem Passwort im
  **Rumpf** (nicht in der Adresse — die landet in Server-Protokollen) und eine
  Wartezeit im Kurzbefehl, sonst liegt die Export-Datei noch nicht in Drive.
  (Kein Silent-Refresh, kein Apps-Script-Daten-Proxy — bewusst.)
  Der zuletzt geladene Stand liegt zusätzlich als Kopie im `localStorage` — die App
  startet daraus (siehe „Sofortstart aus dem Zwischenspeicher").

## Deploy
Git-Repo: `https://github.com/lebrongoku-prog/health-dashboard` (Remote `origin`, Branch `main`).
Live via GitHub Pages aus `main` / `/ (root)`: **https://lebrongoku-prog.github.io/health-dashboard/**
Deploy = `git push` (Auth per Personal Access Token im macOS-Keychain).
Ausgeliefert werden `index.html`, `style.css`, `app.js`, `manifest.json`, `sw.js` und `icons/`.
Wichtig: **`sw.js` immer mitcommitten** — sie löst den Cache-Refresh aus.

## Dateistruktur
- `index.html` — Shell: Bottom-Nav (4 Tabs), `.screen`-Sections, Icon-Links mit
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
  `?scenario=normal|nodata|woerror|stale|inject|dubletten|quellen`. Nur Entwicklung,
  nicht Teil der App. Für die Datenschicht zusätzlich: `?auth=aus` (kein gültiger Token
  → die App muss aus dem Zwischenspeicher weiterlaufen), `?cache=behalten`
  (Zwischenspeicher NICHT leeren — erst normal laden, dann damit neu laden),
  `?netz=langsam` (jede Antwort 1.5 s später), `?tipp=sofort` (Nutzer tippt gleich nach
  dem Start → Hinweisleiste statt stillem Neuzeichnen), `?tage=900` (statt 120 Tagen —
  **nötig für den Jahresvergleich**, der denselben Monat in mehreren Jahren braucht),
  `?meta=fehlt` (Blatt `Meta` gibt es nicht → „Daten bis" muss auf das blosse
  Tagesdatum zurückfallen; das ist der Zustand jedes Sheets, solange das Apps Script
  noch nicht eingespielt ist). Messpunkte:
  `window.__ersterChartMs` / `__ersteAntwortMs` (belegen den Sofortstart), `__anfragen`
  (meta/werte/script), `__fruehText` (Momentaufnahme der Übersicht nach 200 ms — ohne
  sie racet jede Prüfung von aussen gegen die Antwortzeit).
  Zwei Sonderfälle stecken fest in den erfundenen Daten: Jeder vierte Lauf ist ein
  **Indoor-Lauf** (`Innenräume Ausführen` — deckt die Trainingsart-Erkennung ab;
  früher fehlte dort auch die Pace, weil sie aus `runSpeed` kam). Und jede dritte
  Einheit bekommt am **selben Tag ein zweites Training** dazu: ein
  `Hochintensives Intervalltraining`, kurz, hoher Puls, **ohne Strecke und ohne
  Geschwindigkeit** — der Fall, in dem die App früher eine der beiden Einheiten
  verlor und in dem eine falsch gerechnete Pace sofort auffällt.
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
- **Der Laufplan-Tab ist entfallen** (04.09.2026, auf Wunsch): Jahreskalender,
  Planverwaltung, Tagesdetail und der gesamte Schreibweg ins Sheet sind aus App und
  Code entfernt. Mit ihm gingen 56 Bezeichner — u. a. `pgLaufplan`, `laufKalenderHTML`,
  `_blattUmschreiben`, `lpPlanSpeichern`, `planListe`/`planEinheiten`/`planData`,
  `WOCHENTAGE`, `ZIELE.laufKm` — sowie die Blätter `Laufplan`, `Laufplaene` und
  `Laufplan-Einheiten` als Datenquelle. Die Blätter selbst **bleiben im Sheet stehen**;
  die App liest sie nur nicht mehr. Damit ist auch der Schreib-Scope entfallen
  (siehe Kopf) — die App liest jetzt wieder ausschliesslich.

- **Globaler State:** `timeRange` (`7d`/`1m`/`3m`/`6m`/`12m`/`24m`) + `referenceDate`.
  **Einen Bereich `heute` gibt es nicht mehr** (entfallen 06.09.2026): ein Diagramm
  zeigt nie nur einen einzigen Tag. „Heute" ist seither ein **Sprung**, kein Zeitraum.
  `filtered()` liefert die Zeilen des Fensters. `timeDim(D,…)` liefert
  `{labels, align, alignSum, hasData}` und aggregiert je nach Range täglich/wöchentlich/monatlich.
- **Daten:** `allData` = Tageszeilen (aus Sheet), **pro Datum genau eine Zeile** — doppelte
  Datumszeilen werden beim Einlesen zusammengeführt (das Apps-Script schreibt beim Refresh
  die letzten Tage neu und kann Dubletten erzeugen; ungefiltert zählte so ein Tag in jeden
  Durchschnitt doppelt). `workoutData` = nach Datum gekeyt. **Mehrere Einheiten am
  selben Tag werden ZUSAMMENGEFASST, nicht überschrieben.** Vorher stand in
  `_parseWorkoutRows` schlicht `workoutData[date] = {…}`: bei zwei Einträgen am selben
  Tag (etwa Lauf am Morgen, Intervalltraining am Abend) gewann der zuletzt gelesene,
  der andere verschwand spurlos aus jedem Diagramm — gemessen 93.2 min im Sheet gegen
  32.9 min in der Anzeige. Die Regeln:
  - **Dauer und Strecke werden summiert.**
  - **Puls wird nach Dauer gewichtet** gemittelt — eine Stunde Lauf und zwanzig Minuten
    Intervall dürfen nicht gleich schwer wiegen.
  - **Die Geschwindigkeit mittelt NUR über Einheiten, die eine melden.** Ein
    Intervalltraining hat keine Strecke und keine Geschwindigkeit; flösse seine Dauer in
    eine Rechnung Strecke ÷ Zeit ein, sähe die Pace des Tages deutlich langsamer aus als
    tatsächlich gelaufen wurde. Nachgemessen: Tag mit 60.3 min Lauf (10.13 km/h) plus
    32.9 min Intervall → Pace 5.92, also unverändert die des Laufs.
  - `anzahl` hält die Zahl der Einheiten. `_woAnzahl` zählt damit **Einheiten statt
    Tage**, sonst fiele „Ø pro Training" an solchen Tagen zu hoch aus.
  - `einheiten` (seit 18.09.2026) hält jede Einheit des Tages **einzeln**
    (`typ`, `dauer`, `strecke`, `puls`, `speed`) — für die Rekorde der
    Trainings-Einblicke. Zusammengefasst zählten zwei Läufe am selben Tag als ein
    einziger langer. `typ` ist roh und geht beim Anzeigen durch `esc()` (`artLabel`).
  - `laeufe` (seit 14.09.2026) hält die Zahl der Einheiten **mit Strecke** — die
    Grundlage für „Ø pro Lauf" in der Laufstrecke. `anzahl` taugt dafür nicht: ein
    Intervalltraining am selben Tag zählt dort mit, hat aber keine Strecke.
- **Sofortstart aus dem Zwischenspeicher (Vorbild FitTrack):** Die App wartete früher
  auf ~10 Sheets-Anfragen in vier Wellen, bevor irgendetwas erschien; nach Ablauf des
  Tokens (~1 h) sah man statt Daten nur den Login. Jetzt:
  1. `datenCacheLesen()` füllt `allData` und `workoutData` aus `hcc_daten_v3` —
     die App ist nach ~30 ms bedienbar.
  2. `hintergrundLaden()` holt danach den frischen Stand. Ist er **identisch**
     (Fingerabdruck `datenStand()` vorher/nachher), passiert **nichts** — sonst
     blitzte bei jedem Start ein Neuaufbau aller Diagramme auf.
  3. Neu gezeichnet wird **still**, solange `_beruehrt` false ist; danach nur noch auf
     Tipp über die Hinweisleiste („Neue Daten geladen"). `_beruehrt` hört auf
     `pointerdown`/`touchstart`/`keydown`/`wheel` — **nicht** auf `scroll`, das feuert
     auch beim eigenen Tab-Snap der App und hätte jeden Start als berührt gezählt.
  4. `_datumSelbstGewaehlt` schützt die Blätter-Position: hat der Nutzer mit `‹ ›`
     navigiert, setzt kein Nachladen mehr auf den neuesten Tag zurück. „Heute" löst
     den Schutz wieder.
  **Das Sheet bleibt die Quelle** — der Zwischenspeicher ist nur eine Kopie und wird
  nach jedem erfolgreichen Laden überschrieben. Der Schlüssel trägt eine
  Versionsnummer (`hcc_daten_v3`, seit 18.09.2026 — v2 hatte keine `einheiten`, v1
  kein `laeufe`; beide räumen sich beim nächsten Schreiben selbst weg): ändert sich, WIE eingelesen wird, hochzählen, dann
  verwerfen alte Stände sich selbst. Beim Lesen gilt dieselbe Datumsprüfung wie beim
  Sheet — `localStorage` ist von aussen beschreibbar, also nicht vertrauenswürdiger
  als eine Sheet-Zelle; alles andere fängt `esc()` beim Rendern ab.
  **„App-Version aktualisieren" löscht den Datenspeicher NICHT** (nur `caches` + SW),
  genau wie den Google-Token — sonst wartete man nach jedem Update wieder.
- **Abgelaufene Anmeldung sperrt nicht mehr:** `_fetchSheet` leitet **nicht** mehr von
  selbst zu Google weiter (das riss den Nutzer mitten aus der Ansicht), sondern liefert
  `{authError:true}`; der Aufrufer entscheidet. Ohne Token laufen Anzeige und
  Zeitfilter aus dem Zwischenspeicher weiter. Der **Stand der Anmeldung steht in der
  App-Karte** auf der Einstellungen-Seite, nicht mehr als Leiste über allen Tabs: Zeile
  „Google-Anmeldung" (`aktiv` / `nur Lesen` / `abgelaufen`, die letzten beiden
  orange), darunter Knopf + Erklärung — beide nur, wenn wirklich etwas zu tun ist.
  `anmeldeStand()` ist die **einzige** Quelle dafür — die Zeile entsteht in
  `datenStandZeilen()`, sonst stand sie zweimal da.
  **Jeder Knopf der App-Karte hat eine eigene Auslöser-Klasse** (`.anmelde-btn`,
  `.refresh-btn`, `.appver-btn`); `.update-btn` ist reine Optik und sitzt auf allen
  dreien. Wird sie als Auslöser abgefragt, löst „Mit Google anmelden" zusätzlich das
  App-Update samt Rückfrage aus — genau das war passiert. `#hinweis-oben` bleibt allein
  dem Fall „Neue Daten geladen" vorbehalten, der eine sofortige Antwort verlangt.
  **Folge:** Eine abgelaufene Anmeldung fällt erst auf, wenn man die
  Einstellungen öffnet oder etwas laden will — das ist die gewollte Zurückhaltung,
  seit 06.09.2026 eine Ebene tiefer als vorher.
  Fehlertexte dürfen deshalb **nicht** mehr auf „oben" verweisen, sondern auf
  „Übersicht → Einstellungen". **Schreiben ist dann gesperrt**
  (`_schreibenErlaubt()`) — seit der Umstellung schon deshalb, weil die App ohne
  Anmeldung gar nicht mehr ins Sheet schreiben kann.
- **Teilfehler im Hintergrund ändern nichts.** Scheitert beim stillen Nachladen das
  Workout-Blatt, bleibt der vorhandene Stand stehen (`still &&
  vorhanden` → nur `console.warn`). Sonst hätte eine kurze Netzstörung den
  Training-Tab gegen eine Fehlerkarte getauscht, obwohl alle Trainings vorliegen.
- **Blattnamen-Zwischenspeicher (`hcc_blattnamen_v1`):** `_fetchSheet` fragte vor jedem
  Wertabruf, wie die Blätter heissen — fünf Extraanfragen pro Start für eine Angabe,
  die sich nie ändert. Die Liste liegt jetzt lokal; neu geholt wird sie nur, wenn ein
  gesuchtes Blatt fehlt. `_tabsHolen` bündelt parallele Aufrufe, sonst schickten die
  gleichzeitigen Abrufe identische Namensanfragen los.
- **`loadFromAPI` lädt beide Blätter gleichzeitig** (`Promise.all`), nicht mehr
  nacheinander. Das Workout-Blatt fängt seinen Fehler selbst ab (`.catch(alsFehler)`),
  damit es den Gesundheitsteil nicht mitreisst.
  Rückgabe: `true` | `'auth'` | `false` — `'auth'` ist **kein** Fehler, sondern der
  Auftrag, die Hinweisleiste zu zeigen.
- **Rendering:** `_renderTab(name)` → Seiten-Funktion `pgOverview`/`pgHerz`/`pgSchlaf`/
  `pgTraining` setzt `#screen-<name>`.innerHTML und erzeugt Charts via
  `mkC(id,cfg)`; danach `_injectTopbar(name)` → `_injectChartFilters` + `updateNavUI`.
- **Chart-Registry:** `charts` (Instanzen nach Canvas-ID), `tabCharts` (IDs pro Tab, für
  Destroy beim Re-Render).
- **Navigation:** `TAB_ORDER = ['overview','herz','schlaf','training']` (4 Tabs).
  Horizontaler Snap-Scroller (`#tab-container`). Hintergrund-Crossfade via `THEME_GRADIENTS`
  + zwei `bg-fade`-Layer.
- **Übersicht (`pgOverview`):** Ziel-Karte → Tageswert-Kacheln → Verlaufs-Chart →
  Muster-Insights. Die frühere App-Karte am Ende liegt seit 06.09.2026 auf der
  eigenen Seite „Einstellungen" (siehe dort). Gesundheits-Score und Trend-Karte wurden auf Wunsch entfernt; mit ihnen
  entfielen `computeHealthScore`/`scoreCat`, `sparkSVG`, `zielBadge` und `trendKlasse`.
- **Events:** Delegation auf `document.body` für `.nav-prev`/`.nav-next`/
  `.refresh-btn`/`.dark-toggle`/`.zl-pille`/`.zl-opt`/`.einst-act`/`.us-zurueck`/
  `.ti-metric[data-ziel-tab]` (Kachel → Tab, dazu `keydown` für Enter/Leertaste)
  (alle click — der frühere
  `change`-Listener für das Auswahlfeld ist mit ihm entfallen). Jede State-Änderung
  → `_refreshAfterStateChange()`.

## UI-/Namens-Konventionen
- **Keine IDs in wiederholten Komponenten** — Klassen nutzen (bis zu 5 Screen-Instanzen im
  DOM). State-Updates iterieren per `querySelectorAll().forEach`.
- **Tab-Titel:** `pgBanner(icon, titel)` zeigt **nur** Emoji und Tabnamen — der
  erklärende Untertitel und die Zeile „Daten bis … · geladen …" sind entfernt. Der
  Untertitel wiederholte den Tabnamen, der Daten-Stand stand fünfmal identisch da;
  er steht jetzt einmal als zwei Zeilen („Daten bis", „Zuletzt geladen") zuoberst in
  der App-Karte auf der Einstellungen-Seite (`datenStandZeilen()`, ab 2 Tagen
  Rückstand orange).
- **Bedienelemente:** Der Dark-Toggle liegt rechtsbündig auf der `pg-banner`-Titelzeile
  (`pgBanner()`). Er trägt seit 18.09.2026 (auf Wunsch) statt 🌙/☀️ ein
  **Kontrast-Symbol** (`DARK_SYMBOL`: Kreis mit gefüllter Hälfte) in derselben
  Linienoptik wie das Zahnrad daneben. Ein Symbol für beide Zustände: im Dunkelmodus
  dreht es sich per CSS um 180° (`body.dark .pg-act.dark-toggle svg`), die Drehung
  sitzt am SVG, weil das `transform` des Knopfs dem Druckpunkt gehört.
  `applyDarkMode` setzt nur noch `aria-pressed` — ein `textContent` wie früher würde
  das SVG löschen. Das
  Neuladen der Daten sitzt **nicht** mehr dort, sondern als Knopf „Daten aktualisieren"
  auf der Einstellungen-Seite — zusammen mit „App-Version aktualisieren" darunter,
  jeder mit eigener Erklärung. Beide tragen Text statt Symbol; `refreshData` wechselt
  deshalb die Beschriftung auf „Lädt…" statt den Knopf zu drehen. Der Zeitfilter ist **geteilt**:
  Bereichswahl und Blätterpfeile stehen **einmal** in der Zeitleiste am unteren
  Bildschirmrand (siehe „Zeitleiste"), nur der angezeigte Zeitraum bleibt **je
  Diagramm** rechts in der Titelzeile (`filterTitelTeil()`). Einen „Heute"-Knopf gibt
  es dort seit 06.09.2026 nicht mehr — siehe „Zeitleiste", Punkt 6. Der Zeitraum
  richtet sich nach dem Bereich (`zeitraumText()`): bei **7T** die **Kalenderwoche**
  (`KW 36`, seit 06.09.2026), ab **1M** der Monatsbereich (`Jun–Aug 26`).
  Die Woche kommt aus `isoKW()` nach **ISO 8601** — gerechnet über den **Donnerstag**
  der Woche, weil die Woche dem Jahr gehört, in dem ihr Donnerstag liegt. Ohne diesen
  Umweg wären die Tage um den Jahreswechsel falsch (der 29.12.2025 gehört zur KW 1
  von 2026, nicht zur KW 53 von 2025). Das 7T-Fenster läuft ohnehin Montag bis
  Sonntag (`weekDays7()` über `getWeekMonday()`) und ist damit genau eine ISO-Woche.
  Ein Jahr steht nicht dabei — die Zeitachse trägt bei 7T die Datumsangaben.
- **Emojis nur an vier Stellen:** Tab-Titel (`pgBanner`), Minikacheln der Übersicht,
  die Karten unter „Muster & Zusammenhänge" und — dieselbe Kartenart — die
  Trainings-Einblicke (seit 18.09.2026). Titel, Überschriften (auch die
  Abschnittstitel der Einblicke), Status- und
  Warnzeilen tragen keine. Die Banner-Knöpfe tragen inzwischen SVG-Symbole (Zahnrad,
  Kontrast) statt Emojis.
- **Ø-Werte gehören in die Fusszeile, nicht ins Diagramm.** Die gestrichelten Ø-Linien
  sind aus Ruhepuls & HRV, Schlafdauer, Schritte, Kalorien und VO₂max entfernt und
  stehen dort als erste Fusszeile (beim Schlaf als zweite, unter der Ziel-Zeile).
  Ziellinien bleiben. Auch aus den Legenden ist der Ø-Wert raus — er stünde sonst
  doppelt und machte die Legende zu breit für die gemeinsame Zeile mit der Leiste.
- **Legendenmarker:** `.cl-dot` (Punkt) und `.cl-line` (Strich); `.cl-line.cl-strich`
  ist die gestrichelte Variante für Ø-Linien. Ihre Farbe kommt inline als **`color`**,
  nicht als `background` — der Verlauf liest sie über `currentColor`. Die Regel muss
  **nach** `.cl-line` stehen, sonst gewinnt dessen `background`.
- **Legendentexte kurz halten.** Seit die Bedienelemente in der Zeitleiste sitzen,
  hat die Legende die volle Kartenbreite — der frühere Engpass (rund 140 px neben dem
  Auswahlfeld, dadurch drei zweizeilige Legenden) ist weg. Kurz bleiben sie trotzdem:
  Einheiten gehören auf die Achse, nicht in die Legende (`Puls` statt
  `Ruhepuls · Ø 57 bpm`).
- **Wochentrenner statt Wochenend-Tönung:** `wochentrennerPlugin` zieht **nur im
  1M-Fenster** einen feinen Strich (`ACHSEN_COLOR`) auf die linke Kante jeder
  Montagsspalte — die Grenze Sonntag/Montag. Die früher grau getönten Wochenendspalten
  sind entfallen: sie legten eine zweite Fläche unter die Daten, wo ohnehin Ziel- und
  Markierungsflächen liegen. Bei 7T liegt der Montag auf Index 0 (dort steht die
  Achse), ab 3M gibt es keine Tagesschlüssel — in beiden Fällen erscheint nichts.
- **Zeitleiste (Vorbild FitTracks Pille bei laufender Einheit):** `#zeitleiste`,
  erzeugt in `zeitleisteBauen()`, fest am unteren Bildschirmrand: `‹` — Pille mit dem
  gewählten Zeitraum — `›`, darüber die aufklappbare Auswahl der sieben Bereiche.
  Sie ist in **jedem Tab** sichtbar und verschwindet weder beim Scrollen noch beim
  Tippen; nur ihre Höhe folgt der Bottom-Nav (`body.nav-weg`, in `navAusblenden()`
  gemeinsam mit `nav-hidden` umgeschaltet — getrennt gesetzt liefen die beiden
  auseinander).
  **Warum überhaupt:** vorher steckten Auswahlfeld und Pfeile in **jeder** der zwölf
  Diagrammkarten — zwölf Kopien eines Bedienelements für einen einzigen globalen
  Zustand. Sie brauchten je Karte eine zweite Zeile und drängten die Legende so weit
  zusammen, dass zwei Diagramme sie zweizeilig setzen mussten. Mit dem Umzug sind
  `filterLegendenTeil()`, `legendeMitFilter()`, `.cl-items`, `.chart-filter`,
  `.range-select` und `.date-nav` **ersatzlos entfallen**; die Legenden haben ihre
  volle Kartenbreite zurück.
  **Drei Dinge, die daran hängen:**
  1. **`pointer-events: none` auf `#zeitleiste`**, `auto` erst auf den Kindern. Die
     Leiste spannt sich über die volle Breite; ohne das fängt der freie Platz neben
     der Pille die Tipps ab, mit denen man die Bottom-Nav wieder einblendet.
  2. **Die Auswahl schliesst bei jedem Tipp, der nicht der Pille oder einem Eintrag
     gilt** — die Blätterpfeile eingeschlossen, und ebenso beim Tabwechsel
     (`_applyTabState`). „Ausserhalb der ganzen Leiste" als Bedingung reichte nicht:
     ein Tipp auf `‹`/`›` liess sie offen stehen, obwohl sie ihre Aufgabe erfüllt hatte.
  3. **Die Tabfarbe wird über `themaSetzen()` gewechselt — nie über
     `document.body.className`.** Eine Zuweisung an `className` ersetzt ALLE Klassen,
     also auch `dark`, `nav-weg` und `hinweis-an`. Genau das stand zweimal im Code
     (Tabwechsel per Knopf und per Wisch) und kostete zwei Anläufe: Beim ersten
     Reparieren führte ich `nav-weg` in der einen Kopie mit und übersah die zweite —
     der Fehler blieb, nur trat er jetzt beim Wischen statt beim Tippen auf. Symptom
     war beide Male: `nav-weg` verschwindet, die Bottom-Nav bleibt versteckt (ihre
     Klasse sitzt an ihr selbst), die Zeitleiste rückt aber auf Nav-Höhe und
     hinterlässt unten eine Lücke. `themaSetzen()` tauscht nur die `theme-*`-Klasse
     und kann deshalb nichts mitreissen — auch nichts, was es heute noch nicht gibt.
  4. **Die Pfeile sind immer sichtbar.** Sie verschwanden früher beim Bereich
     „Heute" — den gibt es nicht mehr, und jeder verbliebene Bereich lässt sich
     blättern. Ob ein Schritt möglich ist, sagt `updateNavUI()` über die Klasse
     **`.inaktiv`** — **bewusst NICHT über das `disabled`-Attribut** (08.09.2026).
     Ein deaktivierter Knopf nimmt in WebKit keine Tipps an; auf dem iPhone lief der
     Tipp an ihm vorbei und blendete die **Bottom-Nav** ein. Als ganz normaler Knopf
     fängt er den Tipp ab, und die Ausnahmeliste des Hintergrund-Tipps
     (`button, a, input, …`) greift ohnehin. Der Klick-Handler prüft `.inaktiv` und
     tut dann nichts; `aria-disabled` erhält die Ansage für Screenreader.
     **Wer das je zurückdreht, holt den Fehler zurück.**
     Das Verblassen hängt an **zwei** Regeln, die beide `.inaktiv` führen müssen:
     `.nav-arrow.inaktiv` (allgemein) und `#zeitleiste .nav-arrow.inaktiv` — letztere
     gewinnt in der Leiste über den ID-Selektor. Beim Umstellen war zuerst nur die
     erste angepasst, und die Pfeile blieben voll deckend.
  6. **„Heute" ist ein Sprung, kein Bereich** (`.zl-heute`, ohne `data-range`). Ein
     Tipp ruft `aufHeuteSpringen()` und lässt `timeRange` **unangetastet**: steht man
     auf 3M im März, bleibt es 3M und zeigt die neuesten drei Monate. Damit ist
     `referenceDate` wieder am neuesten Tag und `_datumSelbstGewaehlt` false, das
     Nachladen darf also wieder mitziehen. Es trägt nie `aktiv` — es hat keinen
     Zustand. Optisch deshalb **Umrandung statt Füllung**: als siebter Chip in
     Chip-Optik erwartete man eine Tagesansicht, und genau die gibt es nicht mehr.
     Der Weg dorthin: erst `.nav-today` in jeder Diagrammkarte, dann kurz ein Bereich
     `heute`, seit 06.09.2026 dieser Knopf.
     **Seit 18.09.2026 (auf Wunsch) sitzt er links neben dem Pfeil ‹** statt in der
     aufklappbaren Auswahl — immer sichtbar, ein Tipp statt zwei. Er ist ein Kind von
     `.zl-reihe`, aber **absolut** verankert (`right: calc(100% + 8px)`, Reihe
     `position: relative`): im Fluss hätte er die zentrierte Reihe um die halbe
     Knopfbreite nach links geschoben und rechts gegen den Ausklapp-Knopf gedrückt, wo
     bei 375 px nur 11 px Luft sind. Als Kind der Reihe schrumpft er im passiven Modus
     mit und weckt sie per Tipp, ohne eigene Regeln.
     Er **verblasst** (`.inaktiv`, wie die Pfeile — kein `disabled`), wenn
     `referenceDate` schon der neueste Tag ist. Bewusst nicht „wenn › inaktiv ist": bei
     7T kann › schon verblasst sein, während der neueste Tag in der nächsten Woche liegt.
     **In der Form der Pille** (auf Wunsch, 18.09.2026): gleiche Schrift (1.14rem,
     fett), gleiche Kapsel, so breit, wie das Gerät es hergibt. Zuerst stand er als
     50-px-Kreis mit .78rem da — gerechnet für das schmalste iPhone und mit exakt
     zentrierter Reihe. Das war zu eng gedacht: auf jedem breiteren Gerät blieb Platz
     liegen (Leonard auf seinem iPhone: „mehr als genug Platz"). Jetzt drei
     CSS-Grössen aus der Fensterbreite, ohne JavaScript (`#zeitleiste`):
     - `--heute-b` = `clamp(50px, 100vw − 315px − Safe-Areas, 96px)`. Die 315 sind
       6 (Rand) + 8 + Reihe 232 + 8 + Ausklapp 53 + 8 (Rand). Volle Pillenbreite (96 =
       Text 52.6 + Polster 2 × 21) ab 411 px.
     - Schrift = die der Pille, solange ≥ 7 px Polster je Seite bleiben
       (`(100vw − 329px) / 2.885`, 2.885 = Textbreite von „Heute" je px Schrift).
     - `--zl-versatz`: Reihe **und** Auswahl rücken nur so weit nach rechts, dass der
       Knopf 6 px vom Rand bleibt (`left` an `.zl-reihe` und `.zl-optionen`). Die
       Pille „7T" ist dadurch auf Handys bis zu 16 px rechts der Mitte; die Auswahl
       wächst trotzdem genau über ihr auf.
     Gemessen (aktiv, Knopf / Schrift / Rand links / Luft rechts zum Ausklapp):
     360 px → 50 / 12.5 / 6 / 3 (wie vorher), 375 → 60 / 15.9 / 6 / 8,
     393 → 78 / 18.24 / 6 / 8, 402 → 87 / 18.24 / 6 / 8, 430 → 96 / 18.24 / 6 / 27,
     852 quer → 96 / 18.24, Reihe exakt mittig. Auswahl- und Pillenmitte bei 393 px
     beide 208. Passiv dieselbe Unterkante wie die Pille. **Wer Pfeile, Pille oder
     Ausklapp-Knopf breiter macht, zieht die 315 und die 329 im CSS nach.**
  8. **Die Auswahl hat zwei Zeilen** (seit 12.09.2026): oben die **Befehle**
     (seit 18.09.2026 nur noch „YoY" — „Heute" steht neben ‹, siehe Punkt 6), darunter
     die sechs **Bereiche** — beide als `.zl-zeile`
     innerhalb von `.zl-optionen`, das dafür von `row` auf `column` umgestellt wurde.
     Der frühere senkrechte `.zl-trenner` ist damit ersatzlos entfallen.
     Der Grund ist Platz **und** Bedeutung: die eine Zeile war mit „Heute" und den
     sechs Chips bei 375 px schon randvoll (332 von 332 px), „YoY" hätte sie an
     beliebiger Stelle umbrechen lassen. Die Trennung nach Zeilen trennt zugleich,
     was etwas **tut**, von dem, was den Zeitraum **wählt**.
     Die Auswahl wächst nach **oben** (die Leiste ist am unteren Rand verankert) —
     die Pille bleibt also stehen, die zweite Zeile verdeckt nur während des
     Aufklappens etwas mehr Inhalt. Gemessen bei 375 px: Kasten 279 × 86 px,
     Bereichszeile 265 px (von 337 verfügbaren), Befehlszeile 120 px, keine bricht um.
  9. **Jahresvergleich („YoY")** — siehe den eigenen Abschnitt weiter unten.
  7. **Passiver Modus** (`#zeitleiste.passiv`, 06.09.2026): Die Reihe schrumpft auf
     **70 %** und geht auf **50 % Deckkraft**, sobald man scrollt (in **beide**
     Richtungen, Schwelle 2 px gegen iOS' Nachfedern), **auf einen anderen Tab wischt**
     (seit 08.09.2026) oder irgendwo neben die Leiste tippt.
     **Sie STARTET passiv** (auf Wunsch, 13.09.2026) — dieselbe Überlegung wie bei der
     eingeklappt startenden Bottom-Nav: beim ersten Blick auf die App geht es um die
     Zahlen, nicht um das Bedienelement. Gesetzt wird das in `zeitleisteBauen()` am
     **noch nicht eingesetzten** Element (`el.classList.add('passiv')` plus
     `_zlPassiv = true`), NICHT über `zeitleistePassiv(true)` nach dem Einsetzen:
     `.zl-reihe` trägt eine 0.2-s-Überblendung auf `transform` und `opacity`, und
     sobald der Browser zwischen Einsetzen und Klasse einmal den Stil berechnet,
     schrumpft die Leiste bei **jedem** App-Start sichtbar zusammen. Am losgelösten
     Element gesetzt, ist `passiv` schlicht der Anfangszustand.
     Der Wisch braucht einen **eigenen** Auslöser im Scroll-Handler des
     `#tab-container`, weil er keinen Klick erzeugt. Beim Tabwechsel per **Knopf** greift
     dagegen längst die Regel „Tipp neben die Leiste" — die Bottom-Nav liegt ausserhalb
     von `#zeitleiste`. Beide Wege enden im selben Zustand; das war schon vorher so. Ein Tipp auf Pille oder Pfeil
     holt sie zurück; ein Tipp auf einen Eintrag der offenen Auswahl lässt den
     Zustand, wie er ist. Geschrumpft wird über `transform: scale(.7)` mit
     `transform-origin: bottom center` — so bleibt die **Unterkante exakt stehen**
     (gemessen 746 px, mit versteckter Nav 804, beides unverändert beim Umschalten)
     und Höhe, Schrift und Abstände schrumpfen im selben Verhältnis. Die Deckkraft
     sitzt ebenfalls an der **Reihe**, nicht an Pille und Pfeilen einzeln: so
     verblassen Fläche, Rand, Schatten und Schrift gleichmässig und die beiden
     Elemente bleiben untereinander gleich stark. Auf die Tippfläche wirkt sie nicht. Kleinere Masse
     einzeln zu setzen hätte dasselbe Umbruch-Risiko wie die Auswahlleiste.
     **Anders als die Bottom-Nav verschwindet sie nie** — sie ist das einzige
     Bedienelement für den Zeitraum und muss erreichbar bleiben (44 px werden zu
     31 px). Eine offene Auswahl wird beim Wechsel in den passiven Modus geschlossen.
  5. **`blickAnkerMerken()` braucht einen Rückfall.** Die Pfeile sitzen in keiner
     Karte mehr, `closest('.chart-card')` liefert also nichts. Ohne den Rückfall auf
     `obersteSichtbareKarte()` bliebe der Anker leer und die Ansicht spränge beim
     Blättern genau so, wie der Anker es verhindern soll.
  **Jede Änderung an der Auswahl nachmessen.** Stand seit der Zweizeiligkeit:
  die sechs Bereichs-Chips brauchen mit ihren fünf Lücken **265 von 337 px** bei
  375 px Fenster, die Befehlszeile 120 px. Dafür sind `gap: 3px` und
  `.zl-opt{padding:0 .55rem}` nötig; die beiden Befehle dürfen in ihrer eigenen Zeile
  grosszügiger greifen (`.75rem`). Vor der Zweizeiligkeit standen dort 332 von 332 px
  — also exakt null Reserve, und genau daran wäre „YoY" gescheitert. Schmalere
  Geräte brechen weiterhin um; das ist hingenommen.
  `--zeit-h` (**53 px**, seit 08.09.2026 20 % grösser) steht auch im `padding-bottom`
  von `.screen` — sonst verschwindet die unterste Karte unter der Leiste.
  **Die Vergrösserung stiess an eine Grenze, die man kennen muss:** Die Reihe ist
  zentriert, der Ausklapp-Knopf sitzt links daneben. Bei voller Vergrösserung aller
  Masse (Pfeile 62 px, Pille 110 px) wurde die Reihe 254 px breit, begann bei 375 px
  Fenster schon bei x = 61 und **überlappte den Knopf um 19 px**. Höhe und Schrift
  tragen deshalb die vollen +20 % (44 → 53 px, 15.2 → 18.2 px), die **Breiten nur
  +8 %** (Pfeile 52 → 56, Pille 92 → 100). Der Knopf musste zusätzlich von 27 auf
  **8 px** an den Rand. Damit bleiben 11 px Luft bei 375 px und 3 px bei 360 px —
  wer hier etwas vergrössert, muss beides nachmessen.
- **Jahresvergleich („YoY", 12.09.2026, auf Wunsch):** derselbe Kalendermonat in
  **allen** Jahren, die Daten haben — Sep 24, Sep 25, Sep 26 nebeneinander. Er ist
  **kein Zeitraum im bisherigen Sinn**, läuft aber als eigener Wert von `timeRange`
  (`'yoy'`), damit jede Stelle, die den Zeitraum auswertet, ihn auch sieht.
  Eingeschaltet wird er über `.zl-yoy` in der Befehlszeile der Zeitleiste, neben
  „Heute". Anders als „Heute" **hat er einen Zustand** und trägt deshalb `aktiv` in
  der Tabfarbe; die Pille zeigt dann `YoY` statt eines Bereichs. `_yoyVorher` merkt
  sich den Bereich, aus dem heraus eingeschaltet wurde — beim Ausschalten steht er
  wieder da, sonst landete man in einem Bereich, den man nie gewählt hat.
  **Vier Stellen tragen den Modus:**
  1. `filtered()` gibt alle Zeilen zurück, deren Monat dem von `referenceDate`
     entspricht — jahresübergreifend.
  2. `windowDays`/`windowMonths` liefern **null**, damit auch `moWindow()` null
     liefert: ein zusammenhängendes Fenster gibt es hier nicht. Alles, was `moWindow`
     abfragt, fällt damit von selbst weg — unter anderem die Fusszeile **„Ø pro
     Woche"** in Laufstrecke und Trainingszeit. Das ist richtig so: ein Wochenschnitt
     über drei getrennte Septembers ergäbe keine Zahl, die etwas bedeutet.
  3. `timeDim()` braucht **keinen** eigenen Zweig — ohne Tages- oder Wochenfenster
     landet es in der Monatsaggregation, und `allMonths()` liefert genau die
     gewünschten Schlüssel (`2024-09`, `2025-09`, `2026-09`). Markierung und
     Tooltip-Synchronisierung funktionieren dadurch unverändert.
  4. `prevPeriod()` gibt **[]** zurück. Eine „Vorperiode" ist hier nicht definiert —
     die Jahre stehen ja bereits nebeneinander; die Kacheln zeigen dann „—" statt
     einer Zahl ohne Bedeutung (siehe „Kein erfundener Platzhalter").
  Die **Blätterpfeile verschieben den Monat** wie sonst auch um je einen Schritt
  (`addMonths`), begrenzt durch den Datenbestand. Man wandert dabei durch die Jahre,
  was man im Diagramm nicht sieht — das ist hingenommen: es ist dieselbe Bewegung wie
  in jedem anderen Bereich, und der Kopf jeder Karte nennt den Monat
  (`zeitraumText()` → `Sep · 3 Jahre`).
  **Nicht verwechseln:** Der Modus vergleicht **Monate**, nicht Jahre als Ganzes.
  „Total" in den Trainings-Fusszeilen ist deshalb die Summe über alle gezeigten
  Septembers zusammen.
  **Fusszeilen im Jahresvergleich** (auf Wunsch, 14.09.2026): **alle Durchschnitts-
  Zeilen entfallen** — die Durchschnittszeilen („Ø 1M" usw., siehe „Durchschnittszeile";
  in Ruhepuls & HRV, Schlafdauer, den vier Schlafphasen, Laufstrecke, Trainingszeit,
  Pace und VO₂max), „Ø pro Lauf" und die Wochentag/Wochenende-Zeilen. „Veränderung"
  bei VO₂max entfiel hier schon immer (sie mass gegen die Vorperiode, und die ist hier
  `[]`); seit 18.09.2026 gibt es sie gar nicht mehr. An ihre Stelle
  treten **eine Zeile je Jahr ab dem zweiten** mit der prozentualen Veränderung zum
  Vorjahr: `2025 vs. 2024 · +12.3%`. „Total" und „Schlafziel erreicht" bleiben.
  **Das neueste Jahr steht oben** (auf Wunsch, 14.09.2026): `2026 vs. 2025`, darunter
  `2025 vs. 2024` — die Schleife in `yoyZeilen` läuft rückwärts.
  - `yoyWerte(D, wertVon, art)` gruppiert D nach `YYYY-MM` — je Jahr genau ein Wert,
    **derselbe, den der Balken zeigt**: `summe` für Strecke und Zeit, `mittel` für alles
    andere. Die Jahre kommen aus `allMonths(D)`, damit ein Jahr ohne Wert als „—"
    erscheint statt still zu fehlen.
  - `yoyZeilen(reihen, summe)` baut die Zeilen. Mehrere Reihen stehen in EINER Zeile
    (Herz: `Puls | HRV`, Schlafphasen: `REM … | Tief …`). **Farbe nur, wo `ZIELE` eine
    Richtung kennt** — Ruhepuls, HRV, Schlafdauer, VO₂max; Strecke, Zeit, Pace und
    Phasen bleiben neutral.
  - **Angebrochene Monate bei Summen:** ein halber September hat halb so viele
    Kilometer. Liegt der neueste Datentag im Vergleichsmonat und ist nicht dessen
    letzter Tag, trägt die Zeile `(bis 14.09.)`. Bei Mittelwerten nicht — die sind
    auch über einen halben Monat vergleichbar.
  - Pace zeigt im Jahresvergleich nur die Vorjahres-Zeilen. Der Ausklapp-Knopf des
    Training-Tabs war dort bis 18.09.2026 ausgeblendet (ohne Wochenzeilen gab es
    nichts zu klappen); seit es die Trainings-Einblicke gibt, ist er immer da.
    `AUSKLAPP` kennt weiterhin ein optionales `sichtbar()`, das `zeitleisteAusklapp()`
    prüft — derzeit nutzt es kein Tab.
  Nachgerechnet aus den Rohdaten des Prüfstands (`?tage=900`): Laufstrecke 88.9 /
  156.2 / 48.1 km → `+75.7%` / `−69.2%`, Ruhepuls → `+9.1%` / `+6.6%` — identisch.
- **Einstellungen sind eine eigene Seite, kein Tab** (06.09.2026, Vorbild FitTrack).
  `#seite-einstellungen` (`.unterseite`) liegt **ausserhalb** von `#app` und wird von
  `pgEinstellungen()` bei jedem Öffnen frisch gefüllt — deshalb braucht es keinen
  Auffrisch-Pfad für den Normalfall; `appKarteAuffrischen()` baut sie nur neu, wenn
  sie **gerade offen** ist. Erreichbar über das Zahnrad in der Kopfzeile der
  Übersicht, zurück über den Pfeil oben links **oder** einen Wisch vom linken
  Bildschirmrand (`einstellungenWischen()`, Start nur bei x ≤ 28 px, Schwelle 30 %
  der Breite — weiter innen gehört die waagrechte Bewegung dem Inhalt).
  **Bottom-Nav und Zeitleiste sind währenddessen ausgeblendet** — über die eigene
  Klasse `body.einst-offen`, NICHT über `nav-hidden`: der Zustand der Tableiste soll
  erhalten bleiben und beim Schliessen genau so zurückkommen.
  **Zwei Fallen, die dort stecken:**
  1. `.unterseite[hidden]{display:none}` ist Pflicht — siehe den `hidden`-Gotcha.
     (Eine dritte Falle ist am 13.09.2026 entfallen: Im früheren 600-px-Kasten musste
     die Seite über `margin-left:-300px` zentriert werden statt über
     `translateX(-50%)`, weil das `transform` der Ein-/Ausblend-Animation gehört.
     Ohne Deckel liegt sie wieder schlicht auf `inset: 0`.)
  2. Der **Render-Prüfstand hat eine eigene Kopie der Shell**. `#seite-einstellungen`
     musste dort mit aufgenommen werden, sonst findet `pgEinstellungen()` nichts und
     tut still gar nichts — die Seite wäre lokal nicht prüfbar, ohne dass es auffiele.
  **Folge:** Daten-Stand, Anmeldestatus und beide Update-Knöpfe stehen nur noch hier.
  **Verlaufs-Wache — der Wisch zurück führt IMMER in die Übersicht** (15.09.2026, nach
  Meldung): Nach der Google-Anmeldung liegt die Google-Seite im Browserverlauf direkt
  hinter der App, und iOS erlaubt in Homescreen-Apps den Rand-Wisch als „Zurück".
  Gewann diese Systemgeste gegen `einstellungenWischen()`, landete man auf „Bei Google
  anmelden". Einen fremden Verlaufseintrag kann die App nicht löschen — sie legt
  deshalb eigene davor (`verlaufsWacheStarten()`, einmal nach dem ersten `showScreen`):
  `basis` (der Ladeeintrag, per `replaceState`) → `app` → solange die Einstellungen
  offen sind zusätzlich `einst`. Der `popstate`-Handler schliesst offene Einstellungen
  und legt bei `basis` sofort wieder `app` darüber — „Zurück" reicht damit nie über die
  App hinaus. `einstellungenSchliessen(ausVerlauf)` baut beim Schliessen per Knopf oder
  eigenem Wisch den `einst`-Eintrag über `history.back()` ab; kommt der Aufruf selbst
  aus `popstate` (`true`), ist er schon weg.
  **Zweite Sicherung:** Nach einer echten Wischbewegung (> 8 px) verwirft ein
  Capture-Listener an der Seite 450 ms lang jeden Klick — eine kurze Randgeste über
  „Mit Google anmelden" löste sonst auf iOS einen Klick auf den Knopf aus.
  **Folge am Desktop:** die Zurück-Taste des Browsers verlässt die App nicht mehr mit
  einem Klick. Ohne Daten (Anmeldebildschirm) läuft die Wache nicht — dort gibt es
  auch nichts, wovon man zurückwischen könnte.
  Geprüft im Prüfstand mit vorgeschalteter fremder Seite: Einstellungen offen →
  `history.back()` schliesst sie; danach zweimal `back()` im Tab → URL bleibt die App;
  Knopf „Zurück" → Zustand `app`; kurzer Rand-Wisch + Klick → Klick kommt nicht an,
  normaler Tipp danach schon; langer Wisch schliesst.
- **„Daten bis" nennt den Zeitstempel des Exports, nicht nur den Tag** (12.09.2026,
  auf Wunsch): `12.09.26, 07:14 Uhr` statt `12.09.26`. Ein Tag ist auch um 00:05 Uhr
  schon „heute" — erst die Uhrzeit sagt, wie frisch die Gesundheitswerte sind.
  Die Angabe kommt aus einem **eigenen Blatt `Meta`** der Health-Tabelle
  (Schlüssel/Wert; bisher eine Zeile `letzterExport`). Das Apps Script schreibt dort
  bei jedem Import `getLastUpdated()` der **neuesten übernommenen JSON-Datei** —
  also wann Health Auto Export sie abgelegt hat, nicht wann der Import lief.
  **Warum ein eigenes Blatt und keine Spalte:** `upsertDay` schreibt positionsbasiert
  ab Spalte A, und die Kopfzeilenprüfung in `getOrCreateSheet` zählt die Spalten —
  ein Wert neben den Daten hielte den Import an.
  **Fünf Dinge hängen daran:**
  1. `_fetchSheet(HEALTH_SHEET_ID, META_BLATT)` fährt in derselben `Promise.all`-Welle
     mit wie Health- und Workout-Blatt und kostet damit keine zusätzliche Wartestufe.
  2. **Fehlt das Blatt** (Skript noch nicht eingespielt), liefert `_fetchSheet`
     `{fehlt:true}` und die Zeile fällt auf das blosse Tagesdatum zurück. Solange es
     fehlt, kostet das **eine** zusätzliche Blattnamen-Abfrage pro Start — der
     gesuchte Name steht nicht im Zwischenspeicher, also fragt die App einmal nach.
     Mit dem Blatt sind es null.
  3. Der Wert wird **streng geparst** (`_stempelAusBlatt`): ISO oder deutsche
     Schreibweise, und es kommen nur Ziffern heraus. Beide Formen, weil die Sheets-API
     die **angezeigte** Zeichenkette liefert — das Skript formatiert die Zelle deshalb
     als Text (`setNumberFormat('@')`), sonst deutet Sheets sie als Datum und zeigt
     etwas anderes an, als es gespeichert hat (derselbe Fallstrick wie bei
     `sleepStart`/`sleepEnd`).
  4. Der Stempel liegt **neben** dem Fingerabdruck im Zwischenspeicher
     (`{"v":1,"ts":…,"stempel":…,"d":…}`), nicht in `datenStand()`: der Fingerabdruck
     soll sich nur ändern, wenn sich **Messwerte** ändern. Beim Lesen gilt dieselbe
     Prüfung wie beim Sheet (`_stempelGeprueft`) — `localStorage` ist von aussen
     beschreibbar.
  5. Ist der Stempel **älter** als der neueste Tag im Sheet, wird er verworfen und
     nur das Datum gezeigt: dann beschreibt er nicht diesen Stand, und eine falsche
     Uhrzeit wäre schlechter als gar keine.
- **Zeitachse:** bei Tagesauflösung (7T/1M) zweizeilige Labels via `tagLabel()` —
  Wochentag über dem Datum. Monats-/Wochenbereiche unverändert.
- **Bottom-Nav-Ausblenden:** Die Leiste **startet eingeklappt** (auf Wunsch,
  07.09.2026) — `navAusblenden(nav, true)` läuft direkt nach `zeitleisteBauen()` und
  damit vor dem ersten `showScreen`, sonst sässe die Zeitleiste kurz auf der falschen
  Höhe. Runterscrollen blendet sie aus
  (`initScrollHideNav`). Scrollen blendet sie **nie wieder ein** — auch nicht beim
  Zurückscrollen und nicht am Seitenanfang. Zurück kommt sie nur über einen Tipp auf
  den freien Kartenhintergrund. Die letzte Scrollposition wird **pro Tab** gemerkt:
  eine gemeinsame Variable täuschte beim Tabwechsel einen Sprung vor (Tab A bei 800,
  Tab B bei 0) und blendete bei der ersten Bewegung im neuen Tab aus. Solange nur das
  Zurückscrollen wieder einblendete, fiel das nicht auf.
  Die **Zeitleiste** verschwindet dabei nie — sie rückt nur nach unten nach. Beide
  Zustände hängen an `navAusblenden()`.
- **Wochenschnitt in Laufstrecke und Trainingszeit** (07.09.2026). Dahinter stehen
  **zwei verschiedene Fragen**, deshalb zwei Grössen — wer sie zusammenlegt, bekommt
  eine davon falsch:
  - **`_fensterWochen`: wie viele Wochen umfasst das angezeigte Fenster?** Daraus
    entsteht die Fusszeile „Ø pro Woche" direkt nach `Total` (in beiden Diagrammen
    gleich benannt — die Einheit steht im Wert). Sie erscheint **ab 1M**, also
    überall, wo `moWindow()` ein Fenster liefert. Bei 7T nicht: dort wäre sie sinnlos,
    weil das Fenster selbst eine Woche ist.
  - **`_monatsModus`: zeigt ein einzelner Balken einen ganzen Monat?** Nur dann
    bekommt der Tooltip eine zweite Zeile mit dem Wochenschnitt **dieses Monats**.
    Bei 1M steht je Balken ein **Tag** — ein Wochenschnitt für einen Tag ergäbe
    keinen Sinn, obwohl die Fusszeile dort sehr wohl einen hat.
  Grund für beides: Summen über verschieden lange Zeiträume lassen sich nicht
  vergleichen — ein Februar hat 28, ein Juli 31 Tage.
  **`wochenZwischen()` und `wochenImMonat()` rechnen mit Kommastellen**, nicht mit
  „vier Wochen": 28 Tage sind 4.00 Wochen, 31 Tage 4.43. Rund gerechnet läge der
  Wochenschnitt je nach Monat um bis zu 10 % daneben — und genau der Vergleich
  zwischen Monaten ist der Zweck der Zahl.
- **Alle Ø- und Ziellinien sind über die Legende ein- und ausblendbar**
  (Training seit 07.09.2026, alle übrigen seit 08.09.2026): `hlLegende()` erzeugt den
  Schalter, `oeDatensatz()` bzw. `zielDatensatz()` die Linie, `.hl-schalter` die Optik.
  Wo Linien liegen: **Ø** in Laufstrecke, Trainingszeit, Pace, VO₂max, Schlafdauer und
  Ruhepuls & HRV; **Ziel** in Schlafdauer und VO₂max.
  **Das kehrt die ältere Regel „Ø gehört in die Fusszeile, nicht ins Diagramm" um** —
  sie galt zuletzt nur noch für Herz und Schlaf und gilt jetzt nirgends mehr.
  Vier Dinge hängen daran:
  1. Der Zustand `_hilfslinie` liegt **ausserhalb** der Seitenfunktionen, sonst wäre er
     nach jedem Neuaufbau zurückgesetzt (derselbe Grund wie beim früheren
     `_kombiAktiv`). Fehlender Eintrag heisst „an". Der Schlüssel lautet
     **`<canvas-id>|<art>`** mit art `oe` oder `ziel` — ein Diagramm kann beides haben,
     und zwei Diagramme dürfen sich nicht gegenseitig schalten.
  0. **Ruhepuls & HRV hat EINEN Schalter für BEIDE Ø-Linien.** Zwei Einträge („Ø Puls",
     „Ø HRV") machten die Legende doppelt so lang für einen Zustand, den man ohnehin
     gemeinsam will; der Marker ist deshalb grau statt rot oder blau.
     Umgeschaltet wird über `_renderTab(currentScreen)` — die Schalter stehen inzwischen
     in drei Tabs, ein fest verdrahtetes `'training'` wäre falsch.
  2. Das Label der Linie ist **`Ø`**, damit `nurMesswerte` sie erkennt. **Bei den
     Datenbeschriftungen genügt das** — das Plugin wendet die Regel selbst an. **Beim
     Tooltip NICHT:** dort muss jedes Diagramm `filter: nurMesswerte` selbst setzen.
     Genau das fehlte beim Einbau, und der Tooltip zeigte für jeden Monatsbalken
     **zwei** Werte — den echten und den der Ø-Linie, beide durch dieselbe
     Label-Funktion geschickt („231.2 km / Ø 52.2 km je Woche" gefolgt von
     „81.7 km / Ø 18.5 km je Woche"). `c-sl-dur` und `c-herz` fielen nicht auf, weil
     sie eigene Filter mitbringen (`datasetIndex!==0` bzw. eine Namensliste).
  3. `oeDatensatz()` liefert ein **Array** (leer, wenn abgeschaltet), damit der
     Aufrufer es mit `...` einsetzen kann und kein `null` im Datensatz-Array landet.
  Die Linie ist ein **Datensatz**, kein Sichtbarkeits-Schalter — deshalb der
  Neuaufbau statt eines `hidden`-Flags. Seit 18.09.2026 läuft dieser Neuaufbau
  **ohne** Aufbau-Animation, nur die Linie selbst blendet (siehe „Weitere
  Animationen", Punkt 5).
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
  getönte Spaltenfläche — keine senkrechten Randlinien. Ein- und Ausschalten
  **blenden** seit 18.09.2026 (siehe „Weitere Animationen", Punkt 6). Zusätzlich wird der **Tooltip** des
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
- **Schritte sind KEINE Zielmetrik mehr** (auf Wunsch entfernt): weder in `ZIELE`
  noch in der Ziel-Karte `zielUebersichtHTML()` noch als Minikachel. Die vierte
  Minikachel zeigt an Trainingstagen die Dauer der Einheit und sonst die **Zahl der
  Trainingstage im Siebentagefenster** (`+N vs. Vorwoche`). Die Schritte-Reihe im
  **Verlaufs-Diagramm** und die Muster-Insights zu Schritten bleiben davon unberührt —
  dort sind sie Messwert, nicht Ziel.
- **Ziel-Karte (`zielUebersichtHTML()`, erste Karte der Übersicht):** zeigt **immer
  alle** Ziele — auch die erreichten und die ohne Wert (dann `—`). Vorher standen dort
  nur die verfehlten; ob ein erreichtes knapp oder deutlich erreicht war, liess sich
  nicht ablesen. Aufbau wie jede andere Karte: `.chart-card` mit `chart-head` (Titel
  „Ziele" + `scopeBadge`) und darunter eine
  `stats-list` mit einer Zeile je Ziel: `Wert · Ziel X`, wobei der Zielteil in
  `--txt3` zurücktritt.
  **Sie trägt einen eigenen Massstab `--ziel` (1.2, auf Wunsch 13.09.2026 um 20 %
  vergrössert)** — dieselbe Mechanik wie `--kachel` bei den Minikacheln: eine Zahl,
  mit der Schrift, Polster, Zeilenabstand und Badge gemeinsam wachsen. Getragen wird
  sie von der zusätzlichen Klasse `.ziel-karte` am Kartenelement; sonst ist es eine
  gewöhnliche `.chart-card`.
  Zwei Dinge muss man dabei wissen:
  1. **Die Selektoren sind zweistufig** (`.chart-card.ziel-karte h3`, `.ziel-karte
     .stat-lbl`). Die Schriftgrössen kommen aus dem Type Scale mit `!important`;
     dagegen gewinnt nur höhere Spezifität. Ein einstufiges `.ziel-karte h3` wäre
     gleich spezifisch wie `.chart-card h3` und hinge davon ab, welcher Block weiter
     unten im Stylesheet steht.
  2. **Die Breite steckt nicht im Massstab** — im Hochformat ist die Karte so breit
     wie der Bildschirm, im Querformat eine halbe Rasterspalte. „20 % grösser" heisst
     hier 20 % mehr Schrift und 20 % mehr Höhe (gemessen 196.6 → 235.1 px).
  **Im Querformat zieht sie die Kachel-Spalte mit**, weil sie dort die Zeilenhöhe
  vorgibt: deren Kasten wuchs von 197 auf 235 px, jede Kachel von 94 auf 113.5 px.
  Das ist der Grund, warum die Grenze für `--kachel` im Querformat neu zu messen ist
  (siehe dort). Trägt ein Ziel eine Einheit, die im Messwert schon steht,
  kürzt `ZIELE[key].fmtZiel` sie im Zielteil weg (`4 / Woche · Ziel 3`). **Grün = erreicht, Orange = verfehlt, ohne Farbe = kein
  Wert** — die Farbe IST hier die Bewertung. Die frühere eigene Optik
  (`.ziel-status` mit farbiger Kante, `.zs-*`-Pillen) ist entfallen.
- **Zielwerte:** `ZIELE` ist die **einzige** Quelle für Soll-Werte (Wert, Richtung,
  Anzeigeform). Zugehörig: `zielErfuellt` / `zielText` / `zielLinie` und die
  Ziel-Karte `zielUebersichtHTML()` oben auf der Übersicht. Neue Schwellen gehören dorthin,
  nicht in die Seitenfunktionen — vorher lagen sie an acht Stellen, teils widersprüchlich.
  **Schlafdauer- und Schritte-Diagramm:** dort färbt die Zielerreichung den **ganzen** Balken —
  kräftig wenn Nacht bzw. Tag das Ziel erreicht, hell wenn nicht (`_slFarbe`/`_stFarbe`). Den Zielwert markiert die grüne Linie, nicht mehr eine
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
- **Datenbeschriftungen (`werteLabelPlugin`, 06.09.2026):** Zahlen über Balken und
  Datenpunkten. **Sichtbar im Querformat immer, im Hochformat nur bei 7T und im
  Jahresvergleich** (7T seit 07.09.2026, YoY seit 12.09.2026) — dort stehen höchstens
  sieben Säulen nebeneinander bzw. eine je Jahr, ab 1M wären es über dreissig.
  **Alle neun Diagramme der App** melden inzwischen ein
  `cfg.__werteFmt` an: `c-woche`, `c-herz`, `c-sl-dur`, `c-sl-phases`, `c-sl-score`
  und die vier des Training-Tabs. Der Formatierer bekommt `(wert, datensatz)` — nötig
  für `c-woche`, wo vier Reihen vier verschiedene Einheiten tragen.
  **Drei Diagramme weichen ab**, alle auf Wunsch nach einem Zwischenschritt:
  Das **Verlaufs-Diagramm** hat gar kein `__werteFmt` — vier Reihen auf zwei Achsen
  blieben auch nach dem Weglassen von Puls und HRV unruhig; es ist damit als einziges
  vom Titel-Tipp ausgenommen. Der **Schlafphasen-Verlauf** trägt
  `__werteAusStandard: true` (Beschriftung gestapelter Balken sitzt mitten im Balken),
  **Ruhepuls & HRV** trägt `__werteNurQuer: true` (die beiden Kurven liegen im
  Hochformat eng beieinander und kreuzen sich). Beide lassen sich über den Titel
  trotzdem einschalten.
  Zahlen, die auf `0` gerundet werden, fallen überall weg: an trainingsfreien Tagen
  stünde sonst eine Reihe von `0` auf der Grundlinie.
  **Das Format kommt aus denselben Helfern wie der Rest der App** — `fmtPace()` für
  die Pace, `zahl()` für VO₂max, `Math.round` für die Laufstrecke (auf Wunsch ganze
  Kilometer und seit 12.09.2026 **ohne Einheit**: `120`, nicht `120km`. Über dem
  Balken zählt der schnelle Blick, und `km` steht bereits an der Achse; die
  Nachkommastelle steht im Tooltip und in der Fusszeile).
  **Alle Dauern schreibt `stdMinLabel()`** — Schlafdauer, Schlafphasen-Verlauf und
  Trainingszeit (auf Wunsch, 12.09.2026):
  - **Mit Stunden `1:37`**, Minuten immer **zweistellig** (`2:00`, nicht `2:0`).
  - **Unter einer Stunde `28'`** — dasselbe Zeichen wie in `fmtPace`, damit Pace und
    Dauer dieselbe Sprache sprechen.
  - Die aufgerundete Minute muss **überlaufen** können: 7.996 h ergäbe sonst `7:60`
    (dieselbe Falle, die `fmtPace` bei `5'60"` abfängt). 0.9917 h → `1:00`.
  Damit sind **beide 24M-Sonderfälle entfallen** (auf Wunsch): die Trainingszeit
  rundet dort nicht mehr auf ganze Stunden (`10h`), und die Schlafdauer bricht nicht
  mehr über zwei Zeilen um. Nachgemessen bei 24 Monatsbalken im Querformat
  (Spaltenbreite 30 px): Schlafdauer **24 von 24**, Laufstrecke **24 von 24**,
  Trainingszeit **20 von 24** Beschriftungen. Der Umbruch hatte dort ohnehin nichts
  gebracht — `7:26` ist mit 22.6 px praktisch so breit wie die breiteste Zeile des
  umbrochenen `7h`/`25m` (22.3 px); nur das einzeilige `7h 25m` war mit 37.4 px zu
  breit. Der **Schlafphasen-Verlauf** zeigte vorher Dezimalstunden (`1.5`) und damit
  eine zweite Einheit für dieselbe Grösse im Nachbardiagramm.
  `alsStdMin()` (`7h 25m`) bleibt daneben bestehen und bedient **Tooltips, Fusszeilen
  und Kacheln** — dort steht der Wert für sich und hat Platz. Wer eines von beiden
  ändert, ändert nicht das andere.
  Mehrzeilige Beschriftungen sind im Plugin allgemein gelöst: es misst die breiteste
  Zeile für die Kollisionsprüfung, stapelt nach oben (`textBaseline: bottom`, letzte
  Zeile auf `y`) und hält mit `ZEILE_H` (11 px) Zeilenabstand und Prüfhöhe zusammen.
  Breite Texte kosten Beschriftungen: `7h 25m` ist rund doppelt so breit wie `7.4`,
  im vollen Monat (31 Nächte, 23 px je Spalte) tragen deshalb 24 von 31 Balken eine
  Zahl. Das regelt die Rechteck-Prüfung von selbst. Im
  Hochformat ist die Karte halb so breit; dort stünden die Zahlen bei einem
  Monatsfenster als graues Band über den Balken.
  **Die Entscheidung fällt beim Zeichnen, nicht beim Aufbau des Tabs.** Chart.js
  zeichnet bei jeder Grössenänderung ohnehin neu, dadurch kommen und gehen die Zahlen
  beim Drehen von selbst — ohne `_renderTab`, ohne `resize`-Listener.
  **Ein Tipp auf den Kartentitel schaltet sie je Diagramm um** (auf Wunsch,
  08.09.2026). `beschriftungStandard()` liefert, was ohne Zutun gilt (die Regeln
  oben); `_beschriftung[canvasId]` hält den Wunsch des Nutzers und **gewinnt immer** —
  auch gegen `__werteNurQuer` und gegen die Hochformat-Regel. Der Zustand liegt
  ausserhalb der Seitenfunktionen und übersteht Zeitraum-, Tab- und Formatwechsel.
  Umgeschaltet wird mit `chart.draw()`, nicht mit `_renderTab`: die Daten ändern sich
  nicht, nur was darüber steht. Seit 18.09.2026 **blenden** die Zahlen dabei in 180 ms
  ein bzw. aus (`_werteBlenden`, siehe „Weitere Animationen").
  **Im Training-Tab gilt der Tipp für ALLE Diagramme des Tabs** (auf Wunsch,
  12.09.2026) — dort vergleicht man Strecke, Zeit, Pace und VO₂max miteinander, und
  vier Titel nacheinander anzutippen wäre derselbe Wunsch in vier Schritten. In Herz
  und Schlaf bleibt es beim einzelnen Diagramm. Welcher Tab es ist, sagt das **DOM**
  (`_titel.closest('.screen').id`) und NICHT `currentScreen`: alle vier Screens liegen
  gleichzeitig im Dokument, und während eines Wischs hinkt `currentScreen` dem
  sichtbaren Tab hinterher.
  **Zwei Dinge hängen daran:** `.chart-card h3` musste in die Ausnahmeliste des
  Hintergrund-Tipps (`initScrollHideNav`), sonst schaltete derselbe Tipp zusätzlich
  die Bottom-Nav um. Und der **Schlafphasen-Verlauf** hat seinen Formatierer
  zurückbekommen, jetzt mit `__werteAusStandard: true` — er zeigt nichts, bis man den
  Titel antippt. Nur so gilt „alle Diagramme ausser dem Verlauf" und bleibt die
  frühere Entscheidung bestehen, dass seine gestapelten Balken nicht dauerhaft
  beschriftet sind. Das **Verlaufs-Diagramm** hat weiterhin gar keinen Formatierer und
  reagiert deshalb nicht auf den Titel-Tipp.
  **Überlappungen löst das Plugin selbst:** es merkt sich die belegten **Rechtecke**
  (x *und* y, `measureText` für die Breite) und lässt weg, was in ein bereits
  gesetztes hineinragen würde. Nur die x-Achse zu prüfen reichte nicht: in
  „Ruhepuls & HRV" laufen zwei Reihen im selben Diagramm und kreuzen sich — dort
  stiessen die Zahlen aufeinander, obwohl in jeder Reihe für sich Platz war.
  Deshalb braucht es keine Sonderregel je Zeitraum: bei 7T steht über jedem Balken
  eine Zahl, bei 24M im Pace-Diagramm über 16 von 48 Punkten, in „Ruhepuls & HRV"
  über 13 von 14.
  **Die Zahl steht IMMER über dem Balken, nie darin** (auf Wunsch, 12.09.2026).
  Dafür sorgen zwei Dinge zusammen:
  1. **`LABEL_LUFT` (= `ZEILE_H + 6`, 17 px)** wird in `zeichneDiagramm()` als
     `layout.padding.top` gesetzt — an **einer** Stelle für jedes Diagramm mit
     `__werteFmt`, sonst vergisst es das nächste neue Diagramm wieder. Sie gilt
     **immer**, auch wenn die Zahlen gerade aus sind: sonst spränge die Zeichenfläche
     beim Titel-Tipp. Kein Diagramm setzt `layout` selbst.
  2. Geklemmt wird erst am oberen Rand des **Canvas** (`Math.max(punkt.y - 4, hoehe)`),
     nicht an dem der Zeichenfläche. Vorher stand dort `flaeche.top + hoehe`, und
     genau das schob die Zahl des höchsten Balkens nach **unten in ihn hinein**:
     erreicht ein Balken den obersten Achsenwert, liegt seine Oberkante auf
     `chartArea.top` und darüber war im Diagramm nichts mehr. Gesehen bei „2:00" auf
     120 von 120 min. Nachgemessen im erzwungenen Grenzfall (Achsenmaximum = höchster
     Wert): Balkenoberkante 17, Beschriftung bei 13 — die alte Formel hätte 28
     geliefert, also 11 px im Balken.
  **Die einzige Ausnahme ist der Schlafphasen-Verlauf**, und zwar unvermeidlich: dort
  beschriftet jede Zahl ihr eigenes **Segment**, und Segmente liegen nun einmal im
  Balken. Nur die oberste Zahl steht frei. Das ist der Grund, warum dieses Diagramm
  als einziges `__werteAusStandard: true` trägt.
  **Hilfslinien bleiben unbeschriftet**: dieselbe Regel wie im Tooltip
  (`nurMesswerte`, Label beginnt mit `Ø` oder `Ziel`) — beide müssen dasselbe unter
  „Messwert" verstehen. `__werteFmt` bestimmt zugleich das Format; gibt es `''`
  zurück, wird nichts gezeichnet. Genau so unterdrücken die beiden Balken-Diagramme
  die Null an trainingsfreien Tagen: ein Balken der Höhe 0 sagt das bereits.
- **Laufstrecke rundet auf eine Dezimalstelle** (auf Wunsch, 06.09.2026) — in der
  Beschriftung, im Tooltip **und** in der Fusszeile. Zwei Nachkommastellen
  (`465.17 km`) täuschten bei GPS-Distanzen eine Genauigkeit vor, die nicht da ist.
- **`zahl()` schneidet Nullen als Nachkommastelle weg** (auf Wunsch, 06.09.2026):
  `25.0` erscheint als `25`, `25.5` bleibt. Umgesetzt als `Number()` um `toFixed()`
  herum, wirkt damit auch auf die zweite Stelle (`25.10` → `25.1`, `44.00` → `44`).
  **`dec` ist seither eine Obergrenze, keine feste Breite** — wer eine feste Breite
  braucht (rechtsbündige Spalte, monospaced Tabelle), darf `zahl()` nicht nehmen.
  `zahl()` ist die **einzige** Stelle dafür: die früher verstreuten `toFixed(1)`/
  `toFixed(2)` in Tooltips, Insight-Texten und Fusszeilen laufen alle darüber, sonst
  hätte die Regel je nach Anzeige anders gegolten.
- **Blickposition beim Navigieren:** ein Klick auf `‹ ›` baut den Tab neu auf. Ändert
  sich dabei die Gesamthöhe, klemmt der Browser die Scrollposition und die Ansicht
  springt — am stärksten beim untersten Diagramm. `blickAnkerMerken()` merkt sich die
  auslösende Karte, `blickAnkerWiederherstellen()` setzt sie in `_injectTopbar` zurück
  an dieselbe Stelle. Bewusst **synchron**: `getBoundingClientRect` erzwingt ohnehin ein
  Layout, und in einer nicht gezeichneten Seite feuert `requestAnimationFrame` nie.
  Hilfslinien (Ø-Linie, Ziellinie) gehören nicht in die Tooltips — Filter `nurMesswerte`.
- **Wisch-Animation:** `navslide`-Chart.js-Plugin verschiebt beim Datums-Navigieren nur die
  Datenfläche (auf `chartArea` geclippt) — Achsen bleiben fix. **Gilt seit 18.09.2026 nur
  noch für 7T, 1M und den Jahresvergleich**, wo ein Schritt tatsächlich das ganze
  Fenster austauscht. Bei Monatsbalken siehe den nächsten Punkt.
  Die **Flächen unter Linien** (fill) zeichnet Chart.js' Filler-Plugin selbst, in 4.5 je
  Datensatz in `beforeDatasetDraw` und VOR allen Plugins dieser Datei. Keine
  Verschiebung erreichte sie — im Pixelvergleich stand die HRV-Fläche am Endplatz, die
  Linie noch am alten. `fuellungMitziehen()` legt deshalb `$spalten`/`$navslide` um die
  drei Zeichen-Haken des Fillers. Bei der alten Schiebe-Animation hatte das Ausblenden
  den Fehler verdeckt.
  **Die Zahlen über den Balken wandern mit** (auf Wunsch, 18.09.2026, gemeldet bei 7T):
  das navslide-Plugin verschiebt nur die Datensätze und stellt den Zeichenzustand in
  `afterDatasetsDraw` wieder her — VOR dem `werteLabelPlugin`, das erst danach zeichnet.
  Die Zahlen blieben deshalb stehen, während die Balken darunter wegglitten. Das
  Plugin übernimmt jetzt Versatz **und** Deckkraft von `$navslide` (bei Monatsbalken
  schon vorher den von `$spalten`). Gilt für Pfeile und Wisch in 7T, 1M und im
  Jahresvergleich. Gemessen (812 × 375, 7T): Versatz −55.9 px → Balken und Zahlen beide
  bei x 38.3 / 244.4 / 347.4, Zahlen mit Deckkraft 0.6 wie die Balken.
- **Monatsbalken rücken weiter** (auf Wunsch, 18.09.2026). Ab 3M blättert ein Schritt
  EINEN Monat, das Fenster umfasst aber 3 bis 24. Die Schiebe-Animation schob trotzdem
  die ganze Fläche weg und blendete sie aus — es sah aus, als wechsle das ganze
  Fenster, obwohl fünf von sechs Balken dieselben blieben. Umgesetzt (Vorschläge 1–4;
  Punkt 5, der Zeitstrahl-Wisch, folgte am selben Tag — siehe **Wischen** unten):
  1. **Weiterrücken um die tatsächlich verschobenen Spalten.** `_navSchritt()` hält vor
     dem Neuaufbau jedes Diagramm des Tabs fest (`_spaltenMerken`: `$keys`,
     Pixelpositionen, y-Bereiche, Ø-Werte, **Momentaufnahme des Canvas**). Danach
     beginnt das neue Diagramm genau dort, wo das alte stand, und rückt in 420 ms
     (`SPALTEN_DAUER`) an seinen Platz. Der Versatz kommt aus den gemeinsamen
     Zeitraum-Schlüsseln, in **Pixeln** gemessen — stimmt also auch, wenn sich die
     Breite der y-Achse ändert. Der ausscheidende Monat ist im neuen Diagramm nicht
     mehr enthalten; er fährt als Ausschnitt der Momentaufnahme hinaus (`streifen`,
     unter den neuen Daten gezeichnet), sonst stünde am Rand eine leere Spalte.
  2. **Monatsnamen, Zahlen über den Balken, Markierung und Tooltip wandern mit.**
     Die Monatsnamen über ein am Objekt überschriebenes `drawLabels` der x-Achse
     (Chart.js ruft es über `this.drawLabels`, die Achse bleibt bei `update()`
     dieselbe Instanz). Links sichtbar nur so weit, wie der erste Name im Endstand
     übersteht (`_labelLinks`) — sonst stand ein hereinkommender Name schon unten in
     der Ecke neben der y-Achse.
  3. **Die y-Achse gleitet**: `min`/`max` je Bild auf dem **frisch geholten**
     `c.config.options.scales[id]` (die Objekte werden bei jedem `update()` neu
     zusammengesetzt — eine gemerkte Referenz wirkt ab dem zweiten Bild nicht mehr),
     dazu `update('none')`. `ticks.includeBounds` ist währenddessen aus, sonst stünde
     oben eine krumme Zwischenzahl. Am Ende wird alles zurückgesetzt.
  4. **Ø-Linien gleiten senkrecht** auf ihren neuen Wert und rücken NICHT seitlich mit
     (`spaltenPlugin.beforeDatasetDraw` lässt Hilfslinien aus); Ziellinien stehen.
  **Zwei Arten** (`_spaltenPlan`): SPALTEN für Monats- und Wochenspalten mit
  gemeinsamen Zeiträumen; ausgerichtet an einem stehenbleibenden Rand (Anfang/Ende des
  Datenbestands), sonst an der **mittleren** gemeinsamen Spalte — bei Wochen (3M:
  Ruhepuls & HRV, VO₂max, Score) hat ein Fenster mal 13, mal 14 Spalten, eine Spalte
  Unterschied ist erlaubt. GLEITEN für alles andere, vor allem den **Pace** (Punkte je
  Training): um die Breite eines Monats, ohne Ausblenden und ohne Streifen, aber mit
  gleitender Achse, Ø-Linie und Beschriftungen.
  **Wischen wie auf einem Zeitstrahl** (Vorschlag 5, auf Wunsch 18.09.2026): Bei
  Monatsbalken folgt die Fläche dem Finger **1:1 über beliebig viele Monate** — bis zum
  Rand des Datenbestands (`_maxMonate`), danach Gummiband (Dämpfung 0.25, höchstens ein
  Monat). Beim Loslassen **rastet sie auf ganze Monate ein** (gerundet, mindestens
  einer — wie jeder Wisch vorher) und `_navSchritt(richtung, schritte)` blättert in
  EINEM Schritt so viele Monate (`_navZielMonate`). Der Rest bis zum ganzen Monat wird
  nachgeführt: 2.4 gezogen → 2 geblättert, die Fläche federt 0.4 zurück; 2.6 → 3, sie
  rückt 0.4 nach (`_zwischen` mit einem halben Monat Spielraum). Wird weiter geblättert,
  als das Fenster breit ist, gibt es keine gemeinsamen Monate mehr — das Diagramm
  gleitet dann um die ganze Strecke.
  Drei Dinge dabei:
  1. **Gemessen wird in Monaten, nicht in Pixeln**: die Monatsbreite des Diagramms, in
     dem die Geste begann, ist das Mass; jedes Diagramm rückt um denselben Bruchteil
     SEINER Monatsbreite — so bleiben alle beim selben Monat, auch bei verschieden
     breiten y-Achsen.
  2. **Der Zug läuft über `$spalten` (mit `zug: true`)**, nicht mehr über `$navslide`:
     so wandern Monatsnamen, Zahlen und Markierung schon beim Ziehen mit, Hilfslinien
     bleiben stehen, die Fläche bleibt voll deckend. `_spaltenMerken` liest den Zug beim
     Loslassen als Startversatz.
  3. **Die hereinkommenden Monate sind beim Ziehen noch nicht gezeichnet** — das
     Diagramm kennt nur sein Fenster, die Fläche dort bleibt leer bis zum Loslassen.
     Deshalb zeigt der Zeitraum im Kartenkopf während des Ziehens den **Zielzeitraum
     in der Tabfarbe** (`_zeitraumVorschau`, `.zeitraum-text.vorschau`); dafür wird
     `referenceDate` nur für den Aufruf von `zeitraumText()` umgestellt. Die
     Nachbarmonate vorab zu zeichnen hiesse, jede Seitenfunktion für ein zweites
     Fenster laufen zu lassen, samt Fusszeilen — bewusst nicht gemacht.
  **Nebenbei behoben:** Zog man über die Schwelle und wieder darunter zurück, blieb die
  Fläche beim Loslassen mit dem letzten Versatz stehen (in jedem Bereich). Jetzt federt
  sie zurück (`z.zurueck`).
  Gemessen (Prüfstand, 6M, Monatsbreite 62.4 px): 2.4 Monate Zug → 149.7 px Versatz,
  Kopf „Jan–Jun 26", nach dem Loslassen 2 Monate zurück, Start +24.4 px; 2.6 → 3
  Monate, Start −25.5 px; 8 Monate (mehr als das Fenster) → 8, Start 0.7 px; am neuesten
  Stand vorwärts 3.2 Monate Zug → −50 px Gummiband, kein Schritt; Herz 3M (Wochen)
  2 Monate → 2 Monate, mit Streifen.
  **Erstes Bild sofort:** `_spaltenStarten` und `_animNavSlide` (bei Monatsbereichen)
  setzen den Anfangszustand noch in derselben Aufgabe; vorher stand für ein Bild der
  Endstand da. Training baut dafür synchron genug — `pgTraining` wartet nur, solange die
  Workout-Daten fehlen.
  **Nachgemessen** (Prüfstand, Pixelvergleich altes Bild ↔ erstes Bild nach dem
  Schritt): Laufstrecke 6M 1.4–1.7 %, Ruhepuls & HRV 12M 1.2 %, VO₂max 3M (Wochen)
  1.1 % abweichende Pixel — Kantenglättung von Text und Linien an Bruchteil-Positionen.
  Vor der Füllungs-Korrektur waren es 4.6 bzw. 8.5 %. Positionsabweichung gemeinsamer
  Spalten im ersten Bild: Monatsbalken ≤ 1.1 px, Wochen mit ungleicher Spaltenzahl bis
  10 px am Rand. Laufende Bewegungen bricht ein neuer Schritt oder eine neue Geste über
  `_spaltenAbbrechen()` ab (Endstand setzen), es bleibt nichts hängen.
  **Bekannte Kleinigkeit:** bei 12M/24M überspringt Chart.js Monatsnamen
  (`autoSkip`); nach einem Schritt trifft das andere Monate, die Namen wechseln im
  ersten Bild.
  **Hilfslinien bewegen sich nie seitlich und fahren nicht mit hinaus** (gemeldet
  18.09.2026 am Schlafdauer-Diagramm bei 3M: Ziel- und Ø-Linie wirkten beim Wischen
  und Blättern „abgeschnitten und mitgezogen"). Ursache war vor allem der
  hinausfahrende Streifen: als Ausschnitt des alten Bilds brachte er die alten
  Linienstücke mit. `hilfslinienVoll` regelt zweierlei:
  1. `$ohneHilfslinien` lässt die Linien weg (`return false`) — `_spaltenMerken`
     nimmt die Momentaufnahme damit **ohne** Hilfslinien auf.
  2. Bei der Schiebe-Animation (`$navslide`, 7T/1M/YoY) nimmt es den Versatz für
     Hilfslinien zurück (eigenes save/translate/restore um den Datensatz); bei
     Monatsbalken lässt `spaltenPlugin` sie ohnehin aus. Die Linien stehen still,
     während die Daten gleiten, und gleiten nur senkrecht auf ihren neuen Wert.
  **Die Länge bleibt die von Chart.js** (bei Balken von Spaltenmitte zu Spaltenmitte).
  Eine Fassung, die die Linien von Rand zu Rand zog, stand am 18.09.2026 kurz live
  und wurde auf Wunsch zurückgenommen — **nicht wieder einbauen**.
  **Die Registrierungsreihenfolge ist Pflicht:** `hilfslinienVoll` vor
  `hilfslinienBlende` und `spaltenPlugin` — sein `return false` beendet die Kette für
  den Datensatz, sodass deren `before`/`after` gar nicht erst laufen (sonst
  unausgeglichenes save/restore).
  Geprüft (Prüfstand, 812 × 375, Schlafdauer 3M): die Ziellinie reicht in jedem
  Zustand von der ersten bis zur letzten Spaltenmitte (149–640 px) — in Ruhe, beim
  Ziehen (Balken 111 px versetzt), im ersten Bild nach dem Loslassen (−136 px); bei 7T
  mitten in der Schiebe-Animation (−71 px) ebenfalls genau an den Spaltenmitten.
- **Waagrecht wischen IM Diagramm blättert den Zeitraum** (auf Wunsch, 16.09.2026,
  `diagrammWischen()`): nach links = vorwärts, nach rechts = zurück, **ein Schritt je
  Geste** — bei Monatsbalken seit 18.09.2026 so viele Monate, wie gezogen wurde (siehe
  „Monatsbalken rücken weiter", Zeitstrahl-Wisch). Es ruft `navNext()`/`navPrev()` — damit gelten Schrittweite (7 Tage bzw. ein
  Monat), Grenzen des Datenbestands, `_datumSelbstGewaehlt` und die `navslide`-Animation
  unverändert. Vier Dinge hängen daran:
  1. **`touch-action: pan-y` auf `.chart-wrap` ist die Voraussetzung.** Waagrechte
     Gesten gehörten dem Tab-Scroller; ohne die Angabe wechselt der Browser den Tab,
     bevor ein `touchmove` im Handler ankommt. **Folge: ein Tabwechsel per Wisch muss
     neben einem Diagramm beginnen** (Kartenrand, Fusszeile, Hintergrund) — der Rest
     der Karte (`.chart-card`) behält `manipulation`.
  2. **Ausgelöst wird beim LOSLASSEN**, nicht mitten in der Bewegung. Navigiert man im
     `touchmove`, baut `_refreshAfterStateChange` die Karte **unter dem Finger** neu
     auf; die weiteren `touchmove`/`touchend` gehen dann an ein Element, das nicht mehr
     im Dokument hängt, und erreichen die Listener auf `document` nie. Gemessen: bei
     einem langsamen Wisch blieb dadurch die Klick-Sperre ungesetzt.
  3. **Schwelle 45 px UND waagrecht deutlicher als senkrecht** (Faktor 1.5), sonst
     blättert schon ein leicht schräges Scrollen.
  5. **Die Datenfläche zieht mit dem Finger mit** (auf Wunsch, 16.09.2026) — drei
     Phasen, alle über dasselbe `navslide`-Plugin, das schon die Pfeil-Animation
     verschiebt (Achsen und Gitter bleiben deshalb stehen):
     **Ziehen** (`_wischZeichnen`): Ausschlag `(|dx| − Schwelle) × 0.9`, gedeckelt auf
     denselben Weg, den `_animNavSlide` beim Hereinkommen nutzt (`_wischWeg`, 42 % der
     Zeichenfläche, höchstens 110 px); dazu blasser bis 55 %. **Bei Monatsbalken
     anders** (seit 18.09.2026): Zeitstrahl — 1:1 über mehrere Monate, voll deckend,
     kein Hinausgleiten — siehe „Monatsbalken rücken weiter". **Die Schwelle wird
     abgezogen**, sonst spränge die Fläche im Moment der Erkennung um 31 px.
     **Hinausgleiten** (`_wischHinaus`, 150 ms) bis über den Rand, **danach** wird
     geblättert und `_animNavSlide` holt den neuen Stand von der anderen Seite herein.
     **Zurückfedern** (`_wischZurueckfedern`, 220 ms), wenn die Geste nicht zählt.
     Am **Rand des Datenbestands** zieht die Fläche nur mit Dämpfung 0.25 mit und
     federt zurück — das Gummiband sagt „hier ist Schluss", ohne Meldung. Was möglich
     ist, sagt `_navZiel(richtung)`: **eine** Quelle für Pfeile, Geste und Gummiband.
     Alle Animationen teilen sich `_navSlideRAF` mit `_animNavSlide`, damit nie zwei
     gleichzeitig an denselben Diagrammen ziehen; `touchmove` zeichnet höchstens
     **einmal je Bild** (rAF-Drossel) — es feuert öfter als der Bildschirm sich
     auffrischt, und jedes `draw()` zeichnet alle Diagramme des Tabs.
     Gemessen (Prüfstand, Zeichenfläche 282 px): 46 px Geste → 0.9 px Versatz,
     100 → 49.5, 300 → 110 (gedeckelt, Deckkraft 0.55); beim Loslassen 270 px bei
     Deckkraft 0.06, danach `$navslide` wieder entfernt. Am Rand: 150 px → −26.3
     statt −94.
  4. **Nach dem Blättern verwirft ein Capture-Listener 450 ms lang Klicks in der Karte**
     — sonst markiert der von iOS nachgeschobene Klick eine Säule oder schaltet über
     den Kartentitel die Datenbeschriftungen um.
  `blickAnkerMerken(karte)` läuft wie beim Pfeil-Tipp, sonst spränge die Ansicht.
  Geprüft im Prüfstand (simulierte Touch-Ereignisse, alle vier Tabs): schneller und
  langsamer Wisch blättern je einen Schritt und schlucken den Folgeklick; senkrechter
  und zu kurzer Wisch ändern nichts und lassen den Tipp durch; der Tab bleibt stehen;
  die Pfeile der Zeitleiste arbeiten unverändert.
- **Balkenrundung: `BALKEN_RADIUS` (3) ist die einzige Quelle.** Vorher standen 5, 4,
  3 und (im 1M-Fenster) 2 nebeneinander — dieselbe obere Kante sah je nach Diagramm
  anders aus. Klein gehalten: kräftige Kappen lassen kurze Balken abgeschnitten wirken.
- **Schlafdauer ist EIN Balken je Nacht**, kein Stapel mehr. Die zwei Segmente
  („bis Ziel" / „über Ziel") stammten aus der Zeit, als sie verschiedene Farben trugen.
  Seit beide `_slFarbe` nutzen, war der Stapel nur noch schädlich: Chart.js kappt die
  Rundung an der Höhe des **oberen** Segments, und die hängt vom Überschuss ab — je
  nach Nacht 3 oder 15 px, wodurch die Kante von Balken zu Balken anders aussah.
  Die Hilfslinien brauchen weiterhin **eigene Stapelnamen** (`ziel`, `ziel-avg`),
  sonst addiert Chart.js sie auf den Balken.
- **Desktop ab 1024 px: die App füllt die Fläche** (auf Wunsch, 13.09.2026). Vorher
  kappte ein Block `#app` auf **600 px** und stellte ihn mittig, mit Rahmen links und
  rechts — das waren die beiden senkrechten Linien, die am Desktop eine Handy-Ansicht
  andeuteten; Tableiste, Zeitleiste und Einstellungen-Seite waren an denselben Kasten
  geheftet. Ersatzlos entfallen: alle vier tragen von Haus aus `left:0; right:0` bzw.
  `inset:0`.
  **Der Deckel hatte aber einen Grund, und der gilt weiter.** Eine Diagrammkarte über
  die volle Breite ergibt bei 1440 px einen Canvas von **1392 × 210 px — 6.6:1**, in
  dem zwei Balken verloren stehen. Statt die Breite zu begrenzen, wird sie jetzt
  **aufgeteilt**, wie es FitTrack ab 1024 px macht (dort: Karten-Deckel von 520 px
  wieder aufgehoben plus `display:grid` je Screen). Gemessen bei 1440 px: **678 × 283
  statt 1392 × 210**.
  Vier Dinge, die man dabei wissen muss:
  1. **`minmax(0, 1fr)` statt `1fr` ist Pflicht.** `.screen` ist ein Flex-Element im
     Tab-Scroller; mit `1fr` bemessen sich die Spalten an ihrem **Inhalt** statt am
     Container. Gemessen: beide Spalten wurden 1416 px breit, zusammen 2844 px, und
     liefen seitlich aus dem Bild.
  2. **Was über beide Spalten spannt:** der Tab-Banner, der Aufklapp-Bereich
     (`.weitere-inhalt`, der darin selbst zweispaltig wird) und in Herz und Schlaf das
     **Hauptdiagramm** über dem Aufklapp-Bereich. Das ist dort das einzige Element und
     liesse sonst die zweite Spalte leer; es trägt die Seite jetzt als Kopfzeile.
     Training hat vier gleichrangige Diagramme und steht als 2 × 2.
  3. **Innerhalb von `.weitere-inhalt` spannen `.two-col-eq` und `.rec-card`** —
     Ersteres bringt seine eigene Zweiteilung mit (sonst vier Spalten), Letzteres ist
     Fliesstext.
  4. **Die Schwelle ist 1024 px, nicht 768 wie beim alten Deckel.** Ein iPad im
     Hochformat bekommt eine Spalte über die volle Breite; zwei wären dort zu schmal.
     Eine `min-height`-Bedingung braucht es nicht mehr — kein Handy im Querformat ist
     1024 px breit.
  **Unverändert geblieben sind beide Handy-Grössen** (nachgemessen: 375 × 812 →
  Canvas 327 × 147, 812 × 375 → 764 × 210, beide wie vorher): der alte Block verlangte
  `min-height: 600px` und griff dort ohnehin nie.
- **Alle Diagramme sind oberhalb der Fusszeile gleich hoch** (auf Wunsch,
  13.09.2026): Kopfbereich (Titel + Legende) und Diagrammfläche haben in **jeder**
  Karte dieselbe Höhe, die Fusszeile beginnt überall auf derselben Höhe, und die
  Karten unterscheiden sich nur noch in der Zahl ihrer Fusszeilen. Leonard hat die
  Referenzen festgelegt: **Hochformat = „Ruhepuls & HRV"**, **Querformat =
  „Laufstrecke"**. Nachgemessen, jeweils ein einziger Wert für alle neun Diagramme:
  | Fenster | Kopf | Diagramm | Fusszeile ab |
  |---|---|---|---|
  | 375 × 812 (und 360 × 780) | 63.8 | 220.5 | 292.3 |
  | 812 × 375 | 63.8 | 168 | 239.8 |
  | 768 × 1024 | 63.8 | 315 | 386.8 |
  | 1440 × 900 | 63.8 | 283.5 | 355.3 |
  Drei Dinge waren dafür nötig — und müssen so bleiben:
  1. **Kein Diagramm trägt mehr ein eigenes `--h`.** Vorher streuten die Werte von
     210 bis 360 px. Es gibt nur noch `--diagramm-hoch` (315 px) und `--diagramm-quer`
     (210 px) auf `:root`. **Ein neues Diagramm bekommt keine Höhenangabe** — jede
     eigene bricht die Gleichheit wieder auf.
  2. **Keine Inline-Abstände an Titel oder Legende.** Verlauf (`h3` .35rem, Legende
     .3rem) und Schlafdauer (Legende .3rem) wichen genau dadurch um 2.4 bzw. 3.2 px ab.
  3. **Eine Legendenzeile ist immer da.** `.chart-legend` hat `min-height:
     calc(.72rem * 1.4)` (eine Zeile aus dem Type Scale), und der Schlaf-Score, der
     keine Legende braucht, trägt eine **leere** `.chart-legend aria-hidden`. Ohne sie
     begann seine Diagrammfläche 23 px weiter oben.
  **Folge, die man sehen wird:** Laufstrecke und Trainingszeit sind im Hochformat
  deutlich höher als vorher (147 → 220.5), Ruhepuls & HRV, Pace, VO₂max und der
  Verlauf im Querformat deutlich flacher (bis zu 288 → 168). Eine Legende, die auf
  zwei Zeilen umbricht, würde die Gleichheit wieder aufheben — bei 360 px bricht
  derzeit keine um; neue Legendeneinträge deshalb kurz halten.
- **Diagrammhöhen:** kommen aus `--diagramm-hoch` / `--diagramm-quer` (siehe oben),
  nicht mehr aus einem `--h` je Diagramm. Das CSS staffelt sie in **vier** Stufen,
  jede an genau einer Stelle:
  **Hochformat unter 768 px → 70 % von `--diagramm-hoch`**, **Querformat unter
  1024 px → 80 % von `--diagramm-quer`**, dazwischen (iPad im Hochformat) → 100 % von
  `--diagramm-hoch`, **ab 1024 px → 135 % von `--diagramm-quer`**.
  Die 80 % im Handy-Querformat (auf Wunsch, 13.09.2026) sind der einzige Fall, in dem
  nicht die Kartenbreite den Ausschlag gibt, sondern die **Fensterhöhe**: quer hat ein
  iPhone nur 375–440 px, und davon gehen Banner, Kartentitel, Legende und Fusszeilen
  ab. Die Obergrenze von 1023 px hält die Regel aus dem Desktop-Bereich heraus, wo der
  Faktor 1.35 gilt.
  Massgeblich ist nie das Format an sich, sondern die **Breite der Karte**: dieselbe
  Höhe wirkt auf einer halb so breiten Karte fast quadratisch und auf einer doppelt so
  breiten wie ein flaches Band. Deshalb trägt die Hochformat-Regel seit 13.09.2026
  `and (max-width: 767px)` — auf einem iPad im Hochformat ist die Karte 720 px breit,
  und die 70 % machten daraus gemessen ein 4.9:1-Band.
  Alle Diagramm-Karten stehen einzeln untereinander — das frühere dreispaltige
  Raster im Training-Tab (`three-col`) und die Klasse `.chart-wrap-flex` sind mit
  der Neusortierung entfallen.
- **Farbe pro Tab:** Übersicht Teal, Herz Rot, Schlaf Violett, Schritte Grün, Training Orange.
  Innerhalb des Training-Tabs sind **alle vier** Diagramme orange (Pace seit
  18.09.2026, vorher Violett — die Farbe des Schlaf-Tabs): Laufstrecke `#FB923C`,
  Trainingszeit `#F97316`, Pace `#EA580C`, VO₂max `#D97706`. Die **Schlaf-Minikachel**
  der Übersicht trägt seit 18.09.2026 ebenfalls die Tabfarbe ihres Ziels (`#7C3AED`
  statt Hellblau `#2186E8`, das bleibt dem Leichtschlaf im Schlafphasen-Verlauf).
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
- **Durchschnittszeile heisst „Ø 7T", „Ø 1M" … — in JEDEM Diagramm** (auf Wunsch,
  18.09.2026). Das Zeitfenster steht so da wie in der Pille der Zeitleiste; vorher
  hiess die Zeile „Durchschnitt" bzw. „Ø Schlafdauer". Eine Quelle: `oeLabel(zusatz)`
  (aus `_RANGE_OPTS`). Betroffen: Ruhepuls & HRV, Schlafdauer, Schlafphasen-Verlauf
  (vier Zeilen, dort mit Zusatz: `Ø 1M · REM-Schlaf`), Laufstrecke, Trainingszeit,
  Pace, VO₂max. **Nicht** betroffen sind Durchschnitte mit eigener Bezugsgrösse:
  „Ø pro Lauf", „Ø pro Woche", „Ø Wochentag/Wochenende" und „Ø pro Nacht" der
  Schlafschuld (die folgt nicht dem Zeitfilter, sondern den letzten 14 Nächten).
  Im Jahresvergleich entfallen die Zeilen weiterhin ganz.
- **Fusszeilen des Training-Tabs** (auf Wunsch, 18.09.2026):
  **Laufstrecke und Trainingszeit** `Total` → `Ø 1M` → `Ø pro Lauf` →
  `Ø pro Woche` (Letzteres wie bisher erst ab 1M, siehe „Wochenschnitt"); aufgeklappt
  kommen Wochentag/Wochenende dazu. **Pace und VO₂max** tragen nur die
  Durchschnittszeile — auch aufgeklappt: Wochentag/Wochenende beim Pace und
  „Veränderung" bei VO₂max sind **ganz entfallen** (auf Wunsch). Mit „Veränderung"
  ging auch der Vorperioden-Vergleich (`prevPeriod()`) aus dem Training-Tab;
  `vo2Abschnitt(D)` nimmt kein `P` mehr.
  **Die Durchschnittszeile ist der Wert der gestrichelten Ø-Linie** — der Mittelwert der
  Balken, also je Tag (7T, 1M) bzw. je Monat (ab 3M), passend zur Legende „pro Tag"/
  „pro Monat". Tage ohne Einheit stehen als `null` in der Reihe und zählen nicht mit.
  Die Balkenreihen (`_balkenZeit`, `_balkenStr`) werden deshalb **vor** dem Markup
  bestimmt und von Fusszeile und Linie gemeinsam gelesen. Folge: bei 7T und 1M ist
  „Ø 1M" in der Laufstrecke praktisch „Ø pro Lauf" (je Trainingstag statt je
  Einheit — gleich, solange es keinen Tag mit zwei Läufen gibt); ab 3M ist es der
  Monatsschnitt. Pace: Mittel über die Einheiten (`mittelArr(trendPace)`), ebenfalls
  der Linienwert. VO₂max zeigt wie bisher den Mittelwert der Messtage (`v2D`).
  Nachgemessen (Prüfstand, Sep 26): 1M Linie 10.66 km / 67.46 min / 5.62 → Fusszeile
  10.7 km / 1h 7min / 5'37"; 3M 100.16 km / 611.93 min → 100.2 km / 10h 12min.
- **„Ø pro Lauf" in Laufstrecke und Trainingszeit** (auf Wunsch, 14.09.2026): direkt
  nach der Durchschnittszeile (vorher direkt nach „Total"), **immer sichtbar** (nicht hinter dem Ausklapp-Knopf), im
  Jahresvergleich entfällt sie mit den übrigen Ø-Zeilen. Jede Zahl teilt durch das,
  was ihr Total enthält: **Strecke ÷ Einheiten mit Strecke** (`laeufe`), **Zeit ÷
  alle Einheiten** (`anzahl`) — die Trainingszeit summiert auch Intervalltrainings
  ohne Strecke. Das Label heisst in beiden „Ø pro Lauf", obwohl die Zeit genau
  genommen je Training rechnet. Nachgerechnet (Sep 26 im Prüfstand): 6 Einheiten,
  5 mit Strecke → 48.1 km ÷ 5 = 9.6 km, 299 min ÷ 6 = 50 min.
  **Auch im Tooltip jedes Monatsbalkens** (auf Wunsch, 14.09.2026): Summe → `Ø … / Lauf`
  → `Ø … / Woche`. Die Zähler je Monat liegen in `_proMonat` (aus `woRows`, dieselbe
  Rechnung wie die Fusszeile). Bedingung ist der **Balkentyp** (`_lKeyTyp === 'monat'`),
  nicht `_monatsModus`: „/ Lauf" erscheint deshalb auch im Jahresvergleich, „/ Woche"
  weiterhin nur, wo es ein Fenster gibt. Tagesbalken (7T, 1M) bleiben einzeilig.
- **Schlaf-Tab im Querformat: Schlafqualität und Schlafschuld untereinander neben dem
  Schlafphasen-Verlauf** (auf Wunsch, 14.09.2026). Die drei stecken in
  `.schlaf-block.mit-phasen` (Raster `minmax(0,1fr) minmax(0,1fr)`): links das Paar
  (`.two-col-eq`, hier einspaltig), rechts das Diagramm — Reihenfolge aus dem Markup,
  also wie im Hochformat erst die Karten. `mit-phasen` nur, wenn es das Diagramm gibt,
  sonst stünde das Paar in einer halben Spalte. Am Desktop spannt der Block über beide
  Spalten von `.weitere-inhalt`. Gemessen bei 812 × 375: Qualität x 12/y 20, Schuld
  x 12/y 164, Phasen x 412/y 20, je 388 px breit. Hochformat unverändert einspaltig.
- **Zweispaltig im Querformat** (08.09.2026): `.pi-grid` (alle Karten unter
  „Muster & Zusammenhänge") und `.two-col-eq` (die Paare „Ruhepuls-/HRV-Einordnung"
  und „Schlafqualität-Verteilung/Schlafschuld") bekommen dort
  `grid-template-columns: 1fr 1fr`. Beide Paare tragen denselben Rahmen — das
  Schlaf-Paar wurde dafür nachträglich in `.two-col-eq` gefasst.
  **Abstände kommen aus dem `gap` des Rasters, nicht aus den Karten:** `.two-col-eq>*`
  setzt `margin-bottom: 0`, sonst stünde der Kartenabstand im Querformat zusätzlich
  zwischen den Spalten und verfälschte die Zeilenhöhe — dieselbe Falle wie bei
  `.ov-oben`. Gemessen bei 900 px: Spalten 281 px, Lücke 11 px.
- **Übersicht im Querformat:** „Ziele" und die Kachel-Karte stehen **nebeneinander**
  (`.ov-oben`, Grid `1fr 1fr`) und sind **gleich hoch — nach dem Mass der Ziele-Karte**.
  Dafür bestimmt die Kachel-Spalte die Zeilenhöhe NICHT mit: `.ov-oben-kacheln` bleibt
  leer, die Karte darin liegt `position:absolute; inset:0`. Mit blossem
  `align-items:stretch` gäbe die **höhere** der beiden das Mass vor — das ist die
  Kachel-Karte, und „Ziele" würde mitwachsen statt umgekehrt. `min-height:12rem` am
  Kasten verhindert den umgekehrten Fehler: liegen ausnahmsweise nur ein, zwei Ziele
  vor, schnitte `overflow:hidden` die Kacheln sonst ab.
  Der Kartenabstand sitzt am **Container** (`.ov-oben{margin-bottom:.7rem}`), nicht an
  den Karten: im Raster verfälschte er die Zeilenhöhe, und ohne ihn stiess die
  Verlauf-Karte direkt an — Schatten an Schatten, was wie eine Überlappung aussah.
  Die vier Minikacheln stehen darin **zweizeilig** — seit 13.09.2026 in jeder
  Ausrichtung (siehe dort). Reihenfolge
  überall gleich, weil sie aus dem Markup kommt: **Ruhepuls, HRV, Schlaf, Training** —
  also oben die Herz-Werte, unten Schlaf und Training. Die Warnkarte steht
  **über** dem Paar; zwischen zwei nebeneinanderliegenden Karten wäre kein Platz.
- **Minikacheln der Übersicht (`.ti-metric`): ohne Kartenhintergrund** (auf Wunsch,
  08.09.2026). `.ov-combo-card` trägt weder Fläche noch Schatten noch Polster mehr —
  die vier Kacheln sitzen direkt auf dem Tab-Verlauf. **Der ist in beiden Themes
  dunkel**, deshalb tragen `ti-metric-lbl`, `-val`, `-einheit` und `-delta.neu` jetzt
  **Weiss** statt der Grautöne aus dem Type Scale; ohne das wären sie unlesbar.
  Grün und Rot der Abweichungszeile bleiben — sie tragen die Bewertung, nicht die
  Lesbarkeit. Farbige Oberkante und Farbschleier jeder Kachel bleiben ebenfalls: sie
  sind das Einzige, was die Kacheln ohne Karte noch voneinander abgrenzt. Der
  Schleier steht deshalb auf **43 %** (`KACHEL_SCHLEIER`, dreimal auf Wunsch
  angehoben: 5/7 % → 16 % am 08.09.2026 → 24 % („50 % deckender") → 43 % („80 %
  deckender", 24 × 1.8), beide am 13.09.2026; „X % deckender" wird als relative
  Steigerung gelesen). Bei 43 % tritt das Grün und Rot der Abweichungszeile auf der
  roten bzw. blauen Kachel sichtbar zurück — wer weiter anhebt, prüft deren Lesbarkeit —
  die früheren 5 % waren auf dem dunklen Verlauf praktisch unsichtbar. **Eine
  Quelle für alle vier**: vorher standen drei Kacheln auf 5 % und die
  Trainingskachel auf 7 %, ohne dass das je jemand entschieden hätte.
  Inhalte waagrecht **und** senkrecht zentriert. Das ⓘ steht dabei im Textfluss hinter der Beschriftung — absolut in der
  Ecke liesse sich der Inhalt nicht zentrieren, weil die Abweichungszeile dann einen
  einseitigen Rand als Ausgleich bräuchte.
  **Grösser und zweizeilig** (auf Wunsch, 13.09.2026): vier Kacheln in einer
  Reihe waren 83 px breit, jetzt sind es zwei Reihen à 171 px (bei 375 px Fenster).
  Reihenfolge unverändert **Ruhepuls, HRV / Schlaf, Training** — sie kommt aus dem
  Markup, das Raster macht daraus von selbst zwei Zeilen.
  1. **`--kachel` ist der Massstab für ALLES an der Kachel** — Schrift, Polster,
     Abstände, Rundung, Symbol. Er steht auf `.ti-metrics` und wird überall
     multipliziert (`calc(var(--kachel,1) * …)`). Einzelne Werte zu verdoppeln hiesse,
     beim nächsten Mal wieder jeden davon zu suchen. Fallback 1 ergibt die alte Grösse.
     **Er steuert Höhe und Schrift, NICHT die Breite** — die kommt aus dem Raster
     (`1fr 1fr`) und bleibt davon unberührt. Weil jeder Bestandteil der Höhe (Polster,
     Beschriftung, Wert, Abweichungszeile) mitskaliert und keine feste Grösse dazwischen
     steht, ist die Höhe **linear** in `--kachel`: gemessen 175.8 px bei 2 und 141.2 px
     bei 1.6, also exakt −19.7 % für −20 % Massstab. Wer die Kachel höher oder flacher
     will, ändert deshalb genau diese eine Zahl.
     **Stand: 1.6** — zuerst stand hier 2, auf Wunsch am selben Tag um 20 % reduziert
     („Breite behalten, 20 % weniger hoch und kleinere Schrift").
  2. **Die Schriftgrössen stehen deshalb einzeln im Type Scale**, nicht mehr in den
     Gruppen „Display M" und „Caption": sonst zöge eine Vergrösserung der Kacheln den
     Banner-Titel und jedes andere Mini-Label mit.
  3. **Im Querformat gilt `--kachel: 1.2`.** Dort teilen sich die Kacheln die
     Zeile mit „Ziele", und diese Karte gibt die Höhe vor (siehe `.ov-oben`). Als der
     Wert festgelegt wurde, blieben 94 px je Kachelzeile: Massstab 2 ragte 20 px
     heraus und wurde abgeschnitten, 1.3 passte gerade noch, 1.4 nicht mehr.
     **Diese Grenze hängt an der Höhe der Ziele-Karte und ist mit ihr gewandert:**
     seit die Karte 20 % grösser ist (siehe `--ziel`), sind es 113.5 px je Zeile, und
     nachgemessen passt dort jetzt bis **1.7**. Die 1.2 stehen also nicht mehr am
     Anschlag — wer sie anhebt, misst neu, statt sich auf eine Zahl von gestern zu
     verlassen. Erst wer mehr will, als die Zeile hergibt, muss die Kacheln aus der
     Zeile mit „Ziele" herausnehmen.
  4. **Das ⓘ wächst mit kleinerem Faktor** (9 px je Schritt statt 13): „❤️ Ruhepuls"
     braucht bei doppelter Schrift 126 px, mit einem verdoppelten 26-px-Kreis kam die
     Zeile auf 160 px — 4 px mehr, als die Kachel innen breit ist, und das ⓘ rutschte
     allein auf eine zweite Zeile. Mit 18 px bleiben 8.5 px Luft.
  5. **`grid-auto-rows: 1fr` hält beide Zeilen gleich hoch.** In einer Reihe ergab sich
     das von selbst; über zwei Zeilen bemisst jede ihre eigene Höhe.
  Gemessen bei 375 px, gegen die alte einreihige Anordnung: Breite 82.9 →
  **171.5 px** (2.07×), Wert-Schrift 21.1 → **33.8 px** (1.60×), Höhe 131.7 →
  **141.2 px**. Die Höhe wächst also kaum — die alte kam nicht vom Inhalt, sondern
  vom Umbruch in der schmalen Kachel. Eine erzwungene Höhe von 263 px wurde bei
  Massstab 2 ausprobiert und verworfen: die Kachel ist dann halb leer, und die zweite
  Zeile liegt unter dem Bildschirmrand.
  **Jeder Wert passt einzeilig, auch bei 360 px** — bei Massstab 2 brach dort noch
  „53 bpm" um. Für die längste Beschriftung („❤️ Ruhepuls" samt ⓘ) bleiben bei 375 px
  jetzt 39 px Luft statt 8.5. Die frühere Sonderregel `@media (max-width:360px)`
  (dort zweispaltig) ist entfallen: zweispaltig ist jetzt der Normalfall.
- **Minikacheln führen per Tipp in ihren Tab** (auf Wunsch, 13.09.2026): Ruhepuls und
  HRV → Herz, Schlaf → Schlaf, Training → Training — **mit Wisch-Animation**, nicht als
  Sprung. Das Ziel steht als `data-ziel-tab` an der Kachel (`kachelZiel()`, dazu
  `role="button"`, `tabindex="0"`, `aria-label`); **leere Kacheln bekommen es nicht**.
  `zuTabWischen(name)` animiert `scrollLeft` des Tab-Scrollers — also genau das, was
  auch der Finger bewegt. Hintergrund-Verlauf, Tabfarbe, Tableisten-Markierung und
  passive Zeitleiste laufen dadurch über den vorhandenen Scroll-Sync mit und sehen
  aus wie ein Wisch. Die Tableiste wechselt über `showScreen()` weiterhin sprunghaft.
  Dauer 380 ms für einen Tab, +110 ms je weiteren (Übersicht → Training 600 ms),
  easeInOutCubic; bei `prefers-reduced-motion` Sprung.
  **Fünf Dinge, die daran hängen:**
  1. **`scroll-snap-type` ist während der Animation aus** (Inline-Stil `none`, danach
     wieder leer). Mit `x mandatory` rastet Safari jeden Zwischenschritt auf den
     nächsten Tab ein. Am Ende steht `scrollLeft` exakt auf dem Ziel.
  2. **Der Endzustand wird ausdrücklich gesetzt** (`currentScreen`,
     `setTabBackgroundInstant`, `_applyTabState`) — nur wenn die Animation bis zum
     Ende lief. Der Scroll-Sync allein reicht nicht als Beleg: der verdeckte
     Vorschau-Pane feuert keine `scroll`-Events, und dort blieben Tabfarbe und
     Markierung auf „Übersicht" stehen, obwohl die Seite schon auf „Herz" stand. Mit
     gesetztem `currentScreen` überspringt der Settle-Timer des Syncs seinen Aufruf.
     Geprüft mit **und** ohne simulierte Scroll-Events: beide Wege enden gleich.
  3. **Eine Berührung bricht ab** (`touchstart`/`pointerdown` am Container) — dann gilt
     das native Einrasten, und kein Tab wird erzwungen. Gemessen: Abbruch bei 0.31 →
     rastet zurück auf die Übersicht.
  4. **Das ⓘ in der Kachel bleibt ausgenommen** (`!t.closest(TT_TAP_SELECTOR)`) und
     öffnet weiter seine Erklärung; `[data-ziel-tab]` steht in der Ausnahmeliste des
     Hintergrund-Tipps, sonst schaltete derselbe Tipp zusätzlich die Tableiste um.
  5. **Druck-Rückmeldung NUR über Deckkraft** (`:active{opacity:.75}`), ohne
     `transform` wie bei Knöpfen: die Kacheln liegen im waagrecht und senkrecht
     scrollenden Bereich, und ein transform während `:active` bricht auf iOS die
     Wischgeste ab (siehe „Tipp-Animation").
  Ein noch nicht gebauter Ziel-Tab wird **vor** dem Start gebaut, sonst wischte eine
  leere Seite herein.
- **Bezugszeitraum:** Kacheln, die dem globalen Zeitfilter **nicht** folgen, tragen ein
  `scopeBadge('…')` (z. B. `heute`, `letzte 14 Nächte`, `gesamter Datenbestand`).
- **Namensgebung:** ausgeschriebene Namen statt Kürzel — `mittel()` statt `av()`,
  `zahl()` statt `fn()`, `zeichneDiagramm()` statt `mkC()`, `alsStdMin()` statt `toHM()`,
  `prozentDiff()` statt `pct()`, `monatsMittel`/`wochenSumme` statt `mAvg`/`wSum`.
- **Gemeinsame Helfer statt Copy-Paste:** `statZeile(label, wert, farbe)` (Label links,
  Wert rechts — 44 Stellen), `splitWeekWknd(rows)` (Wochentag/Wochenende),
  `fmtPace`/`paceFromSpeed` (Pace), `datenStandZeilen()` (Daten-Stand in der App-Karte
  der Einstellungen).
- **`esc()` bei jedem Fremdtext — nicht verhandelbar.** Alles, was NICHT aus diesem Code
  stammt und als **Text** angezeigt wird (Sheet-Zellen, Google-Fehlermeldungen), muss durch
  `esc()`. Die Seiten entstehen per `innerHTML`; ohne `esc()` würde Auszeichnungscode in
  einer Zelle ausgeführt statt angezeigt — und käme damit an den Google-Token im
  `localStorage`, also an die Sheets. Zahlen und Datumsangaben sind ausgenommen, die
  werden beim Einlesen geprüft (Datum: `/^\d{4}-\d{2}-\d{2}$/` in **beiden** Sheets).
  Betrifft besonders neue Anzeigen von Textfeldern wie der Trainingsart (`typeRaw`).
- **Kartenschatten:** `--shadow` ist die **einzige** Quelle — alle Karten
  (`chart-card`, `kpi`, `pi-card`, `warn-card`, `rec-card`, `no-data`, …) lesen sie.
  Sie trägt jetzt denselben Schatten wie die Ausklapp-Knöpfe (`0 1px 6px rgba(0,0,0,.18)`),
  **ohne** die frühere Haarlinie — die wirkte neben dem Knopf wie eine Umrandung.
  Im Dunkelmodus dieselbe Form mit `.45` statt `.18`: ein 18%-Schwarz verschwindet
  auf dunklem Grund und die Karten hätten keine Kante mehr.
- **Aufklapp-Schalter sitzt unten rechts in der Zeitleiste** (rechts seit
  08.09.2026, davor kurz links; in der Zeitleiste seit 07.09.2026, davor
  kurz als `.pg-act.ausklapp-act` in der Kopfzeile, davor als breiter Balken im
  Inhalt). Er ist ein Kind von `#zeitleiste`, absolut auf `bottom: 0` gesetzt und
  liegt damit auf **derselben Unterkante wie die Pille**. Er trägt deren Fläche,
  Rahmen und Schatten und macht den **passiven Modus mit** — `scale(.7)` und
  `opacity: .5`, ausgelöst von denselben Ereignissen; ein Tipp darauf weckt die
  Leiste ebenso wie ein Tipp auf Pille oder Pfeil.
  Sein Skalierungs-Ursprung ist die Ecke, an der er klebt (`bottom right`), nicht
  `bottom center` wie bei der Reihe: sonst wanderte er beim Schrumpfen von seinem
  Platz am Rand weg. Weil die Reihe **zentriert** ist, ist der Platz links und rechts
  gleich knapp — gemessen bleiben bei 375 px auf beiden Seiten 11 px Luft.
  **Sein Inhalt hängt am Tab, nicht an der Leiste.** `zeitleisteAusklapp()` liest
  `AUSKLAPP[currentScreen]` und setzt Chevron, Titel und `data-ausklapp`; Tabs ohne
  Eintrag blenden ihn aus (seit 14.09.2026 hat **jeder** Tab einen — Training klappt
  damit die Wochentag/Wochenende-Fusszeilen). Aufgerufen wird es aus
  `zeitleisteAktualisieren()` **und** aus `_applyTabState` — beim Wechsel auf einen
  bereits gerenderten Tab läuft kein `_renderTab`, der Knopf zeigte sonst den
  vorherigen Tab an. `.zl-ausklapp[hidden]{display:none}` ist Pflicht (siehe
  `hidden`-Gotcha).
  **`AUSKLAPP` ist die einzige Quelle** dafür, welcher Tab etwas zum Aufklappen hat,
  wie es heisst und wie umgeschaltet wird — Knopf, Zustand und Handler lesen dieselbe
  Tabelle. Tabs ohne Eintrag zeigen den Knopf gar nicht.
  **Optik 1:1 aus FitTracks Übungen-Tab** (`.ex-sort-btn`): heller Knopf
  (`rgba(255,255,255,.95)`, Radius 10, Schatten `0 2px 8px`) mit **Doppel-Chevron**
  als SVG (18 px, `stroke-width:1.8`, runde Enden) — nach unten zum Aufklappen, nach
  oben zum Einklappen. Die Strichfarbe folgt hier `--tab-color` statt FitTracks fester
  Akzentfarbe. Er hebt sich damit bewusst von den durchscheinenden Nachbarn (＋, 🌙) ab.
  **Links davon steht in der Übersicht das Zahnrad** (`.pg-act.einst-act`) zur
  Einstellungen-Seite. Es trägt bewusst die durchscheinende Optik der übrigen
  `.pg-act` — der Ausklapp-Knopf ist der einzige helle Knopf der Zeile und soll das
  bleiben.
- **Tipp-Animation (aus FitTrack):** `button` und `.info-i` tragen
  `transition: opacity .15s, transform .1s` und im gedrückten Zustand
  `opacity:.75; scale(.97)`. Bewusst als **Element-Regel** (Spezifität 0,0,1), damit
  Klassen mit eigenem Druckpunkt (`.pg-act`: `scale(.94)`) ohne `!important` gewinnen.
  Klassen mit eigenem `transition` müssen `opacity`/`transform` mitführen, sonst
  springt der Druckpunkt. **Merke für künftige Scrollbereiche:** ein `transform`
  während `:active` bricht auf iOS die laufende Wischgeste ab — in FitTrack liess sich
  das Jahresraster dadurch gar nicht mehr scrollen.
- **Aufklapp-Knöpfe teilen eine Klasse:** „Weitere Auswertungen" (Herz, Schlaf) und
  „Muster & Zusammenhänge" (Übersicht) tragen beide `.weitere-btn` und sehen damit
  identisch aus. Der Muster-Knopf hatte vorher als `.pi-titel` das Aussehen einer
  Kapitelüberschrift (grau, versalgesetzt, ohne Fläche); beide Klassen sind
  zusammengelegt, `.pi-titel`/`.pi-pfeil` gibt es nicht mehr. Neue Aufklapp-Knöpfe
  nehmen `.weitere-btn` + `.weitere-pfeil`, damit das so bleibt. Drei Stellen nutzen
  ihn: „Weitere Auswertungen" in **allen drei** Tabs — **alle starten zu**
  (`_weitereOffen = {overview, herz, schlaf, training}`; `training` seit 14.09.2026). In der Übersicht steckt seit
  08.09.2026 auch das **Verlaufs-Diagramm** dahinter, nicht mehr nur das
  Muster-Raster; deshalb heisst der Zustand nicht mehr `_musterOffen` und der
  Knopf nicht mehr „Muster & Zusammenhänge". Die frühere vierte Stelle, die
  App-Karte der Übersicht (`_appOffen`), ist mit dem Umzug auf die
  Einstellungen-Seite entfallen.
- **„Weitere Auswertungen" (Herz, Schlaf):** beide Tabs zeigen nur ihr **erstes**
  Diagramm; der Rest liegt hinter einem Knopf über die volle Kartenbreite
  (`weitereAuf(tab)` öffnet Knopf + `<div class="weitere-inhalt">`, das schliessende
  Tag steht im Markup). Zustand in `_weitereOffen`, Start **zu**. Der Knopf trägt
  **weisse** Schrift auf hellem Weiss-Schleier, **keine** Umrandung und einen feinen
  Schatten — er sitzt auf dem farbigen Tab-Hintergrund, wo eine Kontur hart wirkte,
  der Schatten ihn aber weiterhin als Knopf ausweist.
  Das Umschalten ruft `_renderTab` — **nicht** nur ein-/ausblenden: Diagramme, die im
  verborgenen Bereich gezeichnet wurden, behalten Breite 0, und weder `resize()` noch
  `update()` holen sie da heraus. Nur ein Neuaufbau bei sichtbarem Container hilft.
  Seit 14.09.2026 legt sich eine **Animation** um diesen Neuaufbau (siehe nächster
  Abschnitt).
- **Wochentag/Wochenende-Fusszeilen hängen am Ausklapp-Knopf; alles Ausklappbare ist
  animiert** (auf Wunsch, 14.09.2026).
  **Die Fusszeile „Differenz" ist aus allen Diagrammen entfallen** (Ruhepuls & HRV,
  Schlafdauer, Laufstrecke, Trainingszeit). Die Zeilen **„Ø Wochentag (Mo–Fr)" und
  „Ø Wochenende (Sa–So)"** stehen nur noch bei **offenem** Ausklapp-Zustand ihres Tabs,
  also standardmässig nicht. Betroffen: Ruhepuls & HRV, Schlafdauer, Laufstrecke,
  Trainingszeit (beim Pace seit 18.09.2026 ganz entfallen). In Herz und Schlaf klappt **derselbe** Knopf „Weitere
  Auswertungen" und die Wochenzeilen gemeinsam — ein Zustand je Tab, kein zweiter
  Schalter. Training hat dafür einen eigenen `AUSKLAPP`-Eintrag bekommen.
  **Aufbau:**
  1. `fussMehr(tab, zeilen)` liefert die Zeilen in einer Hülle `.fuss-mehr` — oder
     `''`, wenn zu oder leer. EINE Hülle statt einzeln markierter Zeilen, damit die
     Animation einen Block bewegt (mit einzelnen Zeilen spränge der `gap` der Liste).
     Die Hülle steht in jeder Fusszeile **zuletzt**; darauf verlässt sich die
     Trennlinie (`.stat-row:last-child`).
  2. **Pace war bis 18.09.2026 der Sonderfall:** seine Fusszeile bestand NUR aus diesen
     zwei Zeilen, deshalb klappte dort die **ganze** `.diagramm-fuss`. Heute hat Pace
     nur noch die Durchschnittszeile und gar keine Ausklapp-Zeilen. Wer eine Fusszeile
     baut, die zugeklappt leer wäre, braucht den alten Weg wieder (die ganze Fusszeile
     trägt `ausklapp-teil`) — sonst bleibt eine leere Fusszeile mit Trennlinie stehen.
  3. **Alles, was der Knopf zeigt, trägt die Klasse `ausklapp-teil`** — `.weitere-inhalt`,
     der Verlauf und das Muster-Raster der Übersicht, die Fusszeilen-Hüllen. Wer etwas
     Neues hinter den Knopf legt, gibt ihm diese Klasse, mehr braucht es nicht.
  **Animation (`ausklappUmschalten`, `_ausklappAnimieren`, 280 ms):**
  - **AUF:** erst Zustand + `_renderTab` (bei Training auf dessen Promise warten), dann
    wachsen die Teile von 0 auf ihre Höhe. Die Diagramme haben dabei schon ihre echte
    Breite; animiert wird nur der Rahmen, `overflow:hidden` schneidet zu.
  - **ZU:** Chevron sofort umdrehen, die vorhandenen Teile schrumpfen auf 0
    (`fill: forwards`), **danach** `_renderTab`.
  - Animiert werden Höhe, Deckkraft **und** `margin`/`padding` oben und unten — mit der
    Höhe allein erschienen Abstand und Innenrand der Pace-Fusszeile am Ende auf einen
    Schlag. `overflow:hidden` wird **vor** dem Messen gesetzt, sonst zählt der
    Aussenabstand des letzten Kinds mit.
  - Nur die **äussersten sichtbaren** Teile; ein Teil in einem Teil liefe doppelt.
  - Ein zweiter Tipp während der Animation wird verworfen (`_ausklappLaeuft`).
  - `prefers-reduced-motion` → ohne Animation.
  **Die Falle, die der Prüfstand gezeigt hat:** Das Ende kommt aus `onfinish` ODER aus
  einem Zeitgeber (+80 ms) — ein Tab, der nicht gezeichnet wird, lässt die
  Animationszeit stehen, und ohne Rückfall bliebe der Knopf für immer gesperrt. Der
  Zeitgeber allein reichte aber nicht: die stehengebliebene Animation hielt ihr
  **erstes Bild** fest, beim Aufklappen also **Höhe 0** — der Knopf meldete „offen",
  die Fusszeilen blieben unsichtbar. Deshalb ruft `ende()` ausdrücklich `a.finish()`.
  Nachgemessen durch Vorspulen (`currentTime`): Höhe 0 → 13 → 43 → 53 → 55.4 px bei
  0/70/140/210/279 ms, Deckkraft 0 → 1, danach keine Animation mehr am Element.
  **Im Prüfstand beachten:** bei 7T fehlt „Ø Wochenende" in den Trainings-Diagrammen,
  wenn die erfundene Woche kein Wochenendtraining hat — das ist die Datenlage, nicht
  der Klapp-Mechanismus. Bei 1M erscheinen beide.
- **Weitere Animationen** (auf Wunsch, 18.09.2026 — Vorschläge 1 und 3–10; Punkt 2,
  die Tableiste per Wisch statt Sprung, wurde **nicht** gewählt). Alle kurz
  (150–450 ms), alle ohne Bewegung bei `prefers-reduced-motion` (`bewegungAus()`).
  Die Zeichen-Animationen im Canvas laufen über **einen** Helfer, `uebergang(dauer,
  proSchritt, fertig)` (rAF, easeOutCubic, **Zeitgeber als Rückfall** — ohne ihn bliebe
  in einer nicht gezeichneten Seite jeder Zustand auf dem ersten Bild stehen). Die
  DOM-Animationen (WAAPI) tragen denselben Rückfall und rufen darin `finish()` —
  dieselbe Falle wie bei `_ausklappAnimieren`, und der Prüfstand hat sie hier ein
  zweites Mal gezeigt: die Zeitleisten-Auswahl stand offen, aber mit Deckkraft 0.
  1. **Zeitleisten-Auswahl** (`zeitleisteAuswahl`): wächst aus der Pille nach oben
     (190 ms, Deckkraft + `scale(.92)`, `transform-origin: bottom center`) und
     schrumpft beim Schliessen zurück (150 ms). `hidden` bleibt der Zustand, wird beim
     Schliessen aber erst **nach** der Animation gesetzt; währenddessen nimmt die Box
     keine Tipps an. Gleicher Zustand wie vorher → nichts tun (eine laufende Animation
     läuft weiter). Geprüft: auf/zu/auf in 40 ms endet offen und sichtbar.
  3. **Hinweisleiste** (`hinweisZeigen`/`hinweisAus`): gleitet von oben herein (280 ms)
     und hinaus (220 ms), um die eigene Höhe **plus 14 px** — sonst bliebe ihr Schatten
     als Streifen am oberen Rand. Der Platz darüber wächst über
     `.screen{transition: padding-top .28s}` mit. Gemessen: −56.4 → −9.1 → 0 px bei
     0/140/279 ms, Innenabstand 8 → 40.6 → 50 px.
  4. **Balken der Einordnungs-Karten** (`balkenFuellen`, aus `_injectTopbar`):
     `.goal-bar-fill`/`.debt-bar-fill` trugen schon immer `transition: width .5s`, kamen
     per innerHTML aber in voller Breite an — zu sehen war davon nie etwas. Jetzt
     startet jeder Balken bei seiner **letzten** Breite (je Tab und Position gemerkt):
     beim Aufklappen von 0, beim Blättern vom alten Wert (gemessen 60 % → 100 %,
     40 % → 0 %). Nur **sichtbare** Balken zählen; die im zugeklappten Bereich
     (`display:none`) werden vergessen und wachsen beim nächsten Aufklappen wieder von 0.
  5. **Aufbau-Animation der Diagramme**: 450 statt 1000 ms
     (`Chart.defaults.animation.duration`). Und **wo sich die Daten nicht ändern,
     wächst nichts neu**: `_ruhigRendern(tab)` baut den Tab ohne Aufbau-Animation für
     alle Diagramme, die vorher **sichtbar** waren. Benutzt beim Umschalten einer
     Hilfslinie und beim Aus-/Einklappen. „Sichtbar", nicht „vorhanden": die Diagramme
     im zugeklappten Bereich existieren schon (ohne Fläche) — als vorhanden gezählt,
     erschienen Schlafphasen- und Score-Verlauf beim Aufklappen fertig statt
     hereinzuwachsen. Bei Training (asynchron) bleibt die Liste bis zum Ende des
     Aufbaus stehen.
     Die **Hilfslinie selbst blendet** (`hilfslinienBlende`-Plugin, `$hlBlende =
     {art, alpha}`, 220 ms): beim Ausschalten erst aus, dann Neuaufbau ohne sie; beim
     Einschalten Neuaufbau, dann ein. Eingeblendet wird aus `zeichneDiagramm` heraus
     (`_hlPlan`), weil Training seine Diagramme erst nach dem Aufruf baut. Chart.js
     zeichnet das erste, volle Bild schon im Konstruktor; das `draw()` mit Deckkraft 0
     ersetzt es in derselben Aufgabe, bevor der Browser malt — es blitzt nichts auf.
     Während eine Linie ausblendet, sind weitere Schalter-Tipps gesperrt
     (`_hlLaeuft`). Unverändert mit Aufbau-Animation: Bereichswechsel, Jahresvergleich,
     neue Daten. Beim Blättern gilt weiterhin die `navslide`-Animation.
     **Falle, die daran hing (gemeldet 18.09.2026):** Nach Ausklappen und Hilfslinien-
     Schalter fehlten Datenbeschriftungen und Wochentrenner. Ohne Aufbau-Animation
     zeichnet Chart.js schon **im Konstruktor** — also bevor `zeichneDiagramm` `$keys`,
     `$werteFmt` usw. an das Diagramm hängt, und genau daran hängen beide Plugins. Mit
     Animation fiel das nie auf, weil das erste Bild erst im nächsten Frame kommt; beim
     Blättern überdeckte es die `navslide`-Animation, die ohnehin neu zeichnet.
     `zeichneDiagramm` zeichnet deshalb bei `animation: false` nach dem Anhängen noch
     einmal. Geprüft: nach Ausklappen und Schalter ändert ein weiteres `draw()` in
     Herz, Schlaf und Training kein Pixel mehr. **Wer künftig etwas Neues an das
     Diagramm hängt, hängt es vor dieses `draw()`.**
     Im Prüfstand stehen die hereinwachsenden Diagramme (Schlafphasen-, Score-Verlauf)
     dauerhaft mitten in ihrer Aufbau-Animation: Chart.js hält das echte
     `requestAnimationFrame` fest, bevor `?raf=timer` es ersetzt, und das feuert im
     verdeckten Pane nie. Das ist kein Fehler der App.
  6. **Markierung** (`setMarkierung`, 150 ms): Tönung und Schleier laufen über
     `_markAlpha`; beim Ausschalten zeichnet das Plugin den eben abgeschalteten Tag
     (`_markVerblasst`) weiter, bis er ausgeklungen ist. `_markIndex(chart, datum)`
     nimmt dafür ein optionales Datum. Der Wechsel von Säule zu Säule **springt**
     weiterhin (der Schleier steht dort schon). Der **Tooltip blendet nicht** — seine
     Animation bleibt aus (siehe „Markierung"); er verschwindet sofort, während der
     Schleier noch ausklingt. Während der Blende zeichnen nur die Diagramme des
     sichtbaren Tabs, am Ende alle. Gemessen: Tönung 0 → 33/255 (= 0.13) und zurück.
  7. **Datenbeschriftungen** per Titel-Tipp (`_werteBlenden`, 180 ms): `$werteBlende
     = {alpha, aus}`; `aus` hält die Zahlen beim Ausblenden noch im Bild, obwohl
     `beschriftungAn` schon false liefert. Im Training-Tab blenden alle vier Diagramme
     gemeinsam.
  8. **Hell/Dunkel** über `document.startViewTransition` (Safari ab iOS 18): alter
     und neuer Zustand blenden als Ganzes ineinander, Dauer 0.28 s in
     `::view-transition-old/new(root)`. Ohne die API wie bisher ein Umschlag in einem
     Bild. Der Rückruf läuft **asynchron** (direkt nach dem Tipp ist `body.dark` noch
     der alte Stand) und auch dann, wenn der Übergang übersprungen wird — `ready` lehnt
     dann ab und wird abgefangen, sonst stünde die Ablehnung in der Konsole (im
     Vorschau-Pane bei jedem Tipp).
  9. **Kachel-Zahlen zählen hoch** (`kachelZahl`, `kachelnHochzaehlen`, 450 ms): beim
     Start von 0, bei neuen Daten vom zuletzt gezeigten Wert auf den neuen. **Nicht**
     bei jedem Aufbau der Übersicht — ausgelöst über `_kachelnZaehlen`: true beim
     Start, gesetzt von den drei Wegen, auf denen neue Daten ankommen (stilles
     Nachladen, „Anzeigen" in der Hinweisleiste, „Daten aktualisieren"), verbraucht vom
     nächsten Aufbau der Übersicht, der Kacheln hat. Die Schlafdauer zählt in Minuten.
     Die Zahl sitzt in `.ti-zahl` mit `tabular-nums`, sonst wackelte der zentrierte
     Wert beim Zählen seitlich. Die Endzahl steht bereits im HTML; der Rückfall-Zeitgeber
     bringt sie auch ohne gezeichnete Seite ans Ziel. Gemessen: 0 → 55/64/8h 22m/2 in
     440 ms; nach neuen Daten 55 → 53, 64 → 60, 8h 22m → 7h 22m; Bereichswechsel lässt
     die Zahlen stehen.
  10. **„Daten aktualisieren" bestätigt den Erfolg** (`refreshBestaetigen`): 1.8 s lang
     „Aktualisiert ✓" auf Grün (`.update-btn.ok`), dann wieder der alte Text. Nur bei
     `ergebnis === true`, und erst **nach** `appKarteAuffrischen()` — die baut die
     Einstellungen-Seite neu und ersetzt dabei den Knopf. `.update-btn` führt in seiner
     `transition` `opacity`/`transform` mit (siehe „Tipp-Animation").
- **Trainings-Einblicke** (auf Wunsch, 18.09.2026): 19 Karten hinter dem
  Ausklapp-Knopf des Training-Tabs unter VO₂max, **alle über den gesamten
  Datenbestand** — sie folgen dem Zeitfilter nicht. Dieselbe Karte wie „Muster &
  Zusammenhänge" (`insightKarte()`, jetzt gemeinsam genutzt), in vier Abschnitten mit
  weissen Titeln auf dem Tab-Verlauf (`.tr-abschnitt`). Berechnung in
  `_trainingsInsightsBerechnen()`, gemerkt über `_memo('trainingsInsights')`;
  `_parseWorkoutRows` verwirft den Eintrag selbst, weil der Analytics-Cache sonst nur
  beim Einlesen der Gesundheitsdaten geleert wird.
  **Begriffe:** Einheit = ein Eintrag im Workout-Blatt (`workoutData[d].einheiten`),
  Lauf = eine Einheit mit Strecke > 0. Nächte wie in der Übersicht: `sleepTotal` am
  Tag d ist die Nacht davor, die Folgenacht von d steht am Tag d + 1.
  **Rekorde:** Rekordmonat (km, dazu der Monatsschnitt über alle Monate seit
  Datenbeginn), Rekordwoche (km, KW), längster Lauf, längste Einheit (Dauer),
  schnellster Lauf **ab 5 km** (kürzere Läufe und GPS-Ausreisser verzerrten sonst),
  aktivster Monat (Trainingstage), längste Serie (Wochen in Folge mit ≥ 2 Einheiten;
  die laufende Woche bricht eine Serie nicht, solange sie noch keine 2 hat),
  VO₂max-Bestwert. **Gewohnheiten:** Lieblingstag (Anteil der Trainingstage je
  Wochentag), typischer Lauf (Median von Strecke und Pace), Trainingsmix (bis vier
  Arten einzeln, ab fünf „Sonstige"; Namen über `TRAININGSART_KURZ`, unbekannte roh,
  immer `esc()`), Erholung (Ø Ruhetage, häufigster Abstand, längste Pause).
  **Entwicklung:** Pace-Trend und Laufeffizienz (je letzte 91 Tage gegen die 91
  davor, ab dem neuesten Datentag; Effizienz = Puls bei ähnlicher Pace, Band ±20 s/km
  um den Median), Jahr gegen Vorjahr bis zum selben Datum (nur, wenn das Vorjahr ab
  Januar Daten hat), Hochrechnung aufs Jahresende (ab 30 Tagen im Jahr, auf 10 km
  gerundet), Meilenstein (Gesamt-km, nächste runde Marke, Wochen beim Tempo der
  letzten 3 Monate). **Training und Gesundheit:** Schlaf vor den schnellsten Läufen
  (schnellstes Viertel ab 3 km gegen die übrigen) und Schlaf nach langen Läufen (ab
  15 km; sind es weniger als drei, das längste Viertel — die Schwelle steht dann im
  Text).
  **Jede Karte hat Mindestmengen** (etwa ≥ 3 Läufe je Vergleichszeitraum, ≥ 8 Läufe
  mit Schlafdaten) und fehlt, wenn sie nicht erreicht sind — kein erfundener Wert.
  **Farbe bedeutet Bewertung:** Rekorde und Gewohnheiten sind Tatsachen und heben die
  Kernzahl nur fett hervor (`c: 'inherit'`); farbig sind allein Pace-Trend und
  Effizienz (grün besser, orange schlechter) sowie die Schlafkarten (grün, wenn mehr
  Schlaf). Jahr gegen Vorjahr bleibt neutral — mehr Kilometer sind kein Ziel der App.
  **Nachgerechnet** (Prüfstand, `?tage=900`, aus den Rohzeilen): Rekordmonat Juni 2025
  190.8 km, längster Lauf 17.19 km am 19.10.2025, beste Pace ab 5 km 4.800 min/km über
  14.58 km, Gesamt 3'851.2 km aus 505 Einheiten, Mix 145/141/122/97 → 29/28/24/19 % —
  alle identisch mit den Karten. Am Desktop spannen die Einblicke über beide Spalten
  (`#screen-training > .tr-insights`), ihr eigenes Raster teilt sie wieder in zwei.
- **Kartenreihenfolge je Tab** (auf Wunsch festgelegt, nicht umsortieren):
  **Herz** Ruhepuls & HRV → (Weitere Auswertungen) Ruhepuls-Einordnung →
  HRV-Einordnung → Herz-Kreislauf-Einordnung. **Schlaf** Schlaf-Score-Kachel →
  Schlafdauer → (Weitere Auswertungen) Schlafqualität-Verteilung → Schlafschuld →
  Schlafphasen-Verlauf → Schlaf-Score-Verlauf.
  **Training** Laufstrecke → Trainingszeit → Pace → VO₂max (Stand 06.09.2026) →
  (Weitere Auswertungen) Trainings-Einblicke (seit 18.09.2026).
  Überall gilt: erst die Verläufe, dann die Einordnung — erst die Zahlen,
  dann deren Deutung. **Drei Karten sind aus dem Training-Tab entfernt** und stecken
  nur noch in der Git-Historie:
  - der **Trainingskalender** zuoberst (samt `_buildCalHTML`, `_calDate`, `#cal-tip`,
    `.cal-*`),
  - das **Vergleichsdiagramm** `c-kombi` (samt `KOMBI_REIHEN`, `_kombiAktiv`,
    `window._kombiZeichnen`/`_kombiFussHTML`, `.kombi-schalter`, `#kombi-fuss`,
    `.chart-note`),
  - der **Leistungs-Trend** `c-wo-trend`. Achtung: „Leistungs-Trend: Distanz & HR pro
    Training" und „Distanz & HR pro Monat" waren **dasselbe** Diagramm — nur der Titel
    wechselte mit dem Zeitraum. Wer nach zwei Karten sucht, sucht vergebens.
  Mit ihnen entfielen 30 Bezeichner; die Rechenkette dahinter (`wRows`, `trendHR`,
  `hrGesamt`/`hrWkdAvg`/`hrWkndAvg`, `paceGesamt`, `_1mHRData`/`_1mPaceData`) wurde
  Schritt für Schritt nachgezogen, bis kein Name mehr nur bei seiner eigenen
  Deklaration stand. **Puls und Pace-Durchschnitt werden im Training-Tab seither
  nirgends mehr berechnet** — wer sie zurückwill, holt sie aus `workoutData`.
- **Training-Tab-Daten:** ausschließlich `workoutData`; einzige Ausnahme ist die
  VO₂max-Sektion (zuunterst) aus `r.vo2max`. **Auch die Pace** kommt seit 05.09.2026 nur
  noch aus `Speed (km/h)` des Workout-Sheets — vorher zuerst aus `runSpeed` des
  Health-Sheets mit Rückgriff auf die Workout-Geschwindigkeit. Damit stammen Strecke
  UND Pace aus derselben Messung; `runSpeed` ist aus dem Health-Sheet entfallen.
- **Was die App liest, ist NICHT dasselbe wie das, was in den Blättern stehen muss.**
  Die beiden Sheets gehören unterschiedlich vielen Anwendungen, und danach richtet sich,
  ob eine Spalte entbehrlich ist:
  **Health Dashboard Data (12) — nur dieses Dashboard** (von Leonard am 06.09.2026
  ausdrücklich bestätigt; FitTrack nutzt allein `Workout Data`). `date`, `steps`, `restHR`,
  `hrv`, `sleepTotal`, `sleepCore`, `sleepRem`, `sleepDeep`, `sleepAwake`, `vo2max`,
  `sleepStart`, `sleepEnd`. Am 05.09.2026 von 32 auf diese gekürzt — hier war das
  richtig, weil niemand sonst mitliest. `sleepScore` liest die App zwar, das Apps
  Script schreibt es aber nicht — die Score-Kachel bleibt leer, bis die Spalte
  jemand befüllt.
  **Workout Data (11) — auch FitTrack liest diese Datei.** `Date`, `Type`,
  `Duration (min)`, `Distance (km)`, `Avg HR`, `Max HR`, `Speed (km/h)`,
  `Elevation (m)`, `Energy (kJ)`, `Cadence`, `Steps`. Dieses Dashboard wertet davon
  nur sechs aus (`Max HR`, `Elevation`, `Energy`, `Cadence`, `Steps` nicht) — **das
  ist kein Grund, sie zu entfernen.** Genau das geschah am 05.09.2026 und entzog
  FitTrack fünf Spalten; zurückgeholt am 06.09.2026 aus der Sicherung
  (`workoutZurueck()`). `Type` zeigt auch dieses Dashboard nirgends an, es bleibt
  trotzdem: es ist die einzige Angabe, die eine Einheit benennt.
  **Ein drittes Blatt `Meta`** liegt seit 12.09.2026 in der Health-Tabelle:
  Schlüssel/Wert, bisher eine Zeile `letzterExport` für die Anzeige „Daten bis"
  (siehe dort). Es gehört NICHT zu `COLUMNS` und wird vom Import nicht
  positionsbasiert beschrieben. Damit es nicht mit dem Datenblatt verwechselt wird,
  sucht `getOrCreateSheet()` das Datenblatt jetzt über **`ss.getSheets()[0]`** statt
  über `getActiveSheet()`: Letzteres ist UI-Zustand und wandert, sobald ein Skript ein
  Blatt einfügt — der Import schriebe dann ins falsche Blatt. `metaSchreiben()` legt
  `Meta` deshalb zusätzlich **hinten** an und stellt die vorherige Auswahl wieder her.
  **Beide Importe schreiben POSITIONSBASIERT** ab Spalte A und die Kopfzeile nur, wenn
  das Blatt leer ist. Wer `COLUMNS` oder `WORKOUT_SPALTEN` ändert, MUSS die bestehenden
  Zeilen mitziehen — sonst stehen alte Werte unter neuen Überschriften und die App liest
  sie falsch. Dafür gibt es `migriereSpalten()` in `Maintenance.gs` (legt zuerst eine
  Sicherung an, ordnet nach Spaltennamen um, liest zur Kontrolle zurück; mehrfach
  ausführbar). Beide `getOrCreateSheet`-Wege prüfen die Kopfzeile jetzt und **brechen
  mit einer Meldung ab**, statt still zu verschieben.

- **App-Version:** `versionAnzeigen()` liest die laufende Version aus den Namen der
  Caches (`hcc-vNN`) — `sw.js` löscht beim Aktivieren alle fremden, es bleibt genau
  einer übrig. Sortierung **numerisch**, sonst stünde `v9` über `v126`.
  `jetztAktualisieren()` meldet den Service Worker ab, leert die Caches und lädt neu.
  Der Google-Token liegt im `localStorage` und bleibt unberührt — kein neuer Login.

## Gotchas
- **Cache-Bump nicht vergessen** — häufigste Fehlerquelle.
- **NIE ein Geheimnis in `app.js`, `index.html`, `style.css` oder `sw.js`.** GitHub Pages
  liefert diese Dateien an jeden aus — ein Schlüssel darin ist veröffentlicht, egal wie
  er heisst. Genau daran hing der Apps-Script-`SECRET`, mit dem Fremde die damaligen
  Laufplan-Einträge ändern konnten. Braucht etwas eine Absicherung, führt sie über die
  Google-Anmeldung oder über eine Prüfung des Google-Zugangs im Apps Script
  (`zugangGueltig`). Das Repo privat zu machen hilft NICHT: `app.js` bleibt öffentlich.
- **`_apps-script/` ist Referenz, kein Deploy.** Änderungen dort wirken erst, wenn der
  Code im Apps-Script-Projekt eingefügt UND als **neue Version bereitgestellt** wird.
- **Ein Blatt gehört nicht automatisch dieser App.** `Workout Data` liest auch
  **FitTrack**. „Das Dashboard wertet die Spalte nicht aus" ist deshalb kein Befund
  über die Spalte, sondern nur über einen von zwei Lesern — und rechtfertigt kein
  Löschen. Vor jeder Kürzung an einem Blatt zuerst klären, wer sonst noch mitliest;
  im Zweifel fragen statt entfernen. Ungenutzte Spalten kosten etwas Ladezeit, ein
  Datenverlust bei einer anderen App kostet mehr. `_spaltenUmbau` **bricht jetzt ab**,
  wenn eine gewünschte Spalte in der aktuellen Kopfzeile fehlt und damit leer
  entstünde — vorher legte es sie stillschweigend leer an und meldete es erst
  hinterher.
- **Die App liest die ANGEZEIGTE Zeichenkette, nicht den gespeicherten Wert.** Der
  Abruf in `_fetchSheet` setzt kein `valueRenderOption`; der Standard der Sheets-API
  ist `FORMATTED_VALUE`. Was im Blatt steht, ist damit erst die halbe Wahrheit — es
  zählt, was das Blatt **anzeigt**. Aufgefallen ist das an `sleepStart`/`sleepEnd`:
  Sheets speichert eine reine Uhrzeit als Datum 30.12.1899 mit Tageszeit, und ohne
  Zahlenformat zeigt es davon nur `12/30/1899`. Der Wert war unversehrt, die App
  bekam trotzdem nur das Platzhalterdatum, und `parseTV` lieferte `null` — die
  Tooltip-Zeilen „Eingeschlafen"/„Aufgewacht" im Schlafdauer-Diagramm blieben leer.
  Ausgelöst hatte es `migriereSpalten()`: `clear()` löscht neben dem Inhalt auch die
  **Formate**. Seither setzt `_spaltenUmbau` das Zeitformat wieder (`ZEIT_SPALTEN`,
  `_zeitformatAnwenden`) und weist es im Protokoll mit `getDisplayValues()` nach —
  derselben Zeichenkette, die auch die API liefert. Für ein bereits umgestelltes
  Blatt gibt es `zeitformatSetzen()`. **Merke:** Wer am Sheet formatiert, ändert
  Daten. Eine Prüfung mit `getValues()` allein beweist hier nichts.
- **`hidden` allein blendet NICHTS aus, sobald eigenes CSS `display` setzt.** Das
  Attribut wirkt nur über das Browser-Stylesheet, und jede Klassenregel mit `display`
  schlägt es. Zu jedem `hidden`-Element gehört deshalb eine eigene Regel — im Code
  viermal: `#hinweis-oben[hidden]`, `.weitere-inhalt[hidden]`, `.zl-optionen[hidden]`,
  `.unterseite[hidden]`.
  Bei der letzten fehlte sie: die Auswahl der Zeitleiste stand dauerhaft offen und
  liess sich nicht zuklappen, obwohl das Attribut korrekt gesetzt wurde.
  Seit 18.09.2026 setzen `.zl-optionen` und `#hinweis-oben` ihr `hidden` beim
  Schliessen erst **nach** der Ausblend-Animation — direkt nach dem Tipp steht dort
  also noch `hidden = false`, und das ist richtig so.
  **Die eigentliche Lehre betrifft das Prüfen:** Ich hatte `el.hidden` abgefragt — die
  Eigenschaft war richtig, nur eben wirkungslos. Ob etwas verschwindet, beweist allein
  das Ergebnis: `getComputedStyle(el).display`, die gemessene Höhe oder ein Bild im
  geschlossenen Zustand. Ein Zustandsflag zu prüfen heisst, den eigenen Code zu
  befragen statt den Browser.
- **Zwei verschiedene „Caches" nicht verwechseln.** `sw.js`-`CACHE` (`hcc-vNN`) hält die
  **Programmdateien**; `hcc_daten_v3` im `localStorage` hält die **Messdaten**. Der
  Knopf „App-Version aktualisieren" leert nur den ersten. Wer beim Prüfen den falschen
  leert, sucht lange.
- **NIE `toISOString()` für Datums-Strings.** Es rechnet nach UTC um; in der Schweiz
  (UTC+1/+2) kommt dabei der Vortag heraus. Immer `toLocalDateStr(dt)` bzw. `addDays(ds,n)`
  nutzen. Dieser Fehler steckte einmal an sechs Stellen und verfälschte Muster-Insights
  und Kalenderansichten.
- **Kein erfundener Platzhalter für fehlende Messwerte.** Fehlt ein Wert, zeigt die App
  „—" statt eines geschätzten Ersatzwerts. Gilt überall.
- **Testen nur nach SW-Abmeldung.** Ein früher registrierter Service Worker liefert sonst
  die alte `app.js` aus — auch auf `localhost`.
- **`text-size-adjust: 100%` auf `<html>` — nicht entfernen.** Ohne die Angabe gilt auf
  iOS `auto`, und WebKit vergrössert Text dann eigenmächtig, **blockweise** nach Breite
  und Textmenge des Kastens. Zwei Zeilen mit identischer CSS-Grösse erscheinen dadurch
  auf dem iPhone unterschiedlich gross, während jeder Desktop-Browser (und der
  Prüfstand) sie gleich zeigt — im Tagesdetail des Laufkalenders wurden die
  Block-Kästen aufgeblasen, die Flex-Zeile daneben nicht. Wirkt sich auf die **ganze**
  App aus: Erscheint danach etwas zu klein, gehört der Wert im CSS erhöht, nicht die
  Heuristik zurückgeholt.
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
