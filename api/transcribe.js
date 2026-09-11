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

async function getSmartfloToken() {
  const email = process.env.SMARTFLO_EMAIL;
  const password = process.env.SMARTFLO_PASSWORD;
  if (!email || !password) return null;

  const res = await fetchWithTimeout('https://api-smartflo.tatateleservices.com/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ email, password }),
  }, 10000);

  if (!res.ok) throw new Error(`Smartflo authentication failed (${res.status})`);
  const data = await res.json();
  if (!data.access_token) throw new Error('Smartflo authentication returned no access token');
  return data.access_token;
}

async function downloadRecording(recordingUrl) {
  let token = null;
  try {
    token = await getSmartfloToken();
  } catch (e) {
    console.warn('Smartflo auth for recording unavailable:', e.message);
  }

  // Smartflo CDR recording_url is normally a signed URL. Some accounts with
  // protected recordings also require the authenticated bearer token.
  const headerVariants = [
    token ? {
      Authorization: `Bearer ${token}`,
      Accept: 'audio/*,application/octet-stream,*/*',
      'User-Agent': 'QA.Hub-AI/1.0',
    } : null,
    {
      Accept: 'audio/*,application/octet-stream,*/*',
      'User-Agent': 'QA.Hub-AI/1.0',
    },
  ].filter(Boolean);

  let lastError = 'unknown recording download error';

  for (let attempt = 0; attempt < headerVariants.length; attempt++) {
    try {
      const audioRes = await fetchWithTimeout(recordingUrl, {
        method: 'GET',
        headers: headerVariants[attempt],
      }, 12000);

      if (!audioRes.ok) {
        lastError = `HTTP ${audioRes.status}`;
      } else {
        const contentType = (audioRes.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

        if (!audioBuffer.length) {
          lastError = 'empty response body';
        } else {
          const preview = audioBuffer.subarray(0, 64).toString('utf8').trim().toLowerCase();
          if (contentType.includes('text/html') || preview.startsWith('<!doctype') || preview.startsWith('<html')) {
            lastError = 'Smartflo returned HTML/login content instead of audio';
          } else {
            let mime = contentType;
            if (!mime || mime === 'application/octet-stream') {
              const path = new URL(recordingUrl).pathname.toLowerCase();
              if (path.endsWith('.wav')) mime = 'audio/wav';
              else if (path.endsWith('.ogg')) mime = 'audio/ogg';
              else if (path.endsWith('.webm')) mime = 'audio/webm';
              else if (path.endsWith('.mp3')) mime = 'audio/mpeg';
              else if (path.endsWith('.m4a')) mime = 'audio/mp4';
              else mime = 'audio/mpeg';
            }
            return { audioBuffer, mime };
          }
        }
      }
    } catch (e) {
      lastError = e.name === 'AbortError' ? 'request timeout' : e.message;
    }

    if (attempt < headerVariants.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  throw new Error(`Smartflo recording download failed: ${lastError}`);
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
    30000
  );

  if (binaryRes.ok) return binaryRes.json();

  const binaryError = `${binaryRes.status}: ${(await binaryRes.text()).slice(0, 300)}`;

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
    20000
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
    }, 15000);

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
