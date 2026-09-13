const { withRetry } = require('./_lib/reliability');

/**
 * Sends a completed QA.Hub AI audit to a Google Apps Script Web App.
 * The Apps Script endpoint appends one row to the client's Google Sheet.
 *
 * This is deliberately a separate integration layer: if Google Sheets is
 * unavailable, the QA audit itself is still kept in Firebase.
 */
module.exports = async function exportAuditToGoogleSheet({ audit, call, processId, callKey }) {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!webhookUrl) return { synced: false, skipped: true, reason: 'GOOGLE_SHEETS_WEBHOOK_URL not configured' };

  const payload = {
    date: audit.date || audit.callDate || new Date().toISOString(),
    agentName: audit.agentName || call.agentName || '',
    tlName: audit.tlName || call.tlName || call.tl || '',
    customerNo: audit.customerNo || audit.callerNumber || call.callerNumber || call.customerNumber || '',
    recording: audit.recording || call.recordingUrl || '',
    qualityScore: audit.qualityScore ?? audit.totalScore ?? null,
    summary: audit.summary || audit.callSummary || '',
    criticalFatal: Boolean(audit.crFatal || audit.fatal),
    criticalParameters: audit.criticalParameters || '',
    nonCriticalParameters: audit.nonCriticalParameters || '',
    coachingSuggestions: audit.coachingSuggestions || audit.coachingTips || '',
    feedbackGiven: audit.feedbackGiven || '',
    remarks: audit.remarks || audit.recommendation || '',
    processId,
    callKey,
    source: 'QA.Hub AI Audit',
  };

  const response = await withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      return await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }, { retries: 1, baseDelayMs: 1000, maxDelayMs: 5000, label: 'Google Sheets export' });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Google Sheets export failed (${response.status}): ${text.slice(0, 250)}`);
  }

  return { synced: true, payload };
};
