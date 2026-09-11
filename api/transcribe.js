const admin = require('firebase-admin');

function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, redirect: 'follow', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function downloadRecording(recordingUrl) {
  try {
    const audioRes = await fetchWithTimeout(recordingUrl, {
      method: 'GET',
      headers: {
        'Accept': 'audio/*,application/octet-stream,*/*',
        'User-Agent': 'QA.Hub-AI/1.0',
      },
    }, 30000);

    if (!audioRes.ok) {
      throw new Error(`recording download HTTP ${audioRes.status}`);
    }

    const contentType = (audioRes.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    if (!audioBuffer.length) throw new Error('recording download returned an empty file');

    const preview = audioBuffer.subarray(0, 64).toString('utf8').trim().toLowerCase();
    if (contentType.includes('text/html') || preview.startsWith('<!doctype') || preview.startsWith('<html')) {
      throw new Error('recording URL returned HTML instead of audio');
    }

    // Prefer Smartflo's declared MIME type, otherwise infer common formats from
    // the URL path. Deepgram accepts containerized audio when the content type
    // correctly describes the submitted bytes.
    let mime = contentType;
    if (!mime || mime === 'application/octet-stream') {
      const path = new URL(recordingUrl).pathname.toLowerCase();
      if (path.endsWith('.wav')) mime = 'audio/wav';
      else if (path.endsWith('.ogg')) mime = 'audio/ogg';
      else if (path.endsWith('.webm')) mime = 'audio/webm';
      else if (path.endsWith('.mp3')) mime = 'audio/mpeg';
      else if (path.endsWith('.m4a')) mime = 'audio/mp4';
      else mime = 'application/octet-stream';
    }

    return { audioBuffer, mime };
  } catch (error) {
    throw new Error(`Smartflo recording download failed: ${error.name === 'AbortError' ? 'timeout after 30s' : error.message}`);
  }
}

async function transcribeWithDeepgram({ audioBuffer, mime, recordingUrl, lang }) {
  const options = new URLSearchParams({
    model: 'nova-3',
    language: lang,
    diarize: 'true',
    punctuate: 'true',
    utterances: 'true',
    smart_format: 'true',
    filler_words: 'false',
  });

  // First attempt: submit the actual audio bytes. This avoids authentication
  // differences between a browser and Deepgram accessing Smartflo's URL.
  const binaryRes = await fetchWithTimeout(
    `https://api.deepgram.com/v1/listen?${options.toString()}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        'Content-Type': mime,
      },
      body: audioBuffer,
    },
    45000
  );

  if (binaryRes.ok) return binaryRes.json();

  const binaryError = `${binaryRes.status}: ${(await binaryRes.text()).slice(0, 300)}`;

  // Second attempt: let Deepgram fetch the pre-authorized Smartflo URL itself.
  // Some Smartflo recording links are accessible to Deepgram even when the
  // Vercel runtime receives an unexpected content type from the URL.
  const remoteRes = await fetchWithTimeout(
    `https://api.deepgram.com/v1/listen?${options.toString()}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: recordingUrl }),
    },
    45000
  );

  if (remoteRes.ok) return remoteRes.json();

  const remoteError = `${remoteRes.status}: ${(await remoteRes.text()).slice(0, 300)}`;
  throw new Error(`Deepgram rejected recording. Binary=${binaryError}; Remote=${remoteError}`);
}

module.exports = async (req, res) => {
  if (req.headers['x-internal-key'] !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).end();

  const { callKey, processId, recordingUrl, language } = req.body || {};
  if (!callKey || !processId || !recordingUrl) {
    return res.status(400).json({ error: 'callKey, processId, recordingUrl required' });
  }

  const lang = SUPPORTED_LANGUAGES.has(language) ? language : 'hi-en';
  const db = getDb();
  const callRef = db.ref(`processes/${processId}/calls/${callKey}`);

  try {
    await callRef.update({ status: 'transcribing', error: null });

    const { audioBuffer, mime } = await downloadRecording(recordingUrl);
    const dgData = await transcribeWithDeepgram({ audioBuffer, mime, recordingUrl, lang });
    const utterances = dgData.results?.utterances || [];

    if (!utterances.length) {
      throw new Error('Deepgram returned no utterances — recording may be silent, empty, or unsupported');
    }

    const speakerMap = {};
    let speakerIdx = 0;
    const LABELS = ['Agent', 'Customer', 'Agent2', 'Supervisor'];

    const segments = utterances.map(u => {
      if (speakerMap[u.speaker] === undefined) {
        speakerMap[u.speaker] = LABELS[speakerIdx] || `Speaker${speakerIdx}`;
        speakerIdx++;
      }
      return {
        speaker: speakerMap[u.speaker],
        text: u.transcript?.trim() || '',
        start: parseFloat((u.start || 0).toFixed(2)),
        end: parseFloat((u.end || 0).toFixed(2)),
        confidence: parseFloat((u.confidence || 0).toFixed(3)),
      };
    }).filter(s => s.text);

    const fullTranscript = segments.map(s => `[${s.speaker}] ${s.text}`).join('\n');
    const agentWords = segments.filter(s => s.speaker === 'Agent')
      .reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
    const custWords = segments.filter(s => s.speaker === 'Customer')
      .reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
    const totalDur = segments.length ? segments[segments.length - 1].end : 0;

    await callRef.update({
      transcript: {
        full: fullTranscript,
        segments,
        speakerMap,
        language: lang,
        stats: {
          totalSegments: segments.length,
          agentWords,
          customerWords: custWords,
          talkRatio: agentWords + custWords > 0
            ? parseFloat((agentWords / (agentWords + custWords) * 100).toFixed(1))
            : 0,
          durationSeconds: totalDur,
        },
      },
      status: 'ai_scoring',
      transcribedAt: new Date().toISOString(),
    });

    const apiBase = process.env.API_BASE_URL || `https://${process.env.VERCEL_URL}`;
    const scoreRes = await fetchWithTimeout(`${apiBase}/api/ai-score`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': process.env.INTERNAL_API_KEY,
      },
      body: JSON.stringify({ callKey, processId, transcript: fullTranscript, segments }),
    }, 45000);

    if (!scoreRes.ok) {
      const text = await scoreRes.text();
      throw new Error(`AI scoring failed (${scoreRes.status}): ${text.slice(0, 500)}`);
    }

    return res.status(200).json({
      success: true,
      segments: segments.length,
      agentWords,
      custWords,
      language: lang,
    });

  } catch (error) {
    console.error('Transcription error:', error);
    await callRef.update({
      status: 'transcription_failed',
      error: error.message,
    }).catch(() => {});
    return res.status(500).json({ error: error.message });
  }
};

module.exports.config = { maxDuration: 60 };
