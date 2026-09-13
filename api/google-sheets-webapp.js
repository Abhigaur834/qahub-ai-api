/**
 * Reference Google Apps Script Web App for QA.Hub.
 * Copy this file into Google Apps Script attached to the client's Sheet.
 *
 * Expected sheet headers:
 * Date | Agent Name | TL NAME | Customer No. | Recording | Quality Score | Summary |
 * ⚡ Critical Parameters Any N = FATAL FAIL | Non-Critical Parameters |
 * Coaching Suggestions | Feedback Given | Remarks
 */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    var props = PropertiesService.getScriptProperties();
    var secret = props.getProperty('QAHUB_SYNC_SECRET');
    if (secret && body.syncSecret !== secret) {
      return json({ success: false, error: 'Unauthorized' });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetName = props.getProperty('QAHUB_SHEET_NAME') || 'AI Audit Data';
    var sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);

    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        'Date','Agent Name','TL NAME','Customer No.','Recording','Quality Score','Summary',
        '⚡ Critical Parameters Any N = FATAL FAIL','Non-Critical Parameters',
        'Coaching Suggestions','Feedback Given','Remarks'
      ]);
    }

    var key = [body.processId || '', body.callKey || ''].join('|');
    var last = sheet.getLastRow();
    if (last > 1) {
      var keys = sheet.getRange(2, 13, last - 1, 1).getValues().flat();
      if (keys.indexOf(key) !== -1) return json({ success: true, duplicate: true });
    }

    sheet.appendRow([
      body.date || '', body.agentName || '', body.tlName || '', body.customerNo || '',
      body.recording || '', body.qualityScore ?? '', body.summary || '',
      body.criticalParameters || '', body.nonCriticalParameters || '',
      body.coachingSuggestions || '', body.feedbackGiven || '', body.remarks || '',
      key
    ]);

    return json({ success: true });
  } catch (err) {
    return json({ success: false, error: String(err.message || err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
