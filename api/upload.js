const admin = require('firebase-admin');

// ★ AI transcription/scoring is turned OFF for now — calls just need to be
// available for human auditors to listen to and manually score in the
// Scorecard tab. Flip this back to true later if the AI pipeline is
// revisited; nothing else needs to change to re-enable it.
const AI_SCORING_ENABLED = false;

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
      // "ready_for_review" = just sits in the queue with its audio player,
      // waiting for a human to listen and audit manually. Only becomes
      // "pending_transcription" if AI_SCORING_ENABLED is turned back on.
      status: AI_SCORING_ENABLED ? 'pending_transcription' : 'ready_for_review',
      createdAt: new Date().toISOString(),
    });

    if (AI_SCORING_ENABLED) {
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
    }

    return res.json({ success: true, callKey: callRef.key, processId });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};

// ★ FIX: this function now awaits the full transcribe→score chain (see above),
// which can easily exceed Vercel's 10s default timeout. Raise it to the
// Hobby-plan maximum of 60s.
module.exports.config = { maxDuration: 60 };
