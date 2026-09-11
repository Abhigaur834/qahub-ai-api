/**
 * QA.Hub — Transcription via Deepgram
 * Converts call recording to speaker-separated transcript.
 * Accepts language parameter for multilingual Indian calls.
 */

const admin = require('firebase-admin');

function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
  }
  return admin.database();
}

const SUPPORTED_LANGUAGES = new Set([
  'hi-en', 'en', 'hi', 'ta', 'te', 'kn', 'mr', 'gu', 'bn', 'ml'
]);

async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, redirect: 'follow', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  // Internal-only endpoint
  if (req.headers['x-internal-key'] !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).end();

  const { callKey, processId, recordingUrl, language } = req.body || {};
  if (!callKey || !processId || !recordingUrl) {
    return res.status(400).json({ error: 'callKey, processId, recordingUrl required' });
  }

  const lang    = SUPPORTED_LANGUAGES.has(language) ? language : 'hi-en';
  const db      = getDb();
  const callRef = db.ref(`processes/${processId}/calls/${callKey}`);

  try {
    await callRef.update({ status: 'transcribing', error: null });

    // Smartflo recording URLs can be pre-authorized for a browser but rejected
    // when Deepgram tries to fetch them directly. Download the audio ourselves
    // first, then send the actual bytes to Deepgram. This also lets us surface
    // a clear error if the recording URL is expired/inaccessible.
    let audioRes;
    try {
      audioRes = await fetchWithTimeout(recordingUrl, {
        method: 'GET',
        headers: {
          'Accept': 'audio/*,application/octet-stream,*/*',
          'User-Agent': 'QA.Hub-AI/1.0',
        },
      }, 45000);
    } catch (e) {
      throw new Error(`Recording download failed: ${e.name === 'AbortError' ? 'timeout after 45s' : e.message}`);
    }

    if (!audioRes.ok) {
      throw new Error(`Recording download failed (${audioRes.status})`);
    }

    const audioType = (audioRes.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim();
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    if (!audioBuffer.length) {
      throw new Error('Recording download returned an empty audio file');
    }

    // Guard against Smartflo returning an HTML/login page instead of audio.
    if (audioType.includes('text/html')) {
      throw new Error('Smartflo recording URL returned HTML instead of audio; the recording link may be expired');
    }

    // ── Call Deepgram nova-2 with the downloaded audio bytes ────────────────
    const dgRes = await fetchWithTimeout(
      'https://api.deepgram.com/v1/listen?' + new URLSearchParams({
        model:        'nova-2',
        language:     lang,
        diarize:      'true',
        punctuate:    'true',
        utterances:   'true',
        smart_format: 'true',
        filler_words: 'false',
      }).toString(),
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
          'Content-Type': audioType.startsWith('audio/') ? audioType : 'audio/mpeg',
        },
        body: audioBuffer,
      },
      45000
    );

    if (!dgRes.ok) {
      throw new Error(`Deepgram ${dgRes.status}: ${await dgRes.text()}`);
    }

    const dgData     = await dgRes.json();
    const utterances = dgData.results?.utterances || [];

    if (!utterances.length) {
      throw new Error('Deepgram returned no utterances — recording may be silent or inaccessible');
    }

    const speakerMap = {};
    let   speakerIdx = 0;
    const LABELS     = ['Agent', 'Customer', 'Agent2', 'Supervisor'];

    const segments = utterances.map(u => {
      if (speakerMap[u.speaker] === undefined) {
        speakerMap[u.speaker] = LABELS[speakerIdx] || `Speaker${speakerIdx}`;
        speakerIdx++;
      }
      return {
        speaker:    speakerMap[u.speaker],
        text:       u.transcript?.trim() || '',
        start:      parseFloat((u.start || 0).toFixed(2)),
        end:        parseFloat((u.end   || 0).toFixed(2)),
        confidence: parseFloat((u.confidence || 0).toFixed(3)),
      };
    }).filter(s => s.text);

    const fullTranscript = segments.map(s => `[${s.speaker}] ${s.text}`).join('\n');
    const agentWords     = segments
      .filter(s => s.speaker === 'Agent')
      .reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
    const custWords      = segments
      .filter(s => s.speaker === 'Customer')
      .reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
    const totalDur       = segments.length ? segments[segments.length - 1].end : 0;

    await callRef.update({
      transcript: {
        full:     fullTranscript,
        segments,
        speakerMap,
        language: lang,
        stats: {
          totalSegments:   segments.length,
          agentWords,
          customerWords:   custWords,
          talkRatio:       agentWords + custWords > 0
            ? parseFloat((agentWords / (agentWords + custWords) * 100).toFixed(1))
            : 0,
          durationSeconds: totalDur,
        },
      },
      status:        'ai_scoring',
      transcribedAt: new Date().toISOString(),
    });

    // ── Trigger AI scoring ────────────────────────────────────────────────
    try {
      const apiBase = process.env.API_BASE_URL || `https://${process.env.VERCEL_URL}`;
      const scoreRes = await fetchWithTimeout(`${apiBase}/api/ai-score`, {
        method:  'POST',
        headers: {
          'Content-Type':   'application/json',
          'x-internal-key': process.env.INTERNAL_API_KEY,
        },
        body: JSON.stringify({ callKey, processId, transcript: fullTranscript, segments }),
      }, 45000);
      if (!scoreRes.ok) {
        throw new Error(`AI score returned ${scoreRes.status}: ${await scoreRes.text()}`);
      }
    } catch (e) {
      console.error('AI score trigger failed:', e);
      await callRef.update({ status: 'ai_scoring_failed', error: e.message }).catch(() => {});
      return res.status(502).json({ error: e.message });
    }

    return res.status(200).json({
      success:   true,
      segments:  segments.length,
      agentWords,
      custWords,
      language:  lang,
    });

  } catch (error) {
    console.error('Transcription error:', error);
    await callRef.update({
      status: 'transcription_failed',
      error:  error.message,
    }).catch(() => {});
    return res.status(500).json({ error: error.message });
  }
};

module.exports.config = { maxDuration: 60 };
