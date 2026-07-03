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

    return res.json({ success: true, callKey: callRef.key, processId });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
