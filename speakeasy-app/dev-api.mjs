/**
 * 本地开发 API 服务器
 * npm run dev:api  启动，Vite proxy 指向 http://localhost:3001/api
 */

import http from 'http';
import https from 'https';

const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY || '';

// ─── 工具函数 ───
function httpsRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...opts, timeout: 25000, ALPNProtocols: ['http/1.1'] }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() });
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
    if (body) req.write(body);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000, ALPNProtocols: ['http/1.1'] }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    }).on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function uploadToLitterbox(audioBuffer, filename) {
  const boundary = '----LB' + Date.now() + Math.random().toString(36).slice(2);
  const CR = '\r\n';
  const parts = [
    Buffer.from('--' + boundary + CR + 'Content-Disposition: form-data; name="reqtype"' + CR + CR + 'fileupload' + CR),
    Buffer.from('--' + boundary + CR + 'Content-Disposition: form-data; name="time"' + CR + CR + '1h' + CR),
    Buffer.from('--' + boundary + CR + 'Content-Disposition: form-data; name="fileToUpload"; filename="' + filename + '"' + CR + 'Content-Type: audio/webm' + CR + CR),
    audioBuffer,
    Buffer.from(CR + '--' + boundary + '--' + CR),
  ];
  const body = Buffer.concat(parts);
  const result = await httpsRequest(
    { hostname: 'litterbox.catbox.moe', path: '/resources/internals/api.php', method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': String(body.length), 'User-Agent': 'SpeakEasy/1.0' } },
    body
  );
  if (result.status !== 200) throw new Error('Litterbox HTTP ' + result.status);
  const url = result.body.trim();
  if (!url.startsWith('https://')) throw new Error('Invalid litterbox URL: ' + url);
  return url;
}

async function createDashScopeTask(fileUrl) {
  const result = await httpsRequest(
    { hostname: 'dashscope.aliyuncs.com', path: '/api/v1/services/audio/asr/transcription', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + DASHSCOPE_KEY, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' } },
    JSON.stringify({ model: 'paraformer-v2', input: { file_urls: [fileUrl] } })
  );
  if (result.status !== 200) throw new Error('DashScope create HTTP ' + result.status + ': ' + result.body.substring(0, 200));
  const data = JSON.parse(result.body);
  const taskId = data?.output?.task_id;
  if (!taskId) throw new Error('No task_id: ' + result.body.substring(0, 200));
  return taskId;
}

async function pollTask(taskId) {
  const result = await httpsRequest(
    { hostname: 'dashscope.aliyuncs.com', path: '/api/v1/tasks/' + taskId, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + DASHSCOPE_KEY } }
  );
  if (result.status !== 200) throw new Error('Poll HTTP ' + result.status);
  return JSON.parse(result.body);
}

async function fetchTranscription(data) {
  const url = data?.output?.results?.transcription_url;
  if (!url) return null;
  try {
    const json = await httpGet(url);
    const parsed = JSON.parse(json);
    return (parsed?.transcripts || []).map((t) => t.text || '').join(' ').trim();
  } catch { return null; }
}

async function analyzeWithQwen(text) {
  const prompt = [
    'You are an English speaking coach. Analyze this transcription from a learner:',
    '"' + text + '"',
    'Reply in STRICT JSON (no markdown):',
    '{ "accuracy": <0-100>, "fluency": <0-100>, "completeness": <0-100>, "total": <0-100>, "errors": ["..."], "suggestions": ["..."] }',
    'Output ONLY the JSON object.'
  ].join('\n');

  const result = await httpsRequest(
    { hostname: 'dashscope.aliyuncs.com', path: '/api/v1/services/aigc/text-generation/generation', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + DASHSCOPE_KEY, 'Content-Type': 'application/json' } },
    JSON.stringify({ model: 'qwen-turbo', input: { messages: [{ role: 'user', content: prompt }] }, parameters: { result_format: 'message', temperature: 0.3, max_tokens: 800 } })
  );
  if (result.status !== 200) return null;
  const data = JSON.parse(result.body);
  const content = data?.output?.choices?.[0]?.message?.content || '';
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function fallbackScore(text) {
  if (!text || !text.trim()) return { accuracy: 0, fluency: 0, completeness: 0, total: 0, errors: ['No valid speech detected'], suggestions: ['Try speaking clearly', 'Ensure quiet environment'] };
  const words = text.trim().split(/\s+/).length;
  const c = Math.min(100, Math.round(words * 7));
  const f = Math.min(100, Math.round(Math.min(words, 30) * 2.5 + Math.min(words / Math.max(1, text.split(/[.!?]+/).filter(Boolean).length), 12) * 3));
  const a = Math.min(100, Math.round(f * 0.85));
  return { accuracy: a, fluency: f, completeness: c, total: Math.round((a + f + c) / 3), errors: words < 5 ? ['Response too short'] : [], suggestions: words < 8 ? ['Expand your answers', 'Use complete sentences'] : ['Good job! Keep practicing.'] };
}

// ─── 路由 ───
async function handleTranscribe(req, res) {
  if (!DASHSCOPE_KEY) { res.writeHead(500); res.end(JSON.stringify({ error: 'DASHSCOPE_API_KEY not set' })); return; }
  try {
    const audioBuffer = await readBody(req);
    if (audioBuffer.length < 1024) { res.writeHead(400); res.end(JSON.stringify({ error: 'Audio too small' })); return; }
    const fileUrl = await uploadToLitterbox(audioBuffer, 'recording-' + Date.now() + '.webm');
    console.log('[dev-api] Litterbox: ' + fileUrl);
    const taskId = await createDashScopeTask(fileUrl);
    console.log('[dev-api] Task: ' + taskId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ task_id: taskId, message: 'Poll /api/transcribe-status?task_id=' + taskId }));
  } catch (e) {
    console.error('[dev-api] Error:', e.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function handleStatus(url, res) {
  const taskId = new URL(url, 'http://localhost').searchParams.get('task_id');
  if (!taskId) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing task_id' })); return; }
  try {
    const taskData = await pollTask(taskId);
    const taskStatus = taskData?.output?.task_status;
    if (taskStatus === 'PENDING' || taskStatus === 'RUNNING') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'processing', task_status: taskStatus }));
      return;
    }
    if (taskStatus === 'FAILED') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'failed', message: taskData?.output?.message || 'Failed' }));
      return;
    }
    if (taskStatus === 'SUCCEEDED' || taskStatus === 'SUCCESS_WITH_NO_VALID_FRAGMENT') {
      const transcription = await fetchTranscription(taskData);
      const hasSpeech = taskStatus === 'SUCCEEDED' && transcription && transcription.length > 0;
      let scores = hasSpeech ? await analyzeWithQwen(transcription) : null;
      if (!scores) scores = fallbackScore(transcription || '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'completed', transcription: transcription || '', hasSpeech, ...scores }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'unknown', task_status: taskStatus }));
  } catch (e) {
    console.error('[dev-api] Status error:', e.message);
    res.writeHead(500);
    res.end(JSON.stringify({ status: 'error', error: e.message }));
  }
}

// ─── 启动 ───
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const path = req.url.split('?')[0];
  if (req.method === 'POST' && path === '/api/transcribe') return handleTranscribe(req, res);
  if (req.method === 'GET' && path === '/api/transcribe-status') return handleStatus(req.url, res);

  res.writeHead(404); res.end('Not Found');
});

const PORT = process.env.API_PORT || 3001;
server.listen(PORT, () => console.log(`[dev-api] Listening on http://localhost:${PORT}`));
