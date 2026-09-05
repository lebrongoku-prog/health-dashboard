// ── GitHub Pages – OAuth2 + Sheets API (wie Tesla Dashboard) ──
const CLIENT_ID        = '185114707171-tto1teeec25d9sgkeobme666ndpdip7k.apps.googleusercontent.com';
const REDIRECT_URI     = 'https://lebrongoku-prog.github.io/health-dashboard/';
const HEALTH_SHEET_ID  = '1eZ47hJUc7yX_o-eH0p9JL3Wi34wWMQ8gSEI1a46VRKM';
const WORKOUT_SHEET_ID = '1YJ3ke8Z2jS1KdJlKOnukUStMgvqqppnktAb8UVHDdgk';
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

// ── Workout-Daten aus API-Response parsen ──────────────
// Symbol zur Trainingsart – Stichwortsuche statt exakter Namensliste.
function _parseWorkoutRows(rows) {
  // Sheet-Werte kommen als Strings – hier ausdruecklich in Zahlen wandeln.
  const pN = v => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(v); return isNaN(n) ? null : n; };

  // MEHRERE Einheiten am selben Tag werden ZUSAMMENGEFASST, nicht ueberschrieben.
  // Vorher stand hier schlicht `workoutData[date] = {…}` – bei zwei Eintraegen am
  // selben Tag (etwa Lauf am Morgen, Intervalltraining am Abend) gewann der zuletzt
  // gelesene und der andere verschwand spurlos aus jedem Diagramm. Gemessen an
  // Testdaten: 93.2 min im Sheet, 32.9 min in der Anzeige.
  const proTag = {};
  rows.forEach(r => {
    const date = r['Date'] || r['date'];
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return;
    (proTag[date] = proTag[date] || []).push({
      typeRaw:  String(r['Type'] || r['type'] || '').trim(),
      dauer:    pN(r['Duration (min)']),
      strecke:  pN(r['Distance (km)']),
      puls:     pN(r['Avg HR']),
      speed:    pN(r['Speed (km/h)'])
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
      durationMin: summe(e, 'dauer'),
      distanceKm:  summe(e, 'strecke'),
      avgHR:       gewichtet(e, 'puls'),
      avgSpeedKph: gewichtet(e, 'speed')
    };
  });
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

const showErr = m => {
  document.getElementById('loading').style.display = 'none';
  const e = document.getElementById('err-screen');
  e.style.display = 'flex';
  document.getElementById('err-txt').textContent = m;
};

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
  const res = await fetch(
    'https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '?fields=sheets.properties.title',
    { headers: { 'Authorization': 'Bearer ' + accessToken } }
  );
  if (res.status === 401) return { authError: true };
  if (!res.ok) throw new Error('Sheets API Fehler ' + res.status + ': ' + await res.text());
  const meta = await res.json();
  const titel = (meta.sheets || []).map(x => x.properties.title);
  _tabsMerken(sheetId, titel);
  return { titel };
}

// ── Daten von Apps Script API laden ───────────────────
// Sheets-Tab-Name ermitteln und Daten laden (wie Tesla Dashboard)
async function _fetchSheet(sheetId, blattName) {
  // Token-Ablauf proaktiv prüfen – wenn er in < 60 s abläuft, gilt er als ungültig.
  // Hier wird BEWUSST nicht mehr von selbst zur Anmeldung weitergeleitet: seit die
  // App aus dem Zwischenspeicher startet, liefe sonst jeder Hintergrund-Abruf in
  // eine Weiterleitung und risse den Nutzer aus der laufenden Ansicht. Der Aufrufer
  // entscheidet, was mit `authError` geschieht.
  if (!accessToken || Date.now() > tokenExpiry - 60_000) {
    accessToken = null; tokenExpiry = 0;
    try { localStorage.removeItem('g_token'); localStorage.removeItem('g_expiry'); } catch(_) {}
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
  const dataRes = await fetch(
    'https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values/' + encodeURIComponent(tabName),
    { headers: { 'Authorization': 'Bearer ' + accessToken } }
  );
  if (dataRes.status === 401) return { authError: true };
  if (!dataRes.ok) throw new Error('Daten-Abruf fehlgeschlagen: ' + dataRes.status);
  const json = await dataRes.json();
  return { values: json.values || [] };
}

// Laedt alle fuenf Blaetter. `still:true` = Hintergrund-Abruf, waehrend bereits Daten
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
    const [health, workout] = await Promise.all([
      _fetchSheet(HEALTH_SHEET_ID),
      _fetchSheet(WORKOUT_SHEET_ID).catch(alsFehler)
    ]);
    if (health.authError) {
      accessToken = null; tokenExpiry = 0;
      try { localStorage.removeItem('g_token'); localStorage.removeItem('g_expiry'); } catch(_) {}
      if (!still) {
        document.getElementById('loading').style.display = 'none';
        document.getElementById('login-screen').style.display = 'flex';
      }
      return 'auth';
    }
    if (!health.values || health.values.length < 2) throw new Error('Keine Gesundheitsdaten im Sheet gefunden');
    const hHeaders = health.values[0].map(h => h.trim());
    const strCols = new Set(['date','sleepStart','sleepEnd']);
    allData = health.values.slice(1).map(row => {
      const obj = {};
      hHeaders.forEach((h, i) => {
        const v = (row[i] ?? '').toString().trim();
        if (v === '') { obj[h] = null; return; }
        obj[h] = strCols.has(h) ? v : (isNaN(v) ? v : parseFloat(v));
      });
      return obj;
      // Nur echte Datumszeilen übernehmen. Vorher genügte irgendein nicht-leerer
      // Text in der Datumsspalte – der wäre bis in die Anzeige durchgereicht worden.
      // Das Workout-Sheet prüft schon immer nach demselben Muster.
    }).filter(r => r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date));
    if (!allData.length) throw new Error('Keine Zeile mit gültigem Datum (Format JJJJ-MM-TT) gefunden');
    allData.sort((a, b) => a.date.localeCompare(b.date));

    // Doppelte Datumszeilen zusammenführen.
    // Das Apps-Script schreibt beim Refresh die letzten Tage neu; steht ein Tag danach
    // zweimal im Sheet, zählte er bisher in JEDEN Durchschnitt doppelt – Schlaf, Puls,
    // HRV, Schritte, Score, Baselines. Aufgefallen ist es im Schlafschuld-Tooltip, wo
    // dieselbe Nacht mehrfach aufgelistet wurde; die Ursache lag aber im Einlesen.
    // Zusammenführen statt Verwerfen: die spätere Zeile gewinnt, überschreibt aber
    // keinen vorhandenen Wert mit null (eine Nachzügler-Zeile kann Felder leer lassen).
    const _proTag = new Map();
    allData.forEach(r => {
      const vorhanden = _proTag.get(r.date);
      if (!vorhanden) { _proTag.set(r.date, r); return; }
      Object.keys(r).forEach(k => { if (r[k] != null) vorhanden[k] = r[k]; });
    });
    const _dubletten = allData.length - _proTag.size;
    if (_dubletten > 0) console.info(`[Daten] ${_dubletten} doppelte Datumszeile(n) zusammengeführt.`);
    allData = [..._proTag.values()];
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
    showErr('Fehler beim Laden: ' + e.message); return false;
  }
  _lastLoadTs = Date.now();
  datenCacheSchreiben();
  return true;
}

// ── Zwischenspeicher der Daten ────────────────────────
// Die App wartete beim Start, bis alle Blätter geladen waren – bei abgelaufener
// Anmeldung sah man stattdessen nur den Login. Jetzt liegt der zuletzt geladene
// Stand auf dem Gerät: er erscheint sofort, das Nachladen läuft dahinter.
// Das Google-Sheet bleibt die massgebliche Quelle; hier steht nur eine Kopie.
// Die Versionsnummer im Schlüssel verwirft alte Stände automatisch, falls sich
// später ändert, WIE die Daten eingelesen werden – lieber einmal warten als
// einen alten Stand falsch deuten.
const DATEN_KEY = 'hcc_daten_v1';

// Der Inhalt OHNE Zeitstempel – dient zugleich als Fingerabdruck: der Hintergrund-
// Abruf vergleicht ihn vorher und nachher und zeichnet nur neu, wenn sich wirklich
// etwas geaendert hat. Sonst blitzte bei jedem Start ein Neuaufbau aller Diagramme
// auf, obwohl exakt dieselben Zahlen herauskamen.
function datenStand() {
  return JSON.stringify({ allData, workoutData, workoutLoadError });
}

function datenCacheSchreiben() {
  try {
    localStorage.setItem(DATEN_KEY, '{"v":1,"ts":' + (_lastLoadTs || 0) + ',"d":' + datenStand() + '}');
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
  if (!roh || roh.v !== 1 || !roh.d) return false;
  d = roh.d; d.ts = roh.ts;
  if (!Array.isArray(d.allData) || !d.allData.length) return false;
  // Dieselbe Datumsprüfung wie beim Einlesen aus dem Sheet: der Zwischenspeicher ist
  // beschreibbar von aussen, also nicht vertrauenswürdiger als eine Sheet-Zelle.
  const zeilen = d.allData.filter(r => r && typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date));
  if (!zeilen.length) return false;
  allData = zeilen;
  allData.sort((a, b) => a.date.localeCompare(b.date));
  workoutData    = (d.workoutData && typeof d.workoutData === 'object') ? d.workoutData : {};
  workoutLoadError = d.workoutLoadError || null;
  workoutSheetReady = true;
  referenceDate  = allData[allData.length - 1].date;
  _lastLoadTs    = (typeof d.ts === 'number' && d.ts > 0) ? d.ts : null;
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
  if (!accessToken) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
    return;
  }
  if ((await loadFromAPI()) !== true) return;
}

// ── Field detection ────────────────────────────────────
function findField(rows, ...candidates) {
  for (const c of candidates) {
    if (rows.some(r => r[c] != null && r[c] !== 0 && !isNaN(r[c]))) return c;
  }
  return null;
}

// ── Window / filter ────────────────────────────────────
// Die auswählbaren Bereiche stehen in _RANGE_OPTS (Quelle für das Dropdown).
function windowDays() { return {'heute':1,'7d':7}[timeRange] || null; }
function windowMonths() { return {'1m':1,'3m':3,'6m':6,'12m':12,'24m':24}[timeRange] || null; }

// Always format as local YYYY-MM-DD (avoids UTC-offset-off-by-one bug)
function toLocalDateStr(dt) {
  return dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');
}
function addDays(dateStr, n) {
  return toLocalDateStr(new Date(new Date(dateStr+'T00:00:00').getTime() + n*86400000));
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
  const mw = moWindow();
  if (mw) return allData.filter(r => r.date >= mw.s && r.date <= mw.e);
  // fallback (no month filter active)
  const e = referenceDate;
  const s = addDays(referenceDate, -((windowDays()||1)-1));
  return allData.filter(r => r.date >= s && r.date <= e);
}

function prevPeriod() {
  if (!referenceDate || !allData.length) return [];
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


function fmtDayShort(d) {
  if (!d) return '–';
  const dt = new Date(d+'T00:00:00');
  return String(dt.getDate()).padStart(2,'0')+'.'+String(dt.getMonth()+1).padStart(2,'0')+'.'+String(dt.getFullYear()).slice(-2);
}

// Hinweis: navDateLabel wurde entfernt – die Filterleiste zeigt die Zeitspanne
// nicht mehr als Text, sie steht auf der Zeitachse der Diagramme.

function updateNavUI() {
  // Die Zeitspanne als Text entfiel mit der neuen Filterleiste (sie steht auf der
  // Zeitachse). Geblieben ist der Aktiv-/Inaktiv-Zustand der beiden Pfeile.
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
  document.querySelectorAll('.nav-prev').forEach(b => { b.disabled = prevDis; });
  document.querySelectorAll('.nav-next').forEach(b => { b.disabled = nextDis; });
}

function navPrev() {
  if (!referenceDate || !allData.length) return;
  const nr = is7D() ? addDays(referenceDate, -7) : addMonths(referenceDate, -1);
  if (nr < allData[0].date) return;
  referenceDate = nr; _datumSelbstGewaehlt = true;
  updateNavUI();
  _navSliding = true;
  _refreshAfterStateChange();
  _navSliding = false;
  _animNavSlide(-1); // zurück: Daten wischen nach rechts
}

function navNext() {
  if (!referenceDate || !allData.length) return;
  const maxDate = allData[allData.length-1].date;
  const nr = is7D() ? addDays(referenceDate, 7) : addMonths(referenceDate, 1);
  if (nr > maxDate) return;
  referenceDate = nr; _datumSelbstGewaehlt = true;
  updateNavUI();
  _navSliding = true;
  _refreshAfterStateChange();
  _navSliding = false;
  _animNavSlide(1); // vor: Daten wischen nach links
}

// Wisch-Animation beim Pfeil-Navigator. Verschiebt via navslide-Plugin NUR die
// Datenfläche jedes Charts (Achsen/Gitter bleiben stehen). dir=-1 (zurück) →
// Daten kommen von links herein (Bewegung nach rechts); dir=+1 (vor) → von rechts.
// Sanftes, etwas längeres Ease-Out + Einblendung. Respektiert reduce-motion.
let _navSliding = false;
let _navSlideRAF = null;
function _animNavSlide(dir) {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (_navSlideRAF) { cancelAnimationFrame(_navSlideRAF); _navSlideRAF = null; }
  requestAnimationFrame(() => {
    const list = (tabCharts[currentScreen] || [])
      .map(id => charts[id]).filter(c => c && c.chartArea);
    if (!list.length) return;
    const dur = 560;                          // sanfter: länger
    const ease = t => 1 - Math.pow(1 - t, 3); // easeOutCubic – weiches Auslaufen
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const e = ease(t);
      list.forEach(c => {
        if (!c.chartArea) return;
        const w = c.chartArea.right - c.chartArea.left;
        const dist = Math.min(w * 0.42, 110);
        c.$navslide = { offset: dir * dist * (1 - e), alpha: 0.25 + 0.75 * e };
        try { c.draw(); } catch (_) {}
      });
      if (t < 1) { _navSlideRAF = requestAnimationFrame(step); }
      else { list.forEach(c => { delete c.$navslide; try { c.draw(); } catch (_) {} }); _navSlideRAF = null; }
    };
    _navSlideRAF = requestAnimationFrame(step);
  });
}

function setR(r) {
  timeRange = r;
  // Die Filter-Controls liegen jetzt in den Diagrammen und werden beim Re-Render
  // (mit korrektem Bereich + Navigator-Sichtbarkeit) frisch aufgebaut.
  _refreshAfterStateChange();
}

// ── Helpers ────────────────────────────────────────────
const MO = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
function fmtM(ym) { if (!ym) return '—'; const [y,m] = ym.split('-').map(Number); return MO[m-1]+' '+String(y).slice(-2); }
function zahl(v, dec=1) { return v == null ? '—' : Number(v).toFixed(dec); }

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
function mittel(arr, field) {
  const vals = arr.map(r => field ? r[field] : r).filter(v => v != null && !isNaN(v));
  return vals.length ? vals.reduce((a,b) => a+b, 0)/vals.length : null;
}
function standardabw(arr, field) {
  const vals = arr.map(r => field ? r[field] : r).filter(v => v != null && !isNaN(v));
  if (vals.length < 2) return null;
  const m = vals.reduce((a,b)=>a+b,0)/vals.length;
  return Math.sqrt(vals.map(v=>(v-m)**2).reduce((a,b)=>a+b,0)/vals.length);
}
function trendLabel() { return 'vs. Vorperiode'; }
function monatsMittel(rows, field) {
  const b = {};
  rows.forEach(r => { if(r[field]==null) return; const mo=r.date.slice(0,7); if(!b[mo])b[mo]={sum:0,n:0}; b[mo].sum+=r[field]; b[mo].n++; });
  return Object.entries(b).sort((a,x)=>a[0].localeCompare(x[0])).map(([mo,{sum,n}])=>({mo,v:sum/n}));
}
function monatsSumme(rows, field) {
  const b = {};
  rows.forEach(r => { if(r[field]==null) return; const mo=r.date.slice(0,7); b[mo]=(b[mo]||0)+r[field]; });
  return Object.entries(b).sort((a,x)=>a[0].localeCompare(x[0])).map(([mo,v])=>({mo,v}));
}
function allMonths(rows) { return [...new Set(rows.map(r=>r.date.slice(0,7)))].sort(); }
function alignByMo(mos, arr) { const m=Object.fromEntries(arr.map(x=>[x.mo,x.v])); return mos.map(m2=>m[m2]??null); }
function alsStdMin(h) { if(h==null) return '—'; return Math.floor(h)+'h '+Math.round((h%1)*60).toString().padStart(2,'0')+'m'; }
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
function parseTV(val) { if(val==null)return null; if(typeof val==='number'&&!isNaN(val))return val; if(typeof val==='string'){const dt=val.match(/\d{4}-\d{2}-\d{2}\s+(\d{2}):(\d{2})/);if(dt)return parseInt(dt[1])+parseInt(dt[2])/60; const t=val.match(/^(\d{1,2}):(\d{2})/);if(t)return parseInt(t[1])+parseInt(t[2])/60;} return null; }
function avgCircTime(rows,field,isSleepOnset){ if(!field)return null; const vals=rows.map(r=>parseTV(r[field])).filter(v=>v!=null); if(!vals.length)return null; const norm=isSleepOnset?vals.map(h=>h<12?h+24:h):vals; const avg=norm.reduce((a,b)=>a+b,0)/norm.length; return avg>=24?avg-24:avg; }
function findAnyField(rows,...cands){ for(const c of cands){if(rows.some(r=>r[c]!=null))return c;} return null; }

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
function weekDays7() {
  if (!referenceDate) return [];
  const mon = getWeekMonday(referenceDate);
  return Array.from({length:7}, (_,i) => { const d=new Date(mon+'T00:00:00'); d.setDate(d.getDate()+i); return toLocalDateStr(d); });
}
function wochenMittel(rows, field) {
  const b = {};
  rows.forEach(r => { if(r[field]==null) return; const w=getWeekMonday(r.date); if(!b[w])b[w]={sum:0,n:0}; b[w].sum+=r[field]; b[w].n++; });
  return Object.entries(b).sort((a,x)=>a[0].localeCompare(x[0])).map(([w,{sum,n}])=>({w,v:sum/n}));
}
function wochenSumme(rows, field) {
  const b = {};
  rows.forEach(r => { if(r[field]==null) return; const w=getWeekMonday(r.date); b[w]=(b[w]||0)+r[field]; });
  return Object.entries(b).sort((a,x)=>a[0].localeCompare(x[0])).map(([w,v])=>({w,v}));
}
function allWeeks(rows) { return [...new Set(rows.map(r=>getWeekMonday(r.date)))].sort(); }
function alignByWeek(weeks,arr) { const m=Object.fromEntries(arr.map(x=>[x.w,x.v])); return weeks.map(w=>m[w]??null); }
// Zweizeilige Achsenbeschriftung für Tagesauflösung: Wochentag über dem Datum.
// Chart.js rendert ein Array als mehrzeiligen Tick – erster Eintrag oben.
const WOCHENTAG_KURZ = ['So','Mo','Di','Mi','Do','Fr','Sa'];
function wochentagKurz(dateStr) { return WOCHENTAG_KURZ[new Date(dateStr+'T00:00:00').getDay()]; }
function tagLabel(dateStr) {
  const dt = new Date(dateStr+'T00:00:00');
  return [wochentagKurz(dateStr),
          String(dt.getDate()).padStart(2,'0')+'.'+String(dt.getMonth()+1).padStart(2,'0')+'.'];
}
function fmtWeek(w) { const dt=new Date(w+'T00:00:00'); return String(dt.getDate()).padStart(2,'0')+'.'+String(dt.getMonth()+1).padStart(2,'0')+'.'; }

// granular=true → weekly buckets for 1M/3M (line charts); false → monthly (bar charts)
function timeDim(rows, granular=false, keepAggregated=false) {
  if (is7D()) {
    const days = weekDays7();
    const byDate = {};
    rows.forEach(r => { byDate[r.date] = r; });
    const labels = days.map(tagLabel);
    const align = field => days.map(d => byDate[d]?.[field] ?? null);
    return { labels, align, alignSum:align, hasData:days.some(d => d in byDate), keys:days, keyTyp:'tag' };
  }
  // Daily data for 1M
  if (timeRange==='1m' && !keepAggregated) {
    const mw=moWindow();
    const byDate={};
    rows.forEach(r=>{byDate[r.date]=r;});
    const days=[];
    if(mw){let d=new Date(mw.s+'T00:00:00');const end=new Date(mw.e+'T00:00:00');while(d<=end){days.push(toLocalDateStr(d));d.setDate(d.getDate()+1);}}
    const labels=days.map(tagLabel);
    const align=field=>days.map(d=>byDate[d]?.[field]??null);
    return{labels,align,alignSum:align,hasData:days.some(d=>d in byDate),keys:days,keyTyp:'tag'};
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
      align: field => alignByWeek(weeks, wochenMittel(rows, field)),
      alignSum: field => alignByWeek(weeks, wochenSumme(rows, field)),
      hasData: weeks.length > 0,
      keys: weeks, keyTyp: 'woche'
    };
  }
  const mos = allMonths(rows);
  return {
    labels: mos.map(fmtM),
    align: field => alignByMo(mos, monatsMittel(rows, field)),
    alignSum: field => alignByMo(mos, monatsSumme(rows, field)),
    hasData: mos.length > 0,
    keys: mos, keyTyp: 'monat'
  };
}

// ═══════════════════════════════════════════════════════════
// Zeitraum-Schlüssel, Wochenend-Tönung und app-weite Markierung
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
function _markIndex(chart) {
  if (!_markierung || !chart.$keys) return -1;
  const d = _markierung;
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

// ── Ebene 1: Wochenenden tönen (nur bei Tagesauflösung) ──
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

// ── Ebene 2: markierte Säule tönen + einrahmen (vor den Daten) ──
const markierungPlugin = {
  id: 'markierung',
  beforeDatasetsDraw(chart) {
    const i = _markIndex(chart);
    if (i < 0) return;
    const a = chart.chartArea; if (!a) return;
    const sp = _spalte(chart, i), ctx = chart.ctx;
    // Die Markierung besteht ausschliesslich aus der getoenten Spaltenflaeche –
    // keine senkrechten Randlinien mehr.
    ctx.save();
    ctx.fillStyle = _cssFarbe('--tab-color', '#0891B2');
    ctx.globalAlpha = 0.13;
    ctx.fillRect(sp.links, a.top, sp.rechts - sp.links, a.bottom - a.top);
    ctx.restore();
  },
  // ── Ebene 3: alles ausserhalb der Säule zurücktreten lassen ──
  // Als Schleier ÜBER den Daten statt über die Farben jedes einzelnen Datensatzes:
  // wirkt dadurch auch auf Linien und Flächen und kommt ohne Eingriff in die
  // zwölf unterschiedlich aufgebauten Diagramme aus.
  afterDatasetsDraw(chart) {
    const i = _markIndex(chart);
    if (i < 0) return;
    const a = chart.chartArea; if (!a) return;
    const sp = _spalte(chart, i), ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = document.body.classList.contains('dark')
      ? 'rgba(30,41,59,.72)' : 'rgba(255,255,255,.72)';
    ctx.fillRect(a.left, a.top, Math.max(0, sp.links - a.left), a.bottom - a.top);
    ctx.fillRect(sp.rechts, a.top, Math.max(0, a.right - sp.rechts), a.bottom - a.top);
    ctx.restore();
  }
};

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
function setMarkierung(datum) {
  _markierung = datum;
  Object.values(charts).forEach(c => {
    try { c.update('none'); _tooltipAnMarkierung(c); c.draw(); } catch(_) {}
  });
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

Chart.register(wochentrennerPlugin, markierungPlugin);

function killCharts() {
  Object.values(charts).forEach(c => { try { c.destroy(); } catch(e){} });
  Object.keys(charts).forEach(k => delete charts[k]);
}
function zeichneDiagramm(id, cfg) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (charts[id]) { try { charts[id].destroy(); } catch(e){} }
  // Während einer Pfeil-Navigation die Aufbau-Animation abschalten – die seitliche
  // Wisch-Bewegung übernimmt _animNavSlide (sonst zwei konkurrierende Animationen).
  if (_navSliding) { cfg.options = cfg.options || {}; cfg.options.animation = false; }
  charts[id] = new Chart(el, cfg);
  // Zeitraum-Schlüssel am Chart hinterlegen (siehe Kern-Block oben) und den Tipp
  // verkabeln. Ohne __keys bleibt ein Diagramm von Wochenend-Tönung und Markierung
  // unberührt – so lassen sich einzelne Diagramme bewusst ausnehmen.
  charts[id].$keys   = cfg.__keys   || null;
  charts[id].$keyTyp = cfg.__keyTyp || null;
  if (charts[id].$keys) {
    el.addEventListener('click', e => _chartTipp(charts[id], e));
    el.style.cursor = 'pointer';
    // Beim Neuaufbau (Filter- oder Tabwechsel) die bestehende Markierung samt
    // Tooltip wieder herstellen – sonst verschwände sie beim ersten Re-Render.
    if (_markierung) { try { _tooltipAnMarkierung(charts[id]); charts[id].draw(); } catch(_) {} }
  }
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
// Betroffen sind drei Bauarten, die absichtlich verschieden bleiben:
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
    // Am Bildschirmrand einklemmen: die ⓘ auf den Minikacheln sitzen ganz links und
    // ganz rechts, ein mittig zentrierter Kasten ragte dort aus dem Bild.
    const tt = el.querySelector('.info-tt');
    if (!tt) { _ttOpenEl = null; return; }
    el.classList.add('tt-open');                        // erst sichtbar, dann messen
    _placeTooltip(tt, rect, 220, 110);
  } else {
    el.classList.add('tt-open');                        // reine CSS-Tooltips
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
const gx = {grid:{display:false},ticks:{color:'#94A3B8',font:{size:10}}};
const gy = {grid:{color:GRID_COLOR},ticks:{color:'#94A3B8',font:{size:10}}};

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
  // fmtZiel: kuerzere Fassung fuer die Zielangabe. In der Ziel-Karte steht der
  // Zielwert direkt hinter dem Messwert – die Einheit ist dort schon gesagt und
  // haette sich sonst wiederholt („4 / Woche · Ziel 3 / Woche").
  trainDays:  { label:'Trainingstage',ziel:3,     richtung:'hoch', fmt:v=>v+' / Woche', fmtZiel:v=>String(v) },
  vo2max:     { label:'VO₂max',       ziel:45,    richtung:'hoch', fmt:v=>zahl(v,1) }
};
// Erfüllt der Wert das Ziel? null, wenn kein Wert vorliegt.
function zielErfuellt(key, wert) {
  const z = ZIELE[key];
  if (!z || wert == null) return null;
  return z.richtung === 'hoch' ? wert >= z.ziel : wert <= z.ziel;
}
// Hinweis: zielBadge wurde entfernt – die Marke sass ausschliesslich in der
// Trend-Karte der Uebersicht. Mit ihr entfiel auch zielText, das nur von zielBadge
// gebraucht wurde. zielErfuellt bleibt: die Statuszeile oben nutzt es weiter.
// Tooltip-Filter: Hilfslinien (Ø-Linie, Ziellinie) sind Orientierung, keine Messwerte –
// sie gehören nicht in die Werteliste beim Antippen eines Datenpunkts.
const nurMesswerte = item => !/^(Ø|Ziel)/.test(item.dataset.label || '');

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

// ── Statuszeile: alle Ziele auf einen Blick ────────────
// Beantwortet beim Öffnen der App die Frage "liegt gerade etwas ausserhalb?",
// ohne dass durch fünf Tabs gescrollt werden muss.
function zielUebersichtHTML() {
  const last = allData[allData.length-1] || {};
  const letzte7 = allData.slice(-7);
  const trainProWoche = letzte7.filter(r => workoutData[r.date]?.durationMin > 0).length;
  const letzterVo2 = [...allData].reverse().find(r => r.vo2max != null)?.vo2max ?? null;

  // ALLE Ziele, immer – auch die erreichten und die ohne Wert. Vorher zeigte die
  // Karte nur die verfehlten; ob ein erreichtes knapp oder deutlich erreicht war,
  // liess sich nicht ablesen. Aufbau wie die uebrigen Karten: Titel + Wertzeilen.
  const pruef = [
    ['sleepTotal', last.sleepTotal],
    ['restHR',     last.restHR],
    ['hrv',        last.hrv],
    ['trainDays',  letzte7.length >= 7 ? trainProWoche : null],
    ['vo2max',     letzterVo2]
  ];
  if (!allData.length) return '';

  const zeilen = pruef.map(([k, v]) => {
    const z = ZIELE[k];
    const zielTxt = `<span style="color:var(--txt3);font-weight:400"> · Ziel ${(z.fmtZiel || z.fmt)(z.ziel)}</span>`;
    if (v == null) return statZeile(z.label, `—${zielTxt}`, null);
    const ok = zielErfuellt(k, v);
    // Farbe ist hier die Bewertung selbst: gruen erreicht, orange verfehlt.
    return statZeile(z.label, `${z.fmt(v)}${zielTxt}`, ok ? '#10B981' : '#F59E0B');
  }).join('');

  return `<div class="chart-card">
    <div class="chart-head"><h3>Ziele</h3>${scopeBadge('letzter Tag')}</div>
    <div class="stats-list">${zeilen}</div>
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
// Antippbares Fragezeichen. Nutzt das zentrale Tooltip-System (Maus + Finger).
// Erklärt, wie die Zahl auf einer Minikachel der Übersicht zu lesen ist.
// Bewusst je Kennzahl formuliert statt eines allgemeinen Satzes: entscheidend ist,
// in welche Richtung eine Abweichung gut ist – das unterscheidet sich pro Wert.
// Bezug ist überall derselbe: Wert = letzter Tag, Ø = die sieben Tage davor.
const ERKLAERUNG_MINI = {
  sleepTotal: 'Oben die Schlafdauer der letzten Nacht, darunter der Abstand zum Durchschnitt der sieben Nächte davor. „+18m vs. Ø" heisst: 18 Minuten mehr als üblich. Mehr ist besser.',
  restHR:     'Oben der Ruhepuls des letzten Tages, darunter der Abstand zum Durchschnitt der sieben Tage davor. „−2 vs. Ø" heisst: 2 Schläge weniger als üblich. Weniger ist besser.',
  hrv:        'Oben die HRV des letzten Tages, darunter der Abstand zum Durchschnitt der sieben Tage davor. „+3 vs. Ø" heisst: 3 ms mehr als üblich. Mehr ist besser.',
  training:   'Oben die Trainingsminuten des letzten Tages, darunter der Abstand zum Durchschnitt der Trainingstage aus den sieben Tagen davor. Tage ohne Training zählen nicht in den Durchschnitt.',
  trainWoche: 'Anzahl Tage mit Training in den letzten sieben Tagen, darunter der Vergleich mit den sieben Tagen davor. Diese Kachel erscheint an Tagen ohne Training – an Trainingstagen steht hier die Dauer der Einheit. Mehr ist besser.'
};

// Antippbares Fragezeichen. Der Text steckt als eigenes Element im Anker, damit ihn
// openTooltip am Bildschirmrand verschieben kann – ein reiner CSS-Tooltip würde auf
// den schmalen Minikacheln links und rechts aus dem Bild ragen.
function _infoAnker(text) {
  return text
    ? `<span class="info-i" tabindex="0" role="button" aria-label="Erklärung">i<span class="info-tt">${esc(text)}</span></span>`
    : '';
}
function infoI(key)     { return _infoAnker(ERKLAERUNG[key]); }
function infoMini(key)  { return _infoAnker(ERKLAERUNG_MINI[key]); }

// Hinweis: computeHealthScore/scoreCat wurden entfernt – die Score-Karte auf der
// Uebersicht ist auf Wunsch weggefallen und war ihr einziger Aufrufer.

// ─────────────────────────────────────────────────────────
// ── Coaching Helpers ───────────────────────────────────
// ─────────────────────────────────────────────────────────

// Calculate average of a field over the last N days of allData (memoisiert)
function calculateBaseline(field, nDays) {
  return _memo('baseline:'+field+':'+nDays, () => {
    const rows = allData.slice(-nDays).filter(r => r[field] != null);
    return rows.length ? rows.reduce((s,r) => s+r[field], 0)/rows.length : null;
  });
}

// % deviation of current from baseline (positive = above baseline)
function calculateDeviation(current, baseline) {
  if (current == null || baseline == null || baseline === 0) return null;
  return ((current - baseline) / baseline) * 100;
}

// Sleep debt: target minus actual, in hours
// SLEEP_TARGET_H is the personal nightly goal
const SLEEP_TARGET_H = 7.5;
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

// Hinweis: Die frühere classifySleepConsistency wurde entfernt – ihr Ergebnis
// wurde nirgends angezeigt, und sie enthielt eine doppelte Streuungsberechnung
// (eine davon ungenutzt). Die Konsistenz-Einstufung auf dem Schlaf-Tab kommt
// aus consGrade(), das auf dem gewählten Zeitfenster arbeitet.

// ── Main Daily Recommendation Logic ───────────────────
// Returns {status, statusColor, badge, text, action}
// THRESHOLDS are centralised here so they're easy to adjust
const COACHING_THRESHOLDS = {
  hvDevGood:     5,   // HRV >5% above 30d baseline → good signal
  hvDevBad:     -10,  // HRV >10% below 30d baseline → bad signal
  hrDevGood:    -3,   // HR >3% below 30d baseline → good signal
  hrDevBad:      5,   // HR >5% above 30d baseline → bad signal
  sleepGoodH:    7.5, // ≥7.5h → good sleep
  sleepBadH:     6.0, // <6.0h → bad sleep
};
// Hinweis: getDailyRecommendation/_computeDailyRecommendation wurden entfernt –
// die Kachel "Heutige Empfehlung" auf der Uebersicht ist auf Wunsch weggefallen und
// war ihr einziger Aufrufer. COACHING_THRESHOLDS bleibt: die Belastungswarnung
// (detectWarningSignals) nutzt dieselben Schwellen weiter.

// ── Multi-signal Warning Logic ─────────────────────────
// Returns null or {signals:[], text}
// A warning triggers when ≥3 of the following signals are present simultaneously
function detectWarningSignals() { return _memo('warningSignals', _computeWarningSignals); }
function _computeWarningSignals() {
  const last = allData[allData.length-1];
  if (!last) return null;
  const bl30 = {
    hrv:   calculateBaseline('hrv',   30),
    hr:    calculateBaseline('restHR',30),
    sleep: calculateBaseline('sleepTotal',30)
  };
  const signals = [];
  // Sleep under target
  if (last.sleepTotal != null && last.sleepTotal < COACHING_THRESHOLDS.sleepBadH) signals.push('Schlafdauer unter Ziel');
  // HRV significantly below baseline
  const devHRV = calculateDeviation(last.hrv, bl30.hrv);
  if (devHRV != null && devHRV <= COACHING_THRESHOLDS.hvDevBad) signals.push('HRV unter Baseline');
  // HR significantly above baseline
  const devHR = calculateDeviation(last.restHR, bl30.hr);
  if (devHR != null && devHR >= COACHING_THRESHOLDS.hrDevBad) signals.push('Ruhepuls erhöht');

  if (signals.length < 3) return null;
  return {
    signals,
    text: `${signals.length} Signale deuten gleichzeitig auf erhöhte körperliche Belastung hin. Reduziere heute die Intensität und beobachte, ob sich die Werte morgen normalisieren.`
  };
}

// ── Pattern Insights (correlation-based text insights) ─
function generatePatternInsights() { return _memo('patternInsights', _computePatternInsights); }
function _computePatternInsights() {
  const insights = [];
  if (allData.length < 14) return insights;

  // Helper: build date → row lookup
  const byDate = {};
  allData.forEach(r => { byDate[r.date] = r; });
  // Nutzt addDays (lokale Zeitrechnung). Die frühere eigene Variante rechnete über
  // toISOString nach UTC um und lieferte in CH denselben statt des nächsten Tages.
  const nextDay = dateStr => addDays(dateStr, 1);
  // Helper: linear trend slope (positive = rising)
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

  // Insight 4: Training → HRV am Folgetag
  // Trainingstage aus dem Workout-Sheet – dieselbe Regel wie ueberall sonst in der App.
  // Frueher stand hier `r.runSpeed != null`, also ein Feld des Health-Sheets: Indoor-
  // Laeufe ohne GPS fehlten dadurch, obwohl sie als Training erfasst waren.
  const trainDates = new Set(Object.keys(workoutData).filter(d=>workoutData[d]?.durationMin>0));
  if (trainDates.size >= 5) {
    const afterTrain=[], afterRest=[];
    allData.forEach(r => {
      if (r.hrv==null) return;
      const prevStr = addDays(r.date, -1); // lokal, nicht über UTC (sonst zwei Tage zurück)
      if (trainDates.has(prevStr)) afterTrain.push(r);
      else if (byDate[prevStr]) afterRest.push(r);
    });
    const hvTrain = afterTrain.length>=3?mittel(afterTrain,'hrv'):null;
    const hvRest  = afterRest.length >=3?mittel(afterRest, 'hrv'):null;
    if (hvTrain&&hvRest) {
      const diff = Math.abs(hvTrain-hvRest).toFixed(0);
      if (diff >= 2) {
        if (hvTrain > hvRest)
          insights.push({icon:'🏋️',color:'#F97316',text:`Nach Trainingstagen ist deine HRV am Folgetag im Schnitt ${diff} ms höher als nach Ruhetagen – dein Körper erholt sich gut.`,hl:[{phrase:`${diff} ms höher`,c:'#10B981'},{phrase:'erholt sich gut',c:'#10B981'}],conf:'Training–HRV-Folgetag'});
        else
          insights.push({icon:'🏋️',color:'#F97316',text:`Nach Trainingstagen ist deine HRV am Folgetag im Schnitt ${diff} ms tiefer als nach Ruhetagen – ein normales Erholungszeichen.`,hl:[{phrase:`${diff} ms tiefer`,c:'#F97316'}],conf:'Training–HRV-Folgetag'});
      }
    }
  }

  // Insight 5: Training → Ruhepuls am Folgetag
  if (trainDates.size >= 5) {
    const afterTrainHR=[], afterRestHR=[];
    allData.forEach(r => {
      if (r.restHR==null) return;
      const prevStr = addDays(r.date, -1); // lokal, nicht über UTC (sonst zwei Tage zurück)
      if (trainDates.has(prevStr)) afterTrainHR.push(r);
      else if (byDate[prevStr]) afterRestHR.push(r);
    });
    const hrTrain = afterTrainHR.length>=3?mittel(afterTrainHR,'restHR'):null;
    const hrRest  = afterRestHR.length >=3?mittel(afterRestHR, 'restHR'):null;
    if (hrTrain&&hrRest&&hrTrain>hrRest+1.5) {
      const diff = (hrTrain-hrRest).toFixed(0);
      insights.push({icon:'💓',color:'#EF4444',text:`Nach Trainingstagen ist dein Ruhepuls am Folgetag im Schnitt ${diff} bpm erhöht – der Körper arbeitet an der Erholung.`,hl:[{phrase:`${diff} bpm erhöht`,c:'#F97316'}],conf:'Training–Ruhepuls-Folgetag'});
    }
  }

  // Insight 6: Schritte → Schlaf der Folgenacht
  const withStepsNextSleep = allData.filter(r => {
    const nd = byDate[nextDay(r.date)];
    return r.steps!=null && nd && nd.sleepTotal!=null;
  });
  if (withStepsNextSleep.length >= 10) {
    const median = [...withStepsNextSleep].sort((a,b)=>a.steps-b.steps)[Math.floor(withStepsNextSleep.length/2)].steps;
    const activeRows  = withStepsNextSleep.filter(r=>r.steps>=median);
    const inactiveRows= withStepsNextSleep.filter(r=>r.steps< median);
    const slActive  = mittel(activeRows.map(r=>byDate[nextDay(r.date)]).filter(Boolean), 'sleepTotal');
    const slInactive= mittel(inactiveRows.map(r=>byDate[nextDay(r.date)]).filter(Boolean), 'sleepTotal');
    if (slActive&&slInactive&&slActive>slInactive+0.2) {
      const diff = Math.round((slActive-slInactive)*60);
      insights.push({icon:'🌙',color:'#7C3AED',text:`An aktiveren Tagen (mehr Schritte) schläfst du in der Folgenacht im Schnitt ${diff} Minuten länger.`,hl:[{phrase:`${diff} Minuten länger`,c:'#10B981'}],conf:'Schritte–Schlaf-Zusammenhang'});
    }
  }

  // Insight 7: Schritte → HRV der Folgenacht
  const withStepsNextHRV = allData.filter(r => {
    const nd = byDate[nextDay(r.date)];
    return r.steps!=null && nd && nd.hrv!=null;
  });
  if (withStepsNextHRV.length >= 10) {
    const median7 = [...withStepsNextHRV].sort((a,b)=>a.steps-b.steps)[Math.floor(withStepsNextHRV.length/2)].steps;
    const hiRows = withStepsNextHRV.filter(r=>r.steps>=median7);
    const loRows = withStepsNextHRV.filter(r=>r.steps< median7);
    const hvHi = mittel(hiRows.map(r=>byDate[nextDay(r.date)]).filter(Boolean),'hrv');
    const hvLo = mittel(loRows.map(r=>byDate[nextDay(r.date)]).filter(Boolean),'hrv');
    if (hvHi&&hvLo&&Math.abs(hvHi-hvLo)>=2) {
      if (hvHi>hvLo) {
        const diff = ((hvHi-hvLo)/hvLo*100).toFixed(0);
        insights.push({icon:'💪',color:'#059669',text:`Nach aktiveren Tagen ist deine HRV in der Folgenacht im Schnitt ${diff}% höher – Bewegung fördert deine Herzgesundheit.`,hl:[{phrase:`${diff}% höher`,c:'#10B981'}],conf:'Schritte–HRV-Zusammenhang'});
      }
    }
  }

  // Insight 8: HRV-Trend 30 Tage
  const last30hrv = allData.slice(-30).filter(r=>r.hrv!=null);
  if (last30hrv.length >= 7) {
    const slope = linTrend(last30hrv, 'hrv');
    if (slope!=null && Math.abs(slope) >= 0.05) {
      const perWeek = (slope*7).toFixed(1);
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
      const perWeek = Math.abs(slope*7).toFixed(1);
      if (slope < 0)
        insights.push({icon:'📉',color:'#10B981',text:`Dein Ruhepuls sinkt: −${perWeek} bpm pro Woche über 30 Tage – ein klassisches Zeichen steigender Ausdauer.`,hl:[{phrase:'sinkt',c:'#10B981'},{phrase:'steigender Ausdauer',c:'#10B981'}],conf:'Ruhepuls-Trend 30 Tage'});
      else
        insights.push({icon:'📈',color:'#F97316',text:`Dein Ruhepuls steigt leicht: +${perWeek} bpm pro Woche über 30 Tage – mögliche Belastungs- oder Erholungszeichen.`,hl:[{phrase:'steigt leicht',c:'#F97316'}],conf:'Ruhepuls-Trend 30 Tage'});
    }
  }

  // Insight 10: VO₂max-Entwicklung
  const vo2Rows = allData.filter(r=>r.vo2max!=null);
  if (vo2Rows.length >= 5) {
    const slope = linTrend(vo2Rows, 'vo2max');
    const first = mittel(vo2Rows.slice(0, Math.ceil(vo2Rows.length/3)), 'vo2max');
    const last  = mittel(vo2Rows.slice(-Math.ceil(vo2Rows.length/3)), 'vo2max');
    if (first&&last&&Math.abs(last-first)>=0.5) {
      const diff = (last-first).toFixed(1);
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
// Steht als Zeilen in der App-Karte der Übersicht (früher im Tab-Titel — dort
// wiederholte sich dieselbe Angabe auf allen fünf Tabs).
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
  return statZeile('Daten bis', fmtDayShort(newest)+ageTxt, stale ? '#F59E0B' : null)
       + statZeile('Zuletzt geladen', loaded)
       // Stand der Anmeldung: eine Zeile, drei moegliche Werte. Der Text kommt aus
       // anmeldeStand() – frueher stand hier eine zweite, eigene Pruefung auf
       // `accessToken`, die den Fall „nur Lesen" gar nicht kannte und nach dem Umbau
       // dieselbe Zeile ein zweites Mal erzeugte.
       + (()=>{ const a = anmeldeStand();
           return statZeile('Google-Anmeldung', a.text, a.farbe); })();
}

function kpiCard({icon,label,value,unit,delta,deltaLabel,color,sub}={}) {
  const dir = delta==null?'neu':delta>0?'pos':'neg';
  const dStr = delta==null?'—':(delta>0?'↑':'↓')+' '+Math.abs(delta).toFixed(1)+'% '+(deltaLabel||trendLabel());
  return `<div class="kpi" style="border-top-color:${color||'transparent'}">
    <div class="kpi-hd"><span class="kpi-lbl">${label}</span>${icon?`<span class="kpi-ico">${icon}</span>`:''}</div>
    <div class="kpi-val">${value}<span class="kpi-unit">${unit||''}</span></div>
    <div class="kpi-delta ${dir}">${dStr}</div>
    ${sub?`<div class="kpi-sub">${sub}</div>`:''}
  </div>`;
}

// Hinweis: sparkSVG wurde entfernt – die Sparklines lebten ausschliesslich in der
// Trend-Karte der Uebersicht.



// ── Übersicht ──────────────────────────────────────────
function pgOverview() {
  // Last day + 7-day window for mini-cards
  const lastDay = allData[allData.length-1] || {};
  const priorDays = allData.slice(-8,-1); // 7 days before last
  const avg7d = {
    sleep: mittel(priorDays,'sleepTotal'),
    hr:    mittel(priorDays,'restHR'),
    hrv:   mittel(priorDays,'hrv'),
    vo2:   mittel(priorDays.filter(r=>r.vo2max),'vo2max')
  };

  // Belastungswarnung und Muster-Insights – vom Wegfall der Score-Karte unberührt.
  const warnSig = detectWarningSignals();
  const patternIns = generatePatternInsights();

  // Mini-card deltas (absolute vs 7-day avg)
  const slLast = lastDay.sleepTotal;
  const hrLast = lastDay.restHR;
  const hvLast = lastDay.hrv;


  // Verlaufs-Chart + Trend folgen jetzt dem globalen Zeitfilter (D = gewähltes Fenster).
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



  document.getElementById("screen-overview").innerHTML = `
    ${pgBanner('📊','Übersicht')}
    <!-- Warning signals (only shown when triggered). Steht ueber dem Kartenpaar:
         eine Warnung gehoert nach oben, und im Querformat stehen Ziele und Kacheln
         nebeneinander – dazwischen waere kein Platz fuer sie. -->
    ${warnSig ? `<div class="warn-card">
      <div>
        <div class="warn-title">Belastungssignal erkannt ${scopeBadge('letzter Tag')}</div>
        <div class="warn-text">${warnSig.text}</div>
        <div class="warn-signals">${warnSig.signals.map(s=>`<span class="warn-sig">${s}</span>`).join('')}</div>
      </div>
    </div>` : ''}
    <!-- Ziele und Tageswerte: im Hochformat untereinander, im Querformat nebeneinander. -->
    <div class="ov-oben">
    ${zielUebersichtHTML()}

    <!-- Aktuelle Tageswerte. Der Gesundheits-Score stand hier daneben und wurde
         auf Wunsch komplett entfernt; die Belastungswarnung oben bleibt. -->
      <!-- Aktuelle Tageswerte. Die frühere "Heutige Empfehlung" saß hier darüber und
           wurde auf Wunsch entfernt; die Belastungswarnung oben auf der Seite bleibt. -->
    <div class="ov-oben-kacheln">
    <div class="ov-combo-card">
        <!-- Die Bezugszeitraum-Pille ("letzter Tag · Vergleich: Ø 7 Tage") wurde auf
             Wunsch entfernt; die Kacheln tragen den Vergleich bereits im Text ("vs. Ø"). -->
        <div class="ti-metrics">
          ${hrLast!=null?`<div class="ti-metric" style="border-top:3px solid #EF4444;background:rgba(239,68,68,.05)">
            <div class="ti-metric-lbl">❤️ Ruhepuls ${infoMini('restHR')}</div>
            <div class="ti-metric-val">${Math.round(hrLast)} bpm</div>
            ${avg7d.hr!=null?`<div class="ti-metric-delta ${hrLast-avg7d.hr<-0.5?'pos':hrLast-avg7d.hr>0.5?'neg':'neu'}">${(()=>{const d=hrLast-avg7d.hr;return (d>=0?'+':'')+d.toFixed(0)+' vs. Ø';})()}</div>`:''}
          </div>`:'<div class="ti-metric"></div>'}
          ${hvLast!=null?`<div class="ti-metric" style="border-top:3px solid #2563EB;background:rgba(37,99,235,.05)">
            <div class="ti-metric-lbl">💙 HRV ${infoMini('hrv')}</div>
            <div class="ti-metric-val">${Math.round(hvLast)} ms</div>
            ${avg7d.hrv!=null?`<div class="ti-metric-delta ${hvLast-avg7d.hrv>0.5?'pos':hvLast-avg7d.hrv<-0.5?'neg':'neu'}">${(()=>{const d=hvLast-avg7d.hrv;return (d>=0?'+':'')+d.toFixed(0)+' vs. Ø';})()}</div>`:''}
          </div>`:'<div class="ti-metric"></div>'}
          ${slLast!=null?`<div class="ti-metric" style="border-top:3px solid #2186E8;background:rgba(33,134,232,.05)">
            <div class="ti-metric-lbl">🌙 Schlaf ${infoMini('sleepTotal')}</div>
            <div class="ti-metric-val">${alsStdMin(slLast)}</div>
            ${avg7d.sleep!=null?`<div class="ti-metric-delta ${slLast-avg7d.sleep>0.08?'pos':slLast-avg7d.sleep<-0.08?'neg':'neu'}">${(()=>{const d=slLast-avg7d.sleep;const m=Math.round(d*60);const sign=m>=0?'+':'-';const abs=Math.abs(m);if(abs>=60){const h=Math.floor(abs/60);const min=abs%60;return sign+h+'h '+String(min).padStart(2,'0')+'min vs. Ø';}return sign+abs+'m vs. Ø';})()}</div>`:''}
          </div>`:'<div class="ti-metric"></div>'}
          ${(()=>{
            const trMin=workoutData[lastDay.date]?.durationMin??null;
            const trAvg=(()=>{const v=priorDays.map(r=>workoutData[r.date]?.durationMin).filter(x=>x!=null);return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;})();
            if(trMin!=null){return`<div class="ti-metric" style="border-top:3px solid #F97316;background:rgba(249,115,22,.07)">
              <div class="ti-metric-lbl">🏃 Training ${infoMini('training')}</div>
              <div class="ti-metric-val">${Math.round(trMin)} min</div>
              ${trAvg!=null?`<div class="ti-metric-delta ${trMin-trAvg>2?'pos':trMin-trAvg<-2?'neu':'neu'}">${(()=>{const d=Math.round(trMin-trAvg);return(d>=0?'+':'')+d+' min vs. Ø';})()}</div>`:''}
            </div>`;}
            // Kein Training an diesem Tag: statt der Tagesdauer die Anzahl der
            // Trainingstage im Siebentagefenster – die Kachel bleibt damit beim
            // Thema Training. Die frueher hier stehenden Schritte sind auf Wunsch
            // ganz entfallen (auch als Zielmetrik).
            const tage7   = allData.slice(-7);
            const tage7v  = allData.slice(-14, -7);
            const zaehl   = rows => rows.filter(r => workoutData[r.date]?.durationMin > 0).length;
            const nWoche  = zaehl(tage7);
            const nVor    = tage7v.length >= 7 ? zaehl(tage7v) : null;
            return`<div class="ti-metric" style="border-top:3px solid #F97316;background:rgba(249,115,22,.07)">
              <div class="ti-metric-lbl">🏃 Trainings ${infoMini('trainWoche')}</div>
              <div class="ti-metric-val">${nWoche}<span class="ti-metric-einheit"> / 7 Tage</span></div>
              ${nVor!=null?`<div class="ti-metric-delta ${nWoche-nVor>0?'pos':nWoche-nVor<0?'neg':'neu'}">${(()=>{const d=nWoche-nVor;return(d>=0?'+':'')+d+' vs. Vorwoche';})()}</div>`:''}
            </div>`;
          })()}
        </div>
      </div>
    </div>
    </div>
    </div>
    <!-- Zeile 2: Verlauf (oberhalb des Trends) -->
    <div class="chart-card" style="margin-bottom:.7rem">
      <h3 style="margin-bottom:.35rem">Verlauf</h3>
      <div class="chart-legend" style="margin-bottom:.3rem">
        <div class="cl-item"><span class="cl-dot" style="background:#7C3AED"></span>Schlaf</div>
        <div class="cl-item"><span class="cl-dot" style="background:#EF4444"></span>Puls</div>
        <div class="cl-item"><span class="cl-dot" style="background:#2563EB"></span>HRV</div>
        <div class="cl-item"><span class="cl-dot" style="background:${_hasWoDur?'#F97316':'#059669'}"></span>${_hasWoDur?'Training':'Schritte'}</div>
      </div>
      <div class="chart-wrap" style="--h:360px"><canvas id="c-woche"></canvas></div>
    </div>

    <!-- Pattern Insights -->
    ${patternIns.length>0?`
    <div class="pi-grid" style="${_musterOffen?'':'display:none'}">
      ${patternIns.map(p=>{
        let txt=p.text;
        if(p.hl)p.hl.forEach(h=>{txt=txt.replace(h.phrase,`<span style="color:${h.c};font-weight:700">${h.phrase}</span>`);});
        return`<div class="pi-card" style="border-top-color:${p.color}">
        <div class="pi-head"><span class="pi-icon">${p.icon}</span><span class="pi-conf">${p.conf}</span></div>
        <div class="pi-text">${txt}</div>
      </div>`;}).join('')}
    </div>`:''}
    <!-- App-Version + Update: eine installierte PWA übernimmt einen neuen Stand sonst
         erst beim zweiten Start. Der Knopf holt ihn in einem Schritt.
         Hinter demselben Ausklapp-Knopf wie "Weitere Auswertungen" und
         "Muster & Zusammenhänge" – der Abschnitt wird selten gebraucht und muss
         nicht dauerhaft unter der Übersicht stehen. Der Knopf traegt den Namen,
         die Karte darunter deshalb keine eigene Überschrift mehr. -->
    <button type="button" class="weitere-btn" data-appklapp aria-expanded="${_appOffen?'true':'false'}">
      App<span class="weitere-pfeil">${_appOffen?'▾':'▸'}</span>
    </button>
    <div class="weitere-inhalt"${_appOffen?'':' hidden'}>
    <div class="chart-card app-karte">
      <div class="stats-list">
        ${datenStandZeilen()}
        ${statZeile('Installierte Version', '<span class="app-version">wird geprüft…</span>')}
      </div>
      ${(()=>{ const a = anmeldeStand();
        // Knopf und Erklaerung nur, wenn wirklich etwas zu tun ist – sonst staende hier
        // dauerhaft eine Handlungsaufforderung ohne Anlass.
        return a.hinweis ? `<button class="update-btn anmelde-btn">Mit Google anmelden</button>
        <div class="app-hinweis">${a.hinweis}</div>` : ''; })()}
      <button class="update-btn refresh-btn">Daten aktualisieren</button>
      <div class="app-hinweis">Liest Schlaf-, Herz- und Trainingsdaten neu aus den Google-Sheets. Nutze das, wenn heutige Werte noch fehlen.</div>
      <button class="update-btn appver-btn">App-Version aktualisieren</button>
      <div class="app-hinweis">Holt eine neue Fassung der App selbst. Ohne diesen Knopf greift ein Update erst, wenn du die App zweimal neu startest.</div>
    </div>
    </div>
    `;


  versionAnzeigen();   // asynchron, füllt .app-version nach

  // Verlaufs-Chart (folgt dem globalen Zeitfilter; Aggregation via timeDim)
  function _wocheTooltipLabel(ctx){
    const lbl=ctx.dataset.label, v=ctx.raw, agg=_wocheAgg;
    // Bei aggregierten Buckets (Wochen-/Monatswerte) ist der Wert ein Tagesmittel → "Ø …/d".
    const pre=agg?'Ø ':'', per=agg?'':'';
    if(lbl==='Schlaf (h)')return`${pre}Schlaf: ${v!=null?alsStdMin(v)+per:'—'}`;
    if(lbl===_wocheTrLabel){
      if(_hasWoDur){const mins=Math.round((v??0)*60);return`${pre}${_wocheTrLabel}: ${mins} min${per}`;}
      return`${pre}${_wocheTrLabel}: ${v!=null?Math.round(v).toLocaleString('de-CH')+per:'—'}`;
    }
    if(lbl==='Ruhepuls') return `${pre}Ruhepuls: ${v!=null?Math.round(v)+' bpm'+per:'—'}`;
    if(lbl==='HRV')      return `${pre}HRV: ${v!=null?Math.round(v)+' ms'+per:'—'}`;
    return lbl+': '+(v!=null?v.toFixed(1):'—');
  }
  if(wHas){
    zeichneDiagramm('c-woche',{__keys:wKeys,__keyTyp:wKeyTyp,
      data:{labels:wLabels,datasets:[
        {type:'bar',label:'Schlaf (h)',data:wSl,backgroundColor:'rgba(124,58,237,.35)',borderRadius:BALKEN_RADIUS,yAxisID:'yL'},
        {type:'line',label:'Ruhepuls',data:wHR,borderColor:'#EF4444',backgroundColor:'transparent',tension:.35,pointRadius:3,pointBackgroundColor:'#EF4444',yAxisID:'yR',spanGaps:true},
        {type:'line',label:'HRV',data:wHV,borderColor:'#2563EB',backgroundColor:'transparent',tension:.35,pointRadius:3,pointBackgroundColor:'#2563EB',yAxisID:'yR',spanGaps:true},
        {type:'line',label:_wocheTrLabel,data:wTr,borderColor:'#F97316',backgroundColor:'transparent',tension:.35,pointRadius:3,pointBackgroundColor:'#F97316',yAxisID:'yL',spanGaps:true}
      ]},
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,callbacks:{label:ctx=>_wocheTooltipLabel(ctx)}}},
        scales:{
          x:{...gx},
          yL:{position:'left',...gy,suggestedMin:0,suggestedMax:10,ticks:{...gy.ticks,callback:v=>Math.floor(v)+'h'}},
          yR:{position:'right',display:true,grid:{display:false},ticks:{color:'#94A3B8',font:{size:10}},suggestedMin:30,suggestedMax:100}
        }
      }
    });
  }
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
  // Konsistenz über die Streuung – dieselbe Idee wie beim Schlaf, aber mit Schwellen
  // in der jeweiligen Einheit. Ein gleichmässiger Ruhepuls bzw. eine gleichmässige
  // HRV spricht für stabile Erholung; starke Ausschläge für wechselnde Belastung.
  const konsistenz=(streuung,g1,g2,g3)=>{
    if(streuung==null)return['—','#94A3B8'];
    if(streuung<g1)return['Sehr konsistent','#10B981'];
    if(streuung<g2)return['Konsistent','#84CC16'];
    if(streuung<g3)return['Mäßig','#EAB308'];
    return['Schwankend','#EF4444'];
  };
  const [hrKons,hrKonsFarbe]=konsistenz(standardabw(hrf,'restHR'), 2, 3.5, 5);
  const [hvKons,hvKonsFarbe]=konsistenz(standardabw(hvf,'hrv'),    6, 10, 15);

  // HR zone classification
  function hrZone(v){
    if(v==null)return['—','#94A3B8'];
    if(v<50)return['Athleten-Bereich','#2563EB'];
    if(v<60)return['Sehr gut','#10B981'];
    if(v<70)return['Normal','#84CC16'];
    if(v<80)return['Leicht erhöht','#F97316'];
    return['Hoch','#EF4444'];
  }
  const [hrZoneName,hrZoneColor]=hrZone(hrD);

  // HRV interpretation
  function hvCat(v){
    if(v==null)return['—','#94A3B8'];
    if(v>=70)return['Sehr gut','#10B981'];
    if(v>=50)return['Gut','#84CC16'];
    if(v>=30)return['Mittel','#EAB308'];
    return['Niedrig','#EF4444'];
  }
  const [hvCatName,hvCatColor]=hvCat(hvD);

  // Days in zones
  const nAthlete=hrf.filter(r=>r.restHR<50).length;
  const nGood=hrf.filter(r=>r.restHR>=50&&r.restHR<65).length;
  const nNorm=hrf.filter(r=>r.restHR>=65&&r.restHR<75).length;
  const nHigh=hrf.filter(r=>r.restHR>=75).length;
  const nTot=hrf.length||1;
  // HRV categories
  const nHVLow=hvf.filter(r=>r.hrv<30).length;
  const nHVMid=hvf.filter(r=>r.hrv>=30&&r.hrv<50).length;
  const nHVGood=hvf.filter(r=>r.hrv>=50&&r.hrv<70).length;
  const nHVHigh=hvf.filter(r=>r.hrv>=70).length;
  const nHVTot=hvf.length||1;

  const bl30hrv = calculateBaseline('hrv', 30);
  const bl30hr  = calculateBaseline('restHR', 30);
  const lastRow  = allData[allData.length-1] || {};
  const devHRVhz = calculateDeviation(lastRow.hrv, bl30hrv);
  const devHRhz  = calculateDeviation(lastRow.restHR, bl30hr);
  const herzInterpret = (() => {
    if (devHRVhz==null&&devHRhz==null) return null;
    const hvGood = devHRVhz!=null&&devHRVhz>=5;
    const hvBad  = devHRVhz!=null&&devHRVhz<=-10;
    const hrGood = devHRhz!=null&&devHRhz<=-3;
    const hrBad  = devHRhz!=null&&devHRhz>=5;
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

  const {labels:tL,align:tA,hasData:tHD,keys:tKeys,keyTyp:tKeyTyp}=timeDim(D);
  const tdL=timeDim(D,true);
  const hrMaL=tdL.align('restHR'); const hvMaL=tdL.align('hrv');

  document.getElementById("screen-herz").innerHTML=`
    ${pgBanner('❤️','Herz')}
    <div class="chart-card">
      <h3>Ruhepuls &amp; HRV</h3>
      <div class="chart-legend">
        <div class="cl-item"><span class="cl-line" style="background:var(--heart)"></span>Puls</div>
        <div class="cl-item"><span class="cl-line" style="background:var(--hrv)"></span>HRV</div>
      </div>
      <div class="chart-wrap" style="--h:315px"><canvas id="c-herz"></canvas></div>
      <!-- Beide Reihen pro Zeile, immer in der Reihenfolge der Legende: erst Puls,
           dann HRV. Die Einheiten halten sie auseinander. Getrennte Zeilen je Reihe
           waeren acht Stueck und damit laenger als das Diagramm darueber. -->
      <div class="stats-list diagramm-fuss">
        ${statZeile(`Durchschnitt`, `${hrD!=null?zahl(hrD,0)+' bpm':'—'} | ${hvD!=null?zahl(hvD,0)+' ms':'—'}`)}
        ${statZeile(`Ø Wochentag (Mo–Fr)`, `${hrWeek!=null?zahl(hrWeek,0)+' bpm':'—'} | ${hvWeek!=null?zahl(hvWeek,0)+' ms':'—'}`)}
        ${statZeile(`Ø Wochenende (Sa–So)`, `${hrWknd!=null?zahl(hrWknd,0)+' bpm':'—'} | ${hvWknd!=null?zahl(hvWknd,0)+' ms':'—'}`)}
        ${statZeile(`Differenz`, `${hrWeek!=null&&hrWknd!=null?(hrWknd<hrWeek?'':'+')+zahl(hrWknd-hrWeek,0)+' bpm':'—'} | ${hvWeek!=null&&hvWknd!=null?(hvWknd>hvWeek?'+':'')+zahl(hvWknd-hvWeek,0)+' ms':'—'}`)}
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
          <div class="goal-row"><span class="goal-lbl" style="color:#10B981">&lt; 50 bpm</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nAthlete/nTot*100}%;background:#10B981"></div></div><span class="goal-val"><span class="goal-num">${nAthlete}</span><span style="color:var(--txt3)">(${(nAthlete/nTot*100).toFixed(0)}%)</span></span></div>
          <div class="goal-row"><span class="goal-lbl" style="color:#84CC16">50–65 bpm</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nGood/nTot*100}%;background:#84CC16"></div></div><span class="goal-val"><span class="goal-num">${nGood}</span><span style="color:var(--txt3)">(${(nGood/nTot*100).toFixed(0)}%)</span></span></div>
          <div class="goal-row"><span class="goal-lbl" style="color:#EAB308">65–75 bpm</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nNorm/nTot*100}%;background:#EAB308"></div></div><span class="goal-val"><span class="goal-num">${nNorm}</span><span style="color:var(--txt3)">(${(nNorm/nTot*100).toFixed(0)}%)</span></span></div>
          <div class="goal-row"><span class="goal-lbl" style="color:#EF4444">&gt; 75 bpm</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nHigh/nTot*100}%;background:#EF4444"></div></div><span class="goal-val"><span class="goal-num">${nHigh}</span><span style="color:var(--txt3)">(${(nHigh/nTot*100).toFixed(0)}%)</span></span></div>
        </div>
        <div class="stats-list">
          ${statZeile(`Bester Tag`, `${hrBest!=null?zahl(hrBest,0)+' bpm':'—'}`, `#10B981`)}
          ${statZeile(`Schlechtester Tag`, `${hrSchlecht!=null?zahl(hrSchlecht,0)+' bpm':'—'}`, `#EF4444`)}
          ${statZeile(`Konsistenz`, `${hrKons}`, `${hrKonsFarbe}`)}
          ${statZeile(`Messpunkte`, `${hrf.length}d <span style="color:var(--txt3)">(${D.length>0?(hrf.length/D.length*100).toFixed(0):'—'}%)</span>`)}
        </div>
      </div>
      <div class="chart-card split2" style="margin-bottom:0">
        <h3>HRV-Einordnung ${infoI('hrv')}</h3>
        <p class="split2-sub">
          Ø ${zahl(hvD,0)} ms → <span style="color:${hvCatColor};font-weight:700">${hvCatName}</span>
        </p>
        <div class="goal-list">
          <div class="goal-row"><span class="goal-lbl" style="color:#10B981">≥ 70 ms</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nHVHigh/nHVTot*100}%;background:#10B981"></div></div><span class="goal-val"><span class="goal-num">${nHVHigh}</span><span style="color:var(--txt3)">(${(nHVHigh/nHVTot*100).toFixed(0)}%)</span></span></div>
          <div class="goal-row"><span class="goal-lbl" style="color:#84CC16">50–70 ms</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nHVGood/nHVTot*100}%;background:#84CC16"></div></div><span class="goal-val"><span class="goal-num">${nHVGood}</span><span style="color:var(--txt3)">(${(nHVGood/nHVTot*100).toFixed(0)}%)</span></span></div>
          <div class="goal-row"><span class="goal-lbl" style="color:#EAB308">30–50 ms</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nHVMid/nHVTot*100}%;background:#EAB308"></div></div><span class="goal-val"><span class="goal-num">${nHVMid}</span><span style="color:var(--txt3)">(${(nHVMid/nHVTot*100).toFixed(0)}%)</span></span></div>
          <div class="goal-row"><span class="goal-lbl" style="color:#EF4444">&lt; 30 ms</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nHVLow/nHVTot*100}%;background:#EF4444"></div></div><span class="goal-val"><span class="goal-num">${nHVLow}</span><span style="color:var(--txt3)">(${(nHVLow/nHVTot*100).toFixed(0)}%)</span></span></div>
        </div>
        <div class="stats-list">
          ${statZeile(`Bester Tag`, `${hvBest!=null?zahl(hvBest,0)+' ms':'—'}`, `#10B981`)}
          ${statZeile(`Schlechtester Tag`, `${hvSchlecht!=null?zahl(hvSchlecht,0)+' ms':'—'}`, `#EF4444`)}
          ${statZeile(`Konsistenz`, `${hvKons}`, `${hvKonsFarbe}`)}
          ${statZeile(`Messpunkte`, `${hvf.length}d <span style="color:var(--txt3)">(${D.length>0?(hvf.length/D.length*100).toFixed(0):'—'}%)</span>`)}
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
    zeichneDiagramm('c-herz',{__keys:tdL.keys,__keyTyp:tdL.keyTyp,type:'line',data:{labels:tdL.labels,datasets:[
      {label:'Ruhepuls',data:hrMaL,borderColor:'#EF4444',backgroundColor:'rgba(239,68,68,.07)',tension:.3,fill:true,pointRadius:3,spanGaps:true,yAxisID:'yL'},
      {label:'HRV',data:hvMaL,borderColor:'#2563EB',backgroundColor:'rgba(37,99,235,.07)',tension:.3,fill:true,pointRadius:3,spanGaps:true,yAxisID:'yR'},
      // Ø-Linien in der Farbe ihrer Reihe statt der beiden grauen Ziellinien: bei zwei
      // Kurven auf einer Skala liessen sich zwei gleich graue Hilfslinien nicht
      // zuordnen. Die Zielwerte stehen in der Statuszeile der Übersicht.
      {label:'Ø Ruhepuls',data:hrMaL.map(()=>hrD),borderColor:'#EF4444',borderDash:[5,4],
       pointRadius:0,borderWidth:1.5,tension:0,fill:false,yAxisID:'yL'},
      {label:'Ø HRV',data:hvMaL.map(()=>hvD),borderColor:'#2563EB',borderDash:[5,4],
       pointRadius:0,borderWidth:1.5,tension:0,fill:false,yAxisID:'yR'}
    ]},options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,
        filter:item=>item.dataset.label==='Ruhepuls'||item.dataset.label==='HRV',
        // Ganze Zahlen mit Einheit: Nachkommastellen sind hier Scheingenauigkeit,
        // und ohne Einheit sind die beiden Reihen (bpm vs. ms) nicht auseinander-
        // zuhalten – sie teilen sich im Diagramm eine Skala.
        callbacks:{label:ctx=>ctx.parsed.y==null?null:
          `${ctx.dataset.label}: ${Math.round(ctx.parsed.y)} ${ctx.dataset.label==='Ruhepuls'?'bpm':'ms'}`}}},
      scales:{x:gx,
        yL:_yAxis({position:'left',grid:{color:GRID_COLOR}}),
        // Rechte Achse ausgeblendet: sie ist mit der linken synchronisiert und zeigte
        // exakt dieselben Zahlen – auf dem iPhone verschenkte Breite ohne Aussage.
        yR:_yAxis({position:'right',display:false,grid:{display:false}})}}});
  }
}

// Welche Reihen des Vergleichsdiagramms sind eingeblendet? Ueberlebt Re-Render und
// Tabwechsel – sonst waere die Auswahl nach jedem Klick auf die Zeitpfeile zurueck.
let _kombiAktiv = { zeit:true, hr:false, strecke:true, pace:false };
// Muster-Abschnitt der Übersicht: auf- oder zugeklappt. Startet offen, damit sich
// beim ersten Öffnen nichts versteckt.
let _musterOffen = true;
// App-Karte: startet zu, wie die uebrigen Ausklapp-Abschnitte.
let _appOffen = false;
// Herz und Schlaf zeigen zunaechst nur ihr erstes Diagramm; alles Weitere liegt
// hinter einem Knopf. Standardmaessig zu, damit der Tab beim Oeffnen ruhig bleibt.
const _weitereOffen = { herz:false, schlaf:false };
// Knopf + oeffnendes <div>. Der schliessende Tag steht im Markup, damit die Karten
// dazwischen unveraendert bleiben – ein String-Parameter haette die Template-Literale
// der Karten verschachtelt und war nicht sauber zu escapen.
// Nur noch das oeffnende <div>; der Schalter sitzt seit 03.09.2026 als Knopf in der
// Kopfzeile des Tabs (pgBanner) statt als breiter Balken mitten im Inhalt.
function weitereAuf(tab) {
  return `<div class="weitere-inhalt"${_weitereOffen[tab] ? '' : ' hidden'}>`;
}

// Welche Tabs haben ueberhaupt etwas zum Aufklappen – und wie heisst es?
// EINE Quelle fuer Knopf, Zustand und Umschalten; sonst muesste jede der drei
// Stellen ihre eigene Fallunterscheidung fuehren.
const AUSKLAPP = {
  overview: { titel: 'Muster & Zusammenhänge', offen: () => _musterOffen,
              um: () => { _musterOffen = !_musterOffen; } },
  herz:     { titel: 'Weitere Auswertungen',   offen: () => _weitereOffen.herz,
              um: () => { _weitereOffen.herz = !_weitereOffen.herz; } },
  schlaf:   { titel: 'Weitere Auswertungen',   offen: () => _weitereOffen.schlaf,
              um: () => { _weitereOffen.schlaf = !_weitereOffen.schlaf; } }
};

// ── Schlaf ─────────────────────────────────────────────
function pgSchlaf() {
  const D=filtered(), P=prevPeriod();
  const last14sl = allData.slice(-14);
  const sleepDebt = calculateSleepDebt(last14sl);
  const debtLvl = sleepDebtLevel(sleepDebt.perNight);
  const slD=mittel(D,'sleepTotal');
  const scD=mittel(D,'sleepScore'), scP=mittel(P,'sleepScore');
  const dpD=mittel(D,'sleepDeep')||mittel(D,'deepSleep');
  const remD=mittel(D,'sleepRem')||mittel(D,'remSleep');
  const lD=mittel(D,'sleepCore')||mittel(D,'lightSleep');
  const slStd=standardabw(D.filter(r=>r.sleepTotal!=null),'sleepTotal');
  const slRows=D.filter(r=>r.sleepTotal!=null);
  const slZielN = slRows.filter(r=>zielErfuellt('sleepTotal', r.sleepTotal)).length;
  const slMax=slRows.length?Math.max(...slRows.map(r=>r.sleepTotal)):null;
  const slMin=slRows.length?Math.min(...slRows.map(r=>r.sleepTotal)):null;
  // Per-night breakdown for sleep debt tooltip
  const WDAYS=['So','Mo','Di','Mi','Do','Fr','Sa'];
  const debtTooltipRows=last14sl.filter(r=>r.sleepTotal!=null).map(r=>{
    const d=SLEEP_TARGET_H-r.sleepTotal;
    const [,mo,dy]=r.date.split('-');   // Jahr wird hier nicht gebraucht
    const wd=WDAYS[new Date(r.date+'T00:00:00').getDay()];
    return `<div class="debt-tt-row"><span class="debt-tt-date">${wd} ${dy}.${mo}.</span><span class="debt-tt-slept">${alsStdMin(r.sleepTotal)}</span><span class="debt-tt-d ${d>0?'neg':'pos'}">${d>0?'-'+alsStdMin(d):'+'+alsStdMin(-d)}</span></div>`;
  }).join('');
  const debtTtNDays=last14sl.filter(r=>r.sleepTotal!=null).length;
  const {labels:tL,align:tA,hasData:tHD,keys:tKeys,keyTyp:tKeyTyp}=timeDim(D);
  const tdL=timeDim(D,true);
  const slMa=tA('sleepTotal');
  const dpField=D.some(r=>r.sleepDeep!=null)?'sleepDeep':'deepSleep';
  const remField=D.some(r=>r.sleepRem!=null)?'sleepRem':'remSleep';
  const lField=D.some(r=>r.sleepCore!=null)?'sleepCore':'lightSleep';
  const dpMa=tA(dpField);
  const remMa=tA(remField);
  const lMa=tA(lField);
  const awMa=tA('sleepAwake');
  const scMa=tdL.align('sleepScore');
  const hasPhases=D.some(r=>r.sleepDeep!=null||r.deepSleep!=null||r.sleepRem!=null||r.remSleep!=null||r.sleepCore!=null||r.lightSleep!=null);
  const hasAwake=D.some(r=>r.sleepAwake!=null);
  const hasScore=D.some(r=>r.sleepScore!=null);
  const awD=mittel(D.filter(r=>r.sleepAwake!=null),'sleepAwake');

  const total=slD||1;
  const dpPct=dpD!=null?(dpD/total*100).toFixed(0):null;
  const remPct=remD!=null?(remD/total*100).toFixed(0):null;
  const lPct=lD!=null?(lD/total*100).toFixed(0):null;
  const awPct=awD!=null?(awD/total*100).toFixed(0):null;

  // Sleep quality buckets
  const nBelow6=D.filter(r=>r.sleepTotal!=null&&r.sleepTotal<6).length;
  const n6to7=D.filter(r=>r.sleepTotal!=null&&r.sleepTotal>=6&&r.sleepTotal<7).length;
  const n7to85=D.filter(r=>r.sleepTotal!=null&&r.sleepTotal>=7&&r.sleepTotal<8.5).length;
  const nOver85=D.filter(r=>r.sleepTotal!=null&&r.sleepTotal>=8.5).length;
  const nTot=nBelow6+n6to7+n7to85+nOver85||1;

  // Weekday vs weekend sleep
  const slSplit=splitWeekWknd(slRows);
  const slWeek=mittel(slSplit.wkd,'sleepTotal');
  const slWknd=mittel(slSplit.wknd,'sleepTotal');

  // Consistency grade
  function consGrade(s){
    if(s==null)return['—','#94A3B8'];
    if(s<0.5)return['Sehr konsistent','#10B981'];
    if(s<0.75)return['Konsistent','#84CC16'];
    if(s<1.0)return['Mäßig','#EAB308'];
    return['Inkonsistent','#EF4444'];
  }
  const [consLabel,consColor]=consGrade(slStd);

  // Sleep timing (onset & wake)
  const sleepStartField=findAnyField(D,'sleepStart','sleepOnset','bedtime','inBedStart','sleepBegin','asleepAt','sleepTime','startSleep');
  const sleepEndField=findAnyField(D,'sleepEnd','wakeTime','wakeUp','wakeAt','inBedEnd','sleepStop','wokenAt','endSleep');

  // Timing arrays aligned to tL for tooltip use in c-sl-dur
  const slStartArr=(()=>{
    if(is7D()){const days=weekDays7();const bd={};D.forEach(r=>{bd[r.date]=r;});return days.map(d=>parseTV(bd[d]?.[sleepStartField]??null));}
    const mos=allMonths(D);
    return mos.map(mo=>{const moR=D.filter(r=>r.date.startsWith(mo));return avgCircTime(moR,sleepStartField,true);});
  })();
  const slEndArr=(()=>{
    if(is7D()){const days=weekDays7();const bd={};D.forEach(r=>{bd[r.date]=r;});return days.map(d=>parseTV(bd[d]?.[sleepEndField]??null));}
    const mos=allMonths(D);
    return mos.map(mo=>{const moR=D.filter(r=>r.date.startsWith(mo));return avgCircTime(moR,sleepEndField,false);});
  })();

  document.getElementById("screen-schlaf").innerHTML=`
    ${pgBanner('🌙','Schlaf')}
    ${hasScore?`<div class="kpi-grid kpi-grid-1">${kpiCard({icon:'',label:'Ø Schlaf-Score',value:zahl(scD,0),unit:'',delta:prozentDiff(scD,scP),color:'var(--sleep)'})}</div>`:''}

      <div class="chart-card">
        <h3>${is7D()?'Schlafdauer letzte 7 Tage':'Schlafdauer pro Monat'}</h3>
        <div class="chart-legend" style="margin-bottom:.3rem">
          <div class="cl-item"><span class="cl-dot" style="background:rgba(124,58,237,.85)"></span>erreicht</div>
          <div class="cl-item"><span class="cl-dot" style="background:rgba(124,58,237,.32)"></span>verfehlt</div>
          <div class="cl-item"><span class="cl-line" style="background:#10B981"></span>Ziel</div>
          <div class="cl-item"><span class="cl-line cl-strich" style="color:rgba(124,58,237,.85)"></span>Ø</div>
        </div>
        <div class="chart-wrap" style="--h:279px"><canvas id="c-sl-dur"></canvas></div>
        ${slRows.length>0||slWeek!=null||slWknd!=null?`<div class="stats-list diagramm-fuss">
          ${slRows.length>0?`${statZeile(`Schlafziel (${alsStdMin(ZIELE.sleepTotal.ziel)}) erreicht`, `${slZielN} <span style="color:var(--txt3)">von ${slRows.length} (${Math.round(slZielN/slRows.length*100)}%)</span>`, slZielN>0?'#10B981':null)}`:''}
          ${statZeile(`Ø Schlafdauer`, `${slD!=null?alsStdMin(slD):'—'}`)}
          ${statZeile(`Ø Wochentag (Mo–Fr)`, `${slWeek!=null?alsStdMin(slWeek)+'':'—'}`)}
          ${statZeile(`Ø Wochenende (Sa–So)`, `${slWknd!=null?alsStdMin(slWknd)+'':'—'}`)}
          ${slWeek!=null&&slWknd!=null?`${statZeile(`Differenz`, `${(()=>{const d=slWknd-slWeek,a=Math.abs(d),s=d>=0?'+':'−',m=Math.round(a*60);return m<60?s+m+' min':s+Math.floor(a)+'h'+(Math.round((a%1)*60)>0?' '+Math.round((a%1)*60)+'min':'');})()}`)}
`:``}
        </div>`:''}
      </div>

      ${weitereAuf('schlaf')}
      <div class="chart-card split2">
        <h3>Schlafqualität-Verteilung</h3>
        <div class="goal-list">
          <div class="goal-row"><span class="goal-lbl" style="color:#10B981">&gt; 8.5h</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nOver85/nTot*100}%;background:#10B981"></div></div><span class="goal-val"><span class="goal-num">${nOver85}</span><span style="color:var(--txt3)">(${(nOver85/nTot*100).toFixed(0)}%)</span></span></div>
          <div class="goal-row"><span class="goal-lbl" style="color:#84CC16">7 – 8.5h</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${n7to85/nTot*100}%;background:#84CC16"></div></div><span class="goal-val"><span class="goal-num">${n7to85}</span><span style="color:var(--txt3)">(${(n7to85/nTot*100).toFixed(0)}%)</span></span></div>
          <div class="goal-row"><span class="goal-lbl" style="color:#EAB308">6 – 7h</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${n6to7/nTot*100}%;background:#EAB308"></div></div><span class="goal-val"><span class="goal-num">${n6to7}</span><span style="color:var(--txt3)">(${(n6to7/nTot*100).toFixed(0)}%)</span></span></div>
          <div class="goal-row"><span class="goal-lbl" style="color:#EF4444">≤ 6h</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nBelow6/nTot*100}%;background:#EF4444"></div></div><span class="goal-val"><span class="goal-num">${nBelow6}</span><span style="color:var(--txt3)">(${(nBelow6/nTot*100).toFixed(0)}%)</span></span></div>
        </div>
        <div class="stats-list">
          ${statZeile(`Beste Nacht`, `${alsStdMin(slMax)}`, `#10B981`)}
          ${statZeile(`Kürzeste Nacht`, `${alsStdMin(slMin)}`, `#EF4444`)}
          ${statZeile(`Konsistenz`, `${consLabel}`, `${consColor}`)}
          ${statZeile(`Messpunkte`, `${slRows.length}d <span style="color:var(--txt3)">(${D.length>0?(slRows.length/D.length*100).toFixed(0):'—'}%)</span>`)}
        </div>
      </div>

      <div class="chart-card">
        <div class="chart-head"><h3>Schlafschuld</h3>${scopeBadge('letzte 14 Nächte')}</div>
        <div class="stats-list">
          ${statZeile(`Zielschlaf pro Nacht`, `${alsStdMin(SLEEP_TARGET_H)}`)}
          ${statZeile(`Letzte Nacht`, `${sleepDebt.last!=null?(sleepDebt.last>0?'−'+alsStdMin(sleepDebt.last):'+'+alsStdMin(-sleepDebt.last)):'—'}`, `${sleepDebt.last!=null?(sleepDebt.last>0?'#EF4444':'#10B981'):'var(--txt3)'}`)}
          ${statZeile(`Ø pro Nacht`, `${sleepDebt.perNight!=null?(sleepDebt.perNight>0?'−'+alsStdMin(sleepDebt.perNight):'+'+alsStdMin(-sleepDebt.perNight)):'—'}`, `${debtLvl.color}`)}
          ${statZeile(`Summe über ${sleepDebt.nDays} Nächte`, `${sleepDebt.total!=null?(sleepDebt.total>0?'−'+alsStdMin(sleepDebt.total):'+'+alsStdMin(-sleepDebt.total)):'—'}`, `${sleepDebt.total!=null?(sleepDebt.total>0?'#EF4444':'#10B981'):'var(--txt3)'}`)}
        </div>
        <div class="debt-bar-wrap">
          ${sleepDebt.perNight!=null?`<div style="font-size:.66rem;color:var(--txt3);margin-bottom:.3rem">${debtLvl.label} · Balken voll bei Ø ${alsStdMin(SLEEP_DEBT_FULL_BAR_H)} Defizit pro Nacht</div>
          <div class="debt-tt-wrap" tabindex="0" role="button" aria-label="Zusammensetzung der Schlafschuld anzeigen">
            <div class="debt-bar-bg"><div class="debt-bar-fill" style="width:${Math.min(100,Math.max(0,(sleepDebt.perNight/SLEEP_DEBT_FULL_BAR_H)*100))}%;background:${debtLvl.color}"></div></div>
            <div class="debt-tt">
              <div class="debt-tt-title">Zusammensetzung – ${debtTtNDays} Nächte · Ziel ${alsStdMin(SLEEP_TARGET_H)}/Nacht</div>
              <div class="debt-tt-hd"><span>Datum</span><span>Geschlafen</span><span style="text-align:right">Schuld / Plus</span></div>
              ${debtTooltipRows}
            </div>
          </div>`:''}
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
      <div class="chart-wrap" style="--h:270px"><canvas id="c-sl-phases"></canvas></div>
      ${awD!=null||remD!=null||lD!=null||dpD!=null?`<div class="stats-list diagramm-fuss">
        ${awD!=null?`${statZeile(`Ø Wach`, `${alsStdMin(awD)} – ${awPct}%`)}`:''}
        ${remD!=null?`${statZeile(`Ø REM-Schlaf`, `${alsStdMin(remD)} – <span style="color:${parseInt(remPct)>=20?'#10B981':'#F97316'}">${remPct}%</span> <span style="color:var(--txt3)">(Ziel 20–25%)</span>`)}`:''}
        ${lD!=null?`${statZeile(`Ø Leichtschlaf`, `${alsStdMin(lD)} – ${lPct}%`)}`:''}
        ${dpD!=null?`${statZeile(`Ø Tiefschlaf`, `${alsStdMin(dpD)} – <span style="color:${parseInt(dpPct)>=15?'#10B981':'#F97316'}">${dpPct}%</span> <span style="color:var(--txt3)">(Ziel 15–20%)</span>`)}`:''}
      </div>`:''}
    </div>`:''}


    ${hasScore?`<div class="chart-card"><h3>Schlaf-Score Verlauf</h3><div class="chart-wrap" style="--h:225px"><canvas id="c-sl-score"></canvas></div></div>`:''}
    </div>`;


  if(tHD){
    // Y-Achse flexibel: nicht ab 0, sondern an den Datenbereich angeschmiegt, damit
    // die Variation zwischen den Nächten sichtbar wird (Schritt = 1 Std.).
    const _slV=slMa.filter(v=>v!=null);
    const _slY={...gy,ticks:{...gy.ticks,stepSize:1,callback:v=>Math.floor(v)+'h'}};
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
    zeichneDiagramm('c-sl-dur',{__keys:tKeys,__keyTyp:tKeyTyp,type:'bar',data:{labels:tL,datasets:[
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
      {label:'Ziel Schlaf',data:tL.map(()=>_slZiel),borderColor:'#10B981',borderWidth:1.5,
       pointRadius:0,tension:0,fill:false,type:'line',spanGaps:true,stack:'ziel'},
      // Ø gestrichelt in der Farbe der Balken.
      ...(slD!=null?[{label:'Ø Schlafdauer',data:tL.map(()=>slD),borderColor:'rgba(124,58,237,.85)',
       borderDash:[5,4],borderWidth:1.5,pointRadius:0,tension:0,fill:false,type:'line',
       spanGaps:true,stack:'ziel-avg'}]:[])
    ]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>{
        // Der Balken ist aus zwei Segmenten aufgebaut, gemeint ist aber EINE Nacht:
        // nur das untere Segment beschriften, und zwar mit der Gesamtdauer.
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
      }}}},scales:{x:{...gx,stacked:true},y:{..._slY,stacked:true}}}});
    if(hasPhases){
      const _phDs=[
        {label:'Tiefschlaf',data:dpMa,backgroundColor:'#1E1B6E',borderRadius:BALKEN_RADIUS,stack:'s'},
        {label:'Leichtschlaf',data:lMa,backgroundColor:'#2186E8',borderRadius:BALKEN_RADIUS,stack:'s'},
        {label:'REM',data:remMa,backgroundColor:'#5BC8FA',borderRadius:BALKEN_RADIUS,stack:'s'}
      ];
      if(hasAwake) _phDs.push({label:'Wach',data:awMa,backgroundColor:'#F97316',borderRadius:BALKEN_RADIUS,stack:'s'});
      zeichneDiagramm('c-sl-phases',{__keys:tKeys,__keyTyp:tKeyTyp,type:'bar',data:{labels:tL,datasets:_phDs},options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,itemSort:(a,b)=>b.datasetIndex-a.datasetIndex,callbacks:{
          label:ctx=>{
            if(ctx.raw==null)return null;
            const total=ctx.chart.data.datasets.reduce((s,ds)=>s+(ds.data[ctx.dataIndex]??0),0);
            const prozentDiff=total>0?Math.round(ctx.raw/total*100):0;
            return `${ctx.dataset.label}: ${alsStdMin(ctx.raw)} (${prozentDiff}%)`;
          }
        }}},
        scales:{x:{...gx,stacked:true},y:{...gy,stacked:true,ticks:{...gy.ticks,callback:v=>Math.floor(v)+'h'}}}}});
    }
    if(hasScore) zeichneDiagramm('c-sl-score',{__keys:tdL.keys,__keyTyp:tdL.keyTyp,type:'line',data:{labels:tdL.labels,datasets:[{data:scMa,borderColor:'#7C3AED',backgroundColor:'rgba(124,58,237,.08)',tension:.3,fill:true,pointRadius:3}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:gx,y:{...gy,min:0,max:100}}}});
  }
}

// ── Training ───────────────────────────────────────────
async function pgTraining() {
  const D=filtered(), P=prevPeriod();

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
        <div class="field-hint" style="margin-top:.4rem">Quelle: <code>Workout Data</code>-Google-Sheet. Erneut versuchen mit „Daten aktualisieren" in der App-Karte der Übersicht.</div>
      </div>`;
    return;
  }

  // ── Vergleichsdiagramm: vier Reihen, per Legende ein- und ausblendbar ──
  // Achsenpaare nach Groessenordnung: links Minuten und bpm, rechts Kilometer und
  // Pace. Ohne diese Paarung waere jede Reihe neben dem Puls (120-180) eine flache
  // Linie am unteren Rand.
  const KOMBI_REIHEN = [
    {id:'zeit',    label:'Zeit',    farbe:'#F97316', achse:'yL', typ:'bar',
     fmt:v=>fmtMin(v),            summierbar:true},
    {id:'hr',      label:'Puls',    farbe:'#EF4444', achse:'yL', typ:'line',
     fmt:v=>Math.round(v)+' bpm', summierbar:false},
    // Nicht das Orange des Laufstrecke-Diagramms: neben der orangen Zeitreihe waeren
    // die beiden hier kaum auseinanderzuhalten. Teal steht deutlich gegen Orange,
    // Rot und Violett.
    {id:'strecke', label:'Strecke', farbe:'#0891B2', achse:'yR', typ:'line',
     fmt:v=>zahl(v,2)+' km',      summierbar:true},
    {id:'pace',    label:'Pace',    farbe:'#7C3AED', achse:'yR', typ:'line',
     fmt:v=>fmtPace(v)+' min/km', summierbar:false}
  ];

  // ── Trainingstage im aktuellen Filterzeitraum ──
  // Quelle ist ausschließlich das Workout-Sheet (workoutData).
  const _healthDates=new Set(D.map(r=>r.date));
  const trainDates=Object.keys(workoutData).filter(d=>_healthDates.has(d)).sort();
  // Workout rows for current period (with HR data)
  const wRows=trainDates.map(d=>workoutData[d]).filter(w=>w!=null);

  // ── Workout stats ──
  const woDist=wRows.filter(w=>w.distanceKm!=null);

  // Chart data for Leistungs-Trend (per training day, chronological)
  const trendDates=trainDates.slice().sort();
  const trendLabels=trendDates.map(tagLabel);   // je Trainingstag: Wochentag + Datum
  const trendDist=trendDates.map(d=>(workoutData[d]?.distanceKm??null));
  const trendHR=trendDates.map(d=>(workoutData[d]?.avgHR??null));
  // Very broad field detection
  // minField removed – durationMin comes exclusively from Workout Data sheet (workoutData)

  // New chart data — durationMin + distanceKm from CSV workout files
  // Pace ausschliesslich aus `Speed (km/h)` des Workout-Sheets (Wunsch 05.09.2026).
  // Damit stammen Strecke UND Pace aus derselben Messung – vorher kam die Strecke aus
  // dem Workout-Sheet, die Pace aber aus `runSpeed` des Health-Sheets.
  const trendPace=trendDates.map(d=>{
    const kmh = workoutData[d]?.avgSpeedKph>0 ? workoutData[d].avgSpeedKph : null;
    return kmh!=null ? Math.round(paceFromSpeed(kmh)*100)/100 : null;
  });
  // Werktags / Wochenende splits for new chart footers
  const _wkdIdx=trendDates.reduce((a,d,i)=>{const wd=new Date(d+'T00:00:00').getDay();if(wd>=1&&wd<=5)a.push(i);return a;},[]);
  const _wkndIdx=trendDates.reduce((a,d,i)=>{const wd=new Date(d+'T00:00:00').getDay();if(wd===0||wd===6)a.push(i);return a;},[]);
  const _avgNn=arr=>{const f=arr.filter(v=>v!=null);return f.length?f.reduce((a,b)=>a+b,0)/f.length:null;};
  const distWkdAvg=_avgNn(_wkdIdx.map(i=>trendDist[i]));
  const distWkndAvg=_avgNn(_wkndIdx.map(i=>trendDist[i]));
  const paceWkdAvg=_avgNn(_wkdIdx.map(i=>trendPace[i]));
  const paceWkndAvg=_avgNn(_wkndIdx.map(i=>trendPace[i]));
  const hrWkdAvg=_avgNn(_wkdIdx.map(i=>trendHR[i]));
  const hrWkndAvg=_avgNn(_wkndIdx.map(i=>trendHR[i]));
  const paceGesamt=_avgNn(trendPace), hrGesamt=_avgNn(trendHR);

  // Totals for period

  // Aktive Tage = Tage mit Workout-Sheet-Eintrag und durationMin > 0.

  // Weekday vs weekend training (use all days with the field, not just active ones)
  const woMinSplit=splitWeekWknd(D.filter(r=>workoutData[r.date]?.durationMin!=null));
  const _woDur=rows=>rows.map(r=>workoutData[r.date].durationMin);
  const minWeek=mittel(_woDur(woMinSplit.wkd));
  const minWknd=mittel(_woDur(woMinSplit.wknd));

  const {labels:tL,keys:tKeys,keyTyp:tKeyTyp}=timeDim(D);

  // Workout-CSV-based aggregation (Duration + Distance from workoutData, all workout types)
  // NOTE: _woByDate was removed — es filterte auf Health-Sheet-Tage und liess Indoor-Workouts aus
  const woRows=D.map(r=>({date:r.date,_woDurMin:workoutData[r.date]?.durationMin??null,_woDistKm:workoutData[r.date]?.distanceKm??null,
    _woHR:workoutData[r.date]?.avgHR??null,
    // Pace aus derselben Quelle wie im Pace-Diagramm: Workout-Sheet.
    _woPace:(()=>{const kmh=workoutData[r.date]?.avgSpeedKph>0?workoutData[r.date].avgSpeedKph:null;
      return kmh!=null?paceFromSpeed(kmh):null;})(),
    // Zaehlt die EINHEITEN je Zeitraum – gebraucht fuer "Oe pro Training". Vorher
    // stand hier 1 je Tag; an Tagen mit zwei Einheiten fiel der Schnitt dadurch zu hoch aus.
    _woAnzahl:workoutData[r.date]?(workoutData[r.date].anzahl||1):null}));
  const {align:tAvgWo,alignSum:tASwo}=timeDim(woRows);
  // Gesamtwerte des dargestellten Zeitraums – Summe ueber alle Tage des Fensters,
  // unabhaengig von der gewaehlten Aggregation (Tag/Woche/Monat).
  const summe = feld => { const v = woRows.map(r=>r[feld]).filter(x=>x!=null);
    return v.length ? v.reduce((a,b)=>a+b,0) : null; };
  const minGesamt  = summe('_woDurMin');
  const distGesamt = summe('_woDistKm');
  const minSm_wo=tASwo('_woDurMin');
  const distSm_wo=tASwo('_woDistKm');

  // 1M daily: only show bars on actual training days (workout CSV present)
  const _train1m=timeRange==='1m';
  const minSmD=_train1m?minSm_wo.map(v=>v!=null&&v>0?v:null):minSm_wo;
  const distSmD=_train1m?distSm_wo.map((v,i)=>minSmD[i]!=null?v:null):distSm_wo;

  // 1M: build full calendar-month arrays + Monday indices for week gridlines
  let _1mLabels=tL, _1mKeys=tKeys, _1mMinData=minSmD, _1mDistData=distSmD;
  let _1mHRData=tAvgWo('_woHR'), _1mPaceData=tAvgWo('_woPace');
  if(timeRange==='1m'){
    const _rd=new Date(referenceDate+'T00:00:00');
    const _yr=_rd.getFullYear(), _mo=_rd.getMonth();
    const _dim=new Date(_yr,_mo+1,0).getDate();
    const _bd={};D.forEach(r=>{_bd[r.date]=r;});
    const _moDays=Array.from({length:_dim},(_,i)=>toLocalDateStr(new Date(_yr,_mo,i+1)));
    _1mLabels=_moDays.map(tagLabel);
    _1mKeys=_moDays;
    _1mMinData=_moDays.map(d=>workoutData[d]?.durationMin??null);
    _1mDistData=_moDays.map(d=>workoutData[d]?.distanceKm??null);
    _1mHRData=_moDays.map(d=>workoutData[d]?.avgHR??null);
    _1mPaceData=_moDays.map(d=>{
      const kmh=workoutData[d]?.avgSpeedKph>0?workoutData[d].avgSpeedKph:null;
      return kmh!=null?paceFromSpeed(kmh):null;});
  }

  // hasAny stützt sich allein auf das Workout-Sheet – keine Health-CSV-Felder mehr.
  const hasAny=trainDates.length>0;

  const noDataCard=`<div class="no-data">
    <strong>Keine Trainingsdaten gefunden</strong>
    Im aktuellen Zeitraum ist kein Eintrag im Workout-Sheet vorhanden.
    <div class="field-hint" style="margin-top:.4rem">Quelle: <code>Workout Data</code>-Google-Sheet · erwartete Spalten: <code>Date</code> <code>Type</code> <code>Duration (min)</code> <code>Distance (km)</code> <code>Avg HR</code> <code>Speed (km/h)</code></div>
  </div>`;

  const vo2 = vo2Abschnitt(D, P);

  document.getElementById("screen-training").innerHTML=`
    ${pgBanner('🏃','Training')}
      <div class="chart-card">
        <h3>Trainingszeit</h3>
        <div class="chart-legend"><div class="cl-item"><span class="cl-dot" style="background:#F97316"></span>${is7D()||timeRange==='1m'?'pro Tag':'pro Monat'}</div></div>
        <div class="chart-wrap" style="--h:210px"><canvas id="c-tot-zeit"></canvas></div>
        <div class="stats-list diagramm-fuss">
          ${minGesamt!=null?`${statZeile(`Total`, `${fmtMin(minGesamt)}`)}`:''}
          ${minWeek!=null?`${statZeile(`Ø Wochentag (Mo–Fr)`, `${fmtMin(minWeek)}`)}`:''}
          ${minWknd!=null?`${statZeile(`Ø Wochenende (Sa–So)`, `${fmtMin(minWknd)}`)}`:''}
          ${minWeek!=null&&minWknd!=null?`${statZeile(`Differenz`, `${minWknd>minWeek?'+':''}${fmtMin(minWknd-minWeek)}`)}`:''}
        </div>
      </div>

    <div class="chart-card">
      <h3>Vergleich</h3>
      <div class="chart-legend">
        ${KOMBI_REIHEN.map(r=>`<button type="button" class="cl-item kombi-schalter${_kombiAktiv[r.id]?'':' aus'}" data-reihe="${r.id}" aria-pressed="${_kombiAktiv[r.id]?'true':'false'}">
          <span class="${r.typ==='bar'?'cl-dot':'cl-line'}" style="background:${r.farbe}"></span>${r.label}</button>`).join('')}
      </div>
      ${!is7D()&&timeRange!=='1m'?`<div class="chart-note">Zeit und Strecke als Ø pro Training, damit sie neben Puls und Pace lesbar bleiben – die Summen stehen unten als Total.</div>`:''}
      <div class="chart-wrap" style="--h:300px"><canvas id="c-kombi"></canvas></div>
      <div class="stats-list diagramm-fuss" id="kombi-fuss"></div>
    </div>

      <div class="chart-card">
        <h3>Laufstrecke</h3>
        <div class="chart-legend"><div class="cl-item"><span class="cl-dot" style="background:#FB923C"></span>${is7D()||timeRange==='1m'?'pro Tag':'pro Monat'}</div></div>
        <div class="chart-wrap" style="--h:210px"><canvas id="c-tot-strecke"></canvas></div>
        <div class="stats-list diagramm-fuss">
          ${distGesamt!=null?`${statZeile(`Total`, `${zahl(distGesamt,2)} km`)}`:''}
        ${distWkdAvg!=null?`${statZeile(`Ø Wochentag (Mo–Fr)`, `${zahl(distWkdAvg,2)} km`)}`:''}
          ${distWkndAvg!=null?`${statZeile(`Ø Wochenende (Sa–So)`, `${zahl(distWkndAvg,2)} km`)}`:''}
          ${distWkdAvg!=null&&distWkndAvg!=null?`${statZeile(`Differenz`, `${distWkndAvg>distWkdAvg?'+':''}${zahl(distWkndAvg-distWkdAvg,2)} km`)}`:''}
        </div>
      </div>

    <div class="chart-card">
      <h3>${timeRange==='7d'||timeRange==='1m'?'Leistungs-Trend: Distanz & HR pro Training':'Distanz & HR pro Monat'}</h3>
      <div class="chart-legend">
        ${trendDist.some(v=>v!=null)?`<div class="cl-item"><span class="cl-dot" style="background:#FB923C"></span>Distanz</div>`:''}
        ${trendHR.some(v=>v!=null)?`<div class="cl-item"><span class="cl-line" style="background:#EF4444"></span>Puls</div>`:''}
      </div>
      <div class="chart-wrap" style="--h:300px"><canvas id="c-wo-trend"></canvas></div>
    </div>
    <div class="chart-card">
      <h3>Pace pro Training ${infoI('pace')}</h3>
      <div class="chart-legend"><div class="cl-item"><span class="cl-line" style="background:#7C3AED"></span>Pace</div></div>
      <div class="chart-wrap" style="--h:300px"><canvas id="c-tr-pace"></canvas></div>
      <div class="stats-list diagramm-fuss">
        ${paceWkdAvg!=null?`${statZeile(`Ø Wochentag (Mo–Fr)`, `${fmtPace(paceWkdAvg)} min/km`)}`:''}
        ${paceWkndAvg!=null?`${statZeile(`Ø Wochenende (Sa–So)`, `${fmtPace(paceWkndAvg)} min/km`)}`:''}
      </div>
    </div>
    ${!hasAny?noDataCard:''}
    ${vo2.html}`;


  // ── Vergleichsdiagramm ──────────────────────────────────────────────────────
  {
    const _1m = timeRange==='1m';
    const kLbls = _1m?_1mLabels:tL, kKeys = _1m?_1mKeys:tKeys, kKeyTyp = _1m?'tag':tKeyTyp;
    // Ab 3M zeigt die Zeitreihe den Durchschnitt PRO TRAINING statt der Monatssumme.
    // Sonst stuende sie bei 500+ Minuten neben einem Puls von 140 und drueckte ihn
    // auf der gemeinsamen Achse zu einer flachen Linie. Die Fusszeile "Total" nennt
    // weiterhin die Summe.
    const proTraining = !is7D() && !_1m;
    // Beide summierbaren Reihen gleich behandeln. Nur die Zeit umzustellen reichte
    // nicht: die Strecke stuende als Monatssumme bei 100-160 km und drueckte die
    // Pace (rund 5.5) auf der gemeinsamen rechten Achse platt.
    const jeTraining = feld => { const sm=tASwo(feld), an=tASwo('_woAnzahl');
      return sm.map((v,i)=> v!=null&&an[i]>0 ? v/an[i] : null); };
    const kZeit    = _1m ? _1mMinData  : proTraining ? jeTraining('_woDurMin') : minSmD;
    const kStrecke = _1m ? _1mDistData : proTraining ? jeTraining('_woDistKm') : distSmD;
    const kHR   = _1m?_1mHRData:tAvgWo('_woHR');
    const kPace = _1m?_1mPaceData:tAvgWo('_woPace');
    const kDaten = {zeit:kZeit, hr:kHR, strecke:kStrecke, pace:kPace};

    // Fusszeile: pro Zeile alle aktiven Reihen, die dort eine sinnvolle Zahl haben.
    // "Total" laesst Puls und Pace aus - eine Summe von Pulswerten sagt nichts.
    const kGesamt = {zeit:minGesamt, strecke:distGesamt, hr:hrGesamt, pace:paceGesamt};
    const kWkd    = {zeit:minWeek,  strecke:distWkdAvg,  hr:hrWkdAvg,  pace:paceWkdAvg};
    const kWknd   = {zeit:minWknd,  strecke:distWkndAvg, hr:hrWkndAvg, pace:paceWkndAvg};
    window._kombiFussHTML = () => {
      const zeile = (label, quelle, nurSummierbare) => {
        const teile = KOMBI_REIHEN
          .filter(r => _kombiAktiv[r.id] && (!nurSummierbare || r.summierbar) && quelle[r.id]!=null)
          .map(r => r.fmt(quelle[r.id]));
        return teile.length ? statZeile(label, teile.join(' | ')) : '';
      };
      return zeile('Total', kGesamt, true)
           + zeile('Ø Wochentag (Mo–Fr)', kWkd, false)
           + zeile('Ø Wochenende (Sa–So)', kWknd, false);
    };

    window._kombiZeichnen = () => {
      const aktiv = KOMBI_REIHEN.filter(r => _kombiAktiv[r.id]);
      const achseAktiv = id => aktiv.some(r => r.achse === id);
      zeichneDiagramm('c-kombi',{__keys:kKeys,__keyTyp:kKeyTyp,type:'bar',
        data:{labels:kLbls,datasets:aktiv.map(r=>({
          label:r.label, data:kDaten[r.id], type:r.typ, yAxisID:r.achse,
          ...(r.typ==='bar'
            ? {backgroundColor:r.farbe+'CC', borderRadius:BALKEN_RADIUS}
            : {borderColor:r.farbe, backgroundColor:'transparent', borderWidth:2,
               tension:.3, pointRadius:3, pointBackgroundColor:r.farbe, spanGaps:true, fill:false})
        }))},
        options:{responsive:true,maintainAspectRatio:false,
          plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,callbacks:{
            label:ctx=>{ if(ctx.raw==null) return null;
              const r = KOMBI_REIHEN.find(x=>x.label===ctx.dataset.label);
              return r ? `${r.label}: ${r.fmt(ctx.raw)}` : null; }}}},
          scales:{x:gx,
            // Eine Achse erscheint nur, wenn mindestens eine ihrer Reihen aktiv ist.
            yL:{...gy, display:achseAktiv('yL'), position:'left'},
            yR:{...gy, display:achseAktiv('yR'), position:'right', grid:{drawOnChartArea:false}}}}});
      const fuss = document.getElementById('kombi-fuss');
      if (fuss) fuss.innerHTML = window._kombiFussHTML();
    };
  }

  window._kombiZeichnen();

  // ── Totale Laufzeit & Laufstrecke ──
  {
    const _is1m=timeRange==='1m';
    const _zeitInH=timeRange!=='7d'&&timeRange!=='1m'; // 3M+ → show hours
    const _xTot=gx;
    const _lZeitData=_is1m?_1mMinData:minSmD;
    const _lStrData=_is1m?_1mDistData:distSmD;
    const _lZeitLbls=_is1m?_1mLabels:tL;
    const _lStrLbls=_is1m?_1mLabels:tL;
    const _lZeitKeys=_is1m?_1mKeys:tKeys;
    const _lKeyTyp=_is1m?'tag':tKeyTyp;

    zeichneDiagramm('c-tot-zeit',{__keys:_lZeitKeys,__keyTyp:_lKeyTyp,type:'bar',data:{labels:_lZeitLbls,datasets:[
      {label:'Laufzeit',data:_lZeitData,backgroundColor:'rgba(249,115,22,.80)',borderRadius:BALKEN_RADIUS}
    ]},options:{responsive:true,maintainAspectRatio:false,
      // fmtMin schreibt ab einer Stunde "1h 25min", darunter "45 min" – unabhaengig
      // davon, ob die Achse in Stunden oder Minuten beschriftet ist.
      plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,callbacks:{
        label:ctx=>ctx.raw==null?null:fmtMin(ctx.raw)}}},
      scales:{x:_xTot,y:{...gy,
        ticks:{...gy.ticks,callback:v=>_zeitInH?`${Math.floor(v/60)}h`:Math.round(v)+' min'}}}}});

    zeichneDiagramm('c-tot-strecke',{__keys:_lZeitKeys,__keyTyp:_lKeyTyp,type:'bar',data:{labels:_lStrLbls,datasets:[
      {label:'Laufstrecke',data:_lStrData,backgroundColor:'rgba(251,146,60,.80)',borderRadius:BALKEN_RADIUS}
    ]},options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,callbacks:{label:ctx=>ctx.raw!=null?`${ctx.raw.toFixed(2)} km`:null}}},
      scales:{x:_xTot,y:{...gy,
        ticks:{...gy.ticks,callback:v=>v===0?'0':Math.round(v)+' km'}}}}});
  }

  // ── Leistungs-Trend chart (monthly aggregation for 3M+) ──
  {
    const _useMonthly=timeRange!=='7d'&&timeRange!=='1m';
    let woLabels,woDist,woHR,woKeys,woKeyTyp;
    if(_useMonthly){
      // Build from ALL months in the health-data range so months without workouts show 0
      const mMap={};
      trendDates.forEach((d,i)=>{
        const mk=d.slice(0,7);
        if(!mMap[mk])mMap[mk]={dists:[],hrs:[]};
        if(trendDist[i]!=null)mMap[mk].dists.push(trendDist[i]);
        if(trendHR[i]!=null)mMap[mk].hrs.push(trendHR[i]);
      });
      const months=allMonths(D); // all months in current filter, not just those with workouts
      woLabels=months.map(mk=>{const dt=new Date(mk+'-01T00:00:00');return dt.toLocaleDateString('de-CH',{month:'short',year:'2-digit'});});
      woKeys=months; woKeyTyp='monat';
      woDist=months.map(mk=>{const a=(mMap[mk]||{dists:[]}).dists;return a.length?a.reduce((s,v)=>s+v,0)/a.length:0;});
      woHR=months.map(mk=>{const a=(mMap[mk]||{hrs:[]}).hrs;return a.length?a.reduce((s,v)=>s+v,0)/a.length:null;});
    } else {
      woLabels=trendDates.length>0?trendLabels:tL;
      woKeys=trendDates.length>0?trendDates:tKeys;
      woKeyTyp=trendDates.length>0?'tag':tKeyTyp;
      woDist=trendDates.length>0?trendDist:tL.map(()=>null);
      woHR=trendDates.length>0?trendHR:tL.map(()=>null);
    }
    const woDsets=[];
    woDsets.push({
      label:'Distanz (km)',data:woDist,
      backgroundColor:'rgba(249,115,22,.75)',borderRadius:BALKEN_RADIUS,yAxisID:'yL',type:'bar'
    });
    if(woHR.some(v=>v!=null)) woDsets.push({
      label:'Ø HR (bpm)',data:woHR,
      borderColor:'#EF4444',backgroundColor:'transparent',tension:.3,
      pointRadius:3,pointBackgroundColor:'#EF4444',type:'line',yAxisID:'yR'
    });
    zeichneDiagramm('c-wo-trend',{__keys:woKeys,__keyTyp:woKeyTyp,
      type:'bar',
      data:{labels:woLabels,datasets:woDsets},
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,
          callbacks:{label:ctx=>ctx.dataset.label==='Distanz (km)'
            ?`${_useMonthly?'Ø ':''}Distanz: ${ctx.raw!=null?ctx.raw.toFixed(1):'-'} km`
            :`Ø HR: ${ctx.raw!=null?Math.round(ctx.raw):'-'} bpm`}}},
        scales:{
          x:{...gx,ticks:{...gx.ticks,maxRotation:45,minRotation:30}},
          yL:{position:'left',...gy,ticks:{...gy.ticks,callback:v=>v===0?'0':Math.round(v)+' km'}},
          yR:{position:'right',grid:{display:false},
            ticks:{color:'#94A3B8',font:{size:10},callback:v=>Math.round(v)+' bpm'},
            min:100,max:woHR.some(v=>v!=null)?Math.ceil((Math.max(...woHR.filter(v=>v!=null))+10)/10)*10:200}
        }
      }
    });
  }

  // ── Pace pro Training ──
  {
    const _hasP=trendDates.length>0&&trendPace.some(v=>v!=null);
    const _paceLabels=_hasP?trendLabels:tL;
    const _paceKeys=_hasP?trendDates:tKeys;
    const _paceKeyTyp=_hasP?'tag':tKeyTyp;
    const _paceData=_hasP?trendPace:tL.map(()=>null);
    const _pMin=_hasP?Math.floor(Math.min(...trendPace.filter(v=>v!=null))*0.97*10)/10:4;
    const _pMax=_hasP?Math.ceil(Math.max(...trendPace.filter(v=>v!=null))*1.03*10)/10:8;
    zeichneDiagramm('c-tr-pace',{__keys:_paceKeys,__keyTyp:_paceKeyTyp,type:'line',data:{labels:_paceLabels,datasets:[
      {label:'Pace [min/km]',data:_paceData,borderColor:'#7C3AED',backgroundColor:'rgba(124,58,237,.08)',tension:.3,fill:true,pointRadius:3,pointBackgroundColor:'#7C3AED',spanGaps:true}
    ]},options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,callbacks:{label:ctx=>{
        if(ctx.raw==null)return null;
        return `Pace: ${fmtPace(ctx.raw)} min/km`;
      }}}},
      scales:{x:{...gx,ticks:{...gx.ticks,maxRotation:45,minRotation:30}},
        y:{...gy,min:_pMin,max:_pMax,
          ticks:{...gy.ticks,callback:v=>fmtPace(v)}}}}});
  }

  vo2.zeichnen();
}

// ── VO₂max-Abschnitt (zuunterst im Training-Tab) ───────
// Eigene Funktion, weil der Abschnitt inhaltlich für sich steht: er stammt aus dem
// früheren VO₂max-Tab und ist der einzige Teil des Training-Tabs, der NICHT aus dem
// Workout-Sheet kommt, sondern aus r.vo2max der Health-Daten.
// Liefert Markup und Zeichenfunktion getrennt, weil das Markup vor dem Canvas im DOM
// stehen muss, bevor Chart.js darauf zugreifen kann.
function vo2Abschnitt(D, P) {
  const v2r=D.filter(r=>r.vo2max!=null);
  const v2D=mittel(v2r,'vo2max'), v2P=mittel(P.filter(r=>r.vo2max!=null),'vo2max');
  const v2Trend=v2D&&v2P?prozentDiff(v2D,v2P):null;
  const _vo2Cat=(v)=>{
    if(v==null)return['Keine Daten','#94A3B8'];
    if(v>=55)return['Exzellent','#2563EB'];
    if(v>=47)return['Überdurchschnittlich','#10B981'];
    if(v>=42)return['Durchschnittlich','#84CC16'];
    if(v>=35)return['Unterdurchschnittlich','#F97316'];
    return['Niedrig','#EF4444'];
  };
  const [v2cat,v2catColor]=_vo2Cat(v2D);
  const {labels:_v2tL,align:_v2tA,hasData:_v2tHD,keys:_v2Keys,keyTyp:_v2KeyTyp}=timeDim(D,true,true);
  const v2MaFull=_v2tA('vo2max');

  // Die frühere Karte "Fitness-Einordnung" ist aufgelöst: ihr farbiger Skalenbalken ist
  // entfallen, ihre Werte stehen als Fusszeile unter dem Verlauf – wie bei den
  // Schlafphasen. Die Einordnung selbst ("Durchschnittlich") ist als erste Zeile
  // mitgewandert, sonst ginge sie mit dem Balken verloren.
  const html = `    <!-- VO₂max (vormals eigener Tab → jetzt zuunterst) -->
    <div class="chart-card" style="margin-bottom:0">
      <h3>VO₂max-Verlauf ${infoI('vo2max')}</h3>
      <div class="chart-legend"><div class="cl-item"><span class="cl-line" style="background:#D97706"></span>VO₂max</div></div>
      <div class="chart-wrap" style="--h:300px"><canvas id="c-vo2"></canvas></div>
      <div class="stats-list diagramm-fuss">
        ${statZeile(`Ø VO₂max`, `${v2D!=null?zahl(v2D,1)+' ml/kg/min':'—'}`)}
        ${statZeile(`Einordnung`, `${v2cat}`, `${v2catColor}`)}
        ${statZeile(`Trend`, `${v2Trend!=null?(v2Trend>0?'↑ Steigend':'↓ Sinkend'):'Stabil'}`, `${v2Trend!=null&&v2Trend>0?'#10B981':v2Trend!=null&&v2Trend<0?'#EF4444':null}`)}
        ${statZeile(`Veränderung`, `${v2Trend!=null?(v2Trend>0?'+':'')+v2Trend.toFixed(1)+'%':'—'}`)}
        ${statZeile(`Messungen`, `${v2r.length}`)}
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
      const _v2Dsets=[{data:v2MaFull,borderColor:'#D97706',backgroundColor:'rgba(217,119,6,.08)',tension:.3,fill:true,pointRadius:4,pointBackgroundColor:'#D97706',spanGaps:true}];
      _v2Dsets.push(zielLinie('vo2max', _v2tL.length));
      zeichneDiagramm('c-vo2',{__keys:_v2Keys,__keyTyp:_v2KeyTyp,type:'line',data:{labels:_v2tL,datasets:_v2Dsets},
        options:{responsive:true,maintainAspectRatio:false,
          plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,filter:nurMesswerte,callbacks:{label:ctx=>ctx.raw!=null?`VO₂max: ${ctx.raw.toFixed(2)} ml/kg/min`:null}}},
          scales:{x:gx,y:{...gy,min:_v2YMin,max:_v2YMax,ticks:{...gy.ticks,stepSize:_v2Step}}}}});
    }
  }

  return { html, zeichnen };
}

// ── Navigation ─────────────────────────────────────────
const PAGE_FNS={overview:pgOverview,herz:pgHerz,schlaf:pgSchlaf,training:pgTraining};
// Page-Banner ohne inline-Gradient – die Per-Tab-Hintergründe sind auf .screen gesetzt.
// g1/g2 werden zwar von alten Aufrufern noch übergeben, hier aber ignoriert.
function pgBanner(icon,title){
  // Dark-Toggle sitzt rechtsbündig direkt auf der Titelzeile (keine eigene
  // Topbar-Kachel mehr). Dark-Icon spiegelt den aktuellen Zustand.
  // Untertitel und Daten-Stand sind entfallen: der Untertitel erklärte nur den
  // Tabnamen, der Daten-Stand steht jetzt einmal in der App-Karte der Übersicht.
  const darkIcon = document.body.classList.contains('dark') ? '☀️' : '🌙';
  // Aufklapp-Schalter links vom Dark-Toggle – nur in den Tabs, die etwas zu zeigen
  // haben. Er ersetzt die frueheren breiten Balken im Inhalt ("Weitere Auswertungen",
  // "Muster & Zusammenhänge"); der Ausklapp-Knopf der App-Karte bleibt, wo er ist.
  const k = AUSKLAPP[_currentRenderingTab];
  // Doppel-Chevron wie in FitTracks Uebungen-Tab (`.ex-sort-btn`): nach unten zum
  // Aufklappen, nach oben zum Einklappen. Die Punkte der Polylinien sind von dort
  // uebernommen, damit der Knopf in beiden Apps derselbe ist.
  const chevron = k && k.offen()
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="7 11 12 6 17 11"/><polyline points="7 18 12 13 17 18"/></svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/></svg>`;
  const ausklapp = k
    ? `<button class="pg-act ausklapp-act" data-ausklapp="${_currentRenderingTab}"
         aria-expanded="${k.offen() ? 'true' : 'false'}"
         title="${k.titel}" aria-label="${k.titel}">${chevron}</button>`
    : '';
  return`<div class="pg-banner"><span class="pg-banner-icon">${icon}</span><div class="pg-banner-txt"><div class="pg-banner-title">${title}</div></div><div class="pg-banner-actions">${ausklapp}<button class="pg-act dark-toggle" title="Hell/Dunkel" aria-label="Theme">${darkIcon}</button></div></div>`;
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

// Refresh + Dark-Toggle liegen jetzt rechtsbündig auf der Banner-Titelzeile
// jedes Tabs (siehe pgBanner) – keine separate Topbar-Kachel mehr.
// Zeitfilter + Datumsnavigator liegen in den einzelnen Diagrammen
// (siehe filterTitelTeil / filterLegendenTeil / _injectChartFilters).

// Filter-Control für eine Diagramm-Karte: Bereichs-Dropdown + Mini-Datumsnavigator.
// Schreibt in denselben globalen Zustand (timeRange/referenceDate) → app-weit synchron.
const _RANGE_OPTS = [
  ['heute','Heute'],['7d','7T'],['1m','1M'],
  ['3m','3M'],['6m','6M'],['12m','12M'],['24m','24M']
];
// Angezeigter Zeitraum als Text – nur bei den Monatsbereichen. Bei Heute/7T steht das
// Datum bereits auf der Zeitachse; ab 1M zeigt sie je nach Bereich nur noch Monate,
// und aus "Jun 26" allein ist nicht ablesbar, wie weit das Fenster zurückreicht.
const MONAT_KURZ = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
function zeitraumText() {
  const mw = moWindow();
  if (!mw) return '';
  const monat = ds => MONAT_KURZ[+ds.slice(5,7) - 1];
  const jahr  = ds => ds.slice(2,4);
  if (mw.s.slice(0,7) === mw.e.slice(0,7)) return monat(mw.s) + ' ' + jahr(mw.s);
  // Gleiches Jahr: die Jahreszahl nur einmal, sonst wird die Leiste unnötig breit.
  if (mw.s.slice(0,4) === mw.e.slice(0,4)) return monat(mw.s) + '–' + monat(mw.e) + ' ' + jahr(mw.e);
  return monat(mw.s) + ' ' + jahr(mw.s) + '–' + monat(mw.e) + ' ' + jahr(mw.e);
}

  // Eigene Zeile UNTER dem Diagramm-Titel statt daneben: neben dem Titel belegte die
  // Leiste zwei Drittel der Kopfzeile und schnitt ihn auf „V…" / „❤️.." zusammen.
  // Die Zeitspanne als Text ist bewusst weg – sie steht bereits auf der Zeitachse.
// Die Bedienelemente sind auf zwei Zeilen verteilt: "Heute" und der Zeitraum stehen
// rechts neben dem Kartentitel, Auswahlfeld und Pfeile rechts in der Legendenzeile.
// So bleibt jede Zeile schmal genug – zusammen belegten sie zwei Drittel einer Zeile.
function filterTitelTeil() {
  const zeitraum = zeitraumText();
  return `<div class="filter-titel">
    <button class="nav-arrow nav-today" title="Aktuellster Zeitraum" aria-label="Aktuellster Zeitraum" style="display:${timeRange==='heute'?'none':'inline-flex'}">Heute</button>
    ${zeitraum?`<span class="zeitraum-text">${zeitraum}</span>`:''}
  </div>`;
}
function filterLegendenTeil() {
  const opts = _RANGE_OPTS.map(([k,lbl]) => `<option value="${k}"${k===timeRange?' selected':''}>${lbl}</option>`).join('');
  return `<div class="filter-legende">
    <select class="range-select" aria-label="Zeitraum">${opts}</select>
    <div class="date-nav" style="display:${timeRange==='heute'?'none':'inline-flex'}">
      <button class="nav-arrow nav-prev" aria-label="Zurück">‹</button>
      <button class="nav-arrow nav-next" aria-label="Vor">›</button>
    </div>
  </div>`;
}
// Zeitfilter EINMAL pro Tab, direkt unter dem Banner.
//
// Vorher steckte diese Leiste in jeder einzelnen Diagramm-Karte – zwölfmal in der
// App, obwohl alle Kopien denselben globalen Zustand steuern. Sie belegte rund zwei
// Drittel der Kopfzeile, wodurch die Diagramm-Titel auf dem iPhone zu "V…", "7…"
// oder "❤️.." abgeschnitten wurden: Man konnte bei keinem Diagramm mehr erkennen,
// was es zeigt. Eine Leiste pro Tab löst beides auf einmal.
function _injectChartFilters(name) {
  const screenEl = document.getElementById('screen-'+name);
  if (!screenEl) return;
  // Eine Leiste pro Diagramm, auf zwei Zeilen verteilt: "Heute" und der angezeigte
  // Zeitraum stehen rechts neben dem Titel, Auswahlfeld und Pfeile rechts in der
  // Legendenzeile. Zusammen in einer Zeile belegten sie zwei Drittel der Breite.
  screenEl.querySelectorAll('.chart-card').forEach(card => {
    if (!card.querySelector('canvas')) return;         // nur echte Diagramm-Karten
    if (card.querySelector('.filter-titel')) return;   // nicht doppelt injizieren
    const titel = card.querySelector(':scope > .chart-head') || card.querySelector(':scope > h3');
    if (titel) titel.insertAdjacentHTML('beforeend', filterTitelTeil());
    const legende = card.querySelector(':scope > .chart-legend');
    if (legende) { legendeMitFilter(legende); return; }
    // Karte ohne Legende (Schlaf-Score): der zweite Teil bekommt eine eigene Zeile.
    if (titel) titel.insertAdjacentHTML('afterend', `<div class="chart-filter">${filterLegendenTeil()}</div>`);
    else card.insertAdjacentHTML('afterbegin', `<div class="chart-filter">${filterLegendenTeil()}</div>`);
  });
}

// Legendenzeile um Auswahlfeld und Pfeile ergänzen. Die vorhandenen Einträge kommen
// dabei in einen eigenen Block: sonst nimmt eine lange Legende beim Umbruch die
// Bedienelemente mit in die nächste Zeile. So bleiben sie rechts auf der Zeile stehen
// und nur die Einträge selbst brechen um.
function legendeMitFilter(legende) {
  const eintraege = document.createElement('div');
  eintraege.className = 'cl-items';
  while (legende.firstChild) eintraege.appendChild(legende.firstChild);
  legende.appendChild(eintraege);
  legende.insertAdjacentHTML('beforeend', filterLegendenTeil());
  legende.classList.add('mit-filter');
}

// Nach dem Render eines Tabs: Filter-Controls in die Diagramme setzen und
// den Navigations-Zustand (Pfeile/Label) aktualisieren. (Refresh/Dark sitzen
// jetzt im Banner, daher keine separate Topbar-Injektion mehr.)
function _injectTopbar(name) {
  const screenEl = document.getElementById('screen-'+name);
  if (!screenEl) return;
  _injectChartFilters(name); // Filter-Controls in die Diagramm-Karten setzen
  // Disable-State der Pfeile + Label gleich nach Inject korrekt setzen
  updateNavUI();
  // Erst hier steht die endgueltige Hoehe fest – die Filterleisten sind gesetzt.
  if (name === currentScreen) blickAnkerWiederherstellen();
}

// Render einen Tab (oder gibt zurück, wenn schon gerendert)
function _renderTab(name) {
  _currentRenderingTab = name;
  // alte Charts dieses Tabs zerstören
  (tabCharts[name] || []).forEach(id => {
    if (charts[id]) { try { charts[id].destroy(); } catch(_) {} delete charts[id]; }
  });
  tabCharts[name] = [];
  const seitenFn = PAGE_FNS[name];
  if (!seitenFn) return;
  let r;
  try {
    r = seitenFn();
    if (r && typeof r.then === 'function') {
      r.then(() => _injectTopbar(name))
       .catch(e => { document.getElementById('screen-'+name).innerHTML = `<div class="no-data"><strong>Fehler</strong> ${esc(e.message)}</div>`; _injectTopbar(name); });
    } else {
      _injectTopbar(name);
    }
  } catch(e) {
    document.getElementById('screen-'+name).innerHTML = `<div class="no-data"><strong>Fehler</strong> ${esc(e.message)}</div>`;
    _injectTopbar(name);
  }
  return r; // Promise bei async-Tabs (Training), sonst undefined – fürs sequentielle Vorrendern
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
  // KEIN setzen von documentElement.style.background mehr – Body-Gradient mit
  // height:100dvh deckt jetzt die volle physische Viewport-Fläche ab.
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

// Tab-State setzen (Bottom-Nav-Active, Body-Theme-Klasse, ggf. lazy rendern)
function _applyTabState(name) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const navEl = document.getElementById('nav-'+name);
  if (navEl) navEl.classList.add('active');
  const _isDark = document.body.classList.contains('dark');
  document.body.className = 'theme-' + name + (_isDark ? ' dark' : '');
  _setStatusBarColor(name);
  if (!_renderedTabs.has(name)) {
    _renderTab(name);
    _renderedTabs.add(name);
  }
  // Bottom-Nav-Sichtbarkeit bleibt beim Tab-Wechsel erhalten: ausgeblendet bleibt
  // ausgeblendet, bis sie per Hintergrund-Tipp oder Hochscrollen zurückgeholt wird.
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

// State-Change (Filter, Datum, Refresh, Dark-Mode) → alle Tabs invalidieren + aktuellen neu rendern
function _refreshAfterStateChange() {
  // Alle Charts zerstören (Theme- oder Datenwechsel)
  killCharts();
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
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        const navEl = document.getElementById('nav-'+name);
        if (navEl) navEl.classList.add('active');
        const _isDark = document.body.classList.contains('dark');
        document.body.className = 'theme-' + name + (_isDark ? ' dark' : '');
        _setStatusBarColor(name);
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

// Auto-Hide nur noch für Bottom-Nav (Topbar ist jetzt Teil des Scroll-Inhalts
// und rollt natürlich nach oben raus, keine separate Animation nötig).
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
        if (y > 60 && dy > 4) nav.classList.add('nav-hidden');
      });
    }, { passive: true });
  });
  // Tippen auf den Tab-Hintergrund (alles außer echten Bedienelementen wie Buttons,
  // Links, Eingabefeldern, Selects und der oberen Filterleiste) → Bottom-Nav aus-/einblenden.
  const _tapContainer = document.getElementById('tab-container');
  if (_tapContainer) _tapContainer.addEventListener('click', (e) => {
    // Nur auf "totem" Hintergrund togglen. Alles, was selbst etwas auslöst, ausnehmen:
    // Buttons/Links/Eingaben, die Chart-Canvas (Tooltip beim Antippen), die Filterleiste
    // und Elemente mit eigenem Tooltip (data-tt / Tooltip-Wrapper).
    // Tooltip-Anker sind ebenfalls ausgenommen: ein Tipp darauf soll das Tooltip
    // öffnen und nicht zusätzlich die Bottom-Nav umschalten.
    if (e.target.closest('button, a, input, select, textarea, label, canvas, .chart-filter, [data-tt], [data-lauftag], ' + TT_TAP_SELECTOR)) return;
    nav.classList.toggle('nav-hidden');
  });
}

// Aufklapp-Schalter in der Kopfzeile: „Weitere Auswertungen" (Herz, Schlaf) und
// „Muster & Zusammenhänge" (Übersicht) laufen ueber denselben Knopf und dieselbe
// Tabelle (AUSKLAPP).
document.body.addEventListener('click', (e) => {
  const knopf = e.target.closest('[data-ausklapp]');
  if (!knopf) return;
  const tab = knopf.dataset.ausklapp;
  const k = AUSKLAPP[tab];
  if (!k) return;
  k.um();
  // Neu aufbauen statt nur ein-/ausblenden: Diagramme im verborgenen Bereich werden
  // ohne sichtbare Flaeche gezeichnet und behalten Breite 0. Aus diesem Zustand holt
  // sie weder resize() noch update() zurueck – nur ein Neuaufbau bei sichtbarem
  // Container. Der Nutzer oeffnet hier einen ganzen Abschnitt, ein Neuaufbau faellt
  // dabei nicht ins Gewicht.
  _renderTab(tab);
});

// App-Karte auf-/zuklappen. Hier genuegt Ein-/Ausblenden: in der Karte steckt kein
// Diagramm, das im verborgenen Zustand mit Breite 0 gezeichnet wuerde.
document.body.addEventListener('click', (e) => {
  const knopf = e.target.closest('[data-appklapp]');
  if (!knopf) return;
  _appOffen = !_appOffen;
  knopf.setAttribute('aria-expanded', _appOffen);
  const pfeil = knopf.querySelector('.weitere-pfeil');
  if (pfeil) pfeil.textContent = _appOffen ? '▾' : '▸';
  const inhalt = knopf.nextElementSibling;
  if (inhalt) inhalt.hidden = !_appOffen;
});

// Legende des Vergleichsdiagramms: Tipp schaltet eine Reihe ein oder aus. Die
// Schalter sind <button>, damit der Hintergrund-Tipp (Bottom-Nav) sie ausnimmt.
document.body.addEventListener('click', (e) => {
  const schalter = e.target.closest('.kombi-schalter');
  if (!schalter) return;
  const id = schalter.dataset.reihe;
  // Die letzte aktive Reihe bleibt an - ein leeres Diagramm hilft niemandem.
  if (_kombiAktiv[id] && Object.values(_kombiAktiv).filter(Boolean).length === 1) return;
  _kombiAktiv[id] = !_kombiAktiv[id];
  document.querySelectorAll('.kombi-schalter[data-reihe="'+id+'"]').forEach(b => {
    b.classList.toggle('aus', !_kombiAktiv[id]);
    b.setAttribute('aria-pressed', _kombiAktiv[id] ? 'true' : 'false');
  });
  if (typeof window._kombiZeichnen === 'function') window._kombiZeichnen();
});

// ── Event-Wiring (nach Daten-Load) ───────────────────────
// Topbar-Buttons werden per Delegation auf document.body verkabelt,
// weil die Topbar dynamisch in jede .screen-Fläche injiziert wird (sechs Instanzen).
document.body.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('.nav-prev')) { blickAnkerMerken(t); navPrev(); return; }
  if (t.closest('.nav-next')) { blickAnkerMerken(t); navNext(); return; }
  if (t.closest('.nav-today')) {
    blickAnkerMerken(t);
    if (allData.length) {
      referenceDate = allData[allData.length-1].date;
      _datumSelbstGewaehlt = false;   // wieder am neuesten Tag → Nachladen darf mitziehen
      updateNavUI();
      _refreshAfterStateChange();
    }
    return;
  }
  // Jeder Knopf hat eine EIGENE Auslöser-Klasse. `.update-btn` ist reine Optik und
  // sitzt auf allen dreien – wurde sie hier abgefragt, loeste „Mit Google anmelden"
  // zusaetzlich das App-Update samt Rueckfrage aus.
  if (t.closest('.anmelde-btn')) { signIn(); return; }
  if (t.closest('.refresh-btn')) { refreshData(); return; }
  if (t.closest('.appver-btn'))  { jetztAktualisieren(); return; }
  if (t.closest('.dark-toggle')) {
    setDarkMode(!document.body.classList.contains('dark'));
    return;
  }
  const pill = t.closest('.tbtn[data-range]');
  if (pill) { setR(pill.dataset.range); return; }
});
// Bereichs-Dropdown in den Diagrammen (Variante A) → setzt den globalen Zeitfilter.
document.body.addEventListener('change', (e) => {
  const sel = e.target;
  if (sel && sel.classList && sel.classList.contains('range-select')) setR(sel.value);
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

// ── Dark Mode ──────────────────────────────────────────
function applyDarkMode(isDark) {
  document.body.classList.toggle('dark', isDark);
  Chart.defaults.borderColor = ACHSEN_COLOR;
  Chart.defaults.color       = isDark ? '#94A3B8' : '#94A3B8';
  // Dark-Toggle-Emoji in allen Topbar-Instanzen aktualisieren
  document.querySelectorAll('.dark-toggle').forEach(btn => {
    btn.textContent = isDark ? '☀️' : '🌙';
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

function blickAnkerMerken(el) {
  _blickAnker = null;
  const karte = el && el.closest ? el.closest('.chart-card') : null;
  const canvas = karte ? karte.querySelector('canvas') : null;
  const screenEl = document.getElementById('screen-' + currentScreen);
  if (!canvas || !canvas.id || !screenEl) return;
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
let _hinweisZustand = null;
function hinweisZeigen(zustand, text, knopf) {
  const el = document.getElementById('hinweis-oben');
  if (!el) return;
  _hinweisZustand = zustand;
  el.querySelector('.hinweis-txt').textContent = text;
  el.querySelector('.hinweis-akt').textContent = knopf;
  el.hidden = false;
  document.body.classList.add('hinweis-an');
  // Hoehe messen und weitergeben: sie haengt an der Safe-Area und daran, ob der
  // Text umbricht. Ein fester Wert liesse die Leiste je nach Geraet den Tab-Titel
  // ueberdecken oder eine Luecke stehen.
  document.body.style.setProperty('--hinweis-h', el.offsetHeight + 'px');
}
function hinweisAus() {
  const el = document.getElementById('hinweis-oben');
  _hinweisZustand = null;
  if (el) el.hidden = true;
  document.body.classList.remove('hinweis-an');
  document.body.style.removeProperty('--hinweis-h');
}
// Der Stand der Google-Anmeldung steht NICHT mehr als Leiste ueber allen Tabs,
// sondern als Zeile „Google-Anmeldung" in der App-Karte der Uebersicht – dort, wo
// auch die uebrigen App-Angelegenheiten liegen. Die Leiste oben bleibt allein dem
// Fall „Neue Daten geladen" vorbehalten, der eine sofortige Antwort verlangt.
// `anmeldeStand()` ist die einzige Quelle fuer diesen Zustand.
function anmeldeStand() {
  if (!accessToken) return { schluessel:'abgelaufen', text:'abgelaufen', farbe:'#F59E0B',
    hinweis:'Ohne Anmeldung zeigt die App den zuletzt geladenen Stand. Neue Daten holen geht erst nach dem Anmelden wieder.' };
  return { schluessel:'aktiv', text:'aktiv', farbe:null, hinweis:null };
}
// Frueher zeigte das die Leiste oben. Es frischt jetzt die App-Karte auf, damit die
// Zeile dort den neuen Stand traegt.
function hinweisAuthZeigen() { appKarteAuffrischen(); }
// Nur die Uebersicht neu aufbauen, und auch das nur, wenn sie gerade gerendert ist.
function appKarteAuffrischen() {
  if (_renderedTabs.has('overview')) _renderTab('overview');
}
document.body.addEventListener('click', (e) => {
  if (!e.target.closest('.hinweis-akt')) return;
  if (_hinweisZustand === 'neu') { hinweisAus(); _refreshAfterStateChange(); }
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
  if (!accessToken) { hinweisAuthZeigen(); return; }
  const vorher = datenStand();
  const ergebnis = await loadFromAPI({ still: true });
  if (ergebnis === 'auth') { hinweisAuthZeigen(); return; }
  if (ergebnis !== true) return;               // Netzfehler: der alte Stand bleibt stehen
  appKarteAuffrischen();   // Anmeldung wieder gueltig → Zeile in der App-Karte nachziehen
  // Identischer Stand – der Normalfall, wenn die App kurz nacheinander geoeffnet wird.
  // Dann nichts anfassen: ein Neuaufbau saehe nach Ruckeln aus, ohne etwas zu zeigen.
  if (datenStand() === vorher) return;
  if (_beruehrt) {
    hinweisZeigen('neu', 'Neue Daten geladen', 'Anzeigen');
  } else {
    updateNavUI();
    _refreshAfterStateChange();
  }
}

// ── Refresh Button ─────────────────────────────────────
async function refreshData() {
  // Der Knopf traegt jetzt Text statt eines Symbols – deshalb Beschriftung wechseln
  // statt drehen. Der alte Text wird am Element gemerkt und danach zurueckgesetzt.
  // Ohne gültige Anmeldung gibt es nichts zu holen. Frueher lief der Abruf trotzdem
  // los und endete stumm – jetzt sagt es die Leiste oben und der Knopf fuehrt hin.
  if (!accessToken) {
    // Erst die Karte auffrischen (ersetzt die Knoepfe), dann am NEUEN Knopf antworten.
    // Ohne diese Rueckmeldung passierte auf den Tipp sichtbar gar nichts – die Zeile
    // darueber sagte den Grund zwar, aber nicht als Antwort auf den Druck.
    hinweisAuthZeigen();
    document.querySelectorAll('.refresh-btn').forEach(b => {
      const alt = b.textContent;
      b.textContent = 'Anmeldung nötig';
      setTimeout(() => { if (b.isConnected) b.textContent = alt; }, 2500);
    });
    return;
  }
  const btns = document.querySelectorAll('.refresh-btn');
  btns.forEach(b => { b.disabled = true; b.dataset.altText = b.textContent; b.textContent = 'Lädt…'; });
  // 1. Apps Script: Drive → Sheet aktualisieren. `no-cors` liefert keine auswertbare
  //    Antwort; ob es gewirkt hat, zeigt Schritt 3 – die Daten kommen aus dem Sheet.
  try {
    await fetch(REFRESH_URL, { method: 'POST', mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ refresh: true, zugang: accessToken }) });
  } catch(_) {}
  // 2. Kurz warten bis Sheet bereit ist
  await new Promise(r => setTimeout(r, 4000));
  // 3. Daten neu aus Sheet laden
  workoutSheetReady = false; workoutLoadError = null;
  const ergebnis = await loadFromAPI();
  document.querySelectorAll('.refresh-btn').forEach(b => {
    b.disabled = false;
    if (b.dataset.altText) { b.textContent = b.dataset.altText; delete b.dataset.altText; }
  });
  if (ergebnis === 'auth') { hinweisAuthZeigen(); return; }
  // Auf ausdruecklichen Wunsch geladen → immer sofort zeichnen, nie nur ankuendigen.
  if (_hinweisZustand) hinweisAus();
  appKarteAuffrischen();
  updateNavUI();
  _refreshAfterStateChange();
}
// Orientation: keine Lock mehr – App darf in beide Richtungen gedreht werden.
// Im Manifest steht "any". Tab-Snap-Sync reagiert via resize-Listener auf den Wechsel.
// Gespeicherte Präferenz laden
try { if(localStorage.getItem('hcc_dark')==='1') applyDarkMode(true); } catch(e) {}

document.getElementById('loading').style.display = 'none';
updateNavUI();

// Tab-Snap-Sync + Auto-Hide-Bottom-Nav initialisieren
initTabScrollSync();
initScrollHideNav();
// Initial render des ersten Tabs
showScreen('overview');
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
