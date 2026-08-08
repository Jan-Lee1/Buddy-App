// api/transcribe.js — Vercel Serverless: 阶段一（上传音频→uguu.se→提交 DashScope 任务）
// 入口: POST /api/transcribe (Content-Type: multipart/form-data)
// 返回: { status: "processing", taskId: "xxx" } 或 { error: { message: "..." } }

const https = require('https');

// ── Multipart 文件解析（Buffer 逐字节搜索） ──
function parseMultipartFile(bodyBuffer, boundary) {
  const boundaryBuffer = Buffer.from('--' + boundary);
  const doubleCrlf = Buffer.from('\r\n\r\n');

  let pos = 0;
  while (pos < bodyBuffer.length) {
    const boundIdx = bodyBuffer.indexOf(boundaryBuffer, pos);
    if (boundIdx === -1) break;
    pos = boundIdx + boundaryBuffer.length;

    const headerEnd = bodyBuffer.indexOf(doubleCrlf, pos);
    if (headerEnd === -1) break;

    const headersStr = bodyBuffer.slice(pos, headerEnd).toString('utf-8');
    pos = headerEnd + 4;

    let contentEnd = bodyBuffer.indexOf(boundaryBuffer, pos);
    if (contentEnd === -1) contentEnd = bodyBuffer.length;

    let contentLen = contentEnd - pos;
    if (contentLen >= 2 && bodyBuffer[contentEnd - 2] === 0x0d && bodyBuffer[contentEnd - 1] === 0x0a) {
      contentLen -= 2;
    }

    if (headersStr.includes('filename=')) {
      const match = headersStr.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : 'audio.webm';
      const fileBuffer = bodyBuffer.slice(pos, pos + contentLen);
      console.log('[Transcribe] 收到:', filename, (fileBuffer.length / 1024).toFixed(1) + 'KB');
      return { buffer: fileBuffer, filename };
    }

    pos = contentEnd;
  }
  return null;
}

// ── MIME 类型 ──
function getMimeType(filename) {
  const f = filename.toLowerCase();
  if (f.endsWith('.mp4') || f.endsWith('.m4a')) return 'audio/mp4';
  if (f.endsWith('.aac')) return 'audio/aac';
  if (f.endsWith('.ogg')) return 'audio/ogg';
  if (f.endsWith('.wav')) return 'audio/wav';
  if (f.endsWith('.mp3')) return 'audio/mpeg';
  return 'audio/webm';
}

// ── 上传到 litterbox.catbox.moe 免费临时文件服务 ──
function uploadToLitterbox(audioBuffer, filename, mimeType) {
  return new Promise((resolve, reject) => {
    const boundary = '----LB' + Date.now() + Math.random().toString(36).slice(2);
    const CR = '\r\n';
    const formBody = Buffer.concat([
      Buffer.from('--' + boundary + CR + 'Content-Disposition: form-data; name="reqtype"' + CR + CR + 'fileupload' + CR),
      Buffer.from('--' + boundary + CR + 'Content-Disposition: form-data; name="time"' + CR + CR + '1h' + CR),
      Buffer.from('--' + boundary + CR + 'Content-Disposition: form-data; name="fileToUpload"; filename="' + filename + '"' + CR + 'Content-Type: ' + mimeType + CR + CR),
      audioBuffer,
      Buffer.from(CR + '--' + boundary + '--' + CR),
    ]);

    const req = https.request({
      hostname: 'litterbox.catbox.moe',
      path: '/resources/internals/api.php',
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': String(formBody.length),
        'User-Agent': 'PersonalManager/1.0',
      },
      family: 4,
      timeout: 25000,
    }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => {
        const url = d.trim();
        if (url.startsWith('https://')) {
          resolve(url);
        } else {
          reject(new Error('litterbox 上传失败: ' + d.substring(0, 200)));
        }
      });
    });
    req.on('error', (e) => reject(new Error('litterbox 网络错误: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('litterbox 超时')); });
    req.write(formBody); req.end();
  });
}

// ── 提交 DashScope 异步转写任务 ──
function submitTranscriptionTask(fileUrl, apiKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'paraformer-v2',
      input: { file_urls: [fileUrl] }
    });

    const req = https.request({
      hostname: 'dashscope.aliyuncs.com',
      path: '/api/v1/services/audio/asr/transcription',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload)),
        'X-DashScope-Async': 'enable',
      },
      family: 4,
      timeout: 25000,
    }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          if (json.output && json.output.task_id) {
            resolve(json.output.task_id);
          } else if (json.code) {
            reject(new Error('DashScope: ' + json.code + ' - ' + (json.message || '')));
          } else {
            reject(new Error('DashScope 未返回 task_id'));
          }
        } catch (e) {
          reject(new Error('DashScope 响应异常'));
        }
      });
    });
    req.on('error', (e) => reject(new Error('DashScope 网络错误: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('DashScope 超时')); });
    req.write(payload); req.end();
  });
}

// ── Vercel handler ──
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  const apiKey = process.env.DASHSCOPE_API_KEY || process.env.DASHSCOPE_KEY || '';
  if (!apiKey) {
    return res.status(500).json({ error: { message: '服务端未配置 DASHSCOPE_API_KEY' } });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(-+[^\s;]+)/);
  if (!boundaryMatch) {
    return res.status(400).json({ error: { message: '缺少 multipart boundary' } });
  }

  try {
    const chunks = [];
    for await (const chunk of req) { chunks.push(chunk); }
    const bodyBuffer = Buffer.concat(chunks);

    const parsed = parseMultipartFile(bodyBuffer, boundaryMatch[1]);
    if (!parsed || !parsed.buffer || parsed.buffer.length < 100) {
      return res.status(400).json({ error: { message: '未收到有效音频文件' } });
    }

    const mime = getMimeType(parsed.filename);

    const publicUrl = await uploadToLitterbox(parsed.buffer, parsed.filename, mime);
    const taskId = await submitTranscriptionTask(publicUrl, apiKey);

    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ status: 'processing', taskId });
  } catch (err) {
    console.error('[Transcribe] 失败:', err.message);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(500).json({ error: { message: err.message } });
  }
};
