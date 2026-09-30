// ── GitHub Pages – OAuth2 + Sheets API (wie Tesla Dashboard) ──
const CLIENT_ID        = '185114707171-tto1teeec25d9sgkeobme666ndpdip7k.apps.googleusercontent.com';
const REDIRECT_URI     = 'https://lebrongoku-prog.github.io/health-dashboard/';
const HEALTH_SHEET_ID  = '1eZ47hJUc7yX_o-eH0p9JL3Wi34wWMQ8gSEI1a46VRKM';
const WORKOUT_SHEET_ID = '1YJ3ke8Z2jS1KdJlKOnukUStMgvqqppnktAb8UVHDdgk';
// Zusatzangaben zum Import, als Schluessel/Wert-Paare in einem eigenen Blatt der
// Health-Tabelle. Bisher steht dort eine Zeile: `letzterExport` – wann Health Auto
// Export die neueste uebernommene Datei geschrieben hat. Das Apps Script legt das
// Blatt beim Import selbst an; fehlt es (Skript noch nicht eingespielt), faellt die
// App auf das blosse Tagesdatum zurueck.
const META_BLATT = 'Meta';
// Auslöser fuer den Import Drive → Sheet. Nur DAS kann die App nicht selbst: an die
// Health-Auto-Export-Dateien in Drive kommt allein das Apps Script.
// Ohne Passwort im Aufruf – das stand hier frueher und war damit oeffentlich. Statt-
// dessen schickt die App ihren Google-Zugang mit, und das Skript prueft ihn, indem es
// damit die (private) Tabelle anfragt: wer sie lesen darf, darf auch den Import
// ausloesen. Der Zugang steht im POST-Rumpf, nicht in der Adresse – Adressen landen
// in Server-Protokollen, Rumpfdaten nicht.
const REFRESH_URL      = 'https://script.google.com/macros/s/AKfycbyN4HSh5ai3ZBpCkGjuxHVlE0IagpLtUT-gyLgzRfAXZT4wPahzRJUbZTMvUiaT0djA/exec';

let accessToken = null, tokenExpiry = 0;
// **Nur Lesen.** Die App schreibt nirgends mehr ins Sheet – mit dem Laufplan ist der
// einzige Schreibweg entfallen. Der weitergehende Scope `…/spreadsheets` waere jetzt
// ein Recht ohne Zweck, und ein Zugang, der nicht schreiben KANN, kann auch durch
// einen Fehler nichts zerstoeren. Ein bereits erteilter Schreib-Token liest weiterhin
// anstandslos, es braucht also keine neue Anmeldung; erst die naechste fordert
// wieder das kleinere Recht an.
const SCOPE_LESEN = 'https://www.googleapis.com/auth/spreadsheets.readonly';

function signIn() {
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth'
    + '?client_id='    + encodeURIComponent(CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI)
    + '&response_type=token'
    + '&scope='        + encodeURIComponent(SCOPE_LESEN)
    + '&prompt=select_account';
}
function _checkHashToken() {
  const hash = window.location.hash;
  if (!hash || !hash.includes('access_token')) return false;
  const p = new URLSearchParams(hash.substring(1));
  const t = p.get('access_token');
  if (!t) return false;
  const exp = parseInt(p.get('expires_in') || '3600');
  accessToken = t; tokenExpiry = Date.now() + (exp - 60) * 1000;
  // localStorage statt sessionStorage: Token überlebt PWA-Schließen/Restart.
  // Nach ~1h Ablauf wird er bei der nächsten Anfrage wegen 401 automatisch verworfen.
  try { localStorage.setItem('g_token', accessToken); localStorage.setItem('g_expiry', String(tokenExpiry)); } catch(_) {}
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}
// Abgelaufenen oder abgewiesenen Token vergessen – im Speicher und im localStorage.
function tokenVerwerfen() {
  accessToken = null; tokenExpiry = 0;
  try { localStorage.removeItem('g_token'); localStorage.removeItem('g_expiry'); } catch(_) {}
}
function _initAuth() {
  if (_checkHashToken()) return true;
  try {
    const t = localStorage.getItem('g_token');
    const exp = parseInt(localStorage.getItem('g_expiry') || '0');
    if (t && Date.now() < exp) {
      accessToken = t; tokenExpiry = exp;
      return true;
    }
  } catch(_) {}
  return false;
}

(async () => {
let allData = [], timeRange = '7d', referenceDate = '';
// Hat der Nutzer den Zeitraum selbst weggeblättert? Dann darf ein Nachladen im
// Hintergrund ihn nicht heimlich zurück auf den neuesten Tag setzen.
let _datumSelbstGewaehlt = false;
// Erste echte Berührung seit dem Start. Solange sie ausbleibt, darf frisch geladenes
// Material still eingezeichnet werden; danach nur noch auf Tipp, sonst springt die
// Ansicht unter dem Finger weg. Bewusst nur Zeigegeräte/Tastatur – ein `scroll`
// feuert auch, wenn die App selbst scrollt (Tab-Snap beim Start).
let _beruehrt = false;
let _lastLoadTs = null; // Zeitpunkt des letzten erfolgreichen Sheet-Abrufs (für den Daten-Stand)
// Zeitstempel der neuesten Health-Datei, die ins Sheet uebertragen wurde (aus dem
// Blatt `Meta`). Beantwortet die Frage, die das blosse Tagesdatum offen laesst: wie
// frisch sind die Werte des letzten Tages? Format {datum:'YYYY-MM-DD', zeit:'HH:MM'}.
let _exportStempel = null;
const charts = {};
// Cache für allData-abhängige Auswertungen (Baselines, Tages-Empfehlung,
// Warnsignale, Muster-Insights). Wird in loadFromAPI geleert, sobald sich
// allData ändert. So entfällt das Neuberechnen bei jedem Tab-Render/Filterwechsel.
let _analyticsCache = {};
function _memo(key, berechnen) {
  if (!(key in _analyticsCache)) _analyticsCache[key] = berechnen();
  return _analyticsCache[key];
}
let workoutData  = {};      // date → parsed workout row (cached after load)
let workoutSheetReady = false; // true sobald der Ladeversuch abgeschlossen ist – auch bei Fehlschlag
let workoutLoadError  = null;  // Fehlertext, falls der Abruf scheiterte (sonst null)

// Wartet begrenzt darauf, dass der Workout-Ladeversuch abgeschlossen ist.
// Ohne Zeitlimit blieb der Training-Tab bei einem fehlgeschlagenen Sheet-Abruf
// dauerhaft im Ladezustand – samt eines Intervalls, das nie aufgeräumt wurde und
// sich bei jedem Filterwechsel vervielfachte.
function _awaitWorkoutSheet(timeoutMs = 10000) {
  if (workoutSheetReady) return Promise.resolve(true);
  return new Promise(resolve => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (workoutSheetReady)                    { clearInterval(iv); resolve(true);  }
      else if (Date.now() - started >= timeoutMs) { clearInterval(iv); resolve(false); }
    }, 200);
  });
}

// Gueltiges Tagesdatum im Format JJJJ-MM-TT. Dieselbe Pruefung fuer Health-Sheet,
// Workout-Sheet und Zwischenspeicher – alle drei sind Daten von aussen.
function istDatum(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

// ── Workout-Daten aus API-Response parsen ──────────────
function _parseWorkoutRows(rows) {
  // Sheet-Werte kommen als Strings – hier ausdruecklich in Zahlen wandeln.
  const alsZahl = v => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(v); return isNaN(n) ? null : n; };

  // MEHRERE Einheiten am selben Tag werden ZUSAMMENGEFASST, nicht ueberschrieben.
  // Vorher stand hier schlicht `workoutData[date] = {…}` – bei zwei Eintraegen am
  // selben Tag (etwa Lauf am Morgen, Intervalltraining am Abend) gewann der zuletzt
  // gelesene und der andere verschwand spurlos aus jedem Diagramm. Gemessen an
  // Testdaten: 93.2 min im Sheet, 32.9 min in der Anzeige.
  const proTag = {};
  rows.forEach(r => {
    const date = r['Date'] || r['date'];
    if (!date || !istDatum(String(date))) return;
    (proTag[date] = proTag[date] || []).push({
      typeRaw:  String(r['Type'] || r['type'] || '').trim(),
      dauer:    alsZahl(r['Duration (min)']),
      strecke:  alsZahl(r['Distance (km)']),
      puls:     alsZahl(r['Avg HR']),
      speed:    alsZahl(r['Speed (km/h)'])
    });
  });

  // Gewichteter Mittelwert nach Trainingsdauer: eine Stunde Lauf und zwanzig Minuten
  // Intervall duerfen nicht gleich schwer wiegen. Beruecksichtigt nur Einheiten, die
  // den Wert ueberhaupt melden.
  const gewichtet = (liste, feld) => {
    const mit = liste.filter(e => e[feld] != null && e.dauer > 0);
    if (!mit.length) {
      const ohneDauer = liste.filter(e => e[feld] != null);
      if (!ohneDauer.length) return null;
      return ohneDauer.reduce((a, e) => a + e[feld], 0) / ohneDauer.length;
    }
    const gesamt = mit.reduce((a, e) => a + e.dauer, 0);
    return mit.reduce((a, e) => a + e[feld] * e.dauer, 0) / gesamt;
  };
  const summe = (liste, feld) => {
    const mit = liste.filter(e => e[feld] != null);
    return mit.length ? mit.reduce((a, e) => a + e[feld], 0) : null;
  };

  Object.keys(proTag).forEach(date => {
    const e = proTag[date];
    // Die Geschwindigkeit wird NUR ueber Einheiten gemittelt, die eine melden. Ein
    // Intervalltraining ohne Strecke traegt keine – wuerde es als 0 einfliessen oder
    // seine Dauer in eine Rechnung Strecke/Zeit eingehen, saehe die Pace des Tages
    // deutlich langsamer aus, als tatsaechlich gelaufen wurde.
    const arten = [...new Set(e.map(x => x.typeRaw).filter(Boolean))];
    workoutData[date] = {
      date,
      // typeRaw bleibt roh; typeLabel ist die Anzeigefassung und bereits entschaerft.
      typeRaw:  arten.join(' · '),
      typeLabel: esc(arten.join(' · ') || 'Workout'),
      anzahl:      e.length,
      // Einheiten MIT Strecke – die Grundlage fuer „Ø pro Lauf" in der Laufstrecke.
      // `anzahl` taugt dafuer nicht: ein Intervalltraining am selben Tag zaehlt dort
      // mit, hat aber keine Strecke und haette den Schnitt je Lauf gedrueckt.
      laeufe:      e.filter(x => x.strecke != null && x.strecke > 0).length,
      durationMin: summe(e, 'dauer'),
      distanceKm:  summe(e, 'strecke'),
      avgHR:       gewichtet(e, 'puls'),
      avgSpeedKph: gewichtet(e, 'speed'),
      // Die Einheiten zusaetzlich EINZELN (18.09.2026) – fuer die Rekorde der
      // Trainings-Einblicke („laengster Lauf", „schnellster Lauf"). Zusammengefasst
      // zaehlten zwei Laeufe am selben Tag als ein einziger langer. `typ` ist roh und
      // geht bei der Anzeige durch esc() (artLabel).
      einheiten: e.map(x => ({ typ: x.typeRaw, dauer: x.dauer, strecke: x.strecke, puls: x.puls, speed: x.speed }))
    };
  });
  // Die Einblicke haengen an workoutData, der Analytics-Cache wird aber nur beim
  // Einlesen der Gesundheitsdaten geleert – hier eigens verwerfen. Herz und Schlaf
  // gehoeren dazu: ihre Zusammenhaenge lesen die Laeufe bzw. Trainingstage.
  delete _analyticsCache.trainingsInsights;
  delete _analyticsCache.herzInsights;
  delete _analyticsCache.schlafInsights;
  // workoutSheetReady wird vom Aufrufer gesetzt (auch im Fehlerfall) – siehe loadFromAPI.
}

// Gitterlinien und Achsen laufen bewusst über zwei verschiedene Farben. Vorher trugen
// beide dieselbe: die waagrechten Hilfslinien waren dadurch von der Achse, die den
// Datenbereich begrenzt, nicht zu unterscheiden. Das Gitter ist Orientierung im
// Hintergrund und tritt deutlich zurück, die Achse bleibt die kräftigere Kante.
const GRID_COLOR   = 'rgba(148,163,184,0.10)';
const ACHSEN_COLOR = 'rgba(148,163,184,0.38)';
// Rundung der oberen Balkenkante – EINE Quelle fuer alle Diagramme. Vorher standen
// dort 5, 4, 3 und (im 1M-Fenster) 2 nebeneinander, wodurch dieselbe Kante je nach
// Diagramm unterschiedlich stark gerundet aussah. Bewusst klein: kraeftig gerundete
// Kappen lassen kurze Balken abgeschnitten wirken.
const BALKEN_RADIUS = 3;

Chart.defaults.color = '#94A3B8';
Chart.defaults.borderColor = ACHSEN_COLOR;
Chart.defaults.font.family = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif";
Chart.defaults.font.size = 11;

// Schlankere Balken in ALLEN Diagrammen (Chart.js-Standard: 0.9 / 0.8).
// barPercentage      = Breite des Balkens innerhalb seines Slots
// categoryPercentage = Breite des Slots innerhalb des Kategorie-Abstands
// maxBarThickness    = Deckel, damit Balken bei wenigen Werten (z. B. Filter "Heute")
//                      nicht zu klobigen Blöcken aufgehen.
Chart.defaults.datasets.bar.barPercentage      = 0.62;
Chart.defaults.datasets.bar.categoryPercentage = 0.74;
Chart.defaults.datasets.bar.maxBarThickness    = 26;

// Tooltip-Animation aus. Zwei Gründe: die Markierung blendet den Tooltip in ALLEN
// Diagrammen gleichzeitig ein – ein Einfaden je Diagramm bringt dort nichts und
// verzögert nur. Und ohne Animator berechnet Chart.js Position und Grösse sofort;
// mit Animator entstehen sie erst über mehrere Frames, was ein programmgesteuertes
// Einblenden unzuverlässig macht.
Chart.defaults.plugins.tooltip.animation = false;
// Aufbau-Animation (Balken und Linien wachsen von der Grundlinie) 450 statt 1000 ms
// (auf Wunsch, 18.09.2026) – eine Sekunde wirkte bei jedem Bereichswechsel traege.
// Wo sich die Daten NICHT aendern, waechst gar nichts neu: siehe `_ruhigRendern`.
Chart.defaults.animation.duration = 450;
// Chart.js soll selbst auf KEIN Ereignis reagieren. Das Tooltip haengt damit
// ausschliesslich an der Markierung: Tipp auf eine Saeule blendet es ein, erneuter
// Tipp auf dieselbe blendet es aus. Vorher aktivierte Chart.js sein Tooltip beim
// Beruehren zusaetzlich selbst und blendete es nach dem Abschalten sofort wieder
// ein – auf dem iPhone folgt einem Fingertipp ein Maus-Ereignis an derselben
// Stelle, und ein "mouseout" gibt es dort nie. Der Tipp selbst laeuft ueber einen
// eigenen click-Listener am Canvas (zeichneDiagramm) und ist davon unberuehrt.
Chart.defaults.events = [];

// Wisch-Plugin für den Datums-Navigator: verschiebt beim Navigieren NUR die
// Datenfläche (auf chartArea geclippt), sodass X- und Y-Achse/Gitter fix bleiben.
// Aktiv ausschließlich, solange chart.$navslide gesetzt ist – sonst null Overhead.
Chart.register({
  id: 'navslide',
  beforeDatasetsDraw(chart){
    const s = chart.$navslide; if(!s) return;
    const a = chart.chartArea; if(!a) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(a.left, a.top, a.right - a.left, a.bottom - a.top);
    ctx.clip();
    ctx.translate(s.offset, 0);
    ctx.globalAlpha = s.alpha;
    chart.$navslideOn = true;
  },
  afterDatasetsDraw(chart){
    if(chart.$navslideOn){ chart.ctx.restore(); chart.$navslideOn = false; }
  }
});

function fehlerZeigen(meldung) {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('err-screen').style.display = 'flex';
  document.getElementById('err-txt').textContent = meldung;
}
function anmeldungZeigen() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
}

// GET gegen die Sheets-API mit dem aktuellen Token. 401 ist kein Fehler, sondern
// „Anmeldung noetig" – der Aufrufer entscheidet, was dann geschieht.
// `fehlertext(res)` baut die Meldung fuer alle anderen Fehlerstatus.
async function _sheetsAbruf(pfad, fehlertext) {
  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + pfad,
    { headers: { 'Authorization': 'Bearer ' + accessToken } });
  if (res.status === 401) return { authError: true };
  if (!res.ok) throw new Error(await fehlertext(res));
  return { json: await res.json() };
}

// ── Blattnamen-Zwischenspeicher ───────────────────────
// Vor jedem Wertabruf fragte die App das Spreadsheet, wie seine Blätter heissen –
// zusätzliche Anfragen pro Start für eine Angabe, die sich praktisch nie ändert.
// Die Namensliste liegt jetzt lokal; nur wenn ein gesuchtes Blatt fehlt, wird sie
// neu geholt.
const TABS_KEY = 'hcc_blattnamen_v1';
let _tabsCache = (() => { try { return JSON.parse(localStorage.getItem(TABS_KEY)) || {}; } catch(_) { return {}; } })();
function _tabsMerken(sheetId, titel) {
  _tabsCache[sheetId] = titel;
  try { localStorage.setItem(TABS_KEY, JSON.stringify(_tabsCache)); } catch(_) {}
}
const _tabsLaeuft = {};   // sheetId → laufende Anfrage; buendelt parallele Aufrufe
function _tabsHolen(sheetId) {
  // Ohne Buendelung schickten die fuenf gleichzeitigen Blattabrufe fuenf identische
  // Namensanfragen los – genau das, was der Zwischenspeicher einsparen soll.
  if (!_tabsLaeuft[sheetId]) {
    _tabsLaeuft[sheetId] = _tabsHolenJetzt(sheetId).finally(() => { delete _tabsLaeuft[sheetId]; });
  }
  return _tabsLaeuft[sheetId];
}
async function _tabsHolenJetzt(sheetId) {
  const r = await _sheetsAbruf(sheetId + '?fields=sheets.properties.title',
    async res => 'Sheets API Fehler ' + res.status + ': ' + await res.text());
  if (r.authError) return r;
  const titel = (r.json.sheets || []).map(x => x.properties.title);
  _tabsMerken(sheetId, titel);
  return { titel };
}

// ── Ein Blatt aus der Google-Tabelle laden ────────────
// Ohne `blattName` das erste Blatt der Tabelle.
async function _fetchSheet(sheetId, blattName) {
  // Token-Ablauf proaktiv prüfen – wenn er in < 60 s abläuft, gilt er als ungültig.
  // Hier wird BEWUSST nicht mehr von selbst zur Anmeldung weitergeleitet: seit die
  // App aus dem Zwischenspeicher startet, liefe sonst jeder Hintergrund-Abruf in
  // eine Weiterleitung und risse den Nutzer aus der laufenden Ansicht. Der Aufrufer
  // entscheidet, was mit `authError` geschieht.
  if (!accessToken || Date.now() > tokenExpiry - 60_000) {
    tokenVerwerfen();
    return { authError: true };
  }
  // Blattnamen aus dem Zwischenspeicher; fehlt der gesuchte, einmal frisch holen.
  let titel = _tabsCache[sheetId];
  const gesucht = () => blattName ? (titel.includes(blattName) ? blattName : null) : titel[0];
  if (!Array.isArray(titel) || !titel.length || !gesucht()) {
    const frisch = await _tabsHolen(sheetId);
    if (frisch.authError) return { authError: true };
    titel = frisch.titel;
  }
  const tabName = gesucht();
  if (!tabName) return { values: [], fehlt: true };   // Blatt gibt es noch nicht
  const r = await _sheetsAbruf(sheetId + '/values/' + encodeURIComponent(tabName),
    res => 'Daten-Abruf fehlgeschlagen: ' + res.status);
  if (r.authError) return r;
  return { values: r.json.values || [] };
}

// Laedt Health-, Workout- und Meta-Blatt. `still:true` = Hintergrund-Abruf, waehrend bereits Daten
// aus dem Zwischenspeicher auf dem Bildschirm stehen: dann darf weder der Login-Screen
// noch die Fehlerkarte den vorhandenen Stand ueberdecken.
// Rueckgabe: true (geladen) | 'auth' (Anmeldung noetig) | false (Fehler).
async function loadFromAPI(opt = {}) {
  const still = !!opt.still;
  try {
    // Alle Blaetter GLEICHZEITIG anfragen. Vorher liefen sie nacheinander: vier
    // Wartestufen hintereinander, bevor der erste Wert auf dem Bildschirm stand.
    // Das Workout-Blatt faengt seinen Fehler selbst ab, damit es den
    // Gesundheitsteil nicht mitreisst.
    const alsFehler = e => ({ fehler: e });
    const [health, workout, meta] = await Promise.all([
      _fetchSheet(HEALTH_SHEET_ID),
      _fetchSheet(WORKOUT_SHEET_ID).catch(alsFehler),
      // Fehlt das Blatt, liefert _fetchSheet `{fehlt:true}` statt zu scheitern – der
      // Stempel bleibt dann einfach leer. Es faehrt in derselben Welle mit, damit es
      // keine zusaetzliche Wartestufe kostet.
      _fetchSheet(HEALTH_SHEET_ID, META_BLATT).catch(alsFehler)
    ]);
    if (health.authError) {
      tokenVerwerfen();
      if (!still) anmeldungZeigen();
      return 'auth';
    }
    allData = _healthZeilen(health.values);
    // Export-Zeitstempel. Ein Fehlschlag aendert nichts: dann bleibt der zuletzt
    // bekannte Stempel stehen, und ohne Stempel nennt die App weiter nur den Tag.
    const _st = (meta && !meta.fehler && !meta.authError) ? _stempelAusBlatt(meta.values) : null;
    if (_st) _exportStempel = _st;
    // Nur auf den neuesten Tag springen, wenn der Nutzer nicht selbst geblättert hat.
    if (!_datumSelbstGewaehlt || !referenceDate) referenceDate = allData[allData.length - 1].date;
    _analyticsCache = {}; // neue Daten → Analytics-Cache invalidieren

    // 2. Workout-Daten. Ein Fehler hier legt die übrigen Tabs nicht lahm, darf
    //    aber nicht stillschweigend verschluckt werden: sonst wartet der Training-Tab
    //    endlos auf Daten, die nie kommen. Deshalb Fehler merken und den Ladeversuch
    //    in jedem Fall als abgeschlossen markieren.
    // Beim Hintergrund-Abruf gilt: ein gescheiterter Teil aendert NICHTS. Sonst
    // taeuschte eine kurze Netzstoerung den Verlust von Daten vor, die im
    // Zwischenspeicher einwandfrei vorliegen – der Training-Tab waere gegen eine
    // Fehlerkarte getauscht worden, obwohl alle Trainings da sind.
    const behalten = still && Object.keys(workoutData).length > 0;
    if (!behalten) workoutLoadError = null;
    try {
      if (workout.fehler) throw workout.fehler;
      if (workout.authError) {
        if (!behalten) workoutLoadError = 'Keine gültige Berechtigung für das Workout-Sheet.';
      } else if (workout.values && workout.values.length > 1) {
        const wHeaders = workout.values[0].map(h => h.trim());
        const wRows = workout.values.slice(1).map(row => {
          const obj = {};
          wHeaders.forEach((h, i) => { obj[h] = (row[i] ?? '').toString().trim(); });
          return obj;
        });
        // Leeren statt ergaenzen: _parseWorkoutRows schreibt nur hinein, im Sheet
        // geloeschte Tage blieben sonst nach einem Neuladen stehen.
        workoutData = {};
        _parseWorkoutRows(wRows);
      }
      // values.length <= 1 → Sheet enthält nur die Kopfzeile: kein Fehler, nur keine Einträge.
    } catch(e) {
      if (behalten) console.warn('[Daten] Workout-Abruf fehlgeschlagen, alter Stand bleibt:', e.message);
      else workoutLoadError = e.message || 'Unbekannter Fehler beim Abruf.';
    } finally {
      workoutSheetReady = true;
    }

  } catch(e) {
    // Im Hintergrund-Abruf bleibt der Stand aus dem Zwischenspeicher stehen – eine
    // Fehlerkarte wuerde funktionierende Daten hinter einer Meldung verstecken.
    if (still) { console.warn('[Daten] Hintergrund-Abruf fehlgeschlagen:', e.message); return false; }
    fehlerZeigen('Fehler beim Laden: ' + e.message); return false;
  }
  _lastLoadTs = Date.now();
  datenCacheSchreiben();
  return true;
}

// Rohwerte des Health-Blatts → eine Zeile je Datum, nach Datum sortiert.
function _healthZeilen(werte) {
  if (!werte || werte.length < 2) throw new Error('Keine Gesundheitsdaten im Sheet gefunden');
  const kopf = werte[0].map(h => h.trim());
  const textSpalten = new Set(['date','sleepStart','sleepEnd']);
  const zeilen = werte.slice(1).map(row => {
    const obj = {};
    kopf.forEach((h, i) => {
      const v = (row[i] ?? '').toString().trim();
      if (v === '') { obj[h] = null; return; }
      obj[h] = textSpalten.has(h) ? v : (isNaN(v) ? v : parseFloat(v));
    });
    return obj;
    // Nur echte Datumszeilen übernehmen – irgendein Text in der Datumsspalte wäre
    // sonst bis in die Anzeige durchgereicht worden.
  }).filter(r => istDatum(r.date));
  if (!zeilen.length) throw new Error('Keine Zeile mit gültigem Datum (Format JJJJ-MM-TT) gefunden');
  zeilen.sort((a, b) => a.date.localeCompare(b.date));

  // Doppelte Datumszeilen zusammenführen. Das Apps-Script schreibt beim Refresh die
  // letzten Tage neu; steht ein Tag danach zweimal im Sheet, zählte er sonst in JEDEN
  // Durchschnitt doppelt. Die spätere Zeile gewinnt, überschreibt aber keinen
  // vorhandenen Wert mit null (eine Nachzügler-Zeile kann Felder leer lassen).
  const proTag = new Map();
  zeilen.forEach(r => {
    const vorhanden = proTag.get(r.date);
    if (!vorhanden) { proTag.set(r.date, r); return; }
    Object.keys(r).forEach(k => { if (r[k] != null) vorhanden[k] = r[k]; });
  });
  const dubletten = zeilen.length - proTag.size;
  if (dubletten > 0) console.info(`[Daten] ${dubletten} doppelte Datumszeile(n) zusammengeführt.`);
  return [...proTag.values()];
}

// ── Export-Zeitstempel aus dem Blatt `Meta` ───────────
// Zwei Schreibweisen werden akzeptiert, weil die Sheets-API die ANGEZEIGTE
// Zeichenkette liefert (siehe den Gotcha dazu): das Skript schreibt die Zelle als
// Text und damit im ISO-Format, deutet Sheets sie doch als Datum, steht dort
// "12.09.2026 07:14:33". Alles andere gilt als nicht vorhanden.
// Durchgelassen werden nur Ziffern – der Wert kommt aus einer Sheet-Zelle und wird
// angezeigt, taugt also nicht als Rohtext im Markup.
function _stempelAusBlatt(werte) {
  const zeilen = Array.isArray(werte) ? werte : [];
  const treffer = zeilen.find(z => Array.isArray(z) && String(z[0] ?? '').trim() === 'letzterExport');
  if (!treffer) return null;
  const roh = String(treffer[1] ?? '').trim();
  let m = roh.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return { datum: m[1]+'-'+m[2]+'-'+m[3], zeit: m[4]+':'+m[5] };
  m = roh.match(/^(\d{2})\.(\d{2})\.(\d{4}),?\s+(\d{1,2}):(\d{2})/);
  if (m) return { datum: m[3]+'-'+m[2]+'-'+m[1], zeit: String(m[4]).padStart(2,'0')+':'+m[5] };
  return null;
}
// Dieselbe Pruefung fuer den Zwischenspeicher: localStorage ist von aussen
// beschreibbar und damit nicht vertrauenswuerdiger als eine Sheet-Zelle.
function _stempelGeprueft(s) {
  return (s && istDatum(s.datum) && typeof s.zeit === 'string' && /^\d{2}:\d{2}$/.test(s.zeit))
    ? { datum: s.datum, zeit: s.zeit } : null;
}

// ── Zwischenspeicher der Daten ────────────────────────
// Die App wartete beim Start, bis alle Blätter geladen waren – bei abgelaufener
// Anmeldung sah man stattdessen nur den Login. Jetzt liegt der zuletzt geladene
// Stand auf dem Gerät: er erscheint sofort, das Nachladen läuft dahinter.
// Das Google-Sheet bleibt die massgebliche Quelle; hier steht nur eine Kopie.
// Die Versionsnummer im Schlüssel verwirft alte Stände automatisch, falls sich
// später ändert, WIE die Daten eingelesen werden – lieber einmal warten als
// einen alten Stand falsch deuten.
// v2 seit 14.09.2026: `workoutData` traegt `laeufe`. Ein v1-Stand haette das Feld
// nicht, und „Ø pro Lauf" bliebe bis zum Nachladen leer – deshalb verwirft er sich.
// v3 seit 18.09.2026: `workoutData` traegt `einheiten` (jede Einheit einzeln, fuer die
// Rekorde der Trainings-Einblicke).
const DATEN_KEY = 'hcc_daten_v3';

// Der Inhalt OHNE Zeitstempel – dient zugleich als Fingerabdruck: der Hintergrund-
// Abruf vergleicht ihn vorher und nachher und zeichnet nur neu, wenn sich wirklich
// etwas geaendert hat. Sonst blitzte bei jedem Start ein Neuaufbau aller Diagramme
// auf, obwohl exakt dieselben Zahlen herauskamen.
function datenStand() {
  return JSON.stringify({ allData, workoutData, workoutLoadError });
}

function datenCacheSchreiben() {
  try { localStorage.removeItem('hcc_daten_v1'); localStorage.removeItem('hcc_daten_v2'); } catch(_) {}   // Vorgaenger-Staende aufraeumen
  try {
    // Der Stempel steht NEBEN dem Fingerabdruck, nicht darin: datenStand() ist die
    // Vergleichsgrundlage fuer „hat sich etwas geaendert?" und soll sich nur aendern,
    // wenn sich die Messwerte aendern.
    localStorage.setItem(DATEN_KEY, '{"v":3,"ts":' + (_lastLoadTs || 0)
      + ',"stempel":' + JSON.stringify(_exportStempel) + ',"d":' + datenStand() + '}');
  } catch(e) {
    // Voller Speicher: die Kopie ist eine Bequemlichkeit, kein Muss. Den alten
    // (womöglich noch brauchbaren) Stand aber nicht halb überschrieben stehen lassen.
    try { localStorage.removeItem(DATEN_KEY); } catch(_) {}
    console.warn('[Daten] Zwischenspeicher konnte nicht geschrieben werden:', e.name);
  }
}

// Füllt die Datenvariablen aus dem Zwischenspeicher. Gibt true zurück, wenn ein
// brauchbarer Stand da war – nur dann darf die App ohne Netz starten.
function datenCacheLesen() {
  let roh, d;
  try { roh = JSON.parse(localStorage.getItem(DATEN_KEY) || 'null'); } catch(_) { return false; }
  if (!roh || roh.v !== 3 || !roh.d) return false;
  d = roh.d; d.ts = roh.ts;
  if (!Array.isArray(d.allData) || !d.allData.length) return false;
  // Dieselbe Datumsprüfung wie beim Einlesen aus dem Sheet: der Zwischenspeicher ist
  // beschreibbar von aussen, also nicht vertrauenswürdiger als eine Sheet-Zelle.
  const zeilen = d.allData.filter(r => r && istDatum(r.date));
  if (!zeilen.length) return false;
  allData = zeilen;
  allData.sort((a, b) => a.date.localeCompare(b.date));
  workoutData    = (d.workoutData && typeof d.workoutData === 'object') ? d.workoutData : {};
  workoutLoadError = d.workoutLoadError || null;
  workoutSheetReady = true;
  referenceDate  = allData[allData.length - 1].date;
  _lastLoadTs    = (typeof d.ts === 'number' && d.ts > 0) ? d.ts : null;
  _exportStempel = _stempelGeprueft(roh.stempel);
  _analyticsCache = {};
  return true;
}

// ── Start: erst der gespeicherte Stand, dann das Nachladen ──
// Reihenfolge ist wichtig: _initAuth setzt den Token, damit der Hintergrund-Abruf
// später weiss, ob er überhaupt fragen darf.
_initAuth();
const _startAusCache = datenCacheLesen();
if (!_startAusCache) {
  // Ohne gespeicherten Stand gibt es nichts zu zeigen – wie bisher: Login bzw. warten.
  if (!accessToken) { anmeldungZeigen(); return; }
  if ((await loadFromAPI()) !== true) return;
}

// ── Window / filter ────────────────────────────────────
// Die auswählbaren Bereiche stehen in _RANGE_OPTS (Quelle für die Zeitleiste).
// „Heute" ist kein Bereich, sondern ein Sprung auf den neuesten Ausschnitt
// (aufHeuteSpringen) – Diagramme zeigen nie nur einen einzigen Tag.
// Jahresvergleich (12.09.2026, auf Wunsch): kein Zeitraum im bisherigen Sinn, sondern
// DERSELBE Kalendermonat in allen Jahren, die Daten haben – Sep 24, Sep 25, Sep 26
// nebeneinander. Er laeuft als eigener Wert von `timeRange`, damit jede Stelle, die
// den Zeitraum auswertet, ihn auch sieht; `windowDays`/`windowMonths` liefern dafuer
// null, und `moWindow()` damit ebenfalls – ein zusammenhaengendes Fenster gibt es
// hier nicht.
// `_yoyVorher` merkt sich den Bereich, aus dem heraus eingeschaltet wurde: beim
// Ausschalten steht wieder da, was vorher da war.
function istYoY() { return timeRange === 'yoy'; }

// ── Einzeljahr (28.09.2026, auf Wunsch) ────────────────────────────────────────
// Knoepfe „2024", „2025", „2026" in der Befehlszeile der Zeitleiste zeigen EIN
// Kalenderjahr, Januar bis Dezember als Monatsbalken. `timeRange` ist dann 'jahr';
// WELCHES Jahr, sagt `referenceDate` – so blaettern die Pfeile ohne Sonderweg ein
// Jahr weiter (`_navZiel`). Das Fenster (`moWindow`) wird auf den Datenbestand
// geklemmt: fuer das laufende Jahr endet es am neuesten Tag, sonst teilte „Ø pro
// Woche" durch Wochen, die noch gar nicht stattgefunden haben.
// `_jahrVorher` merkt sich Bereich, Bezugsdatum und `_datumSelbstGewaehlt` von vor
// dem Einschalten; ein zweiter Tipp auf das aktive Jahr stellt alles wieder her.
function istJahr() { return timeRange === 'jahr'; }
function jahrVon(ds) { return ds ? +ds.slice(0, 4) : null; }
// Die Jahre, fuer die Gesundheitsdaten vorliegen – daraus entstehen die Knoepfe.
function datenJahre() { return [...new Set(allData.map(r => r.date.slice(0, 4)))].sort().map(Number); }
// Bezugsdatum fuer ein Jahr: sein letzter Tag, im laufenden Jahr der neueste Datentag.
function jahresBezug(jahr) {
  const letzter = allData[allData.length - 1].date, ende = jahr + '-12-31';
  return letzter < ende ? letzter : ende;
}
let _jahrVorher = null;
function jahrUmschalten(jahr) {
  if (istJahr() && jahrVon(referenceDate) === jahr) {
    // Zweiter Tipp auf das aktive Jahr: zurueck in den Zustand von vorher.
    const v = _jahrVorher || { range: '12m', ref: allData[allData.length - 1].date, selbst: false };
    _jahrVorher = null;
    referenceDate = v.ref; _datumSelbstGewaehlt = v.selbst;
    bereichSetzen(v.range);
    return;
  }
  if (!istJahr()) _jahrVorher = { range: timeRange, ref: referenceDate, selbst: _datumSelbstGewaehlt };
  referenceDate = jahresBezug(jahr);
  // Ein Nachladen im Hintergrund darf nicht auf den neuesten Tag – also ins
  // laufende Jahr – zurueckspringen.
  _datumSelbstGewaehlt = true;
  bereichSetzen('jahr');
}

// ── Jahresvergleich: Fusszeilen „2025 vs. 2024" (auf Wunsch, 14.09.2026) ──────
// Im Jahresvergleich enthaelt D nur EINEN Kalendermonat, verteilt auf mehrere Jahre.
// Nach `YYYY-MM` gruppiert ergibt das je Jahr genau einen Wert – denselben, den der
// Balken zeigt: Summe (Strecke, Zeit) oder Mittel (alles andere). Die Jahre kommen
// aus `allMonths(D)`, damit ein Jahr ohne Messwert als „—" sichtbar bleibt statt
// stillschweigend zu fehlen.
function yoyWerte(D, wertVon, art) {
  const b = {};
  D.forEach(r => {
    const v = wertVon(r);
    if (v == null || isNaN(v)) return;
    (b[r.date.slice(0, 7)] = b[r.date.slice(0, 7)] || []).push(v);
  });
  return allMonths(D).map(mo => {
    const l = b[mo];
    if (!l) return { mo, v: null };
    const s = l.reduce((a, x) => a + x, 0);
    return { mo, v: art === 'summe' ? s : s / l.length };
  });
}

// Eine Zeile je Jahr ab dem zweiten: prozentuale Veraenderung zum Vorjahr.
// Das NEUESTE Jahr steht oben (auf Wunsch, 14.09.2026): 2026 vs. 2025, dann
// 2025 vs. 2024 – die Frage ist fast immer „wie steht das laufende Jahr da?".
// `reihen`: [{ werte, richtung: 'hoch'|'tief'|null, vor: 'REM ' }] – mehrere Reihen
// stehen in EINER Zeile, getrennt wie im uebrigen Fuss („+2% | −5%").
// Farbe NUR, wo `ZIELE` eine Richtung kennt (Farbe = Bewertung, nie Richtung).
// `summe`: bei Summen ist ein angebrochener Monat nicht vergleichbar – ein halber
// September hat halb so viele Kilometer. Die Zeile nennt dann, bis wann gezaehlt ist.
function yoyZeilen(reihen, summe) {
  const mos = reihen[0].werte.map(x => x.mo);
  const letzter = allData.length ? allData[allData.length - 1].date : null;
  const jahr = mo => mo.slice(0, 4);
  if (mos.length < 2) {
    return mos.length ? statZeile(`${jahr(mos[0])} vs. ${+jahr(mos[0]) - 1}`, '—') : '';
  }
  let html = '';
  for (let i = mos.length - 1; i >= 1; i--) {
    const teile = reihen.map(r => {
      const p = prozentDiff(r.werte[i].v, r.werte[i - 1].v);
      if (p == null) return { txt: (r.vor || '') + '—', farbe: null };
      const gerundet = Number(p.toFixed(1));
      const txt = (r.vor || '') + (gerundet > 0 ? '+' : '') + zahl(gerundet, 1) + '%';
      const farbe = r.richtung && gerundet !== 0
        ? ((gerundet > 0) === (r.richtung === 'hoch') ? '#10B981' : '#EF4444') : null;
      return { txt, farbe };
    });
    let label = `${jahr(mos[i])} vs. ${jahr(mos[i - 1])}`;
    if (summe && letzter && letzter.slice(0, 7) === mos[i] && letzter !== moLast(letzter)) {
      label += ` (bis ${letzter.slice(8, 10)}.${letzter.slice(5, 7)}.)`;
    }
    if (teile.length === 1) {
      html += statZeile(label, teile[0].txt, teile[0].farbe);
    } else {
      html += statZeile(label, teile.map(t => t.farbe
        ? `<span style="color:${t.farbe};font-weight:700">${t.txt}</span>` : t.txt).join(' | '));
    }
  }
  return html;
}
let _yoyVorher = '1m';

function windowDays() { return {'7d':7}[timeRange] || null; }
function windowMonths() { return {'1m':1,'3m':3,'6m':6,'12m':12,'24m':24,'jahr':12}[timeRange] || null; }

// Always format as local YYYY-MM-DD (avoids UTC-offset-off-by-one bug)
function toLocalDateStr(dt) {
  return dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');
}
// In KALENDERTAGEN (setDate), nicht in Millisekunden: mit n × 24 h verrutschte das
// Ergebnis bei der Zeitumstellung um einen Tag – addDays('2025-10-26', 1) ergab
// wieder den 26.10. (der Tag hat 25 Stunden), rueckwaerts ueber Ende Maerz den Vortag.
function addDays(dateStr, n) {
  const dt = new Date(dateStr + 'T00:00:00');
  dt.setDate(dt.getDate() + n);
  return toLocalDateStr(dt);
}
function addMonths(dateStr, n) {
  const dt = new Date(dateStr+'T00:00:00');
  dt.setMonth(dt.getMonth() + n);
  return toLocalDateStr(dt);
}
// Returns first day of the month containing dateStr
function moFirst(dateStr) { return dateStr.slice(0,7)+'-01'; }
// Returns last day of the month containing dateStr
function moLast(dateStr) { return addDays(addMonths(moFirst(dateStr),1),-1); }

// For month-based filters: compute calendar-snapped start/end
function moWindow() {
  const wm = windowMonths();
  if (wm == null) return null;
  if (istJahr()) {
    // Das Kalenderjahr von referenceDate, geklemmt auf den Datenbestand.
    const j = jahrVon(referenceDate), erster = allData[0].date, letzter = allData[allData.length - 1].date;
    const s = j + '-01-01', e = j + '-12-31';
    return { s: s < erster ? erster : s, e: e > letzter ? letzter : e };
  }
  const endFirst  = moFirst(referenceDate);          // first of end month
  const startFirst = addMonths(endFirst, -(wm-1));   // first of start month
  return { s: startFirst, e: moLast(referenceDate) };
}

function filtered() {
  if (!referenceDate || !allData.length) return [];
  if (is7D()) {
    const days = weekDays7();
    return allData.filter(r => r.date >= days[0] && r.date <= days[6]);
  }
  // Jahresvergleich: derselbe Kalendermonat in JEDEM Jahr, das Daten hat. Welcher
  // Monat gemeint ist, sagt referenceDate – die Blaetterpfeile verschieben ihn wie
  // sonst auch um je einen Monat.
  if (istYoY()) { const mm = referenceDate.slice(5,7); return allData.filter(r => r.date.slice(5,7) === mm); }
  const mw = moWindow();
  if (mw) return allData.filter(r => r.date >= mw.s && r.date <= mw.e);
  // fallback (no month filter active)
  const e = referenceDate;
  const s = addDays(referenceDate, -((windowDays()||1)-1));
  return allData.filter(r => r.date >= s && r.date <= e);
}

function prevPeriod() {
  if (!referenceDate || !allData.length) return [];
  // Im Jahresvergleich gibt es keine Vorperiode: die Jahre stehen bereits
  // nebeneinander im Diagramm. Eine erfundene Vergleichsspanne waere schlechter als
  // keine – die Kacheln zeigen dann „—" statt einer Zahl ohne Bedeutung.
  if (istYoY()) return [];
  // Einzeljahr: das Kalenderjahr davor.
  if (istJahr()) { const j = jahrVon(referenceDate) - 1; return allData.filter(r => jahrVon(r.date) === j); }
  if (is7D()) {
    const prevRef = addDays(referenceDate, -7);
    const mon = getWeekMonday(prevRef);
    const sun = addDays(mon, 6);
    return allData.filter(r => r.date >= mon && r.date <= sun);
  }
  const wm = windowMonths();
  if (wm != null) {
    const curStartFirst = addMonths(moFirst(referenceDate), -(wm-1));
    const prevEndFirst  = addMonths(curStartFirst, -1);        // month before current start
    const prevEnd       = moLast(prevEndFirst);
    const prevStart     = addMonths(moFirst(prevEndFirst), -(wm-1));
    return allData.filter(r => r.date >= prevStart && r.date <= prevEnd);
  }
  const wd = windowDays() || 1;
  const e = addDays(referenceDate, -wd);
  const s = addDays(referenceDate, -(2*wd-1));
  return allData.filter(r => r.date >= s && r.date <= e);
}


// "07.09." – Tag und Monat zweistellig, Grundlage aller kurzen Datumsangaben.
function _tagPunktMonat(dt) {
  return String(dt.getDate()).padStart(2,'0') + '.' + String(dt.getMonth()+1).padStart(2,'0') + '.';
}
function fmtDayShort(d) {
  if (!d) return '–';
  const dt = new Date(d+'T00:00:00');
  return _tagPunktMonat(dt) + String(dt.getFullYear()).slice(-2);
}

// Aktiv-/Inaktiv-Zustand der Blätterpfeile und von „Heute".
function updateNavUI() {
  // Zuerst die Zeitleiste, denn der Bereichsname stimmt auch ohne Daten.
  zeitleisteAktualisieren();
  if (!allData.length) return;
  const minDate = allData[0].date;
  const maxDate = allData[allData.length-1].date;
  let prevDis, nextDis;
  if (is7D()) {
    const days = weekDays7();
    prevDis = days[0] <= minDate;
    nextDis = days[6] >= maxDate;
  } else {
    const mw = moWindow();
    prevDis = mw ? mw.s <= minDate : addMonths(referenceDate,-1) < minDate;
    nextDis = mw ? mw.e >= maxDate : referenceDate >= maxDate;
  }
  // BEWUSST kein `disabled`-Attribut, sondern eine eigene Klasse (07.09.2026).
  // Ein deaktivierter Knopf nimmt in WebKit keine Tipps an; der Tipp lief dort an ihm
  // vorbei und blendete die Bottom-Nav ein — der Nutzer tippte auf einen Pfeil und
  // bekam die Tableiste. Als normaler Knopf schluckt er den Tipp wie jeder andere,
  // und die Ausnahmeliste des Hintergrund-Tipps (`button, a, input, …`) greift.
  // `aria-disabled` sagt Screenreadern trotzdem, dass hier nichts geht.
  const setzeInaktiv = (b, aus) => {
    b.classList.toggle('inaktiv', aus);
    b.setAttribute('aria-disabled', aus ? 'true' : 'false');
  };
  document.querySelectorAll('.nav-prev').forEach(b => setzeInaktiv(b, prevDis));
  document.querySelectorAll('.nav-next').forEach(b => setzeInaktiv(b, nextDis));
  // „Heute" verblasst, wenn man schon am neuesten Tag steht – dann gaebe es nichts zu
  // springen. Bewusst `referenceDate === maxDate` und NICHT „vorwaerts geht nicht":
  // bei 7T kann der Pfeil › schon inaktiv sein, waehrend der neueste Tag in der
  // naechsten Woche liegt.
  document.querySelectorAll('.zl-heute').forEach(b => setzeInaktiv(b, referenceDate === maxDate));
}

// Wohin fuehrt ein Schritt in diese Richtung — oder `null`, wenn der Datenbestand
// dort endet? EINE Quelle fuer Pfeile, Wischgeste und deren Gummiband-Verhalten.
function _navZiel(richtung) {
  if (!referenceDate || !allData.length) return null;
  // Einzeljahr: ein Schritt ist ein Jahr – sofern es fuer das Zieljahr Daten gibt.
  if (istJahr()) {
    const ziel = jahrVon(referenceDate) + richtung;
    return datenJahre().includes(ziel) ? jahresBezug(ziel) : null;
  }
  return _imDatenbestand(is7D() ? addDays(referenceDate, richtung * 7) : addMonths(referenceDate, richtung), richtung);
}
// Das Ziel eines Schritts – oder null, wenn es jenseits des ersten bzw. letzten Tags liegt.
function _imDatenbestand(ziel, richtung) {
  if (richtung < 0 && ziel < allData[0].date) return null;
  if (richtung > 0 && ziel > allData[allData.length - 1].date) return null;
  return ziel;
}

// Ein Schritt in eine Richtung – fuer Pfeile und Wischgeste. Bei Monatsbalken
// (`_spaltenBereich`) wird VOR dem Neuaufbau festgehalten, wie jedes Diagramm gerade
// aussieht, damit der neue Stand genau dort beginnen und um die tatsaechlich
// verschobenen Spalten weiterruecken kann (siehe „Monatsbalken ruecken weiter").
function _navSchritt(richtung, schritte = 1) {
  const nr = schritte > 1 ? _navZielMonate(richtung, schritte) : _navZiel(richtung);
  if (!nr) return;
  _spaltenAbbrechen();
  const spalten = _spaltenBereich() && !bewegungAus();
  const vorher = spalten ? _spaltenMerken() : null;
  referenceDate = nr; _datumSelbstGewaehlt = true;
  updateNavUI();
  _navSliding = true;
  _refreshAfterStateChange();
  _navSliding = false;
  const erledigt = spalten ? _spaltenStarten(vorher, richtung, schritte) : null;
  _animNavSlide(richtung, erledigt, vorher, schritte);
}
// Wie _navZiel, aber um `n` Monate – fuer den Zeitstrahl-Wisch bei Monatsbalken.
function _navZielMonate(richtung, n) {
  if (!referenceDate || !allData.length || n < 1) return null;
  return _imDatenbestand(addMonths(referenceDate, richtung * n), richtung);
}
// Wie viele Monate lassen sich in diese Richtung hoechstens blaettern?
function _maxMonate(richtung) {
  let n = 0;
  while (n < 120 && _navZielMonate(richtung, n + 1)) n++;
  return n;
}

function navPrev() { _navSchritt(-1); }   // zurück: Daten wischen nach rechts
function navNext() { _navSchritt(1); }    // vor: Daten wischen nach links

// ── Kurze Uebergaenge (18.09.2026) ──────────────────────────────────────────
// EIN Helfer fuer die kleinen Zeichen-Animationen (Markierung, Beschriftungen,
// Hilfslinien, Kachel-Zaehler): ruft `proSchritt(e)` je Bild mit dem geglaetteten
// Fortschritt 0..1 (easeOutCubic) und am Ende `fertig()`.
// Der Zeitgeber ist derselbe Rueckfall wie bei `_ausklappAnimieren`: eine Seite, die
// nicht gezeichnet wird, liefert kein requestAnimationFrame – ohne ihn bliebe der
// Zustand auf dem ersten Bild stehen (Beschriftung unsichtbar, Kachel auf 0).
// Rueckgabe: eine Funktion, die abbricht, OHNE `fertig` aufzurufen.
function bewegungAus() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
function uebergang(dauer, proSchritt, fertig) {
  const start = performance.now();
  let raf = null, vorbei = false, zg = null;
  const ende = () => {
    if (vorbei) return; vorbei = true;
    if (raf) cancelAnimationFrame(raf); clearTimeout(zg);
    try { proSchritt(1); } catch (_) {}
    if (fertig) fertig();
  };
  const schritt = now => {
    if (vorbei) return;
    const t = Math.min(1, (now - start) / dauer);
    if (t >= 1) { ende(); return; }
    try { proSchritt(1 - Math.pow(1 - t, 3)); } catch (_) {}
    raf = requestAnimationFrame(schritt);
  };
  zg = setTimeout(ende, dauer + 120);
  raf = requestAnimationFrame(schritt);
  return () => { vorbei = true; if (raf) cancelAnimationFrame(raf); clearTimeout(zg); };
}

// `_navSliding`: waehrend eines Schritts ohne Aufbau-Animation bauen (zeichneDiagramm).
// `_navSlideRAF`: die laufende Schiebe-/Wisch-Animation – nie zwei gleichzeitig.
let _navSliding = false;
let _navSlideRAF = null;

// Wisch-Animation beim Pfeil-Navigator. Verschiebt via navslide-Plugin NUR die
// Datenfläche jedes Charts (Achsen/Gitter bleiben stehen). dir=-1 (zurück) →
// Daten kommen von links herein (Bewegung nach rechts); dir=+1 (vor) → von rechts.
// Sanftes, etwas längeres Ease-Out + Einblendung. Respektiert reduce-motion.
// Seit 18.09.2026 zwei Faelle:
//  - 7T, 1M, Jahresvergleich: ein Schritt tauscht das GANZE Fenster → wie bisher
//    weiter Weg (42 %, hoechstens 110 px) mit Einblenden.
//  - Monatsbalken (`_spaltenBereich`): die meisten Diagramme ruecken um ihre Spalten
//    weiter (`_spaltenStarten`, als `ausnahmen` uebergeben). Was bleibt – der Pace mit
//    seinen Punkten je Training –, gleitet nur um die Breite EINES Monats und ohne
//    Ausblenden; ein Wisch-Versatz aus `vorher` wird dabei fortgesetzt.
// Das erste Bild wird sofort gesetzt: vorher stand fuer ein Bild der Endstand da,
// bevor die Bewegung einsetzte.
function _animNavSlide(dir, ausnahmen, vorher, schritte = 1) {
  if (bewegungAus()) return;
  if (_navSlideRAF) { cancelAnimationFrame(_navSlideRAF); _navSlideRAF = null; }
  const monat = _spaltenBereich();
  const los = () => {
    const list = (tabCharts[currentScreen] || [])
      .map(id => charts[id]).filter(c => c && c.chartArea && !(ausnahmen && ausnahmen.has(c)));
    if (!list.length) return;
    const dur = monat ? SPALTEN_DAUER : 560;
    const ease = t => 1 - Math.pow(1 - t, 3); // easeOutCubic – weiches Auslaufen
    const weg = c => { const w = c.chartArea.right - c.chartArea.left;
                       return monat ? w / windowMonths() * schritte : Math.min(w * 0.42, 110); };
    const anfang = new Map(list.map(c => {
      const ziel = dir * weg(c);
      const zug = vorher && vorher[c.canvas.id] ? vorher[c.canvas.id].zug : 0;
      const spiel = monat ? (c.chartArea.right - c.chartArea.left) / windowMonths() / 2 : 0;
      return [c, _zwischen(ziel + zug, ziel, spiel)];
    }));
    const setze = e => list.forEach(c => {
      if (!c.chartArea) return;
      c.$navslide = { offset: anfang.get(c) * (1 - e), alpha: monat ? 1 : 0.25 + 0.75 * e };
      try { c.draw(); } catch (_) {}
    });
    setze(0);
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur);
      if (t < 1) { setze(ease(t)); _navSlideRAF = requestAnimationFrame(step); }
      else { list.forEach(c => { delete c.$navslide; try { c.draw(); } catch (_) {} }); _navSlideRAF = null; }
    };
    _navSlideRAF = requestAnimationFrame(step);
  };
  // Monatsbereiche: die Diagramme stehen schon (auch Training baut synchron, sobald
  // die Workout-Daten da sind). Sonst wie bisher ein Bild abwarten.
  if (monat) los(); else requestAnimationFrame(los);
}

// Zeitbereich wechseln ('7d', '1m' … oder 'yoy') und neu aufbauen.
function bereichSetzen(bereich) {
  timeRange = bereich;
  _refreshAfterStateChange();
}

// ── Helpers ────────────────────────────────────────────
const MONAT_KURZ = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
function fmtM(ym) { if (!ym) return '—'; const [y,m] = ym.split('-').map(Number); return MONAT_KURZ[m-1]+' '+String(y).slice(-2); }

// Wochen in einem Zeitraum – als Kommazahl. Ein Monat ist NICHT "vier Wochen":
// 28 Tage sind 4.00, 31 Tage 4.43. Wer rund rechnet, liegt je nach Monat um bis zu
// 10 % daneben – und genau der Vergleich zwischen Monaten ist der Zweck der Zahl.
function wochenZwischen(vonDs, bisDs) {
  const tage = Math.round((new Date(bisDs+'T00:00:00') - new Date(vonDs+'T00:00:00')) / 86400000) + 1;
  return tage > 0 ? tage / 7 : null;
}
// Wochen eines Kalendermonats aus dem Schluessel 'JJJJ-MM'. Tag 0 des Folgemonats ist
// der letzte Tag des gesuchten – das kennt auch die Schaltjahre.
function wochenImMonat(monatsKey) {
  const [j, m] = String(monatsKey).split('-').map(Number);
  return (j && m) ? new Date(j, m, 0).getDate() / 7 : null;
}

// Nachkommastellen nur, wo sie etwas aussagen: "25.0" wird zu "25", "25.5" bleibt.
// (Auf Wunsch, 06.09.2026.) `Number()` um `toFixed()` herum wirft die Nullen weg —
// das gilt auch fuer die zweite Stelle: 25.10 -> "25.1", 25.00 -> "25".
// `dec` bleibt damit eine OBERGRENZE, keine feste Breite. Wer je eine feste Breite
// braucht (etwa fuer eine rechtsbuendige Spalte), darf nicht `zahl()` nehmen.
function zahl(v, dec=1) { return v == null ? '—' : String(Number(Number(v).toFixed(dec))); }

// ── Text aus fremder Quelle entschärfen ────────────────
// PFLICHT für jeden Wert, der NICHT aus diesem Code stammt und als Text in eine
// Seite eingesetzt wird: Sheet-Inhalte, Fehlermeldungen von Google, alles, was von
// aussen kommt. Die Seiten werden über innerHTML aufgebaut – ohne diese Funktion
// würde `<img src=x onerror=…>` in einer Zelle nicht angezeigt, sondern ausgeführt.
// Der Schaden wäre real: solcher Code liefe innerhalb der App und käme an den
// Google-Ausweis im Browserspeicher, also an die Sheets.
// Zahlen und Datumsangaben brauchen das nicht – die werden beim Einlesen geprüft.
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function prozentDiff(curr, prev) { if (curr==null||prev==null||prev===0) return null; return ((curr-prev)/Math.abs(prev))*100; }
// Gueltige Zahlen aus Zeilen (`field` gesetzt) oder aus einer blossen Werte-Reihe.
function _werte(arr, field) {
  return (arr || []).map(r => field ? r[field] : r).filter(v => v != null && !isNaN(v));
}
function mittel(arr, field) {
  const vals = _werte(arr, field);
  return vals.length ? vals.reduce((a,b) => a+b, 0)/vals.length : null;
}
// Mittelwert einer Werte-Reihe, leere Werte uebersprungen.
function mittelArr(a) { return mittel(a); }
function standardabw(arr, field) {
  const vals = _werte(arr, field);
  if (vals.length < 2) return null;
  const m = vals.reduce((a,b)=>a+b,0)/vals.length;
  return Math.sqrt(vals.map(v=>(v-m)**2).reduce((a,b)=>a+b,0)/vals.length);
}
// Ein Wert je Zeitraum-Schluessel (Monat, Wochenmontag …), passend zu `schluessel`
// ausgerichtet: Mittel oder Summe der Zeilen, deren `gruppeVon(date)` ihn liefert.
// Zeitraeume ohne Wert bleiben null.
function _gruppenReihe(schluessel, rows, field, gruppeVon, art) {
  const b = {};
  rows.forEach(r => {
    if (r[field] == null) return;
    const g = b[gruppeVon(r.date)] = b[gruppeVon(r.date)] || { sum: 0, n: 0 };
    g.sum += r[field]; g.n++;
  });
  return schluessel.map(k => b[k] ? (art === 'summe' ? b[k].sum : b[k].sum / b[k].n) : null);
}
function allMonths(rows) { return [...new Set(rows.map(r=>r.date.slice(0,7)))].sort(); }
// Dauer-Beschriftung in den Diagrammen: "1:37" (Stunden:Minuten, Minuten immer
// zweistellig) und "28'" fuer alles unter einer Stunde – auf Wunsch, 12.09.2026;
// vorher "1h 37m" bzw. "38m".
// Die aufgerundete Minute muss dabei ueberlaufen koennen: 7.996 h ergaebe sonst
// "7:60" – dieselbe Falle, die fmtPace bei 5'60" abfaengt.
// Das Zeichen fuer "nur Minuten" ist dasselbe wie in fmtPace ('), damit Pace und
// Dauer dieselbe Sprache sprechen.
// Der Zeilenumbruch bei 24M ist damit entfallen (auf Wunsch): das Format ist rund
// 40 % schmaler als "7h 25m" und passt auch neben 24 Nachbarn in eine Zeile.
// alsStdMin() bleibt daneben bestehen – Tooltips, Fusszeilen und Kacheln schreiben
// weiter "7h 25m", wo genug Platz ist und der Text fuer sich stehen muss.
// Stunden → [ganze Stunden, Minuten]; eine auf 60 gerundete Minute laeuft ueber.
function _stundenMinuten(h) {
  let st = Math.floor(h), mi = Math.round((h % 1) * 60);
  if (mi === 60) { st++; mi = 0; }
  return [st, mi];
}
function stdMinLabel(stunden) {
  if (stunden == null) return '';
  const [st, mi] = _stundenMinuten(stunden);
  return st ? st + ':' + String(mi).padStart(2, '0') : mi + "'";
}

function alsStdMin(h) {
  if (h == null) return '—';
  const [st, mi] = _stundenMinuten(h);
  return st + 'h ' + String(mi).padStart(2,'0') + 'm';
}
// Pace: km/h → min/km, plus einheitliche Darstellung 5'30".
// Vorher an drei Stellen ausgeschrieben, dabei zweimal mit '' statt " als Sekundenzeichen.
function paceFromSpeed(kph) { return kph > 0 ? 60/kph : null; }
// Minuten menschenlesbar: ab einer Stunde als "1h 25min", darunter "45 min".
function fmtMin(min) {
  if (min == null) return '—';
  const vz = min < 0 ? '−' : '', a = Math.abs(Math.round(min));
  if (a < 60) return vz + a + ' min';
  const h = Math.floor(a/60), m = a % 60;
  return vz + h + 'h' + (m ? ' ' + m + 'min' : '');
}
function fmtPace(minPerKm) {
  if (minPerKm == null) return '—';
  let m = Math.floor(minPerKm), s = Math.round((minPerKm % 1) * 60);
  if (s === 60) { m++; s = 0; }   // 5.999 min/km sonst als 5'60"
  return `${m}'${String(s).padStart(2,'0')}"`;
}
function fmtHHMM(h) { if(h==null) return '—'; const hh=Math.floor(h)%24; const mm=Math.round((h%1)*60)%60; return hh.toString().padStart(2,'0')+':'+mm.toString().padStart(2,'0'); }
// Uhrzeit aus einer Sheet-Zelle ("23:14" oder "2026-09-07 23:14") → Stunden als Zahl.
function parseTV(val) {
  if (val == null) return null;
  if (typeof val === 'number' && !isNaN(val)) return val;
  if (typeof val !== 'string') return null;
  const m = val.match(/\d{4}-\d{2}-\d{2}\s+(\d{2}):(\d{2})/) || val.match(/^(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1]) + parseInt(m[2]) / 60 : null;
}
// Mittlere Uhrzeit. Einschlafzeiten vor Mittag zaehlen als nach Mitternacht (+24 h),
// sonst laege 00:30 im Mittel sieben Stunden vor 23:30.
function avgCircTime(rows, field, isSleepOnset) {
  const vals = rows.map(r => parseTV(r[field])).filter(v => v != null);
  if (!vals.length) return null;
  const norm = isSleepOnset ? vals.map(h => h < 12 ? h + 24 : h) : vals;
  const avg = norm.reduce((a, b) => a + b, 0) / norm.length;
  return avg >= 24 ? avg - 24 : avg;
}

// ── Wochentag / Wochenende ─────────────────────────────
// Dieselbe Zerlegung stand vorher an 14 Stellen wortwörtlich im Code – jede
// Änderung (etwa Samstag als Wochentag zu werten) hätte 14 Korrekturen erfordert.
function isWeekend(dateStr) { const d = new Date(dateStr+'T00:00:00').getDay(); return d === 0 || d === 6; }
function splitWeekWknd(rows) {
  const wkd = [], wknd = [];
  rows.forEach(r => (isWeekend(r.date) ? wknd : wkd).push(r));
  return { wkd, wknd };
}

function is7D() { return timeRange === '7d'; }
function getWeekMonday(dateStr) {
  const dt = new Date(dateStr+'T00:00:00');
  const mon = new Date(dt); mon.setDate(dt.getDate() - ((dt.getDay()+6)%7));
  return toLocalDateStr(mon);
}
// Kalenderwoche nach ISO 8601. Die Woche gehoert dem Jahr, in dem ihr DONNERSTAG
// liegt — deshalb wird zuerst auf den Donnerstag derselben Woche gesprungen und erst
// dann gezaehlt. Ohne diesen Umweg lieferten die Tage um den Jahreswechsel falsche
// Nummern (der 29.12.2025 gehoert zur KW 1 von 2026, nicht zur KW 53 von 2025).
// Bewusst mit lokalen Date-Objekten und ohne toISOString(): das rechnet nach UTC um
// und verschoebe in der Schweiz jeden Montag auf den Vortag.
function isoKW(dateStr) {
  const dt = new Date(dateStr + 'T00:00:00');
  const do_ = new Date(dt);
  do_.setDate(dt.getDate() - ((dt.getDay() + 6) % 7) + 3);   // Montag dieser Woche + 3
  const jahresanfang = new Date(do_.getFullYear(), 0, 1);
  return Math.floor(Math.round((do_ - jahresanfang) / 86400000) / 7) + 1;
}

function weekDays7() {
  if (!referenceDate) return [];
  const mon = getWeekMonday(referenceDate);
  return Array.from({length:7}, (_,i) => addDays(mon, i));
}
function allWeeks(rows) { return [...new Set(rows.map(r=>getWeekMonday(r.date)))].sort(); }
// Zweizeilige Achsenbeschriftung für Tagesauflösung: Wochentag über dem Datum.
// Chart.js rendert ein Array als mehrzeiligen Tick – erster Eintrag oben.
const WOCHENTAG_KURZ = ['So','Mo','Di','Mi','Do','Fr','Sa'];
function wochentagKurz(dateStr) { return WOCHENTAG_KURZ[new Date(dateStr+'T00:00:00').getDay()]; }
function tagLabel(dateStr) { return [wochentagKurz(dateStr), fmtWeek(dateStr)]; }
function fmtWeek(w) { return _tagPunktMonat(new Date(w+'T00:00:00')); }

// Tagesauflösung (7T, 1M): eine Säule je Tag aus `days`.
function _tagesDim(days, rows) {
  const byDate = {};
  rows.forEach(r => { byDate[r.date] = r; });
  const align = field => days.map(d => byDate[d]?.[field] ?? null);
  return { labels: days.map(tagLabel), align, alignSum: align,
           hasData: days.some(d => d in byDate), keys: days, keyTyp: 'tag' };
}

// granular=true → weekly buckets for 1M/3M (line charts); false → monthly (bar charts)
function timeDim(rows, granular=false, keepAggregated=false) {
  if (is7D()) return _tagesDim(weekDays7(), rows);
  // 1M: jeder Kalendertag des Monats
  if (timeRange==='1m' && !keepAggregated) {
    const mw = moWindow(), days = [];
    if (mw) for (let d = mw.s; d <= mw.e; d = addDays(d, 1)) days.push(d);
    return _tagesDim(days, rows);
  }
  if (granular && (timeRange==='1m' || timeRange==='3m')) {
    const weeks = allWeeks(rows);
    const mw = moWindow();
    const filterStart = mw ? mw.s : null;
    // Clamp week labels: if a week's Monday falls before the filter start,
    // show the filter start date as label instead (avoids showing prev-month dates)
    const labels = weeks.map(w => fmtWeek(filterStart && w < filterStart ? filterStart : w));
    return {
      labels,
      align: field => _gruppenReihe(weeks, rows, field, getWeekMonday, 'mittel'),
      alignSum: field => _gruppenReihe(weeks, rows, field, getWeekMonday, 'summe'),
      hasData: weeks.length > 0,
      keys: weeks, keyTyp: 'woche'
    };
  }
  const mos = allMonths(rows);
  const monatVon = d => d.slice(0, 7);
  return {
    labels: mos.map(fmtM),
    align: field => _gruppenReihe(mos, rows, field, monatVon, 'mittel'),
    alignSum: field => _gruppenReihe(mos, rows, field, monatVon, 'summe'),
    hasData: mos.length > 0,
    keys: mos, keyTyp: 'monat'
  };
}

// ═══════════════════════════════════════════════════════════
// Zeitraum-Schlüssel, Wochentrenner und app-weite Markierung
// ═══════════════════════════════════════════════════════════
// Jedes Diagramm meldet über cfg.__keys, welcher Zeitraum hinter welcher Säule
// steckt, und über cfg.__keyTyp dessen Auflösung ('tag' | 'woche' | 'monat').
// Erst dadurch lässt sich eine Markierung sinnvoll über Diagramme hinweg
// übertragen: Positionen sind NICHT vergleichbar (die 3. Säule im Trainings-
// diagramm ist ein anderer Tag als die 3. Säule im Schlafdiagramm).

// Ausgewählter Tag, app-weit. Bleibt bestehen, bis derselbe Punkt erneut
// angetippt wird – Tippen neben ein Diagramm hebt sie bewusst NICHT auf,
// damit sich Diagramme über Tabs hinweg vergleichen lassen.
let _markierung = null;   // 'YYYY-MM-DD' oder null

// Index der Säule, die in diesem Diagramm den markierten Tag enthält.
function _markIndex(chart, datum = _markierung) {
  if (!datum || !chart.$keys) return -1;
  const d = datum;
  if (chart.$keyTyp === 'monat') return chart.$keys.indexOf(d.slice(0,7));
  if (chart.$keyTyp === 'woche') return chart.$keys.indexOf(getWeekMonday(d));
  return chart.$keys.indexOf(d);
}

// Grenzen einer Säule in Pixeln. Bei Kategorie-Achsen ist die Spaltenbreite
// gleichmässig, deshalb reicht die halbe Kategorie-Breite links und rechts.
function _spalte(chart, i) {
  const x = chart.scales.x, a = chart.chartArea;
  const mitte = x.getPixelForValue(i);
  const n = chart.$keys ? chart.$keys.length : (chart.data.labels||[]).length;
  const halb = n > 0 ? (a.right - a.left) / n / 2 : 12;
  return { mitte, links: mitte - halb, rechts: mitte + halb };
}

function _cssFarbe(name, fallback) {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

// ── Ebene 1: Wochentrenner (nur im 1M-Fenster) ──
// Feiner Strich am Wochenanfang – nur im 1M-Fenster, wo eine ganze Kalenderwoche
// als Block erkennbar sein soll. Die frueher getoenten Wochenendspalten sind
// entfallen: sie legten eine zweite Flaeche unter die Daten und stoerten dort, wo
// ohnehin schon Ziel- und Markierungsflaechen liegen.
const wochentrennerPlugin = {
  id: 'wochentrenner',
  beforeDatasetsDraw(chart) {
    if (timeRange !== '1m' || chart.$keyTyp !== 'tag' || !chart.$keys) return;
    const a = chart.chartArea; if (!a) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = ACHSEN_COLOR;
    ctx.lineWidth = 1;
    chart.$keys.forEach((d, i) => {
      // Montag = Wochenanfang. Der Strich liegt auf der linken Kante seiner Spalte,
      // also genau zwischen Sonntag und Montag. Der ganz linke entfaellt – dort ist
      // schon die Achse.
      if (i === 0 || new Date(d + 'T00:00:00').getDay() !== 1) return;
      const x = Math.round(_spalte(chart, i).links) + 0.5;   // .5 = knackige 1px-Linie
      ctx.beginPath();
      ctx.moveTo(x, a.top);
      ctx.lineTo(x, a.bottom);
      ctx.stroke();
    });
    ctx.restore();
  }
};

// ── Ebene 2: markierte Säule tönen (vor den Daten) ──
const markierungPlugin = {
  id: 'markierung',
  beforeDatasetsDraw(chart) {
    // Waehrend des Ausblendens zeichnet sie den eben abgeschalteten Tag weiter –
    // mit abnehmender Deckkraft (`_markAlpha`, siehe setMarkierung).
    const i = _markIndex(chart, _markierung || _markVerblasst);
    if (i < 0 || _markAlpha <= 0) return;
    const a = chart.chartArea; if (!a) return;
    const sp = _markSpalte(chart, i), ctx = chart.ctx;
    // Die Markierung besteht ausschliesslich aus der getoenten Spaltenflaeche –
    // keine senkrechten Randlinien mehr.
    if (sp.rechts <= sp.links) return;
    ctx.save();
    ctx.fillStyle = _cssFarbe('--tab-color', '#0891B2');
    ctx.globalAlpha = 0.13 * _markAlpha;
    ctx.fillRect(sp.links, a.top, sp.rechts - sp.links, a.bottom - a.top);
    ctx.restore();
  },
  // ── Ebene 3: alles ausserhalb der Säule zurücktreten lassen ──
  // Als Schleier ÜBER den Daten statt über die Farben jedes einzelnen Datensatzes:
  // wirkt dadurch auch auf Linien und Flächen und kommt ohne Eingriff in die
  // zwölf unterschiedlich aufgebauten Diagramme aus.
  afterDatasetsDraw(chart) {
    const i = _markIndex(chart, _markierung || _markVerblasst);
    if (i < 0 || _markAlpha <= 0) return;
    const a = chart.chartArea; if (!a) return;
    const sp = _markSpalte(chart, i), ctx = chart.ctx;
    ctx.save();
    ctx.globalAlpha = _markAlpha;
    ctx.fillStyle = document.body.classList.contains('dark')
      ? 'rgba(30,41,59,.72)' : 'rgba(255,255,255,.72)';
    ctx.fillRect(a.left, a.top, Math.max(0, sp.links - a.left), a.bottom - a.top);
    ctx.fillRect(sp.rechts, a.top, Math.max(0, a.right - sp.rechts), a.bottom - a.top);
    ctx.restore();
  }
};

// Die Spalte der Markierung – waehrend Monatsbalken weiterruecken um deren Versatz
// verschoben und auf die Zeichenflaeche begrenzt (siehe `_spaltenStarten`).
function _markSpalte(chart, i) {
  const sp = _spalte(chart, i), a = chart.chartArea;
  const off = chart.$spalten ? chart.$spalten.off : 0;
  const klemme = x => Math.max(a.left, Math.min(a.right, x));
  return { links: klemme(sp.links + off), rechts: klemme(sp.rechts + off) };
}

// Tooltip des markierten Punkts dauerhaft einblenden – in JEDEM Diagramm, das
// diesen Tag enthält. Ohne das müsste man jedes Diagramm einzeln antippen, um die
// Werte zum selben Tag abzulesen; genau das soll der Vergleich ja ersparen.
function _tooltipAnMarkierung(chart) {
  const tt = chart.tooltip;
  if (!tt) return;
  const leeren = () => {
    try { chart.setActiveElements([]); } catch(_) {}   // Hover-Zustand des Charts
    try { tt.setActiveElements([], {x:0,y:0}); tt.update(true); } catch(_) {}
  };
  const i = _markIndex(chart);
  if (i < 0) { leeren(); return; }
  // ALLE sichtbaren Datensätze mit echtem Wert an dieser Stelle aktivieren – die
  // meisten Diagramme nutzen den Tooltip-Modus 'index' und zeigen dort sonst nur
  // eine einzelne Zeile statt aller Reihen (z. B. nur „Tiefschlaf" statt aller
  // vier Schlafphasen). Ein null-Punkt (fehlende Messung) bleibt aussen vor.
  const elemente = [];
  chart.data.datasets.forEach((ds, di) => {
    if (chart.isDatasetVisible(di) && ds.data[i] != null) elemente.push({ datasetIndex: di, index: i });
  });
  if (!elemente.length) { leeren(); return; }
  const punkt = chart.getDatasetMeta(elemente[0].datasetIndex).data[i];
  try {
    tt.setActiveElements(elemente, { x: punkt ? punkt.x : 0, y: punkt ? punkt.y : 0 });
    // Modell (Position, Grösse, Inhalt) sofort aufbauen – setActiveElements allein
    // setzt nur den Zustand, gezeichnet würde sonst ein Kasten ohne Geometrie.
    tt.update(true);
  } catch(_) {}
}

// Markierung setzen und ALLE Diagramme der App neu zeichnen – auch die der
// anderen Tabs, die im DOM bereits vorgerendert sind.
//
// Ein- und Ausschalten BLENDEN (150 ms, auf Wunsch 18.09.2026): Toenung und Schleier
// laufen ueber `_markAlpha`. Der Wechsel von einer Saeule zur naechsten springt
// weiterhin – dort steht der Schleier ja schon, nur die Luecke wandert.
// Der Tooltip blendet NICHT: seine Animation ist aus gutem Grund abgeschaltet (siehe
// `Chart.defaults.plugins.tooltip.animation`). Er erscheint mit dem ersten Bild und
// verschwindet beim Abschalten sofort, waehrend der Schleier noch ausklingt.
// Waehrend der Blende werden nur die Diagramme des sichtbaren Tabs neu gezeichnet;
// am Ende alle, damit kein vorgerenderter Tab auf einem Zwischenstand stehen bleibt.
const MARK_DAUER = 150;
let _markAlpha = 1;          // Deckkraft von Toenung und Schleier, 0..1
let _markVerblasst = null;   // Tag, dessen Markierung gerade ausklingt
let _markStopp = null;
function setMarkierung(datum) {
  const vorher = _markierung;
  _markierung = datum;
  if (_markStopp) { _markStopp(); _markStopp = null; }
  const blenden = !bewegungAus() && !vorher !== !datum;   // genau eines von beiden gesetzt
  _markVerblasst = blenden && !datum ? vorher : null;
  _markAlpha = blenden && datum ? 0 : 1;
  Object.values(charts).forEach(c => {
    try { c.update('none'); _tooltipAnMarkierung(c); c.draw(); } catch(_) {}
  });
  if (!blenden) return;
  const zeichnen = liste => liste.forEach(c => { try { c.draw(); } catch(_) {} });
  _markStopp = uebergang(MARK_DAUER,
    e => { _markAlpha = datum ? e : 1 - e;
           zeichnen((tabCharts[currentScreen] || []).map(id => charts[id]).filter(Boolean)); },
    () => { _markStopp = null; _markVerblasst = null; _markAlpha = 1; zeichnen(Object.values(charts)); });
}

// Tipp auf ein Diagramm: Säule bestimmen, Tag ableiten, umschalten.
function _chartTipp(chart, evt) {
  if (!chart.$keys || !chart.$keys.length) return;
  const treffer = chart.getElementsAtEventForMode(evt, 'index', { intersect: false }, true);
  if (!treffer.length) return;
  const i = treffer[0].index;
  if (i == null || i < 0 || i >= chart.$keys.length) return;
  // Erneuter Tipp auf dieselbe Säule schaltet ab – auch aus einem anderen Diagramm.
  if (_markIndex(chart) === i) { setMarkierung(null); return; }
  const k = chart.$keys[i];
  // Monats-/Wochensäulen liefern kein Datum: den ersten Tag des Zeitraums nehmen.
  setMarkierung(chart.$keyTyp === 'monat' ? k + '-01' : k);
}

// ── Datenbeschriftungen ueber Balken und Punkten ─────────────────────────────
// Nur, wo ein Diagramm sie ueber `cfg.__werteFmt` anfordert. Ob sie zu sehen sind,
// entscheidet `beschriftungAn()` beim ZEICHNEN, nicht beim Aufbau des Tabs: Chart.js
// zeichnet bei jeder Groessenaenderung ohnehin neu, dadurch kommen und gehen die
// Zahlen beim Drehen des Geraets von selbst.
// Ueberlappungen loest das Plugin selbst (belegte Rechtecke, siehe unten) – lieber
// einzelne Werte auslassen als eine unlesbare Reihe.
// ── Datenbeschriftungen: Standard und Wunsch des Nutzers ─────────────────────
// Ein Tipp auf den Kartentitel schaltet die Zahlen eines Diagramms um (auf Wunsch,
// 08.09.2026) — unabhaengig von Zeitraum und Ausrichtung, und die Wahl bleibt
// erhalten. Der Zustand liegt AUSSERHALB der Seitenfunktionen, sonst waere er nach
// jedem Neuaufbau zurueckgesetzt.
//
// Fehlender Eintrag heisst „noch nicht entschieden" — dann gilt der Standard.
// Ein gesetzter Eintrag gewinnt IMMER, auch gegen `__werteNurQuer` und gegen die
// Hochformat-Regel: der Nutzer hat ausdruecklich gefragt.
const _beschriftung = {};

// Was ein Diagramm ohne Zutun zeigt.
function beschriftungStandard(chart) {
  if (!chart.$werteFmt) return false;
  if (chart.$werteAus) return false;   // Schlafphasen: nur auf Wunsch
  // Querformat immer; im Hochformat nur, wo wenige Saeulen nebeneinander stehen:
  // bei 7T hoechstens sieben, im Jahresvergleich eine je Jahr. Ab 1M waeren es 30+.
  if (window.innerWidth > window.innerHeight) return true;
  return (timeRange === '7d' || istYoY()) && !chart.$nurQuer;
}
function beschriftungAn(chart) {
  const w = _beschriftung[chart.canvas && chart.canvas.id];
  return w === undefined ? beschriftungStandard(chart) : w;
}

// Zeilenhoehe der Beschriftungen – auch die Grundlage fuer die Ueberlappungspruefung
// und den Abstand mehrzeiliger Texte. Eine Quelle, damit beides zusammenpasst.
const ZEILE_H = 11;
// Luft ueber der Zeichenflaeche, damit die Zahl des HOECHSTEN Balkens ueber ihm Platz
// hat (12.09.2026). Ohne sie klemmte das Plugin sie nach unten IN den Balken: erreicht
// ein Balken genau den obersten Achsenwert (gesehen bei „2:00" auf 120 von 120 min),
// liegt seine Oberkante auf `chartArea.top` und darueber ist im Diagramm nichts mehr.
// Die Luft wird in `zeichneDiagramm` als `layout.padding.top` gesetzt — sie gilt
// IMMER, wenn ein Diagramm ueberhaupt beschriftet werden kann, nicht nur wenn die
// Zahlen gerade sichtbar sind: sonst spraenge die Zeichenflaeche beim Titel-Tipp.
const LABEL_LUFT = ZEILE_H + 6;
const werteLabelPlugin = {
  id: 'werteLabel',
  afterDatasetsDraw(chart) {
    const fmt = chart.$werteFmt;
    if (!fmt) return;
    // Ob gezeichnet wird, entscheidet beschriftungAn(): Wunsch des Nutzers, sonst
    // Standard. Die Entscheidung faellt hier beim ZEICHNEN, damit sie beim Drehen
    // des Geraets von selbst nachzieht.
    // `$werteBlende` haelt die Zahlen waehrend des Aus-Blendens noch sichtbar
    // (siehe `_werteBlenden`) – `beschriftungAn` ist dann schon false.
    const blende = chart.$werteBlende;
    if (!beschriftungAn(chart) && !(blende && blende.aus)) return;
    const flaeche = chart.chartArea; if (!flaeche) return;
    const ctx = chart.ctx;
    ctx.save();
    // Die Zahlen wandern mit ihren Balken – bei Monatsbalken (`$spalten`, 18.09.2026)
    // und ebenso bei der Schiebe-Animation von 7T, 1M und Jahresvergleich (`$navslide`,
    // auf Wunsch 18.09.2026): dort verschob das navslide-Plugin nur die Datensaetze und
    // stellte den Zeichenzustand wieder her, BEVOR dieses Plugin zeichnet – die Zahlen
    // blieben stehen, waehrend die Balken darunter wegglitten. Sie uebernehmen deshalb
    // Versatz UND Deckkraft der Balken. Geschnitten an der Zeichenflaeche, die Luft
    // darueber eingeschlossen.
    const ns = chart.$spalten ? null : chart.$navslide;
    ctx.globalAlpha = (blende ? blende.alpha : 1) * (ns ? ns.alpha : 1);
    const versatz = chart.$spalten ? chart.$spalten.off : ns ? ns.offset : 0;
    if (versatz) {
      ctx.beginPath();
      ctx.rect(flaeche.left, 0, flaeche.right - flaeche.left, flaeche.bottom);
      ctx.clip();
    }
    ctx.font = '600 10px ' + (Chart.defaults.font.family || 'sans-serif');
    ctx.fillStyle = _cssFarbe('--txt2', '#64748B');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    // Belegte Flaechen ueber ALLE Datensaetze hinweg. Erst nur die x-Achse zu
    // pruefen reichte nicht: in "Ruhepuls & HRV" laufen zwei Reihen im selben
    // Diagramm und kreuzen sich – dort stiessen die Zahlen aufeinander, obwohl in
    // jeder Reihe fuer sich genug Platz war.
    const belegt = [];
    const frei = (x1, y1, x2, y2) => !belegt.some(b =>
      x1 < b.x2 && x2 > b.x1 && y1 < b.y2 && y2 > b.y1);
    chart.data.datasets.forEach((ds, di) => {
      // Hilfslinien (Ø, Ziel) bleiben unbeschriftet – dieselbe Regel wie im Tooltip,
      // damit beide dasselbe unter "Messwert" verstehen.
      if (!ds || !nurMesswerte({ dataset: ds })) return;
      const meta = chart.getDatasetMeta(di);
      if (!meta || meta.hidden) return;
      meta.data.forEach((punkt, i) => {
        const wert = ds.data[i];
        if (wert == null || !punkt) return;
        const txt = fmt(wert, ds);
        if (txt == null || txt === '') return;
        // Ein `\n` im Ergebnis des Formatierers bricht die Beschriftung um. So kann
        // jedes Diagramm selbst entscheiden, wann sein Text zu breit fuer die Spalte
        // wird – das Plugin muss die Zeitraeume nicht kennen.
        const zeilen = String(txt).split('\n');
        const halb = Math.max(...zeilen.map(z => ctx.measureText(z).width)) / 2 + 3;
        const hoehe = zeilen.length * ZEILE_H;
        // Die Zahl steht IMMER ueber dem Balken, nie darin (auf Wunsch, 12.09.2026).
        // Geklemmt wird deshalb erst am oberen Rand des CANVAS, nicht an dem der
        // Zeichenflaeche: darueber liegt die Luft aus `LABEL_LUFT`, und die gehoert
        // der Beschriftung. Vorher schob `flaeche.top + hoehe` die Zahl des hoechsten
        // Balkens nach unten in ihn hinein.
        const y = Math.max(punkt.y - 4, hoehe);
        const px = punkt.x + versatz;
        const x1 = px - halb, x2 = px + halb, y1 = y - hoehe, y2 = y + 2;
        if (!frei(x1, y1, x2, y2)) return;
        // textBaseline ist 'bottom': die LETZTE Zeile sitzt auf y, die uebrigen
        // darueber.
        zeilen.forEach((z, k) => ctx.fillText(z, px, y - (zeilen.length - 1 - k) * ZEILE_H));
        belegt.push({ x1, y1, x2, y2 });
      });
    });
    ctx.restore();
  }
};

// Titel-Tipp: die Zahlen blenden in 180 ms ein bzw. aus (auf Wunsch, 18.09.2026),
// statt auf einen Schlag zu erscheinen. Der Zustand (`_beschriftung`) ist beim Aufruf
// schon gesetzt; `$werteBlende.aus` haelt die Zahlen waehrend des Ausblendens noch im
// Bild. Ein zweiter Tipp waehrend der Blende bricht die laufende ab und startet neu.
const WERTE_DAUER = 180;
function _werteBlenden(liste, an) {
  liste.forEach(c => { if (c.$werteStopp) c.$werteStopp(); });
  const zeichnen = () => liste.forEach(c => { try { c.draw(); } catch(_) {} });
  if (bewegungAus()) { zeichnen(); return; }
  liste.forEach(c => { c.$werteBlende = { alpha: an ? 0 : 1, aus: !an }; });
  const aufraeumen = () => liste.forEach(c => { delete c.$werteBlende; delete c.$werteStopp; });
  const stopp = uebergang(WERTE_DAUER,
    e => { liste.forEach(c => { if (c.$werteBlende) c.$werteBlende.alpha = an ? e : 1 - e; }); zeichnen(); },
    () => { aufraeumen(); zeichnen(); });
  liste.forEach(c => { c.$werteStopp = () => { stopp(); aufraeumen(); }; });
}

// ── Hilfslinien ein-/ausblenden (5, auf Wunsch 18.09.2026) ──────────────────
// Die Linie ist ein Datensatz; ein Tipp auf den Legenden-Schalter baut den Tab neu
// auf. Vorher wuchsen dabei ALLE Diagramme eine Sekunde lang neu von der Grundlinie,
// obwohl sich an den Daten nichts geaendert hatte. Jetzt: Neuaufbau ohne Wachsen
// (`_ruhigRendern`), und nur die Linie blendet – vor dem Neuaufbau aus, danach ein.
// `$hlBlende` = { art: 'oe'|'ziel', alpha } wirkt auf jeden Datensatz dieser Art;
// in Ruhepuls & HRV schaltet ein Schalter beide Ø-Linien, beide blenden gemeinsam.
const HL_DAUER = 220;
// Hilfslinie einer Art: 'ziel' (Label „Ziel …“) oder 'oe' (Label „Ø …“).
// Hilfslinie ueberhaupt (Ø oder Ziel) – dieselbe Regel fuer Tooltip, Beschriftung
// und alle Verschiebe-Plugins.
function _istHilfslinienLabel(l) { return /^(Ø|Ziel)/.test(l || ''); }
function _istHilfslinie(ds, art) { return (art === 'ziel' ? /^Ziel/ : /^Ø/).test(ds.label || ''); }
const hilfslinienBlende = {
  id: 'hilfslinienBlende',
  beforeDatasetDraw(chart, args) {
    const b = chart.$hlBlende;
    if (!b) return;
    const ds = chart.data.datasets[args.index];
    if (!ds || !_istHilfslinie(ds, b.art)) return;
    chart.ctx.save();
    chart.ctx.globalAlpha *= b.alpha;
    chart.$hlOffen = args.index;
  },
  afterDatasetDraw(chart, args) {
    if (chart.$hlOffen !== args.index) return;
    chart.$hlOffen = null;
    chart.ctx.restore();
  }
};
// Einblenden einer frisch aufgebauten Linie. Aufgerufen aus `zeichneDiagramm`, sobald
// das Diagramm steht – bei Training erst nach dem asynchronen Aufbau. Das erste
// (volle) Bild zeichnet Chart.js noch im Konstruktor, das `draw()` hier ersetzt es in
// derselben Aufgabe, bevor der Browser malt: es blitzt nichts auf.
let _hlPlan = null;          // { id, art } – welche Linie beim naechsten Aufbau einblendet
function _hlEinblenden(c, art) {
  c.$hlBlende = { art, alpha: 0 };
  try { c.draw(); } catch(_) {}
  uebergang(HL_DAUER,
    e => { if (c.$hlBlende) { c.$hlBlende.alpha = e; try { c.draw(); } catch(_) {} } },
    () => { delete c.$hlBlende; try { c.draw(); } catch(_) {} });
}

// Neuaufbau OHNE Aufbau-Animation fuer alle Diagramme, die vorher schon SICHTBAR
// waren – ueberall dort, wo sich die Daten nicht aendern: Hilfslinie umschalten und
// Aus-/Einklappen. Diagramme, die dabei erst ins Bild kommen (etwa beim Aufklappen),
// wachsen wie gewohnt herein. „Sichtbar" statt „vorhanden": die Diagramme im
// zugeklappten Bereich existieren bereits, nur ohne Flaeche (`display:none`) – als
// blosse Existenz gezaehlt, erschienen Schlafphasen- und Score-Verlauf beim Aufklappen
// fertig gezeichnet statt hereinzuwachsen. Bei Training entstehen die Diagramme
// asynchron; die Liste bleibt deshalb stehen, bis dessen Promise erfuellt ist.
let _ruhigeIds = null;
function _ruhigRendern(tab) {
  const ids = new Set((tabCharts[tab] || []).filter(id =>
    charts[id] && charts[id].canvas && charts[id].canvas.getClientRects().length));
  _ruhigeIds = ids;
  const weg = () => { if (_ruhigeIds === ids) _ruhigeIds = null; };
  let r;
  try { r = _renderTab(tab); } catch (e) { weg(); throw e; }
  if (r && typeof r.then === 'function') r.then(weg, weg); else weg();
  return r;
}

// ── Monatsbalken ruecken weiter (auf Wunsch, 18.09.2026) ─────────────────────
// Ab 3M blaettert ein Schritt EINEN Monat, das Fenster umfasst aber drei bis 24. Die
// alte Animation schob die ganze Datenflaeche weg und blendete sie aus – es sah aus,
// als wechsle das ganze Fenster, obwohl fuenf von sechs Balken dieselben blieben.
// Jetzt:
//  1. Das neue Diagramm beginnt GENAU dort, wo das alte stand, und rueckt um die
//     Spalten weiter, die tatsaechlich dazukommen bzw. wegfallen. Der Versatz kommt aus
//     den Zeitraum-Schluesseln (`$keys`) vorher und nachher, in Pixeln gemessen – so
//     stimmt er auch, wenn sich die Breite der y-Achse aendert, und bei VO2max, das bei
//     3M in Wochen aufloest (ein Monat = vier bis fuenf Spalten).
//     Der ausscheidende Monat ist im neuen Diagramm nicht mehr enthalten. Er faehrt als
//     Ausschnitt einer Momentaufnahme des alten Canvas hinaus (`streifen`), sonst stuende
//     am Rand fuer die Dauer der Bewegung eine leere Spalte.
//  2. Monatsnamen (`drawLabels` der x-Achse), Zahlen ueber den Balken, Markierung und
//     Tooltip wandern mit ihren Balken.
//  3. Die y-Achse gleitet vom alten auf den neuen Bereich: `min`/`max` werden je Bild
//     gesetzt und das Diagramm mit `update('none')` neu berechnet – Gitter, Achsen-
//     beschriftung und Balkenhoehen bleiben dadurch stimmig. `includeBounds` ist dabei
//     aus, sonst stuende oben eine krumme Zwischenzahl an der Achse.
//  4. Ø-Linien gleiten senkrecht auf ihren neuen Wert und ruecken NICHT seitlich mit;
//     Ziellinien bleiben stehen.
// Exaktes Weiterruecken gibt es fuer Monats- und Wochenspalten; der Pace (Punkte je
// Training) GLEITET einen Monat weit, mit denselben Punkten 2–4 (siehe `_spaltenPlan`).
// 7T, 1M und der Jahresvergleich bleiben ganz beim alten Weg (`_animNavSlide`): dort
// tauscht ein Schritt tatsaechlich das ganze Fenster.
const SPALTEN_DAUER = 420;
let _spaltenLauf = null;
// Einzeljahr zaehlt nicht dazu: ein Schritt tauscht dort das GANZE Fenster (ein Jahr).
function _spaltenBereich() { return !is7D() && timeRange !== '1m' && !istYoY() && !istJahr(); }
// Startversatz auf [0, ziel] begrenzen – plus `spiel` auf beiden Seiten. Der Spielraum
// ist das Einrasten des Zeitstrahl-Wischs: wer 2.4 Monate zieht, blaettert 2, und die
// Flaeche federt die 0.4 zurueck; bei 2.6 blaettert er 3 und sie rueckt 0.4 nach.
function _zwischen(wert, ziel, spiel = 0) {
  return Math.max(Math.min(0, ziel) - spiel, Math.min(Math.max(0, ziel) + spiel, wert));
}

// Vor dem Neuaufbau: wie sieht jedes Diagramm des sichtbaren Tabs gerade aus?
function _spaltenMerken() {
  const m = {};
  (tabCharts[currentScreen] || []).forEach(id => {
    const c = charts[id];
    if (!c || !c.chartArea || !c.canvas) return;
    // Ein laufender Wisch-Versatz ist der Startpunkt der Bewegung – das Bild selbst
    // muss aber OHNE ihn aufgenommen werden, sonst saesse der Streifen verschoben.
    const zug = c.$spalten && c.$spalten.zug ? c.$spalten.off : c.$navslide ? c.$navslide.offset : 0;
    // Das Bild ohne Wisch-Versatz UND ohne Hilfslinien aufnehmen: der hinausfahrende
    // Streifen braechte sonst die alten Linienstuecke mit (hilfslinienVoll).
    delete c.$navslide; delete c.$spalten;
    c.$ohneHilfslinien = true;
    try { c.draw(); } catch (_) {}
    const v = { zug, keys: c.$keys ? c.$keys.slice() : null, keyTyp: c.$keyTyp,
                links: c.chartArea.left, rechts: c.chartArea.right, skalen: {}, hl: [] };
    const x = c.scales.x;
    if (v.keys && x) {
      v.xpos = v.keys.map((_, i) => x.getPixelForValue(i));
      v.balken = !!(x.options && x.options.offset);
      v.spalte = v.xpos.length > 1 ? v.xpos[1] - v.xpos[0] : (v.rechts - v.links);
    }
    Object.values(c.scales).forEach(s => { if (s.axis === 'y') v.skalen[s.id] = { min: s.min, max: s.max }; });
    c.data.datasets.forEach(ds => {
      if (_istHilfslinienLabel(ds.label)) v.hl.push({ label: ds.label, wert: ds.data.find(w => w != null) });
    });
    try {
      const b = document.createElement('canvas');
      b.width = c.canvas.width; b.height = c.canvas.height;
      b.getContext('2d').drawImage(c.canvas, 0, 0);
      v.bild = b; v.faktor = c.canvas.width / c.width;
    } catch (_) {}
    delete c.$ohneHilfslinien;   // das Diagramm wird gleich ersetzt; der Merker darf nicht haengen bleiben
    m[id] = v;
  });
  return m;
}

// Zwei Arten:
//  - SPALTEN: Monats- oder Wochenspalten mit gemeinsamen Zeitraeumen vorher und
//    nachher. Ausgerichtet wird an der MITTLEREN gemeinsamen Spalte: bei Wochen hat ein
//    Fenster mal 13, mal 14 Spalten (Ruhepuls & HRV, VO2max bei 3M), dann sind die
//    Spalten minimal verschieden breit – so verteilt sich die Abweichung auf beide
//    Raender statt sich an einem zu sammeln. Mehr als eine Spalte Unterschied → GLEITEN.
//  - GLEITEN: alles andere, vor allem der Pace (Punkte je Training, deren Abstand sich
//    mit der Zahl der Trainings aendert). Der neue Stand kommt um die Breite EINES
//    Monats versetzt herein, ohne Ausblenden und ohne Streifen – y-Achse, Ø-Linie und
//    Beschriftungen gleiten aber genauso.
function _spaltenPlan(c, v, richtung, schritte = 1) {
  if (!c.scales.x) return null;
  const neu = c.$keys;
  let versatz = null;
  const streifen = [];
  if (v.keys && v.xpos && neu && (c.$keyTyp === 'monat' || c.$keyTyp === 'woche') &&
      c.$keyTyp === v.keyTyp && neu.length >= 2 && Math.abs(neu.length - v.keys.length) <= 1) {
    const geteilt = [];
    v.keys.forEach((k, i) => { const j = neu.indexOf(k); if (j >= 0) geteilt.push([i, j]); });
    if (geteilt.length) {
      // Bleibt ein Rand stehen (am Anfang oder Ende des Datenbestands waechst bzw.
      // schrumpft das Fenster nur auf einer Seite), wird an ihm ausgerichtet – sonst an
      // der Mitte.
      const n = geteilt.length;
      const anker = v.keys[0] === neu[0] ? 0
        : v.keys[v.keys.length - 1] === neu[neu.length - 1] ? n - 1
        : Math.floor(n / 2);
      const [im, jm] = geteilt[anker];
      versatz = v.xpos[im] - c.scales.x.getPixelForValue(jm);
      // Der Rand des Streifens: bei Balken die Mitte zwischen zwei Spalten, bei Linien
      // GENAU der erste bleibende Punkt – dort endet die Flaeche des neuen Diagramms.
      // Mit 4 px Abstand stand dort im Pixelvergleich eine weisse Haarlinie ohne Flaeche.
      const i0 = geteilt[0][0], i1 = geteilt[geteilt.length - 1][0];
      const rand = v.balken ? v.spalte / 2 : 0;
      if (i0 > 0) streifen.push([v.links, v.xpos[i0] - rand]);
      if (i1 < v.keys.length - 1) streifen.push([v.xpos[i1] + rand, v.rechts]);
    }
  }
  const monat = (c.chartArea.right - c.chartArea.left) / windowMonths();
  if (versatz == null) versatz = richtung * schritte * monat;
  const skalen = [];
  Object.values(c.scales).forEach(s => {
    if (s.axis !== 'y' || !v.skalen[s.id]) return;
    const von = v.skalen[s.id], nach = { min: s.min, max: s.max };
    if (Math.abs(von.min - nach.min) < 1e-9 && Math.abs(von.max - nach.max) < 1e-9) return;
    const raw = c.config.options.scales[s.id];
    if (!raw) return;
    skalen.push({ id: s.id, von, nach,
      hatMin: 'min' in raw, min: raw.min, hatMax: 'max' in raw, max: raw.max,
      hatIb: !!(raw.ticks && 'includeBounds' in raw.ticks), ib: raw.ticks && raw.ticks.includeBounds });
  });
  const linien = [];
  c.data.datasets.forEach(ds => {
    if (!_istHilfslinie(ds, 'oe')) return;
    const alt = v.hl.find(h => h.label === ds.label);
    const nach = ds.data.find(w => w != null);
    if (!alt || alt.wert == null || nach == null || alt.wert === nach) return;
    linien.push({ ds, von: alt.wert, nach, daten: ds.data });
  });
  if (Math.abs(versatz) < 0.5 && !skalen.length && !linien.length) return null;
  return { c, versatz, start: _zwischen(versatz + v.zug, versatz, monat / 2), streifen, skalen, linien,
           bild: v.bild, faktor: v.faktor };
}

// Ein Bild der Bewegung, e = 0 … 1.
function _spaltenSchritt(p, e) {
  const c = p.c;
  if (!c.$spalten || !c.canvas || !c.canvas.isConnected) return;
  c.$spalten.off = p.start * (1 - e);
  c.$spalten.delta = c.$spalten.off - p.versatz;
  if (!p.skalen.length && !p.linien.length) { try { c.draw(); } catch (_) {} return; }
  // Die Skalen-Objekte der Konfiguration werden bei JEDEM update() neu zusammengesetzt –
  // deshalb je Bild frisch holen, nicht einmal merken.
  p.skalen.forEach(s => {
    const raw = c.config.options.scales[s.id];
    if (!raw) return;
    raw.min = s.von.min + (s.nach.min - s.von.min) * e;
    raw.max = s.von.max + (s.nach.max - s.von.max) * e;
    if (raw.ticks) raw.ticks.includeBounds = false;
  });
  p.linien.forEach(l => { const w = l.von + (l.nach - l.von) * e; l.ds.data = l.daten.map(x => x == null ? x : w); });
  try { c.update('none'); } catch (_) {}
}

function _spaltenEnde(p) {
  const c = p.c;
  delete c.$spalten;
  if (!c.canvas || !c.canvas.isConnected) return;
  if (p.skalen.length || p.linien.length) {
    p.skalen.forEach(s => {
      const raw = c.config.options.scales[s.id];
      if (!raw) return;
      if (s.hatMin) raw.min = s.min; else delete raw.min;
      if (s.hatMax) raw.max = s.max; else delete raw.max;
      if (raw.ticks) { if (s.hatIb) raw.ticks.includeBounds = s.ib; else delete raw.ticks.includeBounds; }
    });
    p.linien.forEach(l => { l.ds.data = l.daten; });
    try { c.update('none'); } catch (_) {}
  } else { try { c.draw(); } catch (_) {} }
  if (_markierung) { try { _tooltipAnMarkierung(c); c.draw(); } catch (_) {} }
}

// Wie weit ragt der erste Monatsname im ENDSTAND links ueber die Zeichenflaeche? Bis
// dorthin duerfen die wandernden Namen sichtbar sein – weiter links nicht, sonst stuende
// ein hereinkommender Name schon unten in der Ecke neben der y-Achse, bevor sein Balken
// da ist. Schraege Beschriftungen (Wochen, Pace) ragen um ihre Breite × cos(Winkel).
function _labelLinks(c) {
  const x = c.scales.x, a = c.chartArea;
  try {
    const t = x.ticks && x.ticks[0];
    if (!t) return a.left;
    const ctx = c.ctx;
    ctx.save();
    ctx.font = '10px ' + (Chart.defaults.font.family || 'sans-serif');
    const w = Math.max(...[].concat(t.label).map(z => ctx.measureText(String(z)).width));
    ctx.restore();
    const px = x.getPixelForTick(0), rot = (x.labelRotation || 0) * Math.PI / 180;
    const links = rot ? px - w * Math.cos(rot) : px - w / 2;
    return Math.min(a.left, links - 2);
  } catch (_) { return a.left; }
}

// Die Monatsnamen wandern mit: `drawLabels` der x-Achse wird am Objekt ueberschrieben
// (Chart.js ruft es ueber `this.drawLabels`), die Achse bleibt bei jedem update()
// dieselbe Instanz. Ohne laufende Bewegung reicht es unveraendert durch.
function _xBeschriftungMitziehen(c) {
  const x = c.scales.x;
  if (!x || x.$spaltenHaken) return;
  const orig = x.drawLabels;
  x.drawLabels = function (bereich) {
    const s = c.$spalten;
    if (!s || !s.off) return orig.call(this, bereich);
    const ctx = c.ctx, a = c.chartArea;
    ctx.save();
    ctx.beginPath();
    const links = s.labelLinks != null ? s.labelLinks : a.left;
    ctx.rect(links, a.bottom, c.width - links, c.height - a.bottom);
    ctx.clip();
    ctx.translate(s.off, 0);
    orig.call(this, bereich);
    ctx.restore();
  };
  x.$spaltenHaken = true;
}

// Nach dem Neuaufbau: fuer jedes passende Diagramm die Bewegung anlegen, das erste Bild
// SOFORT zeichnen (sonst stuende fuer ein Bild der Endstand da) und dann laufen lassen.
// Rueckgabe: die Diagramme, um die sich `_animNavSlide` nicht mehr kuemmern soll.
function _spaltenStarten(vorher, richtung, schritte = 1) {
  const plaene = [];
  (tabCharts[currentScreen] || []).forEach(id => {
    const c = charts[id], v = vorher && vorher[id];
    if (!c || !v || !c.chartArea) return;
    const p = _spaltenPlan(c, v, richtung, schritte);
    if (p) plaene.push(p);
  });
  if (!plaene.length) return new Set();
  plaene.forEach(p => {
    _xBeschriftungMitziehen(p.c);
    p.c.$spalten = { off: p.start, delta: p.start - p.versatz, streifen: p.streifen, bild: p.bild, faktor: p.faktor,
                     labelLinks: _labelLinks(p.c) };
    _spaltenSchritt(p, 0);
  });
  const fertig = () => plaene.forEach(_spaltenEnde);
  const lauf = { fertig };
  lauf.stopp = uebergang(SPALTEN_DAUER, e => plaene.forEach(p => _spaltenSchritt(p, e)),
    () => { if (_spaltenLauf === lauf) _spaltenLauf = null; fertig(); });
  _spaltenLauf = lauf;
  return new Set(plaene.map(p => p.c));
}
// Eine laufende Bewegung sofort beenden (neuer Schritt, neue Geste): Endstand setzen.
function _spaltenAbbrechen() {
  const l = _spaltenLauf;
  if (!l) return;
  _spaltenLauf = null;
  l.stopp();
  l.fertig();
}

const spaltenPlugin = {
  id: 'spalten',
  // Messwerte ruecken seitlich, Hilfslinien (Ø, Ziel) nicht – sie gleiten senkrecht.
  beforeDatasetDraw(chart, args) {
    const s = chart.$spalten;
    if (!s || !s.off) return;
    const ds = chart.data.datasets[args.index];
    if (!ds || _istHilfslinienLabel(ds.label)) return;
    const a = chart.chartArea, ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(a.left - 5, 0, a.right - a.left + 10, a.bottom + 5);   // Randpunkte nicht halbieren
    ctx.clip();
    ctx.translate(s.off, 0);
    chart.$spaltenOffen = args.index;
  },
  afterDatasetDraw(chart, args) {
    if (chart.$spaltenOffen !== args.index) return;
    chart.$spaltenOffen = null;
    chart.ctx.restore();
  },
  // Der ausscheidende Monat als Ausschnitt des alten Bilds, samt Zahl und Monatsname.
  // UNTER den neuen Daten (vor den Datensaetzen): bei Linien beginnt der Streifen genau
  // am ersten bleibenden Punkt, dessen Kreis und Linienanschluss das neue Diagramm
  // darueber zeichnet.
  beforeDatasetsDraw(chart) {
    const s = chart.$spalten;
    if (!s || !s.bild || !s.streifen || !s.streifen.length) return;
    const a = chart.chartArea, ctx = chart.ctx, r = s.faktor || 1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(a.left, 0, a.right - a.left, chart.height);
    ctx.clip();
    s.streifen.forEach(([x1, x2]) => {
      if (x2 - x1 < 0.5) return;
      try { ctx.drawImage(s.bild, x1 * r, 0, (x2 - x1) * r, s.bild.height, x1 + s.delta, 0, x2 - x1, s.bild.height / r); } catch (_) {}
    });
    ctx.restore();
  },
  beforeTooltipDraw(chart) {
    const s = chart.$spalten;
    if (!s || !s.off) return;
    chart.ctx.save();
    chart.ctx.translate(s.off, 0);
    chart.$spaltenTooltip = true;
  },
  afterTooltipDraw(chart) {
    if (!chart.$spaltenTooltip) return;
    chart.$spaltenTooltip = false;
    chart.ctx.restore();
  }
};

// ── Hilfslinien (Ø, Ziel) werden nie seitlich verschoben ──────────────────────
// (auf Wunsch, 18.09.2026, gemeldet am Schlafdauer-Diagramm bei 3M: Ziel- und
// Ø-Linie wirkten beim Blaettern und Wischen „abgeschnitten und mitgezogen").
// Zwei Dinge:
//  - Die Verschiebung der Schiebe-Animation (`$navslide`, 7T/1M/YoY) wird fuer
//    Hilfslinien zurueckgenommen – sie stehen still, waehrend die Daten gleiten.
//    `$spalten` (Monatsbalken) laesst Hilfslinien ohnehin aus.
//  - `$ohneHilfslinien` laesst sie ganz weg – fuer die Momentaufnahme in
//    `_spaltenMerken`. Der hinausfahrende Streifen ist ein Ausschnitt dieses Bilds und
//    brachte vorher die alten Linienstuecke mit.
// Die LAENGE bleibt die von Chart.js (bei Balken von Spaltenmitte zu Spaltenmitte).
// Eine Fassung, die die Linien von Rand zu Rand zog, gab es am 18.09.2026 kurz – auf
// Wunsch zurueckgenommen.
// Das `return false` bei `$ohneHilfslinien` beendet die Kette fuer diesen Datensatz:
// spaeter registrierte Plugins (hilfslinienBlende, spaltenPlugin) kommen nicht dran,
// und ohne deren `before` gibt es auch kein unausgeglichenes save/restore. Deshalb
// MUSS dieses Plugin vor ihnen registriert sein.
const hilfslinienVoll = {
  id: 'hilfslinienVoll',
  beforeDatasetDraw(chart, args) {
    const ds = chart.data.datasets[args.index];
    if (!ds || !_istHilfslinienLabel(ds.label)) return;
    if (chart.$ohneHilfslinien) return false;
    if (chart.$navslideOn && chart.$navslide && chart.$navslide.offset) {
      chart.ctx.save();
      chart.ctx.translate(-chart.$navslide.offset, 0);
      chart.$hlZurueck = args.index;
    }
  },
  afterDatasetDraw(chart, args) {
    if (chart.$hlZurueck !== args.index) return;
    chart.$hlZurueck = null;
    chart.ctx.restore();
  }
};

// Reihenfolge zaehlt: hilfslinienVoll VOR hilfslinienBlende und spaltenPlugin – sein
// `return false` beendet die Kette fuer Hilfslinien (siehe dort).
Chart.register(wochentrennerPlugin, markierungPlugin, werteLabelPlugin, hilfslinienVoll, hilfslinienBlende, spaltenPlugin);

// Die FLAECHEN unter Linien (fill: true – HRV, Ruhepuls, Pace, VO2max, Score) zeichnet
// Chart.js' eingebautes Filler-Plugin selbst, in Chart.js 4.5 je Datensatz in seinem
// `beforeDatasetDraw` (drawTime-Standard) – und zwar VOR jedem Plugin dieser Datei,
// weil es zuerst registriert ist. Keine der Verschiebungen (`$spalten`, `$navslide`)
// erreichte sie deshalb: im ersten Bild stand die Flaeche schon am Endplatz, die Linie
// noch am alten (gesehen im Pixelvergleich, 18.09.2026). Bei der alten
// Schiebe-Animation verdeckte das Ausblenden den Fehler. Der Haken legt dieselbe
// Verschiebung um alle drei Zeichen-Zeitpunkte des Fillers – welcher greift, haengt an
// `drawTime`.
(function fuellungMitziehen() {
  const filler = Chart.registry && Chart.registry.getPlugin && Chart.registry.getPlugin('filler');
  if (!filler) return;
  ['beforeDraw', 'beforeDatasetsDraw', 'beforeDatasetDraw'].forEach(haken => {
    const orig = filler[haken];
    if (typeof orig !== 'function') return;
    filler[haken] = function (chart, args, opts) {
      const sp = chart.$spalten, ns = chart.$navslide;
      const off = sp ? sp.off : ns ? ns.offset : 0;
      if (!off && !(ns && ns.alpha < 1)) return orig.call(this, chart, args, opts);
      // Hilfslinien ruecken bei Monatsbalken nicht seitlich – ihre Flaeche (falls je
      // eine) auch nicht.
      if (sp && haken === 'beforeDatasetDraw' && args && args.meta) {
        const ds = chart.data.datasets[args.meta.index];
        if (ds && _istHilfslinienLabel(ds.label)) return orig.call(this, chart, args, opts);
      }
      const a = chart.chartArea, ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.rect(a.left, a.top, a.right - a.left, a.bottom - a.top);
      ctx.clip();
      ctx.translate(off, 0);
      if (!sp && ns) ctx.globalAlpha = ns.alpha;
      try { return orig.call(this, chart, args, opts); } finally { ctx.restore(); }
    };
  });
})();

function alleDiagrammeZerstoeren() {
  Object.values(charts).forEach(c => { try { c.destroy(); } catch(e){} });
  Object.keys(charts).forEach(k => delete charts[k]);
}
function zeichneDiagramm(id, cfg) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (charts[id]) { try { charts[id].destroy(); } catch(e){} }
  cfg.options = cfg.options || {};
  // Ohne Aufbau-Animation bauen: während einer Pfeil-Navigation (die seitliche
  // Bewegung übernimmt _animNavSlide) und wo sich die Daten nicht ändern
  // (Hilfslinie, Ausklappen – siehe _ruhigRendern).
  if (_navSliding || (_ruhigeIds && _ruhigeIds.has(id))) cfg.options.animation = false;
  // Platz fuer die Datenbeschriftungen ueber dem hoechsten Balken (siehe LABEL_LUFT).
  // An EINER Stelle fuer alle Diagramme: jedes einzeln zu bedenken hiesse, dass das
  // naechste neue Diagramm es wieder vergisst. Kein Diagramm setzt `layout` selbst.
  if (cfg.__werteFmt) {
    cfg.options.layout = cfg.options.layout || {};
    cfg.options.layout.padding = Object.assign({ top: LABEL_LUFT }, cfg.options.layout.padding);
  }
  charts[id] = new Chart(el, cfg);
  // Zeitraum-Schlüssel am Chart hinterlegen (siehe Kern-Block oben) und den Tipp
  // verkabeln. Ohne __keys bleibt ein Diagramm von Wochentrenner und Markierung
  // unberührt – so lassen sich einzelne Diagramme bewusst ausnehmen.
  charts[id].$keys   = cfg.__keys   || null;
  charts[id].$keyTyp = cfg.__keyTyp || null;
  // Ohne __werteFmt bleibt ein Diagramm unbeschriftet – so lassen sich einzelne
  // bewusst ausnehmen, genau wie bei __keys.
  charts[id].$werteFmt = cfg.__werteFmt || null;
  charts[id].$nurQuer  = !!cfg.__werteNurQuer;
  charts[id].$werteAus = !!cfg.__werteAusStandard;
  // OHNE Aufbau-Animation zeichnet Chart.js schon im Konstruktor – also BEVOR die
  // Angaben oben am Diagramm haengen. Das erste Bild fehlte dann alles, was an ihnen
  // haengt: Datenbeschriftungen ($werteFmt) und Wochentrenner ($keys). Mit Animation
  // faellt es nicht auf, das erste Bild kommt erst im naechsten Frame. Gesehen beim
  // Ausklappen und beim Hilfslinien-Schalter (beide ueber `_ruhigRendern`, 18.09.2026);
  // beim Blaettern ueberdeckte es die `navslide`-Animation, die ohnehin neu zeichnet.
  if (cfg.options.animation === false) { try { charts[id].draw(); } catch(_) {} }
  if (charts[id].$keys) {
    el.addEventListener('click', e => _chartTipp(charts[id], e));
    el.style.cursor = 'pointer';
    // Beim Neuaufbau (Filter- oder Tabwechsel) die bestehende Markierung samt
    // Tooltip wieder herstellen – sonst verschwände sie beim ersten Re-Render.
    if (_markierung) { try { _tooltipAnMarkierung(charts[id]); charts[id].draw(); } catch(_) {} }
  }
  // Frisch eingeschaltete Hilfslinie einblenden (siehe _hlEinblenden).
  if (_hlPlan && _hlPlan.id === id) { const plan = _hlPlan; _hlPlan = null; _hlEinblenden(charts[id], plan.art); }
  // Track chart per tab (for per-tab destroy on re-render)
  if (_currentRenderingTab && tabCharts[_currentRenderingTab]) {
    tabCharts[_currentRenderingTab].push(id);
  }
  return charts[id];
}
// ═══════════════════════════════════════════════════════════
// Tooltips – bedienbar per Maus UND per Fingertipp
// ═══════════════════════════════════════════════════════════
// Vorher hingen alle Detail-Einblendungen an Maus-Ereignissen (mouseover bzw.
// CSS :hover). Auf dem iPhone – der Hauptplattform dieser App – gibt es keinen
// schwebenden Zeiger, damit war rund die Hälfte der Detailinformationen praktisch
// unerreichbar. Jetzt: Antippen öffnet, erneutes Antippen oder ein Tipp daneben
// schliesst; auf dem Desktop funktioniert Hover unverändert weiter.
//
// Zwei Bauarten, die absichtlich verschieden bleiben:
//   .debt-tt-wrap      → Tooltip-Element im DOM, wird frei positioniert
//   .info-i            → Erklärungskasten als .info-tt-Element im Anker
const TT_TAP_SELECTOR = '.debt-tt-wrap, .info-i';

// Positioniert ein frei schwebendes Tooltip-Element über (oder unter) seinem Anker.
function _placeTooltip(tt, rect, fallbackW, fallbackH) {
  const PAD = 12;
  const ttW = tt.offsetWidth  || fallbackW;
  const ttH = tt.offsetHeight || fallbackH;
  let top  = rect.top - ttH - 10;
  let left = rect.left + rect.width / 2 - ttW / 2;
  left = Math.max(PAD, Math.min(left, window.innerWidth - ttW - PAD));
  if (top < PAD) top = rect.bottom + 10;          // kein Platz oben → darunter
  tt.style.top  = top + 'px';
  tt.style.left = left + 'px';
  // Pfeil zeigt weiterhin auf die Mitte des Ankers, auch wenn das Tooltip verschoben wurde
  const arrowLeft = (rect.left + rect.width / 2) - left;
  tt.style.setProperty('--arrow-left', Math.max(10, Math.min(arrowLeft, ttW - 10)) + 'px');
}

// ── Öffnen / Schliessen ──
let _ttOpenEl = null;
function closeTooltips() {
  document.querySelectorAll('.debt-tt.visible').forEach(t => t.classList.remove('visible'));
  document.querySelectorAll('.tt-open').forEach(el => el.classList.remove('tt-open'));
  _ttOpenEl = null;
}
function openTooltip(el) {
  if (_ttOpenEl === el) { closeTooltips(); return; }   // erneuter Tipp = schliessen
  closeTooltips();
  _ttOpenEl = el;
  const rect = el.getBoundingClientRect();
  if (el.classList.contains('debt-tt-wrap')) {
    const tt = el.querySelector('.debt-tt');
    if (!tt) { _ttOpenEl = null; return; }
    _placeTooltip(tt, rect, 270, 220);
    tt.classList.add('visible');
  } else if (el.classList.contains('info-i')) {
    // Am Bildschirmrand einklemmen: ein ⓘ ganz links oder rechts auf einer schmalen
    // Karte liesse einen mittig zentrierten Kasten aus dem Bild ragen.
    const tt = el.querySelector('.info-tt');
    if (!tt) { _ttOpenEl = null; return; }
    el.classList.add('tt-open');                        // erst sichtbar, dann messen
    _placeTooltip(tt, rect, 220, 110);
  }
}

// Maus: unverändertes Hover-Verhalten (Desktop)
document.addEventListener('mouseover', e => {
  const el = e.target.closest(TT_TAP_SELECTOR);
  if (el) openTooltip(el);
});
document.addEventListener('mouseout', e => {
  const el = e.target.closest(TT_TAP_SELECTOR);
  if (!el || el.contains(e.relatedTarget)) return;
  closeTooltips();
});
// Finger/Klick: öffnen, erneut tippen schliesst, danebentippen schliesst ebenfalls
document.addEventListener('click', e => {
  const el = e.target.closest(TT_TAP_SELECTOR);
  if (el) { e.stopPropagation(); openTooltip(el); }
  else closeTooltips();
});
// Tastaturbedienung für dieselben Elemente
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeTooltips(); return; }
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest && e.target.closest(TT_TAP_SELECTOR);
  if (el) { e.preventDefault(); openTooltip(el); }
});
// Beim Scrollen schliessen – ein fix positioniertes Tooltip würde sonst danebenstehen
window.addEventListener('scroll', () => { if (_ttOpenEl) closeTooltips(); }, true);

// Nur waagrechte Gitterlinien: die senkrechten trennten lediglich die Kategorien,
// die ohnehin durch die Achsenbeschriftung getrennt sind.
const achseX = {grid:{display:false},ticks:{color:'#94A3B8',font:{size:10}}};
const achseY = {grid:{color:GRID_COLOR},ticks:{color:'#94A3B8',font:{size:10}}};

// ═══════════════════════════════════════════════════════════
// Zielwerte – EINE Quelle für alle Soll/Ist-Vergleiche
// ═══════════════════════════════════════════════════════════
// Vorher lagen Schwellen an acht Stellen verstreut, teils widersprüchlich
// (drei verschiedene Schlafgrenzen, zwei verschiedene Ruhepuls-Einteilungen).
// Wer etwas ändern will, ändert es ab jetzt hier – und nur hier.
//
//   richtung: 'hoch' = mehr ist besser, 'tief' = weniger ist besser
//   fmt:      Anzeigeform des Werts (für Ziel-Beschriftungen und Statuszeile)
const ZIELE = {
  sleepTotal: { label:'Schlaf',       ziel:7.5,   richtung:'hoch', fmt:v=>alsStdMin(v) },
  restHR:     { label:'Ruhepuls',     ziel:60,    richtung:'tief', fmt:v=>Math.round(v)+' bpm' },
  hrv:        { label:'HRV',          ziel:50,    richtung:'hoch', fmt:v=>Math.round(v)+' ms' },
  trainDays:  { label:'Trainingstage',ziel:3,     richtung:'hoch', fmt:v=>v+' / Woche' },
  vo2max:     { label:'VO₂max',       ziel:45,    richtung:'hoch', fmt:v=>zahl(v,1) }
};
// Erfüllt der Wert das Ziel? null, wenn kein Wert vorliegt.
function zielErfuellt(key, wert) {
  const z = ZIELE[key];
  if (!z || wert == null) return null;
  return z.richtung === 'hoch' ? wert >= z.ziel : wert <= z.ziel;
}
// Tooltip-Filter: Hilfslinien (Ø-Linie, Ziellinie) sind Orientierung, keine Messwerte –
// sie gehören nicht in die Werteliste beim Antippen eines Datenpunkts.
const nurMesswerte = item => !_istHilfslinienLabel(item.dataset.label);

// ── Ein-/ausblendbare Hilfslinien (Ø, Ziel) ─────────────────────────────────
// Der Zustand liegt AUSSERHALB der Seitenfunktionen, sonst waere er nach jedem
// Neuaufbau des Tabs zurueckgesetzt. Fehlender Eintrag heisst "an".
// Schluessel ist '<canvas-id>|<art>' mit art = 'oe' oder 'ziel'. Ein Diagramm kann
// beide haben (Schlafdauer, VO2max), und zwei Diagramme duerfen sich nicht
// gegenseitig schalten – deshalb die Canvas-ID im Schluessel.
const _hilfslinie = {};
function hlAn(schluessel) { return _hilfslinie[schluessel] !== false; }

// Legendeneintrag zum Ein-/Ausschalten. Ein <button>, damit der Tipp auf den
// Kartenhintergrund die Bottom-Nav nicht mitschaltet.
function hlLegende(schluessel, text, farbe, gestrichelt = true) {
  const an = hlAn(schluessel);
  return `<button type="button" class="cl-item hl-schalter${an?'':' aus'}" data-hl="${schluessel}"
    aria-pressed="${an?'true':'false'}" title="Linie ein-/ausblenden"><span
    class="cl-line${gestrichelt?' cl-strich':''}" style="${gestrichelt?'color':'background'}:${farbe}"></span>${text}</button>`;
}

// Der Datensatz selbst. Das Label 'Ø' ist kein Zufall: `nurMesswerte` haelt damit
// sowohl den Tooltip als auch die Datenbeschriftungen von der Linie fern.
// Rueckgabe ist ein ARRAY, damit der Aufrufer es mit `...` einsetzen kann und der
// ausgeschaltete Fall keinen `null`-Eintrag im Datensatz-Array hinterlaesst.
function oeDatensatz(schluessel, wert, farbe, laenge, achse) {
  if (!hlAn(schluessel) || wert == null) return [];
  return [{ label:'Ø', data:new Array(laenge).fill(wert), borderColor:farbe,
    borderDash:[5,4], borderWidth:1.5, pointRadius:0, tension:0, fill:false,
    type:'line', spanGaps:true, ...(achse?{yAxisID:achse}:{}) }];
}

// Ziellinie, aber nur wenn eingeblendet. Liefert wie oeDatensatz ein ARRAY, damit der
// Aufrufer es mit `...` einsetzen kann.
function zielDatensatz(schluessel, key, laenge, achse) {
  if (!hlAn(schluessel)) return [];
  const z = zielLinie(key, laenge, achse);
  return z ? [z] : [];
}

// Gestrichelte Ziellinie als zusätzlicher Chart-Datensatz.
function zielLinie(key, laenge, achse) {
  const z = ZIELE[key];
  if (!z) return null;
  return {
    label: 'Ziel ' + z.label,
    data: new Array(laenge).fill(z.ziel),
    borderColor: 'rgba(100,116,139,.55)', borderDash:[3,3], borderWidth:1.5,
    pointRadius:0, tension:0, fill:false, type:'line', spanGaps:true,
    ...(achse ? { yAxisID: achse } : {})
  };
}

// ── Ziele der Übersicht: Ringe (letzter Tag) und Wochenbilanz (auf Wunsch, 30.09.2026)
// Ersetzt die frühere weisse Ziel-Karte: sie wiederholte drei Kachelwerte und passte
// optisch nicht zu den Kacheln. Die RINGE stehen über den Kacheln und zeigen, wie nah
// der letzte Tag am Ziel ist; die WOCHENBILANZ darunter zeigt je Ziel die letzten
// Tage der AKTUELLEN Kalenderwoche (Mo–So) als Punkte. Beide lesen ZIELE und
// zielErfuellt – keine eigenen Schwellen.
// Trainingstage: ein Tag mit mindestens einer Einheit im Workout-Blatt
// (durationMin > 0) – dieselbe Regel wie überall in der App.
// Montag bis Sonntag der laufenden Woche (nach dem heutigen Datum, nicht dem neuesten
// Datentag – „diese Woche" soll auch dann stimmen, wenn der Export einen Tag hinterher
// ist). Tage nach heute gibt es darin auch; sie haben noch keinen Wert.
function aktuelleWoche() {
  const mo = getWeekMonday(toLocalDateStr(new Date()));
  return Array.from({ length: 7 }, (_, i) => addDays(mo, i));
}
// Die Woche der Wochenbilanz: im Zeitfilter 7T die angezeigte Woche (die Pfeile ‹ ›
// blättern sie mit, auf Wunsch 30.09.2026), in allen anderen Bereichen die laufende.
function bilanzWoche() { return is7D() && referenceDate ? weekDays7() : aktuelleWoche(); }
function istTrainingstag(d) { return workoutData[d]?.durationMin > 0; }

// ── Gewählter Tag der Wochenbilanz (auf Wunsch, 30.09.2026) ─────────────────
// Ein Tipp auf eine Tagesspalte der Wochenbilanz wählt den Tag; die Ringe zeigen dann
// seine Werte. Ohne Auswahl (null) gilt der heutige Tag – liegt für heute noch kein
// Export vor, der neueste Datentag, sonst stünden morgens nur „—" in den Ringen.
// Gemerkt wird der WOCHENTAG (0 = Mo … 6 = So), nicht das Datum: beim Blättern der
// Woche bleibt er stehen (auf Wunsch, 30.09.2026). „Heute" setzt ihn zurück.
let _bilanzWochentag = null;
function standardTag() {
  const heute = toLocalDateStr(new Date());
  const letzter = allData.length ? allData[allData.length - 1].date : heute;
  return letzter < heute ? letzter : heute;
}
function wochentagIndex(ds) { return (new Date(ds + 'T00:00:00').getDay() + 6) % 7; }
// Der gewählte Tag in der Woche `tage`. Läge er in der Zukunft (Sonntag gewählt, zurück
// in der laufenden Woche), gilt der Standardtag.
function gewaehlterTag(tage) {
  const std = standardTag();
  const d = tage[_bilanzWochentag ?? wochentagIndex(std)];
  return d > toLocalDateStr(new Date()) ? std : d;
}
function wocheVon(ds) { const mo = getWeekMonday(ds); return Array.from({ length: 7 }, (_, i) => addDays(mo, i)); }

// Beide Teile zusammen – auch für den Neuaufbau nach einem Tipp auf einen Tag, ohne
// dass die ganze Übersicht (samt Diagramm und Einblicken) neu entsteht.
function ovObenHTML() {
  if (!allData.length) return '';
  const tage = bilanzWoche(), tag = gewaehlterTag(tage);
  return `<div class="ov-oben">${zielWocheHTML(tage, tag)}${zielRingeHTML(tag)}</div>`;
}
function ovObenNeu() {
  const el = document.querySelector('#screen-overview .ov-oben');
  if (!el) return;
  const vorher = ovObenMerken();
  el.outerHTML = ovObenHTML();
  ovObenAnimieren(vorher);
}

// ── Animation der Wochenbilanz und der Ringe (auf Wunsch, 30.09.2026) ──────────
// Zwei Vorgänge: WOCHE wechseln (Pfeile/Wisch bei 7T, Bereichswechsel) → die Punkte
// gleiten spaltenweise aus der Richtung herein, aus der die Woche kommt; TAG wählen →
// die helle Fläche gleitet von der alten Spalte zur neuen. In beiden Fällen laufen
// die Ringe von ihrem alten Stand auf den neuen (Füllung und Zahl) und der Titel
// blendet über. Vorher/nachher wird am DOM gemessen: `ovObenMerken()` VOR dem
// Neuaufbau, `ovObenAnimieren()` danach – so braucht keiner der Auslöser (Tipp,
// Blättern, Neuaufbau der Übersicht) eigenen Code.
const OV_DAUER = 260;
function ovObenMerken() {
  const ob = document.querySelector('#screen-overview .ov-oben');
  if (!ob) return null;
  const mark = ob.querySelector('.zw-spalte.gewaehlt');
  return {
    woche: ob.querySelector('.ziel-woche')?.dataset.woche,
    tag: mark?.dataset.tag,
    markLinks: mark ? mark.getBoundingClientRect().left : null,
    ringe: [...ob.querySelectorAll('.zr')].map(z => ({
      anteil: Number(z.querySelector('.zr-fuell')?.dataset.anteil || 0),
      wert: z.querySelector('.ti-zahl') ? Number(z.querySelector('.ti-zahl').dataset.wert) : null
    }))
  };
}
// WAAPI mit Rückfall: eine nicht gezeichnete Seite hielte sonst das erste Bild fest
// (Deckkraft 0) – dieselbe Falle wie bei `_ausklappAnimieren`.
function _ovAnim(el, frames, opt) {
  if (!el.animate) return;
  const a = el.animate(frames, opt);
  setTimeout(() => { try { if (a.playState !== 'finished') a.finish(); } catch (_) {} }, (opt.delay || 0) + opt.duration + 120);
}
function ovObenAnimieren(vorher) {
  const ob = document.querySelector('#screen-overview .ov-oben');
  if (!vorher || !ob || bewegungAus() || currentScreen !== 'overview') return;
  const woche = ob.querySelector('.ziel-woche')?.dataset.woche;
  const mark = ob.querySelector('.zw-spalte.gewaehlt');
  const tag = mark?.dataset.tag;
  const easing = 'cubic-bezier(.22,.8,.3,1)';
  if (woche && vorher.woche && woche !== vorher.woche) {
    // Neuere Woche kommt von rechts, ältere von links – wie beim Blättern der Diagramme.
    const r = woche > vorher.woche ? 1 : -1;
    ob.querySelectorAll('.zw-punkt').forEach((el, i) => _ovAnim(el,
      [{ transform: `translateX(${r * 18}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: OV_DAUER, delay: (r > 0 ? i % 7 : 6 - i % 7) * 18, easing, fill: 'backwards' }));
    ob.querySelectorAll('.zw-zahl, .zw-rechts').forEach(el => _ovAnim(el,
      [{ opacity: 0 }, { opacity: 1 }], { duration: OV_DAUER, easing }));
  }
  if (mark && vorher.markLinks != null) {
    const dx = vorher.markLinks - mark.getBoundingClientRect().left;
    if (Math.abs(dx) > .5) _ovAnim(mark, [{ transform: `translateX(${dx}px)` }, { transform: 'none' }],
      { duration: OV_DAUER, easing });
  } else if (mark) {
    _ovAnim(mark, [{ opacity: 0 }, { opacity: 1 }], { duration: OV_DAUER, easing });
  }
  if (tag === vorher.tag) return;
  const titel = ob.querySelector('.zr-titel');
  if (titel) _ovAnim(titel, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }],
    { duration: OV_DAUER, easing });
  // Ringe: Füllung und Zahl vom alten auf den neuen Stand.
  const U = 2 * Math.PI * 44;
  const laeufe = [...ob.querySelectorAll('.zr')].map((z, i) => {
    const alt = vorher.ringe[i] || {};
    const kreis = z.querySelector('.zr-fuell'), zahl = z.querySelector('.ti-zahl');
    const l = { kreis, zahl, von: alt.anteil || 0, bis: kreis ? Number(kreis.dataset.anteil) : 0 };
    if (zahl) {
      l.wVon = alt.wert; l.wBis = Number(zahl.dataset.wert); l.form = zahl.dataset.form;
      _kachelZuletzt[zahl.dataset.feld] = l.wBis;
    }
    return l;
  });
  const fmt = (v, form) => form === 'std' ? alsStdMin(Math.round(v * 60) / 60) : String(Math.round(v));
  const schritt = e => laeufe.forEach(l => {
    if (l.kreis && l.kreis.isConnected)
      l.kreis.setAttribute('stroke-dasharray', `${((l.von + (l.bis - l.von) * e) * U).toFixed(1)} ${U.toFixed(1)}`);
    if (l.zahl && l.zahl.isConnected && l.wVon != null && isFinite(l.wVon) && isFinite(l.wBis))
      l.zahl.textContent = fmt(l.wVon + (l.wBis - l.wVon) * e, l.form);
  });
  schritt(0);
  uebergang(OV_DAUER + 120, schritt);
}

// Anteil 0..1 am Ziel. Bei „weniger ist besser" (Ruhepuls): erreicht = voll, sonst
// Ziel ÷ Wert (66 bpm bei Ziel 60 → 91 %).
function zielAnteil(key, wert) {
  const z = ZIELE[key];
  if (wert == null || !z) return null;
  if (zielErfuellt(key, wert)) return 1;
  return Math.max(0, Math.min(1, z.richtung === 'hoch' ? wert / z.ziel : z.ziel / wert));
}

// Die Ringe ersetzen seit 30.09.2026 die Minikacheln (auf Wunsch): in der Mitte der
// Tageswert (zählt wie früher die Kachelzahl hoch, `kachelZahl`), darunter Name und
// Zielzeile. Ein Tipp wischt in den Tab der Kennzahl (`zuTabWischen`).
const ZIEL_RINGE = [
  { key: 'restHR',     name: 'Ruhepuls', farbe: '#F87171', tab: 'herz',     feld: 'hr',   einheit: 'bpm',
    zielText: () => `Ziel ≤ ${ZIELE.restHR.ziel}` },
  { key: 'hrv',        name: 'HRV',      farbe: '#60A5FA', tab: 'herz',     feld: 'hv',   einheit: 'ms',
    zielText: () => `Ziel ≥ ${ZIELE.hrv.ziel}` },
  { key: 'sleepTotal', name: 'Schlaf',   farbe: '#A78BFA', tab: 'schlaf',   feld: 'sl',   einheit: '', form: 'std',
    zielText: v => zielErfuellt('sleepTotal', v) ? `Ziel ${alsStdMin(ZIELE.sleepTotal.ziel)}`
      : `${alsStdMin(ZIELE.sleepTotal.ziel - v).replace(/^0h 0?/, '')} unter Ziel` },
  { key: 'trainDays',  name: 'Training', farbe: '#FB923C', tab: 'training', feld: 'tage', einheit: `/ ${ZIELE.trainDays.ziel} Tage`,
    zielText: (v, tag) => getWeekMonday(tag) === getWeekMonday(toLocalDateStr(new Date())) ? 'diese Woche' : 'KW ' + isoKW(tag) }
];

// `tag`: der gewählte Tag (Werte von Ruhepuls, HRV, Schlaf); Training zählt die
// Trainingstage seiner Kalenderwoche. Der Titel nennt den Tag, dessen Werte gezeigt werden.
function zielRingeHTML(tag) {
  const zeile = allData.find(r => r.date === tag) || {};
  const werte = {
    restHR: zeile.restHR, hrv: zeile.hrv, sleepTotal: zeile.sleepTotal,
    trainDays: wocheVon(tag).filter(istTrainingstag).length
  };
  const U = 2 * Math.PI * 44;   // Umfang des Rings (r = 44 im 100er-Raster)
  const titel = `${WOCHENTAG_LANG[new Date(tag + 'T00:00:00').getDay()]}, ${tag.slice(8, 10)}.${tag.slice(5, 7)}.${tag.slice(0, 4)}`;
  return `<div class="ziel-ringe"><h3 class="zr-titel">${titel}</h3>${ZIEL_RINGE.map(r => {
    const v = werte[r.key], anteil = zielAnteil(r.key, v), ok = zielErfuellt(r.key, v);
    // Ohne Messwert kein Sprung in den Tab – ein Tipp auf eine leere Stelle soll nicht
    // überraschend wechseln (wie früher bei den leeren Kacheln).
    const ziel = v == null ? '' :
      ` data-ziel-tab="${r.tab}" role="button" tabindex="0" aria-label="${r.name}: ${r.form === 'std' ? alsStdMin(v) : Math.round(v)} ${r.einheit}, Ziel ${ok ? 'erreicht' : 'nicht erreicht'} – zum Tab ${TAB_TITEL[r.tab]}"`;
    return `<div class="zr"${ziel}>
      <div class="zr-ring">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="44" class="zr-spur"/>
          ${anteil ? `<circle cx="50" cy="50" r="44" class="zr-fuell" data-anteil="${anteil}" stroke="${r.farbe}"
            stroke-dasharray="${(anteil * U).toFixed(1)} ${U.toFixed(1)}" transform="rotate(-90 50 50)"/>` : ''}
        </svg>
        <div class="zr-mitte">
          <span class="zr-zahl${r.form === 'std' ? ' lang' : ''}">${v == null ? '—' : kachelZahl(r.feld, v, r.form)}</span>
          ${v != null && r.einheit ? `<span class="zr-einheit">${r.einheit}</span>` : ''}
        </div>
      </div>
      <div class="zr-name">${r.name}</div>
      <div class="zr-wert ${v == null ? '' : ok ? 'ok' : 'nein'}">${v == null ? '—' : (ok ? '✓ ' : '') + r.zielText(v, tag)}</div>
    </div>`;
  }).join('')}</div>`;
}

// Wochenbilanz: je Ziel sieben Punkte (Mo … So, siehe bilanzWoche), gefüllt = Ziel
// erreicht bzw. beim Training: an diesem Tag trainiert. Hohler Punkt = verfehlt,
// blasser Punkt = kein Messwert (auch: Tag liegt noch in der Zukunft). Rechts die Zahl erreichter Tage von denen mit Messwert; beim Training
// die Trainingstage gegen das Wochenziel.
// `tage`: die sieben Tage der angezeigten Woche; `tag`: der gewählte Tag (Spalte
// hervorgehoben). Jede Spalte bis heute ist antippbar (`data-tag`); künftige nicht.
function zielWocheHTML(tage, tag) {
  const heute = toLocalDateStr(new Date());
  const byDate = {}; allData.forEach(r => { byDate[r.date] = r; });
  // EIN Raster für Kopf und alle Zeilen: Name | 7 Tage | Zahl. Dahinter liegt ein
  // zweites Raster mit denselben Spalten (`.zw-spalten`): je Tag eine Fläche über alle
  // Zeilen – die Tippfläche (auch zwischen den Punkten) und die Hervorhebung des
  // gewählten Tags. Im selben Raster verdrängten die Flächen die übrigen Zellen.
  const spalten = tage.map((d, i) => d > heute
    ? `<span class="zw-spalte zukunft" style="grid-column:${i + 2}"></span>`
    : `<span class="zw-spalte${d === tag ? ' gewaehlt' : ''}" style="grid-column:${i + 2}" data-tag="${d}" role="button" tabindex="0"` +
      ` aria-label="${WOCHENTAG_LANG[new Date(d + 'T00:00:00').getDay()]}, ${fmtWeek(d)} anzeigen"${d === tag ? ' aria-pressed="true"' : ''}></span>`).join('');
  const punkte = zustaende => zustaende.map((z, i) => `<span class="zw-punkt${tage[i] === tag ? ' gewaehlt' : ''}"><i class="${z}"></i></span>`).join('');
  const zeile = (name, zustaende, zahl, farbe) =>
    `<span class="zw-name">${name}</span>${punkte(zustaende)}` +
    `<b class="zw-zahl"${farbe ? ` style="color:${farbe}"` : ''}>${zahl}</b>`;
  const messZeile = (key, name) => {
    const z = tage.map(d => { const v = byDate[d]?.[key]; return v == null ? 'leer' : zielErfuellt(key, v) ? 'an' : 'aus'; });
    const mit = z.filter(x => x !== 'leer').length;
    return zeile(name, z, mit ? `${z.filter(x => x === 'an').length}/${mit}` : '—');
  };
  const training = tage.map(d => istTrainingstag(d) ? 'an' : d > heute ? 'leer' : 'aus');
  const nTraining = training.filter(x => x === 'an').length;
  // Wie viele Wochen liegt die angezeigte vor der laufenden?
  const vor = Math.round((new Date(getWeekMonday(heute) + 'T00:00:00') - new Date(tage[0] + 'T00:00:00')) / 86400000 / 7);
  const kopfTage = tage.map(d => `<span class="zw-tag${d === tag ? ' gewaehlt' : ''}">${wochentagKurz(d)}</span>`).join('');
  return `<div class="ziel-woche" data-woche="${tage[0]}">
    <div class="zw-kopf"><h3>Ziele</h3><span class="zw-rechts">${vor > 0 ? `<span class="zw-vor">vor ${vor} ${vor === 1 ? 'Woche' : 'Wochen'}</span>` : ''}${scopeBadge('KW ' + isoKW(tage[0]))}</span></div>
    <div class="zw-raster"><div class="zw-spalten">${spalten}</div>
      <span class="zw-name"></span>${kopfTage}<b class="zw-zahl"></b>
      ${messZeile('restHR', 'Ruhepuls')}
      ${messZeile('hrv', 'HRV')}
      ${messZeile('sleepTotal', 'Schlaf')}
      ${zeile('Training', training, `${nTraining}/${ZIELE.trainDays.ziel}`,
        zielErfuellt('trainDays', nTraining) ? 'var(--zw-gut)' : 'var(--zw-offen)')}
    </div>
  </div>`;
}

// ── Kurzerklärungen zu den Kennzahlen ──────────────────
// Jede Erklärung beantwortet zwei Fragen: Was ist das, und welche Richtung ist gut?
// Ohne die zweite Angabe lässt sich keine Farbe und kein Pfeil deuten.
const ERKLAERUNG = {
  sleepTotal: 'Tatsächlich geschlafene Zeit pro Nacht (ohne Wachliegen). Mehr ist besser, bis etwa 9 Stunden.',
  restHR:     'Ruhepuls: Herzschläge pro Minute in völliger Ruhe. Weniger ist besser – ein sinkender Ruhepuls zeigt wachsende Ausdauer.',
  hrv:        'Herzratenvariabilität: Schwankung der Abstände zwischen zwei Herzschlägen. Mehr ist besser – hohe Werte stehen für gute Erholung.',
  trainDays:  'Tage mit einem Eintrag im Workout-Sheet, gezählt über die letzten sieben Tage.',
  vo2max:     'VO₂max: geschätzte maximale Sauerstoffaufnahme – das gängigste Mass für Ausdauerleistung. Mehr ist besser.',
  pace:       'Pace: benötigte Zeit pro Kilometer. Weniger ist besser (schneller).',
  baseline:   'Baseline: dein eigener Durchschnitt der letzten 30 Tage. Verglichen wird also mit dir selbst, nicht mit Richtwerten.'
};
// Antippbares Fragezeichen. Der Text steckt als eigenes Element im Anker, damit ihn
// openTooltip am Bildschirmrand verschieben kann – ein reiner CSS-Tooltip würde auf
// schmalen Karten links und rechts aus dem Bild ragen.
function _infoAnker(text) {
  return text
    ? `<span class="info-i" tabindex="0" role="button" aria-label="Erklärung">i<span class="info-tt">${esc(text)}</span></span>`
    : '';
}
function infoI(key)     { return _infoAnker(ERKLAERUNG[key]); }

// ─────────────────────────────────────────────────────────
// ── Coaching Helpers ───────────────────────────────────
// ─────────────────────────────────────────────────────────

// Mittelwert eines Felds über die letzten N Tage von allData (memoisiert)
function calculateBaseline(field, nDays) {
  return _memo('baseline:'+field+':'+nDays, () => mittel(allData.slice(-nDays), field));
}

// % deviation of current from baseline (positive = above baseline)
function calculateDeviation(current, baseline) {
  if (current == null || baseline == null || baseline === 0) return null;
  return ((current - baseline) / baseline) * 100;
}

// Schlafschuld: Ziel minus tatsächlicher Schlaf, in Stunden.
const SLEEP_TARGET_H = ZIELE.sleepTotal.ziel;
// Bezugsgröße ist durchgehend das übergebene Fenster (aktuell: 14 Nächte).
// `perNight` ist der eigentliche Kennwert – die Summe allein sagt nichts aus,
// solange die Anzahl der Nächte nicht dabei steht.
function calculateSleepDebt(rows) {
  const debts = rows.map(r => r.sleepTotal != null ? SLEEP_TARGET_H - r.sleepTotal : null).filter(v => v != null);
  if (!debts.length) return { last: null, total: null, perNight: null, nDays: 0 };
  const total = debts.reduce((s,v) => s+v, 0);
  return { last: debts[debts.length-1], total, perNight: total/debts.length, nDays: debts.length };
}
// Balken/Ampel richten sich nach dem Ø-Defizit pro Nacht, nicht nach der Summe:
// eine Summe wächst allein durch mehr Nächte und war deshalb praktisch immer rot.
const SLEEP_DEBT_FULL_BAR_H = 1.0; // Ø 1h zu wenig pro Nacht = Balken voll
function sleepDebtLevel(perNight) {
  if (perNight == null)   return { color:'#94A3B8', label:'Keine Daten' };
  if (perNight >= 0.75)   return { color:'#EF4444', label:'Deutliches Defizit' };
  if (perNight >= 0.33)   return { color:'#F97316', label:'Leichtes Defizit' };
  if (perNight > 0)       return { color:'#84CC16', label:'Nahe am Ziel' };
  return                         { color:'#10B981', label:'Ziel erreicht' };
}

// ── Schwellen für Belastungswarnung und Herz-Kreislauf-Einordnung ─────────
// Abweichung vom eigenen 30-Tage-Schnitt in Prozent bzw. Schlaf in Stunden.
const COACHING_THRESHOLDS = {
  hvDevGood:     5,   // HRV >5% über Baseline → gutes Zeichen
  hvDevBad:     -10,  // HRV >10% unter Baseline → Belastung
  hrDevGood:    -3,   // Ruhepuls >3% unter Baseline → gutes Zeichen
  hrDevBad:      5,   // Ruhepuls >5% über Baseline → Belastung
  sleepBadH:     6.0, // unter 6h → zu wenig Schlaf
};

// ── Belastungswarnung ──────────────────────────────────
// null oder {signals:[], text}. Sie erscheint erst, wenn alle drei Signale
// gleichzeitig vorliegen.
function detectWarningSignals() { return _memo('warningSignals', _computeWarningSignals); }
function _computeWarningSignals() {
  const last = allData[allData.length-1];
  if (!last) return null;
  const signals = [];
  if (last.sleepTotal != null && last.sleepTotal < COACHING_THRESHOLDS.sleepBadH) signals.push('Schlafdauer unter Ziel');
  const devHRV = calculateDeviation(last.hrv, calculateBaseline('hrv', 30));
  if (devHRV != null && devHRV <= COACHING_THRESHOLDS.hvDevBad) signals.push('HRV unter Baseline');
  const devHR = calculateDeviation(last.restHR, calculateBaseline('restHR', 30));
  if (devHR != null && devHR >= COACHING_THRESHOLDS.hrDevBad) signals.push('Ruhepuls erhöht');

  if (signals.length < 3) return null;
  return {
    signals,
    text: `${signals.length} Signale deuten gleichzeitig auf erhöhte körperliche Belastung hin. Reduziere heute die Intensität und beobachte, ob sich die Werte morgen normalisieren.`
  };
}

// ── Pattern Insights (correlation-based text insights) ─
// Eine Einblick-Karte – dieselbe fuer „Muster & Zusammenhaenge" (Uebersicht) und die
// Trainings-Einblicke. `hl` hebt Teile des Texts hervor: mit Signalfarbe, wo der Wert
// eine Bewertung traegt, mit `inherit` (nur fett), wo er bloss eine Tatsache ist –
// „Farbe bedeutet Bewertung". Der Text ist Markup: alles, was aus dem Sheet stammt,
// muss vorher durch esc() (in den Trainings-Einblicken: artLabel).
function insightKarte(p) {
  let txt = p.text;
  if (p.hl) p.hl.forEach(h => { txt = txt.replace(h.phrase, () => `<span style="color:${h.c};font-weight:700">${h.phrase}</span>`); });
  return `<div class="pi-card" style="border-top-color:${p.color}">
        <div class="pi-head"><span class="pi-icon">${p.icon}</span><span class="pi-conf">${p.conf}</span></div>
        <div class="pi-text">${txt}</div>
      </div>`;
}

function generatePatternInsights() { return _memo('patternInsights', _computePatternInsights); }
function _computePatternInsights() {
  const insights = [];
  if (allData.length < 14) return insights;

  const byDate = {};
  allData.forEach(r => { byDate[r.date] = r; });
  const nextDay = dateStr => addDays(dateStr, 1);
  // Steigung der Regressionsgeraden je Messpunkt (positiv = steigend)
  function linTrend(rows, field) {
    const pts = rows.map((r,i)=>({x:i,y:r[field]})).filter(p=>p.y!=null);
    if (pts.length < 7) return null;
    const n = pts.length;
    const sumX = pts.reduce((s,p)=>s+p.x,0);
    const sumY = pts.reduce((s,p)=>s+p.y,0);
    const sumXY = pts.reduce((s,p)=>s+p.x*p.y,0);
    const sumX2 = pts.reduce((s,p)=>s+p.x*p.x,0);
    return (n*sumXY - sumX*sumY) / (n*sumX2 - sumX*sumX);
  }

  // Insight 1: Sleep vs HRV
  const withBothSH = allData.filter(r=>r.sleepTotal!=null&&r.hrv!=null);
  if (withBothSH.length >= 10) {
    const goodSleep = withBothSH.filter(r=>r.sleepTotal>=7.5);
    const poorSleep = withBothSH.filter(r=>r.sleepTotal<6.5);
    const hvGood = goodSleep.length ? mittel(goodSleep,'hrv') : null;
    const hvPoor = poorSleep.length ? mittel(poorSleep,'hrv') : null;
    if (hvGood && hvPoor && hvGood > hvPoor) {
      const diff = ((hvGood-hvPoor)/hvPoor*100).toFixed(0);
      insights.push({icon:'💙',color:'#2563EB',text:`Nach Nächten mit ≥7.5h Schlaf ist deine HRV im Schnitt ${diff}% höher als nach kurzen Nächten.`,hl:[{phrase:`${diff}% höher`,c:'#10B981'}],conf:'Schlaf–HRV-Zusammenhang'});
    }
  }

  // Insight 2: Sleep vs Steps
  const withBothSS = allData.filter(r=>r.sleepTotal!=null&&r.steps!=null);
  if (withBothSS.length >= 10) {
    const goodSleepRows = withBothSS.filter(r=>r.sleepTotal>=7.5);
    const poorSleepRows = withBothSS.filter(r=>r.sleepTotal<6.5);
    const stGood = goodSleepRows.length?mittel(goodSleepRows,'steps'):null;
    const stPoor = poorSleepRows.length?mittel(poorSleepRows,'steps'):null;
    if (stGood&&stPoor&&stGood>stPoor+500) {
      const diff = ((stGood-stPoor)/stPoor*100).toFixed(0);
      insights.push({icon:'🚶',color:'#059669',text:`An Tagen nach gutem Schlaf (≥7.5h) bist du durchschnittlich ${diff}% aktiver als nach kurzen Nächten.`,hl:[{phrase:`${diff}% aktiver`,c:'#10B981'}],conf:'Schlaf–Schritte-Zusammenhang'});
    }
  }

  // Insight 3: HRV vs restHR correlation
  const withBothHR = allData.filter(r=>r.hrv!=null&&r.restHR!=null);
  if (withBothHR.length >= 14) {
    const avgHRV = mittel(withBothHR,'hrv');
    const highHRV = withBothHR.filter(r=>r.hrv>=avgHRV);
    const lowHRV  = withBothHR.filter(r=>r.hrv< avgHRV);
    const hrHigh = highHRV.length?mittel(highHRV,'restHR'):null;
    const hrLow  = lowHRV.length ?mittel(lowHRV, 'restHR'):null;
    if (hrHigh&&hrLow&&hrLow>hrHigh+2) {
      const diff = (hrLow-hrHigh).toFixed(0);
      insights.push({icon:'❤️',color:'#EF4444',text:`An Tagen mit hoher HRV ist dein Ruhepuls im Schnitt ${diff} bpm tiefer als an Tagen mit niedriger HRV.`,hl:[{phrase:`${diff} bpm tiefer`,c:'#10B981'}],conf:'HRV–Ruhepuls-Zusammenhang'});
    }
  }

  // Insight 4/5: Training → HRV bzw. Ruhepuls am Folgetag.
  // Trainingstage aus dem Workout-Sheet – dieselbe Regel wie ueberall sonst in der App.
  const trainDates = new Set(Object.keys(workoutData).filter(d=>workoutData[d]?.durationMin>0));
  // Mittelwert von `feld` an Tagen nach einem Training bzw. nach einem Ruhetag
  // (je mindestens drei Tage, sonst null).
  const nachTraining = feld => {
    const nachT=[], nachR=[];
    allData.forEach(r => {
      if (r[feld]==null) return;
      const vortag = addDays(r.date, -1);
      if (trainDates.has(vortag)) nachT.push(r);
      else if (byDate[vortag]) nachR.push(r);
    });
    return { training: nachT.length>=3 ? mittel(nachT,feld) : null,
             ruhe:     nachR.length>=3 ? mittel(nachR,feld) : null };
  };
  if (trainDates.size >= 5) {
    const { training: hvTrain, ruhe: hvRest } = nachTraining('hrv');
    if (hvTrain&&hvRest) {
      const diff = Math.abs(hvTrain-hvRest).toFixed(0);
      if (diff >= 2) {
        if (hvTrain > hvRest)
          insights.push({icon:'🏋️',color:'#F97316',text:`Nach Trainingstagen ist deine HRV am Folgetag im Schnitt ${diff} ms höher als nach Ruhetagen – dein Körper erholt sich gut.`,hl:[{phrase:`${diff} ms höher`,c:'#10B981'},{phrase:'erholt sich gut',c:'#10B981'}],conf:'Training–HRV-Folgetag'});
        else
          insights.push({icon:'🏋️',color:'#F97316',text:`Nach Trainingstagen ist deine HRV am Folgetag im Schnitt ${diff} ms tiefer als nach Ruhetagen – ein normales Erholungszeichen.`,hl:[{phrase:`${diff} ms tiefer`,c:'#F97316'}],conf:'Training–HRV-Folgetag'});
      }
    }
    const { training: hrTrain, ruhe: hrRest } = nachTraining('restHR');
    if (hrTrain&&hrRest&&hrTrain>hrRest+1.5) {
      const diff = (hrTrain-hrRest).toFixed(0);
      insights.push({icon:'💓',color:'#EF4444',text:`Nach Trainingstagen ist dein Ruhepuls am Folgetag im Schnitt ${diff} bpm erhöht – der Körper arbeitet an der Erholung.`,hl:[{phrase:`${diff} bpm erhöht`,c:'#F97316'}],conf:'Training–Ruhepuls-Folgetag'});
    }
  }

  // Insight 6/7: Schritte → Schlaf bzw. HRV der Folgenacht. Tage am Median der
  // Schritte geteilt; verglichen wird der Mittelwert von `feld` am Folgetag.
  const nachSchritten = feld => {
    const tage = allData.filter(r => {
      const nd = byDate[nextDay(r.date)];
      return r.steps!=null && nd && nd[feld]!=null;
    });
    if (tage.length < 10) return null;
    const median = [...tage].sort((a,b)=>a.steps-b.steps)[Math.floor(tage.length/2)].steps;
    const folge = rows => mittel(rows.map(r=>byDate[nextDay(r.date)]).filter(Boolean), feld);
    return { aktiv: folge(tage.filter(r=>r.steps>=median)), ruhig: folge(tage.filter(r=>r.steps<median)) };
  };
  const schlafNachSchritten = nachSchritten('sleepTotal');
  if (schlafNachSchritten) {
    const { aktiv: slActive, ruhig: slInactive } = schlafNachSchritten;
    if (slActive&&slInactive&&slActive>slInactive+0.2) {
      const diff = Math.round((slActive-slInactive)*60);
      insights.push({icon:'🌙',color:'#7C3AED',text:`An aktiveren Tagen (mehr Schritte) schläfst du in der Folgenacht im Schnitt ${diff} Minuten länger.`,hl:[{phrase:`${diff} Minuten länger`,c:'#10B981'}],conf:'Schritte–Schlaf-Zusammenhang'});
    }
  }
  const hrvNachSchritten = nachSchritten('hrv');
  if (hrvNachSchritten) {
    const { aktiv: hvHi, ruhig: hvLo } = hrvNachSchritten;
    if (hvHi&&hvLo&&hvHi-hvLo>=2) {
      const diff = ((hvHi-hvLo)/hvLo*100).toFixed(0);
      insights.push({icon:'💪',color:'#059669',text:`Nach aktiveren Tagen ist deine HRV in der Folgenacht im Schnitt ${diff}% höher – Bewegung fördert deine Herzgesundheit.`,hl:[{phrase:`${diff}% höher`,c:'#10B981'}],conf:'Schritte–HRV-Zusammenhang'});
    }
  }

  // Insight 8: HRV-Trend 30 Tage
  const last30hrv = allData.slice(-30).filter(r=>r.hrv!=null);
  if (last30hrv.length >= 7) {
    const slope = linTrend(last30hrv, 'hrv');
    if (slope!=null && Math.abs(slope) >= 0.05) {
      const perWeek = zahl(slope*7,1);
      if (slope > 0)
        insights.push({icon:'📈',color:'#10B981',text:`Deine HRV zeigt einen positiven Trend: +${perWeek} ms pro Woche über die letzten 30 Tage – ein starkes Fitnesssignal.`,hl:[{phrase:`positiven Trend`,c:'#10B981'},{phrase:`starkes Fitnesssignal`,c:'#10B981'}],conf:'HRV-Trend 30 Tage'});
      else
        insights.push({icon:'📉',color:'#F97316',text:`Deine HRV zeigt einen leichten Abwärtstrend: ${perWeek} ms pro Woche über die letzten 30 Tage – Erholung beobachten.`,hl:[{phrase:'Abwärtstrend',c:'#F97316'},{phrase:'Erholung beobachten',c:'#F97316'}],conf:'HRV-Trend 30 Tage'});
    }
  }

  // Insight 9: Ruhepuls-Trend 30 Tage
  const last30hr = allData.slice(-30).filter(r=>r.restHR!=null);
  if (last30hr.length >= 7) {
    const slope = linTrend(last30hr, 'restHR');
    if (slope!=null && Math.abs(slope) >= 0.03) {
      const perWeek = zahl(Math.abs(slope*7),1);
      if (slope < 0)
        insights.push({icon:'📉',color:'#10B981',text:`Dein Ruhepuls sinkt: −${perWeek} bpm pro Woche über 30 Tage – ein klassisches Zeichen steigender Ausdauer.`,hl:[{phrase:'sinkt',c:'#10B981'},{phrase:'steigender Ausdauer',c:'#10B981'}],conf:'Ruhepuls-Trend 30 Tage'});
      else
        insights.push({icon:'📈',color:'#F97316',text:`Dein Ruhepuls steigt leicht: +${perWeek} bpm pro Woche über 30 Tage – mögliche Belastungs- oder Erholungszeichen.`,hl:[{phrase:'steigt leicht',c:'#F97316'}],conf:'Ruhepuls-Trend 30 Tage'});
    }
  }

  // Insight 10: VO₂max-Entwicklung
  const vo2Rows = allData.filter(r=>r.vo2max!=null);
  if (vo2Rows.length >= 5) {
    const first = mittel(vo2Rows.slice(0, Math.ceil(vo2Rows.length/3)), 'vo2max');
    const last  = mittel(vo2Rows.slice(-Math.ceil(vo2Rows.length/3)), 'vo2max');
    if (first&&last&&Math.abs(last-first)>=0.5) {
      const diff = zahl(last-first,1);
      if (last>first)
        insights.push({icon:'🫁',color:'#D97706',text:`Dein VO₂max hat sich um +${diff} ml/kg/min verbessert – deine aerobe Fitness entwickelt sich positiv.`,hl:[{phrase:`+${diff} ml/kg/min verbessert`,c:'#10B981'}],conf:'VO₂max-Entwicklung'});
      else
        insights.push({icon:'🫁',color:'#94A3B8',text:`Dein VO₂max ist um ${diff} ml/kg/min zurückgegangen – mehr Ausdauertraining könnte helfen.`,hl:[{phrase:`${diff} ml/kg/min zurückgegangen`,c:'#EF4444'}],conf:'VO₂max-Entwicklung'});
    }
  }

  // Insight 11: Wochentag vs. Wochenende Schlaf
  const withSleep = allData.filter(r=>r.sleepTotal!=null);
  if (withSleep.length >= 14) {
    const { wkd: weekday, wknd: weekend } = splitWeekWknd(withSleep);
    const slWD = weekday.length>=5?mittel(weekday,'sleepTotal'):null;
    const slWE = weekend.length>=2?mittel(weekend,'sleepTotal'):null;
    if (slWD&&slWE&&slWE>slWD+0.4) {
      const diff = Math.round((slWE-slWD)*60);
      insights.push({icon:'📅',color:'#7C3AED',text:`Am Wochenende schläfst du im Schnitt ${diff} Minuten länger als unter der Woche – ein Hinweis auf einen sozialen Jetlag.`,hl:[{phrase:`${diff} Minuten länger`,c:'#F97316'},{phrase:'sozialen Jetlag',c:'#F97316'}],conf:'Wochentag–Wochenende-Muster'});
    } else if (slWD&&slWE&&Math.abs(slWE-slWD)<=0.2) {
      insights.push({icon:'📅',color:'#10B981',text:`Dein Schlafrhythmus ist sehr konsistent: kaum Unterschied zwischen Wochentagen (${alsStdMin(slWD)}) und Wochenende (${alsStdMin(slWE)}).`,hl:[{phrase:'sehr konsistent',c:'#10B981'}],conf:'Wochentag–Wochenende-Muster'});
    }
  }

  // Insight 12: Bester Erholungstag (HRV nach Wochentag)
  const withHRVDate = allData.filter(r=>r.hrv!=null);
  if (withHRVDate.length >= 14) {
    const dayNames     = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
    const byDow = {};
    withHRVDate.forEach(r => {
      const d = new Date(r.date+'T00:00:00').getDay();
      if (!byDow[d]) byDow[d]=[];
      byDow[d].push(r.hrv);
    });
    let bestDow=-1, bestAvg=0;
    Object.entries(byDow).forEach(([d,vals]) => {
      if (vals.length < 2) return;
      const a = vals.reduce((s,v)=>s+v,0)/vals.length;
      if (a>bestAvg) { bestAvg=a; bestDow=parseInt(d); }
    });
    if (bestDow>=0) {
      const globalAvg = mittel(withHRVDate,'hrv');
      const diff = ((bestAvg-globalAvg)/globalAvg*100).toFixed(0);
      if (diff > 3)
        insights.push({icon:'🗓️',color:'#2563EB',text:`${dayNames[bestDow]}s ist dein bester Erholungstag: deine HRV ist dann im Schnitt ${diff}% höher als der Gesamtdurchschnitt.`,hl:[{phrase:`${dayNames[bestDow]}s`,c:'#2563EB'},{phrase:`${diff}% höher`,c:'#10B981'}],conf:'Wochentag–HRV-Muster'});
    }
  }

  // Insight 13: Schlafregelm​ässigkeit → HRV
  const withBothSC = allData.filter(r=>r.sleepTotal!=null&&r.hrv!=null);
  if (withBothSC.length >= 14) {
    const mean = mittel(withBothSC,'sleepTotal');
    const consistent = withBothSC.filter(r=>Math.abs(r.sleepTotal-mean)<=0.5);
    const variable   = withBothSC.filter(r=>Math.abs(r.sleepTotal-mean)>1.0);
    const hvCons = consistent.length>=5?mittel(consistent,'hrv'):null;
    const hvVar  = variable.length  >=4?mittel(variable,  'hrv'):null;
    if (hvCons&&hvVar&&hvCons>hvVar+2) {
      const diff = (hvCons-hvVar).toFixed(0);
      insights.push({icon:'🔄',color:'#0891B2',text:`An Tagen mit regelmässigem Schlaf (nahe dem Durchschnitt) ist deine HRV im Schnitt ${diff} ms höher als nach unregelmässigen Nächten.`,hl:[{phrase:`${diff} ms höher`,c:'#10B981'},{phrase:'regelmässigem Schlaf',c:'#10B981'}],conf:'Schlafregel​m​ässigkeit–HRV'});
    }
  }

  return insights;
}


// ── Statistik-Zeile ────────────────────────────────────
// Label links, Wert rechts – der mit Abstand häufigste Baustein der App (44 Stellen).
// Als Funktion statt als ausgeschriebenes Markup, damit sich Struktur und Klassen an
// einer Stelle ändern lassen.
function statZeile(label, wert, farbe) {
  const stil = farbe ? ` style="color:${farbe}"` : '';
  return `<div class="stat-row"><span class="stat-lbl">${label}</span><span class="stat-val"${stil}>${wert}</span></div>`;
}

// ── Bezugszeitraum-Etikett ─────────────────────────────
// Kennzeichnet Kacheln, deren Zahlen NICHT dem globalen Zeitfilter folgen.
// Ohne diese Kennzeichnung ist nicht erkennbar, warum sich beim Umstellen des
// Filters nur ein Teil des Bildschirms ändert.
function scopeBadge(text) {
  return `<span class="scope-badge" title="Bezugszeitraum dieser Kachel – unabhängig vom Zeitfilter">${text}</span>`;
}

// ── Daten-Stand ────────────────────────────────────────
// Zeigt, bis wann Daten vorliegen und wann zuletzt geladen wurde. Ohne diese
// Angabe war nach einem Abruf nicht erkennbar, ob er etwas bewirkt hat.
// Steht als Zeilen in der App-Karte auf der Einstellungen-Seite.
function datenStandZeilen() {
  if (!allData.length) return '';
  const newest = allData[allData.length-1].date;
  const ageDays = Math.round(
    (new Date(toLocalDateStr(new Date())+'T00:00:00') - new Date(newest+'T00:00:00')) / 86400000
  );
  // Das Alter wird nur genannt, wenn es auffällig ist; sonst genügt das Datum.
  const stale  = ageDays >= 2;
  const ageTxt = stale ? ` · ${ageDays} Tage alt` : '';
  // Der Ladezeitpunkt ueberlebt jetzt im Zwischenspeicher auch einen App-Neustart.
  // Eine reine Uhrzeit waere dann irrefuehrend ("19:06" von gestern) – ausserhalb
  // des heutigen Tages steht deshalb das Datum davor.
  let loaded = '—';
  if (_lastLoadTs) {
    const d = new Date(_lastLoadTs);
    const zeit = d.toLocaleTimeString('de-CH',{hour:'2-digit',minute:'2-digit'}) + ' Uhr';
    loaded = toLocalDateStr(d) === toLocalDateStr(new Date()) ? zeit : fmtDayShort(toLocalDateStr(d)) + ', ' + zeit;
  }
  // „Daten bis" nennt seit 12.09.2026 den Zeitstempel der neuesten uebertragenen
  // Health-Datei statt nur ihren Tag: ein Tag ist auch um 00:05 Uhr schon „heute",
  // und erst die Uhrzeit sagt, wie frisch die Werte wirklich sind. Der Stempel kommt
  // aus dem Blatt `Meta` (siehe META_BLATT).
  // Die Pruefung `>= newest` ist die Sicherung gegen einen stehengebliebenen Stempel:
  // waere er aelter als der neueste Tag im Sheet, beschriebe er nicht diesen Stand —
  // dann lieber nur das Datum nennen als eine falsche Uhrzeit.
  const bisTxt = (_exportStempel && _exportStempel.datum >= newest)
    ? fmtDayShort(_exportStempel.datum) + ', ' + _exportStempel.zeit + ' Uhr'
    : fmtDayShort(newest);
  // Stand der Anmeldung: der Text kommt allein aus anmeldeStand().
  const anmeldung = anmeldeStand();
  return statZeile('Daten bis', bisTxt+ageTxt, stale ? '#F59E0B' : null)
       + statZeile('Zuletzt geladen', loaded)
       + statZeile('Google-Anmeldung', anmeldung.text, anmeldung.farbe);
}

function kpiCard({icon,label,value,unit,delta,deltaLabel,color,sub}={}) {
  const dir = delta==null?'neu':delta>0?'pos':'neg';
  const dStr = delta==null?'—':(delta>0?'↑':'↓')+' '+zahl(Math.abs(delta),1)+'% '+(deltaLabel||'vs. Vorperiode');
  return `<div class="kpi" style="border-top-color:${color||'transparent'}">
    <div class="kpi-hd"><span class="kpi-lbl">${label}</span>${icon?`<span class="kpi-ico">${icon}</span>`:''}</div>
    <div class="kpi-val">${value}<span class="kpi-unit">${unit||''}</span></div>
    <div class="kpi-delta ${dir}">${dStr}</div>
    ${sub?`<div class="kpi-sub">${sub}</div>`:''}
  </div>`;
}

// ── Übersicht ──────────────────────────────────────────
const TAB_TITEL = { overview: 'Übersicht', herz: 'Herz', schlaf: 'Schlaf', training: 'Training' };

// ── Zahlen in den Ziel-Ringen zaehlen hoch (auf Wunsch, 18.09.2026, damals Kacheln) ─
// Beim App-Start von 0 auf den Wert, bei neuen Daten vom zuletzt gezeigten Wert auf
// den neuen – in 450 ms. NICHT bei jedem Aufbau der Uebersicht (Bereichswechsel,
// Blaettern, Ausklappen): dort aendern sich die Tageswerte nicht, und eine Zahl, die
// jedes Mal neu hochzaehlt, nervt. Ausgeloest wird es ueber `_kachelnZaehlen`: true
// beim Start, gesetzt von den drei Wegen, auf denen neue Daten ankommen (stilles
// Nachladen, „Anzeigen" in der Hinweisleiste, „Daten aktualisieren"); verbraucht vom
// naechsten Aufbau der Uebersicht.
// Die endgueltige Zahl steht bereits im HTML; die Animation setzt sie erst im selben
// Schritt auf den Startwert zurueck. Der Zeitgeber in `uebergang` sorgt dafuer, dass
// sie auch ohne gezeichnete Seite am Ziel ankommt.
// `data-wert` ist eine Zahl aus der Einlese-Pruefung, kein Fremdtext.
const KACHEL_ZAEHL_DAUER = 450;
let _kachelnZaehlen = true;
const _kachelZuletzt = {};
function kachelZahl(feld, wert, form = 'ganz') {
  const txt = form === 'std' ? alsStdMin(wert) : String(Math.round(wert));
  return `<span class="ti-zahl" data-feld="${feld}" data-form="${form}" data-wert="${Number(wert)}">${txt}</span>`;
}
function kachelnHochzaehlen() {
  const felder = [...document.querySelectorAll('#screen-overview .ti-zahl')];
  if (!felder.length) return;          // noch keine Daten: das Hochzaehlen aufheben
  const zaehlen = _kachelnZaehlen;
  _kachelnZaehlen = false;
  const laeufe = [];
  felder.forEach(el => {
    const feld = el.dataset.feld, form = el.dataset.form, ziel = Number(el.dataset.wert);
    const von = _kachelZuletzt[feld] != null ? _kachelZuletzt[feld] : 0;
    _kachelZuletzt[feld] = ziel;
    if (!zaehlen || bewegungAus() || !isFinite(ziel) || von === ziel) return;
    // Die Stunden-Form zaehlt in Minuten, sonst sprangen die Minuten ungleichmaessig.
    const fmt = v => form === 'std' ? alsStdMin(Math.round(v * 60) / 60) : String(Math.round(v));
    laeufe.push({ el, von, ziel, fmt });
    el.textContent = fmt(von);
  });
  if (!laeufe.length) return;
  uebergang(KACHEL_ZAEHL_DAUER, e => laeufe.forEach(l => {
    if (l.el.isConnected) l.el.textContent = l.fmt(l.von + (l.ziel - l.von) * e);
  }));
}

function pgOverview() {
  const warnSig = detectWarningSignals();
  const patternIns = generatePatternInsights();

  // Verlaufs-Chart: folgt dem globalen Zeitfilter (D = gewähltes Fenster).
  const D = filtered();
  const _hasWoDur = Object.values(workoutData).some(w => w?.durationMin > 0);
  const { labels: wLabels, align: wAlign, hasData: wHas, keys: wKeys, keyTyp: wKeyTyp } = timeDim(D);
  const wSl = wAlign('sleepTotal');
  const wHR = wAlign('restHR');
  const wHV = wAlign('hrv');
  // Training: Ø Trainingsminuten/Tag pro Bucket (0 für Tage ohne Training) → Stunden; sonst Ø Schritte.
  const _woRows = D.map(r => ({ date: r.date, _dur: _hasWoDur ? (workoutData[r.date]?.durationMin ?? 0) : null, steps: r.steps }));
  const { align: _woAlign } = timeDim(_woRows);
  const wTr = _hasWoDur ? _woAlign('_dur').map(v => v != null ? v/60 : null) : _woAlign('steps');
  const _wocheTrLabel = _hasWoDur ? 'Trainingsmin.' : 'Schritte';
  const _wocheAgg = !(timeRange === '7d' || timeRange === '1m'); // aggregierte Buckets → "Ø" im Tooltip

  const _ovVorher = ovObenMerken();
  document.getElementById("screen-overview").innerHTML = `
    ${pgBanner('📊','Übersicht')}
    <!-- Belastungswarnung (nur wenn ausgelöst). Steht ueber dem Kartenpaar:
         eine Warnung gehoert nach oben, und im Querformat stehen Ziele und Kacheln
         nebeneinander – dazwischen waere kein Platz fuer sie. -->
    ${warnSig ? `<div class="warn-card">
      <div>
        <div class="warn-title">Belastungssignal erkannt ${scopeBadge('letzter Tag')}</div>
        <div class="warn-text">${warnSig.text}</div>
        <div class="warn-signals">${warnSig.signals.map(s=>`<span class="warn-sig">${s}</span>`).join('')}</div>
      </div>
    </div>` : ''}
    <!-- Hochformat: Wochenbilanz über den Ringen. Querformat: Wochenbilanz links,
         Ringe rechts (Raster-Bereiche in style.css). -->
    ${ovObenHTML()}
    <!-- Verlauf und Muster-Raster: Teil des Ausklapp-Bereichs (seit 08.09.2026). -->
    <div class="chart-card ausklapp-teil" style="margin-bottom:.7rem;${_weitereOffen.overview?'':'display:none'}">
      <h3>Verlauf</h3>
      <div class="chart-legend">
        <div class="cl-item"><span class="cl-dot" style="background:#7C3AED"></span>Schlaf</div>
        <div class="cl-item"><span class="cl-dot" style="background:#EF4444"></span>Puls</div>
        <div class="cl-item"><span class="cl-dot" style="background:#2563EB"></span>HRV</div>
        <div class="cl-item"><span class="cl-dot" style="background:${_hasWoDur?'#F97316':'#059669'}"></span>${_hasWoDur?'Training':'Schritte'}</div>
      </div>
      <div class="chart-wrap"><canvas id="c-woche"></canvas></div>
    </div>

    ${patternIns.length>0?`
    <div class="pi-grid ausklapp-teil" style="${_weitereOffen.overview?'':'display:none'}">
      ${patternIns.map(insightKarte).join('')}
    </div>`:''}
    `;
  ovObenAnimieren(_ovVorher);

  // Verlaufs-Chart (folgt dem globalen Zeitfilter; Aggregation via timeDim)
  function _wocheTooltipLabel(ctx){
    const lbl=ctx.dataset.label, v=ctx.raw;
    // Bei aggregierten Buckets (Wochen-/Monatswerte) ist der Wert ein Tagesmittel → "Ø …".
    const pre=_wocheAgg?'Ø ':'';
    if(lbl==='Schlaf (h)')return`${pre}Schlaf: ${v!=null?alsStdMin(v):'—'}`;
    if(lbl===_wocheTrLabel){
      if(_hasWoDur){const mins=Math.round((v??0)*60);return`${pre}${_wocheTrLabel}: ${mins} min`;}
      return`${pre}${_wocheTrLabel}: ${v!=null?Math.round(v).toLocaleString('de-CH'):'—'}`;
    }
    if(lbl==='Ruhepuls') return `${pre}Ruhepuls: ${v!=null?Math.round(v)+' bpm':'—'}`;
    if(lbl==='HRV')      return `${pre}HRV: ${v!=null?Math.round(v)+' ms':'—'}`;
    return lbl+': '+zahl(v,1);
  }
  if(wHas){
    zeichneDiagramm('c-woche',{__keys:wKeys,__keyTyp:wKeyTyp,
      // KEIN __werteFmt: das Verlaufs-Diagramm bleibt ganz ohne Datenbeschriftungen
      // (auf Wunsch, 07.09.2026, in beiden Ausrichtungen). Vier Reihen auf zwei Achsen
      // ergaben selbst nach dem Weglassen von Puls und HRV ein unruhiges Bild.
      data:{labels:wLabels,datasets:[
        {type:'bar',label:'Schlaf (h)',data:wSl,backgroundColor:'rgba(124,58,237,.35)',borderRadius:BALKEN_RADIUS,yAxisID:'yL'},
        {type:'line',label:'Ruhepuls',data:wHR,borderColor:'#EF4444',backgroundColor:'transparent',tension:.35,pointRadius:3,pointBackgroundColor:'#EF4444',yAxisID:'yR',spanGaps:true},
        {type:'line',label:'HRV',data:wHV,borderColor:'#2563EB',backgroundColor:'transparent',tension:.35,pointRadius:3,pointBackgroundColor:'#2563EB',yAxisID:'yR',spanGaps:true},
        {type:'line',label:_wocheTrLabel,data:wTr,borderColor:'#F97316',backgroundColor:'transparent',tension:.35,pointRadius:3,pointBackgroundColor:'#F97316',yAxisID:'yL',spanGaps:true}
      ]},
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,callbacks:{label:ctx=>_wocheTooltipLabel(ctx)}}},
        scales:{
          x:{...achseX},
          yL:{position:'left',...achseY,suggestedMin:0,suggestedMax:10,ticks:{...achseY.ticks,callback:v=>Math.floor(v)+'h'}},
          yR:{position:'right',display:true,grid:{display:false},ticks:{color:'#94A3B8',font:{size:10}},suggestedMin:30,suggestedMax:100}
        }
      }
    });
  }
}

// ── Bausteine der Einordnungs-Karten (Herz, Schlaf) ────
// Eine Zeile der Verteilung: farbiges Label, Balken, Anzahl und Anteil.
function verteilungZeile(label, farbe, n, gesamt) {
  const pct = n / gesamt * 100;
  return `<div class="goal-row"><span class="goal-lbl" style="color:${farbe}">${label}</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${pct}%;background:${farbe}"></div></div><span class="goal-val"><span class="goal-num">${n}</span><span style="color:var(--txt3)">(${pct.toFixed(0)}%)</span></span></div>`;
}
// Konsistenz über die Streuung, mit Schwellen in der Einheit des Werts. Ein
// gleichmässiger Verlauf spricht für stabile Erholung, starke Ausschläge für
// wechselnde Belastung. Liefert [Text, Farbe].
function konsistenzStufe(streuung, g1, g2, g3, schlechtText) {
  if (streuung == null) return ['—', '#94A3B8'];
  if (streuung < g1) return ['Sehr konsistent', '#10B981'];
  if (streuung < g2) return ['Konsistent', '#84CC16'];
  if (streuung < g3) return ['Mäßig', '#EAB308'];
  return [schlechtText, '#EF4444'];
}
// Wie viele Tage des Fensters einen Messwert haben.
function messpunkteZeile(n, fensterTage) {
  return statZeile('Messpunkte', `${n}d <span style="color:var(--txt3)">(${fensterTage>0?(n/fensterTage*100).toFixed(0):'—'}%)</span>`);
}

// ── Herz ───────────────────────────────────────────────
function pgHerz() {
  const D=filtered();
  const hrD=mittel(D,'restHR');
  const hvD=mittel(D,'hrv');
  const hrf=D.filter(r=>r.restHR!=null);
  const hvf=D.filter(r=>r.hrv!=null);

  // Weekday vs weekend HR & HRV
  const hrSplit=splitWeekWknd(hrf);
  const hrWeek=mittel(hrSplit.wkd,'restHR');
  const hrWknd=mittel(hrSplit.wknd,'restHR');
  const hvSplit=splitWeekWknd(hvf);
  const hvWeek=mittel(hvSplit.wkd,'hrv');
  const hvWknd=mittel(hvSplit.wknd,'hrv');

  // Bester/schlechtester Tag richtet sich nach der Zielrichtung: beim Ruhepuls ist der
  // NIEDRIGSTE Wert der beste, bei der HRV der höchste.
  const hrBest = hrf.length?Math.min(...hrf.map(r=>r.restHR)):null;
  const hrSchlecht = hrf.length?Math.max(...hrf.map(r=>r.restHR)):null;
  const hvBest = hvf.length?Math.max(...hvf.map(r=>r.hrv)):null;
  const hvSchlecht = hvf.length?Math.min(...hvf.map(r=>r.hrv)):null;
  // „Ziel erreicht" wie beim Schlaf (auf Wunsch, 30.09.2026): Tage mit erreichtem Ziel
  // von allen Tagen mit Messwert. Grün, sobald mindestens ein Tag das Ziel erreicht.
  // Kürzer als beim Schlaf („25/30" statt „25 von 30"): zwei Reihen in einer Zeile
  // brachen bei 12M (dreistellige Zahlen) auf 375 px sonst um.
  const zielTeil=(rows,key)=>{
    if(!rows.length) return '—';
    const n=rows.filter(r=>zielErfuellt(key,r[key])).length;
    const txt=`${n}<span style="color:var(--txt3)">/${rows.length} (${Math.round(n/rows.length*100)}%)</span>`;
    return n>0?`<span style="color:#10B981;font-weight:700">${txt}</span>`:txt;
  };
  const [hrKons,hrKonsFarbe]=konsistenzStufe(standardabw(hrf,'restHR'), 2, 3.5, 5, 'Schwankend');
  const [hvKons,hvKonsFarbe]=konsistenzStufe(standardabw(hvf,'hrv'),    6, 10, 15, 'Schwankend');

  // Einordnung des Ø-Ruhepulses
  function hrZone(v){
    if(v==null)return['—','#94A3B8'];
    if(v<50)return['Athleten-Bereich','#2563EB'];
    if(v<60)return['Sehr gut','#10B981'];
    if(v<70)return['Normal','#84CC16'];
    if(v<80)return['Leicht erhöht','#F97316'];
    return['Hoch','#EF4444'];
  }
  const [hrZoneName,hrZoneColor]=hrZone(hrD);

  // Einordnung der Ø-HRV
  function hvCat(v){
    if(v==null)return['—','#94A3B8'];
    if(v>=70)return['Sehr gut','#10B981'];
    if(v>=50)return['Gut','#84CC16'];
    if(v>=30)return['Mittel','#EAB308'];
    return['Niedrig','#EF4444'];
  }
  const [hvCatName,hvCatColor]=hvCat(hvD);

  // Tage je Bereich
  const nHr=(von,bis)=>hrf.filter(r=>r.restHR>=von&&r.restHR<bis).length;
  const nHv=(von,bis)=>hvf.filter(r=>r.hrv>=von&&r.hrv<bis).length;
  const nTot=hrf.length||1, nHVTot=hvf.length||1;

  const bl30hrv = calculateBaseline('hrv', 30);
  const bl30hr  = calculateBaseline('restHR', 30);
  const lastRow  = allData[allData.length-1] || {};
  const devHRVhz = calculateDeviation(lastRow.hrv, bl30hrv);
  const devHRhz  = calculateDeviation(lastRow.restHR, bl30hr);
  const herzInterpret = (() => {
    if (devHRVhz==null&&devHRhz==null) return null;
    const T = COACHING_THRESHOLDS;
    const hvGood = devHRVhz!=null&&devHRVhz>=T.hvDevGood;
    const hvBad  = devHRVhz!=null&&devHRVhz<=T.hvDevBad;
    const hrGood = devHRhz!=null&&devHRhz<=T.hrDevGood;
    const hrBad  = devHRhz!=null&&devHRhz>=T.hrDevBad;
    const hvPct  = devHRVhz!=null?(devHRVhz>=0?'+':'')+devHRVhz.toFixed(0)+'%':null;
    const hrPct  = devHRhz!=null?(devHRhz>=0?'+':'')+devHRhz.toFixed(0)+'%':null;
    if (hvGood&&hrGood) return {status:'Gute Erholung',color:'#10B981',
      text:`HRV liegt ${hvPct} über der 30-Tage-Baseline, Ruhepuls ${hrPct} darunter – beide Werte signalisieren optimale Erholung. Mögliche Ursachen: ausreichend Schlaf, niedrige Gesamtbelastung oder eine gelungene Regenerationsphase.`};
    if (hvBad&&hrBad)   return {status:'Belastungssignal',color:'#EF4444',
      text:`HRV liegt ${hvPct} unter der 30-Tage-Baseline, Ruhepuls ${hrPct} darüber – der Körper zeigt klare Stresssignale. Mögliche Ursachen: Schlafmangel, Übertraining, beginnende Erkrankung oder hohe mentale Belastung.`};
    if (hvBad) return {status:'Leichte Belastung',color:'#F97316',
      text:`HRV liegt ${hvPct} unter der 30-Tage-Baseline. Mögliche Ursachen: unzureichende Erholung, erhöhter Stress oder intensives Training in den letzten Tagen.`};
    if (hrBad) return {status:'Leichte Belastung',color:'#F97316',
      text:`Ruhepuls liegt ${hrPct} über der 30-Tage-Baseline. Mögliche Ursachen: beginnende Erkrankung, Dehydration, Schlafmangel oder eine bevorstehende Belastungsreaktion.`};
    return {status:'Normalbereich',color:'#3B82F6',
      text:`HRV (${hvPct||'—'}) und Ruhepuls (${hrPct||'—'}) liegen nahe der persönlichen 30-Tage-Baseline – keine Auffälligkeiten festgestellt.`};
  })();

  const tHD=timeDim(D).hasData;
  const tdL=timeDim(D,true);
  const hrMaL=tdL.align('restHR'); const hvMaL=tdL.align('hrv');

  document.getElementById("screen-herz").innerHTML=`
    ${pgBanner('❤️','Herz')}
    <div class="chart-card">
      <h3>Ruhepuls &amp; HRV</h3>
      <div class="chart-legend">
        <div class="cl-item"><span class="cl-line" style="background:var(--heart)"></span>Puls</div>
        <div class="cl-item"><span class="cl-line" style="background:var(--hrv)"></span>HRV</div>
        ${hlLegende('c-herz|oe','Ø','#94A3B8')}
      </div>
      <div class="chart-wrap"><canvas id="c-herz"></canvas></div>
      <!-- Beide Reihen pro Zeile, immer in der Reihenfolge der Legende: erst Puls,
           dann HRV. Die Einheiten halten sie auseinander. Getrennte Zeilen je Reihe
           waeren acht Stueck und damit laenger als das Diagramm darueber. -->
      <div class="stats-list diagramm-fuss">
        ${hrf.length||hvf.length ? statZeile('Ziel erreicht', `${zielTeil(hrf,'restHR')} | ${zielTeil(hvf,'hrv')}`) : ''}
        ${istYoY() ? yoyZeilen([
            { werte: yoyWerte(D, r => r.restHR, 'mittel'), richtung: ZIELE.restHR.richtung },
            { werte: yoyWerte(D, r => r.hrv,    'mittel'), richtung: ZIELE.hrv.richtung }]) : ''}
        ${istYoY() ? '' : statZeile(oeLabel(), `${hrD!=null?zahl(hrD,0)+' bpm':'—'} | ${hvD!=null?zahl(hvD,0)+' ms':'—'}`)}
        ${istYoY() ? '' : fussMehr('herz',
          statZeile(`Ø Wochentag (Mo–Fr)`, `${hrWeek!=null?zahl(hrWeek,0)+' bpm':'—'} | ${hvWeek!=null?zahl(hvWeek,0)+' ms':'—'}`)
        + statZeile(`Ø Wochenende (Sa–So)`, `${hrWknd!=null?zahl(hrWknd,0)+' bpm':'—'} | ${hvWknd!=null?zahl(hvWknd,0)+' ms':'—'}`))}
      </div>
    </div>

    ${weitereAuf('herz')}
    <div class="two-col-eq">
      <div class="chart-card split2" style="margin-bottom:0">
        <h3>Ruhepuls-Einordnung ${infoI('restHR')}</h3>
        <p class="split2-sub">
          Ø ${zahl(hrD,0)} bpm → <span style="color:${hrZoneColor};font-weight:700">${hrZoneName}</span>
        </p>
        <div class="goal-list">
          ${verteilungZeile('&lt; 50 bpm', '#10B981', nHr(-Infinity,50), nTot)}
          ${verteilungZeile('50–65 bpm', '#84CC16', nHr(50,65), nTot)}
          ${verteilungZeile('65–75 bpm', '#EAB308', nHr(65,75), nTot)}
          ${verteilungZeile('&gt; 75 bpm', '#EF4444', nHr(75,Infinity), nTot)}
        </div>
        <div class="stats-list">
          ${statZeile(`Bester Tag`, `${hrBest!=null?zahl(hrBest,0)+' bpm':'—'}`, `#10B981`)}
          ${statZeile(`Schlechtester Tag`, `${hrSchlecht!=null?zahl(hrSchlecht,0)+' bpm':'—'}`, `#EF4444`)}
          ${statZeile(`Konsistenz`, hrKons, hrKonsFarbe)}
          ${messpunkteZeile(hrf.length, D.length)}
        </div>
      </div>
      <div class="chart-card split2" style="margin-bottom:0">
        <h3>HRV-Einordnung ${infoI('hrv')}</h3>
        <p class="split2-sub">
          Ø ${zahl(hvD,0)} ms → <span style="color:${hvCatColor};font-weight:700">${hvCatName}</span>
        </p>
        <div class="goal-list">
          ${verteilungZeile('≥ 70 ms', '#10B981', nHv(70,Infinity), nHVTot)}
          ${verteilungZeile('50–70 ms', '#84CC16', nHv(50,70), nHVTot)}
          ${verteilungZeile('30–50 ms', '#EAB308', nHv(30,50), nHVTot)}
          ${verteilungZeile('&lt; 30 ms', '#EF4444', nHv(-Infinity,30), nHVTot)}
        </div>
        <div class="stats-list">
          ${statZeile(`Bester Tag`, `${hvBest!=null?zahl(hvBest,0)+' ms':'—'}`, `#10B981`)}
          ${statZeile(`Schlechtester Tag`, `${hvSchlecht!=null?zahl(hvSchlecht,0)+' ms':'—'}`, `#EF4444`)}
          ${statZeile(`Konsistenz`, hvKons, hvKonsFarbe)}
          ${messpunkteZeile(hvf.length, D.length)}
        </div>
      </div>
    </div>

    <!-- Die Einordnung stand zuoberst und wurde auf Wunsch ans Ende gesetzt:
         erst die Zahlen und Verläufe, dann deren Deutung. -->
    ${herzInterpret?`<div class="rec-card" style="--rec-color:${herzInterpret.color}">
      <div class="rec-status" style="background:${herzInterpret.color}22;color:${herzInterpret.color}">${herzInterpret.status}</div>
      <div class="rec-title">Herz-Kreislauf Einordnung ${infoI('baseline')} ${scopeBadge('letzter Tag vs. 30-Tage-Baseline')}</div>
      <div class="rec-text">${herzInterpret.text}</div>
    </div>`:''}
    ${_weitereOffen.herz ? einblickeHTML(herzInsights()) : ''}
    </div>
`;

  if(tHD){
    // Beide Y-Achsen synchronisieren: identischer Min/Max/Schritt → gleicher Zahlenwert
    // liegt auf gleicher Höhe (60 bpm links = 60 ms rechts). Schritte in 5ern oder 10ern.
    const _hrhv=[...hrMaL,...hvMaL].filter(v=>v!=null);
    let _yMin=40,_yMax=90,_yStep=10;
    if(_hrhv.length){
      const _lo=Math.min(..._hrhv), _hi=Math.max(..._hrhv);
      _yStep=(_hi-_lo)>45?10:5;                 // großer Bereich → 10er-, sonst 5er-Schritte
      _yMin=Math.floor(_lo/_yStep)*_yStep;       // auf Schritt abrunden
      _yMax=Math.ceil(_hi/_yStep)*_yStep;        // auf Schritt aufrunden
      if(_yMin===_yMax)_yMax=_yMin+_yStep;
    }
    const _yAxis=extra=>({min:_yMin,max:_yMax,ticks:{color:'#94A3B8',font:{size:10},stepSize:_yStep,callback:v=>Math.round(v)},...extra});
    zeichneDiagramm('c-herz',{__keys:tdL.keys,__keyTyp:tdL.keyTyp,
      // Puls in bpm, HRV in ms – beide ganzzahlig, eine Nachkommastelle waere
      // hier Scheingenauigkeit.
      __werteFmt:v=>String(Math.round(v)),
      // Nur im Querformat (auf Wunsch, 07.09.2026): im Hochformat liegen die beiden
      // Kurven eng beieinander und kreuzen sich, die Zahlen stiessen dort aneinander.
      __werteNurQuer:true,
      type:'line',data:{labels:tdL.labels,datasets:[
      {label:'Ruhepuls',data:hrMaL,borderColor:'#EF4444',backgroundColor:'rgba(239,68,68,.07)',tension:.3,fill:true,pointRadius:3,spanGaps:true,yAxisID:'yL'},
      {label:'HRV',data:hvMaL,borderColor:'#2563EB',backgroundColor:'rgba(37,99,235,.07)',tension:.3,fill:true,pointRadius:3,spanGaps:true,yAxisID:'yR'},
      // Ø-Linien in der Farbe ihrer Reihe statt der beiden grauen Ziellinien: bei zwei
      // Kurven auf einer Skala liessen sich zwei gleich graue Hilfslinien nicht
      // zuordnen. Die Zielwerte stehen in der Ziel-Karte der Übersicht.
      // EIN Schalter fuer beide Ø-Linien. Zwei Eintraege („Ø Puls", „Ø HRV") machten
      // die Legende doppelt so lang fuer einen Zustand, den man ohnehin gemeinsam
      // will. Der Marker ist deshalb grau statt rot oder blau.
      ...(hlAn('c-herz|oe') ? [
      {label:'Ø Ruhepuls',data:hrMaL.map(()=>hrD),borderColor:'#EF4444',borderDash:[5,4],
       pointRadius:0,borderWidth:1.5,tension:0,fill:false,yAxisID:'yL'},
      {label:'Ø HRV',data:hvMaL.map(()=>hvD),borderColor:'#2563EB',borderDash:[5,4],
       pointRadius:0,borderWidth:1.5,tension:0,fill:false,yAxisID:'yR'}] : [])
    ]},options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,
        filter:item=>item.dataset.label==='Ruhepuls'||item.dataset.label==='HRV',
        // Ganze Zahlen mit Einheit: Nachkommastellen sind hier Scheingenauigkeit,
        // und ohne Einheit sind die beiden Reihen (bpm vs. ms) nicht auseinander-
        // zuhalten – sie teilen sich im Diagramm eine Skala.
        callbacks:{label:ctx=>ctx.parsed.y==null?null:
          `${ctx.dataset.label}: ${Math.round(ctx.parsed.y)} ${ctx.dataset.label==='Ruhepuls'?'bpm':'ms'}`}}},
      scales:{x:achseX,
        yL:_yAxis({position:'left',grid:{color:GRID_COLOR}}),
        // Rechte Achse ausgeblendet: sie ist mit der linken synchronisiert und zeigte
        // exakt dieselben Zahlen – auf dem iPhone verschenkte Breite ohne Aussage.
        yR:_yAxis({position:'right',display:false,grid:{display:false}})}}});
  }
}

// Ausklapp-Zustand je Tab („Weitere Auswertungen"). Alle starten ZU, damit ein Tab
// beim Oeffnen ruhig bleibt; die Deutungen holt man sich dazu, wenn man sie will.
// Liegt ausserhalb der Seitenfunktionen und uebersteht damit jeden Neuaufbau.
const _weitereOffen = { overview:false, herz:false, schlaf:false, training:false };
// Fusszeilen „Ø Wochentag" / „Ø Wochenende" (auf Wunsch, 14.09.2026): sie gehoeren zum
// Ausklapp-Zustand ihres Tabs und sind damit standardmaessig zu. Eine eigene Huelle
// statt einzeln markierter Zeilen, damit die Klapp-Animation EINEN Block bewegt – mit
// einzelnen Zeilen spraenge der `gap` der Liste zweimal um 3 px.
// Die Huelle steht in jeder Fusszeile ZULETZT. Darauf verlaesst sich die Trennlinie:
// `.stat-row:last-child` hat keine, und die Zeile davor verliert ihre nur, wenn die
// Huelle fehlt – also genau dann, wenn sie tatsaechlich die letzte ist.
function fussMehr(tab, zeilen) {
  if (!_weitereOffen[tab] || !zeilen || !zeilen.trim()) return '';
  return `<div class="fuss-mehr ausklapp-teil">${zeilen}</div>`;
}
// Das oeffnende <div> des Ausklapp-Bereichs. Der schliessende Tag steht im Markup,
// damit die Karten dazwischen unveraendert bleiben – ein String-Parameter haette die
// Template-Literale der Karten verschachtelt. Der Schalter sitzt in der Zeitleiste.
function weitereAuf(tab) {
  return `<div class="weitere-inhalt ausklapp-teil"${_weitereOffen[tab] ? '' : ' hidden'}>`;
}

// ── Einstellungen: eigene Seite statt Karte in der Uebersicht ────────────────
// Vorbild ist FitTrack: eine Seite, die sich von rechts ueber die App schiebt, mit
// Pfeil oben links zurueck – zusaetzlich zum Wisch vom linken Bildschirmrand.
// Vorher lag alles davon als „App"-Karte hinter einem Ausklapp-Knopf unten in der
// Uebersicht; damit endete jeder Besuch der Uebersicht mit einem Abschnitt, der
// selten gebraucht wird.
//
// FOLGE, die man kennen muss: Der Stand der Google-Anmeldung und die Zeilen
// „Daten bis" / „Zuletzt geladen" stehen NUR hier. Eine abgelaufene Anmeldung faellt
// also erst auf, wenn man diese Seite oeffnet oder etwas laden will. Das war schon
// vorher so gewollt (siehe anmeldeStand) und ist jetzt eine Ebene tiefer.
let _einstOffen = false;

function pgEinstellungen() {
  const el = document.getElementById('seite-einstellungen');
  if (!el) return;
  const a = anmeldeStand();
  el.innerHTML = `
    <div class="us-kopf">
      <button class="us-zurueck" aria-label="Zurück zur Übersicht" title="Zurück">
        <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 5 8 12 15 19"/></svg>
      </button>
      <div class="us-titel">Einstellungen</div>
    </div>
    <div class="us-inhalt">
      <div class="chart-card app-karte">
        <div class="stats-list">
          ${datenStandZeilen()}
          ${statZeile('Installierte Version', '<span class="app-version">wird geprüft…</span>')}
        </div>
        ${a.hinweis ? `<button class="update-btn anmelde-btn">Mit Google anmelden</button>
        <div class="app-hinweis">${a.hinweis}</div>` : ''}
        <button class="update-btn refresh-btn">Daten aktualisieren</button>
        <div class="app-hinweis">Liest Schlaf-, Herz- und Trainingsdaten neu aus den Google-Sheets. Nutze das, wenn heutige Werte noch fehlen.</div>
        <button class="update-btn appver-btn">App-Version aktualisieren</button>
        <div class="app-hinweis">Holt eine neue Fassung der App selbst. Ohne diesen Knopf greift ein Update erst, wenn du die App zweimal neu startest.</div>
      </div>
    </div>`;
  versionAnzeigen();   // asynchron, füllt .app-version nach
}

// ── Verlaufs-Wache (15.09.2026) ─────────────────────────────────────────────
// Nach der Google-Anmeldung liegt die Google-Seite im Browserverlauf DIREKT hinter
// der App. iOS erlaubt in Homescreen-Apps den Wisch vom linken Rand als „Zurueck".
// Gewann diese Systemgeste gegen `einstellungenWischen()`, landete man auf „Bei
// Google anmelden" – genau beim Wisch, der zurueck zur Uebersicht fuehren sollte.
// Einen fremden Eintrag im Verlauf kann die App nicht loeschen. Sie legt deshalb
// eigene Eintraege DAVOR, damit „Zurueck" nie ueber die App hinausreicht:
//   basis  ← der Eintrag, mit dem die App geladen wurde (replaceState)
//   app    ← darueber; „Zurueck" von hier landet auf basis und wird sofort erneuert
//   einst  ← solange die Einstellungen offen sind; „Zurueck" schliesst sie
// Folge am Desktop: die Zurueck-Taste des Browsers verlaesst die App nicht mehr
// mit einem Klick. Fuer eine Homescreen-App ist das der gewollte Zustand.
function verlaufsWacheStarten() {
  if (!window.history || !history.pushState) return;
  const url = location.pathname + location.search;
  try {
    history.replaceState({ hcc: 'basis' }, '', url);
    history.pushState({ hcc: 'app' }, '', url);
  } catch (_) { return; }
  window.addEventListener('popstate', (e) => {
    const s = e.state && e.state.hcc;
    // Jeder Schritt zurueck innerhalb der App schliesst zuerst die Einstellungen –
    // egal ob er von „einst" auf „app" oder (doppelt ausgeloest) bis „basis" ging.
    if (_einstOffen) einstellungenSchliessen(true);
    if (s === 'basis') {
      try { history.pushState({ hcc: 'app' }, '', url); } catch (_) {}
    } else if (s === 'einst') {
      // Vorwaerts-Geste zurueck auf einen alten Einstellungen-Eintrag: nicht wieder
      // oeffnen, nur den Eintrag entschaerfen.
      try { history.replaceState({ hcc: 'app' }, '', url); } catch (_) {}
    }
  });
}

function einstellungenOeffnen() {
  const el = document.getElementById('seite-einstellungen');
  if (!el || _einstOffen) return;
  _einstOffen = true;
  try { history.pushState({ hcc: 'einst' }, '', location.pathname + location.search); } catch (_) {}
  pgEinstellungen();
  el.hidden = false;
  // Layout erzwingen, BEVOR die Klasse kommt: sonst setzt der Browser Ausgangs- und
  // Zielzustand in denselben Stilrechnungsschritt und die Animation faellt aus.
  void el.offsetHeight;
  el.classList.add('offen');
  document.body.classList.add('einst-offen');
}

// `ausVerlauf`: der Aufruf kommt aus `popstate` – dann ist der Verlaufseintrag schon
// weg. Kommt er vom Knopf oder vom eigenen Wisch, wird der „einst"-Eintrag hier
// abgebaut; sonst stuende er noch da, und das naechste „Zurueck" taete nichts.
function einstellungenSchliessen(ausVerlauf) {
  const el = document.getElementById('seite-einstellungen');
  if (!el || !_einstOffen) return;
  _einstOffen = false;
  if (ausVerlauf !== true && history.state && history.state.hcc === 'einst') {
    try { history.back(); } catch (_) {}
  }
  el.style.transform = '';       // eine laufende Wischgeste zuruecksetzen
  el.classList.remove('offen');
  document.body.classList.remove('einst-offen');
  // Erst nach der Animation wegnehmen – sonst verschwindet sie schlagartig.
  setTimeout(() => { if (!_einstOffen) el.hidden = true; }, 300);
}

// ── Waagrecht wischen IM Diagramm blaettert den Zeitraum (auf Wunsch, 16.09.2026)
// Dieselbe Bewegung wie die Pfeile `‹ ›` der Zeitleiste: nach links = vorwaerts,
// nach rechts = zurueck, ein Schritt je Geste, begrenzt durch den Datenbestand.
// Es ruft `navNext`/`navPrev` auf — damit gelten Schrittweite (7 Tage bzw. ein Monat),
// die Wisch-Animation der Datenflaeche und `_datumSelbstGewaehlt` unveraendert.
//
// **Der eigentliche Punkt ist der Zielkonflikt:** waagrechte Wische gehoerten bisher
// dem Tab-Scroller. Ohne `touch-action: pan-y` auf `.chart-wrap` (siehe style.css)
// wechselt der Browser den Tab, bevor ein `touchmove` hier ankommt — die Angabe gibt
// der Diagrammflaeche nur noch die senkrechte Bewegung frei. **Folge:** Ein Tabwechsel
// per Wisch muss neben einem Diagramm beginnen (Kartenrand, Fusszeile, Hintergrund).
//
// Schwelle 45 px UND waagrecht deutlicher als senkrecht (Faktor 1.5), sonst blaettert
// schon ein leicht schraeges Scrollen.
let _diaWisch = null;
let _diaKlickSperreBis = 0;

// Die Diagramme des sichtbaren Tabs, die schon eine Zeichenflaeche haben.
function _wischCharts() {
  return (tabCharts[currentScreen] || []).map(id => charts[id]).filter(c => c && c.chartArea);
}
// Wie weit darf die Datenflaeche hoechstens ausschlagen? Derselbe Weg, den auch
// `_animNavSlide` beim Hereinkommen nutzt — sonst haette die Geste ein anderes Mass
// als ihre eigene Abschlussanimation.
// Bei Monatsbalken die Breite EINES Monats – gebraucht nur noch fuer `_wischAlpha` und
// den Monatsweg von `_animNavSlide`; der Zug selbst folgt dort dem Zeitstrahl-Wisch.
function _wischWeg(c) {
  const w = c.chartArea.right - c.chartArea.left;
  return _spaltenBereich() ? w / windowMonths() : Math.min(w * 0.42, 110);
}
// Deckkraft waehrend der Geste. Bei Monatsbalken bleibt die Flaeche voll deckend –
// die meisten Balken bleiben ja dieselben.
function _wischAlpha(c, off) {
  return _spaltenBereich() ? 1 : 1 - 0.45 * (Math.abs(off) / _wischWeg(c));
}
// Stand der Datenflaeche waehrend der Geste. Gedaempft, damit der Ausschlag begrenzt
// bleibt; am Rand des Datenbestands staerker — das Gummiband sagt „hier ist Schluss",
// ohne dass eine Meldung noetig waere.
// Die SCHWELLE wird abgezogen: sonst spraenge die Flaeche im Moment der Erkennung
// sofort um 31 px (45 x 0.7) — die Bewegung soll bei null beginnen und dem Finger
// von dort folgen.
const WISCH_SCHWELLE = 45;

// ── Zeitstrahl-Wisch bei Monatsbalken (auf Wunsch, 18.09.2026, Vorschlag 5) ──────
// Die Flaeche folgt dem Finger 1:1 ueber beliebig viele Monate – bis zum Rand des
// Datenbestands (`_maxMonate`), danach Gummiband. Beim Loslassen rastet sie auf ganze
// Monate ein: gerundet, mindestens einer (wie jeder Wisch bisher), und `_navSchritt`
// blaettert in EINEM Schritt so viele Monate. Monatsnamen, Zahlen und Markierung
// wandern schon beim Ziehen mit – deshalb laeuft der Zug hier ueber `$spalten`
// (mit `zug: true`) statt ueber `$navslide`, das nur die Datensaetze verschiebt.
// Hilfslinien bleiben stehen.
// Gemessen wird in MONATEN, nicht in Pixeln: die Monatsbreite des Diagramms, in dem die
// Geste begann, ist das Mass; jedes Diagramm des Tabs rueckt um denselben Bruchteil
// seiner eigenen Monatsbreite. So bleiben alle Diagramme beim selben Monat, auch wenn
// ihre y-Achsen verschieden breit sind.
// Grenze, die man kennen muss: die Monate, die hereinkommen, sind waehrend des Ziehens
// NOCH NICHT gezeichnet – das Diagramm kennt nur sein Fenster. Die Flaeche dort bleibt
// leer, bis losgelassen wird. Was kommt, sagt der Zeitraum im Kartenkopf
// (`_zeitraumVorschau`), der waehrend des Ziehens den Zielzeitraum in der Tabfarbe zeigt.
function _monatsBreite(c) { return (c.chartArea.right - c.chartArea.left) / windowMonths(); }
function _wischMonate(z) {
  if (!z.refBreite) {
    const ref = z.charts.find(c => z.karte && z.karte.contains(c.canvas)) || z.charts[0];
    z.refBreite = ref && ref.chartArea ? _monatsBreite(ref) : 60;
  }
  const roh = Math.max(0, Math.abs(z.dx) - WISCH_SCHWELLE) / z.refBreite;
  const frei = (z.max && z.max[z.richtung]) || 0;
  return roh <= frei ? roh : frei + Math.min((roh - frei) * 0.25, 1);
}
// Auf wie viele Monate rastet die Geste ein? 0 = gar nicht (Rand des Datenbestands).
function _wischZiel(z) {
  const frei = (z.max && z.max[z.richtung]) || 0;
  return frei ? Math.max(1, Math.min(frei, Math.round(_wischMonate(z)))) : 0;
}
function _wischZeichnenMonate(z) {
  const monate = _wischMonate(z), vz = Math.sign(z.dx);
  z.charts.forEach(c => {
    if (!c.chartArea) return;
    _xBeschriftungMitziehen(c);
    const off = vz * monate * _monatsBreite(c);
    if (c.$spalten && c.$spalten.zug) c.$spalten.off = off;
    else c.$spalten = { off, delta: 0, streifen: null, zug: true, labelLinks: _labelLinks(c) };
    try { c.draw(); } catch (_) {}
  });
  _zeitraumVorschau(z);
}
// Der Zielzeitraum im Kartenkopf, solange gezogen wird. `referenceDate` wird dafuer
// nur fuer den Aufruf von `zeitraumText()` umgestellt und sofort zurueckgesetzt.
function _zeitraumVorschau(z) {
  const k = _wischZiel(z);
  const schluessel = k ? z.richtung * k : 0;
  if (z.vorschau === schluessel) return;
  z.vorschau = schluessel;
  let text = null;
  const ziel = k ? _navZielMonate(z.richtung, k) : null;
  if (ziel) {
    const alt = referenceDate;
    referenceDate = ziel;
    try { text = zeitraumText(); } finally { referenceDate = alt; }
  }
  document.querySelectorAll('#screen-' + currentScreen + ' .zeitraum-text').forEach(el => {
    if (el.dataset.vorher == null) el.dataset.vorher = el.textContent;
    el.textContent = text || el.dataset.vorher;
    el.classList.toggle('vorschau', !!text);
  });
}
function _zeitraumVorschauEnde() {
  document.querySelectorAll('#screen-' + currentScreen + ' .zeitraum-text').forEach(el => {
    if (el.dataset.vorher != null) { el.textContent = el.dataset.vorher; delete el.dataset.vorher; }
    el.classList.remove('vorschau');
  });
}

function _wischZeichnen(z) {
  if (_spaltenBereich()) { _wischZeichnenMonate(z); return; }
  const daempfung = z.moeglich ? 0.9 : 0.25;
  z.charts.forEach(c => {
    if (!c.chartArea) return;
    const weg = _wischWeg(c);
    const ueber = Math.max(0, Math.abs(z.dx) - WISCH_SCHWELLE);
    const off = Math.sign(z.dx) * Math.min(ueber * daempfung, weg);
    c.$navslide = { offset: off, alpha: _wischAlpha(c, off) };
    try { c.draw(); } catch (_) {}
  });
}
// Gemeinsamer Ablauf fuer „hinausgleiten" und „zurueckfedern": beide bewegen
// dieselbe Groesse und teilen sich `_navSlideRAF` mit `_animNavSlide`, damit nie zwei
// Animationen gleichzeitig an denselben Diagrammen ziehen.
function _wischAnimieren(charts, dauer, proSchritt, fertig) {
  if (_navSlideRAF) { cancelAnimationFrame(_navSlideRAF); _navSlideRAF = null; }
  const start = performance.now();
  const schritt = (jetzt) => {
    const t = Math.min(1, (jetzt - start) / dauer);
    const e = 1 - Math.pow(1 - t, 3);            // easeOutCubic, wie beim Hereinkommen
    charts.forEach(c => { if (!c.chartArea) return; proSchritt(c, e); try { c.draw(); } catch (_) {} });
    if (t < 1) { _navSlideRAF = requestAnimationFrame(schritt); }
    else { _navSlideRAF = null; if (fertig) fertig(); }
  };
  _navSlideRAF = requestAnimationFrame(schritt);
}
function _wischZurueckfedern(charts) {
  _zeitraumVorschauEnde();
  // Bei Monatsbalken liegt der Zug in `$spalten` (siehe Zeitstrahl-Wisch).
  const spalten = charts.some(c => c.$spalten && c.$spalten.zug);
  const von = charts.map(c => spalten ? (c.$spalten ? c.$spalten.off : 0) : (c.$navslide ? c.$navslide.offset : 0));
  _wischAnimieren(charts, 220,
    (c, e) => { const i = charts.indexOf(c), off = von[i] * (1 - e);
                if (spalten) { if (c.$spalten) c.$spalten.off = off; }
                else c.$navslide = { offset: off, alpha: _wischAlpha(c, off) }; },
    () => charts.forEach(c => { delete c.$navslide; if (spalten) delete c.$spalten; try { c.draw(); } catch (_) {} }));
}
// Der alte Stand gleitet in Wischrichtung aus dem Bild; erst DANACH wird geblaettert,
// und `_animNavSlide` holt den neuen von der anderen Seite herein.
function _wischHinaus(charts, richtung, fertig) {
  const von = charts.map(c => (c.$navslide ? c.$navslide.offset : 0));
  _wischAnimieren(charts, 150,
    (c, e) => { const i = charts.indexOf(c);
                const ziel = -richtung * (c.chartArea.right - c.chartArea.left);
                c.$navslide = { offset: von[i] + (ziel - von[i]) * e, alpha: (1 - e) * 0.9 }; },
    fertig);
}

function diagrammWischen() {
  const ruhig = bewegungAus;

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { _diaWisch = null; return; }
    const flaeche = e.target.closest && e.target.closest('.chart-wrap');
    if (!flaeche) { _diaWisch = null; return; }
    _spaltenAbbrechen();   // eine noch laufende Spalten-Bewegung zuerst beenden
    _diaWisch = { x: e.touches[0].clientX, y: e.touches[0].clientY,
                  karte: flaeche.closest('.chart-card'), richtung: 0, dx: 0,
                  charts: _wischCharts(), moeglich: true, frameOffen: false };
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    const z = _diaWisch;
    if (!z || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - z.x, dy = e.touches[0].clientY - z.y;
    if (Math.abs(dx) < WISCH_SCHWELLE || Math.abs(dx) < Math.abs(dy) * 1.5) {
      // Zurueck unter die Schwelle: ein schon gezeigter Zug federt beim Loslassen zurueck.
      // (Vorher blieb die Flaeche dann mit dem letzten Versatz stehen – in jedem Bereich.)
      if (z.richtung) z.zurueck = true;
      z.richtung = 0; return;
    }
    z.zurueck = false;
    z.richtung = dx < 0 ? 1 : -1;
    z.dx = dx;
    z.moeglich = !!_navZiel(z.richtung);
    // Zeitstrahl: wie weit darf es in diese Richtung gehen? Einmal je Richtung ermittelt.
    if (_spaltenBereich()) {
      z.max = z.max || {};
      if (z.max[z.richtung] == null) z.max[z.richtung] = _maxMonate(z.richtung);
    }
    if (ruhig() || z.frameOffen) return;
    // Hoechstens eine Zeichnung je Bild: `touchmove` feuert oefter als der Bildschirm
    // sich auffrischt, und jedes `draw()` zeichnet alle Diagramme des Tabs neu.
    z.frameOffen = true;
    requestAnimationFrame(() => { z.frameOffen = false; if (_diaWisch === z) _wischZeichnen(z); });
  }, { passive: true });

  // Geblaettert wird beim LOSLASSEN — wie ein Tipp auf den Pfeil, der auch erst beim
  // Abheben ausloest. Das ist nicht nur Geschmack: navigiert man im `touchmove`, baut
  // `_refreshAfterStateChange` die Karte UNTER DEM FINGER neu auf; die weiteren
  // `touchmove`/`touchend` gehen dann an ein Element, das nicht mehr im Dokument
  // haengt, und erreichen diese Listener nie.
  const ende = () => {
    const z = _diaWisch;
    _diaWisch = null;
    // Unter die Schwelle zurueckgezogen: nichts blaettern, gezeigten Zug zuruecknehmen.
    if (z && !z.richtung && z.zurueck) { _diaKlickSperreBis = Date.now() + 450; _wischZurueckfedern(z.charts); return; }
    if (!z || !z.richtung) return;
    _diaKlickSperreBis = Date.now() + 450;
    // Am Rand des Datenbestands federt die Flaeche nur zurueck — wie ein Pfeil, der
    // dort nichts tut.
    if (!z.moeglich) { if (!ruhig()) _wischZurueckfedern(z.charts); return; }
    // Zeitstrahl: auf ganze Monate einrasten und in EINEM Schritt so viele blaettern.
    const schritte = _spaltenBereich() ? Math.max(1, _wischZiel(z)) : 1;
    const blaettern = () => {
      // Denselben Blickanker setzen wie ein Pfeil-Tipp: der Neuaufbau aendert die
      // Gesamthoehe, und ohne Anker spraenge die Ansicht unter dem Finger weg.
      blickAnkerMerken(z.karte);
      _navSchritt(z.richtung, schritte);
    };
    // Monatsbalken: nicht erst hinausgleiten – der Schritt setzt die Bewegung des
    // Fingers direkt fort (`_spaltenMerken` liest den Versatz als `zug`).
    if (ruhig() || _spaltenBereich()) { blaettern(); return; }
    _wischHinaus(z.charts, z.richtung, blaettern);
  };
  document.addEventListener('touchend', ende, { passive: true });
  document.addEventListener('touchcancel', () => {
    const z = _diaWisch; _diaWisch = null;
    if (z && z.richtung && !ruhig()) _wischZurueckfedern(z.charts);
  }, { passive: true });

  // Nach dem Blaettern folgt auf iOS noch ein Klick. Der darf weder eine Saeule
  // markieren noch (ueber den Kartentitel) die Datenbeschriftungen umschalten.
  document.addEventListener('click', (e) => {
    if (Date.now() < _diaKlickSperreBis && e.target.closest && e.target.closest('.chart-card')) {
      e.preventDefault(); e.stopPropagation();
    }
  }, true);
}
// Wisch vom linken Bildschirmrand = zurueck, wie in iOS. Bewusst nur vom Rand aus
// (<= 28 px): weiter innen gehoert die waagrechte Bewegung dem Inhalt.
function einstellungenWischen() {
  const el = document.getElementById('seite-einstellungen');
  if (!el) return;
  let startX = 0, dx = 0, aktiv = false, klickSperreBis = 0;
  // Zweite Sicherung: Beginnt die Geste am Rand ueber einem Knopf und bewegt sich nur
  // wenig, erzeugt iOS nach dem Loslassen einen Klick – der Rand liegt keine 28 px
  // vom Knopf „Mit Google anmelden" entfernt. Nach jeder echten Wischbewegung wird
  // der naechste Klick auf der Seite deshalb verworfen (Capture-Phase, also bevor
  // die Delegation am body ihn sieht).
  el.addEventListener('click', (e) => {
    if (Date.now() < klickSperreBis) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  el.addEventListener('touchstart', (e) => {
    if (!_einstOffen || e.touches.length !== 1) return;
    const x = e.touches[0].clientX;
    if (x > 28) return;
    aktiv = true; startX = x; dx = 0;
    el.style.transition = 'none';
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!aktiv) return;
    dx = Math.max(0, e.touches[0].clientX - startX);   // nur nach rechts
    el.style.transform = 'translateX(' + dx + 'px)';
  }, { passive: true });
  const ende = () => {
    if (!aktiv) return;
    aktiv = false;
    el.style.transition = '';
    if (dx > 8) klickSperreBis = Date.now() + 450;
    // Ab einem Drittel der Breite gilt die Geste als „zurueck", sonst schnappt die
    // Seite zurueck – dieselbe Schwelle wie in iOS.
    if (dx > el.getBoundingClientRect().width * 0.3) einstellungenSchliessen();
    else el.style.transform = '';
  };
  el.addEventListener('touchend', ende);
  el.addEventListener('touchcancel', ende);
}

// Welche Tabs haben ueberhaupt etwas zum Aufklappen – und wie heisst es?
// EINE Quelle fuer Knopf, Zustand und Umschalten; sonst muesste jede der drei
// Stellen ihre eigene Fallunterscheidung fuehren. Seit 14.09.2026 hat jeder Tab einen
// Eintrag; im Training klappt der Knopf die Wochentag/Wochenende-Fusszeilen und die
// Trainings-Einblicke. Ein optionales `sichtbar()` blendet den Knopf je Zustand aus
// (derzeit nutzt es kein Tab).
const AUSKLAPP = Object.fromEntries(Object.keys(_weitereOffen).map(tab => [tab, {
  titel: 'Weitere Auswertungen',
  offen: () => _weitereOffen[tab],
  um:    () => { _weitereOffen[tab] = !_weitereOffen[tab]; }
}]));

// ── Schlaf ─────────────────────────────────────────────
// Schlafschuld als Text: Defizit mit "−", Überschuss mit "+".
function schuldText(h) { return h == null ? '—' : (h > 0 ? '−' + alsStdMin(h) : '+' + alsStdMin(-h)); }
function schuldFarbe(h) { return h == null ? 'var(--txt3)' : (h > 0 ? '#EF4444' : '#10B981'); }

// Ein- oder Aufwachzeit je Säule – ausgerichtet an den Zeitraum-Schlüsseln des
// Schlafdauer-Diagramms: je Tag der Wert der Nacht, je Monat die mittlere Uhrzeit.
function schlafzeitReihe(D, keys, keyTyp, feld, einschlafen) {
  if (keyTyp === 'tag') {
    const byDate = {}; D.forEach(r => { byDate[r.date] = r; });
    return keys.map(d => parseTV(byDate[d]?.[feld] ?? null));
  }
  return keys.map(k => avgCircTime(D.filter(r => r.date.startsWith(k)), feld, einschlafen));
}

function pgSchlaf() {
  const D=filtered(), P=prevPeriod();
  const last14sl = allData.slice(-14);
  const sleepDebt = calculateSleepDebt(last14sl);
  const debtLvl = sleepDebtLevel(sleepDebt.perNight);
  const slD=mittel(D,'sleepTotal');
  const scD=mittel(D,'sleepScore'), scP=mittel(P,'sleepScore');
  const dpD=mittel(D,'sleepDeep');
  const remD=mittel(D,'sleepRem');
  const lD=mittel(D,'sleepCore');
  const slRows=D.filter(r=>r.sleepTotal!=null);
  const slStd=standardabw(slRows,'sleepTotal');
  const slZielN = slRows.filter(r=>zielErfuellt('sleepTotal', r.sleepTotal)).length;
  const slMax=slRows.length?Math.max(...slRows.map(r=>r.sleepTotal)):null;
  const slMin=slRows.length?Math.min(...slRows.map(r=>r.sleepTotal)):null;
  // Einzelne Nächte für den Tooltip der Schlafschuld
  const debtNaechte=last14sl.filter(r=>r.sleepTotal!=null);
  const debtTooltipRows=debtNaechte.map(r=>{
    const d=SLEEP_TARGET_H-r.sleepTotal;
    return `<div class="debt-tt-row"><span class="debt-tt-date">${wochentagKurz(r.date)} ${fmtWeek(r.date)}</span><span class="debt-tt-slept">${alsStdMin(r.sleepTotal)}</span><span class="debt-tt-d ${d>0?'neg':'pos'}">${d>0?'-'+alsStdMin(d):'+'+alsStdMin(-d)}</span></div>`;
  }).join('');
  const {labels:tL,align:tA,hasData:tHD,keys:tKeys,keyTyp:tKeyTyp}=timeDim(D);
  const tdL=timeDim(D,true);
  const slMa=tA('sleepTotal');
  const dpMa=tA('sleepDeep');
  const remMa=tA('sleepRem');
  const lMa=tA('sleepCore');
  const awMa=tA('sleepAwake');
  const scMa=tdL.align('sleepScore');
  const hasPhases=D.some(r=>r.sleepDeep!=null||r.sleepRem!=null||r.sleepCore!=null);
  const hasAwake=D.some(r=>r.sleepAwake!=null);
  const hasScore=D.some(r=>r.sleepScore!=null);
  const awD=mittel(D,'sleepAwake');

  const total=slD||1;
  const anteil=v=>v!=null?(v/total*100).toFixed(0):null;
  const dpPct=anteil(dpD), remPct=anteil(remD), lPct=anteil(lD), awPct=anteil(awD);

  // Nächte je Dauer-Bereich
  const nSl=(von,bis)=>slRows.filter(r=>r.sleepTotal>=von&&r.sleepTotal<bis).length;
  const nTot=slRows.length||1;

  const slSplit=splitWeekWknd(slRows);
  const slWeek=mittel(slSplit.wkd,'sleepTotal');
  const slWknd=mittel(slSplit.wknd,'sleepTotal');

  const [consLabel,consColor]=konsistenzStufe(slStd, 0.5, 0.75, 1.0, 'Inkonsistent');

  // Ein- und Aufwachzeiten für den Tooltip des Schlafdauer-Diagramms
  const slStartArr=schlafzeitReihe(D, tKeys, tKeyTyp, 'sleepStart', true);
  const slEndArr=schlafzeitReihe(D, tKeys, tKeyTyp, 'sleepEnd', false);

  document.getElementById("screen-schlaf").innerHTML=`
    ${pgBanner('🌙','Schlaf')}
    ${hasScore?`<div class="kpi-grid kpi-grid-1">${kpiCard({icon:'',label:'Ø Schlaf-Score',value:zahl(scD,0),unit:'',delta:prozentDiff(scD,scP),color:'var(--sleep)'})}</div>`:''}

      <div class="chart-card">
        <h3>${is7D()?'Schlafdauer letzte 7 Tage':'Schlafdauer pro Monat'}</h3>
        <div class="chart-legend">
          <div class="cl-item"><span class="cl-dot" style="background:rgba(124,58,237,.85)"></span>erreicht</div>
          <div class="cl-item"><span class="cl-dot" style="background:rgba(124,58,237,.32)"></span>verfehlt</div>
          ${hlLegende('c-sl-dur|ziel','Ziel','#10B981',false)}
          ${hlLegende('c-sl-dur|oe','Ø','rgba(124,58,237,.85)')}
        </div>
        <div class="chart-wrap"><canvas id="c-sl-dur"></canvas></div>
        ${slRows.length>0||slWeek!=null||slWknd!=null?`<div class="stats-list diagramm-fuss">
          ${slRows.length>0?`${statZeile(`Schlafziel erreicht`, `${slZielN} <span style="color:var(--txt3)">von ${slRows.length} (${Math.round(slZielN/slRows.length*100)}%)</span>`, slZielN>0?'#10B981':null)}`:''}
          ${istYoY() ? yoyZeilen([{ werte: yoyWerte(D, r => r.sleepTotal, 'mittel'), richtung: ZIELE.sleepTotal.richtung }]) : ''}
          ${istYoY() ? '' : statZeile(oeLabel(), `${slD!=null?alsStdMin(slD):'—'}`)}
          ${istYoY() ? '' : fussMehr('schlaf',
            statZeile(`Ø Wochentag (Mo–Fr)`, `${slWeek!=null?alsStdMin(slWeek):'—'}`)
          + statZeile(`Ø Wochenende (Sa–So)`, `${slWknd!=null?alsStdMin(slWknd):'—'}`))}
        </div>`:''}
      </div>

      ${weitereAuf('schlaf')}
      <!-- Querformat: Schlafqualitaet und Schlafschuld untereinander NEBEN dem
           Schlafphasen-Verlauf (auf Wunsch, 14.09.2026). Die Klasse "mit-phasen" nur,
           wenn es das Diagramm gibt – sonst stuende das Paar in einer halben Spalte. -->
      <div class="schlaf-block${hasPhases?' mit-phasen':''}">
      <div class="two-col-eq">
      <div class="chart-card split2">
        <h3>Schlafqualität-Verteilung</h3>
        <div class="goal-list">
          ${verteilungZeile('&gt; 8.5h', '#10B981', nSl(8.5,Infinity), nTot)}
          ${verteilungZeile('7 – 8.5h', '#84CC16', nSl(7,8.5), nTot)}
          ${verteilungZeile('6 – 7h', '#EAB308', nSl(6,7), nTot)}
          ${verteilungZeile('≤ 6h', '#EF4444', nSl(-Infinity,6), nTot)}
        </div>
        <div class="stats-list">
          ${statZeile(`Beste Nacht`, `${alsStdMin(slMax)}`, `#10B981`)}
          ${statZeile(`Kürzeste Nacht`, `${alsStdMin(slMin)}`, `#EF4444`)}
          ${statZeile(`Konsistenz`, consLabel, consColor)}
          ${messpunkteZeile(slRows.length, D.length)}
        </div>
      </div>

      <div class="chart-card">
        <div class="chart-head"><h3>Schlafschuld</h3>${scopeBadge('letzte 14 Nächte')}</div>
        <div class="stats-list">
          ${statZeile(`Zielschlaf pro Nacht`, `${alsStdMin(SLEEP_TARGET_H)}`)}
          ${statZeile(`Letzte Nacht`, schuldText(sleepDebt.last), schuldFarbe(sleepDebt.last))}
          ${statZeile(`Ø pro Nacht`, schuldText(sleepDebt.perNight), debtLvl.color)}
          ${statZeile(`Summe über ${sleepDebt.nDays} Nächte`, schuldText(sleepDebt.total), schuldFarbe(sleepDebt.total))}
        </div>
        <div class="debt-bar-wrap">
          ${sleepDebt.perNight!=null?`<div style="font-size:.66rem;color:var(--txt3);margin-bottom:.3rem">${debtLvl.label} · Balken voll bei Ø ${alsStdMin(SLEEP_DEBT_FULL_BAR_H)} Defizit pro Nacht</div>
          <div class="debt-tt-wrap" tabindex="0" role="button" aria-label="Zusammensetzung der Schlafschuld anzeigen">
            <div class="debt-bar-bg"><div class="debt-bar-fill" style="width:${Math.min(100,Math.max(0,(sleepDebt.perNight/SLEEP_DEBT_FULL_BAR_H)*100))}%;background:${debtLvl.color}"></div></div>
            <div class="debt-tt">
              <div class="debt-tt-title">Zusammensetzung – ${debtNaechte.length} Nächte · Ziel ${alsStdMin(SLEEP_TARGET_H)}/Nacht</div>
              <div class="debt-tt-hd"><span>Datum</span><span>Geschlafen</span><span style="text-align:right">Schuld / Plus</span></div>
              ${debtTooltipRows}
            </div>
          </div>`:''}
        </div>
      </div>
      </div>


    <!-- Verlauf steht auf Wunsch VOR der Aufteilung: erst der zeitliche Verlauf,
         dann die Zusammenfassung als Durchschnitt. -->
    ${hasPhases?`<div class="chart-card">
      <h3>Schlafphasen-Verlauf</h3>
      <div class="chart-legend">
        <div class="cl-item"><span class="cl-dot" style="background:#F97316"></span>Wach</div>
        <div class="cl-item"><span class="cl-dot" style="background:#5BC8FA"></span>REM</div>
        <div class="cl-item"><span class="cl-dot" style="background:#2186E8"></span>Leicht</div>
        <div class="cl-item"><span class="cl-dot" style="background:#1E1B6E"></span>Tief</div>
      </div>
      <div class="chart-wrap"><canvas id="c-sl-phases"></canvas></div>
      ${istYoY() ? `<div class="stats-list diagramm-fuss">${yoyZeilen([
          { werte: yoyWerte(D, r => r.sleepRem, 'mittel'), vor: 'REM ' },
          { werte: yoyWerte(D, r => r.sleepDeep, 'mittel'), vor: 'Tief ' }])}</div>`
      : awD!=null||remD!=null||lD!=null||dpD!=null?`<div class="stats-list diagramm-fuss">
        ${awD!=null?`${statZeile(oeLabel('Wach'), `${alsStdMin(awD)} – ${awPct}%`)}`:''}
        ${remD!=null?`${statZeile(oeLabel('REM-Schlaf'), `${alsStdMin(remD)} – <span style="color:${parseInt(remPct)>=20?'#10B981':'#F97316'}">${remPct}%</span> <span style="color:var(--txt3)">(Ziel 20–25%)</span>`)}`:''}
        ${lD!=null?`${statZeile(oeLabel('Leichtschlaf'), `${alsStdMin(lD)} – ${lPct}%`)}`:''}
        ${dpD!=null?`${statZeile(oeLabel('Tiefschlaf'), `${alsStdMin(dpD)} – <span style="color:${parseInt(dpPct)>=15?'#10B981':'#F97316'}">${dpPct}%</span> <span style="color:var(--txt3)">(Ziel 15–20%)</span>`)}`:''}
      </div>`:''}
    </div>`:''}
      </div>


    ${hasScore?`<div class="chart-card"><h3>Schlaf-Score Verlauf</h3><div class="chart-legend" aria-hidden="true"></div><div class="chart-wrap"><canvas id="c-sl-score"></canvas></div></div>`:''}
    ${_weitereOffen.schlaf ? einblickeHTML(schlafInsights()) : ''}
    </div>`;


  if(tHD){
    // Y-Achse flexibel: nicht ab 0, sondern an den Datenbereich angeschmiegt, damit
    // die Variation zwischen den Nächten sichtbar wird (Schritt = 1 Std.).
    const _slV=slMa.filter(v=>v!=null);
    const _slY={...achseY,ticks:{...achseY.ticks,stepSize:1,callback:v=>Math.floor(v)+'h'}};
    if(_slV.length){
      _slY.min=Math.max(0, Math.floor(Math.min(..._slV) - 0.5));
      _slY.max=Math.ceil(Math.max(..._slV) + 0.2);
    } else { _slY.min=0; }
    // Das Ziel MUSS im Sichtbereich liegen. Schläft man eine Woche lang durchgehend
    // mehr als 7h30, läge die Farbnaht sonst unterhalb der Achse – alle Balken sähen
    // einfarbig aus und die Zielerreichung wäre nicht mehr ablesbar.
    _slY.min = Math.min(_slY.min, ZIELE.sleepTotal.ziel - 0.5);
    // Die Farbe gilt dem GANZEN Balken, nicht mehr einzelnen Segmenten: kräftig, wenn
    // die Nacht das Ziel erreicht, hell wenn nicht. Zuvor war jeder Balken bis 7h30
    // kräftig und darüber hell – man sah den Überschuss, aber nicht auf einen Blick,
    // welche Nächte das Ziel verfehlten. Den Zielwert markiert jetzt die grüne Linie.
    const _slZiel = ZIELE.sleepTotal.ziel;
    const _slErreicht = i => slMa[i]!=null && slMa[i] >= _slZiel;
    const _slFarbe = ctx => _slErreicht(ctx.dataIndex) ? 'rgba(124,58,237,.85)' : 'rgba(124,58,237,.32)';
    zeichneDiagramm('c-sl-dur',{__keys:tKeys,__keyTyp:tKeyTyp,
      // "7h 25m" statt "7.4" – dasselbe Format wie in der Ziele-Karte und den
      // Minikacheln, damit dieselbe Nacht ueberall gleich aussieht.
      __werteFmt:v=>v?stdMinLabel(v):'',
      type:'bar',data:{labels:tL,datasets:[
      // EIN Balken je Nacht. Frueher waren es zwei gestapelte Segmente ("bis Ziel" /
      // "ueber Ziel") – ein Rest aus der Zeit, als sie verschiedene Farben trugen.
      // Seit beide dieselbe Farbe haben, war der Stapel nur noch schaedlich: Chart.js
      // kappt die Rundung an der Hoehe des OBEREN Segments, und das ist je nach
      // Ueberschuss mal 3, mal 15 Pixel hoch – dieselbe Kante sah dadurch von Balken
      // zu Balken anders aus.
      {label:'Schlafdauer',data:slMa,backgroundColor:_slFarbe,stack:'s',borderRadius:BALKEN_RADIUS},
      // Beide Hilfslinien brauchen einen EIGENEN Stapel: sonst addiert Chart.js sie auf
      // die Balken darunter und sie lägen bei 15h statt bei 7h30.
      // Ziel: durchgezogen und im Grün, das die App für erreichte Ziele nutzt.
      ...(hlAn('c-sl-dur|ziel') ? [
      {label:'Ziel Schlaf',data:tL.map(()=>_slZiel),borderColor:'#10B981',borderWidth:1.5,
       pointRadius:0,tension:0,fill:false,type:'line',spanGaps:true,stack:'ziel'}] : []),
      // Ø gestrichelt in der Farbe der Balken.
      ...(slD!=null&&hlAn('c-sl-dur|oe')?[{label:'Ø Schlafdauer',data:tL.map(()=>slD),borderColor:'rgba(124,58,237,.85)',
       borderDash:[5,4],borderWidth:1.5,pointRadius:0,tension:0,fill:false,type:'line',
       spanGaps:true,stack:'ziel-avg'}]:[])
    ]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>{
        // Nur der Balken selbst, nicht die Hilfslinien.
        if(ctx.datasetIndex!==0) return null;
        const i=ctx.dataIndex;
        const gesamt=slMa[i];
        if(gesamt==null) return null;
        const _isAvg=timeRange!=='7d'&&timeRange!=='1m';
        const fehlt=_slZiel-gesamt;
        const lines=[`${_isAvg?'Ø ':''}${alsStdMin(gesamt)}`];
        lines.push(fehlt>0 ? `${alsStdMin(fehlt)} unter Ziel` : `${alsStdMin(-fehlt)} über Ziel`);
        if(slStartArr[i]!=null) lines.push((_isAvg?'Ø ':'')+('Eingeschlafen: '+fmtHHMM(slStartArr[i])));
        if(slEndArr[i]!=null) lines.push((_isAvg?'Ø ':'')+('Aufgewacht: '+fmtHHMM(slEndArr[i])));
        return lines;
      }}}},scales:{x:{...achseX,stacked:true},y:{..._slY,stacked:true}}}});
    if(hasPhases){
      const _phDs=[
        {label:'Tiefschlaf',data:dpMa,backgroundColor:'#1E1B6E',borderRadius:BALKEN_RADIUS,stack:'s'},
        {label:'Leichtschlaf',data:lMa,backgroundColor:'#2186E8',borderRadius:BALKEN_RADIUS,stack:'s'},
        {label:'REM',data:remMa,backgroundColor:'#5BC8FA',borderRadius:BALKEN_RADIUS,stack:'s'}
      ];
      if(hasAwake) _phDs.push({label:'Wach',data:awMa,backgroundColor:'#F97316',borderRadius:BALKEN_RADIUS,stack:'s'});
      zeichneDiagramm('c-sl-phases',{__keys:tKeys,__keyTyp:tKeyTyp,
        // Bei gestapelten Balken sitzt die Beschriftung auf der Oberkante des
        // jeweiligen Segments und damit mitten im Balken – das las sich nicht als
        // Wert, sondern als Stoerung. Deshalb standardmaessig AUS; der Titel-Tipp
        // holt sie bei Bedarf trotzdem hervor.
        // Dieselbe Schreibweise wie in Schlafdauer und Trainingszeit (12.09.2026,
        // auf Wunsch): vorher standen hier Dezimalstunden ("1.5") – zwei Einheiten
        // fuer dieselbe Groesse in benachbarten Diagrammen.
        __werteFmt:v=>v>=0.5?stdMinLabel(v):'',
        __werteAusStandard:true,
        type:'bar',data:{labels:tL,datasets:_phDs},options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,itemSort:(a,b)=>b.datasetIndex-a.datasetIndex,callbacks:{
          label:ctx=>{
            if(ctx.raw==null)return null;
            const total=ctx.chart.data.datasets.reduce((s,ds)=>s+(ds.data[ctx.dataIndex]??0),0);
            const anteil=total>0?Math.round(ctx.raw/total*100):0;
            return `${ctx.dataset.label}: ${alsStdMin(ctx.raw)} (${anteil}%)`;
          }
        }}},
        scales:{x:{...achseX,stacked:true},y:{...achseY,stacked:true,ticks:{...achseY.ticks,callback:v=>Math.floor(v)+'h'}}}}});
    }
    if(hasScore) zeichneDiagramm('c-sl-score',{__keys:tdL.keys,__keyTyp:tdL.keyTyp,
      __werteFmt:v=>String(Math.round(v)),
      type:'line',data:{labels:tdL.labels,datasets:[{data:scMa,borderColor:'#7C3AED',backgroundColor:'rgba(124,58,237,.08)',tension:.3,fill:true,pointRadius:3}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:achseX,y:{...achseY,min:0,max:100}}}});
  }
}

// ── Training ───────────────────────────────────────────
async function pgTraining() {
  const D=filtered();

  // 1) Auf den Abschluss des Workout-Ladevorgangs warten – begrenzt, damit ein
  //    fehlgeschlagener Abruf nicht in einem dauerhaften Ladezustand endet.
  //    Muss VOR der Auswertung stehen: sonst würde mit noch leerem workoutData gerechnet.
  if(!workoutSheetReady){
    document.getElementById("screen-training").innerHTML=`<div style="display:flex;align-items:center;justify-content:center;gap:.6rem;height:180px;color:var(--txt3);font-size:.88rem">⏳ Workout-Daten werden geladen…</div>`;
    await _awaitWorkoutSheet(10000);
  }
  const woProblem = !workoutSheetReady
    ? 'Die Workout-Daten konnten nicht rechtzeitig geladen werden.'
    : workoutLoadError;
  if(woProblem){
    document.getElementById("screen-training").innerHTML=`
      ${pgBanner('🏃','Training')}
      <div class="no-data">
        <strong>Workout-Daten nicht verfügbar</strong>
        ${esc(woProblem)}
        <div class="field-hint" style="margin-top:.4rem">Quelle: <code>Workout Data</code>-Google-Sheet. Erneut versuchen mit „Daten aktualisieren" unter Übersicht → Einstellungen.</div>
      </div>`;
    return;
  }

  // ── Trainingstage im aktuellen Filterzeitraum ──
  // Quelle ist ausschließlich das Workout-Sheet (workoutData); in zeitlicher
  // Reihenfolge die Grundlage für das Pace-Diagramm.
  const _healthDates=new Set(D.map(r=>r.date));
  const trainDates=Object.keys(workoutData).filter(d=>_healthDates.has(d)).sort();
  const trendLabels=trainDates.map(tagLabel);   // je Trainingstag: Wochentag + Datum
  // Pace ausschliesslich aus `Speed (km/h)` des Workout-Sheets (Wunsch 05.09.2026):
  // Strecke UND Pace stammen damit aus derselben Messung.
  const trendPace=trainDates.map(d=>{
    const kmh = workoutData[d]?.avgSpeedKph>0 ? workoutData[d].avgSpeedKph : null;
    return kmh!=null ? Math.round(paceFromSpeed(kmh)*100)/100 : null;
  });

  // Wochentag/Wochenende: Strecke je Trainingstag, Dauer je Tag mit Eintrag.
  const strSplit=splitWeekWknd(trainDates.map(d=>({date:d})));
  const _strMittel=rows=>mittel(rows.map(r=>workoutData[r.date]?.distanceKm ?? null));
  const distWkdAvg=_strMittel(strSplit.wkd);
  const distWkndAvg=_strMittel(strSplit.wknd);
  const woMinSplit=splitWeekWknd(D.filter(r=>workoutData[r.date]?.durationMin!=null));
  const _woDur=rows=>rows.map(r=>workoutData[r.date].durationMin);
  const minWeek=mittel(_woDur(woMinSplit.wkd));
  const minWknd=mittel(_woDur(woMinSplit.wknd));

  const {labels:tL,keys:tKeys,keyTyp:tKeyTyp}=timeDim(D);
  // Zwei verschiedene Fragen, deshalb zwei Groessen:
  //
  // `_fensterWochen` — wie viele Wochen umfasst das ANGEZEIGTE FENSTER? Daraus wird
  // die Fusszeile „Ø pro Woche". `moWindow()` liefert ab 1M ein Fenster, bei 7T nicht:
  // dort waere der Wochenschnitt sinnlos, weil das Fenster selbst eine Woche IST.
  //
  // `_monatsModus` — zeigt ein BALKEN einen ganzen Monat? Nur dann bekommt der
  // Tooltip seine zweite Zeile. Bei 1M steht je Balken ein Tag; ein Wochenschnitt
  // fuer einen einzelnen Tag ergaebe keinen Sinn.
  const _mw = moWindow();
  const _fensterWochen = _mw ? wochenZwischen(_mw.s, _mw.e) : null;
  const _monatsModus = tKeyTyp === 'monat' && !!_mw;

  // Workout-Werte je Health-Tag (alle Trainingsarten). Nicht auf Tage mit Workout
  // gefiltert – sonst fielen Indoor-Einheiten ohne Health-Zeile heraus.
  const woRows=D.map(r=>{
    const w=workoutData[r.date];
    return {date:r.date, _woDurMin:w?.durationMin??null, _woDistKm:w?.distanceKm??null,
      // Zaehlt die EINHEITEN je Zeitraum – ein Tag mit zwei Einheiten zaehlt zweifach.
      _woAnzahl:w?(w.anzahl||1):null,
      _woLaeufe:w?.laeufe??null};
  });
  const {alignSum:tASwo}=timeDim(woRows);
  // Gesamtwerte des dargestellten Zeitraums – Summe ueber alle Tage des Fensters,
  // unabhaengig von der gewaehlten Aggregation (Tag/Woche/Monat).
  const summe = feld => { const v = woRows.map(r=>r[feld]).filter(x=>x!=null);
    return v.length ? v.reduce((a,b)=>a+b,0) : null; };
  const minGesamt  = summe('_woDurMin');
  const distGesamt = summe('_woDistKm');
  // „Ø pro Lauf" (auf Wunsch, 14.09.2026). Jede Zahl teilt durch das, was ihr Total
  // enthaelt: die Strecke durch die Einheiten MIT Strecke, die Zeit durch ALLE
  // Einheiten – die Trainingszeit summiert auch Intervalltrainings ohne Strecke.
  const laeufeGesamt    = summe('_woLaeufe');
  const einheitenGesamt = summe('_woAnzahl');
  // Dieselben Zaehler je Monat – fuer „Ø / Lauf" im Tooltip eines Monatsbalkens.
  const _proMonat = {};
  woRows.forEach(r => {
    const m = _proMonat[r.date.slice(0, 7)] = _proMonat[r.date.slice(0, 7)] || { laeufe: 0, einheiten: 0 };
    m.laeufe += r._woLaeufe || 0;
    m.einheiten += r._woAnzahl || 0;
  });

  // Balkenreihen und Achse beider Diagramme. Bei 1M jeder Kalendertag des Monats
  // direkt aus workoutData – auch Tage mit Workout, aber ohne Health-Zeile.
  const _is1m=timeRange==='1m';
  const _balkenKeys=tKeys, _balkenLabels=tL, _balkenKeyTyp=tKeyTyp;
  const _balkenZeit = _is1m ? tKeys.map(d=>workoutData[d]?.durationMin??null) : tASwo('_woDurMin');
  const _balkenStr  = _is1m ? tKeys.map(d=>workoutData[d]?.distanceKm??null)  : tASwo('_woDistKm');
  // Die Fusszeile „Ø 1M" zeigt denselben Wert wie die gestrichelte Ø-Linie: den
  // Mittelwert der Balken, also je Tag (7T, 1M) bzw. je Monat (ab 3M). Tage ohne
  // Einheit fehlen in der Reihe (null) und zaehlen deshalb nicht mit.
  // AUSNAHME Monatsbalken – 3M bis 24M und Einzeljahr (auf Wunsch, 28.09.2026): dort
  // zaehlt JEDER Monat mit Daten, ein Monat ohne Training mit 0 – „Ø 6M" ist das
  // Monatsmittel ueber das Fenster. Die Reihe enthaelt nur Monate mit Gesundheitsdaten
  // (die Schluessel kommen aus allMonths(D)), im laufenden Monat bzw. Jahr also nur
  // die bisher vergangenen. Nicht im Jahresvergleich: dort steht je Jahr ein Balken.
  const _jeMonat = _balkenKeyTyp === 'monat' && !istYoY();
  // Die Fusszeile „Ø 6M · pro Monat" gibt es nur bei Monatsbalken (auf Wunsch,
  // 30.09.2026, Variante C): bei 7T und 1M war „Ø 1M" der Schnitt je Trainingstag und
  // damit fast dieselbe Zahl wie „Ø pro Lauf" darunter. Die gestrichelte Ø-Linie
  // bleibt dort trotzdem im Diagramm.
  const _oeBalken = reihe => (_jeMonat && reihe.some(v => v != null))
    ? reihe.reduce((summe, v) => summe + (v || 0), 0) / reihe.length
    : mittelArr(reihe);
  const oeZeitBalken = _oeBalken(_balkenZeit);
  const oeStrBalken  = _oeBalken(_balkenStr);
  // Ø-Pace: ebenfalls der Wert der Ø-Linie – Mittel ueber die Einheiten.
  const oePace = mittelArr(trendPace);

  const hasAny=trainDates.length>0;

  const noDataCard=`<div class="no-data">
    <strong>Keine Trainingsdaten gefunden</strong>
    Im aktuellen Zeitraum ist kein Eintrag im Workout-Sheet vorhanden.
    <div class="field-hint" style="margin-top:.4rem">Quelle: <code>Workout Data</code>-Google-Sheet · erwartete Spalten: <code>Date</code> <code>Type</code> <code>Duration (min)</code> <code>Distance (km)</code> <code>Avg HR</code> <code>Speed (km/h)</code></div>
  </div>`;

  const vo2 = vo2Abschnitt(D);

  document.getElementById("screen-training").innerHTML=`
    ${pgBanner('🏃','Training')}
      <div class="chart-card">
        <h3>Laufstrecke</h3>
        <div class="chart-legend"><div class="cl-item"><span class="cl-dot" style="background:#FB923C"></span>${is7D()||timeRange==='1m'?'pro Tag':'pro Monat'}</div>${hlLegende('c-tot-strecke|oe','Ø','#FB923C')}</div>
        <div class="chart-wrap"><canvas id="c-tot-strecke"></canvas></div>
        <div class="stats-list diagramm-fuss">
          ${distGesamt!=null?`${statZeile(`Total`, `${zahl(distGesamt,1)} km`)}`:''}
          ${_jeMonat&&oeStrBalken!=null?statZeile(oeLabel('pro Monat'), `${zahl(oeStrBalken,1)} km`):''}
          ${!istYoY()&&distGesamt!=null&&laeufeGesamt?statZeile(`Ø pro Lauf`, `${zahl(distGesamt/laeufeGesamt,1)} km`):''}
          ${distGesamt!=null&&_fensterWochen?`${statZeile(`Ø pro Woche`, `${zahl(distGesamt/_fensterWochen,1)} km`)}`:''}
          ${istYoY() ? yoyZeilen([{ werte: yoyWerte(D, r => workoutData[r.date]?.distanceKm ?? null, 'summe') }], true) : ''}
          ${istYoY() ? '' : fussMehr('training',
            (distWkdAvg!=null ? statZeile(`Ø Wochentag (Mo–Fr)`, `${zahl(distWkdAvg,1)} km`) : '')
          + (distWkndAvg!=null ? statZeile(`Ø Wochenende (Sa–So)`, `${zahl(distWkndAvg,1)} km`) : ''))}
        </div>
      </div>

      <div class="chart-card">
        <h3>Trainingszeit</h3>
        <div class="chart-legend"><div class="cl-item"><span class="cl-dot" style="background:#F97316"></span>${is7D()||timeRange==='1m'?'pro Tag':'pro Monat'}</div>${hlLegende('c-tot-zeit|oe','Ø','#F97316')}</div>
        <div class="chart-wrap"><canvas id="c-tot-zeit"></canvas></div>
        <div class="stats-list diagramm-fuss">
          ${minGesamt!=null?`${statZeile(`Total`, `${fmtMin(minGesamt)}`)}`:''}
          ${_jeMonat&&oeZeitBalken!=null?statZeile(oeLabel('pro Monat'), `${fmtMin(oeZeitBalken)}`):''}
          ${!istYoY()&&minGesamt!=null&&einheitenGesamt?statZeile(`Ø pro Lauf`, `${fmtMin(minGesamt/einheitenGesamt)}`):''}
          ${minGesamt!=null&&_fensterWochen?`${statZeile(`Ø pro Woche`, `${fmtMin(minGesamt/_fensterWochen)}`)}`:''}
          ${istYoY() ? yoyZeilen([{ werte: yoyWerte(D, r => workoutData[r.date]?.durationMin ?? null, 'summe') }], true) : ''}
          ${istYoY() ? '' : fussMehr('training',
            (minWeek!=null ? statZeile(`Ø Wochentag (Mo–Fr)`, `${fmtMin(minWeek)}`) : '')
          + (minWknd!=null ? statZeile(`Ø Wochenende (Sa–So)`, `${fmtMin(minWknd)}`) : ''))}
        </div>
      </div>

    <div class="chart-card">
      <h3>Pace pro Training ${infoI('pace')}</h3>
      <div class="chart-legend"><div class="cl-item"><span class="cl-line" style="background:#EA580C"></span>Pace</div>${hlLegende('c-tr-pace|oe','Ø','#EA580C')}</div>
      <div class="chart-wrap"><canvas id="c-tr-pace"></canvas></div>
      <!-- Nur die Durchschnittszeile (18.09.2026, auf Wunsch). Wochentag/Wochenende sind
           beim Pace ganz entfallen – auch aufgeklappt. Ohne Pace-Werte keine Fusszeile. -->
      ${istYoY() ? `<div class="stats-list diagramm-fuss">${yoyZeilen([{ werte: yoyWerte(D, r => workoutData[r.date]?.avgSpeedKph > 0 ? paceFromSpeed(workoutData[r.date].avgSpeedKph) : null, 'mittel') }])}</div>`
        : oePace != null ? `<div class="stats-list diagramm-fuss">
        ${statZeile(oeLabel(), `${fmtPace(oePace)} min/km`)}
      </div>` : ''}
    </div>
    ${!hasAny?noDataCard:''}
    ${vo2.html}
    ${hasAny && _weitereOffen.training ? einblickeHTML(trainingsInsights(), true) : ''}`;


  // ── Totale Laufzeit & Laufstrecke ──
  {
    const _zeitInH=timeRange!=='7d'&&timeRange!=='1m'; // ab 3M: Achse in Stunden

    zeichneDiagramm('c-tot-zeit',{__keys:_balkenKeys,__keyTyp:_balkenKeyTyp,
      // Beschriftung in der Einheit der Achse. Balken ohne Training tragen keine
      // Null – ein Balken der Hoehe 0 sagt das bereits, und im Monatsfenster
      // stuenden sonst Dutzende Nullen auf der Grundlinie.
      // Dasselbe Format wie beim Schlaf – die Werte liegen hier in Minuten.
      // Seit dem schmaleren Format (12.09.2026) ohne Sonderfall bei 24M: dort stand
      // vorher nur die ganze Stunde ("10h"), weil "10h 12m" neben 24 Nachbarn nicht
      // mehr lesbar war. "10:12" ist schmal genug.
      __werteFmt:v=>v?stdMinLabel(v/60):'',
      type:'bar',data:{labels:_balkenLabels,datasets:[
      {label:'Laufzeit',data:_balkenZeit,backgroundColor:'rgba(249,115,22,.80)',borderRadius:BALKEN_RADIUS},
      ...oeDatensatz('c-tot-zeit|oe', oeZeitBalken, '#F97316', _balkenLabels.length)
    ]},options:{responsive:true,maintainAspectRatio:false,
      // fmtMin schreibt ab einer Stunde "1h 25min", darunter "45 min" – unabhaengig
      // davon, ob die Achse in Stunden oder Minuten beschriftet ist.
      plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,filter:nurMesswerte,callbacks:{
        label:ctx=>{
          if(ctx.raw==null)return null;
          const t=fmtMin(ctx.raw);
          // Monatsbalken (auf Wunsch, 14.09.2026, auch im Jahresvergleich): unter der
          // Summe „Ø / Lauf", darunter wie bisher „Ø / Woche". Die Zeit teilt durch ALLE
          // Einheiten – dieselbe Rechnung wie die Fusszeile „Ø pro Lauf".
          if(_balkenKeyTyp!=='monat')return t;
          const mo=_balkenKeys[ctx.dataIndex], zeilen=[t];
          const n=_proMonat[mo]?.einheiten;
          if(n)zeilen.push(`Ø ${fmtMin(ctx.raw/n)} / Lauf`);
          // Woche nur, wo es ein Fenster gibt (_monatsModus) – im Jahresvergleich nicht.
          const w=_monatsModus?wochenImMonat(mo):null;
          if(w)zeilen.push(`Ø ${fmtMin(ctx.raw/w)} / Woche`);
          return zeilen.length>1?zeilen:t;
        }}}},
      scales:{x:achseX,y:{...achseY,
        ticks:{...achseY.ticks,callback:v=>_zeitInH?`${Math.floor(v/60)}h`:Math.round(v)+' min'}}}}});

    zeichneDiagramm('c-tot-strecke',{__keys:_balkenKeys,__keyTyp:_balkenKeyTyp,
      // Ganze Kilometer, OHNE Einheit (auf Wunsch, 12.09.2026): ueber dem Balken
      // zaehlt der schnelle Blick, und "km" steht bereits an der Achse. Die
      // Nachkommastelle steht im Tooltip und in der Fusszeile.
      __werteFmt:v=>v?String(Math.round(v)):'',
      type:'bar',data:{labels:_balkenLabels,datasets:[
      {label:'Laufstrecke',data:_balkenStr,backgroundColor:'rgba(251,146,60,.80)',borderRadius:BALKEN_RADIUS},
      ...oeDatensatz('c-tot-strecke|oe', oeStrBalken, '#FB923C', _balkenLabels.length)
    ]},options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,filter:nurMesswerte,callbacks:{
        label:ctx=>{
          if(ctx.raw==null)return null;
          const t=`${zahl(ctx.raw,1)} km`;
          // Wie bei der Trainingszeit; die Strecke teilt durch die Einheiten MIT Strecke.
          if(_balkenKeyTyp!=='monat')return t;
          const mo=_balkenKeys[ctx.dataIndex], zeilen=[t];
          const n=_proMonat[mo]?.laeufe;
          if(n)zeilen.push(`Ø ${zahl(ctx.raw/n,1)} km / Lauf`);
          const w=_monatsModus?wochenImMonat(mo):null;
          if(w)zeilen.push(`Ø ${zahl(ctx.raw/w,1)} km / Woche`);
          return zeilen.length>1?zeilen:t;
        }}}},
      scales:{x:achseX,y:{...achseY,
        ticks:{...achseY.ticks,callback:v=>v===0?'0':Math.round(v)+' km'}}}}});
  }

  // ── Pace pro Training ──
  {
    const _hasP=trainDates.length>0&&trendPace.some(v=>v!=null);
    const _paceLabels=_hasP?trendLabels:tL;
    const _paceKeys=_hasP?trainDates:tKeys;
    const _paceKeyTyp=_hasP?'tag':tKeyTyp;
    const _paceData=_hasP?trendPace:tL.map(()=>null);
    const _pMin=_hasP?Math.floor(Math.min(...trendPace.filter(v=>v!=null))*0.97*10)/10:4;
    const _pMax=_hasP?Math.ceil(Math.max(...trendPace.filter(v=>v!=null))*1.03*10)/10:8;
    zeichneDiagramm('c-tr-pace',{__keys:_paceKeys,__keyTyp:_paceKeyTyp,
      __werteFmt:v=>fmtPace(v),
      type:'line',data:{labels:_paceLabels,datasets:[
      // Orange wie die uebrigen Diagramme des Tabs (auf Wunsch, 18.09.2026; vorher
      // Violett, die Farbe des Schlaf-Tabs). #EA580C ist dunkler als Trainingszeit
      // (#F97316) und Laufstrecke (#FB923C) und roeter als VO2max (#D97706).
      {label:'Pace [min/km]',data:_paceData,borderColor:'#EA580C',backgroundColor:'rgba(234,88,12,.08)',tension:.3,fill:true,pointRadius:3,pointBackgroundColor:'#EA580C',spanGaps:true},
      ...oeDatensatz('c-tr-pace|oe', mittelArr(_paceData), '#EA580C', _paceLabels.length)
    ]},options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,filter:nurMesswerte,callbacks:{label:ctx=>{
        if(ctx.raw==null)return null;
        return `Pace: ${fmtPace(ctx.raw)} min/km`;
      }}}},
      scales:{x:{...achseX,ticks:{...achseX.ticks,maxRotation:45,minRotation:30}},
        y:{...achseY,min:_pMin,max:_pMax,
          ticks:{...achseY.ticks,callback:v=>fmtPace(v)}}}}});
  }

  vo2.zeichnen();
}

// ── Trainings-Einblicke (auf Wunsch, 18.09.2026) ─────────────────────────────
// Karten wie „Muster & Zusammenhaenge" der Uebersicht, hinter dem Ausklapp-Knopf des
// Training-Tabs unter VO2max. ALLE ueber den gesamten Datenbestand (auf Wunsch) – sie
// folgen dem Zeitfilter NICHT. Die Entwicklungs-Karten vergleichen feste Zeitraeume
// (letzte 3 Monate gegen die 3 davor, Jahr gegen Vorjahr), gerechnet ab dem neuesten
// Datentag.
// Vier Abschnitte, 19 Karten. Jede Karte erscheint nur, wenn genug Daten da sind –
// sonst fehlt sie (kein erfundener Platzhalter).
// Begriffe: EINHEIT = ein Eintrag im Workout-Blatt (`workoutData[d].einheiten`);
// LAUF = eine Einheit mit Strecke > 0. Nacht-Zuordnung wie in der Uebersicht:
// `sleepTotal` am Tag d ist die Nacht VOR d (Aufwachdatum), die Folgenacht von d
// steht also am Tag d + 1.
const MONAT_LANG = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
const WOCHENTAG_LANG = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
// Anzeigenamen der Trainingsarten. Health Auto Export liefert Apples eigene, teils
// holprig uebersetzte Namen („Outdoor Ausführen" = Lauf draussen). Unbekannte bleiben
// wie im Sheet stehen – immer durch esc().
const TRAININGSART_KURZ = {
  'Outdoor Ausführen': 'Laufen draussen',
  'Innenräume Ausführen': 'Laufen drinnen',
  'Trail-Laufen': 'Trail',
  'Hochintensives Intervalltraining': 'Intervall (HIIT)'
};
function artLabel(typ) { const t = String(typ || '').trim(); return esc(TRAININGSART_KURZ[t] || t || 'Workout'); }
// ── Gemeinsame Helfer der Einblicke (Training, Herz, Schlaf) ─────────────────
const _EB_GUT = '#10B981', _EB_ACHTUNG = '#F97316';
const _ebFett = s => ({ phrase: s, c: 'inherit' });   // nur fett: Tatsache
const _ebDatum = ds => `${ds.slice(8,10)}.${ds.slice(5,7)}.${ds.slice(0,4)}`;
const _ebTagMonat = ds => `${+ds.slice(8,10)}.${+ds.slice(5,7)}.`;
const _ebMonat = ym => `${MONAT_LANG[+ym.slice(5,7) - 1]} ${ym.slice(0,4)}`;
const _ebWochentag = ds => WOCHENTAG_LANG[new Date(ds + 'T00:00:00').getDay()];
const _ebTage = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
const _ebMedian = werte => _ebQuantil(werte, .5);
// Die letzten 91 Tage bis `ende` und die 91 davor – fuer alle „3 Monate gegen die
// 3 davor"-Vergleiche. `datum(x)` liest das Datum eines Eintrags.
function _ebQuartale(ende, datum = x => x.date) {
  const drei = addDays(ende, -91), sechs = addDays(ende, -182);
  return {
    letzte3: liste => liste.filter(x => datum(x) > drei),
    davor3:  liste => liste.filter(x => datum(x) > sechs && datum(x) <= drei)
  };
}
// Uhrzeit aus Stunden (auch ueber 24, fuer Einschlafzeiten nach Mitternacht). Erst auf
// die Minute runden – fmtHHMM allein machte aus 23.999 „23:00".
const _ebUhr = h => fmtHHMM((Math.round(h * 60) % 1440 + 1440) % 1440 / 60);
function _ebQuantil(werte, p) {
  const s = werte.filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const i = (s.length - 1) * p, u = Math.floor(i);
  return s[u] + (s[Math.min(u + 1, s.length - 1)] - s[u]) * (i - u);
}
// Werte je Gruppe (Monat, Woche …): { schluessel: [werte] }
function _ebGruppiert(rows, schluessel, wert) {
  const g = {};
  rows.forEach(r => { const v = wert(r); if (v == null) return; const k = schluessel(r); (g[k] = g[k] || []).push(v); });
  return g;
}
// Beste Gruppe nach Mittelwert, nur Gruppen mit mindestens `min` Werten. null, wenn
// weniger als drei Gruppen in Frage kommen – ein Rekord unter zweien ist keiner.
function _ebBeste(gruppen, min, hoch) {
  const l = Object.entries(gruppen).filter(([, v]) => v.length >= min)
    .map(([k, v]) => ({ k, wert: mittelArr(v), n: v.length }));
  if (l.length < 3) return null;
  return l.reduce((a, b) => (hoch ? b.wert >= a.wert : b.wert <= a.wert) ? b : a);   // Gleichstand: der juengste
}
const _EB_WINTER = [12, 1, 2], _EB_SOMMER = [6, 7, 8];
const _ebSaison = (rows, monate) => rows.filter(r => monate.includes(+r.date.slice(5,7)));

function trainingsInsights() { return _memo('trainingsInsights', _trainingsInsightsBerechnen); }

function _trainingsInsightsBerechnen() {
  const tage = Object.keys(workoutData).filter(istDatum).sort();
  if (!tage.length) return [];
  const zahlOk = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  const einheiten = [];
  tage.forEach(d => {
    const w = workoutData[d] || {};
    const liste = Array.isArray(w.einheiten) && w.einheiten.length ? w.einheiten
      : [{ typ: w.typeRaw, dauer: w.durationMin, strecke: w.distanceKm, puls: w.avgHR, speed: w.avgSpeedKph }];
    liste.forEach(e => einheiten.push({ datum: d, typ: String((e && e.typ) || '').trim(),
      dauer: zahlOk(e && e.dauer), strecke: zahlOk(e && e.strecke),
      puls: zahlOk(e && e.puls), speed: zahlOk(e && e.speed) }));
  });
  const laeufe = einheiten.filter(e => e.strecke > 0);
  const mitPace = laeufe.filter(e => e.speed > 0);
  const erster = tage[0];
  const ende = [tage[tage.length - 1], allData.length ? allData[allData.length - 1].date : null].filter(Boolean).sort().pop();
  const byDate = {}; allData.forEach(r => { byDate[r.date] = r; });

  // Helfer
  const F = _ebFett, GUT = _EB_GUT, ACHTUNG = _EB_ACHTUNG, ORANGE = '#F97316';
  const datumDe = _ebDatum, tagMonat = _ebTagMonat, monatLang = _ebMonat, tageZwischen = _ebTage, median = _ebMedian;
  const tsd = v => Math.round(v).toLocaleString('de-CH');
  const summe = (liste, f) => liste.reduce((s, e) => s + (f(e) || 0), 0);
  // Groesster Eintrag eines Zaehlers; bei Gleichstand der juengste Schluessel.
  const maxEintrag = obj => Object.entries(obj).sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0];
  const pace = e => paceFromSpeed(e.speed);
  const { letzte3, davor3 } = _ebQuartale(ende, e => e.datum);

  const rekorde = [], gewohnheiten = [], entwicklung = [], gesundheit = [];

  // ── Rekorde ──
  // 1 Rekordmonat (km)
  if (laeufe.length) {
    const km = {}, n = {};
    laeufe.forEach(e => { const m = e.datum.slice(0,7); km[m] = (km[m] || 0) + e.strecke; n[m] = (n[m] || 0) + 1; });
    const [m, best] = maxEintrag(km);
    const monate = (+ende.slice(0,4) - +erster.slice(0,4)) * 12 + (+ende.slice(5,7) - +erster.slice(5,7)) + 1;
    const schnitt = summe(laeufe, e => e.strecke) / Math.max(1, monate);
    const kern = `${monatLang(m)} mit ${zahl(best,1)} km`;
    rekorde.push({ icon:'🗓️', color:ORANGE, conf:'Rekordmonat',
      text:`Dein stärkster Monat war ${kern} in ${n[m]} ${n[m] === 1 ? 'Lauf' : 'Läufen'} – dein Monatsschnitt liegt bei ${zahl(schnitt,0)} km.`, hl:[F(kern)] });
  }
  // 2 Rekordwoche (km)
  if (laeufe.length) {
    const km = {};
    laeufe.forEach(e => { const w = getWeekMonday(e.datum); km[w] = (km[w] || 0) + e.strecke; });
    const [w, best] = maxEintrag(km);
    const kern = `${zahl(best,1)} km`;
    rekorde.push({ icon:'📅', color:ORANGE, conf:'Rekordwoche',
      text:`Die meisten Kilometer in einer Woche: ${kern} in KW ${isoKW(w)} (${tagMonat(w)}–${tagMonat(addDays(w, 6))}${addDays(w, 6).slice(0,4)}).`, hl:[F(kern)] });
  }
  // 3 Laengster Lauf
  if (laeufe.length) {
    const l = laeufe.reduce((a, e) => e.strecke > a.strecke ? e : a);
    const kern = `${zahl(l.strecke,1)} km`;
    rekorde.push({ icon:'🛣️', color:ORANGE, conf:'Längster Lauf',
      text:`Dein längster Lauf: ${kern} am ${datumDe(l.datum)}${l.dauer ? ` in ${fmtMin(l.dauer)}` : ''}${l.speed > 0 ? `, Pace ${fmtPace(pace(l))} min/km` : ''}.`, hl:[F(kern)] });
  }
  // 4 Laengste Einheit (Dauer)
  {
    const mitDauer = einheiten.filter(e => e.dauer > 0);
    if (mitDauer.length) {
      const u = mitDauer.reduce((a, e) => e.dauer > a.dauer ? e : a);
      const kern = fmtMin(u.dauer);
      rekorde.push({ icon:'⏱️', color:ORANGE, conf:'Längste Einheit',
        text:`Deine längste Einheit dauerte ${kern}: ${artLabel(u.typ)} am ${datumDe(u.datum)}${u.strecke > 0 ? ` über ${zahl(u.strecke,1)} km` : ''}.`, hl:[F(kern)] });
    }
  }
  // 5 Schnellster Lauf ab 5 km – kuerzere Laeufe und GPS-Ausreisser verzerrten sonst
  {
    const lang = mitPace.filter(e => e.strecke >= 5);
    if (lang.length) {
      const s = lang.reduce((a, e) => e.speed > a.speed ? e : a);
      const kern = `${fmtPace(pace(s))} min/km`;
      rekorde.push({ icon:'⚡', color:ORANGE, conf:'Schnellster Lauf ab 5 km',
        text:`Deine beste Pace ab 5 km: ${kern} über ${zahl(s.strecke,1)} km am ${datumDe(s.datum)}.`, hl:[F(kern)] });
    }
  }
  // 6 Aktivster Monat (Trainingstage)
  {
    const n = {};
    tage.forEach(d => { const m = d.slice(0,7); n[m] = (n[m] || 0) + 1; });
    const [m, best] = maxEintrag(n);
    const kern = `an ${best} Tagen`;
    rekorde.push({ icon:'🔥', color:ORANGE, conf:'Aktivster Monat',
      text:`Im ${monatLang(m)} hast du ${kern} trainiert – so oft wie in keinem anderen Monat.`, hl:[F(kern)] });
  }
  // 7 Laengste Serie: Wochen in Folge mit mindestens 2 Einheiten
  {
    const proWoche = {};
    einheiten.forEach(e => { const w = getWeekMonday(e.datum); proWoche[w] = (proWoche[w] || 0) + 1; });
    const wochen = [];
    for (let w = getWeekMonday(erster), letzte = getWeekMonday(ende); w <= letzte; w = addDays(w, 7)) wochen.push(w);
    let lauf = 0, best = 0, start = null, bestStart = null, bestEnde = null;
    wochen.forEach(w => {
      if ((proWoche[w] || 0) >= 2) { if (!lauf) start = w; lauf++; if (lauf > best) { best = lauf; bestStart = start; bestEnde = w; } }
      else lauf = 0;
    });
    // Aktuelle Serie: die laufende Woche zaehlt mit, sobald sie 2 Einheiten hat – vorher
    // bricht sie die Serie nicht, sie ist ja noch nicht vorbei.
    let aktuell = 0;
    for (let i = wochen.length - 1; i >= 0; i--) {
      if ((proWoche[wochen[i]] || 0) >= 2) aktuell++;
      else if (i === wochen.length - 1) continue;
      else break;
    }
    if (best >= 2) {
      const von = fmtM(bestStart.slice(0,7)), bis = fmtM(addDays(bestEnde, 6).slice(0,7));
      const kern = `${best} Wochen in Folge`;
      const jetzt = aktuell >= best ? ' Du bist gerade mittendrin – das ist deine Bestserie.'
        : aktuell >= 2 ? ` Aktuell läuft eine Serie von ${aktuell} Wochen.` : '';
      rekorde.push({ icon:'🔗', color:ORANGE, conf:'Längste Serie',
        text:`Deine längste Serie: ${kern} mit mindestens 2 Trainings (${von === bis ? von : von + ' bis ' + bis}).${jetzt}`, hl:[F(kern)] });
    }
  }
  // 8 Hoechster VO2max
  {
    const v2 = allData.filter(r => r.vo2max != null);
    if (v2.length) {
      const b = v2.reduce((a, r) => r.vo2max > a.vo2max ? r : a), jetzt = v2[v2.length - 1];
      const kern = `${zahl(b.vo2max,1)} ml/kg/min`;
      rekorde.push({ icon:'🫁', color:'#D97706', conf:'VO₂max-Bestwert',
        text:`Dein höchster VO₂max: ${kern} am ${datumDe(b.date)}` + (b.date === jetzt.date
          ? ' – das ist zugleich dein aktueller Wert.' : `. Aktuell liegst du bei ${zahl(jetzt.vo2max,1)}.`), hl:[F(kern)] });
    }
  }

  // ── Gewohnheiten ──
  // 9 Lieblings-Trainingstag
  if (tage.length >= 10) {
    const n = [0,0,0,0,0,0,0];
    tage.forEach(d => { n[new Date(d + 'T00:00:00').getDay()]++; });
    const max = n.indexOf(Math.max(...n)), min = n.indexOf(Math.min(...n));
    const pct = i => Math.round(n[i] / tage.length * 100);
    const kern = `${WOCHENTAG_LANG[max]} (${pct(max)} %)`;
    gewohnheiten.push({ icon:'📌', color:'#FB923C', conf:'Lieblingstag',
      text:`Die meisten Trainingstage fallen auf den ${kern}, die wenigsten auf den ${WOCHENTAG_LANG[min]} (${pct(min)} %).`, hl:[F(kern)] });
  }
  // 10 Typischer Lauf (Median)
  if (laeufe.length >= 5) {
    const s = median(laeufe.map(e => e.strecke));
    const p = mitPace.length >= 5 ? median(mitPace.map(pace)) : null;
    const kern = `${zahl(s,1)} km` + (p != null ? ` in ${fmtPace(p)} min/km` : '');
    gewohnheiten.push({ icon:'🏃', color:'#FB923C', conf:'Typischer Lauf',
      text:`Dein typischer Lauf: ${kern} – der Median aus ${laeufe.length} Läufen.`, hl:[F(kern)] });
  }
  // 11 Trainingsmix
  if (einheiten.length >= 5) {
    const n = {};
    einheiten.forEach(e => { const l = artLabel(e.typ); n[l] = (n[l] || 0) + 1; });
    const sortiert = Object.entries(n).sort((a, b) => b[1] - a[1]);
    // Bis zu vier Arten einzeln; erst ab fuenf werden die kleinsten zu „Sonstige".
    const oben = sortiert.length <= 4 ? sortiert : sortiert.slice(0, 3);
    const rest = sortiert.slice(oben.length).reduce((s, [, v]) => s + v, 0);
    const teile = oben.map(([l, v]) => `${l} ${Math.round(v / einheiten.length * 100)} %`);
    if (rest) teile.push(`Sonstige ${Math.round(rest / einheiten.length * 100)} %`);
    gewohnheiten.push({ icon:'🧩', color:'#FB923C', conf:'Trainingsmix',
      text:`Deine ${einheiten.length} Einheiten: ${teile.join(', ')}.`, hl:[F(teile[0])] });
  }
  // 12 Erholungsabstand
  if (tage.length >= 5) {
    const ruhe = [];
    for (let i = 1; i < tage.length; i++) ruhe.push({ tage: tageZwischen(tage[i - 1], tage[i]) - 1, bis: tage[i] });
    const mittelRuhe = ruhe.reduce((s, r) => s + r.tage, 0) / ruhe.length;
    const haeufig = {}; ruhe.forEach(r => { haeufig[r.tage] = (haeufig[r.tage] || 0) + 1; });
    const modus = +Object.entries(haeufig).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    const pause = ruhe.reduce((a, r) => r.tage > a.tage ? r : a);
    const modusSatz = modus === 0 ? 'am häufigsten trainierst du an zwei Tagen hintereinander'
      : modus === 1 ? 'am häufigsten liegt genau ein Ruhetag dazwischen' : `am häufigsten sind es ${modus}`;
    const kern = `${zahl(mittelRuhe,1)} Ruhetage`;
    gewohnheiten.push({ icon:'🛋️', color:'#FB923C', conf:'Erholung',
      text:`Zwischen zwei Trainingstagen liegen im Schnitt ${kern}; ${modusSatz}. Deine längste Pause: ${pause.tage} Tage (bis ${datumDe(pause.bis)}).`, hl:[F(kern)] });
  }

  // ── Entwicklung ──
  // 13 Pace-Trend: letzte 3 Monate gegen die 3 davor
  {
    const a = letzte3(mitPace), b = davor3(mitPace);
    if (a.length >= 3 && b.length >= 3) {
      const pa = a.reduce((s, e) => s + pace(e), 0) / a.length, pb = b.reduce((s, e) => s + pace(e), 0) / b.length;
      const sek = Math.round((pb - pa) * 60);
      const kern = Math.abs(sek) < 3 ? 'praktisch unverändert' : `${Math.abs(sek)} s/km ${sek > 0 ? 'schneller' : 'langsamer'}`;
      entwicklung.push({ icon: sek >= 3 ? '🚀' : sek <= -3 ? '🐢' : '➖', color: sek >= 3 ? GUT : sek <= -3 ? ACHTUNG : '#94A3B8', conf:'Pace-Trend · 3 Monate',
        text:`Deine Ø Pace der letzten 3 Monate: ${fmtPace(pa)} min/km – ${kern}${Math.abs(sek) < 3 ? '' : ' als in den 3 Monaten davor'} (${fmtPace(pb)}).`,
        hl:[{ phrase: kern, c: sek >= 3 ? GUT : sek <= -3 ? ACHTUNG : 'inherit' }] });
    }
  }
  // 14 Jahr gegen Vorjahr bis zum selben Datum – nur, wenn das Vorjahr ab Januar Daten hat
  const jahr = +ende.slice(0,4), md = ende.slice(5);
  const kmJahr = summe(laeufe.filter(e => e.datum >= `${jahr}-01-01` && e.datum <= ende), e => e.strecke);
  {
    const vjEnde = `${jahr - 1}-${md === '02-29' ? '02-28' : md}`;
    if (erster <= `${jahr - 1}-01-31`) {
      const kmVj = summe(laeufe.filter(e => e.datum >= `${jahr - 1}-01-01` && e.datum <= vjEnde), e => e.strecke);
      if (kmVj > 0) {
        const pct = Math.round((kmJahr - kmVj) / kmVj * 100);
        const kern = `${tsd(kmJahr)} km`;
        entwicklung.push({ icon:'📊', color:'#EA580C', conf:`${jahr} gegen ${jahr - 1}`,
          text:`Seit dem 1. Januar ${jahr}: ${kern} – ${pct === 0 ? 'gleich viel wie' : `${Math.abs(pct)} % ${pct > 0 ? 'mehr' : 'weniger'} als`} im Vorjahr bis zum ${tagMonat(ende)} (${tsd(kmVj)} km).`, hl:[F(kern)] });
      }
    }
  }
  // 15 Hochrechnung aufs Jahresende – erst ab 30 Tagen im Jahr, sonst zu wacklig
  {
    const tagImJahr = tageZwischen(`${jahr}-01-01`, ende) + 1;
    const tageJahr = tageZwischen(`${jahr}-01-01`, `${jahr + 1}-01-01`);
    if (tagImJahr >= 30 && kmJahr > 0 && erster <= `${jahr}-01-31`) {
      const hoch = Math.round(kmJahr / tagImJahr * tageJahr / 10) * 10;
      const kmVjGanz = erster <= `${jahr - 1}-01-31` ? summe(laeufe.filter(e => e.datum.startsWith(`${jahr - 1}-`)), e => e.strecke) : 0;
      const kern = `rund ${tsd(hoch)} km`;
      entwicklung.push({ icon:'🔭', color:'#EA580C', conf:'Hochrechnung',
        text:`Bei deinem bisherigen Tempo kommst du ${jahr} auf ${kern}${kmVjGanz > 0 ? ` (${jahr - 1}: ${tsd(kmVjGanz)} km)` : ''}.`, hl:[F(kern)] });
    }
  }
  // 16 Laufeffizienz: Puls bei aehnlicher Pace, letzte 3 Monate gegen die 3 davor
  {
    const mitPuls = mitPace.filter(e => e.puls > 0);
    const beide = [...letzte3(mitPuls), ...davor3(mitPuls)];
    if (beide.length >= 6) {
      const mitte = median(beide.map(pace));
      const imBand = liste => liste.filter(e => Math.abs(pace(e) - mitte) <= 20 / 60);   // ±20 s/km
      const a = imBand(letzte3(mitPuls)), b = imBand(davor3(mitPuls));
      if (a.length >= 3 && b.length >= 3) {
        const ha = a.reduce((s, e) => s + e.puls, 0) / a.length, hb = b.reduce((s, e) => s + e.puls, 0) / b.length;
        const d = Math.round(ha - hb);
        const kern = d === 0 ? 'praktisch gleich' : `${Math.abs(d)} bpm ${d < 0 ? 'tiefer' : 'höher'}`;
        entwicklung.push({ icon:'💓', color: d < 0 ? GUT : d > 0 ? ACHTUNG : '#94A3B8', conf:'Laufeffizienz · 3 Monate',
          text:`Bei ähnlicher Pace (um ${fmtPace(mitte)} min/km) war dein Puls in den letzten 3 Monaten ${kern}${d === 0 ? ' wie' : ' als'} in den 3 Monaten davor${d < 0 ? ' – dein Herz arbeitet effizienter' : ''}.`,
          hl:[{ phrase: kern, c: d < 0 ? GUT : d > 0 ? ACHTUNG : 'inherit' }] });
      }
    }
  }
  // 17 Meilenstein
  if (laeufe.length) {
    const gesamt = summe(laeufe, e => e.strecke);
    const schritt = gesamt < 500 ? 100 : gesamt < 2000 ? 250 : gesamt < 5000 ? 500 : 1000;
    const naechster = Math.floor(gesamt / schritt + 1) * schritt;
    const rest = naechster - gesamt;
    const proTag = summe(letzte3(laeufe), e => e.strecke) / 91;
    const wochen = proTag > 0 ? Math.max(1, Math.round(rest / proTag / 7)) : null;
    const kern = `${tsd(gesamt)} km`;
    entwicklung.push({ icon:'🏁', color:'#EA580C', conf:'Meilenstein',
      text:`Seit ${monatLang(erster.slice(0,7))} bist du ${kern} gelaufen. Noch ${zahl(rest,1)} km bis ${tsd(naechster)} km` +
        (wochen ? ` – beim Tempo der letzten 3 Monate in etwa ${wochen} ${wochen === 1 ? 'Woche' : 'Wochen'}.` : '.'), hl:[F(kern)] });
  }

  // ── Training und Gesundheit ──
  // 18 Schlaf vor den schnellsten Laeufen (schnellstes Viertel, Laeufe ab 3 km)
  {
    const mitSchlaf = mitPace.filter(e => e.strecke >= 3 && byDate[e.datum] && byDate[e.datum].sleepTotal != null);
    if (mitSchlaf.length >= 8) {
      const sortiert = [...mitSchlaf].sort((a, b) => pace(a) - pace(b));
      const k = Math.ceil(sortiert.length / 4);
      const schnell = sortiert.slice(0, k), uebrige = sortiert.slice(k);
      const sl = liste => liste.reduce((s, e) => s + byDate[e.datum].sleepTotal, 0) / liste.length;
      const ss = sl(schnell), su = sl(uebrige), min = Math.round((ss - su) * 60);
      const kern = Math.abs(min) < 5 ? 'etwa gleich lang' : `${Math.abs(min)} Minuten ${min > 0 ? 'mehr' : 'weniger'}`;
      gesundheit.push({ icon:'🌙', color:'#7C3AED', conf:'Schlaf vor schnellen Läufen',
        text: Math.abs(min) < 5
          ? `Vor deinen schnellsten Läufen hast du ${kern} geschlafen wie vor den übrigen (${alsStdMin(ss)}).`
          : `Vor deinen schnellsten Läufen (schnellstes Viertel) hast du im Schnitt ${alsStdMin(ss)} geschlafen – ${kern} als vor den übrigen.`,
        hl:[{ phrase: kern, c: min >= 5 ? GUT : 'inherit' }] });
    }
  }
  // 19 Schlaf nach langen Laeufen (ab 15 km; sind es weniger als drei, das laengste Viertel)
  {
    const folge = d => { const r = byDate[addDays(d, 1)]; return r && r.sleepTotal != null ? r.sleepTotal : null; };
    const mitFolge = laeufe.filter(e => folge(e.datum) != null);
    let lang = mitFolge.filter(e => e.strecke >= 15), schwelle = 15;
    if (lang.length < 3 && mitFolge.length >= 8) {
      const sortiert = [...mitFolge].sort((a, b) => b.strecke - a.strecke);
      lang = sortiert.slice(0, Math.ceil(sortiert.length / 4));
      schwelle = Math.floor(lang[lang.length - 1].strecke * 10) / 10;
    }
    if (lang.length >= 3) {
      const langTage = new Set(lang.map(e => e.datum));
      const sonst = allData.filter(r => !langTage.has(r.date)).map(r => folge(r.date)).filter(v => v != null);
      if (sonst.length >= 10) {
        const sl = lang.reduce((s, e) => s + folge(e.datum), 0) / lang.length;
        const so = sonst.reduce((s, v) => s + v, 0) / sonst.length;
        const min = Math.round((sl - so) * 60);
        const kern = Math.abs(min) < 5 ? 'etwa gleich lang' : `${Math.abs(min)} Minuten ${min > 0 ? 'länger' : 'kürzer'}`;
        gesundheit.push({ icon:'😴', color:'#7C3AED', conf:'Schlaf nach langen Läufen',
          text:`Nach Läufen ab ${zahl(schwelle,1)} km schläfst du in der Folgenacht ${kern}${Math.abs(min) < 5 ? ' wie sonst' : ' als sonst'} (${alsStdMin(sl)} statt ${alsStdMin(so)}).`,
          hl:[{ phrase: kern, c: min >= 5 ? GUT : 'inherit' }] });
      }
    }
  }

  return [
    { titel: 'Rekorde', hinweis: `seit ${monatLang(erster.slice(0,7))}`, karten: rekorde },
    { titel: 'Gewohnheiten', karten: gewohnheiten },
    { titel: 'Entwicklung', karten: entwicklung },
    { titel: 'Training und Gesundheit', karten: gesundheit }
  ].filter(a => a.karten.length);
}

// Die Abschnitte als Markup – fuer Training, Herz und Schlaf. EINE Huelle; `klapp`
// gibt ihr `ausklapp-teil` (Training: sie steht dort frei im Tab). In Herz und Schlaf
// liegt sie in `.weitere-inhalt`, das die Klasse schon traegt – ein Teil im Teil
// liefe doppelt.
function einblickeHTML(abschnitte, klapp) {
  if (!abschnitte.length) return '';
  return `<div class="einblicke${klapp ? ' ausklapp-teil' : ''}">` + abschnitte.map(a =>
    `<div class="eb-abschnitt"><span>${a.titel}</span>${a.hinweis ? `<span class="eb-hinweis">${a.hinweis}</span>` : ''}</div>`
    + `<div class="pi-grid">${a.karten.map(insightKarte).join('')}</div>`).join('') + `</div>`;
}

// ── Einblicke in Herz und Schlaf (auf Wunsch, 19.09.2026) ──────────────────
// Wie die Trainings-Einblicke: Karten hinter dem Ausklapp-Knopf, alle ueber den
// GESAMTEN Datenbestand – sie folgen dem Zeitfilter nicht. Bewusst ohne Doppel zu
// „Muster & Zusammenhaenge" der Uebersicht; dort stehen die 30-Tage-Trends,
// Schlaf→HRV, HRV→Ruhepuls, Training→HRV/Ruhepuls am Folgetag, Schritte→Schlaf/HRV,
// die HRV je Wochentag und die Schlafdauer Wochentag gegen Wochenende.
// Nacht-Zuordnung wie ueberall: `sleepTotal` am Tag d ist die Nacht VOR d.
// Jede Karte hat Mindestmengen und fehlt, wenn sie nicht erreicht sind.
function herzInsights() { return _memo('herzInsights', _herzInsightsBerechnen); }
function _herzInsightsBerechnen() {
  const hr = allData.filter(r => r.restHR > 0), hv = allData.filter(r => r.hrv > 0);
  if (hr.length < 14 && hv.length < 14) return [];
  const daten = [...hr, ...hv].map(r => r.date).sort();
  const erster = daten[0], ende = daten[daten.length - 1];
  const byDate = {}; allData.forEach(r => { byDate[r.date] = r; });
  const PULS = '#EF4444', HRV = '#2563EB';
  const bpm = v => `${Math.round(v)} bpm`, ms = v => `${Math.round(v)} ms`;
  const puls = rows => rows.map(r => r.restHR), var_ = rows => rows.map(r => r.hrv);
  const { letzte3, davor3 } = _ebQuartale(ende);
  const rekorde = [], muster = [], entwicklung = [], alltag = [];

  // ── Rekorde ──
  // 1 Tiefster Ruhepuls
  if (hr.length >= 14) {
    const b = hr.reduce((a, r) => r.restHR <= a.restHR ? r : a);
    const jetzt = mittelArr(puls(hr.filter(r => r.date > addDays(ende, -30))));
    const kern = bpm(b.restHR);
    rekorde.push({ icon:'🫀', color:PULS, conf:'Tiefster Ruhepuls',
      text:`Dein tiefster Ruhepuls: ${kern} am ${_ebWochentag(b.date)}, ${_ebDatum(b.date)}.` +
        (jetzt != null ? ` In den letzten 30 Tagen liegst du im Schnitt bei ${bpm(jetzt)}.` : ''), hl:[_ebFett(kern)] });
  }
  // 2 Hoechste HRV
  if (hv.length >= 14) {
    const b = hv.reduce((a, r) => r.hrv >= a.hrv ? r : a);
    const jetzt = mittelArr(var_(hv.filter(r => r.date > addDays(ende, -30))));
    const kern = ms(b.hrv);
    rekorde.push({ icon:'💙', color:HRV, conf:'Höchste HRV',
      text:`Deine höchste HRV: ${kern} am ${_ebWochentag(b.date)}, ${_ebDatum(b.date)}.` +
        (jetzt != null ? ` In den letzten 30 Tagen liegst du im Schnitt bei ${ms(jetzt)}.` : ''), hl:[_ebFett(kern)] });
  }
  // 3 Ruhigster Monat (tiefster Ø Ruhepuls)
  {
    const b = _ebBeste(_ebGruppiert(hr, r => r.date.slice(0,7), r => r.restHR), 10, false);
    if (b) {
      const kern = `${_ebMonat(b.k)} mit Ø\u00A0${bpm(b.wert)}`;
      rekorde.push({ icon:'🗓️', color:PULS, conf:'Ruhigster Monat',
        text:`Am tiefsten war dein Ruhepuls im ${kern} – über alle Monate liegt er bei Ø\u00A0${bpm(mittelArr(puls(hr)))}.`, hl:[_ebFett(kern)] });
    }
  }
  // 4 Bester HRV-Monat
  {
    const b = _ebBeste(_ebGruppiert(hv, r => r.date.slice(0,7), r => r.hrv), 10, true);
    if (b) {
      const kern = `${_ebMonat(b.k)} mit Ø\u00A0${ms(b.wert)}`;
      rekorde.push({ icon:'📅', color:HRV, conf:'Bester HRV-Monat',
        text:`Am höchsten war deine HRV im ${kern} – über alle Monate liegt sie bei Ø\u00A0${ms(mittelArr(var_(hv)))}.`, hl:[_ebFett(kern)] });
    }
  }

  // ── Muster ──
  // 5 Normalbereich: 8 von 10 Tagen (10. bis 90. Perzentil)
  {
    const teile = [], hl = [];
    if (hr.length >= 30) { const k = `zwischen ${Math.round(_ebQuantil(puls(hr), .1))} und ${bpm(_ebQuantil(puls(hr), .9))}`; teile.push(`dein Ruhepuls ${k}`); hl.push(_ebFett(k)); }
    if (hv.length >= 30) { const k = `zwischen ${Math.round(_ebQuantil(var_(hv), .1))} und ${ms(_ebQuantil(var_(hv), .9))}`; teile.push(`deine HRV ${k}`); hl.push(_ebFett(k)); }
    if (teile.length) muster.push({ icon:'🎯', color:PULS, conf:'Dein Normalbereich',
      text:`An 8 von 10 Tagen liegt ${teile.join(' und ')}. Fällt ein Tag heraus, lohnt ein Blick auf Schlaf und Belastung.`, hl });
  }
  // 6 Wochenrhythmus des Ruhepulses (die HRV je Wochentag steht in der Uebersicht)
  if (hr.length >= 28) {
    const je = [[],[],[],[],[],[],[]];
    hr.forEach(r => je[new Date(r.date + 'T00:00:00').getDay()].push(r.restHR));
    if (je.every(l => l.length >= 4)) {
      const m = je.map(mittelArr);
      const lo = m.indexOf(Math.min(...m)), hi = m.indexOf(Math.max(...m));
      const kern = `am ${WOCHENTAG_LANG[lo]}`;
      muster.push({ icon:'📆', color:PULS, conf:'Wochenrhythmus',
        text: m[hi] - m[lo] < 1
          ? `Dein Ruhepuls ist an allen Wochentagen praktisch gleich – der Unterschied bleibt unter 1 bpm.`
          : `Am ruhigsten ist dein Herz ${kern} (Ø\u00A0${zahl(m[lo],1)} bpm), am schnellsten schlägt es am ${WOCHENTAG_LANG[hi]} (Ø\u00A0${zahl(m[hi],1)} bpm).`,
        hl: m[hi] - m[lo] < 1 ? [] : [_ebFett(kern)] });
    }
  }
  // 7 Ausreisser: hoechster Ruhepuls, mit dem, was davor war
  if (hr.length >= 30) {
    const a = hr.reduce((x, r) => r.restHR >= x.restHR ? r : x);
    const schnitt = mittelArr(puls(hr));
    const sl = a.sleepTotal, vortag = workoutData[addDays(a.date, -1)];
    const davor = [];
    if (sl > 0 && sl < 6.5) davor.push(`in der Nacht davor hast du nur ${alsStdMin(sl)} geschlafen`);
    if (vortag && vortag.distanceKm >= 10) davor.push(`am Vortag bist du ${zahl(vortag.distanceKm,1)} km gelaufen`);
    else if (vortag && vortag.durationMin >= 60) davor.push(`am Vortag hast du ${fmtMin(vortag.durationMin)} trainiert`);
    const kern = bpm(a.restHR);
    const satz = davor.join(', und ');
    muster.push({ icon:'📍', color:PULS, conf:'Ausreisser',
      text:`Dein höchster Ruhepuls: ${kern} am ${_ebDatum(a.date)} – ${zahl(a.restHR - schnitt,0)} bpm über deinem Schnitt.` +
        (satz ? ` ${satz[0].toUpperCase()}${satz.slice(1)}.` : ''), hl:[_ebFett(kern)] });
  }
  // 8 Jahreszeiten: Winter (Dez–Feb) gegen Sommer (Jun–Aug)
  {
    const saetze = [], hl = [];
    const vergleich = (rows, wert, schwelle, dec, einheit, name, erster) => {
      const w = mittelArr(_ebSaison(rows, _EB_WINTER).map(wert)), so = mittelArr(_ebSaison(rows, _EB_SOMMER).map(wert));
      const nw = _ebSaison(rows, _EB_WINTER).length, ns = _ebSaison(rows, _EB_SOMMER).length;
      if (nw < 20 || ns < 20) return;
      const d = w - so, gleich = Math.abs(d) < schwelle;
      const kern = gleich ? 'etwa gleich hoch' : `${zahl(Math.abs(d), dec)} ${einheit} ${d > 0 ? 'höher' : 'tiefer'}`;
      saetze.push(`${erster ? 'Im Winter (Dez–Feb) liegt' : 'Im Winter liegt'} ${name} ${kern}${gleich ? ' wie' : ' als'} im Sommer${erster ? ' (Jun–Aug)' : ''} – Ø\u00A0${Math.round(w)} gegen ${Math.round(so)} ${einheit}.`);
      if (!hl.some(h => h.phrase === kern)) hl.push(_ebFett(kern));
    };
    vergleich(hr, r => r.restHR, 1, 1, 'bpm', 'dein Ruhepuls', true);
    vergleich(hv, r => r.hrv, 1, 0, 'ms', 'deine HRV', !saetze.length);
    if (saetze.length) muster.push({ icon:'❄️', color:HRV, conf:'Jahreszeiten', text: saetze.join(' '), hl });
  }

  // ── Entwicklung ──
  // 9/10 Ruhepuls und HRV: letzte 3 Monate gegen die 3 davor
  const trend = (rows, wert, schwelle, dec, einheit, besserTief, name, conf, farbe) => {
    const a = letzte3(rows).map(wert), b = davor3(rows).map(wert);
    if (a.length < 20 || b.length < 20) return;
    const ma = mittelArr(a), mb = mittelArr(b), d = ma - mb, gleich = Math.abs(d) < schwelle;
    const besser = besserTief ? d < 0 : d > 0;
    const kern = gleich ? 'praktisch unverändert' : `${zahl(Math.abs(d), dec)} ${einheit} ${d < 0 ? 'tiefer' : 'höher'}`;
    const c = gleich ? 'inherit' : besser ? _EB_GUT : _EB_ACHTUNG;
    entwicklung.push({ icon: gleich ? '➖' : d < 0 ? '📉' : '📈', color: gleich ? farbe : c, conf,
      text:`${name} der letzten 3 Monate: ${zahl(ma, dec)} ${einheit} – ${kern}${gleich ? ' gegenüber' : ' als in'} den 3 Monaten davor (${zahl(mb, dec)} ${einheit}).`,
      hl:[{ phrase: kern, c }] });
  };
  trend(hr, r => r.restHR, .5, 1, 'bpm', true,  'Dein Ø Ruhepuls', 'Ruhepuls · 3 Monate', PULS);
  trend(hv, r => r.hrv,    1,  0, 'ms',  false, 'Deine Ø HRV',     'HRV · 3 Monate',      HRV);
  // 11 Seit Beginn: erste 3 Monate gegen die letzten 3 – erst ab einem Jahr Daten
  if (_ebTage(erster, ende) >= 365) {
    const anfang = rows => rows.filter(r => r.date <= addDays(erster, 90)), jetzt = rows => rows.filter(r => r.date > addDays(ende, -91));
    const teile = [], heute = [], hl = [];
    const seit = (rows, wert, schwelle, dec, einheit, besserTief, name) => {
      const a = anfang(rows).map(wert), n = jetzt(rows).map(wert);
      if (a.length < 20 || n.length < 20) return;
      const ma = mittelArr(a), mn = mittelArr(n), d = mn - ma, gleich = Math.abs(d) < schwelle;
      const kern = gleich ? 'praktisch gleich geblieben' : `um ${zahl(Math.abs(d), dec)} ${einheit} ${d < 0 ? 'gesunken' : 'gestiegen'}`;
      teile.push(`${name} ${kern}`); heute.push(`${Math.round(mn)} ${einheit}`);
      if (!hl.some(h => h.phrase === kern)) hl.push({ phrase: kern, c: gleich ? 'inherit' : (besserTief ? d < 0 : d > 0) ? _EB_GUT : _EB_ACHTUNG });
    };
    seit(hr, r => r.restHR, .5, 1, 'bpm', true, 'dein Ruhepuls');
    seit(hv, r => r.hrv, 1, 0, 'ms', false, 'deine HRV');
    if (teile.length) entwicklung.push({ icon:'🧭', color:PULS, conf:'Seit Beginn',
      text:`Seit deinen ersten 3 Monaten (ab ${_ebMonat(erster.slice(0,7))}) ist ${teile.join(' und ')} – heute Ø\u00A0${heute.join(' und ')}.`, hl });
  }

  // ── Herz und Alltag ──
  // 12 Erholung nach langen Laeufen (ab 15 km; sind es weniger als drei, das laengste
  // Viertel). Bezug ist der Ø Ruhepuls der 7 Tage VOR dem Lauf, nicht der Gesamtschnitt –
  // so zaehlt nur, was der Lauf veraendert, nicht die Jahreszeit.
  {
    const laufKm = {};
    Object.keys(workoutData).forEach(d => {
      const w = workoutData[d] || {};
      const liste = Array.isArray(w.einheiten) && w.einheiten.length ? w.einheiten : [{ strecke: w.distanceKm }];
      const km = Math.max(0, ...liste.map(e => (e && typeof e.strecke === 'number' && isFinite(e.strecke)) ? e.strecke : 0));
      if (km > 0) laufKm[d] = km;
    });
    const alle = Object.keys(laufKm);
    let lang = alle.filter(d => laufKm[d] >= 15), schwelle = 15;
    if (lang.length < 3 && alle.length >= 8) {
      lang = [...alle].sort((a, b) => laufKm[b] - laufKm[a]).slice(0, Math.ceil(alle.length / 4));
      schwelle = Math.floor(Math.min(...lang.map(d => laufKm[d])) * 10) / 10;
    }
    const hrAm = d => byDate[d] && byDate[d].restHR > 0 ? byDate[d].restHR : null;
    const abw = [[], [], []];
    lang.forEach(d => {
      const vorher = [1,2,3,4,5,6,7].map(k => hrAm(addDays(d, -k))).filter(v => v != null);
      if (vorher.length < 4) return;
      const basis = mittelArr(vorher);
      for (let k = 1; k <= 3; k++) { const v = hrAm(addDays(d, k)); if (v != null) abw[k - 1].push(v - basis); }
    });
    if (abw[0].length >= 3) {
      const m = abw.map(mittelArr), ab = `Nach Läufen ab ${zahl(schwelle,1)} km`;
      let text, kern;
      if (m[0] < .5) {
        kern = m[0] > -.5 ? 'kaum verändert' : `${zahl(-m[0],1)} bpm tiefer`;
        text = `${ab} ist dein Ruhepuls am Folgetag ${kern}${m[0] > -.5 ? ' gegenüber' : ' als in'} der Woche davor – dein Herz steckt lange Läufe gut weg.`;
      } else {
        kern = `${zahl(m[0],1)} bpm höher`;
        const zurueck = m.findIndex((v, i) => i > 0 && v != null && v < .5);
        text = `${ab} liegt dein Ruhepuls am Folgetag ${kern} als in der Woche davor` +
          (zurueck > 0 ? `; nach ${zurueck + 1} Tagen ist er wieder auf dem gewohnten Niveau.`
            : m[2] != null ? `, auch drei Tage danach noch ${zahl(m[2],1)} bpm darüber.` : '.');
      }
      alltag.push({ icon:'🏃', color:PULS, conf:'Erholung nach langen Läufen', text, hl:[_ebFett(kern)] });
    }
  }
  // 13 Kurze Naechte und Ruhepuls (unter 6h 30m gegen ab Schlafziel)
  {
    const ziel = ZIELE.sleepTotal.ziel;
    const paare = allData.filter(r => r.restHR > 0 && r.sleepTotal > 0);
    let kurz = paare.filter(r => r.sleepTotal < 6.5), grenze = `unter ${alsStdMin(6.5)}`;
    if (kurz.length < 8 && paare.length >= 40) {
      kurz = [...paare].sort((a, b) => a.sleepTotal - b.sleepTotal).slice(0, Math.ceil(paare.length / 4));
      grenze = `bis ${alsStdMin(kurz[kurz.length - 1].sleepTotal)}`;
    }
    const kurzSet = new Set(kurz);
    const gut = paare.filter(r => r.sleepTotal >= ziel && !kurzSet.has(r));
    if (kurz.length >= 8 && gut.length >= 8) {
      const a = mittelArr(puls(kurz)), b = mittelArr(puls(gut)), d = a - b, gleich = Math.abs(d) < .5;
      const kern = gleich ? 'etwa gleich hoch' : `${zahl(Math.abs(d),1)} bpm ${d > 0 ? 'höher' : 'tiefer'}`;
      alltag.push({ icon:'😴', color:PULS, conf:'Kurze Nächte und Ruhepuls',
        text:`Nach Nächten ${grenze} liegt dein Ruhepuls im Schnitt ${kern}${gleich ? ' wie' : ' als'} nach Nächten ab ${alsStdMin(ziel)} (${zahl(a,1)} gegen ${zahl(b,1)} bpm).`,
        hl:[{ phrase: kern, c: !gleich && d > 0 ? _EB_ACHTUNG : 'inherit' }] });
    }
  }
  // 14 Tiefschlaf und HRV: oberstes gegen unterstes Viertel der Naechte
  {
    const paare = allData.filter(r => r.hrv > 0 && r.sleepDeep > 0).sort((a, b) => a.sleepDeep - b.sleepDeep);
    if (paare.length >= 40) {
      const k = Math.floor(paare.length / 4), wenig = paare.slice(0, k), viel = paare.slice(-k);
      const d = mittelArr(var_(viel)) - mittelArr(var_(wenig)), gleich = Math.abs(d) < 1;
      const kern = gleich ? 'etwa gleich hoch' : `${zahl(Math.abs(d),0)} ms ${d > 0 ? 'höher' : 'tiefer'}`;
      alltag.push({ icon:'🌊', color:HRV, conf:'Tiefschlaf und HRV',
        text:`Nach Nächten mit viel Tiefschlaf (ab ${alsStdMin(viel[0].sleepDeep)}) ist deine HRV im Schnitt ${kern}${gleich ? ' wie' : ' als'} nach Nächten mit wenig (bis ${alsStdMin(wenig[k - 1].sleepDeep)}).`,
        hl:[{ phrase: kern, c: !gleich && d > 0 ? _EB_GUT : 'inherit' }] });
    }
  }

  return [
    { titel: 'Rekorde', hinweis: `seit ${_ebMonat(erster.slice(0,7))}`, karten: rekorde },
    { titel: 'Muster', karten: muster },
    { titel: 'Entwicklung', karten: entwicklung },
    { titel: 'Herz und Alltag', karten: alltag }
  ].filter(a => a.karten.length);
}

function schlafInsights() { return _memo('schlafInsights', _schlafInsightsBerechnen); }
function _schlafInsightsBerechnen() {
  const naechte = allData.filter(r => r.sleepTotal > 0);
  if (naechte.length < 14) return [];
  const erster = naechte[0].date, ende = naechte[naechte.length - 1].date;
  const byDate = {}; allData.forEach(r => { byDate[r.date] = r; });
  const ZIEL = ZIELE.sleepTotal.ziel;
  const LILA = '#7C3AED', LILA_HELL = '#8B5CF6', LILA_DUNKEL = '#6D28D9';
  const dauer = rows => rows.map(r => r.sleepTotal);
  const minuten = h => Math.round(h * 60);
  const { letzte3, davor3 } = _ebQuartale(ende);
  const quote = rows => Math.round(rows.filter(r => r.sleepTotal >= ZIEL).length / rows.length * 100);
  const rekorde = [], rhythmus = [], entwicklung = [], zusammen = [];

  // Schlafzeiten. Einschlafen vor Mittag zaehlt als nach Mitternacht (+24 h), sonst
  // laege 00:30 im Mittel sieben Stunden vor 23:30. Die Schlafmitte nur, wenn die Nacht
  // plausibel lang ist (2–16 h) – sonst ist eine der beiden Angaben verrutscht.
  const zeiten = naechte.map(r => {
    const s = parseTV(r.sleepStart), e = parseTV(r.sleepEnd);
    const ein = s != null ? (s < 12 ? s + 24 : s) : null;
    let mitte = null;
    if (ein != null && e != null) { let auf = e; while (auf <= ein) auf += 24; if (auf - ein >= 2 && auf - ein <= 16) mitte = (ein + auf) / 2; }
    return { date: r.date, sleepTotal: r.sleepTotal, ein, auf: e, mitte };
  });
  const mitEin = zeiten.filter(z => z.ein != null), mitAuf = zeiten.filter(z => z.auf != null);

  // ── Rekorde ──
  // 1 Laengste Nacht
  {
    const l = naechte.reduce((a, r) => r.sleepTotal >= a.sleepTotal ? r : a);
    const kern = alsStdMin(l.sleepTotal);
    rekorde.push({ icon:'🛌', color:LILA, conf:'Längste Nacht',
      text:`Deine längste Nacht: ${kern} in der Nacht auf ${_ebWochentag(l.date)}, ${_ebDatum(l.date)}. Im Schnitt schläfst du ${alsStdMin(mittelArr(dauer(naechte)))}.`, hl:[_ebFett(kern)] });
  }
  // 2 Laengste Serie mit erreichtem Schlafziel – eine fehlende Nacht unterbricht sie
  {
    let lauf = 0, best = 0, bestEnde = null, vorher = null;
    naechte.forEach(r => {
      const folgt = vorher && addDays(vorher, 1) === r.date;
      lauf = r.sleepTotal >= ZIEL ? (folgt ? lauf + 1 : 1) : 0;
      if (lauf && lauf >= best) { best = lauf; bestEnde = r.date; }
      vorher = r.date;
    });
    if (best >= 2) {
      const kern = `${best} Nächte in Folge`;
      const jetzt = lauf >= best ? ' Du bist gerade mittendrin – das ist deine Bestserie.'
        : lauf >= 2 ? ` Aktuell läuft eine Serie von ${lauf} Nächten.` : '';
      rekorde.push({ icon:'🔗', color:LILA, conf:'Längste Zielserie',
        text:`Deine längste Serie: ${kern} mit mindestens ${alsStdMin(ZIEL)} Schlaf${lauf >= best ? '' : ` (bis ${_ebDatum(bestEnde)})`}.${jetzt}`, hl:[_ebFett(kern)] });
    }
  }
  // 3 Bester Schlafmonat
  {
    const b = _ebBeste(_ebGruppiert(naechte, r => r.date.slice(0,7), r => r.sleepTotal), 10, true);
    if (b) {
      const kern = `${_ebMonat(b.k)} mit Ø\u00A0${alsStdMin(b.wert)}`;
      const n = naechte.filter(r => r.date.startsWith(b.k) && r.sleepTotal >= ZIEL).length;
      rekorde.push({ icon:'🗓️', color:LILA, conf:'Bester Schlafmonat',
        text:`Am meisten geschlafen hast du im ${kern} – das Ziel hast du in ${n} von ${b.n} Nächten erreicht.`, hl:[_ebFett(kern)] });
    }
  }
  // 4 Beste Woche (mindestens 5 Naechte)
  {
    const b = _ebBeste(_ebGruppiert(naechte, r => getWeekMonday(r.date), r => r.sleepTotal), 5, true);
    if (b) {
      const kern = `Ø\u00A0${alsStdMin(b.wert)} pro Nacht`;
      rekorde.push({ icon:'📅', color:LILA, conf:'Beste Woche',
        text:`Deine erholsamste Woche: KW ${isoKW(b.k)} (${_ebTagMonat(b.k)}–${_ebTagMonat(addDays(b.k, 6))}${addDays(b.k, 6).slice(0,4)}) mit ${kern}.`, hl:[_ebFett(kern)] });
    }
  }

  // ── Rhythmus ──
  // 5 Typische Schlafzeiten (Median)
  if (mitEin.length >= 14 && mitAuf.length >= 14) {
    const kern = `um ${_ebUhr(_ebQuantil(mitEin.map(z => z.ein), .5))}`;
    rhythmus.push({ icon:'⏰', color:LILA_HELL, conf:'Typische Schlafzeiten',
      text:`Du schläfst typischerweise ${kern} ein und wachst um ${_ebUhr(_ebQuantil(mitAuf.map(z => z.auf), .5))} auf – der Median aus ${Math.min(mitEin.length, mitAuf.length)} Nächten.`, hl:[_ebFett(kern)] });
  }
  // 6 Regelmaessigkeit: die mittlere Haelfte der Naechte (25. bis 75. Perzentil)
  if (mitEin.length >= 14 && mitAuf.length >= 14) {
    const spanne = werte => { const a = _ebQuantil(werte, .25), b = _ebQuantil(werte, .75); return { a, b, min: minuten(b - a) }; };
    const e = spanne(mitEin.map(z => z.ein)), w = spanne(mitAuf.map(z => z.auf));
    const kern = `${e.min} Minuten`;
    rhythmus.push({ icon:'🎯', color:LILA_HELL, conf:'Regelmässigkeit',
      text:`In der Hälfte deiner Nächte schläfst du innerhalb von ${kern} ein (${_ebUhr(e.a)}–${_ebUhr(e.b)}) und wachst innerhalb von ${w.min} Minuten auf (${_ebUhr(w.a)}–${_ebUhr(w.b)}).`, hl:[_ebFett(kern)] });
  }
  // 7 Wochenrhythmus: Nacht auf welchen Wochentag ist am laengsten / kuerzesten?
  {
    const je = [[],[],[],[],[],[],[]];
    naechte.forEach(r => je[new Date(r.date + 'T00:00:00').getDay()].push(r.sleepTotal));
    if (je.every(l => l.length >= 4)) {
      const m = je.map(mittelArr);
      const hi = m.indexOf(Math.max(...m)), lo = m.indexOf(Math.min(...m));
      const kern = `Nacht auf ${WOCHENTAG_LANG[hi]}`;
      rhythmus.push({ icon:'📆', color:LILA_HELL, conf:'Wochenrhythmus',
        text:`Am längsten schläfst du in der ${kern} (Ø\u00A0${alsStdMin(m[hi])}), am kürzesten in der Nacht auf ${WOCHENTAG_LANG[lo]} (Ø\u00A0${alsStdMin(m[lo])}).`, hl:[_ebFett(kern)] });
    }
  }
  // 8 Schlafmitte am Wochenende gegen unter der Woche. Naechte auf Samstag und Sonntag
  // gehen einem freien Tag voraus – das Mass fuer „sozialen Jetlag".
  {
    const mitMitte = zeiten.filter(z => z.mitte != null);
    const we = mitMitte.filter(z => [0, 6].includes(new Date(z.date + 'T00:00:00').getDay()));
    const wt = mitMitte.filter(z => ![0, 6].includes(new Date(z.date + 'T00:00:00').getDay()));
    if (we.length >= 8 && wt.length >= 8) {
      const a = mittelArr(we.map(z => z.mitte)), b = mittelArr(wt.map(z => z.mitte)), d = minuten(a - b), gleich = Math.abs(d) < 15;
      const kern = gleich ? 'praktisch gleich' : `${Math.abs(d)} Minuten ${d > 0 ? 'später' : 'früher'}`;
      rhythmus.push({ icon:'🕰️', color:LILA_HELL, conf:'Schlafmitte am Wochenende',
        text:`Am Wochenende liegt die Mitte deines Schlafs ${kern}${gleich ? ' wie' : ' als'} unter der Woche (${_ebUhr(a)} gegen ${_ebUhr(b)}).` +
          (d >= 60 ? ' Ab einer Stunde spricht man von sozialem Jetlag – der Körper muss sich jeden Montag neu einstellen.' : ''),
        hl:[{ phrase: kern, c: d >= 60 ? _EB_ACHTUNG : 'inherit' }] });
    }
  }

  // ── Entwicklung ──
  // 9 Schlafdauer und Zielquote: letzte 3 Monate gegen die 3 davor
  {
    const a = letzte3(naechte), b = davor3(naechte);
    if (a.length >= 20 && b.length >= 20) {
      const ma = mittelArr(dauer(a)), mb = mittelArr(dauer(b)), d = minuten(ma - mb), gleich = Math.abs(d) < 5;
      const kern = gleich ? 'praktisch unverändert' : `${Math.abs(d)} Minuten ${d > 0 ? 'mehr' : 'weniger'}`;
      const c = gleich ? 'inherit' : d > 0 ? _EB_GUT : _EB_ACHTUNG;
      entwicklung.push({ icon: gleich ? '➖' : d > 0 ? '📈' : '📉', color: gleich ? LILA_DUNKEL : c, conf:'Schlafdauer · 3 Monate',
        text:`Ø der letzten 3 Monate: ${alsStdMin(ma)} pro Nacht – ${kern}${gleich ? ' gegenüber' : ' als in'} den 3 Monaten davor (${alsStdMin(mb)}). Schlafziel erreicht in ${quote(a)} % der Nächte, davor in ${quote(b)} %.`,
        hl:[{ phrase: kern, c }] });
    }
  }
  // 10 Einschlafzeit: letzte 3 Monate gegen die 3 davor (Median)
  {
    const a = letzte3(mitEin), b = davor3(mitEin);
    if (a.length >= 20 && b.length >= 20) {
      const ma = _ebQuantil(a.map(z => z.ein), .5), mb = _ebQuantil(b.map(z => z.ein), .5), d = minuten(ma - mb), gleich = Math.abs(d) < 5;
      const kern = gleich ? 'praktisch zur selben Zeit' : `${Math.abs(d)} Minuten ${d < 0 ? 'früher' : 'später'}`;
      entwicklung.push({ icon:'🌙', color:LILA_DUNKEL, conf:'Einschlafzeit · 3 Monate',
        text:`In den letzten 3 Monaten schläfst du ${kern} ein${gleich ? ' wie' : ' als'} in den 3 Monaten davor (${_ebUhr(ma)} statt ${_ebUhr(mb)}).`, hl:[_ebFett(kern)] });
    }
  }
  // 11 Jahreszeiten: Winter (Dez–Feb) gegen Sommer (Jun–Aug)
  {
    const w = _ebSaison(naechte, _EB_WINTER), so = _ebSaison(naechte, _EB_SOMMER);
    if (w.length >= 20 && so.length >= 20) {
      const mw = mittelArr(dauer(w)), ms_ = mittelArr(dauer(so)), d = minuten(mw - ms_), gleich = Math.abs(d) < 5;
      const kern = gleich ? 'etwa gleich lang' : `${Math.abs(d)} Minuten ${d > 0 ? 'länger' : 'kürzer'}`;
      entwicklung.push({ icon:'❄️', color:LILA_DUNKEL, conf:'Jahreszeiten',
        text:`Im Winter (Dez–Feb) schläfst du im Schnitt ${kern}${gleich ? ' wie' : ' als'} im Sommer (Jun–Aug) – ${alsStdMin(mw)} gegen ${alsStdMin(ms_)}.`, hl:[_ebFett(kern)] });
    }
  }

  // ── Zusammenhaenge ──
  // 12 Folgenacht nach Trainings- gegen Ruhetage. Ruhetage erst ab dem ersten
  // erfassten Training – davor fehlt nur das Workout-Blatt, nicht das Training.
  {
    const trainTage = Object.keys(workoutData).filter(istDatum).sort();
    if (trainTage.length) {
      const trainSet = new Set(trainTage);
      const folge = d => byDate[addDays(d, 1)];
      const nacht = d => { const r = folge(d); return r && r.sleepTotal > 0 ? r : null; };
      const T = trainTage.map(nacht).filter(Boolean);
      const R = allData.filter(r => r.date >= trainTage[0] && !trainSet.has(r.date)).map(r => nacht(r.date)).filter(Boolean);
      if (T.length >= 10 && R.length >= 10) {
        const t = mittelArr(dauer(T)), r = mittelArr(dauer(R)), d = minuten(t - r), gleich = Math.abs(d) < 5;
        const kern = gleich ? 'etwa gleich lang' : `${Math.abs(d)} Minuten ${d > 0 ? 'länger' : 'kürzer'}`;
        const hl = [{ phrase: kern, c: gleich ? 'inherit' : d > 0 ? _EB_GUT : _EB_ACHTUNG }];
        let tief = '';
        const tT = T.filter(x => x.sleepDeep > 0), tR = R.filter(x => x.sleepDeep > 0);
        if (tT.length >= 10 && tR.length >= 10) {
          const dt = minuten(mittelArr(tT.map(x => x.sleepDeep)) - mittelArr(tR.map(x => x.sleepDeep)));
          tief = Math.abs(dt) < 3 ? ', mit etwa gleich viel Tiefschlaf' : `, mit ${Math.abs(dt)} Minuten ${dt > 0 ? 'mehr' : 'weniger'} Tiefschlaf`;
        }
        zusammen.push({ icon:'🏋️', color:LILA, conf:'Schlaf nach dem Training',
          text:`Nach Trainingstagen schläfst du ${kern}${gleich ? ' wie' : ' als'} nach Ruhetagen (${alsStdMin(t)} gegen ${alsStdMin(r)})${tief}.`, hl });
      }
    }
  }
  // 13 Spaete Naechte: spaetestes Viertel der Einschlafzeiten gegen die uebrigen
  if (mitEin.length >= 40) {
    const s = [...mitEin].sort((a, b) => b.ein - a.ein), k = Math.ceil(s.length / 4);
    const spaet = s.slice(0, k), rest = s.slice(k);
    const a = mittelArr(dauer(spaet)), b = mittelArr(dauer(rest)), d = minuten(a - b), gleich = Math.abs(d) < 5;
    const kern = gleich ? 'etwa gleich lang' : `${Math.abs(d)} Minuten ${d < 0 ? 'kürzer' : 'länger'}`;
    zusammen.push({ icon:'🦉', color:LILA, conf:'Späte Nächte',
      text:`Schläfst du ab ${_ebUhr(spaet[k - 1].ein)} ein (spätestes Viertel deiner Nächte), schläfst du im Schnitt ${kern}${gleich ? ' wie' : ' als'} sonst – ${alsStdMin(a)} gegen ${alsStdMin(b)}.`,
      hl:[{ phrase: kern, c: !gleich && d < 0 ? _EB_ACHTUNG : 'inherit' }] });
  }

  return [
    { titel: 'Rekorde', hinweis: `seit ${_ebMonat(erster.slice(0,7))}`, karten: rekorde },
    { titel: 'Rhythmus', karten: rhythmus },
    { titel: 'Entwicklung', karten: entwicklung },
    { titel: 'Zusammenhänge', karten: zusammen }
  ].filter(a => a.karten.length);
}

// ── VO₂max-Abschnitt (zuunterst im Training-Tab) ───────
// Eigene Funktion, weil der Abschnitt inhaltlich für sich steht: er stammt aus dem
// früheren VO₂max-Tab und ist der einzige Teil des Training-Tabs, der NICHT aus dem
// Workout-Sheet kommt, sondern aus r.vo2max der Health-Daten.
// Liefert Markup und Zeichenfunktion getrennt, weil das Markup vor dem Canvas im DOM
// stehen muss, bevor Chart.js darauf zugreifen kann.
function vo2Abschnitt(D) {
  const v2r=D.filter(r=>r.vo2max!=null);
  const v2D=mittel(v2r,'vo2max');
  const {labels:_v2tL,align:_v2tA,hasData:_v2tHD,keys:_v2Keys,keyTyp:_v2KeyTyp}=timeDim(D,true,true);
  const v2MaFull=_v2tA('vo2max');

  // Fusszeile: nur die Durchschnittszeile („Ø 1M" …) bzw. im Jahresvergleich die
  // Vorjahreszeilen.
  const html = `
    <div class="chart-card" style="margin-bottom:0">
      <h3>VO₂max-Verlauf ${infoI('vo2max')}</h3>
      <div class="chart-legend"><div class="cl-item"><span class="cl-line" style="background:#D97706"></span>VO₂max</div>${hlLegende('c-vo2|ziel','Ziel','rgba(100,116,139,.55)')}${hlLegende('c-vo2|oe','Ø','#D97706')}</div>
      <div class="chart-wrap"><canvas id="c-vo2"></canvas></div>
      <div class="stats-list diagramm-fuss">
        ${istYoY()
          ? yoyZeilen([{ werte: yoyWerte(D, r => r.vo2max, 'mittel'), richtung: ZIELE.vo2max.richtung }])
          : statZeile(oeLabel(), `${v2D!=null?zahl(v2D,1)+' ml/kg/min':'—'}`)}
      </div>
    </div>`;

  function zeichnen() {
    if(_v2tHD&&v2MaFull.some(v=>v!=null)){
      let _v2Min=v2MaFull.filter(v=>v!=null).reduce((a,b)=>Math.min(a,b),Infinity);
      let _v2Max=v2MaFull.filter(v=>v!=null).reduce((a,b)=>Math.max(a,b),-Infinity);
      if(v2D!=null){ _v2Min=Math.min(_v2Min,v2D); _v2Max=Math.max(_v2Max,v2D); } // Ø-Linie im Sichtbereich halten
      // Ziellinie ebenfalls im Sichtbereich halten – muss VOR der Achsenberechnung stehen.
      _v2Min=Math.min(_v2Min, ZIELE.vo2max.ziel); _v2Max=Math.max(_v2Max, ZIELE.vo2max.ziel);
      const _v2Step=2;
      const _v2YMin=Math.floor(_v2Min/_v2Step)*_v2Step;
      const _v2YMax=Math.ceil(_v2Max/_v2Step)*_v2Step;
      const _v2Dsets=[{data:v2MaFull,borderColor:'#D97706',backgroundColor:'rgba(217,119,6,.08)',tension:.3,fill:true,pointRadius:4,pointBackgroundColor:'#D97706',spanGaps:true},
        ...zielDatensatz('c-vo2|ziel', 'vo2max', _v2tL.length),
        ...oeDatensatz('c-vo2|oe', mittelArr(v2MaFull), '#D97706', _v2tL.length)];
      zeichneDiagramm('c-vo2',{__keys:_v2Keys,__keyTyp:_v2KeyTyp,
        __werteFmt:v=>zahl(v,1),
        type:'line',data:{labels:_v2tL,datasets:_v2Dsets},
        options:{responsive:true,maintainAspectRatio:false,
          plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,filter:nurMesswerte,callbacks:{label:ctx=>ctx.raw!=null?`VO₂max: ${zahl(ctx.raw,2)} ml/kg/min`:null}}},
          scales:{x:achseX,y:{...achseY,min:_v2YMin,max:_v2YMax,ticks:{...achseY.ticks,stepSize:_v2Step}}}}});
    }
  }

  return { html, zeichnen };
}

// ── Navigation ─────────────────────────────────────────
const PAGE_FNS={overview:pgOverview,herz:pgHerz,schlaf:pgSchlaf,training:pgTraining};
// Kontrast-Symbol des Dark-Toggles (auf Wunsch, 18.09.2026): ein Kreis mit gefuellter
// Haelfte. EIN Symbol fuer beide Zustaende – im Dunkelmodus dreht es sich per CSS um
// 180°, deshalb tauscht `applyDarkMode` nichts aus.
const DARK_SYMBOL = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path class="voll" d="M12 3.5a8.5 8.5 0 0 1 0 17Z"/></svg>`;
// Titelzeile eines Tabs: Emoji + Name, rechtsbündig Zahnrad (nur Übersicht) und
// Dark-Toggle. Die Tab-Hintergründe sitzen auf .screen, nicht hier.
function pgBanner(icon,title){
  // Zahnrad NUR in der Uebersicht, in der durchscheinenden Optik der uebrigen `.pg-act`.
  const einst = _currentRenderingTab === 'overview'
    ? `<button class="pg-act einst-act" title="Einstellungen" aria-label="Einstellungen">
         <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 13.5a7.7 7.7 0 0 0 0-3l1.7-1.3-1.8-3.1-2 .8a7.7 7.7 0 0 0-2.6-1.5L14.4 3h-3.6l-.3 2.4a7.7 7.7 0 0 0-2.6 1.5l-2-.8-1.8 3.1 1.7 1.3a7.7 7.7 0 0 0 0 3l-1.7 1.3 1.8 3.1 2-.8a7.7 7.7 0 0 0 2.6 1.5l.3 2.4h3.6l.3-2.4a7.7 7.7 0 0 0 2.6-1.5l2 .8 1.8-3.1Z"/></svg>
       </button>`
    : '';
  return`<div class="pg-banner"><span class="pg-banner-icon">${icon}</span><div class="pg-banner-txt"><div class="pg-banner-title">${title}</div></div><div class="pg-banner-actions">${einst}<button class="pg-act dark-toggle" title="Hell/Dunkel" aria-label="Dunkelmodus" aria-pressed="${document.body.classList.contains('dark')?'true':'false'}">${DARK_SYMBOL}</button></div></div>`;
}
// ═══════════════════════════════════════════════════════════
// Tab-Navigation: horizontaler Snap-Scroller + Bottom-Nav
// ═══════════════════════════════════════════════════════════
const TAB_ORDER = ['overview','herz','schlaf','training'];
let currentScreen = 'overview';
let _suppressScrollSync = false;
let _currentRenderingTab = null;
const _renderedTabs = new Set();
const tabCharts = { overview:[], herz:[], schlaf:[], training:[] };

// Der angezeigte Zeitraum steht in der Titelzeile jedes Diagramms (filterTitelTeil);
// Bereichswahl, „Heute" und Blätterpfeile stehen EINMAL in der Zeitleiste unten am
// Bildschirm (zeitleisteBauen).

// Die wählbaren Bereiche: [timeRange-Wert, Beschriftung].
const _RANGE_OPTS = [
  ['7d','7T'],['1m','1M'],['3m','3M'],
  ['6m','6M'],['12m','12M'],['24m','24M']
];
// Label der Durchschnittszeile unter einem Diagramm (auf Wunsch, 18.09.2026):
// „Ø 7T", „Ø 1M" … – das Zeitfenster heisst dort genau wie in der Pille der
// Zeitleiste, damit man die Zahl ohne Nachdenken dem Filter zuordnet. Vorher stand
// „Durchschnitt" bzw. „Ø Schlafdauer". Mit `zusatz` fuer Diagramme mit mehreren
// Reihen je Zeile (Schlafphasen: „Ø 1M · REM-Schlaf").
// Im Jahresvergleich entfallen alle Durchschnittszeilen – dort wird es nie gerufen.
function oeLabel(zusatz) {
  const basis = 'Ø ' + bereichKurz();
  return zusatz ? basis + ' · ' + zusatz : basis;
}
// Kurzname des aktuellen Bereichs – fuer Pille und Durchschnittszeile: „7T", „YoY", „2025".
function bereichKurz() {
  if (istYoY()) return 'YoY';
  if (istJahr()) return String(jahrVon(referenceDate));
  const t = _RANGE_OPTS.find(([k]) => k === timeRange);
  return t ? t[1] : timeRange;
}
// Angezeigter Zeitraum als Text: bei 7T die Kalenderwoche, ab 1M der Monatsbereich –
// die Zeitachse zeigt dort nur Monate, und aus "Jun 26" allein ist nicht ablesbar,
// wie weit das Fenster zurückreicht.
function zeitraumText() {
  // Bei 7T die Kalenderwoche des angezeigten Fensters. Das Fenster laeuft Montag bis
  // Sonntag (weekDays7 baut es ueber getWeekMonday auf) und ist damit genau eine
  // ISO-Woche — der erste Tag bestimmt sie eindeutig.
  if (is7D()) {
    const tage = weekDays7();
    return tage.length ? 'KW ' + isoKW(tage[0]) : '';
  }
  // Jahresvergleich: der verglichene Monat, dazu wie viele Jahre Daten dafuer haben.
  // Die Jahreszahlen selbst stehen auf der Zeitachse ("Sep 24", "Sep 25", …).
  if (istYoY()) {
    if (!referenceDate) return '';
    const mm = referenceDate.slice(5,7);
    const jahre = new Set(allData.filter(r => r.date.slice(5,7) === mm).map(r => r.date.slice(0,4)));
    return MONAT_KURZ[+mm - 1] + (jahre.size > 1 ? ' · ' + jahre.size + ' Jahre' : '');
  }
  const mw = moWindow();
  if (!mw) return '';
  if (istJahr()) return String(jahrVon(referenceDate));
  const monat = ds => MONAT_KURZ[+ds.slice(5,7) - 1];
  const jahr  = ds => ds.slice(2,4);
  if (mw.s.slice(0,7) === mw.e.slice(0,7)) return monat(mw.s) + ' ' + jahr(mw.s);
  // Gleiches Jahr: die Jahreszahl nur einmal, sonst wird die Leiste unnötig breit.
  if (mw.s.slice(0,4) === mw.e.slice(0,4)) return monat(mw.s) + '–' + monat(mw.e) + ' ' + jahr(mw.e);
  return monat(mw.s) + ' ' + jahr(mw.s) + '–' + monat(mw.e) + ' ' + jahr(mw.e);
}

// Der angezeigte Zeitraum rechts im Kartentitel. Leer bleibt er nur ohne
// Bezugsdatum; `.filter-titel:empty` blendet den Kasten dann aus.
function filterTitelTeil() {
  const zeitraum = zeitraumText();
  return `<div class="filter-titel">${zeitraum?`<span class="zeitraum-text">${zeitraum}</span>`:''}</div>`;
}

// Auf den neuesten vorhandenen Tag springen. `_datumSelbstGewaehlt` wieder auf false:
// wer am neuesten Tag steht, will beim naechsten Nachladen mitgezogen werden.
function aufHeuteSpringen() {
  if (!allData.length) return;
  _bilanzWochentag = null;   // die Wochenbilanz zeigt wieder den heutigen Tag
  referenceDate = allData[allData.length-1].date;
  _datumSelbstGewaehlt = false;
}

// ── Zeitleiste: EIN Bedienelement für die ganze App ───────────────────────────
// Vorbild ist FitTracks Pille bei laufender Einheit: ein Element, das unten am
// Bildschirm stehen bleibt, in jedem Tab sichtbar ist und beim Scrollen oder Tippen
// nicht verschwindet.
//
// Vorher steckten Auswahlfeld und Blätterpfeile in JEDER Diagrammkarte — zwölf
// Kopien desselben Bedienelements für einen einzigen globalen Zustand. In den Karten
// bleibt nur der angezeigte Zeitraum (filterTitelTeil).
let _zlOffen = false;

function zeitleisteBauen() {
  if (document.getElementById('zeitleiste')) return;
  // Aus _RANGE_OPTS erzeugt — die Liste der Zeiträume bleibt damit an einer Stelle.
  const opts = _RANGE_OPTS.map(([k,lbl]) =>
    `<button class="zl-opt" data-range="${k}">${lbl}</button>`).join('');
  // „YoY" ist KEIN Bereich, sondern ein Befehl (Jahresvergleich ein/aus). Deshalb
  // ohne `data-range`, mit eigener Klasse und in einer EIGENEN Zeile ueber den
  // Bereichs-Chips – das trennt, was etwas tut, von dem, was den Zeitraum waehlt, und
  // haelt die Chip-Zeile bei 375 px ohne Umbruch.
  // Die Jahres-Knoepfe fuellt zeitleisteAktualisieren() – sie haengen am Datenbestand.
  const aktionen = `<button class="zl-yoy" aria-pressed="false" title="Jahresvergleich">YoY</button>`
    + `<span class="zl-jahre"></span>`;
  const el = document.createElement('div');
  el.id = 'zeitleiste';
  el.innerHTML = `<button class="zl-ausklapp" hidden></button>`
    + `<div class="zl-optionen" hidden role="group" aria-label="Zeitraum">`
    +   `<div class="zl-zeile">${aktionen}</div>`
    +   `<div class="zl-zeile">${opts}</div>`
    + `</div>`
    + `<div class="zl-reihe">`
    // „Heute" links neben ‹ (auf Wunsch, 18.09.2026). Absolut an der Reihe verankert
    // (siehe CSS): die Reihe bleibt dadurch zentriert, der Ausklapp-Knopf rechts
    // bekommt keinen Platz weggenommen, und im passiven Modus schrumpft der Knopf mit
    // der Reihe mit – ein Tipp darauf weckt sie wie Pille und Pfeile.
    + `<button class="zl-heute" title="Zum neuesten Stand" aria-label="Heute – zum neuesten Stand">Heute</button>`
    + `<button class="nav-arrow nav-prev" aria-label="Zurück">‹</button>`
    + `<button class="zl-pille" aria-haspopup="true" aria-expanded="false"></button>`
    + `<button class="nav-arrow nav-next" aria-label="Vor">›</button>`
    + `</div>`;
  // Die Leiste startet PASSIV (auf Wunsch, 13.09.2026) – wie die Bottom-Nav
  // eingeklappt startet. Beim ersten Blick auf die App geht es um die Zahlen, nicht
  // um das Bedienelement; ein Tipp auf Pille, Pfeil oder Ausklappknopf weckt sie.
  //
  // Bewusst HIER und nicht ueber `zeitleistePassiv(true)` nach dem Einsetzen:
  // `.zl-reihe` traegt eine 0.2-s-Ueberblendung auf `transform` und `opacity`. Wird
  // die Klasse erst gesetzt, nachdem das Element im Dokument steht, kann der Browser
  // dazwischen den Stil berechnen – und die Leiste schrumpft bei JEDEM App-Start
  // sichtbar zusammen. Am noch nicht eingesetzten Element gesetzt, ist `passiv` der
  // Anfangszustand: es gibt nichts zu ueberblenden.
  el.classList.add('passiv');
  _zlPassiv = true;
  document.body.appendChild(el);
  zeitleisteAktualisieren();
}

// Ausklapp-Knopf des AKTUELLEN Tabs. Er sitzt in der Zeitleiste, sein Inhalt haengt
// aber am Tab: `AUSKLAPP` sagt, ob es dort etwas zu klappen gibt und wie es heisst.
// Tabs ohne Eintrag zeigen ihn gar nicht.
function zeitleisteAusklapp() {
  const knopf = document.querySelector('#zeitleiste .zl-ausklapp');
  if (!knopf) return;
  const _k = AUSKLAPP[currentScreen];
  const k = _k && (!_k.sichtbar || _k.sichtbar()) ? _k : null;
  knopf.hidden = !k;
  if (!k) { knopf.removeAttribute('data-ausklapp'); return; }
  knopf.dataset.ausklapp = currentScreen;
  knopf.setAttribute('aria-expanded', k.offen() ? 'true' : 'false');
  knopf.setAttribute('title', k.titel);
  knopf.setAttribute('aria-label', k.titel);
  // Doppel-Chevron wie in FitTracks Uebungen-Tab: nach unten zum Aufklappen, nach
  // oben zum Einklappen.
  knopf.innerHTML = k.offen()
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="7 11 12 6 17 11"/><polyline points="7 18 12 13 17 18"/></svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/></svg>`;
}

function zeitleisteAktualisieren() {
  const el = document.getElementById('zeitleiste');
  if (!el) return;
  const pille = el.querySelector('.zl-pille');
  // Im Jahresvergleich und im Einzeljahr gehoert keiner der sechs Bereiche zum
  // Zustand – dann nennt die Pille den Modus bzw. das Jahr.
  if (pille) pille.textContent = bereichKurz();
  // Ein Knopf je Jahr mit Daten. Neu gebaut nur, wenn sich die Jahre aendern (etwa
  // am 1. Januar nach dem Nachladen).
  const jahre = el.querySelector('.zl-jahre');
  if (jahre) {
    const liste = datenJahre();
    if (jahre.dataset.jahre !== liste.join(',')) {
      jahre.dataset.jahre = liste.join(',');
      jahre.innerHTML = liste.map(j =>
        `<button class="zl-jahr" data-jahr="${j}" aria-pressed="false" title="Nur das Jahr ${j}">${j}</button>`).join('');
    }
    const aktiv = istJahr() ? jahrVon(referenceDate) : null;
    jahre.querySelectorAll('.zl-jahr').forEach(b => {
      const an = +b.dataset.jahr === aktiv;
      b.classList.toggle('aktiv', an);
      b.setAttribute('aria-pressed', an ? 'true' : 'false');
    });
  }
  const yoy = el.querySelector('.zl-yoy');
  if (yoy) {
    yoy.classList.toggle('aktiv', istYoY());
    yoy.setAttribute('aria-pressed', istYoY() ? 'true' : 'false');
  }
  // Ob ein Schritt moeglich ist, sagt `updateNavUI()` ueber die Klasse `.inaktiv`.
  el.querySelectorAll('.zl-opt').forEach(b => {
    b.classList.toggle('aktiv', b.dataset.range === timeRange);
  });
  zeitleisteAusklapp();
}

// ── Passiver Modus ───────────────────────────────────────────────────────────
// Die Leiste steht dauerhaft ueber dem Inhalt. Wer gerade liest oder scrollt,
// braucht sie nicht — dann schrumpft sie auf 70 %, bleibt aber sichtbar, bedienbar
// und an derselben Unterkante stehen. Ein Tipp auf Pille oder Pfeil holt sie zurueck.
//
// Absichtlich NICHT wie das Ausblenden der Bottom-Nav geloest: die verschwindet ganz
// und kommt nur ueber einen Tipp auf den Hintergrund zurueck. Die Zeitleiste muss
// jederzeit erreichbar bleiben — sie ist das einzige Bedienelement fuer den Zeitraum.
let _zlPassiv = false;

function zeitleistePassiv(ja) {
  const el = document.getElementById('zeitleiste');
  if (!el || _zlPassiv === !!ja) return;   // nichts tun, wenn der Zustand schon stimmt
  _zlPassiv = !!ja;
  el.classList.toggle('passiv', _zlPassiv);
  // Eine offene Auswahl gehoert zum aktiven Bedienen. Sie stehen zu lassen, waehrend
  // die Reihe darunter schrumpft, saehe nach einem Fehler aus.
  if (_zlPassiv) zeitleisteAuswahl(false);
}

// Auf- und Zuklappen ist animiert (auf Wunsch, 18.09.2026): die Auswahl waechst aus
// der Pille nach oben (190 ms, Deckkraft + leichte Vergroesserung, Ursprung an der
// Unterkante) und schrumpft beim Schliessen dorthin zurueck (150 ms).
// Drei Dinge dabei:
//  - `hidden` bleibt der Zustand. Beim Schliessen wird es erst NACH der Animation
//    gesetzt; die Box nimmt waehrenddessen keine Tipps mehr an.
//  - Das Ende kommt aus `onfinish` ODER aus dem Zeitgeber – ohne gezeichnete Seite
//    bliebe die Auswahl sonst unsichtbar offen stehen (vgl. `_ausklappAnimieren`).
//  - Gleicher Zustand wie vorher → nichts tun; eine laufende Animation laeuft weiter.
let _zlAnim = null;
function zeitleisteAuswahl(offen) {
  const el = document.getElementById('zeitleiste');
  if (!el) return;
  const war = _zlOffen;
  _zlOffen = !!offen;
  const pille = el.querySelector('.zl-pille');
  if (pille) pille.setAttribute('aria-expanded', _zlOffen ? 'true' : 'false');
  const box = el.querySelector('.zl-optionen');
  if (!box || war === _zlOffen) return;
  if (_zlAnim) { _zlAnim.cancel(); _zlAnim = null; }
  box.style.pointerEvents = '';
  if (bewegungAus() || !box.animate) { box.hidden = !_zlOffen; return; }
  const zu  = { opacity: 0, transform: 'translateY(10px) scale(.92)' };
  const auf = { opacity: 1, transform: 'none' };
  if (_zlOffen) {
    box.hidden = false;
    const a = _zlAnim = box.animate([zu, auf], { duration: 190, easing: 'cubic-bezier(0, 0, 0.2, 1)' });
    // `finish()` auch hier ueber den Zeitgeber: steht die Animationszeit, hielte die
    // Auswahl sonst ihr erstes Bild fest – offen, aber unsichtbar.
    const fertig = () => { if (_zlAnim !== a) return; _zlAnim = null; try { a.finish(); } catch (_) {} };
    a.onfinish = fertig;
    setTimeout(fertig, 190 + 80);
    return;
  }
  box.style.pointerEvents = 'none';
  const a = _zlAnim = box.animate([auf, zu], { duration: 150, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' });
  const ende = () => {
    if (_zlAnim !== a) return;
    _zlAnim = null;
    box.hidden = true;
    box.style.pointerEvents = '';
    a.cancel();
  };
  a.onfinish = ende;
  setTimeout(ende, 150 + 80);
}
// Den angezeigten Zeitraum in die Titelzeile jeder Diagrammkarte setzen.
function _zeitraumEinsetzen(name) {
  const screenEl = document.getElementById('screen-'+name);
  if (!screenEl) return;
  screenEl.querySelectorAll('.chart-card').forEach(card => {
    if (!card.querySelector('canvas')) return;         // nur echte Diagramm-Karten
    if (card.querySelector('.filter-titel')) return;   // nicht doppelt einsetzen
    const titel = card.querySelector(':scope > .chart-head') || card.querySelector(':scope > h3');
    if (titel) titel.insertAdjacentHTML('beforeend', filterTitelTeil());
  });
}

// Nach dem Aufbau eines Tabs: Zeitraum in die Karten, Balken und Kacheln animieren,
// Pfeil-Zustand setzen und die Blickposition wiederherstellen.
function _tabNachbereiten(name) {
  const screenEl = document.getElementById('screen-'+name);
  if (!screenEl) return;
  _zeitraumEinsetzen(name);
  balkenFuellen(name);
  if (name === 'overview') kachelnHochzaehlen();
  updateNavUI();
  // Erst hier steht die endgueltige Hoehe fest – die Zeitraum-Angaben sind gesetzt.
  if (name === currentScreen) blickAnkerWiederherstellen();
}

// ── Balken der Einordnungs-Karten fuellen sich (auf Wunsch, 18.09.2026) ──────
// `.goal-bar-fill` und `.debt-bar-fill` trugen schon immer `transition: width .5s`,
// wurden aber per innerHTML gleich in voller Breite eingesetzt – zu sehen war davon
// nie etwas. Jetzt startet jeder Balken bei seiner LETZTEN Breite und laeuft auf die
// neue: beim ersten Erscheinen (Aufklappen) von 0, beim Blaettern vom alten Wert.
// Gemerkt wird je Tab und Position. Nur SICHTBARE Balken zaehlen – im zugeklappten
// Bereich (`display:none`) laeuft keine Ueberblendung; sie werden vergessen und
// wachsen beim naechsten Aufklappen wieder von 0.
const _balkenStand = {};     // Tab → { Position: letzte Breite }
function balkenFuellen(tab) {
  const screen = document.getElementById('screen-' + tab);
  if (!screen) return;
  const alt = _balkenStand[tab] || {};
  const neu = {};
  const ruhig = bewegungAus();
  screen.querySelectorAll('.goal-bar-fill, .debt-bar-fill').forEach((el, i) => {
    if (!el.getClientRects().length) return;          // zugeklappt: nicht merken
    const ziel = el.style.width;
    neu[i] = ziel;
    const von = alt[i] != null ? alt[i] : '0%';
    if (ruhig || von === ziel) return;
    el.style.transition = 'none';
    el.style.width = von;
    void el.offsetWidth;                              // Startbreite festschreiben
    el.style.transition = '';
    el.style.width = ziel;
  });
  _balkenStand[tab] = neu;
}

// Einen Tab (neu) aufbauen. Rückgabe: Promise bei async-Tabs (Training), sonst
// undefined – fürs sequentielle Vorrendern.
function _renderTab(name) {
  _currentRenderingTab = name;
  // alte Charts dieses Tabs zerstören
  (tabCharts[name] || []).forEach(id => {
    if (charts[id]) { try { charts[id].destroy(); } catch(_) {} delete charts[id]; }
  });
  tabCharts[name] = [];
  const seitenFn = PAGE_FNS[name];
  if (!seitenFn) return;
  const fehler = e => {
    document.getElementById('screen-'+name).innerHTML = `<div class="no-data"><strong>Fehler</strong> ${esc(e.message)}</div>`;
    _tabNachbereiten(name);
  };
  let r;
  try {
    r = seitenFn();
    if (r && typeof r.then === 'function') r.then(() => _tabNachbereiten(name)).catch(fehler);
    else _tabNachbereiten(name);
  } catch(e) { fehler(e); }
  return r;
}

// ── Tabs im Hintergrund vorrendern, damit beim Wischen kein leeres Panel erscheint ──
// Rendert die übergebenen Tabs (sofern noch nicht gerendert) je einen pro Frame.
// Bei async-Tabs wird auf den Abschluss gewartet, bevor der nächste startet – so
// bleibt _currentRenderingTab korrekt und der Main-Thread wird nicht blockiert.
function _neighborTabs(name) {
  const i = TAB_ORDER.indexOf(name);
  if (i < 0) return [];
  return [TAB_ORDER[i-1], TAB_ORDER[i+1]].filter(Boolean);
}
function _prerenderTabs(names) {
  const queue = names.filter(n => n && !_renderedTabs.has(n));
  if (!queue.length) return;
  let i = 0;
  function step() {
    if (i >= queue.length) return;
    const n = queue[i++];
    let p;
    if (!_renderedTabs.has(n)) {          // erneut prüfen (könnte zwischenzeitlich gerendert sein)
      p = _renderTab(n);
      _renderedTabs.add(n);
    }
    if (p && typeof p.then === 'function') p.then(() => requestAnimationFrame(step), () => requestAnimationFrame(step));
    else requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// Pro-Tab Status-Bar-Tönung (theme-color meta) – iOS 16+ PWA respektiert das,
// iOS wählt automatisch passende Schriftfarbe für Uhr/Akku.
const TAB_THEME_COLORS = {
  overview:   '#0891B2',
  herz:       '#EF4444',
  schlaf:     '#7C3AED',
  training:   '#F97316'
};
function _setStatusBarColor(name) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && TAB_THEME_COLORS[name]) {
    meta.setAttribute('content', TAB_THEME_COLORS[name]);
  }
}

// ── Farb-Crossfade: vollflächiger Hintergrund-Gradient pro Tab ──────────
// Literale Hex-Werte verwenden (KEINE var()-Referenzen – iOS friert
// var()-Gradients beim ersten Render ein). Reihenfolge passt zu TAB_ORDER.
const THEME_GRADIENTS = {
  overview:   'linear-gradient(135deg, #0C4A6E, #0891B2)',
  herz:       'linear-gradient(135deg, #7F1D1D, #EF4444)',
  schlaf:     'linear-gradient(135deg, #1E3A8A, #7C3AED)',
  training:   'linear-gradient(135deg, #7C2D12, #F97316)'
};
// Pro Wisch-Frame aufrufen. progress = container.scrollLeft / clientWidth
// (z.B. 2.37 = zwischen Tab 2 und 3). Layer a ("von") bleibt deckend, Layer b
// ("nach") blendet fingergebunden ein → sauberer Crossfade ohne html-Durchscheinen.
function updateBackgroundForSwipe(progress) {
  const a = document.getElementById('bg-fade-a');
  const b = document.getElementById('bg-fade-b');
  if (!a || !b) return;
  const lastIdx = TAB_ORDER.length - 1;
  const fromIdx = Math.max(0, Math.min(lastIdx, Math.floor(progress)));
  const toIdx   = Math.max(0, Math.min(lastIdx, Math.ceil(progress)));
  const t = progress - fromIdx; // 0..1 zwischen den beiden Tabs
  const fromName = TAB_ORDER[fromIdx], toName = TAB_ORDER[toIdx];
  a.classList.add('no-anim'); b.classList.add('no-anim');
  // backgroundImage nur neu setzen, wenn sich das Theme des Layers ändert (Performance)
  if (a.dataset.theme !== fromName) { a.style.backgroundImage = THEME_GRADIENTS[fromName] || ''; a.dataset.theme = fromName; }
  if (b.dataset.theme !== toName)   { b.style.backgroundImage = THEME_GRADIENTS[toName]   || ''; b.dataset.theme = toName;   }
  a.style.opacity = '1';
  b.style.opacity = String(t);
}
// Sofort-Variante für nicht-gewischte Wechsel (Tableisten-Klick, App-Start, Resize).
function setTabBackgroundInstant(name) {
  const a = document.getElementById('bg-fade-a');
  const b = document.getElementById('bg-fade-b');
  if (!a || !b) return;
  a.classList.add('no-anim'); b.classList.add('no-anim');
  a.style.backgroundImage = THEME_GRADIENTS[name] || '';
  a.dataset.theme = name;
  a.style.opacity = THEME_GRADIENTS[name] ? '1' : '0';
  b.style.backgroundImage = ''; b.style.opacity = '0'; b.dataset.theme = '';
  void a.offsetWidth; // Reflow erzwingen, damit der Sofort-Wechsel sicher greift
}

// Tabfarbe umschalten, ohne alles andere am <body> mitzureissen.
//
// Vorher stand hier zweimal `document.body.className = 'theme-' + name + …` — einmal
// fuer den Tabwechsel per Knopf, einmal fuer den per Wisch. Eine Zuweisung an
// `className` ersetzt ALLE Klassen, also auch `dark`, `nav-weg` und `hinweis-an`.
// Beide Kopien mussten deshalb jede dieser Klassen einzeln mitfuehren, und wer eine
// vergass, erzeugte einen Fehler, der nur beim Tabwechsel auftrat: `nav-weg` ging
// verloren, die Bottom-Nav blieb versteckt (ihre Klasse sitzt an ihr selbst), die
// Zeitleiste rueckte aber wieder auf Nav-Hoehe und liess unten eine Luecke.
// Genau das ist zweimal passiert — beim Bauen und beim Reparieren, weil ich nur eine
// der beiden Kopien erwischt hatte.
//
// Jetzt wird nur die Theme-Klasse getauscht. Was sonst am <body> haengt, bleibt
// unberuehrt — auch Klassen, die es heute noch gar nicht gibt.
function themaSetzen(name) {
  const body = document.body;
  [...body.classList].filter(c => c.startsWith('theme-')).forEach(c => body.classList.remove(c));
  body.classList.add('theme-' + name);
}
// Markierung in der Tableiste auf den Tab `name` setzen.
function tableisteMarkieren(name) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const navEl = document.getElementById('nav-'+name);
  if (navEl) navEl.classList.add('active');
}

// Tab-Zustand setzen (Tableiste, Tabfarbe, Zeitleiste, ggf. erst jetzt aufbauen).
function _applyTabState(name) {
  tableisteMarkieren(name);
  themaSetzen(name);
  // Beim Tabwechsel hat eine offene Auswahl ausgedient.
  zeitleisteAuswahl(false);
  // Der Ausklapp-Knopf gehoert zum Tab – bei einem bereits gerenderten Tab laeuft
  // kein _renderTab, also hier nachziehen.
  zeitleisteAusklapp();
  _setStatusBarColor(name);
  if (!_renderedTabs.has(name)) {
    _renderTab(name);
    _renderedTabs.add(name);
  }
  // Bottom-Nav-Sichtbarkeit bleibt beim Tab-Wechsel erhalten: ausgeblendet bleibt
  // ausgeblendet, bis sie per Hintergrund-Tipp zurückgeholt wird.
}

// Programmatischer Tab-Wechsel (Klick auf Bottom-Nav-Button)
function showScreen(name) {
  if (!TAB_ORDER.includes(name)) return;
  currentScreen = name;
  const container = document.getElementById('tab-container');
  if (container) {
    const idx = TAB_ORDER.indexOf(name);
    const target = idx * container.clientWidth;
    _suppressScrollSync = true;
    container.scrollTo({ left: target, behavior: 'auto' });
    requestAnimationFrame(() => { requestAnimationFrame(() => { _suppressScrollSync = false; }); });
  }
  setTabBackgroundInstant(name); // Hintergrund sofort setzen (kein Wisch-Fortschritt)
  _applyTabState(name);
}

// Tabwechsel MIT Wisch-Animation (Tipp auf einen Ziel-Ring der Übersicht, 13.09.2026).
// Bewegt wird `scrollLeft` des Tab-Scrollers — also genau das, was auch der Finger
// beim Wischen bewegt. Deshalb laeuft der Rest ueber den vorhandenen Scroll-Sync und
// sieht aus wie ein Wisch: Hintergrund-Verlauf folgt dem Fortschritt, Tabfarbe und
// Tableisten-Markierung wechseln unterwegs, die Zeitleiste wird passiv, und 90 ms nach
// dem letzten Schritt setzt der Settle-Timer `currentScreen` und ruft `_applyTabState`.
// `showScreen()` bleibt fuer die Tableiste bewusst sprunghaft.
//
// Zwei Dinge sind noetig, damit es zuverlaessig laeuft:
// 1. `scroll-snap-type` ist WAEHREND der Animation aus. Mit `x mandatory` rastet
//    Safari jeden einzelnen Zwischenschritt wieder auf den naechsten Tab ein, und die
//    Bewegung ruckelt oder bleibt stehen. Am Ende steht `scrollLeft` exakt auf dem
//    Ziel, das Wiedereinschalten verschiebt also nichts.
// 2. Eine Beruehrung bricht ab. Wer mitten in der Animation den Finger auflegt,
//    uebernimmt — dann gilt wieder das native Einrasten.
// Ein noch nicht gebauter Ziel-Tab wird VOR dem Start gebaut, sonst wischte eine leere
// Seite herein und fuellte sich erst am Ende.
let _tabWischRAF = null;
function zuTabWischen(name) {
  if (!TAB_ORDER.includes(name) || name === currentScreen) return;
  const container = document.getElementById('tab-container');
  const w = container ? container.clientWidth : 0;
  if (!w || bewegungAus()) { showScreen(name); return; }
  if (!_renderedTabs.has(name)) { _renderTab(name); _renderedTabs.add(name); }
  if (_tabWischRAF) cancelAnimationFrame(_tabWischRAF);
  const start = container.scrollLeft;
  const ziel  = TAB_ORDER.indexOf(name) * w;
  // Ein Tab weit 380 ms, jeder weitere 110 ms dazu – ueber drei Tabs 600 ms. Linear
  // mit der Strecke waere das zu lang, fest zu hektisch.
  const dauer = 380 + 110 * Math.max(0, Math.round(Math.abs(ziel - start) / w) - 1);
  const ease  = t => t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;   // easeInOutCubic
  container.style.scrollSnapType = 'none';
  // `fertig` = die Animation ist bis zum Ziel gelaufen. Nur dann wird der Endzustand
  // ausdruecklich gesetzt. Bei einem Abbruch durch Beruehrung entscheidet das native
  // Einrasten, wo man landet – dort einen Tab zu erzwingen, waere falsch.
  // Warum ueberhaupt ausdruecklich: der Scroll-Sync zieht den Zustand nur ueber
  // `scroll`-Events nach. Die feuern auf dem Geraet zuverlaessig, im verdeckten
  // Vorschau-Pane aber gar nicht – dort blieben Tabfarbe und Markierung auf dem
  // Ausgangstab stehen. Mit gesetztem `currentScreen` ueberspringt der Settle-Timer des
  // Syncs seinen eigenen Aufruf, doppelt laeuft also nichts.
  const ende = fertig => {
    if (_tabWischRAF) cancelAnimationFrame(_tabWischRAF);
    _tabWischRAF = null;
    container.style.scrollSnapType = '';
    container.removeEventListener('touchstart', abbruch);
    container.removeEventListener('pointerdown', abbruch);
    if (fertig === true && currentScreen !== name) {
      currentScreen = name;
      setTabBackgroundInstant(name);
      _applyTabState(name);
    }
  };
  const abbruch = () => ende(false);
  container.addEventListener('touchstart', abbruch, { passive: true });
  container.addEventListener('pointerdown', abbruch, { passive: true });
  const t0 = performance.now();
  const schritt = now => {
    const t = Math.min(1, (now - t0) / dauer);
    container.scrollLeft = start + (ziel - start) * ease(t);
    if (t < 1) _tabWischRAF = requestAnimationFrame(schritt);
    else ende(true);
  };
  _tabWischRAF = requestAnimationFrame(schritt);
}

// State-Change (Filter, Datum, Refresh, Dark-Mode) → alle Tabs invalidieren + aktuellen neu rendern
function _refreshAfterStateChange() {
  // Alle Charts zerstören (Theme- oder Datenwechsel)
  alleDiagrammeZerstoeren();
  TAB_ORDER.forEach(t => { tabCharts[t] = []; });
  _renderedTabs.clear();
  _renderTab(currentScreen);
  _renderedTabs.add(currentScreen);
  // Nach Filter-/Datumswechsel nur die Nachbar-Tabs vorrendern (Kosten gering halten);
  // der Rest rendert bei Bedarf nach.
  _prerenderTabs(_neighborTabs(currentScreen));
}

// Snap-Sync: Wisch erkennen, Theme/Renderer aktualisieren
function initTabScrollSync() {
  const container = document.getElementById('tab-container');
  if (!container) return;
  let ticking = false;
  let lastReported = currentScreen;
  let settleTimer = null;
  container.addEventListener('scroll', () => {
    if (_suppressScrollSync) return;
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const w = container.clientWidth;
      if (w <= 0) return;
      // Hintergrund-Gradient fingergebunden an den Scroll-Fortschritt koppeln.
      updateBackgroundForSwipe(container.scrollLeft / w);
      const idx = Math.round(container.scrollLeft / w);
      const clamped = Math.max(0, Math.min(TAB_ORDER.length-1, idx));
      const name = TAB_ORDER[clamped];
      if (name !== lastReported) {
        // Theme/Nav-Highlight schon während des Snaps wechseln
        tableisteMarkieren(name);
        themaSetzen(name);
        _setStatusBarColor(name);
        // Wischen zaehlt wie Scrollen: die Zeitleiste tritt zurueck (auf Wunsch,
        // 08.09.2026). Der Wisch braucht einen EIGENEN Ausloeser, weil er keinen Klick
        // erzeugt — beim Tabwechsel per Knopf greift laengst die Regel „Tipp neben die
        // Leiste" aus dem body-Handler, die Tableiste liegt ausserhalb von
        // `#zeitleiste`. Beide Wege enden damit im selben Zustand.
        zeitleistePassiv(true);
        lastReported = name;
      }
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        const exact = clamped * w;
        if (Math.abs(container.scrollLeft - exact) > 1) {
          _suppressScrollSync = true;
          container.scrollTo({ left: exact, behavior: 'auto' });
          requestAnimationFrame(() => { _suppressScrollSync = false; });
        }
        if (currentScreen !== name) {
          currentScreen = name;
          _applyTabState(name);
        }
      }, 90);
    });
  }, { passive: true });
  window.addEventListener('resize', () => {
    if (!TAB_ORDER.includes(currentScreen)) return;
    showScreen(currentScreen);
  });
}

// Auto-Hide der Bottom-Nav. Die Zeitleiste sitzt ueber der Tableiste und folgt ihr nach unten, wenn diese
// ausgeblendet wird — sie selbst bleibt immer sichtbar. Beides an EINER Stelle
// umgeschaltet, sonst laufen Leiste und Tableiste auseinander.
function navAusblenden(nav, aus) {
  nav.classList.toggle('nav-hidden', aus);
  document.body.classList.toggle('nav-weg', aus);
}

function initScrollHideNav() {
  const nav = document.getElementById('bottom-nav');
  if (!nav) return;
  const tickingByTab = new Map();
  // Letzte Scrollposition PRO Tab. Eine gemeinsame Variable täuschte beim Tabwechsel
  // einen Sprung vor (Tab A steht bei 800, Tab B bei 0) und blendete die Leiste bei
  // der ersten Bewegung im neuen Tab aus, obwohl dort kaum gescrollt wurde.
  const letzteYProTab = new Map();
  TAB_ORDER.forEach(tabName => {
    const screenEl = document.getElementById('screen-'+tabName);
    if (!screenEl) return;
    screenEl.addEventListener('scroll', () => {
      if (currentScreen !== tabName) return;
      if (tickingByTab.get(tabName)) return;
      tickingByTab.set(tabName, true);
      requestAnimationFrame(() => {
        tickingByTab.set(tabName, false);
        const y = screenEl.scrollTop;
        const dy = y - (letzteYProTab.has(tabName) ? letzteYProTab.get(tabName) : y);
        letzteYProTab.set(tabName, y);
        // Scrollen blendet die Leiste nur AUS. Zurück kommt sie ausschliesslich über
        // einen Tipp auf den freien Kartenhintergrund – auch beim Zurückscrollen und
        // am Seitenanfang bleibt sie weg. So gewünscht.
        if (y > 60 && dy > 4) navAusblenden(nav, true);
        // Die Zeitleiste tritt schon bei der kleinsten Bewegung zurück, und zwar in
        // BEIDE Richtungen — anders als die Bottom-Nav, die nur beim Runterscrollen
        // verschwindet. Die 2 px Schwelle fangen das Nachfedern von iOS ab, das sonst
        // nach jedem Antippen ein Mini-dy meldet.
        if (Math.abs(dy) > 2) zeitleistePassiv(true);
      });
    }, { passive: true });
  });
  // Tippen auf den freien Tab-Hintergrund → Bottom-Nav aus-/einblenden.
  const _tapContainer = document.getElementById('tab-container');
  if (_tapContainer) _tapContainer.addEventListener('click', (e) => {
    // Alles, was selbst etwas auslöst, ausnehmen: Bedienelemente, Diagramme (Markierung),
    // Kartentitel (Datenbeschriftung), Ziel-Ringe (Tabwechsel) und Tooltip-Anker.
    if (e.target.closest('button, a, input, select, textarea, label, canvas, .chart-card h3, [data-ziel-tab], [data-tag], ' + TT_TAP_SELECTOR)) return;
    navAusblenden(nav, !nav.classList.contains('nav-hidden'));
  });
}

// Ausklapp-Knopf der Zeitleiste – alle Tabs laufen ueber dieselbe Tabelle (AUSKLAPP).
document.body.addEventListener('click', (e) => {
  const knopf = e.target.closest('[data-ausklapp]');
  if (!knopf) return;
  ausklappUmschalten(knopf.dataset.ausklapp);
});

// ── Aus- und Einklappen, animiert (auf Wunsch, 14.09.2026) ──────────────────
// Neu aufgebaut wird weiterhin statt nur ein-/ausgeblendet: Diagramme im verborgenen
// Bereich werden ohne sichtbare Flaeche gezeichnet und behalten Breite 0; aus diesem
// Zustand holt sie weder resize() noch update() zurueck. Die Animation legt sich
// deshalb um den Neuaufbau herum:
//   AUF: erst Zustand + Neuaufbau (die Teile stehen in voller Groesse da), dann wachsen
//        sie von 0 auf ihre Hoehe. Die Diagramme haben dabei schon ihre echte Breite –
//        animiert wird nur die Hoehe des Rahmens, `overflow:hidden` schneidet zu.
//   ZU:  erst schrumpfen die vorhandenen Teile auf 0, DANN Zustand-Neuaufbau.
// Wer etwas Neues hinter den Knopf legt, gibt ihm die Klasse `ausklapp-teil` – mehr
// braucht es nicht.
const AUSKLAPP_DAUER = 280;
let _ausklappLaeuft = false;

// Nur die aeussersten, sichtbaren Teile: ein Teil in einem Teil wuerde doppelt bewegt.
function _ausklappTeile(tab) {
  const screen = document.getElementById('screen-' + tab);
  if (!screen) return [];
  return [...screen.querySelectorAll('.ausklapp-teil')].filter(el =>
    !(el.parentElement && el.parentElement.closest('.ausklapp-teil')) &&
    getComputedStyle(el).display !== 'none');
}

// Hoehe, Deckkraft und die senkrechten Abstaende gemeinsam – nur die Hoehe allein
// liesse `margin-top` und `padding` der Fusszeile am Ende auf einen Schlag erscheinen.
// Das Ende kommt aus `onfinish` ODER aus dem Zeitgeber, je nachdem was zuerst eintritt:
// ein Tab, der gerade nicht gezeichnet wird, laesst die Animationszeit stillstehen, und
// ohne Rueckfall bliebe `_ausklappLaeuft` fuer immer gesetzt – der Knopf waere tot.
function _ausklappAnimieren(el, auf) {
  return new Promise(fertig => {
    let erledigt = false, a = null;
    // `finish()` ist Pflicht, nicht nur Aufraeumen: endet der Vorgang ueber den
    // Zeitgeber, weil die Animationszeit stand, haelt die Animation sonst ihr ERSTES
    // Bild fest – beim Aufklappen also Hoehe 0. Genau das zeigte der Pruefstand: der
    // Knopf meldete „offen", die Fusszeilen blieben unsichtbar.
    const ende = () => {
      if (erledigt) return; erledigt = true;
      try { if (a && a.playState !== 'finished') a.finish(); } catch (_) {}
      el.style.overflow = ''; fertig();
    };
    try {
      const cs = getComputedStyle(el);
      el.style.overflow = 'hidden';   // VOR dem Messen: sonst zaehlt der Aussenabstand des letzten Kinds mit
      const voll = { height: el.getBoundingClientRect().height + 'px', opacity: 1,
        marginTop: cs.marginTop, marginBottom: cs.marginBottom,
        paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom };
      const leer = { height: '0px', opacity: 0, marginTop: '0px', marginBottom: '0px',
        paddingTop: '0px', paddingBottom: '0px' };
      a = el.animate(auf ? [leer, voll] : [voll, leer], {
        duration: AUSKLAPP_DAUER, easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
        // Beim Zuklappen auf 0 stehen bleiben, bis der Neuaufbau das Element entfernt –
        // sonst blitzte es fuer einen Frame in voller Hoehe auf.
        fill: auf ? 'none' : 'forwards' });
      a.onfinish = ende;
    } catch (_) { ende(); return; }
    setTimeout(ende, AUSKLAPP_DAUER + 80);
  });
}

function ausklappUmschalten(tab) {
  const k = AUSKLAPP[tab];
  if (!k || _ausklappLaeuft) return;
  const ruhig = bewegungAus();
  if (k.offen()) {
    k.um();
    zeitleisteAusklapp();              // Chevron sofort umdrehen, nicht erst nach 280 ms
    const teile = ruhig ? [] : _ausklappTeile(tab);
    _ausklappLaeuft = true;
    Promise.all(teile.map(el => _ausklappAnimieren(el, false))).then(() => {
      _ausklappLaeuft = false;
      _ruhigRendern(tab);
    });
    return;
  }
  k.um();
  // Ohne Wachsen fuer die Diagramme, die schon da waren; die neu aufgeklappten
  // wachsen herein (siehe _ruhigRendern).
  const r = _ruhigRendern(tab);        // Training baut asynchron – erst danach messen
  if (ruhig) return;
  _ausklappLaeuft = true;
  Promise.resolve(r)
    .then(() => Promise.all(_ausklappTeile(tab).map(el => _ausklappAnimieren(el, true))))
    .then(() => { _ausklappLaeuft = false; }, () => { _ausklappLaeuft = false; });
}

// Hilfslinien (Ø, Ziel) ein-/ausschalten. Neu aufgebaut wird der ganze Tab: die
// Linie ist ein Datensatz, kein Sichtbarkeits-Schalter.
// Seit 18.09.2026 ohne erneutes Wachsen aller Diagramme; nur die Linie blendet
// (siehe _ruhigRendern / hilfslinienBlende). Waehrend eine Linie ausblendet, sind
// weitere Tipps gesperrt – der Neuaufbau am Ende muss den dann gueltigen Zustand sehen.
let _hlLaeuft = false;
document.body.addEventListener('click', (e) => {
  const sch = e.target.closest('.hl-schalter');
  if (!sch || _hlLaeuft) return;
  const schluessel = sch.dataset.hl;
  const an = !hlAn(schluessel);
  const [id, art] = schluessel.split('|');
  const alt = charts[id];
  // Den AKTUELLEN Tab neu aufbauen – die Schalter stehen in Herz, Schlaf und Training.
  const neuAufbauen = () => {
    _hilfslinie[schluessel] = an;
    _hlPlan = an && !bewegungAus() ? { id, art } : null;
    _ruhigRendern(currentScreen);
  };
  if (an || !alt || bewegungAus()) { neuAufbauen(); return; }
  // Ausschalten: erst die Linie ausblenden, dann ohne sie neu aufbauen. Der Schalter
  // zeigt den neuen Zustand sofort, nicht erst nach der Blende.
  sch.classList.add('aus');
  sch.setAttribute('aria-pressed', 'false');
  _hlLaeuft = true;
  alt.$hlBlende = { art, alpha: 1 };
  uebergang(HL_DAUER,
    x => { if (alt.$hlBlende) { alt.$hlBlende.alpha = 1 - x; try { alt.draw(); } catch(_) {} } },
    () => { _hlLaeuft = false; neuAufbauen(); });
});

// ── Event-Wiring (nach Daten-Load) ───────────────────────
// Per Delegation auf document.body, weil die Seiten bei jedem Neuaufbau per
// innerHTML ersetzt werden.
document.body.addEventListener('click', (e) => {
  const t = e.target;
  // Tipp auf einen Ziel-Ring: Wisch in seinen Tab. Ein ⓘ darin bliebe ausgenommen –
  // es oeffnet weiterhin seine Erklaerung, statt den Tab zu wechseln.
  // Tipp auf eine Tagesspalte der Wochenbilanz: Tag wählen, Ringe zeigen seine Werte.
  const _bilanzZelle = t.closest('.ziel-woche [data-tag]');
  if (_bilanzZelle) {
    const d = _bilanzZelle.dataset.tag;
    _bilanzWochentag = d === standardTag() ? null : wochentagIndex(d);
    ovObenNeu();
    return;
  }
  const _kachel = t.closest('.zr[data-ziel-tab]');
  if (_kachel && !t.closest(TT_TAP_SELECTOR)) { zuTabWischen(_kachel.dataset.zielTab); return; }
  // Tipp auf den Kartentitel schaltet die Datenbeschriftungen dieses Diagramms um.
  // Das Verlaufs-Diagramm ist ausgenommen — es hat keinen Formatierer, `$werteFmt`
  // ist dort null und der Zweig greift gar nicht.
  const _titel = t.closest('.chart-card h3');
  if (_titel && !t.closest(TT_TAP_SELECTOR) && !t.closest('button')) {
    const _cv = _titel.closest('.chart-card').querySelector('canvas');
    const _ch = _cv && Chart.getChart(_cv);
    if (_ch && _ch.$werteFmt) {
      const _an = !beschriftungAn(_ch);
      // Im Training-Tab gilt der Tipp fuer ALLE Diagramme des Tabs (auf Wunsch,
      // 12.09.2026): dort vergleicht man Strecke, Zeit, Pace und VO2max miteinander,
      // und vier Titel nacheinander anzutippen ist derselbe Wunsch in vier Schritten.
      // In den uebrigen Tabs bleibt es beim einzelnen Diagramm.
      // Welcher Tab es ist, sagt das DOM und NICHT `currentScreen`: alle vier Screens
      // liegen gleichzeitig im Dokument, und waehrend eines Wischs hinkt
      // `currentScreen` dem sichtbaren Tab hinterher.
      const _screen = _titel.closest('.screen');
      const _tabDia = (_screen && _screen.id === 'screen-training')
        ? (tabCharts.training || []).map(id => charts[id]).filter(c => c && c.$werteFmt)
        : [];
      const _ziele = _tabDia.indexOf(_ch) >= 0 ? _tabDia : [_ch];
      // Nur neu zeichnen – die Daten aendern sich nicht. Seit 18.09.2026 geblendet.
      _ziele.forEach(c => { _beschriftung[c.canvas.id] = _an; });
      _werteBlenden(_ziele, _an);
      return;
    }
  }

  // Passiver Modus: ein Tipp auf Pille, Pfeil oder „Heute" (alle in `.zl-reihe`) holt
  // die Leiste zurueck, ein Tipp irgendwo daneben schickt sie zurueck. Ein Tipp auf
  // einen Eintrag der offenen Auswahl (`.zl-opt`, `.zl-yoy`) laesst den Zustand, wie er ist — er gehoert zum
  // Bedienen der Leiste, liegt aber nicht in der Reihe.
  // BEWUSST ohne `return`: der Tipp soll danach noch das tun, wofuer er gedacht war.
  if (t.closest('.zl-reihe') || t.closest('.zl-ausklapp')) zeitleistePassiv(false);
  else if (!t.closest('#zeitleiste')) zeitleistePassiv(true);

  // Zeitleiste zuerst: die aufgeklappte Auswahl schliesst bei JEDEM Tipp, der nicht
  // der Pille selbst oder einem ihrer Einträge gilt — die Blätterpfeile eingeschlossen.
  // Vorher galt „ausserhalb der ganzen Leiste": ein Tipp auf ‹ oder › liess die
  // Auswahl offen stehen, obwohl sie ihre Aufgabe erfüllt hatte.
  // BEWUSST ohne `return` — der Tipp soll trotzdem noch das tun, wofür er gedacht war.
  if (_zlOffen && !t.closest('.zl-pille') && !t.closest('.zl-opt')) zeitleisteAuswahl(false);
  if (t.closest('.zl-pille')) { zeitleisteAuswahl(!_zlOffen); return; }
  // „Heute" wechselt den Bereich NICHT – es schiebt nur den Ausschnitt ans Ende.
  // Steht man auf 3M im Maerz, bleibt es 3M und zeigt die neuesten drei Monate.
  if (t.closest('.zl-heute')) {
    zeitleisteAuswahl(false);
    if (t.closest('.zl-heute').classList.contains('inaktiv')) return;
    blickAnkerMerken(t);
    aufHeuteSpringen();
    updateNavUI();
    _refreshAfterStateChange();
    return;
  }
  // Jahresvergleich ein/aus. Beim Einschalten wird der bisherige Bereich gemerkt,
  // beim Ausschalten steht er wieder da — sonst landete man nach dem Vergleich in
  // einem Bereich, den man nie gewaehlt hat.
  if (t.closest('.zl-yoy')) {
    zeitleisteAuswahl(false);
    blickAnkerMerken(t);
    if (istYoY()) { bereichSetzen(_yoyVorher); }
    else { _yoyVorher = timeRange; bereichSetzen('yoy'); }
    return;
  }
  // Einzeljahr ein/aus bzw. wechseln (siehe jahrUmschalten).
  const zlJahr = t.closest('.zl-jahr');
  if (zlJahr) {
    zeitleisteAuswahl(false);
    blickAnkerMerken(t);
    jahrUmschalten(+zlJahr.dataset.jahr);
    return;
  }
  const zlOpt = t.closest('.zl-opt');
  if (zlOpt) { zeitleisteAuswahl(false); bereichSetzen(zlOpt.dataset.range); return; }
  // Am Rand des Datenbestands passiert nichts – der Knopf bleibt aber ein Knopf und
  // faengt den Tipp ab, statt ihn an die Bottom-Nav durchzureichen.
  const pfeilZurueck = t.closest('.nav-prev'), pfeilVor = t.closest('.nav-next');
  if (pfeilZurueck) { if (!pfeilZurueck.classList.contains('inaktiv')) { blickAnkerMerken(t); navPrev(); } return; }
  if (pfeilVor)     { if (!pfeilVor.classList.contains('inaktiv'))     { blickAnkerMerken(t); navNext(); } return; }
  // Jeder Knopf hat eine EIGENE Auslöser-Klasse. `.update-btn` ist reine Optik und
  // sitzt auf allen dreien – wurde sie hier abgefragt, loeste „Mit Google anmelden"
  // zusaetzlich das App-Update samt Rueckfrage aus.
  if (t.closest('.einst-act'))   { einstellungenOeffnen(); return; }
  if (t.closest('.us-zurueck'))  { einstellungenSchliessen(); return; }
  if (t.closest('.anmelde-btn')) { signIn(); return; }
  if (t.closest('.refresh-btn')) { refreshData(); return; }
  if (t.closest('.appver-btn'))  { jetztAktualisieren(); return; }
  if (t.closest('.dark-toggle')) {
    // Sanft ueberblenden statt in einem Bild umschlagen (auf Wunsch, 18.09.2026):
    // die View Transitions API haelt den alten Zustand als Bild fest und blendet ihn
    // in den neuen (Dauer im CSS unter `::view-transition-*`). Safari kann das ab
    // iOS 18; aeltere Geraete schalten wie bisher ohne Uebergang um.
    // Wird der Uebergang uebersprungen (zweiter Tipp waehrend der Blende, Seite gerade
    // nicht gezeichnet), lehnt `ready` ab – umgeschaltet ist trotzdem, der Rueckruf
    // laeuft in jedem Fall. Abfangen, sonst steht die Ablehnung in der Konsole.
    const _dunkel = !document.body.classList.contains('dark');
    if (document.startViewTransition && !bewegungAus()) {
      const _vt = document.startViewTransition(() => setDarkMode(_dunkel));
      if (_vt && _vt.ready) _vt.ready.catch(() => {});
    } else setDarkMode(_dunkel);
  }
});
// Bottom-Nav bleibt statisch im DOM, weiterhin direkt verkabelt
document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    // Tippt man den bereits offenen Tab erneut an, sanft nach oben scrollen
    // (iOS-Verhalten) statt nichts zu tun – kein erneutes Rendern.
    if (tab === currentScreen) {
      const screenEl = document.getElementById('screen-' + tab);
      if (screenEl) screenEl.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    showScreen(tab);
  });
});

// Ziel-Ringe sind per `role="button"` Knoepfe – dann gehoeren Enter und Leertaste dazu.
document.body.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const k = e.target.closest && e.target.closest('.zr[data-ziel-tab], .ziel-woche [data-tag]');
  if (k && k.dataset.tag && e.target === k) { e.preventDefault(); k.click(); return; }
  if (!k || e.target !== k) return;
  e.preventDefault();
  zuTabWischen(k.dataset.zielTab);
});

// ── Dark Mode ──────────────────────────────────────────
function applyDarkMode(isDark) {
  document.body.classList.toggle('dark', isDark);
  // Das Symbol bleibt dasselbe (die Drehung macht das CSS über `body.dark`); nur der
  // Zustand fuer Screenreader zieht nach. Vorher wurde hier 🌙/☀️ getauscht – ein
  // `textContent` wuerde das SVG loeschen.
  document.querySelectorAll('.dark-toggle').forEach(btn => {
    btn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
  });
  try { localStorage.setItem('hcc_dark', isDark ? '1' : '0'); } catch(e) {}
}
function setDarkMode(isDark) {
  applyDarkMode(isDark);
  // Theme-Wechsel ändert keine Daten und keinen Text – Karten/Schrift folgen den
  // CSS-Variablen via body.dark. Statt den ganzen Tab (innerHTML + Analytik +
  // Chart-Neuaufbau) zu regenerieren, werden nur die bestehenden Chart-Instanzen
  // neu gezeichnet. Das macht den Dark-Mode-Toggle praktisch instant.
  Object.values(charts).forEach(c => { try { c.update('none'); } catch(_) {} });
}
// ── App-Version + Update ───────────────────────────────
// Eine installierte PWA übernimmt einen neuen Stand erst beim ZWEITEN Start:
// der erste Start installiert den neuen Service Worker, der zweite aktiviert ihn.
// Diese beiden Helfer machen sichtbar, was gerade läuft, und holen das Update auf
// Wunsch in einem Schritt.

// Die laufende Version steckt im Namen des Caches, den der Service Worker angelegt
// hat ("hcc-v74"). Da sw.js beim Aktivieren alle fremden Caches löscht, bleibt im
// Normalfall genau einer übrig; nur im kurzen Moment zwischen Installation und
// Aktivierung sind es zwei – deshalb wird der höchste genommen.
async function versionAnzeigen() {
  const felder = document.querySelectorAll('.app-version');
  if (!felder.length) return;
  let text = 'unbekannt';
  try {
    const nummern = (await caches.keys())
      .filter(k => /^hcc-v\d+$/.test(k))
      .map(k => parseInt(k.slice(5), 10))
      .sort((a, b) => a - b);
    if (nummern.length) text = 'v' + nummern[nummern.length - 1];
    else text = 'noch nicht installiert';
  } catch(_) { /* caches-API nicht verfügbar (z. B. ohne HTTPS) */ }
  felder.forEach(el => { el.textContent = text; });
}

// Service Worker abmelden, Caches leeren, neu laden. Der Google-Token liegt im
// localStorage und bleibt unberührt – man muss sich also nicht neu anmelden.
async function jetztAktualisieren() {
  // Nur der eigene Knopf – `.update-btn` sitzt auch auf „Daten aktualisieren" und
  // „Mit Google anmelden", die hier nichts zu suchen haben.
  const knoepfe = document.querySelectorAll('.appver-btn');
  if (!confirm('Jetzt aktualisieren?\n\nDie App lädt den neuesten Stand vom Server und startet neu. Deine Anmeldung und deine Daten bleiben erhalten.')) return;
  knoepfe.forEach(b => { b.disabled = true; b.textContent = 'Wird geladen…'; });
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(r => r.unregister()));
    const namen = await caches.keys();
    await Promise.all(namen.map(n => caches.delete(n)));
  } catch(_) {}
  location.reload();
}

// ── Blickposition ueber einen Re-Render retten ─────────
// Ein Klick auf die Pfeile baut den ganzen Tab neu auf. Aendert sich dabei die
// Gesamthoehe – etwa weil im neuen Zeitraum weniger Trainings vorliegen –, klemmt
// der Browser die Scrollposition und die Ansicht springt. Am staerksten trifft es
// das unterste Diagramm (VO2max), weil dessen Position von allem darueber abhaengt.
// Deshalb: die ausloesende Diagramm-Karte als Anker merken und sie danach wieder
// an dieselbe Stelle im Sichtfenster setzen.
let _blickAnker = null;   // { canvasId, abstandOben }

// Die oberste Diagrammkarte, die gerade zu sehen ist — der Anker, wenn der Auslöser
// selbst zu keiner Karte gehört.
function obersteSichtbareKarte(screenEl) {
  const oben = screenEl.getBoundingClientRect().top;
  const karten = screenEl.querySelectorAll('.chart-card');
  for (let i = 0; i < karten.length; i++) {
    if (!karten[i].querySelector('canvas')) continue;
    if (karten[i].getBoundingClientRect().bottom > oben + 8) return karten[i];
  }
  return null;
}

function blickAnkerMerken(el) {
  _blickAnker = null;
  const screenEl = document.getElementById('screen-' + currentScreen);
  if (!screenEl) return;
  // Die Blätterpfeile sitzen seit der Zeitleiste NICHT mehr in einer Karte. Ohne
  // Rückfall bliebe der Anker leer und die Ansicht spränge beim Blättern genau so,
  // wie es der Anker verhindern soll. Dann zählt, worauf man gerade schaut.
  let karte = el && el.closest ? el.closest('.chart-card') : null;
  if (!karte) karte = obersteSichtbareKarte(screenEl);
  const canvas = karte ? karte.querySelector('canvas') : null;
  if (!canvas || !canvas.id) return;
  _blickAnker = {
    canvasId: canvas.id,
    abstandOben: karte.getBoundingClientRect().top - screenEl.getBoundingClientRect().top
  };
}

function blickAnkerWiederherstellen() {
  const anker = _blickAnker;
  if (!anker) return;
  _blickAnker = null;
  // Synchron statt in requestAnimationFrame: getBoundingClientRect erzwingt ohnehin
  // ein Layout, die neuen Hoehen stehen also bereits fest. Ein Frame abzuwarten
  // wuerde den Sprung zusaetzlich sichtbar machen - und in einer nicht gezeichneten
  // Seite (Hintergrund-Tab) feuert der Frame gar nicht.
  const screenEl = document.getElementById('screen-' + currentScreen);
  const canvas = screenEl ? screenEl.querySelector('canvas[id="' + anker.canvasId + '"]') : null;
  const karte = canvas ? canvas.closest('.chart-card') : null;
  if (!karte) return;
  const ist = karte.getBoundingClientRect().top - screenEl.getBoundingClientRect().top;
  screenEl.scrollTop += (ist - anker.abstandOben);
}

// ── Hinweisleiste oben ─────────────────────────────────
// Nur noch EIN Zustand: 'neu' – im Hintergrund wurde frisch geladen, waehrend der
// Nutzer schon arbeitete; der Knopf zeichnet neu. Der frueher hier gezeigte Stand
// der Google-Anmeldung ist auf Wunsch in die App-Karte gewandert (anmeldeStand()):
// er verlangt keine sofortige Antwort und muss deshalb nicht ueber allen Tabs stehen.
// Ohne Zustand verschwindet die Leiste und gibt den Platz wieder frei.
//
// Seit 18.09.2026 gleitet die Leiste von oben herein und wieder hinaus (280/220 ms);
// der Platz darueber waechst und schrumpft ueber eine CSS-Ueberblendung auf
// `padding-top` der `.screen` mit. `hidden` wird beim Ausblenden erst nach der
// Animation gesetzt – mit Zeitgeber als Rueckfall, wie bei der Zeitleisten-Auswahl.
// Der Weg nach oben ist die eigene Hoehe PLUS 14 px: sonst bliebe der Schatten am
// oberen Rand als grauer Streifen stehen.
let _hinweisZustand = null;
let _hinweisAnim = null;
const HINWEIS_WEG = 'translateY(calc(-100% - 14px))';
function hinweisZeigen(zustand, text, knopf) {
  const el = document.getElementById('hinweis-oben');
  if (!el) return;
  _hinweisZustand = zustand;
  el.querySelector('.hinweis-txt').textContent = text;
  el.querySelector('.hinweis-akt').textContent = knopf;
  if (_hinweisAnim) { _hinweisAnim.cancel(); _hinweisAnim = null; }
  const war = !el.hidden && document.body.classList.contains('hinweis-an');
  el.hidden = false;
  document.body.classList.add('hinweis-an');
  // Hoehe messen und weitergeben: sie haengt an der Safe-Area und daran, ob der
  // Text umbricht. Ein fester Wert liesse die Leiste je nach Geraet den Tab-Titel
  // ueberdecken oder eine Luecke stehen.
  document.body.style.setProperty('--hinweis-h', el.offsetHeight + 'px');
  if (war || bewegungAus() || !el.animate) return;
  const a = _hinweisAnim = el.animate([{ transform: HINWEIS_WEG }, { transform: 'none' }],
    { duration: 280, easing: 'cubic-bezier(0, 0, 0.2, 1)' });
  const fertig = () => { if (_hinweisAnim !== a) return; _hinweisAnim = null; try { a.finish(); } catch (_) {} };
  a.onfinish = fertig;
  setTimeout(fertig, 280 + 80);
}
function hinweisAus() {
  const el = document.getElementById('hinweis-oben');
  _hinweisZustand = null;
  const war = document.body.classList.contains('hinweis-an');
  document.body.classList.remove('hinweis-an');
  document.body.style.removeProperty('--hinweis-h');
  if (!el) return;
  if (!war || el.hidden || bewegungAus() || !el.animate) { el.hidden = true; return; }
  if (_hinweisAnim) _hinweisAnim.cancel();
  const a = _hinweisAnim = el.animate([{ transform: 'none' }, { transform: HINWEIS_WEG }],
    { duration: 220, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' });
  const ende = () => {
    if (_hinweisAnim !== a) return;
    _hinweisAnim = null;
    el.hidden = true;
    a.cancel();
  };
  a.onfinish = ende;
  setTimeout(ende, 220 + 80);
}
// Der Stand der Google-Anmeldung steht als Zeile „Google-Anmeldung" in der App-Karte
// der Einstellungen. Die Leiste oben bleibt allein dem Fall „Neue Daten geladen"
// vorbehalten, der eine sofortige Antwort verlangt.
// `anmeldeStand()` ist die einzige Quelle fuer diesen Zustand.
function anmeldeStand() {
  if (!accessToken) return { text:'abgelaufen', farbe:'#F59E0B',
    hinweis:'Ohne Anmeldung zeigt die App den zuletzt geladenen Stand. Neue Daten holen geht erst nach dem Anmelden wieder.' };
  return { text:'aktiv', farbe:null, hinweis:null };
}
// Die App-Karte liegt seit 06.09.2026 auf der Einstellungen-Seite. Neu aufgebaut wird
// sie nur, wenn diese gerade offen ist – sonst holt sie sich den Stand beim naechsten
// Oeffnen ohnehin frisch (einstellungenOeffnen ruft pgEinstellungen).
function appKarteAuffrischen() {
  if (_einstOffen) pgEinstellungen();
}
document.body.addEventListener('click', (e) => {
  if (!e.target.closest('.hinweis-akt')) return;
  if (_hinweisZustand === 'neu') { hinweisAus(); _kachelnZaehlen = true; _refreshAfterStateChange(); }
});

// ── Erste Berührung merken ─────────────────────────────
// Nur Zeigegeraet und Tastatur: ein `scroll` feuert auch, wenn die App beim Start
// selbst zum ersten Tab schiebt – das haette jeden Start sofort als "berührt" gezaehlt.
['pointerdown','touchstart','keydown','wheel'].forEach(typ => {
  window.addEventListener(typ, () => { _beruehrt = true; }, { once:true, capture:true, passive:true });
});

// ── Nachladen im Hintergrund ───────────────────────────
// Laeuft nach dem Start, wenn die Anzeige aus dem Zwischenspeicher kam. Der frische
// Stand landet direkt in den Datenvariablen; offen ist nur, WANN neu gezeichnet wird:
// solange der Nutzer nichts angetippt hat, sofort und still – danach erst auf Tipp,
// sonst springt ihm die Ansicht unter dem Finger weg.
async function hintergrundLaden() {
  if (!accessToken) { appKarteAuffrischen(); return; }
  const vorher = datenStand();
  const ergebnis = await loadFromAPI({ still: true });
  if (ergebnis === 'auth') { appKarteAuffrischen(); return; }
  if (ergebnis !== true) return;               // Netzfehler: der alte Stand bleibt stehen
  appKarteAuffrischen();   // Anmeldung wieder gueltig → Zeile in der App-Karte nachziehen
  // Identischer Stand – der Normalfall, wenn die App kurz nacheinander geoeffnet wird.
  // Dann nichts anfassen: ein Neuaufbau saehe nach Ruckeln aus, ohne etwas zu zeigen.
  if (datenStand() === vorher) return;
  if (_beruehrt) {
    hinweisZeigen('neu', 'Neue Daten geladen', 'Anzeigen');
  } else {
    updateNavUI();
    _kachelnZaehlen = true;
    _refreshAfterStateChange();
  }
}

// ── Refresh Button ─────────────────────────────────────
async function refreshData() {
  // Ohne gültige Anmeldung gibt es nichts zu holen – der Knopf sagt es selbst.
  if (!accessToken) {
    // Erst die Karte auffrischen (ersetzt die Knoepfe), dann am NEUEN Knopf antworten.
    // Ohne diese Rueckmeldung passierte auf den Tipp sichtbar gar nichts – die Zeile
    // darueber sagte den Grund zwar, aber nicht als Antwort auf den Druck.
    appKarteAuffrischen();
    document.querySelectorAll('.refresh-btn').forEach(b => {
      const alt = b.textContent;
      b.textContent = 'Anmeldung nötig';
      setTimeout(() => { if (b.isConnected) b.textContent = alt; }, 2500);
    });
    return;
  }
  // Beschriftung „Lädt…"; der alte Text wird am Element gemerkt und danach zurueckgesetzt.
  const btns = document.querySelectorAll('.refresh-btn');
  btns.forEach(b => { b.disabled = true; b.dataset.altText = b.textContent; b.textContent = 'Lädt…'; });
  const knoepfeZurueck = () => document.querySelectorAll('.refresh-btn').forEach(b => {
    b.disabled = false;
    if (b.dataset.altText) { b.textContent = b.dataset.altText; delete b.dataset.altText; }
  });
  // 1. Apps Script: Drive → Sheet. Das Skript antwortet erst, wenn der Import fertig
  //    ist – danach stehen die Werte bereits im Sheet. Die fruehere feste Pause von
  //    4 s danach war deshalb reine Wartezeit (entfernt 27.09.2026).
  const bericht = await importAnstossen();
  // 2. Hat der Import nichts geaendert und stand die letzte Aenderung schon beim
  //    letzten Laden im Sheet, gibt es nichts Neues zu lesen.
  if (nichtsNeues(bericht)) {
    knoepfeZurueck();
    appKarteAuffrischen();
    refreshBestaetigen('Schon aktuell ✓');
    return;
  }
  // 3. Daten neu aus dem Sheet laden
  workoutSheetReady = false; workoutLoadError = null;
  const ergebnis = await loadFromAPI();
  knoepfeZurueck();
  if (ergebnis === 'auth') { appKarteAuffrischen(); return; }
  // Auf ausdruecklichen Wunsch geladen → immer sofort zeichnen, nie nur ankuendigen.
  if (_hinweisZustand) hinweisAus();
  appKarteAuffrischen();
  if (ergebnis === true) { refreshBestaetigen('Aktualisiert ✓'); _kachelnZaehlen = true; }
  updateNavUI();
  _refreshAfterStateChange();
}

// Import im Apps Script ausloesen und seinen Bericht lesen:
// { ok, neu, ersetzt, workoutTage, letzteAenderung } – oder null, wenn keiner kam
// (Netzfehler, altes Skript ohne Bericht, Antwort nicht lesbar). null heisst
// „unbekannt": dann wird wie frueher in jedem Fall neu geladen.
async function importAnstossen() {
  try {
    const res = await fetch(REFRESH_URL, { method: 'POST',
      // text/plain haelt die Anfrage „einfach" – ohne Vorab-Anfrage (CORS-Preflight),
      // die das Apps Script nicht beantworten kann.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ refresh: true, zugang: accessToken }) });
    const bericht = await res.json();
    if (bericht && bericht.error) console.warn('[Import] Apps Script meldet:', bericht.error);
    return bericht && typeof bericht === 'object' ? bericht : null;
  } catch (e) {
    console.warn('[Import] kein Bericht vom Apps Script:', e.message);
    return null;
  }
}

// Darf das erneute Lesen der Blaetter entfallen? Nur, wenn der Bericht ausdruecklich
// null Aenderungen meldet UND die letzte Aenderung im Sheet aelter ist als der zuletzt
// geladene Stand – sonst koennte ein Import per Zeitplan seither etwas geschrieben
// haben. 5 Minuten Puffer gegen abweichende Uhren von Geraet und Server.
function nichtsNeues(b) {
  if (!b || !b.ok || b.error) return false;
  if ([b.neu, b.ersetzt, b.workoutTage].some(n => typeof n !== 'number') || b.neu + b.ersetzt + b.workoutTage > 0) return false;
  if (typeof b.letzteAenderung !== 'number' || !_lastLoadTs || !allData.length) return false;
  return b.letzteAenderung < _lastLoadTs - 5 * 60 * 1000;
}
// Rueckmeldung nach erfolgreichem Laden (auf Wunsch, 18.09.2026): der Knopf zeigt
// 1.8 s lang `text` auf Gruen („Aktualisiert ✓" bzw. „Schon aktuell ✓", wenn der
// Import nichts Neues fand), dann wieder seinen Text. Vorher sprang er
// von „Lädt…" kommentarlos zurueck – ob das Laden geklappt hatte, sah man nicht.
// Erst NACH `appKarteAuffrischen()` aufrufen: die baut die Einstellungen-Seite neu
// und ersetzt dabei den Knopf. Nur bei `true` – ein Netzfehler ist kein Erfolg.
function refreshBestaetigen(text) {
  document.querySelectorAll('.refresh-btn').forEach(b => {
    const alt = b.textContent;
    b.textContent = text;
    b.classList.add('ok');
    setTimeout(() => {
      if (!b.isConnected) return;
      b.classList.remove('ok');
      if (b.textContent === text) b.textContent = alt;
    }, 1800);
  });
}
// Gespeicherte Hell/Dunkel-Präferenz laden
try { if(localStorage.getItem('hcc_dark')==='1') applyDarkMode(true); } catch(e) {}

document.getElementById('loading').style.display = 'none';
updateNavUI();

// Tab-Snap-Sync + Auto-Hide-Bottom-Nav initialisieren
initTabScrollSync();
zeitleisteBauen();
// Die Tableiste startet eingeklappt (auf Wunsch, 07.09.2026). Zurueck kommt sie wie
// sonst auch: durch einen Tipp auf den freien Kartenhintergrund. Muss VOR dem ersten
// showScreen stehen, damit die Zeitleiste gleich auf der richtigen Hoehe sitzt.
navAusblenden(document.getElementById('bottom-nav'), true);
einstellungenWischen();
diagrammWischen();
initScrollHideNav();
// Initial render des ersten Tabs
showScreen('overview');
// Nach dem ersten Tab: `_checkHashToken` hat den Anmelde-Hash bis hier bereits
// entfernt, und der Verlaufseintrag hinter der App zeigt die fertige Uebersicht.
verlaufsWacheStarten();
// Übrige Tabs direkt danach im Hintergrund vorrendern (deferred, einer pro Frame),
// damit beim Wischen kein leeres Panel mehr erscheint.
_prerenderTabs(TAB_ORDER);

// Kam die Anzeige aus dem Zwischenspeicher, jetzt den frischen Stand nachholen –
// die App ist zu diesem Zeitpunkt bereits vollstaendig bedienbar.
if (_startAusCache) hintergrundLaden();

})();

// Service-Worker (registriert sich nach DOMContentLoaded; ausserhalb des IIFE)
window.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
});
