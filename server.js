/**
 * 个人管理系统 - 本地代理服务器
 * 功能：静态文件服务 + 飞书 API 反向代理 + DashScope AI 代理 + 语音转写
 * 启动：node server.js
 * 环境变量：
 *   DASHSCOPE_API_KEY   - 阿里云 DashScope API Key
 *   FEISHU_APP_ID       - 飞书应用 App ID
 *   FEISHU_APP_SECRET   - 飞书应用 App Secret
 * 零依赖，纯 Node.js 内置模块
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const PORT = 3000;
const STATIC_DIR = __dirname;

// ── 加载 .env 文件（本地开发环境） ──────────────────────────
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    // 跳过空行和注释
    if (trimmed && !trimmed.startsWith('#')) {
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        const key = trimmed.substring(0, eqIndex).trim();
        const value = trimmed.substring(eqIndex + 1).trim();
        // 移除可能的引号
        const cleanValue = value.replace(/^["']|["']$/g, '');
        if (!process.env[key]) {  // 不覆盖已有的系统环境变量
          process.env[key] = cleanValue;
        }
      }
    }
  });
  console.log('[Env] ✅ .env 文件已加载');
} else {
  console.log('[Env] ⚠️ 未找到 .env 文件，使用系统环境变量');
}

// Vercel 环境 /var/task 只读，使用 /tmp；本地使用 __dirname/temp
const TEMP_DIR = process.env.VERCEL
  ? path.join('/', 'tmp', 'temp')
  : path.join(__dirname, 'temp');

const FEISHU_HOST = 'open.feishu.cn';
const DASHSCOPE_HOST = 'dashscope.aliyuncs.com';

// 确保临时目录存在
try {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
} catch (e) {
  // Vercel 等只读文件系统环境，静默忽略
  console.warn('[Server] 无法创建 temp 目录:', e.message);
}

// ── 环境变量加载 ──────────────────────────────────────────
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const OSS_REGION = process.env.OSS_REGION || '';
const OSS_BUCKET = process.env.OSS_BUCKET || '';
const OSS_ACCESS_KEY_ID = process.env.OSS_ACCESS_KEY_ID || '';
const OSS_ACCESS_KEY_SECRET = process.env.OSS_ACCESS_KEY_SECRET || '';
const OSS_ENDPOINT = process.env.OSS_ENDPOINT || '';

if (DASHSCOPE_API_KEY) {
  console.log('[DashScope] API Key 已从环境变量加载 (' + DASHSCOPE_API_KEY.substring(0, 8) + '***)');
} else {
  console.log('[DashScope] 未设置 DASHSCOPE_API_KEY 环境变量，AI/转写功能将不可用');
}

if (FEISHU_APP_ID && FEISHU_APP_SECRET) {
  console.log('[Feishu] App ID/Secret 已从环境变量加载 (App ID: ' + FEISHU_APP_ID.substring(0, 8) + '***)');
} else if (FEISHU_APP_ID || FEISHU_APP_SECRET) {
  console.log('[Feishu] ⚠️ FEISHU_APP_ID 和 FEISHU_APP_SECRET 需要同时设置');
} else {
  console.log('[Feishu] 未设置 FEISHU_APP_ID/FEISHU_APP_SECRET，将通过前端透传凭据');
}

// ── API Key 获取工具 ────────────────────────────────────────
function getDashScopeKey(req) {
  // 仅从服务器端环境变量获取，不从请求头读取
  return DASHSCOPE_API_KEY;
}

// MIME 类型映射
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  let filePath;
  if (req.url === '/' || req.url === '') {
    filePath = path.join(STATIC_DIR, 'index.html');
  } else {
    // Strip query string
    const cleanPath = req.url.split('?')[0];
    filePath = path.join(STATIC_DIR, cleanPath);
  }

  // Security: prevent directory traversal
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback: any 404 goes to index.html
      fs.readFile(path.join(STATIC_DIR, 'index.html'), (e2, indexData) => {
        if (e2) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(indexData);
        }
      });
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=3600',
      });
      res.end(data);
    }
  });
}

function proxyToDashScope(req, res) {
  // /api/dashscope/chat/completions → /compatible-mode/v1/chat/completions
  const apiKey = getDashScopeKey(req);
  const targetPath = req.url.replace(/^\/api\/dashscope/, '/compatible-mode/v1');

  if (!apiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: '服务端未配置 DASHSCOPE_API_KEY（环境变量和请求头均缺失）' } }));
    return;
  }

  // Collect body first, then forward
  let rawBody = '';
  req.on('data', (chunk) => { rawBody += chunk; });
  req.on('end', () => {
    const cleanHeaders = {
      'host': DASHSCOPE_HOST,
      'accept': 'application/json',
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
    };

    const options = {
      hostname: DASHSCOPE_HOST,
      port: 443,
      path: targetPath,
      method: req.method,
      headers: cleanHeaders,
      timeout: 60000,
    };

    console.log(`[DashScope] ${req.method} ${targetPath} (${rawBody.length} bytes)`);

    const proxyReq = https.request(options, (proxyRes) => {
      let resBody = '';
      proxyRes.on('data', (chunk) => { resBody += chunk.toString(); });

      const resHeaders = {};
      for (const key of Object.keys(proxyRes.headers)) {
        const lower = key.toLowerCase();
        if (!['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers'].includes(lower)) {
          resHeaders[key] = proxyRes.headers[key];
        }
      }
      resHeaders['Access-Control-Allow-Origin'] = '*';
      resHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PUT, OPTIONS';
      resHeaders['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-DashScope-Key';

      res.writeHead(proxyRes.statusCode, resHeaders);

      proxyRes.on('end', () => {
        console.log(`[DashScope] Response ${proxyRes.statusCode} for ${targetPath}`);
        res.end(resBody);
      });
    });

    proxyReq.on('error', (e) => {
      console.error('[DashScope Error]', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'DashScope 请求失败: ' + e.message } }));
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      res.writeHead(504, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'DashScope 请求超时' } }));
    });

    proxyReq.write(rawBody);
    proxyReq.end();
  });
}

function proxyToFeishu(req, res) {
  // /api/auth/v3/... → /open-apis/auth/v3/...
  const targetPath = req.url.replace(/^\/api/, '/open-apis');

  // Collect the body first, then forward
  let rawBody = '';
  req.on('data', (chunk) => { rawBody += chunk; });
  req.on('end', () => {
    // Build clean headers: only forward essential ones, NOT content-length
    // (Node.js will recalculate it from the actual body we send)
    const cleanHeaders = {
      'host': FEISHU_HOST,
      'accept': 'application/json',
    };
    // Forward content-type if present
    if (req.headers['content-type']) {
      cleanHeaders['content-type'] = req.headers['content-type'];
    }
    // Forward authorization if present
    if (req.headers['authorization']) {
      cleanHeaders['authorization'] = req.headers['authorization'];
    }

    const options = {
      hostname: FEISHU_HOST,
      port: 443,
      path: targetPath,
      method: req.method,
      headers: cleanHeaders,
      timeout: 30000,
    };

    console.log(`[Proxy] ${req.method} ${targetPath} (${rawBody.length} bytes body)`);

    const proxyReq = https.request(options, (proxyRes) => {
      // Collect response for logging
      let resBody = '';
      proxyRes.on('data', (chunk) => { resBody += chunk.toString(); });

      // Pass through all response headers except CORS-related ones
      const resHeaders = {};
      for (const key of Object.keys(proxyRes.headers)) {
        const lower = key.toLowerCase();
        if (!['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers'].includes(lower)) {
          resHeaders[key] = proxyRes.headers[key];
        }
      }
      resHeaders['Access-Control-Allow-Origin'] = '*';
      resHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
      resHeaders['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-DashScope-Key';

      res.writeHead(proxyRes.statusCode, resHeaders);

      proxyRes.on('end', () => {
        console.log(`[Proxy] Response ${proxyRes.statusCode} for ${targetPath}:`, resBody.substring(0, 200));
        res.end(resBody);
      });
    });

    proxyReq.on('error', (err) => {
      console.error('[Proxy Error]', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: -1, msg: '飞书代理连接失败: ' + err.message }));
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      res.writeHead(504, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: -1, msg: '飞书代理连接超时' }));
    });

    // Write body and end
    if (rawBody) {
      proxyReq.write(rawBody);
    }
    proxyReq.end();
  });
}

/* ================================================================
 *  FEISHU TOKEN: 服务端获取飞书 Tenant Access Token
 *  使用环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET，凭据不暴露给前端
 * ================================================================ */
function proxyFeishuToken(req, res) {
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    // 未配置环境变量 → 回退到透传模式，由前端自行发送凭据
    proxyToFeishu(req, res);
    return;
  }

  const postData = JSON.stringify({
    app_id: FEISHU_APP_ID,
    app_secret: FEISHU_APP_SECRET
  });

  console.log(`[FeishuToken] 使用服务端凭据获取 Token`);

  const options = {
    hostname: FEISHU_HOST,
    port: 443,
    path: '/open-apis/auth/v3/tenant_access_token/internal',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Content-Length': String(Buffer.byteLength(postData)),
    },
    timeout: 10000,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', (chunk) => { data += chunk; });
    proxyRes.on('end', () => {
      try {
        const json = JSON.parse(data);
        console.log(`[FeishuToken] Response ${proxyRes.statusCode}: code=${json.code}, msg=${json.msg}`);
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
      } catch (e) {
        console.error('[FeishuToken] 解析响应失败:', e.message);
        res.writeHead(502, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ code: -1, msg: '飞书Token响应解析失败' }));
      }
    });
  });

  proxyReq.on('error', (err) => {
    console.error('[FeishuToken Error]', err.message);
    res.writeHead(502, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ code: -1, msg: '飞书Token获取失败: ' + err.message }));
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.writeHead(504, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ code: -1, msg: '飞书Token获取超时' }));
  });

  proxyReq.write(postData);
  proxyReq.end();
}

/* ================================================================
 *  TRANSCRIBE: 语音转写 (MediaRecorder → Paraformer)
 *  接收音频文件 → 异步提交 DashScope Paraformer → 轮询结果 → 返回文本
 * ================================================================ */
function parseMultipartFile(bodyBuffer, boundary) {
  // 用 latin1 编码分割，保留二进制完整性
  const bodyStr = bodyBuffer.toString('latin1');
  const parts = bodyStr.split('--' + boundary);

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === '' || trimmed === '--') continue;

    const headerEndIdx = part.indexOf('\r\n\r\n');
    if (headerEndIdx === -1) continue;

    const headersStr = part.substring(0, headerEndIdx);
    let contentStr = part.substring(headerEndIdx + 4);

    // 去除尾部 \r\n
    if (contentStr.endsWith('\r\n')) {
      contentStr = contentStr.substring(0, contentStr.length - 2);
    }

    if (headersStr.includes('filename=')) {
      const filenameMatch = headersStr.match(/filename="([^"]+)"/);
      const filename = filenameMatch ? filenameMatch[1] : 'audio.webm';
      const fileBuffer = Buffer.from(contentStr, 'latin1');
      console.log(`[Transcribe] 收到文件: ${filename}, 大小: ${(fileBuffer.length / 1024).toFixed(1)}KB`);
      return { buffer: fileBuffer, filename };
    }
  }
  return null;
}

// ── MIME 类型（根据文件名推断） ──
function getMimeType(filename) {
  const f = filename.toLowerCase();
  if (f.endsWith('.mp4') || f.endsWith('.m4a')) return 'audio/mp4';
  if (f.endsWith('.aac')) return 'audio/aac';
  if (f.endsWith('.ogg')) return 'audio/ogg';
  if (f.endsWith('.wav')) return 'audio/wav';
  if (f.endsWith('.mp3')) return 'audio/mpeg';
  return 'audio/webm';
}

function getOssConfig() {
  const missing = [];
  if (!OSS_REGION) missing.push('OSS_REGION');
  if (!OSS_BUCKET) missing.push('OSS_BUCKET');
  if (!OSS_ACCESS_KEY_ID) missing.push('OSS_ACCESS_KEY_ID');
  if (!OSS_ACCESS_KEY_SECRET) missing.push('OSS_ACCESS_KEY_SECRET');
  if (missing.length) throw new Error('服务端未配置 OSS 环境变量: ' + missing.join(', '));

  const endpoint = OSS_ENDPOINT || ('https://oss-' + OSS_REGION.replace(/^oss-/, '') + '.aliyuncs.com');
  let endpointUrl;
  try { endpointUrl = new URL(endpoint.includes('://') ? endpoint : 'https://' + endpoint); }
  catch { throw new Error('OSS_ENDPOINT 格式无效'); }
  const hostname = endpointUrl.hostname.startsWith(OSS_BUCKET + '.')
    ? endpointUrl.hostname
    : OSS_BUCKET + '.' + endpointUrl.hostname;
  return { bucket: OSS_BUCKET, accessKeyId: OSS_ACCESS_KEY_ID, accessKeySecret: OSS_ACCESS_KEY_SECRET, hostname };
}

function ossSignature(method, contentType, dateOrExpires, resource, secret) {
  const stringToSign = [method, '', contentType || '', dateOrExpires, resource].join('\n');
  return crypto.createHmac('sha1', secret).update(stringToSign).digest('base64');
}

function uploadToOSS(audioBuffer, filename, mimeType) {
  return new Promise((resolve, reject) => {
    let config;
    try { config = getOssConfig(); } catch (error) { reject(error); return; }
    const ext = path.extname(filename || '').replace(/[^a-zA-Z0-9]/g, '') || 'webm';
    const objectKey = 'asr/' + new Date().toISOString().slice(0, 10) + '/' + crypto.randomUUID() + '.' + ext;
    const resource = '/' + config.bucket + '/' + objectKey;
    const date = new Date().toUTCString();
    const authorization = 'OSS ' + config.accessKeyId + ':' + ossSignature('PUT', mimeType, date, resource, config.accessKeySecret);
    const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/');
    const uploadReq = https.request({
      hostname: config.hostname, path: '/' + encodedKey, method: 'PUT',
      headers: { 'Content-Type': mimeType, 'Content-Length': String(audioBuffer.length), Date: date, Authorization: authorization },
      family: 4, timeout: 25000,
    }, (uploadRes) => {
      let data = ''; uploadRes.on('data', chunk => { data += chunk; });
      uploadRes.on('end', () => {
        if (uploadRes.statusCode >= 200 && uploadRes.statusCode < 300) {
          const expires = String(Math.floor(Date.now() / 1000) + 20 * 60);
          const signature = ossSignature('GET', '', expires, resource, config.accessKeySecret);
          const query = new URLSearchParams({ OSSAccessKeyId: config.accessKeyId, Expires: expires, Signature: signature });
          // The bucket remains private. Configure an OSS lifecycle rule to delete asr/ objects after a short retention period.
          resolve('https://' + config.hostname + '/' + encodedKey + '?' + query.toString());
        } else {
          reject(new Error('OSS 上传失败: HTTP ' + uploadRes.statusCode + ' ' + data.substring(0, 200)));
        }
      });
    });
    uploadReq.on('error', error => reject(new Error('OSS 网络错误: ' + error.message)));
    uploadReq.on('timeout', () => { uploadReq.destroy(); reject(new Error('OSS 上传超时')); });
    uploadReq.write(audioBuffer); uploadReq.end();
  });
}

function submitTranscriptionTask(fileUrl, apiKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model: 'paraformer-v2', input: { file_urls: [fileUrl] } });
    const taskReq = https.request({
      hostname: DASHSCOPE_HOST, path: '/api/v1/services/audio/asr/transcription', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)), 'X-DashScope-Async': 'enable' },
      family: 4, timeout: 25000,
    }, (taskRes) => {
      let data = ''; taskRes.on('data', chunk => { data += chunk; });
      taskRes.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.output && json.output.task_id) resolve(json.output.task_id);
          else if (json.code) reject(new Error('DashScope: ' + json.code + ' - ' + (json.message || '')));
          else reject(new Error('DashScope 未返回 task_id'));
        } catch { reject(new Error('DashScope 响应异常')); }
      });
    });
    taskReq.on('error', error => reject(new Error('DashScope 网络错误: ' + error.message)));
    taskReq.on('timeout', () => { taskReq.destroy(); reject(new Error('DashScope 超时')); });
    taskReq.write(payload); taskReq.end();
  });
}

function requestText(options) {
  return new Promise((resolve, reject) => {
    const request = https.get({ ...options, family: 4 }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.on('timeout', () => { request.destroy(); reject(new Error('请求超时')); });
  });
}

async function handleTranscribeStatus(req, res) {
  const apiKey = getDashScopeKey(req);
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const taskId = url.searchParams.get('taskId') || url.searchParams.get('task_id') || '';
  if (!apiKey) return sendTranscribeJson(res, 500, { error: { message: '服务端未配置 DASHSCOPE_API_KEY' } });
  if (!taskId) return sendTranscribeJson(res, 400, { error: { message: '缺少 taskId 参数' } });

  try {
    const pollResult = await requestText({ hostname: DASHSCOPE_HOST, path: '/api/v1/tasks/' + encodeURIComponent(taskId), headers: { Authorization: 'Bearer ' + apiKey }, timeout: 20000 });
    if (pollResult.status !== 200) return sendTranscribeJson(res, 502, { error: { message: '查询任务失败: HTTP ' + pollResult.status } });
    const task = JSON.parse(pollResult.body);
    const taskStatus = task && task.output && task.output.task_status;
    if (taskStatus === 'PENDING' || taskStatus === 'RUNNING') return sendTranscribeJson(res, 200, { status: 'processing' });
    if (taskStatus === 'FAILED') return sendTranscribeJson(res, 200, { status: 'failed', error: (task.output && task.output.message) || '任务失败' });
    if (taskStatus !== 'SUCCEEDED') return sendTranscribeJson(res, 200, { status: 'error', message: '未知状态: ' + (taskStatus || 'unknown') });

    const results = (task.output && task.output.results) || [];
    const transcriptionUrl = (results[0] && results[0].transcription_url) || (results[0] && results[0].output && results[0].output.results && results[0].output.results[0] && results[0].output.results[0].transcription_url);
    if (!transcriptionUrl) return sendTranscribeJson(res, 200, { status: 'completed', text: '' });
    const transcription = new URL(transcriptionUrl);
    const textResult = await requestText({ hostname: transcription.hostname, path: transcription.pathname + transcription.search, timeout: 10000, headers: { 'User-Agent': 'PersonalManager/1.0' } });
    let text = '';
    try {
      const parsed = JSON.parse(textResult.body);
      if (Array.isArray(parsed.transcripts)) text = parsed.transcripts.map(item => item.text || '').join(' ').trim();
      else if (parsed.text) text = String(parsed.text).trim();
    } catch { text = textResult.body.trim(); }
    return sendTranscribeJson(res, 200, { status: 'completed', text });
  } catch (error) {
    console.error('[TranscribeStatus] 失败:', error.message);
    return sendTranscribeJson(res, 500, { error: { message: error.message } });
  }
}

function sendTranscribeJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function proxyToTranscribe(req, res) {
  const apiKey = getDashScopeKey(req);
  if (!apiKey) return sendTranscribeJson(res, 500, { error: { message: '服务端未配置 DASHSCOPE_API_KEY' } });
  const chunks = [];
  req.on('data', chunk => { chunks.push(chunk); });
  req.on('end', async () => {
    try {
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(-+[^\s;]+)/);
      if (!boundaryMatch) return sendTranscribeJson(res, 400, { error: { message: '缺少 multipart boundary' } });
      const parsed = parseMultipartFile(Buffer.concat(chunks), boundaryMatch[1]);
      if (!parsed || !parsed.buffer || parsed.buffer.length < 100) return sendTranscribeJson(res, 400, { error: { message: '未收到有效音频文件' } });
      const startedAt = Date.now();
      const uploadStartedAt = Date.now();
      const signedUrl = await uploadToOSS(parsed.buffer, parsed.filename, getMimeType(parsed.filename));
      console.log('[Perf] ASR upload: ' + (Date.now() - uploadStartedAt) + 'ms');
      const submitStartedAt = Date.now();
      const taskId = await submitTranscriptionTask(signedUrl, apiKey);
      console.log('[Perf] ASR submit: ' + (Date.now() - submitStartedAt) + 'ms');
      console.log('[Perf] ASR total: ' + (Date.now() - startedAt) + 'ms');
      console.log('[Transcribe] 已提交异步任务:', taskId);
      return sendTranscribeJson(res, 200, { status: 'processing', taskId });
    } catch (error) {
      console.error('[Transcribe] 失败:', error.message);
      return sendTranscribeJson(res, 500, { error: { message: error.message } });
    }
  });
}

const server = http.createServer((req, res) => {
  console.log(`[Request] ${req.method} ${req.url}`);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-DashScope-Key',
    });
    res.end();
    return;
  }

  // Proxy /api/feishu/token → 服务端获取飞书 Token（BEFORE /api/ general）
  if (req.url === '/api/feishu/token' && req.method === 'POST') {
    proxyFeishuToken(req, res);
    return;
  }

  // Proxy /api/transcribe → DashScope Paraformer 语音转写 (BEFORE /api/ general)
  if (req.url === '/api/transcribe' && req.method === 'POST') {
    proxyToTranscribe(req, res);
    return;
  }

  // 查询语音转写任务必须在通用 /api/* 飞书代理之前处理
  if (req.url.startsWith('/api/transcribe/status') && req.method === 'GET') {
    handleTranscribeStatus(req, res);
    return;
  }

  // Proxy /api/dashscope/* → DashScope AI (must check BEFORE /api/ feishu)
  if (req.url.startsWith('/api/dashscope/')) {
    proxyToDashScope(req, res);
    return;
  }

  // Proxy /api/* → Feishu Open API
  if (req.url.startsWith('/api/')) {
    proxyToFeishu(req, res);
    return;
  }

  // Serve static files
  serveStatic(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   个人管理系统 · 已启动                  ║');
  console.log('║   http://localhost:' + PORT + '                    ║');
  console.log('║   飞书Token:  /api/feishu/token          ║');
  console.log('║   飞书代理:  /api → open.feishu.cn       ║');
  console.log('║   AI 代理:   /api/dashscope → dashscope  ║');
  console.log('║   语音转写:  /api/transcribe → Paraformer ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('按 Ctrl+C 停止服务器');
});
