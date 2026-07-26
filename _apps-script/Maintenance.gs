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
  var list = getAllHealthFiles().filter(function(item) {
    return item.date > lastDone;
  });
  list.sort(function(a, b) { return a.date.localeCompare(b.date); });
  var batch = list.slice(0, BATCH);
  batch.forEach(function(item) {
    try {
      var raw = JSON.parse(item.file.getBlob().getDataAsString());
      appendDay(sheet, parseDay(item.date, raw.data.metrics));
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
function fixHRValues() {
  var BATCH = 40;
  var props = PropertiesService.getScriptProperties();
  var startRow = parseInt(props.getProperty('fix_hr_last_row') || '2');
  var r = getOrCreateSheet();
  var sheet = r.sheet;
  var lastRow = sheet.getLastRow();
  if (startRow > lastRow) {
    Logger.log('🎉 Fertig! Alle HR-Werte wurden geprüft.');
    props.deleteProperty('fix_hr_last_row');
    return;
  }
  var folder = getHealthFolder();
  var hrAvgCol = COLUMNS.indexOf('hrAvg') + 1;
  var hrMinCol = COLUMNS.indexOf('hrMin') + 1;
  var hrMaxCol = COLUMNS.indexOf('hrMax') + 1;
  var endRow = Math.min(startRow + BATCH - 1, lastRow);
  var numRows = endRow - startRow + 1;
  var batchData = sheet.getRange(startRow, 1, numRows, COLUMNS.length).getValues();
  var fixed = 0;
  for (var i = 0; i < batchData.length; i++) {
    var row = batchData[i];
    var hrAvg = row[COLUMNS.indexOf('hrAvg')];
    if (hrAvg !== 0 && hrAvg !== '') continue;
    var dateVal = row[0];
    var dateStr = (dateVal instanceof Date)
      ? Utilities.formatDate(dateVal, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : String(dateVal);
    if (!dateStr || dateStr.length < 10) continue;
    var found = folder.getFilesByName('HealthAutoExport-' + dateStr + '.json');
    if (!found.hasNext()) continue;
    try {
      var raw = JSON.parse(found.next().getBlob().getDataAsString());
      var hrMetric = null;
      for (var j = 0; j < raw.data.metrics.length; j++) {
        if (raw.data.metrics[j].name === 'heart_rate') { hrMetric = raw.data.metrics[j]; break; }
      }
      if (!hrMetric || !hrMetric.data || !hrMetric.data.length) continue;
      var pts = hrMetric.data;
      var avg = pts[0].Avg, mn = pts[0].Min, mx = pts[0].Max;
      if (!avg) {
        var vals = pts.map(function(p){ return p.qty||0; }).filter(function(v){ return v>0; });
        if (vals.length) {
          avg = vals.reduce(function(a,b){ return a+b; },0)/vals.length;
          mn = Math.min.apply(null,vals);
          mx = Math.max.apply(null,vals);
        }
      }
      var sheetRow = startRow + i;
      sheet.getRange(sheetRow, hrAvgCol).setValue(Math.round(avg||0));
      sheet.getRange(sheetRow, hrMinCol).setValue(Math.round(mn||0));
      sheet.getRange(sheetRow, hrMaxCol).setValue(Math.round(mx||0));
      fixed++;
    } catch(e) { Logger.log('Fehler ' + dateStr + ': ' + e); }
  }
  props.setProperty('fix_hr_last_row', String(endRow + 1));
  var remaining = lastRow - endRow;
  if (remaining > 0) {
    Logger.log('✅ ' + fixed + ' Zeilen korrigiert. Noch ~' + remaining + ' übrig → fixHRValues() erneut ausführen!');
  } else {
    Logger.log('🎉 Fertig! ' + fixed + ' HR-Einträge korrigiert.');
    props.deleteProperty('fix_hr_last_row');
  }
}

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
  var data = backupSheet.getRange(2, 1, lastRow - 1, COLUMNS.length - 2).getValues();
  var r = getOrCreateSheet();
  var sheet = r.sheet;
  var curLast = sheet.getLastRow();
  if (curLast > 1) sheet.getRange(2, 1, curLast - 1, COLUMNS.length).clearContent();
  sheet.getRange(2, 1, data.length, COLUMNS.length - 2).setValues(data);
  PropertiesService.getScriptProperties().deleteProperty('fix_hr_last_row');
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
