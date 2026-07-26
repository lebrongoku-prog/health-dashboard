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
  writeToSheet();
  return ContentService.createTextOutput('OK');
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

function getAllHealthFiles() {
  var folder = getHealthFolder();
  var files = folder.getFiles();
  var list = [];
  while (files.hasNext()) {
    var f = files.next();
    var n = f.getName();
    if (/^HealthAutoExport-\d{4}-\d{2}-\d{2}\.json$/.test(n)) {
      list.push({ date: n.slice(17, 27), file: f });
    }
  }
  return list;
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

function appendDay(sheet, day) {
  sheet.appendRow(COLUMNS.map(function(col) {
    var v = day[col];
    return (v !== undefined && v !== null) ? v : '';
  }));
}

function writeToSheet() {
  var DAYS_TO_REFRESH = 2;
  var BATCH_LIMIT = 60;
  var r = getOrCreateSheet();
  var sheet = r.sheet;
  var lastRow = sheet.getLastRow();
  var refreshDate = null;
  if (lastRow > 1) {
    var refreshRow = Math.max(2, lastRow - DAYS_TO_REFRESH + 1);
    var val = sheet.getRange(refreshRow, 1).getValue();
    refreshDate = (val instanceof Date)
      ? Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : String(val);
    sheet.deleteRows(refreshRow, lastRow - refreshRow + 1);
  }
  var list = getAllHealthFiles().filter(function(item) {
    return !refreshDate || item.date >= refreshDate;
  });
  list.sort(function(a, b) { return a.date.localeCompare(b.date); });
  var batch = list.slice(0, BATCH_LIMIT);
  var remaining = list.length - batch.length;
  var added = 0;
  batch.forEach(function(item) {
    try {
      var raw = JSON.parse(item.file.getBlob().getDataAsString());
      appendDay(sheet, parseDay(item.date, raw.data.metrics));
      added++;
    } catch(e) { Logger.log('Fehler ' + item.date + ': ' + e); }
  });
  sheet.getRange(1,1).setNote('Zuletzt aktualisiert: ' + new Date().toLocaleString('de-DE'));
  if (remaining > 0) {
    Logger.log('✅ ' + added + ' Tage aktualisiert. Noch ' + remaining + ' übrig → erneut ausführen!');
  } else {
    Logger.log('✅ ' + added + ' Tage aktualisiert. Gesamt: ' + (sheet.getLastRow()-1));
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
  var lastRow = sheet.getLastRow();
  var refreshDate = null;
  if (lastRow > 1) {
    var refreshRow = Math.max(2, lastRow - WORKOUT_DAYS_TO_REFRESH + 1);
    var val = sheet.getRange(refreshRow, 1).getValue();
    refreshDate = (val instanceof Date)
      ? Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : String(val);
    sheet.deleteRows(refreshRow, lastRow - refreshRow + 1);
    Logger.log('Refreshe ab: ' + refreshDate);
  }
  var folder = DriveApp.getFolderById(WORKOUT_FOLDER_ID);
  var files = folder.getFiles();
  var rows = [];
  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();
    var dateMatch = name.match(/(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;
    var date = dateMatch[1];
    if (refreshDate && date < refreshDate) continue;
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
  rows.sort(function(a, b) {
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  if (rows.length > 0) {
    var startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rows.length, HEADERS.length).setValues(rows);
    Logger.log(rows.length + ' Einträge importiert.');
  } else {
    Logger.log('Keine neuen Einträge gefunden.');
  }
  Logger.log('Workout Sheet ID (für Dashboard): ' + ss.getId());
  return ss.getId();
}
