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
  dem Start → Hinweisleiste statt stillem Neuzeichnen). Messpunkte:
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
- **Sofortstart aus dem Zwischenspeicher (Vorbild FitTrack):** Die App wartete früher
  auf ~10 Sheets-Anfragen in vier Wellen, bevor irgendetwas erschien; nach Ablauf des
  Tokens (~1 h) sah man statt Daten nur den Login. Jetzt:
  1. `datenCacheLesen()` füllt `allData` und `workoutData` aus `hcc_daten_v1` —
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
  Versionsnummer (`hcc_daten_v1`): ändert sich, WIE eingelesen wird, hochzählen, dann
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
  `.refresh-btn`/`.dark-toggle`/`.zl-pille`/`.zl-opt`/`.einst-act`/`.us-zurueck`
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
- **Bedienelemente:** 🌙 Dark-Toggle liegt rechtsbündig auf der `pg-banner`-Titelzeile
  (`pgBanner()`). Das
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
     blättern. Ob ein Schritt möglich ist, sagt allein `updateNavUI()` über `disabled`.
  6. **„Heute" ist ein Sprung, kein Bereich** (`.zl-heute`, ohne `data-range`). Ein
     Tipp ruft `aufHeuteSpringen()` und lässt `timeRange` **unangetastet**: steht man
     auf 3M im März, bleibt es 3M und zeigt die neuesten drei Monate. Damit ist
     `referenceDate` wieder am neuesten Tag und `_datumSelbstGewaehlt` false, das
     Nachladen darf also wieder mitziehen. Es trägt nie `aktiv` — es hat keinen
     Zustand. Optisch deshalb **Umrandung statt Füllung** und durch `.zl-trenner`
     abgesetzt: als siebter Chip in Chip-Optik erwartete man eine Tagesansicht, und
     genau die gibt es nicht mehr. Der Weg dorthin: erst `.nav-today` in jeder
     Diagrammkarte, dann kurz ein Bereich `heute`, seit 06.09.2026 dieser Knopf.
  7. **Passiver Modus** (`#zeitleiste.passiv`, 06.09.2026): Die Reihe schrumpft auf
     **70 %** und geht auf **50 % Deckkraft**, sobald man scrollt (in **beide** Richtungen, Schwelle 2 px gegen iOS'
     Nachfedern) oder irgendwo neben die Leiste tippt. Ein Tipp auf Pille oder Pfeil
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
  **Die Auswahl passt nur knapp in eine Zeile — jede Änderung dort nachmessen.**
  Stand: „Heute" + Trenner + sechs Chips brauchen **332 von 332 px** bei 375 px
  Fenster, also exakt. Dafür sind `gap: 3px`, `.zl-opt{padding:0 .55rem}`,
  `.zl-heute{padding:0 .5rem}` und `.zl-trenner{margin:0 1px}` nötig. Mit den
  Ausgangswerten (`gap:4px`, `.6rem`, `2px`) waren es 340.2 px und die Leiste brach
  auf zwei Zeilen um — sie wird dann 86 statt 48 px hoch und drängt sich vor die
  Diagramme. Schmalere Geräte brechen weiterhin um; das ist hingenommen.
  `--zeit-h` (44 px) steht auch im `padding-bottom` von `.screen` — sonst verschwindet
  die unterste Karte unter der Leiste.
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
  **Drei Fallen, die dort stecken:**
  1. `.unterseite[hidden]{display:none}` ist Pflicht — siehe den `hidden`-Gotcha.
  2. Im 600-px-Kasten (`min-width:768px and min-height:600px`) wird die Seite über
     **`margin-left:-300px`** zentriert, nicht über `translateX(-50%)`: das `transform`
     gehört der Ein-/Ausblend-Animation und läge sonst um die halbe Breite daneben.
  3. Der **Render-Prüfstand hat eine eigene Kopie der Shell**. `#seite-einstellungen`
     musste dort mit aufgenommen werden, sonst findet `pgEinstellungen()` nichts und
     tut still gar nichts — die Seite wäre lokal nicht prüfbar, ohne dass es auffiele.
  **Folge:** Daten-Stand, Anmeldestatus und beide Update-Knöpfe stehen nur noch hier.
- **Zeitachse:** bei Tagesauflösung (7T/1M) zweizeilige Labels via `tagLabel()` —
  Wochentag über dem Datum. Monats-/Wochenbereiche unverändert.
- **Bottom-Nav-Ausblenden:** Runterscrollen blendet die Leiste aus
  (`initScrollHideNav`). Scrollen blendet sie **nie wieder ein** — auch nicht beim
  Zurückscrollen und nicht am Seitenanfang. Zurück kommt sie nur über einen Tipp auf
  den freien Kartenhintergrund. Die letzte Scrollposition wird **pro Tab** gemerkt:
  eine gemeinsame Variable täuschte beim Tabwechsel einen Sprung vor (Tab A bei 800,
  Tab B bei 0) und blendete bei der ersten Bewegung im neuen Tab aus. Solange nur das
  Zurückscrollen wieder einblendete, fiel das nicht auf.
  Die **Zeitleiste** verschwindet dabei nie — sie rückt nur nach unten nach. Beide
  Zustände hängen an `navAusblenden()`.
- **Wochenschnitt bei Monatsbalken** (Laufstrecke und Trainingszeit, 07.09.2026):
  Sobald die Diagramme Monate zeigen (`tKeyTyp === 'monat'`), erscheint direkt nach
  `Total` eine Zeile „Durchschn. Strecke/Zeit pro Woche", und der Tooltip jedes
  Monatsbalkens bekommt eine zweite Zeile mit demselben Wert **für diesen Monat**.
  Grund: Monatssummen lassen sich untereinander schlecht vergleichen — ein Februar
  hat 28, ein Juli 31 Tage.
  **`wochenZwischen()` und `wochenImMonat()` rechnen mit Kommastellen**, nicht mit
  „vier Wochen": 28 Tage sind 4.00 Wochen, 31 Tage 4.43. Rund gerechnet läge der
  Wochenschnitt je nach Monat um bis zu 10 % daneben — und genau der Vergleich
  zwischen Monaten ist der Zweck der Zahl.
- **Gestrichelte Ø-Linien im Training-Tab** (auf Wunsch, 07.09.2026) in allen vier
  Diagrammen, **abschaltbar über einen Legendeneintrag** (`oeLegende()`,
  `.oe-schalter`, Optik vom entfernten Vergleichsdiagramm übernommen).
  **Das kehrt die ältere Regel „Ø gehört in die Fusszeile, nicht ins Diagramm" für
  diesen Tab um** — für Herz und Schlaf gilt sie weiter.
  Drei Dinge hängen daran:
  1. Der Zustand `_oeLinie` liegt **ausserhalb** von `pgTraining`, sonst wäre er nach
     jedem Neuaufbau zurückgesetzt (derselbe Grund wie beim früheren `_kombiAktiv`).
     Fehlender Eintrag heisst „an".
  2. Das Label der Linie ist **`Ø`** — damit hält `nurMesswerte` sowohl den Tooltip
     als auch die Datenbeschriftungen von ihr fern. Eine Umbenennung bricht beides.
  3. `oeDatensatz()` liefert ein **Array** (leer, wenn abgeschaltet), damit der
     Aufrufer es mit `...` einsetzen kann und kein `null` im Datensatz-Array landet.
  Umgeschaltet wird über `_renderTab('training')`: die Linie ist ein Datensatz, kein
  Sichtbarkeitsschalter.
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
  `--txt3` zurücktritt. Trägt ein Ziel eine Einheit, die im Messwert schon steht,
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
  Datenpunkten. **Sichtbar im Querformat immer, im Hochformat nur bei 7T** (seit
  07.09.2026) — dort stehen höchstens sieben Säulen nebeneinander, ab 1M wären es
  über dreissig. **Alle neun Diagramme der App** melden inzwischen ein
  `cfg.__werteFmt` an: `c-woche`, `c-herz`, `c-sl-dur`, `c-sl-phases`, `c-sl-score`
  und die vier des Training-Tabs. Der Formatierer bekommt `(wert, datensatz)` — nötig
  für `c-woche`, wo vier Reihen vier verschiedene Einheiten tragen.
  **Das Format kommt aus denselben Helfern wie der Rest der App** — `fmtPace()` für
  die Pace, `zahl()` für VO₂max, `Math.round`+`km` für die Laufstrecke (auf Wunsch
  ganze Kilometer und **ohne Leerzeichen**: `120km`; über dem Balken zählt der
  schnelle Blick, die Nachkommastelle steht im Tooltip und in der Fusszeile).
  **Die Trainingszeit weicht bei 24M ab**: dort ganze Stunden (`10h`) statt
  `10h 12m` — bei 24 Monatsbalken ist die Minute weder lesbar noch aussagekräftig.
  Die Schlafdauer behält dort ihren Umbruch.
  **`stdMinLabel()` bedient Schlafdauer und Trainingszeit** (`7h 25m`) und ist die
  einzige Stelle, die zwei Sonderfälle kennt:
  - **Bei 24M bricht der Text um** (`7h` über `25m`). Dort stehen 24 Balken
    nebeneinander; einzeilig wäre der Text breiter als die Spalte, umgebrochen halb
    so breit. Der Umbruch geschieht über ein `\n` im Rückgabewert — **das Plugin
    kennt die Zeiträume nicht**, jedes Diagramm entscheidet selbst, wann sein Text
    zu breit wird.
  - **Ein führendes `0h ` fällt weg**: bei 38 Minuten Training sagt `0h 38m` nichts,
    was `38m` nicht auch sagt. Beim Schlaf tritt der Fall praktisch nie ein.
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
  **Überlappungen löst das Plugin selbst:** es merkt sich die belegten **Rechtecke**
  (x *und* y, `measureText` für die Breite) und lässt weg, was in ein bereits
  gesetztes hineinragen würde. Nur die x-Achse zu prüfen reichte nicht: in
  „Ruhepuls & HRV" laufen zwei Reihen im selben Diagramm und kreuzen sich — dort
  stiessen die Zahlen aufeinander, obwohl in jeder Reihe für sich Platz war.
  Deshalb braucht es keine Sonderregel je Zeitraum: bei 7T steht über jedem Balken
  eine Zahl, bei 24M im Pace-Diagramm über 16 von 48 Punkten, in „Ruhepuls & HRV"
  über 13 von 14.
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
  Datenfläche (auf `chartArea` geclippt) — Achsen bleiben fix.
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
  Die vier Minikacheln stehen darin **zweizeilig**. Reihenfolge
  überall gleich, weil sie aus dem Markup kommt: **Ruhepuls, HRV, Schlaf, Training** —
  im Querformat also oben Herz-Werte, unten Schlaf und Training. Die Warnkarte steht
  **über** dem Paar; zwischen zwei nebeneinanderliegenden Karten wäre kein Platz.
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
- **Aufklapp-Schalter sitzt in der Kopfzeile.** „Weitere Auswertungen" (Herz, Schlaf)
  und „Muster & Zusammenhänge" (Übersicht) haben keinen breiten Balken im Inhalt mehr,
  sondern einen `.pg-act.ausklapp-act` links vom Dark-Toggle (`▾` zu / `▴` offen).
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
  ihn: „Weitere Auswertungen" (Herz, Schlaf) und „Muster & Zusammenhänge" — **alle
  drei starten zu** (`_weitereOffen`, `_musterOffen`; letzteres seit 06.09.2026 auf
  Wunsch, vorher offen). Die
  frühere dritte Stelle, die App-Karte der Übersicht (`_appOffen`), ist mit dem Umzug
  auf die Einstellungen-Seite entfallen.
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
- **Kartenreihenfolge je Tab** (auf Wunsch festgelegt, nicht umsortieren):
  **Herz** Ruhepuls & HRV → (Weitere Auswertungen) Ruhepuls-Einordnung →
  HRV-Einordnung → Herz-Kreislauf-Einordnung. **Schlaf** Schlaf-Score-Kachel →
  Schlafdauer → (Weitere Auswertungen) Schlafqualität-Verteilung → Schlafschuld →
  Schlafphasen-Verlauf → Schlaf-Score-Verlauf.
  **Training** Laufstrecke → Trainingszeit → Pace → VO₂max (Stand 06.09.2026).
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
  **Die eigentliche Lehre betrifft das Prüfen:** Ich hatte `el.hidden` abgefragt — die
  Eigenschaft war richtig, nur eben wirkungslos. Ob etwas verschwindet, beweist allein
  das Ergebnis: `getComputedStyle(el).display`, die gemessene Höhe oder ein Bild im
  geschlossenen Zustand. Ein Zustandsflag zu prüfen heisst, den eigenen Code zu
  befragen statt den Browser.
- **Zwei verschiedene „Caches" nicht verwechseln.** `sw.js`-`CACHE` (`hcc-vNN`) hält die
  **Programmdateien**; `hcc_daten_v1` im `localStorage` hält die **Messdaten**. Der
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
