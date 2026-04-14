import admin from 'firebase-admin';

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

function normalizePayload(body, query) {
  const processId = query.orgId || query.processId || body.orgId || 'LQ';

  if (body.CallSid || body.CallTo) {
    return {
      processId,
      dialerSource: 'exotel',
      callId: body.CallSid,
      agentNumber: body.To || body.CallTo,
      callerNumber: body.From || body.CallFrom,
      recordingUrl: body.RecordingUrl,
      duration: parseInt(body.RecordingDuration || 0),
      status: body.Status,
    };
  }

  if (body.ucid || body.campaign_id) {
    return {
      processId,
      dialerSource: 'ozonetel',
      callId: body.ucid,
      agentNumber: body.agent_number,
      callerNumber: body.customer_number,
      recordingUrl: body.recording_url,
      duration: parseInt(body.duration || 0),
      status: body.call_status,
    };
  }

  return {
    processId,
    dialerSource: 'generic',
    callId: body.callId || body.call_id || body.id,
    agentNumber: body.agent || body.agentNumber,
    callerNumber: body.caller || body.callerNumber || body.customer,
    recordingUrl: body.recordingUrl || body.recording_url || body.recording,
    duration: parseInt(body.duration || 0),
    status: body.status || 'completed',
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const payload = normalizePayload(body, req.query);

    if (!payload.recordingUrl) {
      return res.status(200).json({ ok: true, skipped: 'no recording URL' });
    }

    const db = getDb();

    const callRef = await db.ref(`processes/${payload.processId}/calls`).push({
      ...payload,
      agentName: payload.agentNumber || null,
      status: 'pending_transcription',
      transcript: null,
      aiSuggestions: null,
      finalAuditId: null,
      assignedTo: null,
      language: 'hi-en',
      createdAt: new Date().toISOString(),
    });

    const apiBase = process.env.API_BASE_URL || `https://${process.env.VERCEL_URL}`;

    fetch(`${apiBase}/api/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': process.env.INTERNAL_API_KEY,
      },
      body: JSON.stringify({
        callKey: callRef.key,
        processId: payload.processId,
        recordingUrl: payload.recordingUrl,
        language: 'hi-en',
      }),
    }).catch(console.error);

    return res.status(200).json({ ok: true, callKey: callRef.key });

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: error.message });
  }
}
