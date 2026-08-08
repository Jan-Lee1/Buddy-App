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
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const STATIC_DIR = __dirname;

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
 *  TRANSCRIBE: 语音转写 (MediaRecorder → uguu.se → Paraformer)
 *  两阶段异步：
 *   POST /api/transcribe        → 上传音频→uguu.se→提交任务→返回taskId
 *   GET  /api/transcribe/status → 查询任务→返回文本
 * ================================================================ */

// ── multipart 文件解析 ──
function parseMultipartFile(bodyBuffer, boundary) {
  const bodyStr = bodyBuffer.toString('latin1');
  const parts = bodyStr.split('--' + boundary);

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === '' || trimmed === '--') continue;

    const headerEndIdx = part.indexOf('\r\n\r\n');
    if (headerEndIdx === -1) continue;

    const headersStr = part.substring(0, headerEndIdx);
    let contentStr = part.substring(headerEndIdx + 4);

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

// ── 上传音频到 litterbox.catbox.moe 免费临时文件服务 ──
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

    console.log(`[Litterbox] 上传 ${filename} (${(audioBuffer.length / 1024).toFixed(1)}KB) 到 litterbox.catbox.moe`);

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
      timeout: 30000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        console.log(`[Litterbox] HTTP ${res.statusCode}: ${d.substring(0, 200)}`);
        const url = d.trim();
        if (url.startsWith('https://')) {
          console.log(`[Litterbox] ✅ 上传成功: ${url}`);
          resolve(url);
        } else {
          reject(new Error('litterbox 上传失败: ' + d.substring(0, 200)));
        }
      });
    });
    req.on('error', (e) => reject(new Error('litterbox 网络错误: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('litterbox 上传超时')); });
    req.write(formBody);
    req.end();
  });
}

// ── 提交 DashScope 异步转写任务 ──
function submitTranscriptionTask(fileUrl, apiKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'paraformer-v2',
      input: { file_urls: [fileUrl] }
    });

    console.log(`[DashScope ASR] 提交任务: model=paraformer-v2, file_urls=[${fileUrl.substring(0, 60)}...]`);

    const req = https.request({
      hostname: DASHSCOPE_HOST,
      path: '/api/v1/services/audio/asr/transcription',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload)),
        'X-DashScope-Async': 'enable',
      },
      family: 4,
      timeout: 30000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        console.log(`[DashScope ASR] 提交状态: ${res.statusCode}, 响应: ${d.substring(0, 300)}`);
        try {
          const json = JSON.parse(d);
          if (json.output && json.output.task_id) {
            console.log(`[DashScope ASR] ✅ task_id: ${json.output.task_id}`);
            resolve(json.output.task_id);
          } else if (json.code) {
            reject(new Error('DashScope 返回错误: ' + json.code + ' - ' + (json.message || '')));
          } else {
            reject(new Error('DashScope 未返回 task_id: ' + d.substring(0, 200)));
          }
        } catch (e) {
          reject(new Error('DashScope 提交响应解析失败: ' + d.substring(0, 200)));
        }
      });
    });
    req.on('error', (e) => reject(new Error('DashScope 提交请求失败: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('DashScope 提交请求超时')); });
    req.write(payload);
    req.end();
  });
}

// ── 查询 DashScope 转写任务状态 ──
function queryTranscriptionTask(taskId, apiKey) {
  return new Promise((resolve, reject) => {
    const urlPath = '/api/v1/tasks/' + taskId;

    https.get({
      hostname: DASHSCOPE_HOST,
      path: urlPath,
      headers: { 'Authorization': 'Bearer ' + apiKey },
      family: 4,
      timeout: 20000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          const taskStatus = json.output && json.output.task_status;

          if (taskStatus === 'SUCCEEDED') {
            // 任务完成，获取 transcription_url（多层嵌套结构）
            const results = json.output.results || [];
            const transUrl =
              results[0]?.transcription_url ||
              results[0]?.output?.results?.[0]?.transcription_url;
            if (transUrl) {
              console.log(`[DashScope ASR] 任务完成，transcription_url: ${transUrl}`);

              // 下载转写结果
              https.get(transUrl, { family: 4 }, (res2) => {
                let d2 = '';
                res2.on('data', (c) => d2 += c);
                res2.on('end', () => {
                  try {
                    const transJson = JSON.parse(d2);
                    let text = '';
                    if (transJson.transcripts && transJson.transcripts.length > 0) {
                      text = transJson.transcripts[0].text || '';
                    } else if (transJson.text) {
                      text = transJson.text;
                    }
                    resolve({ status: 'completed', text: text.trim() });
                  } catch (e) {
                    reject(new Error('转写结果解析失败: ' + d2.substring(0, 200)));
                  }
                });
              }).on('error', (e) => reject(new Error('下载转写结果失败: ' + e.message)));
            } else {
              reject(new Error('任务完成但无 transcription_url'));
            }
          } else if (taskStatus === 'FAILED') {
            const errMsg = json.output && json.output.message || '未知错误';
            console.log(`[DashScope ASR] 任务失败: ${errMsg}`);
            resolve({ status: 'failed', error: errMsg });
          } else {
            // PENDING 或 RUNNING
            console.log(`[DashScope ASR] task_status: ${taskStatus || 'UNKNOWN'}`);
            resolve({ status: 'processing' });
          }
        } catch (e) {
          reject(new Error('DashScope 查询响应解析失败: ' + d.substring(0, 200)));
        }
      });
    }).on('error', (e) => reject(new Error('DashScope 查询请求失败: ' + e.message)));
  });
}

// ── POST /api/transcribe (阶段一：上传+提交任务) ──
function proxyToTranscribe(req, res) {
  const apiKey = getDashScopeKey(req);
  if (!apiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: '服务端未配置 DASHSCOPE_API_KEY' } }));
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => { chunks.push(chunk); });
  req.on('end', async () => {
    try {
      const bodyBuffer = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(-+[^\s;]+)/);

      if (!boundaryMatch) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ error: { message: '请求格式错误，缺少 multipart boundary' } }));
        return;
      }

      const parsed = parseMultipartFile(bodyBuffer, boundaryMatch[1]);
      if (!parsed || !parsed.buffer || parsed.buffer.length < 100) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ error: { message: '未收到有效音频文件' } }));
        return;
      }

      const mime = getMimeType(parsed.filename);
      console.log(`[Transcribe] 音频: ${(parsed.buffer.length / 1024).toFixed(1)}KB, MIME: ${mime}`);

      // Step 1: 上传到 litterbox.catbox.moe 获取公网 URL
      const publicUrl = await uploadToLitterbox(parsed.buffer, parsed.filename, mime);

      // Step 2: 提交 DashScope 异步转写任务
      const taskId = await submitTranscriptionTask(publicUrl, apiKey);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ status: 'processing', taskId }));
    } catch (err) {
      console.error('[Transcribe] 阶段一失败:', err.message);
      res.writeHead(500, corsHeaders());
      res.end(JSON.stringify({ error: { message: err.message } }));
    }
  });
}

// ── GET /api/transcribe/status (阶段二：查询任务) ──
function handleTranscribeStatus(req, res) {
  const apiKey = getDashScopeKey(req);
  if (!apiKey) {
    res.writeHead(500, corsHeaders());
    res.end(JSON.stringify({ error: { message: '服务端未配置 DASHSCOPE_API_KEY' } }));
    return;
  }

  const urlObj = new URL(req.url, 'http://localhost');
  const taskId = urlObj.searchParams.get('taskId');

  if (!taskId) {
    res.writeHead(400, corsHeaders());
    res.end(JSON.stringify({ error: { message: '缺少 taskId 参数' } }));
    return;
  }

  queryTranscriptionTask(taskId, apiKey).then((result) => {
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify(result));
  }).catch((err) => {
    console.error('[Transcribe] 阶段二失败:', err.message);
    res.writeHead(500, corsHeaders());
    res.end(JSON.stringify({ status: 'failed', error: err.message }));
  });
}

// ── CORS headers 快捷函数 ──
function corsHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  };
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

  // Proxy /api/transcribe → 语音转写提交任务
  if (req.url === '/api/transcribe' && req.method === 'POST') {
    proxyToTranscribe(req, res);
    return;
  }

  // GET /api/transcribe/status → 查询转写任务状态
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
