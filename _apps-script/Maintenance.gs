// ================================================================
// Wartungs- und Einmal-Skripte
// ================================================================
// Diese Funktionen sind keine Production-Endpunkte, sondern
// werden bei Bedarf manuell aus dem Apps-Script-Editor ausgeführt.
//
// Apps Script teilt sich den globalen Namespace über alle .gs-
// Dateien hinweg – COLUMNS, SHEET_NAME, getOrCreateSheet,
// getHealthFolder, extractTime usw. werden aus Code.gs übernommen.
// ================================================================

// ── Fehlende Spalten ans Sheet-Header anhängen ────────────────
// Hilfreich nach Erweiterung von COLUMNS in Code.gs.
function addMissingColumns() {
  var r = getOrCreateSheet();
  var sheet = r.sheet;
  var headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var added = 0;
  COLUMNS.forEach(function(col) {
    if (headerRow.indexOf(col) === -1) {
      var newColIndex = sheet.getLastColumn() + 1;
      sheet.getRange(1, newColIndex).setValue(col);
      Logger.log('➕ Spalte hinzugefügt: ' + col + ' (Spalte ' + newColIndex + ')');
      headerRow.push(col);
      added++;
    }
  });
  if (added === 0) {
    Logger.log('✅ Alle Spalten bereits vorhanden – nichts zu tun.');
  } else {
    Logger.log('✅ ' + added + ' neue Spalte(n) ergänzt.');
  }
}

// ── Sheet-ID neu in ScriptProperties einspeichern ─────────────
function initSheet() {
  var props = PropertiesService.getScriptProperties();
  var files = DriveApp.getFilesByName(SHEET_NAME);
  if (!files.hasNext()) {
    Logger.log('❌ Kein Sheet mit Name "' + SHEET_NAME + '" gefunden.');
    return;
  }
  var ss = SpreadsheetApp.open(files.next());
  props.setProperty('sheet_id', ss.getId());
  Logger.log('✅ Sheet-ID gespeichert: ' + ss.getId());
  Logger.log('   Sheet: ' + ss.getUrl());
  Logger.log('   Zeilen: ' + (ss.getActiveSheet().getLastRow() - 1) + ' Datentage');
}

// ── Vollständiger Batch-Import (Initial- oder Wiederherstellungs-Run) ──
// Importiert alle JSON-Dateien aus dem Health-Ordner in Batches à 50,
// merkt sich den Fortschritt in ScriptProperties und kann beliebig oft
// hintereinander ausgeführt werden, bis alles geladen ist.
function writeToSheetBatch() {
  var BATCH = 50;
  var props = PropertiesService.getScriptProperties();
  var lastDone = props.getProperty('batch_last_date') || '0000-00-00';
  var r = getOrCreateSheet();
  var sheet = r.sheet;
  // Schreibt über upsertDay statt über das frühere appendDay. Vorher hängte dieses
  // Skript ungeprüft an – es schaute weder ins Sheet noch löschte es etwas. Wurde es
  // ausgeführt, um eine Lücke zu schliessen, entstanden dabei Zweitzeilen für alle
  // Tage, die bereits vorhanden waren (im Sheet als Block ganz unten sichtbar).
  var index = buildDateIndex(sheet);
  var list = getAllHealthFiles().filter(function(item) {
    return item.date > lastDone;
  });
  list.sort(function(a, b) { return a.date.localeCompare(b.date); });
  var batch = list.slice(0, BATCH);
  batch.forEach(function(item) {
    try {
      var raw = JSON.parse(item.file.getBlob().getDataAsString());
      upsertDay(sheet, parseDay(item.date, raw.data.metrics), index);
      props.setProperty('batch_last_date', item.date);
    } catch(e) { Logger.log('Fehler ' + item.date + ': ' + e); }
  });
  var remaining = list.length - batch.length;
  if (remaining > 0) {
    Logger.log('✅ ' + batch.length + ' Tage verarbeitet. Noch ' + remaining + ' übrig → writeToSheetBatch() erneut ausführen!');
  } else {
    Logger.log('🎉 Alle Daten geladen! Gesamt: ' + (sheet.getLastRow()-1) + ' Tage.');
    props.deleteProperty('batch_last_date');
  }
  sheet.getRange(1,1).setNote('Zuletzt aktualisiert: ' + new Date().toLocaleString('de-DE'));
  return r.ss.getId();
}

// ── Fehlende HR-Werte im Sheet aus den JSON-Dateien nachladen ─
// Hinweis: `fixHRValues()` ist entfallen (05.09.2026). Es reparierte die Spalten
// hrAvg/hrMin/hrMax, die es seit der Spaltenkuerzung nicht mehr gibt — der Aufruf
// waere in einen Fehler gelaufen (COLUMNS.indexOf('hrAvg') + 1 ergibt 0, und
// getRange(zeile, 0) bricht ab).

// ── Sheet sortieren, Datums-Strings vereinheitlichen, Duplikate raus ──
function cleanSheet() {
  var r = getOrCreateSheet();
  var sheet = r.sheet;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('Keine Daten.'); return; }
  var data = sheet.getRange(2, 1, lastRow - 1, COLUMNS.length).getValues();
  data = data.map(function(row) {
    if (row[0] instanceof Date) {
      row[0] = Utilities.formatDate(row[0], Session.getScriptTimeZone(), 'yyyy-MM-dd');
    }
    return row;
  });
  data.sort(function(a, b) { return String(a[0]).localeCompare(String(b[0])); });
  var seen = {};
  data = data.filter(function(row) {
    var d = String(row[0]);
    if (!d || seen[d]) return false;
    seen[d] = true;
    return true;
  });
  sheet.getRange(2, 1, lastRow - 1, COLUMNS.length).clearContent();
  if (data.length > 0) {
    sheet.getRange(2, 1, data.length, COLUMNS.length).setValues(data);
  }
  Logger.log('✅ Fertig: ' + data.length + ' eindeutige Tage, aufsteigend sortiert.');
}

// ── Fehlende sleepStart/sleepEnd-Zellen nachladen ─────────────
function fixSleepTimes() {
  var BATCH = 40;
  var props = PropertiesService.getScriptProperties();
  var startRow = parseInt(props.getProperty('fix_sleep_last_row') || '2');
  var r = getOrCreateSheet();
  var sheet = r.sheet;
  var lastRow = sheet.getLastRow();
  if (startRow > lastRow) {
    Logger.log('🎉 Fertig! Alle Schlafzeiten wurden geprüft.');
    props.deleteProperty('fix_sleep_last_row');
    return;
  }
  var folder = getHealthFolder();
  var sleepStartCol = COLUMNS.indexOf('sleepStart') + 1;
  var sleepEndCol   = COLUMNS.indexOf('sleepEnd')   + 1;
  if (sleepStartCol === 0 || sleepEndCol === 0) {
    Logger.log('❌ Spalten sleepStart/sleepEnd nicht gefunden. Zuerst addMissingColumns() ausführen!');
    return;
  }
  var endRow  = Math.min(startRow + BATCH - 1, lastRow);
  var numRows = endRow - startRow + 1;
  var batchData = sheet.getRange(startRow, 1, numRows, COLUMNS.length).getValues();
  var fixed = 0;
  for (var i = 0; i < batchData.length; i++) {
    var row     = batchData[i];
    var dateVal = row[0];
    var dateStr = (dateVal instanceof Date)
      ? Utilities.formatDate(dateVal, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : String(dateVal);
    if (!dateStr || dateStr.length < 10) continue;
    var curStart = row[COLUMNS.indexOf('sleepStart')];
    var curEnd   = row[COLUMNS.indexOf('sleepEnd')];
    if (curStart !== '' && curStart !== null && curEnd !== '' && curEnd !== null) continue;
    var found = folder.getFilesByName('HealthAutoExport-' + dateStr + '.json');
    if (!found.hasNext()) continue;
    try {
      var raw = JSON.parse(found.next().getBlob().getDataAsString());
      var sleepMetric = null;
      for (var j = 0; j < raw.data.metrics.length; j++) {
        if (raw.data.metrics[j].name === 'sleep_analysis') { sleepMetric = raw.data.metrics[j]; break; }
      }
      if (!sleepMetric || !sleepMetric.data || !sleepMetric.data.length) continue;
      var s          = sleepMetric.data[0];
      var sleepStart = extractTime(s.sleepStart || s.inBedStart);
      var sleepEnd   = extractTime(s.sleepEnd   || s.inBedEnd);
      if (!sleepStart && !sleepEnd) continue;
      var sheetRow = startRow + i;
      if (sleepStart) sheet.getRange(sheetRow, sleepStartCol).setValue(sleepStart);
      if (sleepEnd)   sheet.getRange(sheetRow, sleepEndCol).setValue(sleepEnd);
      fixed++;
    } catch(e) { Logger.log('Fehler ' + dateStr + ': ' + e); }
  }
  props.setProperty('fix_sleep_last_row', String(endRow + 1));
  var remaining = lastRow - endRow;
  if (remaining > 0) {
    Logger.log('✅ ' + fixed + ' Zeilen befüllt. Noch ~' + remaining + ' übrig → fixSleepTimes() erneut ausführen!');
  } else {
    Logger.log('🎉 Fertig! ' + fixed + ' Schlafzeit-Einträge ergänzt.');
    props.deleteProperty('fix_sleep_last_row');
  }
}

// ── Aus Backup wiederherstellen ───────────────────────────────
function restoreFromBackup() {
  var BACKUP_NAME = 'Health Dashboard Data_Backup 2026-05-02';
  var backupFiles = DriveApp.getFilesByName(BACKUP_NAME);
  if (!backupFiles.hasNext()) {
    Logger.log('❌ Backup-Datei nicht gefunden: ' + BACKUP_NAME);
    return;
  }
  var backupSheet = SpreadsheetApp.open(backupFiles.next()).getActiveSheet();
  var lastRow = backupSheet.getLastRow();
  if (lastRow < 2) { Logger.log('❌ Backup ist leer.'); return; }
  // Diese Sicherung stammt aus der Zeit der 32-Spalten-Fassung; die Zeilen
  // positionsbasiert in das gekuerzte Blatt zu schreiben, wuerde die Werte unter
  // falsche Ueberschriften legen. Wer sie wirklich zurueckholen will, laesst sie
  // erst durch _spaltenUmbau() laufen.
  var backupKopf = backupSheet.getRange(1, 1, 1, backupSheet.getLastColumn()).getValues()[0]
                              .map(function (v) { return String(v).trim(); });
  var passt = backupKopf.length === COLUMNS.length
    && COLUMNS.every(function (c, i) { return backupKopf[i] === c; });
  if (!passt) {
    throw new Error('Backup hat ' + backupKopf.length + ' Spalten, das Blatt erwartet '
      + COLUMNS.length + '. Positionsbasiertes Zurueckschreiben wuerde die Werte '
      + 'verschieben — Sicherung zuerst mit _spaltenUmbau() umstellen.');
  }
  var data = backupSheet.getRange(2, 1, lastRow - 1, COLUMNS.length).getValues();
  var r = getOrCreateSheet();
  var sheet = r.sheet;
  var curLast = sheet.getLastRow();
  if (curLast > 1) sheet.getRange(2, 1, curLast - 1, COLUMNS.length).clearContent();
  sheet.getRange(2, 1, data.length, COLUMNS.length).setValues(data);
  PropertiesService.getScriptProperties().deleteProperty('fix_sleep_last_row');
  Logger.log('✅ Wiederhergestellt: ' + data.length + ' Tage aus Backup.');
}

// ── Workout-Daten aus konsolidiertem Sheet lesen (Utility) ────
// Wird nicht von der Production benutzt – nur als Helper für
// zukünftige Analysen oder Migration.
function getWorkoutData() {
  var ss   = SpreadsheetApp.openById(WORKOUT_SHEET_ID);
  var sh   = ss.getSheets()[0];
  var vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  var headers = vals[0].map(function(h) { return String(h).trim(); });
  return vals.slice(1).map(function(row) {
    var obj = {};
    headers.forEach(function(h, i) {
      var cell = row[i];
      if (cell instanceof Date) {
        obj[h] = Utilities.formatDate(cell, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      } else if (cell === '' || cell === null || cell === undefined) {
        obj[h] = null;
      } else {
        obj[h] = cell;
      }
    });
    return obj;
  });
}

// ════════════════════════════════════════════════════════════════
// EINMALIGE UMSCHICHTUNG AUF DIE GEKUERZTEN SPALTENLISTEN (05.09.2026)
// ════════════════════════════════════════════════════════════════
// Warum das noetig ist: Beide Importe schreiben ihre Zeilen POSITIONSBASIERT ab
// Spalte A und die Kopfzeile nur, wenn das Blatt leer ist. Kuerzt man COLUMNS bzw.
// WORKOUT_SPALTEN einfach, stehen die neuen Werte unter den alten Ueberschriften —
// das Dashboard liest nach Namen und faende dann z. B. den Ruhepuls unter 'distKm'.
//
// Diese Funktion baut deshalb beide Blaetter einmalig um: Sicherung anlegen, Zeilen
// NACH SPALTENNAMEN in die neue Reihenfolge bringen, zurueckschreiben, gegenlesen.
// Danach nicht mehr noetig — ausser die Spaltenlisten aendern sich erneut.
//
// AUSFUEHREN: einmal von Hand im Editor. Das Protokoll sagt, was passiert ist.
function migriereSpalten() {
  var zeilen = [];
  zeilen.push(_spaltenUmbau(getOrCreateSheet().sheet, COLUMNS, 'Health Dashboard Data'));
  zeilen.push(_spaltenUmbau(_workoutBlatt(), WORKOUT_SPALTEN, 'Workout Data'));
  var text = zeilen.join('\n\n');
  Logger.log(text);
  return text;
}

// Das Workout-Blatt finden, ohne den Import anzustossen.
function _workoutBlatt() {
  var dateien = DriveApp.getFilesByName(WORKOUT_SHEET_TITLE);
  if (!dateien.hasNext()) throw new Error('Workout-Sheet nicht gefunden: ' + WORKOUT_SHEET_TITLE);
  return SpreadsheetApp.open(dateien.next()).getSheets()[0];
}

function _spaltenUmbau(blatt, neueSpalten, name) {
  var alle = blatt.getDataRange().getValues();
  if (!alle.length) return name + ': leer, nichts zu tun.';

  var altKopf = alle[0].map(function (v) { return String(v).trim(); });

  // Schon umgestellt? Dann nichts anfassen — die Funktion ist damit gefahrlos
  // mehrfach ausfuehrbar.
  var schonFertig = altKopf.length === neueSpalten.length
    && neueSpalten.every(function (c, i) { return altKopf[i] === c; });
  if (schonFertig) return name + ': bereits im neuen Layout (' + (alle.length - 1) + ' Zeilen), nichts geaendert.';

  // Jede gewuenschte Spalte in der ALTEN Kopfzeile suchen. Fehlt eine, bleibt sie leer –
  // das ist kein Fehler (eine Spalte kann spaeter dazugekommen sein).
  var quelle = neueSpalten.map(function (c) { return altKopf.indexOf(c); });
  var fehlend = neueSpalten.filter(function (c, i) { return quelle[i] < 0; });

  var daten = alle.slice(1);
  var neu = daten.map(function (r) {
    return quelle.map(function (i) { return i >= 0 ? r[i] : ''; });
  });

  // 1. Sicherung ANLEGEN, bevor irgendetwas geschrieben wird.
  var stempel = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  var sicherung = blatt.copyTo(blatt.getParent()).setName('Backup ' + stempel);

  // 2. Blatt leeren und im neuen Layout neu schreiben.
  blatt.clear();
  blatt.getRange(1, 1, 1, neueSpalten.length).setValues([neueSpalten]);
  if (neu.length) {
    var benoetigt = neu.length + 1;
    if (benoetigt > blatt.getMaxRows()) blatt.insertRowsAfter(blatt.getMaxRows(), benoetigt - blatt.getMaxRows());
    blatt.getRange(2, 1, neu.length, neueSpalten.length).setValues(neu);
  }
  blatt.setFrozenRows(1);

  // 3. GEGENLESEN: das tatsaechlich Geschriebene mit dem Erwarteten vergleichen.
  //    Ohne diesen Schritt waere nur belegt, dass der Aufruf nicht abgebrochen ist.
  var kontrolle = blatt.getDataRange().getValues();
  var abweichungen = 0;
  for (var z = 0; z < neu.length; z++) {
    for (var sp = 0; sp < neueSpalten.length; sp++) {
      if (String(kontrolle[z + 1][sp]) !== String(neu[z][sp])) abweichungen++;
    }
  }

  return name + ': ' + altKopf.length + ' → ' + neueSpalten.length + ' Spalten, '
    + neu.length + ' Zeilen umgestellt.'
    + (fehlend.length ? ' In der alten Kopfzeile fehlten: ' + fehlend.join(', ') + ' (leer gelassen).' : '')
    + ' Gegenprobe: ' + (abweichungen === 0 ? 'alle Werte stimmen.' : abweichungen + ' ABWEICHUNGEN!')
    + ' Sicherung: "' + sicherung.getName() + '".';
}
