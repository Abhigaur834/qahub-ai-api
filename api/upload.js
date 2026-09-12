const admin = require('firebase-admin');

// AI transcription/scoring is enabled: imported/uploaded calls are sent
// through Deepgram transcription and then Gemini scoring automatically.
const AI_SCORING_ENABLED = true;

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

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
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

    // Idempotency guard: if this same recording was already submitted for
    // this process in the last 24h and isn't in a dead ERROR state, don't
    // create a duplicate entry (protects against double-click uploads and
    // overlapping Smartflo sync runs re-submitting the same call).
    const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
    const recentSnap = await db.ref(`processes/${processId}/calls`)
      .orderByChild('recordingUrl')
      .equalTo(recordingUrl)
      .once('value');
    if (recentSnap.exists()) {
      const existing = recentSnap.val();
      for (const [key, call] of Object.entries(existing)) {
        const age = Date.now() - new Date(call.createdAt || 0).getTime();
        const isDeadFailure = call.status === 'transcription_failed' || call.status === 'ai_scoring_failed';
        if (age < DUPLICATE_WINDOW_MS && !isDeadFailure) {
          return res.json({ success: true, callKey: key, processId, deduplicated: true });
        }
      }
    }

    const callRef = await db.ref(`processes/${processId}/calls`).push({
      processId,
      recordingUrl,
      agentName: agentName || null,
      callerNumber: callerNumber || null,
      notes: notes || '',
      uploadedBy: uploadedBy || null,
      assignedTo: assignedTo || null,
      language: language || 'hi-en',
      status: 'pending_transcription',
      createdAt: new Date().toISOString(),
    });

    if (AI_SCORING_ENABLED) {
      // Always call the known production API directly. This avoids a stale or
      // incorrect API_BASE_URL / deployment URL leaving calls stranded at
      // pending_transcription without ever reaching /api/transcribe.
      const apiBase = 'https://qahub-ai-api-glz7.vercel.app';
      try {
        const trRes = await fetch(`${apiBase}/api/transcribe`, {
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
        if (!trRes.ok) {
          const text = await trRes.text();
          console.error('Transcribe trigger returned non-2xx:', trRes.status, text);
          await callRef.update({
            status: 'transcription_failed',
            error: `Transcribe trigger failed (${trRes.status})`,
          }).catch(() => {});
        }
      } catch (e) {
        console.error('Transcribe trigger failed:', e);
        await callRef.update({ status: 'transcription_failed', error: e.message }).catch(() => {});
      }
    }

    return res.json({ success: true, callKey: callRef.key, processId });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = { maxDuration: 60 };
