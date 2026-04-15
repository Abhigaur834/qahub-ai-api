/**
 * QA.Hub — Universal Dialer Webhook
 * CommonJS format — required by Vercel Node.js runtime
 * POST /api/webhook?orgId=CX
 */

const admin = require('firebase-admin');

function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
  }
  return admin.database();
}

function detectDialer(body) {
  if (body.CallSid || body.CallTo)                    return 'exotel';
  if (body.ucid || body.campaign_id)                  return 'ozonetel';
  if (body.call_id && body.virtual_number)            return 'knowlarity';
  if (body.call_id && body.agent_number)              return 'servetel';
  return 'generic';
}

function normalizePayload(body, query) {
  const processId = query.orgId || query.processId || body.orgId || body.processId || 'LQ';
  const dialer    = detectDialer(body);

  const map = {
    exotel:     { callId: body.CallSid||body.call_sid, recordingUrl: body.RecordingUrl||body.recording_url, agentNumber: body.To||body.CallTo, callerNumber: body.From||body.CallFrom, duration: parseInt(body.RecordingDuration||body.Duration||0) },
    ozonetel:   { callId: body.ucid||body.call_id, recordingUrl: body.recording_url||body.recordingUrl, agentNumber: body.agent_number||body.agent_id, callerNumber: body.caller_id||body.caller_number, duration: parseInt(body.duration||0) },
    knowlarity: { callId: body.call_id||body.id, recordingUrl: body.recording_url, agentNumber: body.agent_number||body.virtual_number, callerNumber: body.caller_number||body.customer_number, duration: parseInt(body.call_duration||body.duration||0) },
    servetel:   { callId: body.call_id, recordingUrl: body.recording_url, agentNumber: body.agent_number, callerNumber: body.caller_id||body.caller_number, duration: parseInt(body.duration||0) },
    generic:    { callId: body.call_id||body.callId||body.id||`call_${Date.now()}`, recordingUrl: body.recording_url||body.RecordingUrl||body.recordingUrl||body.audio_url||body.mp3_url, agentNumber: body.agent_number||body.agent||body.agentNumber||body.To, callerNumber: body.caller_number||body.caller||body.customer||body.From, duration: parseInt(body.duration||body.Duration||0) },
  };

  return { processId, dialerSource: dialer, ...map[dialer] };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  try {
    const db   = getDb();
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const payload = normalizePayload(body, req.query);

    if (!payload.recordingUrl) {
      await db.ref(`processes/${payload.processId}/webhook_errors`).push({
        rawPayload: body, detectedDialer: payload.dialerSource,
        error: 'No recording URL found', receivedAt: new Date().toISOString(),
      });
      return res.status(200).json({ ok: true, skipped: 'no recording URL — logged for debugging' });
    }

    const callRef = await db.ref(`processes/${payload.processId}/calls`).push({
      ...payload,
      agentName:     payload.agentNumber || null,
      agentId:       null,
      status:        'pending_transcription',
      transcript:    null,
      aiSuggestions: null,
      finalAuditId:  null,
      assignedTo:    null,
      language:      'hi-en',
      rawPayload:    body,
      createdAt:     new Date().toISOString(),
      transcribedAt: null,
      aiScoredAt:    null,
      reviewedAt:    null,
    });

    const apiBase = process.env.API_BASE_URL || `https://${process.env.VERCEL_URL}`;
    fetch(`${apiBase}/api/transcribe`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': process.env.INTERNAL_API_KEY },
      body:    JSON.stringify({ callKey: callRef.key, processId: payload.processId, recordingUrl: payload.recordingUrl, language: 'hi-en' }),
    }).catch(e => console.error('Transcription trigger failed:', e));

    return res.status(200).json({ success: true, callKey: callRef.key, dialer: payload.dialerSource, message: 'Received. AI pipeline started.' });

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: error.message });
  }
};
