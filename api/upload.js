const admin = require('firebase-admin');

function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
  }
  return admin.database();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  // ★ FIX: browsers send an OPTIONS "preflight" request before the real POST
  // whenever the request has a JSON body (cross-origin). This endpoint was
  // rejecting that preflight with 405, which made the browser block every
  // real upload before it was ever sent — this is what "Failed to fetch" /
  // "Imported 0, N failed" actually was.
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ★ FIX: the dashboard sends all of these — previously only recordingUrl
    // and agentName were being read, and processId was silently dropped,
    // which meant calls weren't scoped to the right process at all.
    const {
      processId,
      recordingUrl,
      agentName,
      callerNumber,
      notes,
      uploadedBy,
      assignedTo,
      language,
    } = req.body;

    if (!recordingUrl) {
      return res.status(400).json({ error: 'Missing recordingUrl' });
    }
    if (!processId) {
      return res.status(400).json({ error: 'Missing processId' });
    }

    const db = getDb();

    // ★ FIX: store under processes/{processId}/calls — this is the exact
    // path the dashboard's AI Audit tab reads from (aiLoadQueue()). Calls
    // pushed to the old flat "calls/" root never showed up per-process.
    const callRef = await db.ref(`processes/${processId}/calls`).push({
      processId,
      recordingUrl,
      agentName: agentName || null,
      callerNumber: callerNumber || null,
      notes: notes || '',
      uploadedBy: uploadedBy || null,
      assignedTo: assignedTo || null,
      language: language || 'hi-en',
      // ★ FIX: use a status the dashboard's queue filters actually recognize
      // (the old "pending" value matched none of the Pending/Done filters).
      status: 'pending_transcription',
      createdAt: new Date().toISOString(),
    });

    // ★ FIX: this call was previously never made — the record sat at
    // "pending_transcription" forever because nothing told the transcription
    // pipeline it existed. webhook.js already did this correctly; upload.js
    // (used by both manual upload and Smartflo Sync) was missing it entirely.
    // ★ FIX #2: this MUST be awaited. Vercel can terminate a function's
    // execution the instant it sends its response — a "fire and forget"
    // fetch() left running in the background can get killed mid-flight
    // before the request is even delivered. Awaiting it guarantees the
    // trigger actually happens, at the cost of upload() taking a few
    // seconds longer to respond (acceptable — the dashboard already shows
    // "AI is scoring, check back in ~60s" after this call returns).
    const apiBase = process.env.API_BASE_URL || `https://${process.env.VERCEL_URL}`;
    try {
      await fetch(`${apiBase}/api/transcribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-key': process.env.INTERNAL_API_KEY,
        },
        body: JSON.stringify({
          callKey: callRef.key,
          processId,
          recordingUrl,
          language: language || 'hi-en',
        }),
      });
    } catch (e) {
      console.error('Transcribe trigger failed:', e);
    }

    return res.json({ success: true, callKey: callRef.key, processId });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
