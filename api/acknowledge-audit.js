/**
 * QA.Hub — Audit Acknowledgment
 *
 * Called by ack.html when an agent clicks "I've read this audit" in their
 * email. Writes acknowledgedAt/acknowledgedIp onto that specific audit
 * record using firebase-admin — this is deliberately a backend endpoint
 * rather than a public Firebase write rule, so no new public write access
 * to your database is ever opened up.
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { processId, auditId } = req.body || {};
  if (!processId || !auditId) return res.status(400).json({ error: 'processId and auditId required' });

  try {
    const db = getDb();
    const auditRef = db.ref(`processes/${processId}/audits/${auditId}`);
    const snap = await auditRef.once('value');
    if (!snap.exists()) return res.status(404).json({ error: 'Audit not found' });

    // Don't overwrite an earlier acknowledgment timestamp if they click twice
    const existing = snap.val();
    if (existing.acknowledgedAt) {
      return res.status(200).json({ success: true, alreadyAcknowledged: true, acknowledgedAt: existing.acknowledgedAt });
    }

    const acknowledgedAt = new Date().toISOString();
    await auditRef.update({ acknowledgedAt });
    return res.status(200).json({ success: true, acknowledgedAt });
  } catch (error) {
    console.error('Acknowledge audit error:', error);
    return res.status(500).json({ error: error.message });
  }
};
