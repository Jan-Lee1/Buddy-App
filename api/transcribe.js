/**
 * Vercel Serverless: 语音转写
 * POST /api/transcribe — multipart/form-data 上传音频
 * 使用 DashScope OpenAI 兼容端点：/compatible-mode/v1/audio/transcriptions
 * 无需区分同步/异步，直接返回转写文本
 */

const https = require('https');

const DASHSCOPE_HOST = 'dashscope.aliyuncs.com';
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';

/* ── 提取 boundary ── */
function extractBoundary(contentType) {
  if (!contentType) return null;
  const m = contentType.match(/boundary="?([^";\s]+)"?/);
  return m ? m[1] : null;
}

/* ── 从 multipart body 中提取文件 ── */
function parseMultipartFile(bodyBuffer, boundary) {
  const mark = Buffer.from('--' + boundary);
  const parts = [];
  let start = 0;

  while (true) {
    const idx = bodyBuffer.indexOf(mark, start);
    if (idx === -1) break;
    start = idx + mark.length;

    // Find next boundary
    const nextIdx = bodyBuffer.indexOf(mark, start);
    if (nextIdx === -1) break;

    let part = bodyBuffer.slice(start, nextIdx);
    // Trim leading \r\n
    if (part[0] === 0x0D && part[1] === 0x0A) part = part.slice(2);
    if (part[part.length - 2] === 0x0D && part[part.length - 1] === 0x0A) part = part.slice(0, part.length - 2);
    parts.push(part);
    start = nextIdx;
  }

  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headersStr = part.slice(0, headerEnd).toString('utf8');
    let content = part.slice(headerEnd + 4);
    // Strip trailing \r\n
    if (content[content.length - 2] === 0x0D && content[content.length - 1] === 0x0A) {
      content = content.slice(0, content.length - 2);
    }

    if (headersStr.toLowerCase().includes('filename')) {
      const fn1 = headersStr.match(/filename="([^"]*)"/);
      const fn2 = headersStr.match(/filename=([^\s;\r\n]+)/);
      const filename = fn1 ? fn1[1] : (fn2 ? fn2[1] : 'audio.webm');
      return { buffer: content, filename };
    }
  }
  return null;
}

/* ── MIME 类型 ── */
function getMimeType(filename) {
  const f = filename.toLowerCase();
  if (f.endsWith('.mp4') || f.endsWith('.m4a')) return 'audio/mp4';
  if (f.endsWith('.aac')) return 'audio/aac';
  if (f.endsWith('.ogg')) return 'audio/ogg';
  if (f.endsWith('.wav')) return 'audio/wav';
  if (f.endsWith('.mp3')) return 'audio/mpeg';
  return 'audio/webm';
}

/* ── OpenAI 兼容端点转写 (multipart/form-data) ── */
function transcribeWithOpenAIEndpoint(fileBuffer, filename) {
  return new Promise((resolve, reject) => {
    const mimeType = getMimeType(filename);
    const boundary = '----DashScopeBoundary' + Date.now();
    const crlf = '\r\n';

    // Build multipart body
    const parts = [];
    parts.push(Buffer.from('--' + boundary + crlf));
    parts.push(Buffer.from('Content-Disposition: form-data; name="model"' + crlf + crlf));
    parts.push(Buffer.from('paraformer-v1' + crlf));
    parts.push(Buffer.from('--' + boundary + crlf));
    parts.push(Buffer.from('Content-Disposition: form-data; name="file"; filename="' + filename + '"' + crlf));
    parts.push(Buffer.from('Content-Type: ' + mimeType + crlf + crlf));
    parts.push(fileBuffer);
    parts.push(Buffer.from(crlf + '--' + boundary + '--' + crlf));

    const body = Buffer.concat(parts);

    const req = https.request({
      hostname: DASHSCOPE_HOST,
      port: 443,
      path: '/compatible-mode/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + DASHSCOPE_API_KEY,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': String(body.length),
      },
      timeout: 60000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.text && typeof json.text === 'string') {
            resolve(json.text.trim());
          } else if (json.error) {
            reject(new Error('转写失败: ' + (json.error.message || JSON.stringify(json.error))));
          } else {
            reject(new Error('转写返回异常: ' + data.substring(0, 200)));
          }
        } catch (e) {
          reject(new Error('解析转写响应失败: ' + data.substring(0, 200)));
        }
      });
    });

    req.on('error', (e) => reject(new Error('转写请求失败: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('转写请求超时')); });
    req.write(body);
    req.end();
  });
}

/* ── 安全发送 JSON ── */
function safeJson(res, status, payload) {
  if (res.headersSent) {
    console.warn('[Transcribe Vercel] 响应已发送，跳过');
    return;
  }
  res.status(status).json(payload);
}

/* ── 入口 ── */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { safeJson(res, 405, { text: '', error: '仅支持 POST' }); return; }
  if (!DASHSCOPE_API_KEY) {
    console.error('[Transcribe Vercel] 未配置 DASHSCOPE_API_KEY');
    safeJson(res, 500, { text: '', error: '服务端未配置 DashScope API 密钥' });
    return;
  }

  try {
    // 读取完整请求体
    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on('data', (c) => chunks.push(c));
      req.on('end', resolve);
      req.on('error', reject);
    });
    const bodyBuffer = Buffer.concat(chunks);

    if (bodyBuffer.length === 0) {
      safeJson(res, 400, { text: '', error: '未收到音频数据' });
      return;
    }

    console.log(`[Transcribe Vercel] 收到请求体: ${(bodyBuffer.length / 1024).toFixed(1)}KB`);

    // 尝试直接作为纯二进制音频处理（非 multipart）
    let audioBuffer = null;
    let filename = 'audio.webm';

    const contentType = req.headers['content-type'] || '';
    const boundary = extractBoundary(contentType);

    if (boundary) {
      // Multipart 上传
      const file = parseMultipartFile(bodyBuffer, boundary);
      if (file) {
        audioBuffer = file.buffer;
        filename = file.filename;
      }
    }

    // 如果没有 boundary 或解析失败，尝试作为纯二进制
    if (!audioBuffer) {
      audioBuffer = bodyBuffer;
      console.log('[Transcribe Vercel] 非 multipart 请求，按纯二进制处理');
    }

    if (!audioBuffer || audioBuffer.length < 100) {
      safeJson(res, 400, { text: '', error: '音频数据太短或无效' });
      return;
    }

    console.log(`[Transcribe Vercel] 文件: ${filename}, 大小: ${(audioBuffer.length / 1024).toFixed(1)}KB`);
    const text = await transcribeWithOpenAIEndpoint(audioBuffer, filename);
    console.log(`[Transcribe Vercel] 转写成功: "${text}"`);
    safeJson(res, 200, { text });

  } catch (err) {
    console.error('[Transcribe Vercel] 转写失败:', err.message);
    safeJson(res, 500, { text: '', error: err.message });
  }
};
