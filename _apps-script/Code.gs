// ================================================================
// Health Auto Export → Dashboard API
// ================================================================
// Production-Code: doGet/doPost-Endpunkte, Health-Daten-Import,
// Workout-Daten-Import.
//
// Wartungs- und Einmal-Skripte (fixHRValues, cleanSheet,
// initSheet, restoreFromBackup, …) liegen in Maintenance.gs.
// ================================================================

var SECRET           = 'I4C1c9csK02bAvQbF2cLnUuEsgfJbtWjzzGAPaHnd-Vn';
var WORKOUT_SHEET_ID = '1YJ3ke8Z2jS1KdJlKOnukUStMgvqqppnktAb8UVHDdgk';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🔄 Health Import')
    .addItem('Jetzt aktualisieren', 'writeToSheet')
    .addToUi();
}

// ── Refresh-Trigger (einziger Zweck dieses Endpoints) ─────────
function doGet(e) {
  var p = e && e.parameter ? e.parameter : {};

  // Secret-Token prüfen
  if (p.token !== SECRET) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Optional: Sheets aktualisieren
  if (p.refresh === 'true') {
    try {
      writeToSheet();
    } catch(err) {
      return ContentService.createTextOutput(JSON.stringify({ error: err.toString() }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var params = e && e.parameter ? e.parameter : {};
  if (params.token !== SECRET) {
    return ContentService.createTextOutput('Unauthorized');
  }
  // Laufplan-Termine: die App schickt sie per POST (mode:'no-cors', daher ohne
  // auswertbare Antwort - sie liest den Plan danach neu aus dem Sheet).
  if (params.plan) {
    try { return planEndpunkt(params); }
    catch (err) { return ContentService.createTextOutput('Fehler: ' + err); }
  }
  // Laufplaene (Kopfdaten) und ihre geplanten Einheiten.
  if (params.lp) {
    try { return laufplanEndpunkt(params); }
    catch (err) { return ContentService.createTextOutput('Fehler: ' + err); }
  }
  writeToSheet();
  return ContentService.createTextOutput('OK');
}

// ── Laufplan ───────────────────────────────────────────────────
// Einzelne Termine in einem eigenen Blatt des Workout-Spreadsheets. Die App liest
// es mit ihrem Nur-Lese-Recht; geschrieben wird ausschliesslich hier.
var PLAN_BLATT = 'Laufplan';

function planBlatt() {
  var ss = SpreadsheetApp.openById(WORKOUT_SHEET_ID);
  var sh = ss.getSheetByName(PLAN_BLATT);
  if (!sh) {
    sh = ss.insertSheet(PLAN_BLATT);
    sh.appendRow(['Date', 'Distance (km)', 'Note']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function planEndpunkt(p) {
  var sh = planBlatt();
  var datum = String(p.datum || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) {
    return ContentService.createTextOutput('Ungueltiges Datum');
  }
  var werte = sh.getDataRange().getValues();
  // Zeile dieses Datums suchen - ein Datum kommt hoechstens einmal vor.
  var zeile = -1;
  for (var i = 1; i < werte.length; i++) {
    if (planDatumStr(werte[i][0]) === datum) { zeile = i + 1; break; }
  }

  if (p.plan === 'del') {
    if (zeile > 0) sh.deleteRow(zeile);
    return ContentService.createTextOutput('OK geloescht');
  }

  var km    = p.km ? Number(String(p.km).replace(',', '.')) : '';
  var notiz = String(p.notiz || '').slice(0, 200);
  if (zeile > 0) {
    sh.getRange(zeile, 1, 1, 3).setValues([[datum, km, notiz]]);
  } else {
    sh.appendRow([datum, km, notiz]);
    // Nach Datum sortieren, damit das Blatt auch von Hand lesbar bleibt.
    if (sh.getLastRow() > 2) {
      sh.getRange(2, 1, sh.getLastRow() - 1, 3).sort({ column: 1, ascending: true });
    }
  }
  return ContentService.createTextOutput('OK gespeichert');
}

// Das Blatt kann Datumswerte als Date ODER als Text enthalten - beides auf
// JJJJ-MM-TT bringen. Ohne das schluege der Abgleich bei von Hand getippten
// Zeilen fehl.
function planDatumStr(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v || '').trim().slice(0, 10);
}

// ── Einen Tag verarbeiten ──────────────────────────────────────
function parseDay(date, metrics) {
  var d = { date: date };
  metrics.forEach(function(m) {
    var pts = m.data || [];
    switch (m.name) {
      case 'step_count':                       d.steps         = Math.round(S(pts));         break;
      case 'walking_running_distance':         d.distKm        = R1(S(pts));                 break;
      case 'active_energy':                    d.activeCal     = Math.round(S(pts) / 4.184); break;
      case 'basal_energy_burned':              d.basalCal      = Math.round(S(pts) / 4.184); break;
      case 'heart_rate':
        if (pts.length) {
          var hrAvg = pts[0].Avg, hrMin = pts[0].Min, hrMax = pts[0].Max;
          if (!hrAvg) {
            var vals = pts.map(function(p){ return p.qty||0; }).filter(function(v){ return v>0; });
            if (vals.length) {
              hrAvg = vals.reduce(function(a,b){ return a+b; },0) / vals.length;
              hrMin = Math.min.apply(null, vals);
              hrMax = Math.max.apply(null, vals);
            }
          }
          d.hrAvg = Math.round(hrAvg||0);
          d.hrMin = Math.round(hrMin||0);
          d.hrMax = Math.round(hrMax||0);
        }
        break;
      case 'resting_heart_rate':               d.restHR        = Math.round(A(pts));         break;
      case 'heart_rate_variability':           d.hrv           = Math.round(A(pts));         break;
      case 'blood_oxygen_saturation':          d.spo2          = R1(A(pts));                 break;
      case 'respiratory_rate':                 d.respRate      = R1(A(pts));                 break;
      case 'sleep_analysis':
        if (pts[0]) {
          var s        = pts[0];
          d.sleepTotal = R1(s.totalSleep || 0);
          d.sleepCore  = R1(s.core       || 0);
          d.sleepRem   = R1(s.rem        || 0);
          d.sleepDeep  = R1(s.deep       || 0);
          d.sleepAwake = R1(s.awake      || 0);
          d.sleepStart = extractTime(s.sleepStart || s.inBedStart);
          d.sleepEnd   = extractTime(s.sleepEnd   || s.inBedEnd);
        }
        break;
      case 'vo2_max':                          d.vo2max        = R1(A(pts));                 break;
      case 'apple_exercise_time':              d.exerciseMin   = Math.round(S(pts));         break;
      case 'apple_stand_time':                 d.standMin      = Math.round(S(pts));         break;
      case 'apple_stand_hour':                 d.standHours    = Math.round(S(pts));         break;
      case 'flights_climbed':                  d.flights       = Math.round(S(pts));         break;
      case 'time_in_daylight':                 d.daylight      = Math.round(S(pts));         break;
      case 'apple_sleeping_wrist_temperature': d.wristTemp     = R1(A(pts));                 break;
      case 'breathing_disturbances':           d.breathDisturb = R1(A(pts));                 break;
      case 'running_speed':      if (pts.length) d.runSpeed    = R1(A(pts));                 break;
      case 'running_power':      if (pts.length) d.runPower    = Math.round(A(pts));         break;
      case 'walking_speed':                    d.walkSpeed     = R1(A(pts));                 break;
      case 'physical_effort':                  d.physEffort    = R1(A(pts));                 break;
      case 'walking_heart_rate_average':       d.walkHR        = Math.round(A(pts));         break;
    }
  });
  return d;
}

// ── Hilfsfunktion: Zeit aus Datetime-String extrahieren ────────
function extractTime(dtStr) {
  if (!dtStr) return null;
  var m = String(dtStr).match(/\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

// ── Mathe-Hilfsfunktionen ──────────────────────────────────────
function S(d)  { return d.reduce(function(a,x){ return a+(x.qty||0); }, 0); }
function A(d)  { return d.length ? S(d) / d.length : 0; }
function R1(v) { return Math.round(v * 10) / 10; }

// ================================================================
// GOOGLE SHEETS EXPORT
// ================================================================

var SHEET_NAME = 'Health Dashboard Data';
var COLUMNS = [
  'date','steps','distKm','activeCal','basalCal',
  'hrAvg','hrMin','hrMax','restHR','hrv','spo2','respRate',
  'sleepTotal','sleepCore','sleepRem','sleepDeep','sleepAwake',
  'vo2max','exerciseMin','standMin','standHours','flights',
  'daylight','wristTemp','breathDisturb','runSpeed','runPower',
  'walkSpeed','physEffort','walkHR',
  'sleepStart','sleepEnd'
];

function getHealthFolder() {
  var parent = DriveApp.getFolderById('1akYBt8MyyvS03yxxWgxAV-lYOeqKdrL_');
  var subs = parent.getFoldersByName('Health Data');
  if (subs.hasNext()) return subs.next();
  throw new Error('Ordner nicht gefunden: Health Data');
}

// Pro Datum genau eine Datei zurückgeben.
// Google Drive ERSETZT eine gleichnamige Datei nicht, sondern legt eine zweite daneben.
// Exportiert Health Auto Export für denselben Tag mehrmals, lagen bisher mehrere
// Dateien mit identischem Namen im Ordner – und jede erzeugte eine eigene Sheet-Zeile.
// Bei Mehrfachtreffern gewinnt die zuletzt geänderte Datei.
function getAllHealthFiles() {
  var folder = getHealthFolder();
  var files = folder.getFiles();
  var proDatum = {};
  while (files.hasNext()) {
    var f = files.next();
    var n = f.getName();
    if (!/^HealthAutoExport-\d{4}-\d{2}-\d{2}\.json$/.test(n)) continue;
    var d = n.slice(17, 27);
    var vorh = proDatum[d];
    // getLastUpdated() nur im Kollisionsfall aufrufen – sonst ein API-Call je Datei.
    if (!vorh || f.getLastUpdated() > vorh.file.getLastUpdated()) {
      proDatum[d] = { date: d, file: f };
    }
  }
  return Object.keys(proDatum).map(function(d) { return proDatum[d]; });
}

// Datum → Zeilennummer für das gesamte Sheet.
// Grundlage dafür, dass ein Tag ERSETZT statt ein zweites Mal angehängt wird.
function buildDateIndex(sheet) {
  var index = {};
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return index;
  var werte = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < werte.length; i++) {
    var v = werte[i][0];
    var d = (v instanceof Date)
      ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) index[d] = i + 2;  // +2: Kopfzeile + 0-basiert
  }
  return index;
}

// Datum minus n Tage, ohne Zeitzonen-Fallstrick.
// 12:00 UTC als Anker: dadurch kann keine Zeitverschiebung und keine Sommerzeit-
// Umstellung über eine Tagesgrenze kippen.
function minusTage(datumStr, n) {
  var t = new Date(datumStr + 'T12:00:00Z');
  t.setUTCDate(t.getUTCDate() - n);
  return t.toISOString().slice(0, 10);
}

function getOrCreateSheet() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('sheet_id');
  var ss;
  if (sheetId) {
    try {
      ss = SpreadsheetApp.openById(sheetId);
    } catch(e) {
      Logger.log('⚠️ Gespeicherte Sheet-ID ungültig, suche neu: ' + e);
      sheetId = null;
    }
  }
  if (!sheetId) {
    var files = DriveApp.getFilesByName(SHEET_NAME);
    if (files.hasNext()) {
      ss = SpreadsheetApp.open(files.next());
    } else {
      ss = SpreadsheetApp.create(SHEET_NAME);
    }
    props.setProperty('sheet_id', ss.getId());
    Logger.log('✅ Sheet-ID gespeichert: ' + ss.getId());
  }
  var sheet = ss.getActiveSheet();
  if (sheet.getLastRow() === 0) sheet.appendRow(COLUMNS);
  return { ss: ss, sheet: sheet };
}

// Schreibt einen Tag. Existiert bereits eine Zeile mit diesem Datum, wird sie
// ÜBERSCHRIEBEN statt eine zweite anzuhängen – das ist der eigentliche Dubletten-Schutz.
// Gibt true zurück, wenn ersetzt wurde, false bei einem neu angehängten Tag.
// Ersetzt das frühere appendDay(), das ungeprüft angehängt hat.
function upsertDay(sheet, day, index) {
  var zeile = COLUMNS.map(function(col) {
    var v = day[col];
    return (v !== undefined && v !== null) ? v : '';
  });
  var row = index[day.date];
  if (row) {
    sheet.getRange(row, 1, 1, COLUMNS.length).setValues([zeile]);
    return true;
  }
  sheet.appendRow(zeile);
  index[day.date] = sheet.getLastRow();
  return false;
}

function writeToSheet() {
  var DAYS_TO_REFRESH = 2;
  var BATCH_LIMIT = 60;
  var r = getOrCreateSheet();
  var sheet = r.sheet;

  // Frühere Logik: "die letzten DAYS_TO_REFRESH ZEILEN löschen und ab dem Datum der
  // vorletzten Zeile neu einlesen". Das setzte zweierlei voraus – dass das Sheet nach
  // Datum sortiert ist, und dass die letzten Zeilen die neuesten Tage sind. Beides
  // stimmte irgendwann nicht mehr, mit zwei Folgen:
  //   • Eine Datei, die verspätet ankam (z. B. der 23.07., während 25./26. schon
  //     im Sheet standen), lag VOR dem Stichtag und wurde nie wieder eingelesen.
  //   • Nachträglich angehängte Tage standen doppelt im Sheet.
  // Jetzt: kein Löschen mehr. Über einen Datums-Index wird jede Zeile am richtigen
  // Platz ersetzt, und fehlende Tage werden unabhängig von ihrem Alter nachgetragen.
  var index = buildDateIndex(sheet);
  var vorhandene = Object.keys(index).sort();

  // Auffrisch-Fenster: die letzten DAYS_TO_REFRESH Tage ab dem NEUESTEN Datum im
  // Sheet (nicht ab der letzten Zeilennummer). Diese Tage werden neu geschrieben,
  // weil ihre Werte sich im Tagesverlauf noch ändern.
  var refreshDate = vorhandene.length
    ? minusTage(vorhandene[vorhandene.length - 1], DAYS_TO_REFRESH - 1)
    : null;

  var list = getAllHealthFiles().filter(function(item) {
    // (a) Tag fehlt noch → nachtragen, auch wenn er älter ist als das Fenster
    // (b) Tag liegt im Auffrisch-Fenster → neu schreiben
    return !index[item.date] || (refreshDate && item.date >= refreshDate);
  });
  list.sort(function(a, b) { return a.date.localeCompare(b.date); });
  var batch = list.slice(0, BATCH_LIMIT);
  var remaining = list.length - batch.length;
  var neu = 0, ersetzt = 0;
  batch.forEach(function(item) {
    try {
      var raw = JSON.parse(item.file.getBlob().getDataAsString());
      if (upsertDay(sheet, parseDay(item.date, raw.data.metrics), index)) ersetzt++;
      else neu++;
    } catch(e) { Logger.log('Fehler ' + item.date + ': ' + e); }
  });

  // Nachgetragene ältere Tage landen beim Anhängen unten. Einmal sortieren hält das
  // Sheet lesbar – genau die Unordnung hatte die Dubletten zuvor verschleiert.
  var lastRow = sheet.getLastRow();
  if (lastRow > 2) {
    sheet.getRange(2, 1, lastRow - 1, COLUMNS.length).sort({ column: 1, ascending: true });
  }

  sheet.getRange(1,1).setNote('Zuletzt aktualisiert: ' + new Date().toLocaleString('de-DE'));
  if (remaining > 0) {
    Logger.log('✅ ' + neu + ' neu, ' + ersetzt + ' aktualisiert. Noch ' + remaining + ' übrig → erneut ausführen!');
  } else {
    Logger.log('✅ ' + neu + ' neu, ' + ersetzt + ' aktualisiert. Gesamt: ' + (sheet.getLastRow()-1));
  }
  // Workout Data Sheet ebenfalls aktualisieren (CSV-Dateien aus Workout-Ordner)
  try {
    importWorkoutData();
    Logger.log('✅ Workout-Daten aktualisiert.');
  } catch(e) {
    Logger.log('⚠️ Workout-Import übersprungen: ' + e);
  }
  return r.ss.getId();
}

// ================================================================
// WORKOUT DATA IMPORT
// ================================================================

var WORKOUT_FOLDER_ID    = '11ZJtwDCrV_UNofOMTi1VUeWnltONSgQI';
var WORKOUT_SHEET_TITLE  = 'Workout Data';
var WORKOUT_DAYS_TO_REFRESH = 30;

// ── Duration-String parsen: "H:MM:SS" → Dezimalminuten ───────
function parseDurationStr(str) {
  if (!str || typeof str !== 'string') return null;
  str = str.trim();
  var p = str.split(':').map(function(x) { return parseInt(x, 10); });
  if (p.length === 3 && !isNaN(p[0]) && !isNaN(p[1]) && !isNaN(p[2])) {
    return p[0] * 60 + p[1] + p[2] / 60;
  }
  return null;
}

// ── Numerische Anzeigewerte parsen ────────────────────────────
// Google Sheets interpretiert manche Dezimalwerte (z. B. "20.02")
// als Datum "20. Feb. 2026". Diese Funktion macht das rückgängig.
function parseNumericDisplay(str) {
  if (!str || typeof str !== 'string') return null;
  str = str.trim();
  if (str === '') return null;
  // 1. Reines Dezimal "20.02" / "20,02"
  if (/^-?\d+([.,]\d+)?$/.test(str)) {
    return parseFloat(str.replace(',', '.'));
  }
  // 2. Deutsches Datum DD.MM.YYYY → DD.MM
  var mDE = str.match(/^(\d{1,2})\.(\d{2})\.\d{2,4}$/);
  if (mDE) return parseFloat(mDE[1] + '.' + mDE[2]);
  // 3. Langes deutsches Datum "20. Feb. 2026"
  var MONTHS_DE = {
    'jan':'01','feb':'02','mär':'03','mar':'03','apr':'04',
    'mai':'05','may':'05','jun':'06','jul':'07','aug':'08',
    'sep':'09','okt':'10','oct':'10','nov':'11','dez':'12','dec':'12'
  };
  var mLong = str.match(/^(\d{1,2})\.\s*([A-Za-zä]+)\.?\s+\d{2,4}$/);
  if (mLong) {
    var moStr = mLong[2].substring(0, 3).toLowerCase();
    var moNum = MONTHS_DE[moStr];
    if (moNum) return parseFloat(mLong[1] + '.' + moNum);
  }
  // 4. US-Format M/D/YYYY (kann mit EU kollidieren – Heuristik unten)
  var mUS = str.match(/^(\d{1,2})\/(\d{1,2})\/\d{2,4}$/);
  if (mUS) {
    var mo = parseInt(mUS[1], 10);
    var dy = parseInt(mUS[2], 10);
    return parseFloat(dy + '.' + (mo < 10 ? '0' + mo : mo));
  }
  // 5. EU-Schrägstrich D/M/YYYY (nur wenn 1. Teil > 12)
  var mEU = str.match(/^(\d{1,2})\/(\d{1,2})\/\d{2,4}$/);
  if (mEU && parseInt(mEU[1], 10) > 12) {
    var dy2 = parseInt(mEU[1], 10);
    var mo2 = parseInt(mEU[2], 10);
    return parseFloat(dy2 + '.' + (mo2 < 10 ? '0' + mo2 : mo2));
  }
  // 6. Fallback
  var n = parseFloat(str.replace(',', '.'));
  return isNaN(n) ? null : n;
}

// ── Workout-Datei auslesen (Google-Sheet ODER echte CSV) ──────
// Gibt { hdrs: [...], vals: [...] } zurück oder null bei leerer Datei.
function readWorkoutFile(file) {
  var mimeType = file.getMimeType();
  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    var wbk = SpreadsheetApp.open(file);
    var wsh = wbk.getSheets()[0];
    // getDisplayValues() liefert die Zellen so wie angezeigt –
    // "00:22:54" bleibt String statt Date-Objekt zu werden.
    var display = wsh.getDataRange().getDisplayValues();
    if (display.length < 2) return null;
    return {
      hdrs: display[0].map(function(h) { return String(h).trim(); }),
      vals: display[1].map(function(v) { return String(v).trim(); })
    };
  } else {
    var content = file.getBlob().getDataAsString('UTF-8');
    var lines = content.replace(/\r\n/g, '\n').split('\n')
      .filter(function(l) { return l.trim().length > 0; });
    if (lines.length < 2) return null;
    return {
      hdrs: lines[0].split(',').map(function(h) { return h.trim(); }),
      vals: lines[1].split(',').map(function(v) { return v.trim().replace(/^"|"$/g, ''); })
    };
  }
}

// ── Flexible Spaltensuche per Substring im Header ─────────────
function makeGetters(hdrs, vals) {
  var getIdx = function() {
    var subs = Array.prototype.slice.call(arguments);
    for (var i = 0; i < hdrs.length; i++) {
      var h = hdrs[i].toLowerCase();
      for (var j = 0; j < subs.length; j++) {
        if (h.indexOf(subs[j].toLowerCase()) !== -1) return i;
      }
    }
    return -1;
  };
  var getRaw = function() {
    var idx = getIdx.apply(null, arguments);
    return idx >= 0 ? vals[idx] : null;
  };
  var getN = function() {
    var v = getRaw.apply(null, arguments);
    if (!v || v === '') return null;
    return parseNumericDisplay(v);
  };
  return { getIdx: getIdx, getRaw: getRaw, getN: getN };
}

function importWorkoutData() {
  var HEADERS = [
    'Date', 'Type', 'Duration (min)', 'Distance (km)',
    'Avg HR', 'Max HR', 'Speed (km/h)', 'Elevation (m)',
    'Energy (kJ)', 'Cadence', 'Steps'
  ];
  var ss, sheet;
  var existing = DriveApp.getFilesByName(WORKOUT_SHEET_TITLE);
  if (existing.hasNext()) {
    ss = SpreadsheetApp.open(existing.next());
    Logger.log('Bestehendes Sheet gefunden: ' + ss.getId());
  } else {
    ss = SpreadsheetApp.create(WORKOUT_SHEET_TITLE);
    Logger.log('Neues Sheet erstellt: ' + ss.getId());
  }
  sheet = ss.getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
  // Bestehende Zeilen einlesen. Anders als beim Health-Sheet darf hier NICHT pro Datum
  // auf eine Zeile zusammengefasst werden – zwei Einheiten am selben Tag sind legitim.
  // Stattdessen wird das Auffrisch-Fenster komplett neu aufgebaut.
  var lastRow = sheet.getLastRow();
  var bestehend = [];
  if (lastRow > 1) {
    bestehend = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues()
      .map(function(r) {
        var v = r[0];
        r[0] = (v instanceof Date)
          ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd')
          : String(v).trim();
        return r;
      })
      .filter(function(r) { return /^\d{4}-\d{2}-\d{2}$/.test(r[0]); });
  }

  // Fenster über das NEUESTE Datum bestimmen, nicht über die Zeilennummer.
  // Vorher hiess WORKOUT_DAYS_TO_REFRESH zwar "days", zählte aber ZEILEN: die letzten
  // 30 Zeilen spannten bei unregelmässigem Training über vier Monate. Schlimmer noch:
  // eine verspätet abgelegte Datei war älter als der so errechnete Stichtag und wurde
  // dadurch nie eingelesen – dieselbe Lücken-Mechanik wie im Health-Sheet.
  var daten = bestehend.map(function(r) { return r[0]; }).sort();
  var refreshDate = daten.length
    ? minusTage(daten[daten.length - 1], WORKOUT_DAYS_TO_REFRESH - 1)
    : null;
  var vorhandeneDaten = {};
  daten.forEach(function(d) { vorhandeneDaten[d] = true; });
  if (refreshDate) Logger.log('Refreshe ab: ' + refreshDate);

  // Alles ausserhalb des Fensters bleibt unangetastet stehen.
  var behalten = bestehend.filter(function(r) { return !refreshDate || r[0] < refreshDate; });

  var folder = DriveApp.getFolderById(WORKOUT_FOLDER_ID);
  var files = folder.getFiles();
  var rows = [];
  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();
    var dateMatch = name.match(/(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;
    var date = dateMatch[1];
    // Eingelesen wird, was im Fenster liegt ODER bisher überhaupt fehlt (Nachzügler).
    var imFenster = !refreshDate || date >= refreshDate;
    var fehltNoch = !vorhandeneDaten[date];
    if (!imFenster && !fehltNoch) continue;
    try {
      var parsed = readWorkoutFile(file);
      if (!parsed) continue;
      var g = makeGetters(parsed.hdrs, parsed.vals);
      var durationMin = parseDurationStr(g.getRaw('Duration'));
      rows.push([
        date,
        (g.getRaw('Type') || '').trim(),
        durationMin !== null ? Math.round(durationMin * 100) / 100 : null,
        g.getN('Distance', 'Distanz', 'Dist'),
        g.getN('Avg Heart', 'Avg HR'),
        g.getN('Max Heart', 'Max HR'),
        g.getN('Speed'),
        g.getN('Elevation Ascend'),
        g.getN('Active Energy'),
        g.getN('Cadence'),
        g.getN('Step Count', 'Steps')
      ]);
    } catch (e) {
      Logger.log('Fehler bei Datei ' + name + ': ' + e.message);
    }
  }
  // Leere Werte vereinheitlichen, damit der Dubletten-Vergleich unten zuverlässig greift
  // (aus Dateien kommt null, aus dem Sheet ein leerer String).
  var norm = function(r) { return r.map(function(v) { return (v === null || v === undefined) ? '' : v; }); };
  var alle = behalten.map(norm).concat(rows.map(norm));

  // Wortwörtlich identische Zeilen entfernen. Zwei exakt gleiche Einheiten am selben Tag
  // gibt es praktisch nicht – das ist die Signatur einer doppelt in Drive liegenden Datei.
  // Zwei UNTERSCHIEDLICHE Einheiten am selben Tag bleiben dagegen erhalten.
  var gesehen = {}, eindeutig = [];
  alle.forEach(function(r) {
    var key = r.join('');
    if (gesehen[key]) return;
    gesehen[key] = true;
    eindeutig.push(r);
  });
  eindeutig.sort(function(a, b) {
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });

  // Datenbereich geschlossen neu schreiben – dadurch kann weder eine Zeile doppelt
  // stehen bleiben noch eine Restzeile aus einem früheren, längeren Stand überleben.
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, HEADERS.length).clearContent();
  if (eindeutig.length > 0) {
    // setValues erweitert das Blatt nicht von selbst (anders als appendRow) – reicht der
    // Platz nicht, bricht der Aufruf ab. Deshalb vorher aufstocken.
    var benoetigt = eindeutig.length + 1;
    if (benoetigt > sheet.getMaxRows()) {
      sheet.insertRowsAfter(sheet.getMaxRows(), benoetigt - sheet.getMaxRows());
    }
    sheet.getRange(2, 1, eindeutig.length, HEADERS.length).setValues(eindeutig);
  }
  var entfernt = alle.length - eindeutig.length;
  Logger.log('✅ ' + eindeutig.length + ' Workouts im Sheet · ' + rows.length + ' aus Dateien gelesen'
    + (entfernt > 0 ? ' · ' + entfernt + ' Dublette(n) entfernt' : ''));
  Logger.log('Workout Sheet ID (für Dashboard): ' + ss.getId());
  return ss.getId();
}

// ── Laufplaene ─────────────────────────────────────────────────
// Zwei Blaetter, damit der Plan im Sheet von Hand lesbar bleibt:
//   Laufplaene         – eine Zeile je Plan
//   Laufplan-Einheiten – eine Zeile je geplanter Einheit
var LP_PLAENE   = 'Laufplaene';
var LP_EINHEITEN = 'Laufplan-Einheiten';
var LP_KOPF_SPALTEN = ['ID','Name','Notizen','Start','Ende','Wochen','Lauftage','Archiviert'];
var LP_EINHEIT_SPALTEN = ['PlanID','Woche','Wochentag','Datum','Strecke (km)','Zeit (min)','Herzzone'];

function lpBlatt(name, spalten) {
  var ss = SpreadsheetApp.openById(WORKOUT_SHEET_ID);
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(spalten);
    sh.setFrozenRows(1);
  }
  return sh;
}

function laufplanEndpunkt(p) {
  var was = String(p.lp || '');

  if (was === 'planSpeichern') {
    var sh = lpBlatt(LP_PLAENE, LP_KOPF_SPALTEN);
    var id = String(p.id || '').trim() || ('lp' + Date.now());
    var zeile = lpZeileFinden(sh, id);
    var werte = [id, String(p.name || '').slice(0,120), String(p.notizen || '').slice(0,500),
                 String(p.start || ''), String(p.ende || ''), Number(p.wochen || 0) || '',
                 String(p.lauftage || ''), String(p.archiviert || '') === '1' ? 'ja' : ''];
    if (zeile > 0) sh.getRange(zeile, 1, 1, werte.length).setValues([werte]);
    else sh.appendRow(werte);
    return ContentService.createTextOutput('OK ' + id);
  }

  if (was === 'planLoeschen') {
    var shP = lpBlatt(LP_PLAENE, LP_KOPF_SPALTEN);
    var z = lpZeileFinden(shP, String(p.id || ''));
    if (z > 0) shP.deleteRow(z);
    // Zugehoerige Einheiten mitloeschen – von unten nach oben, sonst verschieben
    // sich die Zeilennummern waehrend des Loeschens.
    var shE = lpBlatt(LP_EINHEITEN, LP_EINHEIT_SPALTEN);
    var daten = shE.getDataRange().getValues();
    for (var i = daten.length - 1; i >= 1; i--) {
      if (String(daten[i][0]) === String(p.id)) shE.deleteRow(i + 1);
    }
    return ContentService.createTextOutput('OK geloescht');
  }

  if (was === 'einheitSpeichern') {
    var shE2 = lpBlatt(LP_EINHEITEN, LP_EINHEIT_SPALTEN);
    var daten2 = shE2.getDataRange().getValues();
    var treffer = -1;
    for (var j = 1; j < daten2.length; j++) {
      if (String(daten2[j][0]) === String(p.id) &&
          String(daten2[j][1]) === String(p.woche) &&
          String(daten2[j][2]) === String(p.wochentag)) { treffer = j + 1; break; }
    }
    var w = [String(p.id||''), Number(p.woche||0), String(p.wochentag||''), String(p.datum||''),
             p.strecke ? Number(String(p.strecke).replace(',','.')) : '',
             p.zeit ? Number(p.zeit) : '', String(p.zone || '')];
    if (treffer > 0) shE2.getRange(treffer, 1, 1, w.length).setValues([w]);
    else shE2.appendRow(w);
    return ContentService.createTextOutput('OK Einheit');
  }

  return ContentService.createTextOutput('Unbekannte Aktion');
}

function lpZeileFinden(sh, id) {
  var daten = sh.getDataRange().getValues();
  for (var i = 1; i < daten.length; i++) if (String(daten[i][0]) === id) return i + 1;
  return -1;
}
