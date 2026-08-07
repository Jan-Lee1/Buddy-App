/**
 * POST /api/transcribe
 * 接收音频文件 → 上传 litterbox.catbox.moe → 创建 DashScope ASR 异步任务
 * 返回 { task_id }，前端用 /api/transcribe-status 轮询
 */

import https from 'https';

const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY || '';

// 简易 HTTPS 请求封装
function httpsRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...opts, timeout: 25000 }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf.toString(), raw: buf });
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 上传音频到 litterbox.catbox.moe，获取公网直链
 */
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
    {
      hostname: 'litterbox.catbox.moe',
      path: '/resources/internals/api.php',
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': String(body.length),
        'User-Agent': 'SpeakEasy/1.0',
      },
    },
    body
  );

  if (result.status !== 200) {
    throw new Error('Litterbox upload failed: HTTP ' + result.status + ' - ' + result.body.substring(0, 200));
  }

  const url = result.body.trim();
  if (!url.startsWith('https://')) {
    throw new Error('Litterbox returned invalid URL: ' + url);
  }

  return url;
}

/**
 * 创建 DashScope Paraformer-v2 异步 ASR 任务
 */
async function createDashScopeTask(fileUrl) {
  const result = await httpsRequest(
    {
      hostname: 'dashscope.aliyuncs.com',
      path: '/api/v1/services/audio/asr/transcription',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + DASHSCOPE_KEY,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
      },
    },
    JSON.stringify({
      model: 'paraformer-v2',
      input: { file_urls: [fileUrl] },
    })
  );

  if (result.status !== 200) {
    throw new Error('DashScope task creation failed: HTTP ' + result.status + ' - ' + result.body.substring(0, 500));
  }

  const data = JSON.parse(result.body);
  const taskId = data?.output?.task_id;
  if (!taskId) {
    throw new Error('No task_id in DashScope response: ' + result.body.substring(0, 500));
  }

  return taskId;
}

// ─── Vercel Serverless Handler ───
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  if (!DASHSCOPE_KEY) {
    return res.status(500).json({ error: 'DASHSCOPE_API_KEY not configured on server.' });
  }

  try {
    // 读取请求体（raw binary 音频数据）
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const audioBuffer = Buffer.concat(chunks);

    if (audioBuffer.length < 1024) {
      return res.status(400).json({ error: 'Audio file too small (< 1KB). Please record speech.' });
    }

    const filename = 'recording-' + Date.now() + '.webm';
    const contentType = req.headers['content-type'] || 'audio/webm';

    console.log(`[transcribe] Received ${audioBuffer.length}B, type: ${contentType}`);

    // Step 1: Upload to litterbox.catbox.moe
    const fileUrl = await uploadToLitterbox(audioBuffer, filename);
    console.log(`[transcribe] Litterbox URL: ${fileUrl}`);

    // Step 2: Create DashScope async ASR task
    const taskId = await createDashScopeTask(fileUrl);
    console.log(`[transcribe] DashScope task_id: ${taskId}`);

    return res.status(200).json({
      task_id: taskId,
      message: 'ASR task created. Poll /api/transcribe-status?task_id=' + taskId,
    });
  } catch (err) {
    console.error('[transcribe] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
