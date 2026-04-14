/**
 * QA.Hub — Manual Call Upload
 * Called by the "+ Upload" button in the AI Audit tab.
 * Saves assignedTo + language so auditor-wise visibility works.
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).end();

  try {
    const db   = getDb();
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    const {
      processId,
      agentName,
      callerNumber,
      recordingUrl,
      duration,
      notes,
      uploadedBy,
      assignedTo,   // auditor email — null means admin-visible only
      language,     // Deepgram language code e.g. 'hi-en', 'en', 'ta'
    } = body;

    if (!processId || !recordingUrl) {
      return res.status(400).json({ error: 'processId and recordingUrl are required' });
    }

    const callRef = await db.ref(`processes/${processId}/calls`).push({
      dialerSource:  'manual_upload',
      recordingUrl,
      agentId:       null,
      agentName:     agentName    || null,
      callerNumber:  callerNumber || null,
      duration:      parseInt(duration || 0),
      notes:         notes        || '',
      uploadedBy:    uploadedBy   || null,
      assignedTo:    assignedTo   || null,    // saved so dashboard can filter by auditor
      language:      language     || 'hi-en', // saved so transcribe.js uses correct language
      processId,
      status:        'pending_transcription',
      transcript:    null,
      aiSuggestions: null,
      finalAuditId:  null,
      createdAt:     new Date().toISOString(),
      transcribedAt: null,
      aiScoredAt:    null,
      reviewedAt:    null,
    });

    // Kick off transcription pipeline
    const apiBase = process.env.API_BASE_URL || `https://${process.env.VERCEL_URL}`;
    fetch(`${apiBase}/api/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'x-internal-key': process.env.INTERNAL_API_KEY,
      },
      body: JSON.stringify({
        callKey:      callRef.key,
        processId,
        recordingUrl,
        language:     language || 'hi-en',
      }),
    }).catch(console.error);

    return res.status(200).json({
      success:    true,
      callKey:    callRef.key,
      assignedTo: assignedTo || null,
      language:   language   || 'hi-en',
    });

  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({ error: error.message });
  }
};
