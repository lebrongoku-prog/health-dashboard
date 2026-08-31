// ================================================================
// Health Auto Export → Dashboard API
// ================================================================
// Production-Code: doGet/doPost-Endpunkte, Health-Daten-Import,
// Workout-Daten-Import.
//
// Wartungs- und Einmal-Skripte (fixHRValues, cleanSheet,
// initSheet, restoreFromBackup, …) liegen in Maintenance.gs.
// ================================================================

var WORKOUT_SHEET_ID = '1YJ3ke8Z2jS1KdJlKOnukUStMgvqqppnktAb8UVHDdgk';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🔄 Health Import')
    .addItem('Jetzt aktualisieren', 'writeToSheet')
    .addToUi();
}

// ── Zugangspruefung ────────────────────────────────────────────
// Frueher stand hier ein festes Passwort (var SECRET). Es musste zugleich in app.js
// stehen, damit die App es mitschicken kann – und app.js liefert GitHub Pages an
// jeden aus. Damit konnte jeder, der das Projekt fand, diesen Endpunkt bedienen und
// Laufplan-Eintraege anlegen, aendern und loeschen.
//
// Ein Passwort im Quelltext einer Webseite laesst sich grundsaetzlich nicht geheim
// halten. Deshalb ist es ersatzlos entfallen. Stattdessen schickt die App ihren
// Google-Zugang mit, und hier wird geprueft, ob dieser Zugang die (private) Tabelle
// lesen darf. Wer das darf, ist berechtigt – wer nicht, kommt nicht weiter. Ein
// Fremder kann sich keinen solchen Zugang beschaffen: Google liefert ihn nur an die
// hinterlegte Adresse der App zurueck.
//
// Die Laufplan-Endpunkte sind ganz entfallen; die App schreibt inzwischen selbst
// ueber die Sheets-API. Uebrig bleibt der Import Drive → Sheet, denn NUR das Skript
// kommt an die Health-Auto-Export-Dateien in Drive.
function zugangGueltig(zugang) {
  if (!zugang || String(zugang).length < 20) {
    Logger.log('zugangGueltig: kein Zugang mitgeschickt');
    return false;
  }
  try {
    var res = UrlFetchApp.fetch(
      'https://sheets.googleapis.com/v4/spreadsheets/' + WORKOUT_SHEET_ID + '?fields=spreadsheetId',
      { headers: { Authorization: 'Bearer ' + zugang }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      Logger.log('zugangGueltig: Google lehnt den Zugang ab (' + res.getResponseCode() + ')');
      return false;
    }
    return true;
  } catch (err) {
    // WICHTIG: Hier landet man auch, wenn das Skript nach dem Einfuegen des neuen
    // Codes nie neu berechtigt wurde – UrlFetchApp braucht eine Erlaubnis, die es
    // vorher nicht hatte. Ohne diese Zeile im Protokoll sieht das genauso aus wie
    // ein falscher Zugang, und man sucht an der falschen Stelle.
    Logger.log('zugangGueltig: UrlFetchApp scheitert – Skript vermutlich nicht neu '
      + 'berechtigt. Einmal selbsttest() im Editor ausfuehren. Fehler: ' + err);
    return false;
  }
}

function antwort(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// GET macht bewusst nichts mehr. Der Import laeuft ueber POST, weil der Google-Zugang
// dort in den Rumpf gehoert: Adressen landen in Server-Protokollen, Rumpfdaten nicht.
function doGet(e) {
  return antwort({ ok: true, hinweis: 'Import per POST mit {"refresh":true,"zugang":"<Google-Token>"}' });
}

function doPost(e) {
  var daten = {};
  try { daten = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { daten = {}; }

  if (!zugangGueltig(daten.zugang)) {
    return antwort({ error: 'Unauthorized' });
  }
  if (daten.refresh) {
    try { writeToSheet(); }
    catch (err) { return antwort({ error: String(err) }); }
  }
  return antwort({ ok: true });
}

// Hinweis: Die frueheren Laufplan-Endpunkte (planEndpunkt, planBlatt, planDatumStr,
// laufplanEndpunkt, lpBlatt, lpZeileFinden samt LP_*-Konstanten) sind entfallen.
// Die App legt die Blaetter 'Laufplan', 'Laufplaene' und 'Laufplan-Einheiten' jetzt
// selbst an und schreibt direkt ueber die Sheets-API – abgesichert durch die
// Google-Anmeldung statt durch ein Passwort im oeffentlichen Quelltext.

// ── Automatischer Import (ersetzt den frueheren Aufruf per Adresse) ──────────
// Bis zur Umstellung liess sich der Import ueber die Web-Adresse ausloesen, abgesichert
// mit dem Passwort im Quelltext. Alles, was auf dem Handy eingerichtet war und diese
// Adresse aufrief, konnte den Import damit anstossen – und ist seit dem Wegfall des
// Passworts stumm, denn ein Google-Zugang laesst sich dort nicht mitgeben.
//
// Die Loesung fuehrt NICHT ueber ein neues Geheimnis, sondern ueber einen Zeitplan im
// Skript selbst: Es holt sich die Dateien von sich aus. Damit braucht es von aussen
// gar keinen Ausloeser mehr – das ist zugleich zuverlaessiger als der fruehere Ping,
// der bei jedem Netzfehler auf dem Handy einfach ausfiel.
//
// EINMAL im Apps-Script-Editor ausfuehren. Danach laeuft der Import stuendlich.
function installiereStuendlichenImport() {
  loescheImportTrigger();
  ScriptApp.newTrigger('writeToSheet').timeBased().everyHours(1).create();
  var msg = 'Stuendlicher Import eingerichtet. Naechster Lauf innerhalb der naechsten Stunde.';
  Logger.log(msg);
  return msg;
}

function loescheImportTrigger() {
  var weg = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'writeToSheet') { ScriptApp.deleteTrigger(t); weg++; }
  });
  Logger.log('Entfernte Import-Trigger: ' + weg);
  return weg;
}

// ── Selbsttest ───────────────────────────────────────────────────────────────
// Prueft der Reihe nach die drei Stellen, an denen es klemmen kann, und schreibt das
// Ergebnis ins Protokoll (Editor: Ausfuehrungsprotokoll). Ein Aufruf von Hand loest
// ausserdem die faellige Neu-Berechtigung aus, falls sie noch aussteht.
function selbsttest() {
  var zeilen = [];

  zeilen.push('1. Nach aussen telefonieren (fuer die Zugangspruefung der App):');
  try {
    var res = UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/'
      + WORKOUT_SHEET_ID + '?fields=spreadsheetId', { muteHttpExceptions: true });
    zeilen.push('   OK – UrlFetchApp ist berechtigt (Antwort ' + res.getResponseCode()
      + ', 401 ist hier richtig: ohne Zugang darf niemand lesen).');
  } catch (err) {
    zeilen.push('   FEHLER – ' + err + '\n   → Das Skript ist nicht neu berechtigt. '
      + 'Solange das so ist, lehnt es JEDEN Aufruf der App ab.');
  }

  zeilen.push('2. Drive-Ordner mit den Health-Dateien:');
  try {
    var dateien = getAllHealthFiles();
    zeilen.push('   OK – ' + dateien.length + ' Datei(en) gefunden.');
    if (dateien.length) {
      var neueste = dateien.map(function (d) { return d.date; }).sort().pop();
      zeilen.push('   Neuester Tag in den Dateien: ' + neueste);
    } else {
      zeilen.push('   ACHTUNG – keine Dateien. Dann liegt es NICHT am Skript, sondern '
        + 'daran, dass vom Handy nichts in Drive ankommt.');
    }
  } catch (err) {
    zeilen.push('   FEHLER – ' + err);
  }

  zeilen.push('3. Zeitplan fuer den automatischen Import:');
  var trigger = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'writeToSheet';
  });
  zeilen.push(trigger.length
    ? '   OK – ' + trigger.length + ' Zeitplan aktiv.'
    : '   FEHLT – einmal installiereStuendlichenImport() ausfuehren.');

  var text = zeilen.join('\n');
  Logger.log(text);
  return text;
}

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

