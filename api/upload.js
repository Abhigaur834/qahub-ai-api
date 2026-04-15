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
    const { recordingUrl, agentName } = req.body;

    if (!recordingUrl) {
      return res.status(400).json({ error: 'Missing recordingUrl' });
    }

    const db = getDb();

    const callRef = await db.ref(`calls`).push({
      recordingUrl,
      agentName,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    return res.json({ success: true, callKey: callRef.key });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
