// ── GitHub Pages – OAuth2 + Sheets API (wie Tesla Dashboard) ──
const CLIENT_ID        = '185114707171-tto1teeec25d9sgkeobme666ndpdip7k.apps.googleusercontent.com';
const REDIRECT_URI     = 'https://lebrongoku-prog.github.io/health-dashboard/';
const HEALTH_SHEET_ID  = '1eZ47hJUc7yX_o-eH0p9JL3Wi34wWMQ8gSEI1a46VRKM';
const WORKOUT_SHEET_ID = '1YJ3ke8Z2jS1KdJlKOnukUStMgvqqppnktAb8UVHDdgk';
const REFRESH_URL      = 'https://script.google.com/macros/s/AKfycbyN4HSh5ai3ZBpCkGjuxHVlE0IagpLtUT-gyLgzRfAXZT4wPahzRJUbZTMvUiaT0djA/exec?refresh=true&token=I4C1c9csK02bAvQbF2cLnUuEsgfJbtWjzzGAPaHnd-Vn';

let accessToken = null, tokenExpiry = 0;

function signIn() {
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth'
    + '?client_id='    + encodeURIComponent(CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI)
    + '&response_type=token'
    + '&scope='        + encodeURIComponent('https://www.googleapis.com/auth/spreadsheets.readonly')
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
    if (t && Date.now() < exp) { accessToken = t; tokenExpiry = exp; return true; }
  } catch(_) {}
  return false;
}

(async () => {
let allData = [], timeRange = '7d', referenceDate = '';
let _lastLoadTs = null; // Zeitpunkt des letzten erfolgreichen Sheet-Abrufs (für den Daten-Stand)
const charts = {};
// Cache für allData-abhängige Auswertungen (Baselines, Tages-Empfehlung,
// Warnsignale, Muster-Insights). Wird in loadFromAPI geleert, sobald sich
// allData ändert. So entfällt das Neuberechnen bei jedem Tab-Render/Filterwechsel.
let _analyticsCache = {};
function _memo(key, fn) {
  if (!(key in _analyticsCache)) _analyticsCache[key] = fn();
  return _analyticsCache[key];
}
let _calDate = null; // persists calendar month across re-renders
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

// ── Training Calendar helper ───────────────────────────
function _buildCalHTML(year, month) {
  // month: 0-indexed (JS Date convention)
  // Trainingstage werden ausschließlich aus dem Workout-Sheet abgeleitet.
  // Health-CSV-Felder (runSpeed/distanceWalkingRunning/…) werden hier nicht mehr genutzt.
  const trainDays = new Set(Object.keys(workoutData));
  const minDate = allData.length ? allData[0].date : null;
  const maxDate = allData.length ? allData[allData.length-1].date : null;
  const today = new Date(); today.setHours(0,0,0,0);
  const todayStr = toLocalDateStr(new Date());
  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth = new Date(year, month+1, 0);
  const monthStr = firstOfMonth.toLocaleDateString('de-CH',{month:'long',year:'numeric'});
  const prevMonth = new Date(year, month-1, 1);
  const nextMonth = new Date(year, month+1, 1);
  // toLocalDateStr statt toISOString: toISOString rechnet nach UTC um, wodurch in
  // Zeitzonen östlich von Greenwich (CH = UTC+1/+2) der Vortag herauskommt.
  const prevDisabled = minDate && toLocalDateStr(prevMonth).slice(0,7) < minDate.slice(0,7) ? 'disabled' : '';
  const nextDisabled = maxDate && toLocalDateStr(nextMonth).slice(0,7) > maxDate.slice(0,7) ? 'disabled' : '';
  let startDow = firstOfMonth.getDay();
  startDow = startDow === 0 ? 6 : startDow - 1; // Mon=0
  const mo1=toLocalDateStr(firstOfMonth), mo2=toLocalDateStr(lastOfMonth);
  const trainCount = allData.filter(r=>r.date>=mo1&&r.date<=mo2&&trainDays.has(r.date)).length;

  // Build cells — each cell is a flex container so circle is centered within the 1fr column.
  // Trainingstage tragen .cal-train + data-day; Inhalt und Position des Tooltips
  // übernimmt der zentrale Handler (Maus UND Touch, siehe initTooltips).
  let cells='';
  for(let i=0;i<startDow;i++) cells+=`<div></div>`;
  for(let d=1;d<=lastOfMonth.getDate();d++){
    const ds=`${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isTrain=trainDays.has(ds);
    const isToday=ds===todayStr;
    const bg=isTrain?'#F97316':'transparent';
    const col=isTrain?'#fff':isToday?'#F97316':'var(--txt2)';
    const ring=isToday?'box-shadow:0 0 0 2px #F97316;':'';
    const fw=isTrain||isToday?'700':'400';
    cells+=`<div class="cal-cell${isTrain?' cal-train':''}"${isTrain?` data-day="${ds}" tabindex="0" role="button" aria-label="Training am ${ds}"`:''}>
      <div style="width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:${bg};color:${col};font-size:.74rem;font-weight:${fw};${ring}">${d}</div>
    </div>`;
  }

  return `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.3rem">
    <button class="nav-arrow" style="width:32px;height:32px;font-size:.9rem" onclick="window._calPrev()" ${prevDisabled}>◀</button>
    <span style="font-size:.72rem;font-weight:700;color:var(--txt)">${monthStr}</span>
    <button class="nav-arrow" style="width:32px;height:32px;font-size:.9rem" onclick="window._calNext()" ${nextDisabled}>▶</button>
  </div>
  <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:1px;margin-bottom:.3rem">
    ${['Mo','Di','Mi','Do','Fr','Sa','So'].map(d=>`<div style="display:flex;align-items:center;justify-content:center;font-size:.6rem;font-weight:700;color:var(--txt3);height:22px">${d}</div>`).join('')}
    ${cells}
  </div>
  <div style="font-size:.64rem;color:var(--txt2);text-align:center;border-top:1px solid var(--border);padding-top:.25rem">🏋️ ${trainCount} Training${trainCount!==1?'s':''} diesen Monat</div>`;
}

// ── Workout-Daten aus API-Response parsen ──────────────
const _typeIcons = {'Outdoor Ausführen':'🏃','Laufen':'🏃','Radfahren':'🚴','Schwimmen':'🏊','Wandern':'🥾','Krafttraining':'💪','HIIT':'⚡','Yoga':'🧘','Radfahren, drinnen':'🚴','Funktionstraining':'🏋️','Trail-Laufen':'🏔️'};
function _parseWorkoutRows(rows) {
  // Sheet values arrive as strings via .toString() – parse to numbers explicitly
  const pN = v => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(v); return isNaN(n) ? null : n; };
  rows.forEach(r => {
    const date = r['Date'] || r['date'];
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return;
    const typeRaw = String(r['Type'] || r['type'] || '').trim();
    const icon = _typeIcons[typeRaw] || '🏋️';
    workoutData[date] = {
      // typeRaw bleibt roh (dient als Schlüssel für _typeIcons); typeLabel ist die
      // Anzeigefassung und deshalb bereits entschärft.
      date, typeRaw, typeLabel: icon + ' ' + esc(typeRaw || 'Workout'), icon,
      durationMin:    pN(r['Duration (min)']),
      distanceKm:     pN(r['Distance (km)']),
      avgHR:          pN(r['Avg HR']),
      maxHR:          pN(r['Max HR']),
      avgSpeedKph:    pN(r['Speed (km/h)']),
      elevationM:     pN(r['Elevation (m)']),
      activeEnergyKJ: pN(r['Energy (kJ)']),
      cadence:        pN(r['Cadence']),
      stepCount:      pN(r['Steps'])
    };
  });
  // workoutSheetReady wird vom Aufrufer gesetzt (auch im Fehlerfall) – siehe loadFromAPI.
}

Chart.defaults.color = '#94A3B8';
Chart.defaults.borderColor = '#E8EDF2';
Chart.defaults.font.family = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif";
Chart.defaults.font.size = 10;

// Schlankere Balken in ALLEN Diagrammen (Chart.js-Standard: 0.9 / 0.8).
// barPercentage      = Breite des Balkens innerhalb seines Slots
// categoryPercentage = Breite des Slots innerhalb des Kategorie-Abstands
// maxBarThickness    = Deckel, damit Balken bei wenigen Werten (z. B. Filter "Heute")
//                      nicht zu klobigen Blöcken aufgehen.
Chart.defaults.datasets.bar.barPercentage      = 0.62;
Chart.defaults.datasets.bar.categoryPercentage = 0.74;
Chart.defaults.datasets.bar.maxBarThickness    = 26;

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

// ── Daten von Apps Script API laden ───────────────────
// Sheets-Tab-Name ermitteln und Daten laden (wie Tesla Dashboard)
async function _fetchSheet(sheetId) {
  // Token-Ablauf proaktiv prüfen – wenn er in < 60 s abläuft, sauber neu anmelden
  // statt erst auf den 401 vom Server zu warten.
  if (!accessToken || Date.now() > tokenExpiry - 60_000) {
    try { localStorage.removeItem('g_token'); localStorage.removeItem('g_expiry'); } catch(_) {}
    signIn();
    return { authError: true };
  }
  const metaRes = await fetch(
    'https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '?fields=sheets.properties.title',
    { headers: { 'Authorization': 'Bearer ' + accessToken } }
  );
  if (metaRes.status === 401) return { authError: true };
  if (!metaRes.ok) throw new Error('Sheets API Fehler ' + metaRes.status + ': ' + await metaRes.text());
  const meta = await metaRes.json();
  const tabName = meta.sheets[0].properties.title;
  const dataRes = await fetch(
    'https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values/' + encodeURIComponent(tabName),
    { headers: { 'Authorization': 'Bearer ' + accessToken } }
  );
  if (!dataRes.ok) throw new Error('Daten-Abruf fehlgeschlagen: ' + dataRes.status);
  const json = await dataRes.json();
  return { values: json.values || [] };
}

async function loadFromAPI() {
  try {
    // 1. Gesundheitsdaten direkt von Google Sheets laden
    const health = await _fetchSheet(HEALTH_SHEET_ID);
    if (health.authError) {
      accessToken = null; tokenExpiry = 0;
      try { localStorage.removeItem('g_token'); localStorage.removeItem('g_expiry'); } catch(_) {}
      document.getElementById('loading').style.display = 'none';
      document.getElementById('login-screen').style.display = 'flex';
      return false;
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
    referenceDate = allData[allData.length - 1].date;
    _analyticsCache = {}; // neue Daten → Analytics-Cache invalidieren

    // 2. Workout-Daten laden. Ein Fehler hier legt die übrigen Tabs nicht lahm, darf
    //    aber nicht stillschweigend verschluckt werden: sonst wartet der Training-Tab
    //    endlos auf Daten, die nie kommen. Deshalb Fehler merken und den Ladeversuch
    //    in jedem Fall als abgeschlossen markieren.
    workoutLoadError = null;
    try {
      const workout = await _fetchSheet(WORKOUT_SHEET_ID);
      if (workout.authError) {
        workoutLoadError = 'Keine gültige Berechtigung für das Workout-Sheet.';
      } else if (workout.values && workout.values.length > 1) {
        const wHeaders = workout.values[0].map(h => h.trim());
        const wRows = workout.values.slice(1).map(row => {
          const obj = {};
          wHeaders.forEach((h, i) => { obj[h] = (row[i] ?? '').toString().trim(); });
          return obj;
        });
        _parseWorkoutRows(wRows);
      }
      // values.length <= 1 → Sheet enthält nur die Kopfzeile: kein Fehler, nur keine Einträge.
    } catch(e) {
      workoutLoadError = e.message || 'Unbekannter Fehler beim Abruf.';
    } finally {
      workoutSheetReady = true;
    }

  } catch(e) { showErr('Fehler beim Laden: ' + e.message); return false; }
  _lastLoadTs = Date.now();
  return true;
}

// ── Auth prüfen, sonst Login-Screen ───────────────────
if (!_initAuth()) {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  return;
}
if (!await loadFromAPI()) return;

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

function fmtDayFull(d) {
  if (!d) return '–';
  const dt = new Date(d+'T00:00:00');
  return String(dt.getDate()).padStart(2,'0')+'.'+String(dt.getMonth()+1).padStart(2,'0')+'.'+dt.getFullYear();
}

const MONATE_LANG = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
const MO_SHORT = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
function fmtDayShort(d) {
  if (!d) return '–';
  const dt = new Date(d+'T00:00:00');
  return String(dt.getDate()).padStart(2,'0')+'.'+String(dt.getMonth()+1).padStart(2,'0')+'.'+String(dt.getFullYear()).slice(-2);
}
function fmtMonthYear(dt) { return MO_SHORT[dt.getMonth()]+' '+String(dt.getFullYear()).slice(-2); }

function navDateLabel() {
  if (!referenceDate) return '–';
  if (timeRange === '7d') {
    const days = weekDays7();
    if (!days.length) return '–';
    return fmtDayShort(days[0]) + ' – ' + fmtDayShort(days[6]);
  }
  const wm = windowMonths();
  if (wm != null) {
    const endDt = new Date(referenceDate+'T00:00:00');
    if (wm === 1) return fmtMonthYear(endDt); // single month: "Mär '26"
    const startFirst = addMonths(moFirst(referenceDate), -(wm-1));
    const startDt = new Date(startFirst+'T00:00:00');
    return fmtMonthYear(startDt) + ' – ' + fmtMonthYear(endDt);
  }
  const dt2 = new Date(referenceDate+'T00:00:00');
  return MONATE_LANG[dt2.getMonth()] + ' ' + dt2.getFullYear();
}

function updateNavUI() {
  const label = navDateLabel();
  document.querySelectorAll('.nav-label').forEach(el => { el.textContent = label; });
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
  referenceDate = nr;
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
  referenceDate = nr;
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
function fn(v, dec=1) { return v == null ? '—' : Number(v).toFixed(dec); }

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
function pct(curr, prev) { if (curr==null||prev==null||prev===0) return null; return ((curr-prev)/Math.abs(prev))*100; }
function av(arr, field) {
  const vals = arr.map(r => field ? r[field] : r).filter(v => v != null && !isNaN(v));
  return vals.length ? vals.reduce((a,b) => a+b, 0)/vals.length : null;
}
function sdv(arr, field) {
  const vals = arr.map(r => field ? r[field] : r).filter(v => v != null && !isNaN(v));
  if (vals.length < 2) return null;
  const m = vals.reduce((a,b)=>a+b,0)/vals.length;
  return Math.sqrt(vals.map(v=>(v-m)**2).reduce((a,b)=>a+b,0)/vals.length);
}
function trendLabel() { return 'vs. Vorperiode'; }
function mAvg(rows, field) {
  const b = {};
  rows.forEach(r => { if(r[field]==null) return; const mo=r.date.slice(0,7); if(!b[mo])b[mo]={sum:0,n:0}; b[mo].sum+=r[field]; b[mo].n++; });
  return Object.entries(b).sort((a,x)=>a[0].localeCompare(x[0])).map(([mo,{sum,n}])=>({mo,v:sum/n}));
}
function mSum(rows, field) {
  const b = {};
  rows.forEach(r => { if(r[field]==null) return; const mo=r.date.slice(0,7); b[mo]=(b[mo]||0)+r[field]; });
  return Object.entries(b).sort((a,x)=>a[0].localeCompare(x[0])).map(([mo,v])=>({mo,v}));
}
function allMonths(rows) { return [...new Set(rows.map(r=>r.date.slice(0,7)))].sort(); }
function alignByMo(mos, arr) { const m=Object.fromEntries(arr.map(x=>[x.mo,x.v])); return mos.map(m2=>m[m2]??null); }
function toHM(h) { if(h==null) return '—'; return Math.floor(h)+'h '+Math.round((h%1)*60).toString().padStart(2,'0')+'m'; }
// Pace: km/h → min/km, plus einheitliche Darstellung 5'30".
// Vorher an drei Stellen ausgeschrieben, dabei zweimal mit '' statt " als Sekundenzeichen.
function paceFromSpeed(kph) { return kph > 0 ? 60/kph : null; }
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
function wAvg(rows, field) {
  const b = {};
  rows.forEach(r => { if(r[field]==null) return; const w=getWeekMonday(r.date); if(!b[w])b[w]={sum:0,n:0}; b[w].sum+=r[field]; b[w].n++; });
  return Object.entries(b).sort((a,x)=>a[0].localeCompare(x[0])).map(([w,{sum,n}])=>({w,v:sum/n}));
}
function wSum(rows, field) {
  const b = {};
  rows.forEach(r => { if(r[field]==null) return; const w=getWeekMonday(r.date); b[w]=(b[w]||0)+r[field]; });
  return Object.entries(b).sort((a,x)=>a[0].localeCompare(x[0])).map(([w,v])=>({w,v}));
}
function allWeeks(rows) { return [...new Set(rows.map(r=>getWeekMonday(r.date)))].sort(); }
function alignByWeek(weeks,arr) { const m=Object.fromEntries(arr.map(x=>[x.w,x.v])); return weeks.map(w=>m[w]??null); }
function fmtWeek(w) { const dt=new Date(w+'T00:00:00'); return String(dt.getDate()).padStart(2,'0')+'.'+String(dt.getMonth()+1).padStart(2,'0')+'.'; }

// granular=true → weekly buckets for 1M/3M (line charts); false → monthly (bar charts)
function timeDim(rows, granular=false, keepAggregated=false) {
  if (is7D()) {
    const days = weekDays7();
    const byDate = {};
    rows.forEach(r => { byDate[r.date] = r; });
    const labels = days.map(d => { const dt=new Date(d+'T00:00:00'); return String(dt.getDate()).padStart(2,'0')+'.'+String(dt.getMonth()+1).padStart(2,'0')+'.'; });
    const align = field => days.map(d => byDate[d]?.[field] ?? null);
    return { labels, align, alignSum:align, hasData:days.some(d => d in byDate) };
  }
  // Daily data for 1M
  if (timeRange==='1m' && !keepAggregated) {
    const mw=moWindow();
    const byDate={};
    rows.forEach(r=>{byDate[r.date]=r;});
    const days=[];
    if(mw){let d=new Date(mw.s+'T00:00:00');const end=new Date(mw.e+'T00:00:00');while(d<=end){days.push(toLocalDateStr(d));d.setDate(d.getDate()+1);}}
    const labels=days.map(d=>{const dt=new Date(d+'T00:00:00');return String(dt.getDate()).padStart(2,'0')+'.'+String(dt.getMonth()+1).padStart(2,'0')+'.';});
    const align=field=>days.map(d=>byDate[d]?.[field]??null);
    return{labels,align,alignSum:align,hasData:days.some(d=>d in byDate)};
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
      align: field => alignByWeek(weeks, wAvg(rows, field)),
      alignSum: field => alignByWeek(weeks, wSum(rows, field)),
      hasData: weeks.length > 0
    };
  }
  const mos = allMonths(rows);
  return {
    labels: mos.map(fmtM),
    align: field => alignByMo(mos, mAvg(rows, field)),
    alignSum: field => alignByMo(mos, mSum(rows, field)),
    hasData: mos.length > 0
  };
}

function killCharts() {
  Object.values(charts).forEach(c => { try { c.destroy(); } catch(e){} });
  Object.keys(charts).forEach(k => delete charts[k]);
}
function mkC(id, cfg) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (charts[id]) { try { charts[id].destroy(); } catch(e){} }
  // Während einer Pfeil-Navigation die Aufbau-Animation abschalten – die seitliche
  // Wisch-Bewegung übernimmt _animNavSlide (sonst zwei konkurrierende Animationen).
  if (_navSliding) { cfg.options = cfg.options || {}; cfg.options.animation = false; }
  charts[id] = new Chart(el, cfg);
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
//   .cal-train         → gemeinsames #cal-tip-Element, Inhalt aus workoutData
//   .ov-ring-wrap /
//   .hs-komp-bar-wrap  → reine CSS-Tooltips, geöffnet über die Klasse .tt-open
const TT_TAP_SELECTOR = '.debt-tt-wrap, .cal-train, .ov-ring-wrap, .hs-komp-bar-wrap, .info-i';

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

// ── Trainingskalender: gemeinsames Tooltip-Element ──
function _calTipEl() {
  let tip = document.getElementById('cal-tip');
  if (!tip) { tip = document.createElement('div'); tip.id = 'cal-tip'; document.body.appendChild(tip); }
  return tip;
}
function _calTipHTML(ds) {
  const wo = workoutData[ds];
  if (!wo) return '';
  const dateStr = new Date(ds+'T00:00:00').toLocaleDateString('de-CH',{weekday:'short',day:'2-digit',month:'long'});
  let html = `<div class="cal-tip-title">${wo.icon} ${dateStr}</div>`;
  if (wo.avgHR)       html += `<div class="cal-tip-row">💓 Ø ${Math.round(wo.avgHR)} bpm${wo.maxHR?` · Max ${wo.maxHR} bpm`:''}</div>`;
  if (wo.distanceKm)  html += `<div class="cal-tip-row">📍 ${wo.distanceKm.toFixed(2)} km${wo.avgSpeedKph?` · ${fmtPace(paceFromSpeed(wo.avgSpeedKph))}/km`:''}</div>`;
  if (wo.elevationM)  html += `<div class="cal-tip-row">⛰️ ${Math.round(wo.elevationM)} m ↑</div>`;
  if (wo.durationMin) html += `<div class="cal-tip-row">⏱️ ${Math.floor(wo.durationMin)} min</div>`;
  return html;
}

// ── Öffnen / Schliessen ──
let _ttOpenEl = null;
function closeTooltips() {
  document.querySelectorAll('.debt-tt.visible').forEach(t => t.classList.remove('visible'));
  document.querySelectorAll('.tt-open').forEach(el => el.classList.remove('tt-open'));
  const tip = document.getElementById('cal-tip');
  if (tip) tip.classList.remove('visible');
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
  } else if (el.classList.contains('cal-train')) {
    const tip = _calTipEl();
    tip.innerHTML = _calTipHTML(el.dataset.day);
    tip.classList.add('visible');                       // erst sichtbar, dann messen
    _placeTooltip(tip, rect, 190, 110);
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

const GRID_COLOR = 'rgba(148,163,184,0.18)';
const gx = {grid:{color:GRID_COLOR},ticks:{color:'#94A3B8',font:{size:9}}};
const gy = {grid:{color:GRID_COLOR},ticks:{color:'#94A3B8',font:{size:9}}};

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
  sleepTotal: { label:'Schlaf',       ziel:7.5,   richtung:'hoch', fmt:v=>toHM(v) },
  restHR:     { label:'Ruhepuls',     ziel:60,    richtung:'tief', fmt:v=>Math.round(v)+' bpm' },
  hrv:        { label:'HRV',          ziel:50,    richtung:'hoch', fmt:v=>Math.round(v)+' ms' },
  steps:      { label:'Schritte',     ziel:10000, richtung:'hoch', fmt:v=>Math.round(v).toLocaleString('de-CH') },
  trainDays:  { label:'Trainingstage',ziel:3,     richtung:'hoch', fmt:v=>v+' / Woche' },
  vo2max:     { label:'VO₂max',       ziel:45,    richtung:'hoch', fmt:v=>fn(v,1) }
};
// Erfüllt der Wert das Ziel? null, wenn kein Wert vorliegt.
function zielErfuellt(key, wert) {
  const z = ZIELE[key];
  if (!z || wert == null) return null;
  return z.richtung === 'hoch' ? wert >= z.ziel : wert <= z.ziel;
}
// Klartext des Ziels, z. B. "Ziel: ≥ 7h 30m"
function zielText(key) {
  const z = ZIELE[key];
  if (!z) return '';
  return `Ziel: ${z.richtung === 'hoch' ? '≥' : '≤'} ${z.fmt(z.ziel)}`;
}
// Einheitliche Markierung an jeder Kachel: immer gleiche Form, immer gleiche Stelle.
// Vorher bedeutete Farbe je nach Kachel etwas anderes.
function zielBadge(key, wert) {
  const ok = zielErfuellt(key, wert);
  if (ok === null) return `<span class="ziel-badge neutral">${zielText(key)}</span>`;
  return `<span class="ziel-badge ${ok?'ok':'ab'}">${ok?'✓':'!'} ${zielText(key)}</span>`;
}
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

  const pruef = [
    ['sleepTotal', last.sleepTotal],
    ['restHR',     last.restHR],
    ['hrv',        last.hrv],
    ['steps',      last.steps],
    ['trainDays',  letzte7.length >= 7 ? trainProWoche : null],
    ['vo2max',     letzterVo2]
  ].filter(([,v]) => v != null);

  if (!pruef.length) return '';
  const verfehlt = pruef.filter(([k,v]) => zielErfuellt(k,v) === false);
  const alleOk = verfehlt.length === 0;

  const details = verfehlt.map(([k,v]) =>
    `<span class="zs-item">${ZIELE[k].label} <strong>${ZIELE[k].fmt(v)}</strong> statt ${ZIELE[k].fmt(ZIELE[k].ziel)}</span>`
  ).join('');

  return `<div class="ziel-status ${alleOk?'ok':'ab'}">
    <div class="zs-kopf">${alleOk ? '✅' : '⚠️'} <strong>${alleOk
      ? `Alle ${pruef.length} Ziele erreicht`
      : `${verfehlt.length} von ${pruef.length} Zielen verfehlt`}</strong>${scopeBadge('letzter Tag')}</div>
    ${alleOk ? '' : `<div class="zs-liste">${details}</div>`}
  </div>`;
}

// ── Kurzerklärungen zu den Kennzahlen ──────────────────
// Jede Erklärung beantwortet zwei Fragen: Was ist das, und welche Richtung ist gut?
// Ohne die zweite Angabe lässt sich keine Farbe und kein Pfeil deuten.
const ERKLAERUNG = {
  sleepTotal: 'Tatsächlich geschlafene Zeit pro Nacht (ohne Wachliegen). Mehr ist besser, bis etwa 9 Stunden.',
  restHR:     'Ruhepuls: Herzschläge pro Minute in völliger Ruhe. Weniger ist besser – ein sinkender Ruhepuls zeigt wachsende Ausdauer.',
  hrv:        'Herzratenvariabilität: Schwankung der Abstände zwischen zwei Herzschlägen. Mehr ist besser – hohe Werte stehen für gute Erholung.',
  steps:      'Zurückgelegte Schritte pro Tag. Mehr ist besser.',
  trainDays:  'Tage mit einem Eintrag im Workout-Sheet, gezählt über die letzten sieben Tage.',
  vo2max:     'VO₂max: geschätzte maximale Sauerstoffaufnahme – das gängigste Mass für Ausdauerleistung. Mehr ist besser.',
  pace:       'Pace: benötigte Zeit pro Kilometer. Weniger ist besser (schneller).',
  baseline:   'Baseline: dein eigener Durchschnitt der letzten 30 Tage. Verglichen wird also mit dir selbst, nicht mit Richtwerten.'
};
// Antippbares Fragezeichen. Nutzt das zentrale Tooltip-System (Maus + Finger).
function infoI(key) {
  const t = ERKLAERUNG[key];
  return t ? `<span class="info-i" data-tt="${esc(t)}" tabindex="0" role="button" aria-label="Erklärung">i</span>` : '';
}

// ── Score ──────────────────────────────────────────────
function computeHealthScore(days) {
  let s=0,w=0;
  const sl=av(days,'sleepTotal');
  if(sl!=null){const v=sl>=7&&sl<=9?100:sl<4?0:sl<7?((sl-4)/3)*100:Math.max(0,100-(sl-9)*20);s+=Math.min(100,Math.max(0,v))*35;w+=35;}
  const hv=av(days,'hrv'),hvA=av(allData,'hrv');
  if(hv!=null&&hvA){s+=Math.min(100,(hv/hvA)*100)*30;w+=30;}
  const hr=av(days,'restHR');
  if(hr!=null){const v=hr<=50?100:hr>=80?0:((80-hr)/30)*100;s+=v*20;w+=20;}
  const st=av(days,'steps');
  if(st!=null){s+=Math.min(100,(st/10000)*100)*15;w+=15;}
  // null statt eines erfundenen Platzhalters: ohne Messwerte gibt es keinen Score.
  // Ein fester Wert (früher 70 = "Gut") wäre von einem echten Ergebnis nicht
  // unterscheidbar gewesen – in einer Gesundheits-App der schlechteste Fehlerfall.
  return w ? Math.round(s/w) : null;
}
function scoreCat(s) {
  if(s==null)return['Keine Daten','#94A3B8'];
  if(s>=85)return['Ausgezeichnet','#10B981'];
  if(s>=70)return['Gut','#84CC16'];
  if(s>=55)return['Ordentlich','#EAB308'];
  if(s>=40)return['Ausbaufähig','#F97316'];
  return['Niedrig','#EF4444'];
}

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
    const hvGood = goodSleep.length ? av(goodSleep,'hrv') : null;
    const hvPoor = poorSleep.length ? av(poorSleep,'hrv') : null;
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
    const stGood = goodSleepRows.length?av(goodSleepRows,'steps'):null;
    const stPoor = poorSleepRows.length?av(poorSleepRows,'steps'):null;
    if (stGood&&stPoor&&stGood>stPoor+500) {
      const diff = ((stGood-stPoor)/stPoor*100).toFixed(0);
      insights.push({icon:'🚶',color:'#059669',text:`An Tagen nach gutem Schlaf (≥7.5h) bist du durchschnittlich ${diff}% aktiver als nach kurzen Nächten.`,hl:[{phrase:`${diff}% aktiver`,c:'#10B981'}],conf:'Schlaf–Schritte-Zusammenhang'});
    }
  }

  // Insight 3: HRV vs restHR correlation
  const withBothHR = allData.filter(r=>r.hrv!=null&&r.restHR!=null);
  if (withBothHR.length >= 14) {
    const avgHRV = av(withBothHR,'hrv');
    const highHRV = withBothHR.filter(r=>r.hrv>=avgHRV);
    const lowHRV  = withBothHR.filter(r=>r.hrv< avgHRV);
    const hrHigh = highHRV.length?av(highHRV,'restHR'):null;
    const hrLow  = lowHRV.length ?av(lowHRV, 'restHR'):null;
    if (hrHigh&&hrLow&&hrLow>hrHigh+2) {
      const diff = (hrLow-hrHigh).toFixed(0);
      insights.push({icon:'❤️',color:'#EF4444',text:`An Tagen mit hoher HRV ist dein Ruhepuls im Schnitt ${diff} bpm tiefer als an Tagen mit niedriger HRV.`,hl:[{phrase:`${diff} bpm tiefer`,c:'#10B981'}],conf:'HRV–Ruhepuls-Zusammenhang'});
    }
  }

  // Insight 4: Training → HRV am Folgetag
  const trainDates = new Set(allData.filter(r=>r.runSpeed!=null).map(r=>r.date));
  if (trainDates.size >= 5) {
    const afterTrain=[], afterRest=[];
    allData.forEach(r => {
      if (r.hrv==null) return;
      const prevStr = addDays(r.date, -1); // lokal, nicht über UTC (sonst zwei Tage zurück)
      if (trainDates.has(prevStr)) afterTrain.push(r);
      else if (byDate[prevStr]) afterRest.push(r);
    });
    const hvTrain = afterTrain.length>=3?av(afterTrain,'hrv'):null;
    const hvRest  = afterRest.length >=3?av(afterRest, 'hrv'):null;
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
    const hrTrain = afterTrainHR.length>=3?av(afterTrainHR,'restHR'):null;
    const hrRest  = afterRestHR.length >=3?av(afterRestHR, 'restHR'):null;
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
    const slActive  = av(activeRows.map(r=>byDate[nextDay(r.date)]).filter(Boolean), 'sleepTotal');
    const slInactive= av(inactiveRows.map(r=>byDate[nextDay(r.date)]).filter(Boolean), 'sleepTotal');
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
    const hvHi = av(hiRows.map(r=>byDate[nextDay(r.date)]).filter(Boolean),'hrv');
    const hvLo = av(loRows.map(r=>byDate[nextDay(r.date)]).filter(Boolean),'hrv');
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
    const first = av(vo2Rows.slice(0, Math.ceil(vo2Rows.length/3)), 'vo2max');
    const last  = av(vo2Rows.slice(-Math.ceil(vo2Rows.length/3)), 'vo2max');
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
    const slWD = weekday.length>=5?av(weekday,'sleepTotal'):null;
    const slWE = weekend.length>=2?av(weekend,'sleepTotal'):null;
    if (slWD&&slWE&&slWE>slWD+0.4) {
      const diff = Math.round((slWE-slWD)*60);
      insights.push({icon:'📅',color:'#7C3AED',text:`Am Wochenende schläfst du im Schnitt ${diff} Minuten länger als unter der Woche – ein Hinweis auf einen sozialen Jetlag.`,hl:[{phrase:`${diff} Minuten länger`,c:'#F97316'},{phrase:'sozialen Jetlag',c:'#F97316'}],conf:'Wochentag–Wochenende-Muster'});
    } else if (slWD&&slWE&&Math.abs(slWE-slWD)<=0.2) {
      insights.push({icon:'📅',color:'#10B981',text:`Dein Schlafrhythmus ist sehr konsistent: kaum Unterschied zwischen Wochentagen (${toHM(slWD)}) und Wochenende (${toHM(slWE)}).`,hl:[{phrase:'sehr konsistent',c:'#10B981'}],conf:'Wochentag–Wochenende-Muster'});
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
      const globalAvg = av(withHRVDate,'hrv');
      const diff = ((bestAvg-globalAvg)/globalAvg*100).toFixed(0);
      if (diff > 3)
        insights.push({icon:'🗓️',color:'#2563EB',text:`${dayNames[bestDow]}s ist dein bester Erholungstag: deine HRV ist dann im Schnitt ${diff}% höher als der Gesamtdurchschnitt.`,hl:[{phrase:`${dayNames[bestDow]}s`,c:'#2563EB'},{phrase:`${diff}% höher`,c:'#10B981'}],conf:'Wochentag–HRV-Muster'});
    }
  }

  // Insight 13: Schlafregelm​ässigkeit → HRV
  const withBothSC = allData.filter(r=>r.sleepTotal!=null&&r.hrv!=null);
  if (withBothSC.length >= 14) {
    const mean = av(withBothSC,'sleepTotal');
    const consistent = withBothSC.filter(r=>Math.abs(r.sleepTotal-mean)<=0.5);
    const variable   = withBothSC.filter(r=>Math.abs(r.sleepTotal-mean)>1.0);
    const hvCons = consistent.length>=5?av(consistent,'hrv'):null;
    const hvVar  = variable.length  >=4?av(variable,  'hrv'):null;
    if (hvCons&&hvVar&&hvCons>hvVar+2) {
      const diff = (hvCons-hvVar).toFixed(0);
      insights.push({icon:'🔄',color:'#0891B2',text:`An Tagen mit regelmässigem Schlaf (nahe dem Durchschnitt) ist deine HRV im Schnitt ${diff} ms höher als nach unregelmässigen Nächten.`,hl:[{phrase:`${diff} ms höher`,c:'#10B981'},{phrase:'regelmässigem Schlaf',c:'#10B981'}],conf:'Schlafregel​m​ässigkeit–HRV'});
    }
  }

  return insights;
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
// Angabe war nach einem 🔄 nicht erkennbar, ob der Abruf etwas bewirkt hat.
function dataStandHTML() {
  if (!allData.length) return '';
  const newest = allData[allData.length-1].date;
  const ageDays = Math.round(
    (new Date(toLocalDateStr(new Date())+'T00:00:00') - new Date(newest+'T00:00:00')) / 86400000
  );
  // Kurz halten – die Zeile muss auf einem iPhone in eine Zeile passen. Das Alter
  // wird nur genannt, wenn es auffällig ist; sonst genügt Datum + Ladezeit.
  const stale  = ageDays >= 2;
  const ageTxt = stale ? ` · ${ageDays} Tage alt` : '';
  const loaded = _lastLoadTs
    ? new Date(_lastLoadTs).toLocaleTimeString('de-CH',{hour:'2-digit',minute:'2-digit'})
    : null;
  return `<div class="pg-banner-stand${stale?' stale':''}">${stale?'⚠️ ':''}Daten bis ${fmtDayShort(newest)}${ageTxt}${loaded?` · geladen ${loaded}`:''}</div>`;
}

function kpiCard({icon,label,value,unit,delta,deltaLabel,color,sub}={}) {
  const dir = delta==null?'neu':delta>0?'pos':'neg';
  const dStr = delta==null?'—':(delta>0?'↑':'↓')+' '+Math.abs(delta).toFixed(1)+'% '+(deltaLabel||trendLabel());
  return `<div class="kpi" style="border-top-color:${color||'transparent'}">
    <div class="kpi-hd"><span class="kpi-lbl">${label}</span><span class="kpi-ico">${icon}</span></div>
    <div class="kpi-val">${value}<span class="kpi-unit">${unit||''}</span></div>
    <div class="kpi-delta ${dir}">${dStr}</div>
    ${sub?`<div class="kpi-sub">${sub}</div>`:''}
  </div>`;
}

// ── sparkline SVG ─────────────────────────────────────
function sparkSVG(data, color='#4F46E5', w=80, h=26) {
  const vals = data.filter(v => v != null && !isNaN(v));
  if (vals.length < 2) return `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}"></svg>`;
  const mn = Math.min(...vals), mx = Math.max(...vals), rng = (mx-mn)||1;
  const pts = vals.map((v,i)=>{
    const x = (i/(vals.length-1))*w;
    const y = h - ((v-mn)/rng)*(h-6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const apts = vals.map((v,i)=>({x:(i/(vals.length-1))*w,y:h-((v-mn)/rng)*(h-6)-3}));
  const area = `M0,${h} ` + apts.map(p=>`L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ` L${w},${h} Z`;
  return `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block;min-width:0">
    <path d="${area}" fill="${color}" fill-opacity=".1"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}



// ── Übersicht ──────────────────────────────────────────
function pgOverview() {
  // Last day + 7-day window for mini-cards
  const lastDay = allData[allData.length-1] || {};
  const priorDays = allData.slice(-8,-1); // 7 days before last
  const avg7d = {
    sleep: av(priorDays,'sleepTotal'),
    hr:    av(priorDays,'restHR'),
    hrv:   av(priorDays,'hrv'),
    steps: av(priorDays,'steps'),
    vo2:   av(priorDays.filter(r=>r.vo2max),'vo2max')
  };
  // Health score (immer der Score des aktuellen Tages – unabhängig vom Zeitfilter)
  const hs = computeHealthScore([lastDay]);
  const prev7hs = computeHealthScore(priorDays.length ? priorDays : [lastDay]);
  const [hsCat, hsColor] = scoreCat(hs);
  // Delta nur bilden, wenn beide Seiten wirklich vorliegen.
  const hsDelta = (hs != null && prev7hs != null) ? hs - prev7hs : null;

  // Daily recommendation
  // Warning signals
  const warnSig = detectWarningSignals();
  // Pattern insights
  const patternIns = generatePatternInsights();

  // Score component breakdown for tooltip (immer aktueller Tag, passend zum Score)
  const _hsDays = [lastDay];
  const _hsSl=av(_hsDays,'sleepTotal');
  const _hsHv=av(_hsDays,'hrv'), _hsHvA=av(allData,'hrv');
  const _hsHr=av(_hsDays,'restHR');
  const _hsSt=av(_hsDays,'steps');
  const _slScore=_hsSl!=null?Math.min(100,Math.max(0,_hsSl>=7&&_hsSl<=9?100:_hsSl<4?0:_hsSl<7?((_hsSl-4)/3)*100:Math.max(0,100-(_hsSl-9)*20))):null;
  const _hvScore=_hsHv!=null&&_hsHvA?Math.min(100,(_hsHv/_hsHvA)*100):null;
  const _hrScore=_hsHr!=null?(_hsHr<=50?100:_hsHr>=80?0:(80-_hsHr)/30*100):null;
  const _stScore=_hsSt!=null?Math.min(100,(_hsSt/10000)*100):null;



  // Mini-card deltas (absolute vs 7-day avg)
  function absDelta(curr, ref) { return (curr!=null&&ref!=null) ? curr-ref : null; }
  const slLast = lastDay.sleepTotal;
  const hrLast = lastDay.restHR;
  const hvLast = lastDay.hrv;
  const stLast = lastDay.steps;
  const v2Last = lastDay.vo2max;

  function miniDeltaStr(d, fmt='num', decimals=1) {
    if (d == null) return '';
    const sign = d > 0 ? '+' : d < 0 ? '' : '±';
    if (fmt==='hm') { const h=Math.floor(Math.abs(d)),m=Math.round((Math.abs(d)%1)*60); return (d>=0?'+':'-')+h+':'+String(m).padStart(2,'0')+' vs. 7-Tage-Schnitt'; }
    if (fmt==='steps') return sign+Math.round(Math.abs(d)).toLocaleString('de-CH')+' vs. 7-Tage-Schnitt';
    return sign+Math.abs(d).toFixed(decimals)+' vs. 7-Tage-Schnitt';
  }
  function miniDeltaClass(d) { return d==null?'neu':d>0?'pos':d<0?'neg':'neu'; }

  // Verlaufs-Chart + Trend folgen jetzt dem globalen Zeitfilter (D = gewähltes Fenster).
  const D = filtered();
  const _hasWoDur = Object.values(workoutData).some(w => w?.durationMin > 0);
  const { labels: wLabels, align: wAlign, hasData: wHas } = timeDim(D);
  const wSl = wAlign('sleepTotal');
  const wHR = wAlign('restHR');
  const wHV = wAlign('hrv');
  // Training: Ø Trainingsminuten/Tag pro Bucket (0 für Tage ohne Training) → Stunden; sonst Ø Schritte.
  const _woRows = D.map(r => ({ date: r.date, _dur: _hasWoDur ? (workoutData[r.date]?.durationMin ?? 0) : null, steps: r.steps }));
  const { align: _woAlign } = timeDim(_woRows);
  const wTr = _hasWoDur ? _woAlign('_dur').map(v => v != null ? v/60 : null) : _woAlign('steps');
  const _wocheTrLabel = _hasWoDur ? 'Trainingsmin.' : 'Schritte';
  const _wocheAgg = !(timeRange === '7d' || timeRange === '1m'); // aggregierte Buckets → "Ø" im Tooltip

  // Trend-Karte: folgt dem globalen Filter (Sparkline/Schnitt/Pfeil über das Fenster D).
  function trendArrowRaw(vals) {
    if (vals.length < 4) return 'eq';
    const h1 = vals.slice(0,Math.floor(vals.length/2));
    const h2 = vals.slice(Math.floor(vals.length/2));
    const a1 = h1.reduce((a,b)=>a+b,0)/h1.length;
    const a2 = h2.reduce((a,b)=>a+b,0)/h2.length;
    const diff = a2-a1, threshold = Math.abs(a1)*0.02;
    return Math.abs(diff)<threshold?'eq':diff>0?'up':'dn';
  }
  // Der Pfeil zeigt die RICHTUNG, die Farbe die BEWERTUNG – das ist nicht dasselbe.
  // Vorher war ↑ immer grün und ↓ immer rot; ein sinkender Ruhepuls, also genau das
  // Ziel jedes Ausdauertrainings, erschien dadurch in Alarmrot.
  function trendKlasse(key, dir) {
    if (dir === 'eq') return 'neutral';
    const z = ZIELE[key];
    if (!z) return 'neutral';
    const besser = z.richtung === 'hoch' ? 'up' : 'dn';
    return dir === besser ? 'gut' : 'schlecht';
  }
  function trendGlyph(dir) { return dir==='up'?'↑':dir==='dn'?'↓':'→'; }
  const _trendTitle = {heute:'Heute','7d':'7-Tage-Trend','1m':'1-Monats-Trend','3m':'3-Monats-Trend','6m':'6-Monats-Trend','12m':'12-Monats-Trend','24m':'24-Monats-Trend'}[timeRange] || 'Trend';
  const slValsT = D.filter(r=>r.sleepTotal!=null).map(r=>r.sleepTotal);
  const hrValsT = D.filter(r=>r.restHR!=null).map(r=>r.restHR);
  const hvValsT = D.filter(r=>r.hrv!=null).map(r=>r.hrv);
  const stValsT = D.filter(r=>r.steps!=null).map(r=>r.steps);
  const slTr = trendArrowRaw(slValsT); const hrTr = trendArrowRaw(hrValsT);
  const hvTr = trendArrowRaw(hvValsT); const stTr = trendArrowRaw(stValsT);


  document.getElementById("screen-overview").innerHTML = `
    ${pgBanner('📊','Übersicht','Dein Gesundheitsüberblick auf einen Blick','#0C4A6E','#0891B2')}
    ${zielUebersichtHTML()}
    <!-- Warning signals (only shown when triggered) -->
    ${warnSig ? `<div class="warn-card">
      <div class="warn-icon">⚠️</div>
      <div>
        <div class="warn-title">Belastungssignal erkannt ${scopeBadge('letzter Tag')}</div>
        <div class="warn-text">${warnSig.text}</div>
        <div class="warn-signals">${warnSig.signals.map(s=>`<span class="warn-sig">${s}</span>`).join('')}</div>
      </div>
    </div>` : ''}

    <!-- Zeile 1: Score | Empfehlung+Tagesinsights -->
    <div class="ov-row">
      <div class="ov-score-card ov-col-narrow">
        <div class="chart-head"><h3 style="font-size:.78rem;font-weight:700">Gesundheits-Score</h3>${scopeBadge('heute')}</div>
        <div class="ov-score-body">
        <div class="ov-score-left">
          <div class="ov-ring-wrap">
            <div class="ov-score-ring">
              <svg width="120" height="120" viewBox="0 0 120 120">
                <circle cx="60" cy="60" r="48" fill="none" stroke="#E2E8F0" stroke-width="9"/>
                <circle id="hs-arc" cx="60" cy="60" r="48" fill="none" stroke="${hsColor}" stroke-width="9"
                  stroke-dasharray="0 302" stroke-linecap="round" transform="rotate(-90 60 60)"
                  style="transition:stroke-dasharray .9s ease"/>
                <text id="hs-num" x="60" y="60" text-anchor="middle" dominant-baseline="central"
                  font-size="34" font-weight="800" fill="currentColor" style="letter-spacing:-0.04em">—</text>
              </svg>
            </div>
            <div class="hs-ring-tt">
              <div class="hs-tt-title">Score-Zusammensetzung</div>
              <div class="hs-ring-tt-row"><span>🌙 Schlaf</span><span style="color:var(--txt3)">35%</span></div>
              <div class="hs-ring-tt-row"><span>💙 HRV</span><span style="color:var(--txt3)">30%</span></div>
              <div class="hs-ring-tt-row"><span>❤️ Ruhepuls</span><span style="color:var(--txt3)">20%</span></div>
              <div class="hs-ring-tt-row"><span>🚶 Schritte</span><span style="color:var(--txt3)">15%</span></div>
            </div>
          </div>
          <div class="ov-score-cat" style="color:${hsColor}">${hsCat}</div>
        </div>
        <div class="hs-komp-rows">
        <div class="hs-komp-title">Score-Komponenten</div>
        ${(()=>{
          const bl30hrv=calculateBaseline('hrv',30);
          const bl30hr=calculateBaseline('restHR',30);
          const bl30sl=calculateBaseline('sleepTotal',30);
          const last=allData[allData.length-1]||{};
          let slPts=null,hvPts=null,hrPts=null,stPts=null;
          if(last.sleepTotal!=null&&bl30sl!=null){const d=last.sleepTotal-bl30sl;slPts=Math.round(d*4);}
          if(last.hrv!=null&&bl30hrv!=null){const d=calculateDeviation(last.hrv,bl30hrv);hvPts=Math.round((d||0)*0.4);}
          if(last.restHR!=null&&bl30hr!=null){const d=calculateDeviation(last.restHR,bl30hr);hrPts=Math.round(-(d||0)*0.3);}
          if(last.steps!=null){stPts=last.steps>=10000?3:last.steps>=7000?1:last.steps>=4000?0:-2;}
          function kompRow(icon,lbl,score,pts){
            if(score==null)return'';
            const c=score>=70?'#10B981':score>=40?'#F97316':'#EF4444';
            const ttTxt=pts!=null?(pts>0?`+${pts} Pkt vs. 30-Tage-Schnitt`:`${pts} Pkt vs. 30-Tage-Schnitt`):'Keine Änderungsdaten';
            return `<div class="hs-komp-row">
              <span class="hs-komp-lbl">${icon} ${lbl}</span>
              <span class="hs-komp-val" style="color:${c}">${Math.round(score)}</span>
              <div class="hs-komp-bar-wrap" data-tt="${ttTxt}">
                <div class="hs-komp-bar-fill" style="width:${score}%;background:${c}"></div>
              </div>
            </div>`;
          }
          return [
            kompRow('🌙','Schlaf',_slScore,slPts),
            kompRow('💙','HRV',_hvScore,hvPts),
            kompRow('❤️','Ruhepuls',_hrScore,hrPts),
            kompRow('🚶','Schritte',_stScore,stPts)
          ].join('');
        })()}
        </div>
        </div><!-- /ov-score-body -->
        <div class="ov-score-footer">
          ${hs==null?`<div class="ov-score-interp">Für ${lastDay.date?fmtDayFull(lastDay.date):'den letzten Tag'} liegen noch keine Messwerte vor. Sobald Schlaf, Ruhepuls, HRV oder Schritte im Sheet stehen, wird der Score berechnet.</div>`:`
          <div class="ov-score-delta">${hsDelta!=null?`${hsDelta>=0?'+':''}${hsDelta} vs. 7-Tage-Schnitt`:'Kein Vergleichswert'}</div>
          <div class="ov-score-interp">${(()=>{
            if(hsDelta==null)return'Für die Vorwoche liegen zu wenige Daten für einen Vergleich vor.';
            if(hsDelta>=8)return'<span style="color:#10B981">Deutliche Verbesserung</span> gegenüber der letzten Woche';
            if(hsDelta>=3)return'<span style="color:#10B981">Leichte Verbesserung</span> gegenüber letzter Woche';
            if(hsDelta>=-2)return'Score ist <span style="color:#94A3B8">stabil</span>, kaum Veränderung';
            if(hsDelta>=-7)return'Leicht <span style="color:#F97316">unter dem Wochenschnitt</span> – beobachten';
            return'Deutlich <span style="color:#EF4444">unter dem Wochenschnitt</span> – Erholung empfohlen';
          })()}</div>`}
        </div>
      </div>
      <!-- Aktuelle Tageswerte. Die frühere "Heutige Empfehlung" saß hier darüber und
           wurde auf Wunsch entfernt; die Belastungswarnung oben auf der Seite bleibt. -->
      <div class="ov-combo-card ov-col-wide">
        <div class="scope-row">${scopeBadge('letzter Tag · Vergleich: Ø 7 Tage')}</div>
        <div class="ti-metrics">
          ${slLast!=null?`<div class="ti-metric" style="border-top:3px solid #2186E8;background:rgba(33,134,232,.05)">
            <div class="ti-metric-lbl">🌙 Schlaf</div>
            <div class="ti-metric-val">${toHM(slLast)}</div>
            ${avg7d.sleep!=null?`<div class="ti-metric-delta ${slLast-avg7d.sleep>0.08?'pos':slLast-avg7d.sleep<-0.08?'neg':'neu'}">${(()=>{const d=slLast-avg7d.sleep;const m=Math.round(d*60);const sign=m>=0?'+':'-';const abs=Math.abs(m);if(abs>=60){const h=Math.floor(abs/60);const min=abs%60;return sign+h+'h '+String(min).padStart(2,'0')+'min vs. Ø';}return sign+abs+'m vs. Ø';})()}</div>`:''}
          </div>`:'<div class="ti-metric"></div>'}
          ${hrLast!=null?`<div class="ti-metric" style="border-top:3px solid #EF4444;background:rgba(239,68,68,.05)">
            <div class="ti-metric-lbl">❤️ Ruhepuls</div>
            <div class="ti-metric-val">${Math.round(hrLast)} bpm</div>
            ${avg7d.hr!=null?`<div class="ti-metric-delta ${hrLast-avg7d.hr<-0.5?'pos':hrLast-avg7d.hr>0.5?'neg':'neu'}">${(()=>{const d=hrLast-avg7d.hr;return (d>=0?'+':'')+d.toFixed(0)+' vs. Ø';})()}</div>`:''}
          </div>`:'<div class="ti-metric"></div>'}
          ${hvLast!=null?`<div class="ti-metric" style="border-top:3px solid #2563EB;background:rgba(37,99,235,.05)">
            <div class="ti-metric-lbl">💙 HRV</div>
            <div class="ti-metric-val">${Math.round(hvLast)} ms</div>
            ${avg7d.hrv!=null?`<div class="ti-metric-delta ${hvLast-avg7d.hrv>0.5?'pos':hvLast-avg7d.hrv<-0.5?'neg':'neu'}">${(()=>{const d=hvLast-avg7d.hrv;return (d>=0?'+':'')+d.toFixed(0)+' vs. Ø';})()}</div>`:''}
          </div>`:'<div class="ti-metric"></div>'}
          ${(()=>{
            const trMin=workoutData[lastDay.date]?.durationMin??null;
            const trAvg=(()=>{const v=allData.slice(-7).map(r=>workoutData[r.date]?.durationMin).filter(x=>x!=null);return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;})();
            if(trMin!=null){return`<div class="ti-metric" style="border-top:3px solid #F97316;background:rgba(249,115,22,.07)">
              <div class="ti-metric-lbl">🏃 Training</div>
              <div class="ti-metric-val">${Math.round(trMin)} min</div>
              ${trAvg!=null?`<div class="ti-metric-delta ${trMin-trAvg>2?'pos':trMin-trAvg<-2?'neu':'neu'}">${(()=>{const d=Math.round(trMin-trAvg);return(d>=0?'+':'')+d+' min vs. Ø';})()}</div>`:''}
            </div>`;}
            return`<div class="ti-metric" style="border-top:3px solid #10B981;background:rgba(16,185,129,.05)">
              <div class="ti-metric-lbl">🚶 Schritte</div>
              <div class="ti-metric-val">${stLast!=null?Math.round(stLast).toLocaleString('de-CH'):'—'}</div>
              ${stLast!=null&&avg7d.steps!=null?`<div class="ti-metric-delta ${stLast-avg7d.steps>10?'pos':stLast-avg7d.steps<-10?'neg':'neu'}">${(()=>{const d=Math.round(stLast-avg7d.steps);return(d>=0?'+':'')+d.toLocaleString('de-CH')+' vs. Ø';})()}</div>`:''}
            </div>`;
          })()}
        </div>
      </div>
    </div>
    <!-- Zeile 2: Verlauf (oberhalb des Trends) -->
    <div class="chart-card" style="margin-bottom:.7rem">
      <h3 style="margin-bottom:.35rem">Verlauf</h3>
      <div class="chart-legend" style="margin-bottom:.3rem">
        <div class="cl-item"><span class="cl-dot" style="background:#7C3AED"></span>Schlaf (h)</div>
        <div class="cl-item"><span class="cl-dot" style="background:#EF4444"></span>Ruhepuls (bpm)</div>
        <div class="cl-item"><span class="cl-dot" style="background:#2563EB"></span>HRV (ms)</div>
        <div class="cl-item"><span class="cl-dot" style="background:${_hasWoDur?'#F97316':'#059669'}"></span>${_hasWoDur?'Trainingsmin.':'Schritte'}</div>
      </div>
      <div class="chart-wrap" style="height:240px"><canvas id="c-woche"></canvas></div>
    </div>
    <!-- Zeile 3: Monats-Trend (unterhalb des Verlaufs) -->
    <div class="chart-card" style="margin-bottom:.7rem">
      <div class="chart-head"><h3>${_trendTitle}</h3></div>
      <div>
        ${[
          {key:'sleepTotal', farbe:'#7C3AED', vals:slValsT, dir:slTr, wert:av(D,'sleepTotal')},
          {key:'restHR',     farbe:'#EF4444', vals:hrValsT, dir:hrTr, wert:av(D,'restHR')},
          {key:'hrv',        farbe:'#2563EB', vals:hvValsT, dir:hvTr, wert:av(D,'hrv')},
          {key:'steps',      farbe:'#059669', vals:stValsT, dir:stTr, wert:av(D,'steps')}
        ].map(m => `
        <div class="mt-row">
          <div class="mt-dot" style="background:${m.farbe}"></div>
          <div class="mt-lbl">${ZIELE[m.key].label} ${infoI(m.key)}</div>
          <div class="mt-spark">${sparkSVG(m.vals,m.farbe,160,24)}</div>
          <div class="mt-val">${m.wert!=null?'Ø '+ZIELE[m.key].fmt(m.wert):'—'}</div>
          <div class="mt-arrow ${trendKlasse(m.key,m.dir)}">${trendGlyph(m.dir)}</div>
        </div>
        <div class="mt-ziel">${zielBadge(m.key, m.wert)}</div>`).join('')}
      </div>
    </div>

    <!-- Pattern Insights -->
    ${patternIns.length>0?`
    <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--txt3);margin-bottom:.4rem;margin-top:.3rem;display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">📊 Muster &amp; Zusammenhänge ${scopeBadge('gesamter Datenbestand')}</div>
    <div class="pi-grid">
      ${patternIns.map(p=>{
        let txt=p.text;
        if(p.hl)p.hl.forEach(h=>{txt=txt.replace(h.phrase,`<span style="color:${h.c};font-weight:700">${h.phrase}</span>`);});
        return`<div class="pi-card" style="border-top-color:${p.color}">
        <div class="pi-head"><span class="pi-icon">${p.icon}</span><span class="pi-conf">${p.conf}</span></div>
        <div class="pi-text">${txt}</div>
      </div>`;}).join('')}
    </div>`:''}
    `;

  // Animate score ring – ohne Score bleibt der Ring leer und die Zahl ein "—".
  setTimeout(()=>{
    const arc=document.getElementById('hs-arc'), num=document.getElementById('hs-num');
    const c=2*Math.PI*48;
    if(arc) arc.setAttribute('stroke-dasharray', hs!=null ? `${c*hs/100} ${c}` : `0 ${c}`);
    if(num) num.textContent = hs!=null ? hs : '—';
  },80);

  // Verlaufs-Chart (folgt dem globalen Zeitfilter; Aggregation via timeDim)
  function _wocheTooltipLabel(ctx){
    const lbl=ctx.dataset.label, v=ctx.raw, agg=_wocheAgg;
    // Bei aggregierten Buckets (Wochen-/Monatswerte) ist der Wert ein Tagesmittel → "Ø …/d".
    const pre=agg?'Ø ':'', per=agg?'':'';
    if(lbl==='Schlaf (h)')return`${pre}Schlaf: ${v!=null?toHM(v)+per:'—'}`;
    if(lbl===_wocheTrLabel){
      if(_hasWoDur){const mins=Math.round((v??0)*60);return`${pre}${_wocheTrLabel}: ${mins} min${per}`;}
      return`${pre}${_wocheTrLabel}: ${v!=null?Math.round(v).toLocaleString('de-CH')+per:'—'}`;
    }
    if(lbl==='Ruhepuls') return `${pre}Ruhepuls: ${v!=null?Math.round(v)+' bpm'+per:'—'}`;
    if(lbl==='HRV')      return `${pre}HRV: ${v!=null?Math.round(v)+' ms'+per:'—'}`;
    return lbl+': '+(v!=null?v.toFixed(1):'—');
  }
  if(wHas){
    mkC('c-woche',{
      data:{labels:wLabels,datasets:[
        {type:'bar',label:'Schlaf (h)',data:wSl,backgroundColor:'rgba(124,58,237,.35)',borderRadius:4,yAxisID:'yL'},
        {type:'line',label:'Ruhepuls',data:wHR,borderColor:'#EF4444',backgroundColor:'transparent',tension:.35,pointRadius:3,pointBackgroundColor:'#EF4444',yAxisID:'yR',spanGaps:true},
        {type:'line',label:'HRV',data:wHV,borderColor:'#2563EB',backgroundColor:'transparent',tension:.35,pointRadius:3,pointBackgroundColor:'#2563EB',yAxisID:'yR',spanGaps:true},
        {type:'line',label:_wocheTrLabel,data:wTr,borderColor:'#F97316',backgroundColor:'transparent',tension:.35,pointRadius:3,pointBackgroundColor:'#F97316',yAxisID:'yL',spanGaps:true}
      ]},
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,callbacks:{label:ctx=>_wocheTooltipLabel(ctx)}}},
        scales:{
          x:{...gx},
          yL:{position:'left',...gy,suggestedMin:0,suggestedMax:10,ticks:{...gy.ticks,callback:v=>Math.floor(v)+'h'}},
          yR:{position:'right',display:true,grid:{display:false},ticks:{color:'#94A3B8',font:{size:9}},suggestedMin:30,suggestedMax:100}
        }
      }
    });
  }
}

// ── Herz ───────────────────────────────────────────────
function pgHerz() {
  const D=filtered(), P=prevPeriod();
  const hrD=av(D,'restHR'), hrP=av(P,'restHR');
  const hvD=av(D,'hrv'), hvP=av(P,'hrv');
  const hrf=D.filter(r=>r.restHR!=null);
  const hrMin=hrf.length?Math.min(...hrf.map(r=>r.restHR)):null;
  const hrMax=hrf.length?Math.max(...hrf.map(r=>r.restHR)):null;
  const hrStd=sdv(hrf,'restHR');
  const hvf=D.filter(r=>r.hrv!=null);
  const hvMin=hvf.length?Math.min(...hvf.map(r=>r.hrv)):null;
  const hvMax=hvf.length?Math.max(...hvf.map(r=>r.hrv)):null;
  const hvStd=sdv(hvf,'hrv');

  // Weekday vs weekend HR & HRV
  const hrSplit=splitWeekWknd(hrf);
  const hrWeek=av(hrSplit.wkd,'restHR');
  const hrWknd=av(hrSplit.wknd,'restHR');
  const hvSplit=splitWeekWknd(hvf);
  const hvWeek=av(hvSplit.wkd,'hrv');
  const hvWknd=av(hvSplit.wknd,'hrv');

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

  const {labels:tL,align:tA,hasData:tHD}=timeDim(D);
  const tdL=timeDim(D,true);
  const hrMa=tA('restHR'); const hvMa=tA('hrv');
  const hrMaL=tdL.align('restHR'); const hvMaL=tdL.align('hrv');

  document.getElementById("screen-herz").innerHTML=`
    ${pgBanner('❤️','Herz','Ist mein Herz-Kreislauf-System stabil oder zeigt es Belastung?','#7F1D1D','#EF4444')}
    ${herzInterpret?`<div class="rec-card" style="--rec-color:${herzInterpret.color};margin-bottom:.7rem">
      <div class="rec-status" style="background:${herzInterpret.color}22;color:${herzInterpret.color}">❤️ ${herzInterpret.status}</div>
      <div class="rec-title">Herz-Kreislauf Einordnung ${infoI('baseline')} ${scopeBadge('letzter Tag vs. 30-Tage-Baseline')}</div>
      <div class="rec-text">${herzInterpret.text}</div>
    </div>`:''}
    <div class="two-col-eq">
      <div class="chart-card split2" style="margin-bottom:0">
        <h3>❤️ Ruhepuls-Einordnung ${infoI('restHR')}</h3>
        <p style="font-size:.72rem;color:var(--txt2);margin-bottom:.5rem">
          Ø ${fn(hrD,0)} bpm → <span style="color:${hrZoneColor};font-weight:700">${hrZoneName}</span>
        </p>
        <div style="margin:.4rem 0">
          <div class="goal-row"><span class="goal-lbl" style="color:#10B981">&lt; 50 bpm</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nAthlete/nTot*100}%;background:#10B981"></div></div><span class="goal-val"><span class="goal-num">${nAthlete}</span><span style="color:var(--txt3)">(${(nAthlete/nTot*100).toFixed(0)}%)</span></span></div>
          <div class="goal-row"><span class="goal-lbl" style="color:#84CC16">50–65 bpm</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nGood/nTot*100}%;background:#84CC16"></div></div><span class="goal-val"><span class="goal-num">${nGood}</span><span style="color:var(--txt3)">(${(nGood/nTot*100).toFixed(0)}%)</span></span></div>
          <div class="goal-row"><span class="goal-lbl" style="color:#EAB308">65–75 bpm</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nNorm/nTot*100}%;background:#EAB308"></div></div><span class="goal-val"><span class="goal-num">${nNorm}</span><span style="color:var(--txt3)">(${(nNorm/nTot*100).toFixed(0)}%)</span></span></div>
          <div class="goal-row"><span class="goal-lbl" style="color:#EF4444">&gt; 75 bpm</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nHigh/nTot*100}%;background:#EF4444"></div></div><span class="goal-val"><span class="goal-num">${nHigh}</span><span style="color:var(--txt3)">(${(nHigh/nTot*100).toFixed(0)}%)</span></span></div>
        </div>
        <div class="stats-list" style="margin-top:.6rem">
          ${hrWeek!=null||hrWknd!=null?`<div class="stat-row"><span class="stat-lbl">Ø Wochentag</span><span class="stat-val">${hrWeek!=null?fn(hrWeek,0)+' bpm':'—'}</span></div>
          <div class="stat-row"><span class="stat-lbl">Ø Wochenende</span><span class="stat-val">${hrWknd!=null?fn(hrWknd,0)+' bpm':'—'}</span></div>
          ${hrWeek!=null&&hrWknd!=null?`<div class="stat-row"><span class="stat-lbl">Differenz</span><span class="stat-val" style="color:var(--txt2)">${hrWknd<hrWeek?'':'+'}${fn(hrWknd-hrWeek,0)} bpm</span></div>`:``}`:''}
          <div class="stat-row"><span class="stat-lbl">Messpunkte</span><span class="stat-val">${hrf.length}d <span style="color:var(--txt3)">(${D.length>0?(hrf.length/D.length*100).toFixed(0):'—'}%)</span></span></div>
        </div>
      </div>
      <div class="chart-card split2" style="margin-bottom:0">
        <h3>💙 HRV-Einordnung ${infoI('hrv')}</h3>
        <p style="font-size:.72rem;color:var(--txt2);margin-bottom:.5rem">
          Ø ${fn(hvD,0)} ms → <span style="color:${hvCatColor};font-weight:700">${hvCatName}</span>
        </p>
        <div style="margin:.4rem 0">
          <div class="goal-row"><span class="goal-lbl" style="color:#10B981">≥ 70 ms</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nHVHigh/nHVTot*100}%;background:#10B981"></div></div><span class="goal-val"><span class="goal-num">${nHVHigh}</span><span style="color:var(--txt3)">(${(nHVHigh/nHVTot*100).toFixed(0)}%)</span></span></div>
          <div class="goal-row"><span class="goal-lbl" style="color:#84CC16">50–70 ms</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nHVGood/nHVTot*100}%;background:#84CC16"></div></div><span class="goal-val"><span class="goal-num">${nHVGood}</span><span style="color:var(--txt3)">(${(nHVGood/nHVTot*100).toFixed(0)}%)</span></span></div>
          <div class="goal-row"><span class="goal-lbl" style="color:#EAB308">30–50 ms</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nHVMid/nHVTot*100}%;background:#EAB308"></div></div><span class="goal-val"><span class="goal-num">${nHVMid}</span><span style="color:var(--txt3)">(${(nHVMid/nHVTot*100).toFixed(0)}%)</span></span></div>
          <div class="goal-row"><span class="goal-lbl" style="color:#EF4444">&lt; 30 ms</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nHVLow/nHVTot*100}%;background:#EF4444"></div></div><span class="goal-val"><span class="goal-num">${nHVLow}</span><span style="color:var(--txt3)">(${(nHVLow/nHVTot*100).toFixed(0)}%)</span></span></div>
        </div>
        <div class="stats-list" style="margin-top:.6rem">
          ${hvWeek!=null||hvWknd!=null?`<div class="stat-row"><span class="stat-lbl">Ø Wochentag</span><span class="stat-val">${hvWeek!=null?fn(hvWeek,0)+' ms':'—'}</span></div>
          <div class="stat-row"><span class="stat-lbl">Ø Wochenende</span><span class="stat-val">${hvWknd!=null?fn(hvWknd,0)+' ms':'—'}</span></div>
          ${hvWeek!=null&&hvWknd!=null?`<div class="stat-row"><span class="stat-lbl">Differenz</span><span class="stat-val" style="color:var(--txt2)">${hvWknd>hvWeek?'+':''}${fn(hvWknd-hvWeek,0)} ms</span></div>`:``}`:''}
          <div class="stat-row"><span class="stat-lbl">Messpunkte</span><span class="stat-val">${hvf.length}d <span style="color:var(--txt3)">(${D.length>0?(hvf.length/D.length*100).toFixed(0):'—'}%)</span></span></div>
        </div>
      </div>
    </div>

    <div class="chart-card">
      <h3>❤️ Ruhepuls &amp; HRV</h3>
      <div class="chart-legend">
        <div class="cl-item"><span class="cl-line" style="background:var(--heart)"></span>Ruhepuls${hrD!=null?` · Ø <strong>${fn(hrD,0)} bpm</strong>`:''}</div>
        <div class="cl-item"><span class="cl-line" style="background:var(--hrv)"></span>HRV${hvD!=null?` · Ø <strong>${fn(hvD,0)} ms</strong>`:''}</div>
        <div class="cl-item"><span class="cl-line" style="background:rgba(100,116,139,.55)"></span>Ziellinien</div>
      </div>
      <div class="chart-note">Beide Kurven teilen sich eine Skala: gleiche Höhe = gleicher Zahlenwert.</div>
      <div class="chart-wrap" style="height:210px"><canvas id="c-herz"></canvas></div>
      <!-- Die Wochentag/Wochenende-Aufstellung stand hier ein zweites Mal, identisch
           zu den beiden Einordnungs-Karten weiter oben. Auf einem 375-px-Bildschirm
           scrollt man sonst an denselben vier Zahlen zweimal vorbei. -->
    </div>
`;

  if(tHD){
    const hrAvgLine=hrMaL.map(()=>hrD);
    const hvAvgLine=hvMaL.map(()=>hvD);
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
    const _yAxis=extra=>({min:_yMin,max:_yMax,ticks:{color:'#94A3B8',font:{size:9},stepSize:_yStep,callback:v=>Math.round(v)},...extra});
    mkC('c-herz',{type:'line',data:{labels:tdL.labels,datasets:[
      {label:'Ruhepuls',data:hrMaL,borderColor:'#EF4444',backgroundColor:'rgba(239,68,68,.07)',tension:.3,fill:true,pointRadius:3,spanGaps:true,yAxisID:'yL'},
      {label:'HRV',data:hvMaL,borderColor:'#2563EB',backgroundColor:'rgba(37,99,235,.07)',tension:.3,fill:true,pointRadius:3,spanGaps:true,yAxisID:'yR'},
      {label:'Ø Ruhepuls',data:hrAvgLine,borderColor:'rgba(239,68,68,.45)',borderDash:[5,4],pointRadius:0,borderWidth:1.5,tension:0,yAxisID:'yL'},
      {label:'Ø HRV',data:hvAvgLine,borderColor:'rgba(37,99,235,.45)',borderDash:[5,4],pointRadius:0,borderWidth:1.5,tension:0,yAxisID:'yR'},
      zielLinie('restHR', hrMaL.length, 'yL'),
      zielLinie('hrv',    hvMaL.length, 'yR')
    ]},options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,
        filter:item=>item.dataset.label==='Ruhepuls'||item.dataset.label==='HRV'}},
      scales:{x:gx,
        yL:_yAxis({position:'left',grid:{color:GRID_COLOR}}),
        // Rechte Achse ausgeblendet: sie ist mit der linken synchronisiert und zeigte
        // exakt dieselben Zahlen – auf dem iPhone verschenkte Breite ohne Aussage.
        yR:_yAxis({position:'right',display:false,grid:{display:false}})}}});
  }
}

// ── Schlaf ─────────────────────────────────────────────
function pgSchlaf() {
  const D=filtered(), P=prevPeriod();
  const last14sl = allData.slice(-14);
  const sleepDebt = calculateSleepDebt(last14sl);
  const debtLvl = sleepDebtLevel(sleepDebt.perNight);
  const slD_last = (allData[allData.length-1]||{}).sleepTotal;
  const slCoachHint = slD_last!=null
    ? slD_last >= 7.5
      ? 'Dein Schlaf war ausreichend. Die Erholung wird unterstützt. Eine moderate Trainingsbelastung ist heute möglich.'
      : slD_last >= 6.5
        ? 'Dein Schlaf lag leicht unter Zielwert. Vermeide heute sehr intensive Belastung und priorisiere frühere Schlafenszeit.'
        : 'Schlafdauer unter 6.5h. Heute möglichst auf intensives Training verzichten. Fokus auf Erholung.'
    : 'Schlafeinschätzung noch nicht verfügbar.';
  const slD=av(D,'sleepTotal'), slP=av(P,'sleepTotal');
  const scD=av(D,'sleepScore'), scP=av(P,'sleepScore');
  const dpD=av(D,'sleepDeep')||av(D,'deepSleep'), dpP=av(P,'sleepDeep')||av(P,'deepSleep');
  const remD=av(D,'sleepRem')||av(D,'remSleep'), remP=av(P,'sleepRem')||av(P,'remSleep');
  const lD=av(D,'sleepCore')||av(D,'lightSleep'), lP=av(P,'sleepCore')||av(P,'lightSleep');
  const slStd=sdv(D.filter(r=>r.sleepTotal!=null),'sleepTotal');
  const slRows=D.filter(r=>r.sleepTotal!=null);
  const slMax=slRows.length?Math.max(...slRows.map(r=>r.sleepTotal)):null;
  const slMin=slRows.length?Math.min(...slRows.map(r=>r.sleepTotal)):null;
  // Per-night breakdown for sleep debt tooltip
  const WDAYS=['So','Mo','Di','Mi','Do','Fr','Sa'];
  const debtTooltipRows=last14sl.filter(r=>r.sleepTotal!=null).map(r=>{
    const d=SLEEP_TARGET_H-r.sleepTotal;
    const [yr,mo,dy]=r.date.split('-');
    const wd=WDAYS[new Date(r.date+'T00:00:00').getDay()];
    return `<div class="debt-tt-row"><span class="debt-tt-date">${wd} ${dy}.${mo}.</span><span class="debt-tt-slept">${toHM(r.sleepTotal)}</span><span class="debt-tt-d ${d>0?'neg':'pos'}">${d>0?'-'+toHM(d):'+'+toHM(-d)}</span></div>`;
  }).join('');
  const debtTtNDays=last14sl.filter(r=>r.sleepTotal!=null).length;
  const {labels:tL,align:tA,hasData:tHD}=timeDim(D);
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
  const awD=av(D.filter(r=>r.sleepAwake!=null),'sleepAwake');

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
  const slWeek=av(slSplit.wkd,'sleepTotal');
  const slWknd=av(slSplit.wknd,'sleepTotal');

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
  const avgOnset=avgCircTime(D,sleepStartField,true);
  const avgWake=avgCircTime(D,sleepEndField,false);

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

  const phaseBar=hasPhases&&slD?`
    <div class="phase-bar">
      ${awD!=null?`<div class="phase-seg" style="width:${awD/total*100}%;background:#F97316"></div>`:''}
      ${remD!=null?`<div class="phase-seg" style="width:${remD/total*100}%;background:#5BC8FA"></div>`:''}
      ${lD!=null?`<div class="phase-seg" style="width:${lD/total*100}%;background:#2186E8"></div>`:''}
      ${dpD!=null?`<div class="phase-seg" style="width:${dpD/total*100}%;background:#1E1B6E"></div>`:''}
    </div>
    <div class="phase-legend">
      ${awD!=null?`<div class="pl-item"><span class="pl-dot" style="background:#F97316"></span>Wach ${toHM(awD)} (${awPct}%)</div>`:''}
      ${remD!=null?`<div class="pl-item"><span class="pl-dot" style="background:#5BC8FA"></span>REM ${toHM(remD)} (${remPct}%)</div>`:''}
      ${lD!=null?`<div class="pl-item"><span class="pl-dot" style="background:#2186E8"></span>Leicht ${toHM(lD)} (${lPct}%)</div>`:''}
      ${dpD!=null?`<div class="pl-item"><span class="pl-dot" style="background:#1E1B6E"></span>Tiefschlaf ${toHM(dpD)} (${dpPct}%)</div>`:''}
    </div>`:hasPhases?'':'';

  document.getElementById("screen-schlaf").innerHTML=`
    ${pgBanner('🌙','Schlaf','War mein Schlaf ausreichend und erholsam?','#1E3A8A','#7C3AED')}
    <div class="ch-card">
      <h4>💬 Was bedeutet das für heute? ${scopeBadge('letzte Nacht')}</h4>
      <p>${slCoachHint}</p>
    </div>
    ${hasScore?`<div class="kpi-grid kpi-grid-1">${kpiCard({icon:'⭐',label:'Ø Schlaf-Score',value:fn(scD,0),unit:'',delta:pct(scD,scP),color:'var(--sleep)'})}</div>`:''}

    <!-- Zeile 2: Schlafqualität-Verteilung | Schlafschuld -->
    <div class="two-col-eq">
      <div class="chart-card split2" style="margin-bottom:0">
        <h3>📊 Schlafqualität-Verteilung</h3>
        <div style="margin:.4rem 0">
          <div class="goal-row"><span class="goal-lbl" style="color:#10B981">&gt; 8.5h</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nOver85/nTot*100}%;background:#10B981"></div></div><span class="goal-val"><span class="goal-num">${nOver85}</span><span style="color:var(--txt3)">(${(nOver85/nTot*100).toFixed(0)}%)</span></span></div>
          <div class="goal-row"><span class="goal-lbl" style="color:#84CC16">7 – 8.5h</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${n7to85/nTot*100}%;background:#84CC16"></div></div><span class="goal-val"><span class="goal-num">${n7to85}</span><span style="color:var(--txt3)">(${(n7to85/nTot*100).toFixed(0)}%)</span></span></div>
          <div class="goal-row"><span class="goal-lbl" style="color:#EAB308">6 – 7h</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${n6to7/nTot*100}%;background:#EAB308"></div></div><span class="goal-val"><span class="goal-num">${n6to7}</span><span style="color:var(--txt3)">(${(n6to7/nTot*100).toFixed(0)}%)</span></span></div>
          <div class="goal-row"><span class="goal-lbl" style="color:#EF4444">≤ 6h</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nBelow6/nTot*100}%;background:#EF4444"></div></div><span class="goal-val"><span class="goal-num">${nBelow6}</span><span style="color:var(--txt3)">(${(nBelow6/nTot*100).toFixed(0)}%)</span></span></div>
        </div>
        <div class="stats-list" style="margin-top:.5rem">
          <div class="stat-row"><span class="stat-lbl">Beste Nacht</span><span class="stat-val" style="color:#10B981">${toHM(slMax)}</span></div>
          <div class="stat-row"><span class="stat-lbl">Kürzeste Nacht</span><span class="stat-val" style="color:#EF4444">${toHM(slMin)}</span></div>
          <div class="stat-row"><span class="stat-lbl">Konsistenz</span><span class="stat-val" style="color:${consColor}">${consLabel}</span></div>
          <div class="stat-row"><span class="stat-lbl">Messpunkte</span><span class="stat-val">${slRows.length}d <span style="color:var(--txt3)">(${D.length>0?(slRows.length/D.length*100).toFixed(0):'—'}%)</span></span></div>
        </div>
      </div>
      <div class="chart-card" style="margin-bottom:0">
        <div class="chart-head"><h3>🌙 Schlafschuld</h3>${scopeBadge('letzte 14 Nächte')}</div>
        <div class="stats-list">
          <div class="stat-row"><span class="stat-lbl">Zielschlaf pro Nacht</span><span class="stat-val">${toHM(SLEEP_TARGET_H)}</span></div>
          <div class="stat-row"><span class="stat-lbl">Letzte Nacht</span><span class="stat-val" style="color:${sleepDebt.last!=null?(sleepDebt.last>0?'#EF4444':'#10B981'):'var(--txt3)'}">${sleepDebt.last!=null?(sleepDebt.last>0?'−'+toHM(sleepDebt.last):'+'+toHM(-sleepDebt.last)):'—'}</span></div>
          <div class="stat-row"><span class="stat-lbl">Ø pro Nacht</span><span class="stat-val" style="color:${debtLvl.color}">${sleepDebt.perNight!=null?(sleepDebt.perNight>0?'−'+toHM(sleepDebt.perNight):'+'+toHM(-sleepDebt.perNight)):'—'}</span></div>
          <div class="stat-row"><span class="stat-lbl">Summe über ${sleepDebt.nDays} Nächte</span><span class="stat-val" style="color:${sleepDebt.total!=null?(sleepDebt.total>0?'#EF4444':'#10B981'):'var(--txt3)'}">${sleepDebt.total!=null?(sleepDebt.total>0?'−'+toHM(sleepDebt.total):'+'+toHM(-sleepDebt.total)):'—'}</span></div>
        </div>
        <div class="debt-bar-wrap">
          ${sleepDebt.perNight!=null?`<div style="font-size:.6rem;color:var(--txt3);margin-bottom:.3rem">${debtLvl.label} · Balken voll bei Ø ${toHM(SLEEP_DEBT_FULL_BAR_H)} Defizit pro Nacht</div>
          <div class="debt-tt-wrap" tabindex="0" role="button" aria-label="Zusammensetzung der Schlafschuld anzeigen">
            <div class="debt-bar-bg"><div class="debt-bar-fill" style="width:${Math.min(100,Math.max(0,(sleepDebt.perNight/SLEEP_DEBT_FULL_BAR_H)*100))}%;background:${debtLvl.color}"></div></div>
            <div class="debt-tt">
              <div class="debt-tt-title">Zusammensetzung – ${debtTtNDays} Nächte · Ziel ${toHM(SLEEP_TARGET_H)}/Nacht</div>
              <div class="debt-tt-hd"><span>Datum</span><span>Geschlafen</span><span style="text-align:right">Schuld / Plus</span></div>
              ${debtTooltipRows}
            </div>
          </div>`:''}
        </div>
      </div>
    </div>

    <!-- Zeile 3: Schlafdauer pro Monat | Schlafphasen-Aufteilung -->
    <div class="two-col-eq">
      <div class="chart-card" style="margin-bottom:0">
        <h3>🌙 ${is7D()?'Schlafdauer letzte 7 Tage':'Schlafdauer pro Monat'}</h3>
        ${slD!=null?`<div class="chart-legend" style="margin-bottom:.3rem"><div class="cl-item"><span class="cl-line" style="background:rgba(124,58,237,.55);border-style:dashed"></span>Ø Schlafdauer · <strong>${toHM(slD)}</strong></div></div>`:''}
        <div class="chart-wrap" style="height:155px"><canvas id="c-sl-dur"></canvas></div>
        ${slWeek!=null||slWknd!=null?`<div class="stats-list" style="margin-top:.5rem;border-top:1px solid var(--border);padding-top:.4rem">
          <div class="stat-row"><span class="stat-lbl">Ø Wochentag (Mo–Fr)</span><span class="stat-val">${slWeek!=null?toHM(slWeek)+'':'—'}</span></div>
          <div class="stat-row"><span class="stat-lbl">Ø Wochenende (Sa–So)</span><span class="stat-val">${slWknd!=null?toHM(slWknd)+'':'—'}</span></div>
          ${slWeek!=null&&slWknd!=null?`<div class="stat-row"><span class="stat-lbl">Differenz</span><span class="stat-val" style="color:var(--txt2)">${(()=>{const d=slWknd-slWeek,a=Math.abs(d),s=d>=0?'+':'−',m=Math.round(a*60);return m<60?s+m+' min':s+Math.floor(a)+'h'+(Math.round((a%1)*60)>0?' '+Math.round((a%1)*60)+'min':'');})()}</span></div>
          ${(()=>{
            // Einordnung statt Wertung durch Farbe. Vorher war "am Wochenende länger"
            // hier grün, in den Muster-Insights aber orange als sozialer Jetlag – zwei
            // gegenteilige Urteile zur selben Tatsache, einen Bildschirm auseinander.
            const d=slWknd-slWeek;
            if(d>=0.75) return `<div class="stat-hint">Deutlich mehr Schlaf am Wochenende deutet auf einen <strong>sozialen Jetlag</strong> hin: Unter der Woche fehlt Schlaf, der am Wochenende nachgeholt wird. Ein gleichmässiger Rhythmus ist erholsamer.</div>`;
            if(Math.abs(d)<=0.25) return `<div class="stat-hint">Sehr gleichmässiger Rhythmus über die ganze Woche – erholsamer als ein Nachholen am Wochenende.</div>`;
            return '';
          })()}`:``}
        </div>`:''}
      </div>
      ${hasPhases?`<div class="chart-card" style="margin-bottom:0">
        <h3>💤 Schlafphasen-Aufteilung (Ø pro Nacht)</h3>
        ${phaseBar}
        <div class="stats-list" style="margin-top:.6rem">
          ${awD!=null?`<div class="stat-row"><span class="stat-lbl">Wach</span><span class="stat-val">${toHM(awD)} – ${awPct}%</span></div>`:''}
          ${remD!=null?`<div class="stat-row"><span class="stat-lbl">REM-Schlaf</span><span class="stat-val">${toHM(remD)} – <span style="color:${parseInt(remPct)>=20?'#10B981':'#F97316'}">${remPct}%</span> (Ziel: 20–25%)</span></div>`:''}
          ${lD!=null?`<div class="stat-row"><span class="stat-lbl">Leichtschlaf</span><span class="stat-val">${toHM(lD)} – ${lPct}%</span></div>`:''}
          ${dpD!=null?`<div class="stat-row"><span class="stat-lbl">Tiefschlaf</span><span class="stat-val">${toHM(dpD)} – <span style="color:${parseInt(dpPct)>=15?'#10B981':'#F97316'}">${dpPct}%</span> (Ziel: 15–20%)</span></div>`:''}
        </div>
      </div>`:''}
    </div>

    <!-- Zeile 4: Schlafphasen-Verlauf -->
    ${hasPhases?`<div class="chart-card">
      <h3>💤 Schlafphasen-Verlauf</h3>
      <div class="chart-legend">
        <div class="cl-item"><span class="cl-dot" style="background:#F97316"></span>Wach</div>
        <div class="cl-item"><span class="cl-dot" style="background:#5BC8FA"></span>REM</div>
        <div class="cl-item"><span class="cl-dot" style="background:#2186E8"></span>Leichtschlaf</div>
        <div class="cl-item"><span class="cl-dot" style="background:#1E1B6E"></span>Tiefschlaf</div>
      </div>
      <div class="chart-wrap" style="height:180px"><canvas id="c-sl-phases"></canvas></div>
    </div>`:''}
    ${hasScore?`<div class="chart-card"><h3>⭐ Schlaf-Score Verlauf</h3><div class="chart-wrap" style="height:150px"><canvas id="c-sl-score"></canvas></div></div>`:''}`;


  if(tHD){
    const slAvgLine=slMa.map(()=>slD);
    // Y-Achse flexibel: nicht ab 0, sondern an den Datenbereich angeschmiegt, damit
    // die Variation zwischen den Nächten sichtbar wird (Schritt = 1 Std.).
    const _slV=slMa.filter(v=>v!=null);
    const _slY={...gy,ticks:{...gy.ticks,stepSize:1,callback:v=>Math.floor(v)+'h'}};
    if(_slV.length){
      _slY.min=Math.max(0, Math.floor(Math.min(..._slV) - 0.5));
      _slY.max=Math.ceil(Math.max(..._slV) + 0.2);
    } else { _slY.min=0; }
    mkC('c-sl-dur',{type:'bar',data:{labels:tL,datasets:[
      // Balken unterhalb des Ziels bleiben blass – Zielerreichung ist damit ohne
      // Zahlenlesen erkennbar. Schwelle kommt aus ZIELE, nicht mehr hartkodiert.
      {data:slMa,backgroundColor:slMa.map(v=>v!=null&&v>=ZIELE.sleepTotal.ziel?'rgba(124,58,237,.8)':'rgba(124,58,237,.35)'),borderRadius:5},
      {label:'Ø Schlafdauer',data:slAvgLine,type:'line',borderColor:'rgba(124,58,237,.55)',borderDash:[5,4],pointRadius:0,borderWidth:1.5,tension:0},
      zielLinie('sleepTotal', slMa.length)
    ]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>{
        if(!nurMesswerte(ctx)) return null;
        const _isAvg=timeRange!=='7d'&&timeRange!=='1m';
        const lines=[`${_isAvg?'Ø ':''}${toHM(ctx.raw)}${_isAvg?'':''}`];
        const i=ctx.dataIndex;
        if(slStartArr[i]!=null) lines.push((_isAvg?'Ø ':'')+('Eingeschlafen: '+fmtHHMM(slStartArr[i])));
        if(slEndArr[i]!=null) lines.push((_isAvg?'Ø ':'')+('Aufgewacht: '+fmtHHMM(slEndArr[i])));
        return lines;
      }}}},scales:{x:gx,y:_slY}}});
    if(hasPhases){
      const _phDs=[
        {label:'Tiefschlaf',data:dpMa,backgroundColor:'#1E1B6E',borderRadius:3,stack:'s'},
        {label:'Leichtschlaf',data:lMa,backgroundColor:'#2186E8',borderRadius:3,stack:'s'},
        {label:'REM',data:remMa,backgroundColor:'#5BC8FA',borderRadius:3,stack:'s'}
      ];
      if(hasAwake) _phDs.push({label:'Wach',data:awMa,backgroundColor:'#F97316',borderRadius:3,stack:'s'});
      const _phAvg={Tiefschlaf:dpD,Leichtschlaf:lD,REM:remD,Wach:awD};
      mkC('c-sl-phases',{type:'bar',data:{labels:tL,datasets:_phDs},options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,itemSort:(a,b)=>b.datasetIndex-a.datasetIndex,callbacks:{
          label:ctx=>{
            if(ctx.raw==null)return null;
            const total=ctx.chart.data.datasets.reduce((s,ds)=>s+(ds.data[ctx.dataIndex]??0),0);
            const pct=total>0?Math.round(ctx.raw/total*100):0;
            return `${ctx.dataset.label}: ${toHM(ctx.raw)} (${pct}%)`;
          }
        }}},
        scales:{x:{...gx,stacked:true},y:{...gy,stacked:true,ticks:{...gy.ticks,callback:v=>Math.floor(v)+'h'}}}}});
    }
    if(hasScore) mkC('c-sl-score',{type:'line',data:{labels:tdL.labels,datasets:[{data:scMa,borderColor:'#7C3AED',backgroundColor:'rgba(124,58,237,.08)',tension:.3,fill:true,pointRadius:3}]},
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
    document.getElementById("screen-training").innerHTML=`<div style="display:flex;align-items:center;justify-content:center;gap:.6rem;height:180px;color:var(--txt3);font-size:.8rem">⏳ Workout-Daten werden geladen…</div>`;
    await _awaitWorkoutSheet(10000);
  }
  const woProblem = !workoutSheetReady
    ? 'Die Workout-Daten konnten nicht rechtzeitig geladen werden.'
    : workoutLoadError;
  if(woProblem){
    document.getElementById("screen-training").innerHTML=`
      ${pgBanner('🏃','Training','Wie war meine gezielte sportliche Belastung?')}
      <div class="no-data">
        <strong>⚠️ Workout-Daten nicht verfügbar</strong>
        ${esc(woProblem)}
        <div class="field-hint" style="margin-top:.4rem">Quelle: <code>Workout Data</code>-Google-Sheet. Mit 🔄 oben rechts erneut versuchen.</div>
      </div>`;
    return;
  }

  // ── Trainingstage im aktuellen Filterzeitraum ──
  // Quelle ist ausschließlich das Workout-Sheet (workoutData). Tage mit runSpeed
  // in Health-CSV, die NICHT im Workout-Sheet stehen, zählen nicht mehr als Training.
  const _healthDates=new Set(D.map(r=>r.date));
  const trainDates=Object.keys(workoutData).filter(d=>_healthDates.has(d)).sort();
  // Workout rows for current period (with HR data)
  const wRows=trainDates.map(d=>workoutData[d]).filter(w=>w!=null);
  const wRowsHR=wRows.filter(w=>w.avgHR!=null);
  const hasWD=wRowsHR.length>0;

  // ── Workout stats ──
  const woCount=wRows.length;
  const woAvgHR=hasWD ? Math.round(wRowsHR.reduce((s,w)=>s+w.avgHR,0)/wRowsHR.length) : null;
  const woDist=wRows.filter(w=>w.distanceKm!=null);
  const woTotalDist=woDist.length ? woDist.reduce((s,w)=>s+w.distanceKm,0) : null;
  const woAvgDist=woDist.length ? woTotalDist/woDist.length : null;
  const woSpeedRows=wRows.filter(w=>w.avgSpeedKph&&w.avgSpeedKph>0);
  const woAvgSpeed=woSpeedRows.length ? woSpeedRows.reduce((s,w)=>s+w.avgSpeedKph,0)/woSpeedRows.length : null;
  const woAvgPaceStr=woAvgSpeed ? fmtPace(paceFromSpeed(woAvgSpeed)) : null;
  const woElev=wRows.filter(w=>w.elevationM!=null);
  const woTotalElev=woElev.length ? Math.round(woElev.reduce((s,w)=>s+w.elevationM,0)) : null;

  // Chart data for Leistungs-Trend (per training day, chronological)
  const trendDates=trainDates.slice().sort();
  const trendLabels=trendDates.map(d=>{const dt=new Date(d+'T00:00:00');return dt.toLocaleDateString('de-CH',{day:'2-digit',month:'2-digit'});});
  const trendDist=trendDates.map(d=>(workoutData[d]?.distanceKm??null));
  const trendHR=trendDates.map(d=>(workoutData[d]?.avgHR??null));
  // Very broad field detection
  const calField=findField(D,
    'activeCal',
    'activeEnergyBurned','activeCalories','calories','activeEnergy',
    'moveCalories','burnedCalories','totalCaloriesBurned','energyBurned',
    'activeKcal','kcal','caloriesBurned','workoutCalories',
    'HKQuantityTypeIdentifierActiveEnergyBurned'
  );
  // minField removed – durationMin comes exclusively from Workout Data sheet (workoutData)
  const distField=findField(D,
    'distKm',
    'distanceWalkingRunning','distance','totalDistance','distanceRun',
    'runningDistance','walkingDistance','distanceKm',
    'HKQuantityTypeIdentifierDistanceWalkingRunning'
  );
  const calD=calField?av(D,calField):null, calP=calField?av(P,calField):null;
  const _woMinD=D.map(r=>workoutData[r.date]?.durationMin).filter(v=>v!=null);
  const _woMinP=P.map(r=>workoutData[r.date]?.durationMin).filter(v=>v!=null);
  const minD=_woMinD.length?_woMinD.reduce((a,b)=>a+b,0)/_woMinD.length:null;
  const minP=_woMinP.length?_woMinP.reduce((a,b)=>a+b,0)/_woMinP.length:null;
  const distD=distField?av(D,distField):null, distP=distField?av(P,distField):null;

  // New chart data — durationMin + distanceKm from CSV workout files
  const trendMin=trendDates.map(d=>workoutData[d]?.durationMin??null);
  const trendPace=trendDates.map(d=>{const row=D.find(r=>r.date===d);return row?.runSpeed>0?Math.round((60/row.runSpeed)*100)/100:null;});
  // Werktags / Wochenende splits for new chart footers
  const _wkdIdx=trendDates.reduce((a,d,i)=>{const wd=new Date(d+'T00:00:00').getDay();if(wd>=1&&wd<=5)a.push(i);return a;},[]);
  const _wkndIdx=trendDates.reduce((a,d,i)=>{const wd=new Date(d+'T00:00:00').getDay();if(wd===0||wd===6)a.push(i);return a;},[]);
  const _avgNn=arr=>{const f=arr.filter(v=>v!=null);return f.length?f.reduce((a,b)=>a+b,0)/f.length:null;};
  const distWkdAvg=_avgNn(_wkdIdx.map(i=>trendDist[i]));
  const distWkndAvg=_avgNn(_wkndIdx.map(i=>trendDist[i]));
  const minWkdAvg=_avgNn(_wkdIdx.map(i=>trendMin[i]));
  const minWkndAvg=_avgNn(_wkndIdx.map(i=>trendMin[i]));
  const paceWkdAvg=_avgNn(_wkdIdx.map(i=>trendPace[i]));
  const paceWkndAvg=_avgNn(_wkndIdx.map(i=>trendPace[i]));

  // Totals for period
  const calTotal=calField?D.filter(r=>r[calField]!=null).reduce((a,r)=>a+(r[calField]||0),0):null;
  const minTotal=_woMinD.length?_woMinD.reduce((a,b)=>a+b,0):null;
  const distTotal=distField?D.filter(r=>r[distField]!=null).reduce((a,r)=>a+(r[distField]||0),0):null;

  // Aktive Tage = Tage mit Workout-Sheet-Eintrag und durationMin > 0.
  const activeDays=D.filter(r=>workoutData[r.date]?.durationMin>0).length;
  const totalDays=D.length||1;
  const activePct=(activeDays/totalDays*100).toFixed(0);
  const avgPerWeek=D.length>0?(activeDays/(D.length/7)).toFixed(1):null;

  // Weekday vs weekend training (use all days with the field, not just active ones)
  const calSplit=splitWeekWknd(calField?D.filter(r=>r[calField]!=null):[]);
  const calWeek=calSplit.wkd.length?av(calSplit.wkd,calField):null;
  const calWknd=calSplit.wknd.length?av(calSplit.wknd,calField):null;
  const woMinSplit=splitWeekWknd(D.filter(r=>workoutData[r.date]?.durationMin!=null));
  const _woDur=rows=>rows.map(r=>workoutData[r.date].durationMin);
  const minWeek=av(_woDur(woMinSplit.wkd));
  const minWknd=av(_woDur(woMinSplit.wknd));

  // Init calendar to latest data month if not yet set
  if(!_calDate && allData.length){
    const ld=allData[allData.length-1].date;
    _calDate={y:parseInt(ld.slice(0,4)),m:parseInt(ld.slice(5,7))-1};
  }
  // Sync calendar to 1M filter month
  if(timeRange==='1m'){
    const refD=new Date(referenceDate+'T00:00:00');
    _calDate={y:refD.getFullYear(),m:refD.getMonth()};
  }

  const {labels:tL}=timeDim(D);

  // Workout-CSV-based aggregation (Duration + Distance from workoutData, all workout types)
  // NOTE: _woByDate was removed — it filtered to runSpeed-dates only, excluding indoor workouts
  const woRows=D.map(r=>({date:r.date,_woDurMin:workoutData[r.date]?.durationMin??null,_woDistKm:workoutData[r.date]?.distanceKm??null}));
  const {alignSum:tASwo}=timeDim(woRows);
  const minSm_wo=tASwo('_woDurMin');
  const distSm_wo=tASwo('_woDistKm');

  // 1M daily: only show bars on actual training days (workout CSV present)
  const _train1m=timeRange==='1m';
  const minSmD=_train1m?minSm_wo.map(v=>v!=null&&v>0?v:null):minSm_wo;
  const distSmD=_train1m?distSm_wo.map((v,i)=>minSmD[i]!=null?v:null):distSm_wo;

  // 1M: build full calendar-month arrays + Monday indices for week gridlines
  let _1mLabels=tL, _1mMinData=minSmD, _1mDistData=distSmD, _1mMoIdx=new Set();
  if(timeRange==='1m'){
    const _rd=new Date(referenceDate+'T00:00:00');
    const _yr=_rd.getFullYear(), _mo=_rd.getMonth();
    const _dim=new Date(_yr,_mo+1,0).getDate();
    const _bd={};D.forEach(r=>{_bd[r.date]=r;});
    const _moDays=Array.from({length:_dim},(_,i)=>toLocalDateStr(new Date(_yr,_mo,i+1)));
    _1mLabels=_moDays.map(d=>{const dt=new Date(d+'T00:00:00');return String(dt.getDate()).padStart(2,'0')+'.'+String(dt.getMonth()+1).padStart(2,'0')+'.'});
    _1mMinData=_moDays.map(d=>workoutData[d]?.durationMin??null);
    _1mDistData=_moDays.map(d=>workoutData[d]?.distanceKm??null);
    _moDays.forEach((d,i)=>{if(new Date(d+'T00:00:00').getDay()===1)_1mMoIdx.add(i);});
  }

  // hasAny stützt sich allein auf das Workout-Sheet – keine Health-CSV-Felder mehr.
  const hasAny=trainDates.length>0;

  const noDataCard=`<div class="no-data">
    <strong>⚠️ Keine Trainingsdaten gefunden</strong>
    Im aktuellen Zeitraum ist kein Eintrag im Workout-Sheet vorhanden.
    <div class="field-hint" style="margin-top:.4rem">Quelle: <code>Workout Data</code>-Google-Sheet · erwartete Spalten: <code>Date</code> <code>Type</code> <code>Duration (min)</code> <code>Distance (km)</code> <code>Avg HR</code> <code>Speed (km/h)</code></div>
  </div>`;

  // ── VO₂max (vormals eigener Tab → jetzt zuunterst im Training) ──
  const v2r=D.filter(r=>r.vo2max!=null);
  const v2D=av(v2r,'vo2max'), v2P=av(P.filter(r=>r.vo2max!=null),'vo2max');
  const v2Trend=v2D&&v2P?pct(v2D,v2P):null;
  const _vo2Cat=(v)=>{
    if(v==null)return['Keine Daten','#94A3B8',0];
    if(v>=55)return['Exzellent','#2563EB',92];
    if(v>=47)return['Überdurchschnittlich','#10B981',74];
    if(v>=42)return['Durchschnittlich','#84CC16',55];
    if(v>=35)return['Unterdurchschnittlich','#F97316',35];
    return['Niedrig','#EF4444',15];
  };
  const [v2cat,v2catColor,v2pctPos]=_vo2Cat(v2D);
  const {labels:_v2tL,align:_v2tA,hasData:_v2tHD}=timeDim(D,true,true);
  const v2MaFull=_v2tA('vo2max');

  document.getElementById("screen-training").innerHTML=`
    ${pgBanner('🏃','Training','Wie war meine gezielte sportliche Belastung?','#7C2D12','#F97316')}
    <div class="three-col">
      <div class="chart-card" style="margin-bottom:0">
        <h3 style="margin:0 0 .5rem">🏋️ Trainingskalender</h3>
        <div id="cal-training">${_calDate?_buildCalHTML(_calDate.y,_calDate.m):''}</div>
      </div>
      <div class="chart-card" style="margin-bottom:0;display:flex;flex-direction:column">
        <h3>⏱️ Trainingszeit</h3>
        <div class="chart-legend"><div class="cl-item"><span class="cl-dot" style="background:#F97316"></span>${is7D()||timeRange==='1m'?'pro Tag':'pro Monat'}</div></div>
        <div class="chart-wrap" style="flex:1;min-height:140px"><canvas id="c-tot-zeit"></canvas></div>
        <div class="stats-list" style="margin-top:.5rem;border-top:1px solid var(--border);padding-top:.4rem">
          ${minWeek!=null?`<div class="stat-row"><span class="stat-lbl">Ø Wochentag (Mo–Fr)</span><span class="stat-val">${Math.round(minWeek)} min</span></div>`:''}
          ${minWknd!=null?`<div class="stat-row"><span class="stat-lbl">Ø Wochenende (Sa–So)</span><span class="stat-val">${Math.round(minWknd)} min</span></div>`:''}
          ${minWeek!=null&&minWknd!=null?`<div class="stat-row"><span class="stat-lbl">Differenz</span><span class="stat-val" style="color:var(--txt2)">${minWknd>minWeek?'+':''}${Math.round(minWknd-minWeek)} min</span></div>`:''}
        </div>
      </div>
      <div class="chart-card" style="margin-bottom:0;display:flex;flex-direction:column">
        <h3>📍 Laufstrecke</h3>
        <div class="chart-legend"><div class="cl-item"><span class="cl-dot" style="background:#FB923C"></span>${is7D()||timeRange==='1m'?'pro Tag':'pro Monat'}</div></div>
        <div class="chart-wrap" style="flex:1;min-height:140px"><canvas id="c-tot-strecke"></canvas></div>
        <div class="stats-list" style="margin-top:.5rem;border-top:1px solid var(--border);padding-top:.4rem">
          ${distWkdAvg!=null?`<div class="stat-row"><span class="stat-lbl">Ø Wochentag (Mo–Fr)</span><span class="stat-val">${fn(distWkdAvg,2)} km</span></div>`:''}
          ${distWkndAvg!=null?`<div class="stat-row"><span class="stat-lbl">Ø Wochenende (Sa–So)</span><span class="stat-val">${fn(distWkndAvg,2)} km</span></div>`:''}
          ${distWkdAvg!=null&&distWkndAvg!=null?`<div class="stat-row"><span class="stat-lbl">Differenz</span><span class="stat-val" style="color:var(--txt2)">${distWkndAvg>distWkdAvg?'+':''}${fn(distWkndAvg-distWkdAvg,2)} km</span></div>`:''}
        </div>
      </div>
    </div>
    <div class="chart-card">
      <h3>📈 ${timeRange==='7d'||timeRange==='1m'?'Leistungs-Trend: Distanz & HR pro Training':'Distanz & HR pro Monat'}</h3>
      <div class="chart-legend">
        ${trendDist.some(v=>v!=null)?`<div class="cl-item"><span class="cl-dot" style="background:#FB923C"></span>Distanz [km]</div>`:''}
        ${trendHR.some(v=>v!=null)?`<div class="cl-item"><span class="cl-line" style="background:#EF4444"></span>HR [bpm]</div>`:''}
      </div>
      <div class="chart-wrap" style="height:200px"><canvas id="c-wo-trend"></canvas></div>
    </div>
    <div class="chart-card">
      <h3>🏃 Pace pro Training ${infoI('pace')}</h3>
      <div class="chart-legend"><div class="cl-item"><span class="cl-line" style="background:#7C3AED"></span>Pace [min/km]</div></div>
      <div class="chart-wrap" style="height:200px"><canvas id="c-tr-pace"></canvas></div>
      <div class="stats-list" style="margin-top:.5rem;border-top:1px solid var(--border);padding-top:.4rem">
        ${paceWkdAvg!=null?`<div class="stat-row"><span class="stat-lbl">Ø Wochentag (Mo–Fr)</span><span class="stat-val">${fmtPace(paceWkdAvg)} min/km</span></div>`:''}
        ${paceWkndAvg!=null?`<div class="stat-row"><span class="stat-lbl">Ø Wochenende (Sa–So)</span><span class="stat-val">${fmtPace(paceWkndAvg)} min/km</span></div>`:''}
      </div>
    </div>
    ${!hasAny?noDataCard:''}
    <!-- VO₂max (vormals eigener Tab → jetzt zuunterst) -->
    <div class="chart-card">
      <h3>📊 Fitness-Einordnung ${infoI('vo2max')}</h3>
      <p style="font-size:.72rem;color:var(--txt2);margin-bottom:.6rem">VO₂max aktuell: <strong>${fn(v2D,1)} ml/kg/min</strong> – <span style="color:${v2catColor};font-weight:700">${v2cat}</span></p>
      <div class="fit-bar-wrap">
        <div class="fit-bar"><div class="fit-marker" style="left:${v2pctPos}%"></div></div>
        <div class="fit-labels"><span>Niedrig<br>&lt;35</span><span>Unter-Ø<br>35–42</span><span>Ø<br>42–47</span><span>Über-Ø<br>47–55</span><span>Top<br>&gt;55</span></div>
      </div>
      <span class="fit-cat-badge" style="background:${v2catColor}20;color:${v2catColor}">${v2cat}</span>
      <div class="stats-list" style="margin-top:.8rem">
        <div class="stat-row"><span class="stat-lbl">Trend</span><span class="stat-val" style="color:${v2Trend!=null&&v2Trend>0?'#10B981':v2Trend!=null&&v2Trend<0?'#EF4444':'#94A3B8'}">${v2Trend!=null?(v2Trend>0?'↑ Steigend':'↓ Sinkend'):'Stabil'}</span></div>
        <div class="stat-row"><span class="stat-lbl">Veränderung</span><span class="stat-val">${v2Trend!=null?(v2Trend>0?'+':'')+v2Trend.toFixed(1)+'%':'—'}</span></div>
        <div class="stat-row"><span class="stat-lbl">Messungen</span><span class="stat-val">${v2r.length}</span></div>
      </div>
    </div>
    <div class="chart-card" style="margin-bottom:0">
      <h3>🫁 VO₂max-Verlauf</h3>
      <div class="chart-legend"><div class="cl-item"><span class="cl-line" style="background:#D97706"></span>VO₂max [ml/kg/min]${v2D!=null?` · Ø <strong>${fn(v2D,1)}</strong>`:''}</div></div>
      <div class="chart-wrap" style="height:200px"><canvas id="c-vo2"></canvas></div>
    </div>`;

  // Calendar navigation callbacks
  window._calPrev=()=>{
    if(!_calDate||timeRange==='1m')return;
    const d=new Date(_calDate.y,_calDate.m-1,1);
    _calDate={y:d.getFullYear(),m:d.getMonth()};
    const el=document.getElementById('cal-training');
    if(el) el.innerHTML=_buildCalHTML(_calDate.y,_calDate.m);
  };
  window._calNext=()=>{
    if(!_calDate||timeRange==='1m')return;
    const d=new Date(_calDate.y,_calDate.m+1,1);
    _calDate={y:d.getFullYear(),m:d.getMonth()};
    const el=document.getElementById('cal-training');
    if(el) el.innerHTML=_buildCalHTML(_calDate.y,_calDate.m);
  };

  // ── Totale Laufzeit & Laufstrecke ──
  {
    const _is1m=timeRange==='1m';
    const _zeitInH=timeRange!=='7d'&&timeRange!=='1m'; // 3M+ → show hours
    const _xTot=gx;
    const _lZeitData=_is1m?_1mMinData:minSmD;
    const _lStrData=_is1m?_1mDistData:distSmD;
    const _lZeitLbls=_is1m?_1mLabels:tL;
    const _lStrLbls=_is1m?_1mLabels:tL;

    mkC('c-tot-zeit',{type:'bar',data:{labels:_lZeitLbls,datasets:[
      {label:'Laufzeit',data:_lZeitData,backgroundColor:'rgba(249,115,22,.80)',borderRadius:_is1m?2:4}
    ]},options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,callbacks:{label:ctx=>{
        if(ctx.raw==null)return null;
        if(_zeitInH){const h=Math.floor(ctx.raw/60),m=Math.round(ctx.raw%60);return m>0?`${h}h ${m}min`:`${h}h`;}
        return `${Math.round(ctx.raw)} min`;
      }}}},
      scales:{x:_xTot,y:{...gy,
        ticks:{...gy.ticks,callback:v=>_zeitInH?`${Math.floor(v/60)}h`:Math.round(v)+' min'}}}}});

    mkC('c-tot-strecke',{type:'bar',data:{labels:_lStrLbls,datasets:[
      {label:'Laufstrecke',data:_lStrData,backgroundColor:'rgba(251,146,60,.80)',borderRadius:_is1m?2:4}
    ]},options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,callbacks:{label:ctx=>ctx.raw!=null?`${ctx.raw.toFixed(2)} km`:null}}},
      scales:{x:_xTot,y:{...gy,
        ticks:{...gy.ticks,callback:v=>v===0?'0':Math.round(v)+' km'}}}}});
  }

  // ── Leistungs-Trend chart (monthly aggregation for 3M+) ──
  {
    const _useMonthly=timeRange!=='7d'&&timeRange!=='1m';
    let woLabels,woDist,woHR;
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
      woDist=months.map(mk=>{const a=(mMap[mk]||{dists:[]}).dists;return a.length?a.reduce((s,v)=>s+v,0)/a.length:0;});
      woHR=months.map(mk=>{const a=(mMap[mk]||{hrs:[]}).hrs;return a.length?a.reduce((s,v)=>s+v,0)/a.length:null;});
    } else {
      woLabels=trendDates.length>0?trendLabels:tL;
      woDist=trendDates.length>0?trendDist:tL.map(()=>null);
      woHR=trendDates.length>0?trendHR:tL.map(()=>null);
    }
    const woDsets=[];
    woDsets.push({
      label:'Distanz (km)',data:woDist,
      backgroundColor:'rgba(249,115,22,.75)',borderRadius:4,yAxisID:'yL',type:'bar'
    });
    if(woHR.some(v=>v!=null)) woDsets.push({
      label:'Ø HR (bpm)',data:woHR,
      borderColor:'#EF4444',backgroundColor:'transparent',tension:.3,
      pointRadius:3,pointBackgroundColor:'#EF4444',type:'line',yAxisID:'yR'
    });
    mkC('c-wo-trend',{
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
            ticks:{color:'#94A3B8',font:{size:9},callback:v=>Math.round(v)+' bpm'},
            min:100,max:woHR.some(v=>v!=null)?Math.ceil((Math.max(...woHR.filter(v=>v!=null))+10)/10)*10:200}
        }
      }
    });
  }

  // ── Pace pro Training ──
  {
    const _hasP=trendDates.length>0&&trendPace.some(v=>v!=null);
    const _paceLabels=_hasP?trendLabels:tL;
    const _paceData=_hasP?trendPace:tL.map(()=>null);
    const _pMin=_hasP?Math.floor(Math.min(...trendPace.filter(v=>v!=null))*0.97*10)/10:4;
    const _pMax=_hasP?Math.ceil(Math.max(...trendPace.filter(v=>v!=null))*1.03*10)/10:8;
    mkC('c-tr-pace',{type:'line',data:{labels:_paceLabels,datasets:[
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

  // ── VO₂max-Verlauf (vormals eigener Tab) ──
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
    if(v2D!=null) _v2Dsets.push({label:'Ø VO₂max',data:_v2tL.map(()=>v2D),borderColor:'rgba(217,119,6,.55)',borderDash:[5,4],pointRadius:0,borderWidth:1.5,tension:0,fill:false,spanGaps:true});
    _v2Dsets.push(zielLinie('vo2max', _v2tL.length));
    _v2Min=Math.min(_v2Min, ZIELE.vo2max.ziel); _v2Max=Math.max(_v2Max, ZIELE.vo2max.ziel); // Ziellinie im Sichtbereich halten
    mkC('c-vo2',{type:'line',data:{labels:_v2tL,datasets:_v2Dsets},
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,filter:nurMesswerte,callbacks:{label:ctx=>ctx.raw!=null?`VO₂max: ${ctx.raw.toFixed(2)} ml/kg/min`:null}}},
        scales:{x:gx,y:{...gy,min:_v2YMin,max:_v2YMax,ticks:{...gy.ticks,stepSize:_v2Step}}}}});
  }
}

// ── Aktivität ──────────────────────────────────────────
function pgAktivitaet() {
  const D=filtered(), P=prevPeriod();
  const stD=av(D,'steps'), stP=av(P,'steps');
  const calField=findField(D,'activeCal','activeEnergyBurned','activeCalories','calories','activeEnergy','moveCalories');
  const calD=calField?av(D,calField):null, calP=calField?av(P,calField):null;
  const distField=findField(D,'distKm','distanceWalkingRunning','distance','totalDistance','distanceKm');
  const distD=distField?av(D,distField):null;
  const flField=findField(D,'flights','flightsClimbed','floors','floorClimbed');
  const flD=flField?av(D,flField):null;

  const stRows=D.filter(r=>r.steps!=null);
  const n10k=stRows.filter(r=>r.steps>=10000).length;
  const n8k=stRows.filter(r=>r.steps>=8000&&r.steps<10000).length;
  const n5k=stRows.filter(r=>r.steps>=5000&&r.steps<8000).length;
  const nU5k=stRows.filter(r=>r.steps<5000).length;
  const nTot=stRows.length||1;
  const stMax=stRows.length?Math.max(...stRows.map(r=>r.steps)):null;
  const stMin=stRows.length?Math.min(...stRows.map(r=>r.steps)):null;

  // Week vs weekend
  const stSplit=splitWeekWknd(stRows);
  const stWeek=av(stSplit.wkd,'steps');
  const stWknd=av(stSplit.wknd,'steps');

  // Calorie weekday/weekend averages
  const calSplit=splitWeekWknd(calField?D.filter(r=>r[calField]!=null):[]);
  const calWeek=calSplit.wkd.length?av(calSplit.wkd,calField):null;
  const calWknd=calSplit.wknd.length?av(calSplit.wknd,calField):null;

  // Streak: consecutive days >= 8k
  let maxStreak=0,cur=0;
  stRows.forEach(r=>{if(r.steps>=8000){cur++;maxStreak=Math.max(maxStreak,cur);}else cur=0;});

  // Display avg: always daily average, regardless of time filter
  const stDisplayAvg=stD!=null?Math.round(stD):null;
  const stDisplayLbl='';
  const calDisplayAvg=calD!=null?Math.round(calD):null;
  const calDisplayLbl='';

  const {labels:tL,align:tA,hasData:tHD}=timeDim(D);
  const stMa=tA('steps');   // Ø pro Tag (Durchschnitt der Tageswerte pro Zeitbucket)
  const calMaAct=calField?tA(calField):tL.map(()=>null);  // Ø pro Tag

  // Init calendar to latest data month if not yet set
  if(!_calDate && allData.length){
    const ld=allData[allData.length-1].date;
    _calDate={y:parseInt(ld.slice(0,4)),m:parseInt(ld.slice(5,7))-1};
  }

  document.getElementById("screen-aktivitaet").innerHTML=`
    ${pgBanner('🚶','Schritte','Tägliche Bewegung, Schritte & Kalorienverbrauch','#064E3B','#10B981')}

    <!-- Row 2: Schritteziel-Erreichung -->
    <div class="chart-card split2">
      <h3>🎯 Schritteziel-Erreichung ${infoI('steps')}</h3>
      <div style="margin:.4rem 0">
        <div class="goal-row"><span class="goal-lbl" style="color:#10B981">≥ 10.000</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${n10k/nTot*100}%;background:#10B981"></div></div><span class="goal-val"><span class="goal-num">${n10k}</span><span style="color:var(--txt3)">(${(n10k/nTot*100).toFixed(0)}%)</span></span></div>
        <div class="goal-row"><span class="goal-lbl" style="color:#84CC16">8k – 10k</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${n8k/nTot*100}%;background:#84CC16"></div></div><span class="goal-val"><span class="goal-num">${n8k}</span><span style="color:var(--txt3)">(${(n8k/nTot*100).toFixed(0)}%)</span></span></div>
        <div class="goal-row"><span class="goal-lbl" style="color:#EAB308">5k – 8k</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${n5k/nTot*100}%;background:#EAB308"></div></div><span class="goal-val"><span class="goal-num">${n5k}</span><span style="color:var(--txt3)">(${(n5k/nTot*100).toFixed(0)}%)</span></span></div>
        <div class="goal-row"><span class="goal-lbl" style="color:#EF4444">&lt; 5.000</span><div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${nU5k/nTot*100}%;background:#EF4444"></div></div><span class="goal-val"><span class="goal-num">${nU5k}</span><span style="color:var(--txt3)">(${(nU5k/nTot*100).toFixed(0)}%)</span></span></div>
      </div>
      <div class="stats-list" style="margin-top:.5rem">
        <div class="stat-row"><span class="stat-lbl">Bester Tag</span><span class="stat-val" style="color:#10B981">${stMax!=null?Math.round(stMax).toLocaleString('de-CH'):'—'}</span></div>
        <div class="stat-row"><span class="stat-lbl">Schlechtester Tag</span><span class="stat-val" style="color:#EF4444">${stMin!=null?Math.round(stMin).toLocaleString('de-CH'):'—'}</span></div>
        <div class="stat-row"><span class="stat-lbl">Längste Streak</span><span class="stat-val">${maxStreak} Tage</span></div>
        <div class="stat-row"><span class="stat-lbl">Messpunkte</span><span class="stat-val">${stRows.length}d <span style="color:var(--txt3)">(${D.length>0?(stRows.length/D.length*100).toFixed(0):'—'}%)</span></span></div>
      </div>
    </div>

    <!-- Row 3: Schritte + Aktive Kalorien side by side -->
    <div class="two-col-eq">
      <div class="chart-card" style="margin-bottom:0">
        <h3>🚶 Anzahl Schritte</h3>
        <div class="chart-legend" style="margin-bottom:.3rem">
          <div class="cl-item"><span class="cl-dot" style="background:#059669"></span>Schritte${stDisplayAvg!=null?` · Ø <strong>${stDisplayAvg.toLocaleString('de-CH')}</strong>${stDisplayLbl}`:''}</div>
        </div>
        <div class="chart-wrap" style="height:185px"><canvas id="c-steps"></canvas></div>
        ${stWeek!=null||stWknd!=null?`
        <div class="stats-list" style="margin-top:.5rem;border-top:1px solid var(--border);padding-top:.4rem">
          <div class="stat-row"><span class="stat-lbl">Ø Wochentag (Mo–Fr)</span><span class="stat-val">${stWeek!=null?Math.round(stWeek).toLocaleString('de-CH')+'':'—'}</span></div>
          <div class="stat-row"><span class="stat-lbl">Ø Wochenende (Sa–So)</span><span class="stat-val">${stWknd!=null?Math.round(stWknd).toLocaleString('de-CH')+'':'—'}</span></div>
          ${stWeek!=null&&stWknd!=null?`<div class="stat-row"><span class="stat-lbl">Differenz</span><span class="stat-val" style="color:var(--txt2)">${stWknd>stWeek?'+':''}${Math.round(stWknd-stWeek).toLocaleString('de-CH')}</span></div>`:``}
        </div>`:''}
      </div>
      ${calMaAct.some(v=>v!=null)?`<div class="chart-card" style="margin-bottom:0">
        <h3>🔥 Aktive Kalorien</h3>
        <div class="chart-legend" style="margin-bottom:.3rem">
          <div class="cl-item"><span class="cl-dot" style="background:#34D399"></span>Aktive Kalorien${calDisplayAvg!=null?` · Ø <strong>${calDisplayAvg.toLocaleString('de-CH')} kcal</strong>${calDisplayLbl}`:''}</div>
        </div>
        <div class="chart-wrap" style="height:185px"><canvas id="c-cals"></canvas></div>
        ${calWeek!=null||calWknd!=null?`
        <div class="stats-list" style="margin-top:.5rem;border-top:1px solid var(--border);padding-top:.4rem">
          <div class="stat-row"><span class="stat-lbl">Ø Wochentag (Mo–Fr)</span><span class="stat-val">${calWeek!=null?Math.round(calWeek).toLocaleString('de-CH')+' kcal':'—'}</span></div>
          <div class="stat-row"><span class="stat-lbl">Ø Wochenende (Sa–So)</span><span class="stat-val">${calWknd!=null?Math.round(calWknd).toLocaleString('de-CH')+' kcal':'—'}</span></div>
          ${calWeek!=null&&calWknd!=null?`<div class="stat-row"><span class="stat-lbl">Differenz</span><span class="stat-val" style="color:var(--txt2)">${calWknd>calWeek?'+':''}${Math.round(calWknd-calWeek).toLocaleString('de-CH')} kcal</span></div>`:``}
        </div>`:''}
      </div>`:'<div></div>'}
    </div>
    `;

  if(tHD){
    // Chart 1: Schritte
    const dsSteps=[
      {label:'Schritte',data:stMa,backgroundColor:stMa.map(v=>v!=null&&v>=ZIELE.steps.ziel?'rgba(5,150,105,.75)':'rgba(148,163,184,.45)'),borderRadius:5,type:'bar'}
    ];
    if(stDisplayAvg!=null) dsSteps.push({label:'Ø Schritte',data:stMa.map(()=>stDisplayAvg),borderColor:'rgba(5,150,105,.45)',borderDash:[5,4],pointRadius:0,borderWidth:1.5,tension:0,type:'line'});
    dsSteps.push(zielLinie('steps', stMa.length));
    mkC('c-steps',{type:'bar',data:{labels:tL,datasets:dsSteps},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,filter:nurMesswerte,callbacks:{label:ctx=>ctx.raw!=null?'Ø '+Math.round(ctx.raw).toLocaleString('de-CH')+' Schritte':null}}},
        scales:{x:gx,y:{...gy,ticks:{...gy.ticks,callback:v=>Math.round(v).toLocaleString('de-CH')}}}}});
    // Chart 2: Aktive Kalorien (bar)
    if(calMaAct.some(v=>v!=null)){
      const dsCals=[
        {label:'Kalorien',data:calMaAct,backgroundColor:calMaAct.map(v=>v!=null&&calDisplayAvg!=null&&v>=calDisplayAvg?'rgba(52,211,153,.80)':'rgba(148,163,184,.45)'),borderRadius:5,type:'bar'}
      ];
      if(calDisplayAvg!=null) dsCals.push({label:'Ø Kalorien',data:calMaAct.map(()=>calDisplayAvg),borderColor:'rgba(52,211,153,.5)',borderDash:[5,4],pointRadius:0,borderWidth:1.5,tension:0,type:'line'});
      mkC('c-cals',{type:'bar',data:{labels:tL,datasets:dsCals},
        options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,filter:nurMesswerte,callbacks:{label:ctx=>ctx.raw!=null?'Ø '+Math.round(ctx.raw).toLocaleString('de-CH')+' kcal':null}}},
          scales:{x:gx,y:{...gy,ticks:{...gy.ticks,callback:v=>Math.round(v).toLocaleString('de-CH')}}}}});
    }
  }
}

// ── Navigation ─────────────────────────────────────────
const PAGE_TITLES={overview:'Übersicht',herz:'Herz',schlaf:'Schlaf',aktivitaet:'Schritte',training:'Training'};
const PAGE_FNS={overview:pgOverview,herz:pgHerz,schlaf:pgSchlaf,aktivitaet:pgAktivitaet,training:pgTraining};

const PAGE_THEMES={overview:'th-overview',herz:'th-herz',schlaf:'th-schlaf',aktivitaet:'th-aktivitaet',training:'th-training'};
// Page-Banner ohne inline-Gradient – die Per-Tab-Hintergründe sind auf .screen gesetzt.
// g1/g2 werden zwar von alten Aufrufern noch übergeben, hier aber ignoriert.
function pgBanner(icon,title,sub){
  // Refresh + Dark-Toggle sitzen jetzt rechtsbündig direkt auf der Titelzeile
  // (keine eigene Topbar-Kachel mehr). Dark-Icon spiegelt den aktuellen Zustand.
  const darkIcon = document.body.classList.contains('dark') ? '☀️' : '🌙';
  return`<div class="pg-banner"><span class="pg-banner-icon">${icon}</span><div class="pg-banner-txt"><div class="pg-banner-title">${title}</div><div class="pg-banner-sub">${sub}</div>${dataStandHTML()}</div><div class="pg-banner-actions"><button class="pg-act refresh-btn" title="Daten neu laden" aria-label="Refresh">🔄</button><button class="pg-act dark-toggle" title="Hell/Dunkel" aria-label="Theme">${darkIcon}</button></div></div>`;
}
// ═══════════════════════════════════════════════════════════
// Tab-Navigation: horizontaler Snap-Scroller + Bottom-Nav
// ═══════════════════════════════════════════════════════════
const TAB_ORDER = ['overview','herz','schlaf','aktivitaet','training'];
let currentScreen = 'overview';
let _suppressScrollSync = false;
let _currentRenderingTab = null;
const _renderedTabs = new Set();
const tabCharts = { overview:[], herz:[], schlaf:[], aktivitaet:[], training:[] };

// Refresh + Dark-Toggle liegen jetzt rechtsbündig auf der Banner-Titelzeile
// jedes Tabs (siehe pgBanner) – keine separate Topbar-Kachel mehr.
// Zeitfilter + Datumsnavigator liegen in den einzelnen Diagrammen
// (siehe chartFilterHTML / _injectChartFilters).

// Filter-Control für eine Diagramm-Karte: Bereichs-Dropdown + Mini-Datumsnavigator.
// Schreibt in denselben globalen Zustand (timeRange/referenceDate) → app-weit synchron.
const _RANGE_OPTS = [
  ['heute','Heute'],['7d','7T'],['1m','1M'],
  ['3m','3M'],['6m','6M'],['12m','12M'],['24m','24M']
];
function chartFilterHTML() {
  const r = timeRange;
  const opts = _RANGE_OPTS.map(([k,lbl]) => `<option value="${k}"${k===r?' selected':''}>${lbl}</option>`).join('');
  const hideNav = r === 'heute';
  // ↺ (aktuellster Zeitraum) bewusst GANZ LINKS, getrennt vom ›-Pfeil – sonst
  // wird es leicht aus Versehen statt des Vorwärts-Pfeils getroffen.
  return `<div class="chart-filter">
    <button class="nav-arrow nav-today" title="Aktuellster Zeitraum" aria-label="Aktuellster Zeitraum" style="display:${hideNav?'none':'inline-flex'}">Heute</button>
    <select class="range-select" aria-label="Zeitraum">${opts}</select>
    <div class="date-nav" style="display:${hideNav?'none':'inline-flex'}">
      <button class="nav-arrow nav-prev" aria-label="Zurück">‹</button>
      <span class="nav-label">${navDateLabel()}</span>
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
  if (screenEl.querySelector('.tab-filter-bar')) return;   // nicht doppelt injizieren
  const banner = screenEl.querySelector('.pg-banner');
  if (!banner) return;
  banner.insertAdjacentHTML('afterend',
    `<div class="tab-filter-bar"><span class="tfb-lbl">Zeitraum</span>${chartFilterHTML()}</div>`);
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
}

// Render einen Tab (oder gibt zurück, wenn schon gerendert)
function _renderTab(name) {
  _currentRenderingTab = name;
  // alte Charts dieses Tabs zerstören
  (tabCharts[name] || []).forEach(id => {
    if (charts[id]) { try { charts[id].destroy(); } catch(_) {} delete charts[id]; }
  });
  tabCharts[name] = [];
  const fn = PAGE_FNS[name];
  if (!fn) return;
  let r;
  try {
    r = fn();
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
  aktivitaet: '#10B981',
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
  aktivitaet: 'linear-gradient(135deg, #064E3B, #10B981)',
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
let _navLastScrollY = 0;
function initScrollHideNav() {
  const nav = document.getElementById('bottom-nav');
  if (!nav) return;
  const tickingByTab = new Map();
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
        const dy = y - _navLastScrollY;
        if (y > 60 && dy > 4) nav.classList.add('nav-hidden');
        else if (dy < -4 || y < 30) nav.classList.remove('nav-hidden');
        _navLastScrollY = y;
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
    if (e.target.closest('button, a, input, select, textarea, label, canvas, .chart-filter, [data-tt], .topbar-inline, ' + TT_TAP_SELECTOR)) return;
    nav.classList.toggle('nav-hidden');
  });
}

// ── Event-Wiring (nach Daten-Load) ───────────────────────
// Topbar-Buttons werden per Delegation auf document.body verkabelt,
// weil die Topbar dynamisch in jede .screen-Fläche injiziert wird (sechs Instanzen).
document.body.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('.nav-prev')) { navPrev(); return; }
  if (t.closest('.nav-next')) { navNext(); return; }
  if (t.closest('.nav-today')) {
    if (allData.length) {
      referenceDate = allData[allData.length-1].date;
      updateNavUI();
      _refreshAfterStateChange();
    }
    return;
  }
  if (t.closest('.refresh-btn')) { refreshData(); return; }
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
  Chart.defaults.borderColor = GRID_COLOR;
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
// ── Refresh Button ─────────────────────────────────────
async function refreshData() {
  const btns = document.querySelectorAll('.refresh-btn');
  btns.forEach(b => { b.disabled = true; b.classList.add('spinning'); });
  // 1. Apps Script: Drive → Sheet aktualisieren
  try { await fetch(REFRESH_URL, { mode: 'no-cors' }); } catch(_) {}
  // 2. Kurz warten bis Sheet bereit ist
  await new Promise(r => setTimeout(r, 4000));
  // 3. Daten neu aus Sheet laden
  workoutData = {}; workoutSheetReady = false; workoutLoadError = null;
  await loadFromAPI();
  document.querySelectorAll('.refresh-btn').forEach(b => { b.disabled = false; b.classList.remove('spinning'); });
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

})();

// Service-Worker (registriert sich nach DOMContentLoaded; ausserhalb des IIFE)
window.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
});
