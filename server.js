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
const TEMP_DIR = path.join(__dirname, 'temp');
const FEISHU_HOST = 'open.feishu.cn';
const DASHSCOPE_HOST = 'dashscope.aliyuncs.com';

// 确保临时目录存在
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

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
  const targetPath = req.url.replace(/^\/api\/dashscope/, '/compatible-mode/v1');

  if (!DASHSCOPE_API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: '服务端未配置 DASHSCOPE_API_KEY 环境变量' } }));
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
      'authorization': `Bearer ${DASHSCOPE_API_KEY}`,
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
      resHeaders['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';

      res.writeHead(proxyRes.statusCode, resHeaders);

      proxyRes.on('end', () => {
        console.log(`[DashScope] Response ${proxyRes.statusCode} for ${targetPath}`);
        res.end(resBody);
      });
    });

    proxyReq.on('error', (err) => {
      console.error('[DashScope Error]', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'DashScope 代理连接失败: ' + err.message } }));
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      res.writeHead(504, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'DashScope 代理连接超时' } }));
    });

    if (rawBody) {
      proxyReq.write(rawBody);
    }
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
      resHeaders['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';

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

function submitAudioToParaformer(audioBuffer, filename, localUrl) {
  return new Promise((resolve, reject) => {
    // Paraformer 异步转写需要 JSON body，参数为 file_urls（不可直接上传文件流）
    const postData = JSON.stringify({
      model: 'paraformer-v1',
      input: {
        file_urls: [localUrl]
      }
    });

    const options = {
      hostname: DASHSCOPE_HOST,
      port: 443,
      path: '/api/v1/services/audio/asr/transcription',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + DASHSCOPE_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(postData)),
      },
      timeout: 30000,
    };

    console.log(`[Paraformer] 提交转写任务, file_urls: ${localUrl}, 音频大小: ${(audioBuffer.length / 1024).toFixed(1)}KB`);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        console.log(`[Paraformer] 提交响应 ${res.statusCode}: ${data.substring(0, 300)}`);
        try {
          const json = JSON.parse(data);
          const taskId = json.output?.task_id;
          if (!taskId) {
            reject(new Error(json.message || json.code || '未获取到转写任务ID'));
          } else {
            resolve(taskId);
          }
        } catch (e) {
          reject(new Error('解析提交响应失败: ' + data.substring(0, 100)));
        }
      });
    });

    req.on('error', (e) => { reject(new Error('提交转写任务失败: ' + e.message)); });
    req.on('timeout', () => { req.destroy(); reject(new Error('提交转写任务超时')); });
    req.write(postData);
    req.end();
  });
}

function pollTranscriptionTask(taskId, maxWaitMs) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const pollInterval = 800;

    function poll() {
      const elapsed = Date.now() - startTime;
      if (elapsed >= maxWaitMs) {
        reject(new Error('转写任务超时（超过' + (maxWaitMs / 1000) + '秒）'));
        return;
      }

      const options = {
        hostname: DASHSCOPE_HOST,
        port: 443,
        path: '/api/v1/tasks/' + taskId,
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + DASHSCOPE_API_KEY },
        timeout: 10000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const status = json.output?.task_status;
            console.log(`[Paraformer] 轮询任务 ${taskId}: ${status} (已等 ${(elapsed / 1000).toFixed(1)}s)`);

            if (status === 'SUCCEEDED') {
              const results = json.output?.results;
              if (results && results.length > 0 && results[0].transcription_url) {
                fetchTranscriptionResult(results[0].transcription_url).then(resolve).catch(reject);
              } else {
                reject(new Error('转写任务已完成但无结果'));
              }
            } else if (status === 'FAILED') {
              reject(new Error('转写任务失败: ' + (json.output?.message || '未知错误')));
            } else {
              setTimeout(poll, pollInterval);
            }
          } catch (e) {
            reject(new Error('解析轮询响应失败: ' + data.substring(0, 100)));
          }
        });
      });

      req.on('error', (e) => { reject(new Error('轮询转写任务失败: ' + e.message)); });
      req.on('timeout', () => { req.destroy(); setTimeout(poll, pollInterval); });
      req.end();
    }

    poll();
  });
}

function fetchTranscriptionResult(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const transcripts = json.transcripts || [];
          const text = transcripts.map(t => t.text).join(' ').trim();
          console.log(`[Paraformer] ✅ 转写完成: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
          resolve(text);
        } catch (e) {
          reject(new Error('解析转写结果失败'));
        }
      });
    });

    req.on('error', (e) => { reject(new Error('获取转写结果失败: ' + e.message)); });
    req.on('timeout', () => { req.destroy(); reject(new Error('获取转写结果超时')); });
    req.end();
  });
}

function proxyToTranscribe(req, res) {
  if (!DASHSCOPE_API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: '服务端未配置 DASHSCOPE_API_KEY 环境变量' } }));
    return;
  }

  // 收集整个请求体（二进制）
  const chunks = [];
  req.on('data', (chunk) => { chunks.push(chunk); });
  req.on('end', async () => {
    let tempFilePath = null;
    try {
      const bodyBuffer = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(-+[^\s;]+)/);

      if (!boundaryMatch) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: '请求格式错误，缺少 multipart boundary' } }));
        return;
      }

      const parsed = parseMultipartFile(bodyBuffer, boundaryMatch[1]);
      if (!parsed || !parsed.buffer || parsed.buffer.length < 100) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: '未收到有效音频文件' } }));
        return;
      }

      // 1. 保存音频文件到 temp 目录（Paraformer 需要可访问的 URL）
      const ext = path.extname(parsed.filename) || '.webm';
      const tempName = 'rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext;
      tempFilePath = path.join(TEMP_DIR, tempName);
      fs.writeFileSync(tempFilePath, parsed.buffer);
      console.log(`[Transcribe] 音频已保存: ${tempFilePath} (${(parsed.buffer.length / 1024).toFixed(1)}KB)`);

      // 构建本地可访问 URL
      const localUrl = `http://localhost:${PORT}/temp/${tempName}`;
      console.log(`[Transcribe] 文件 URL: ${localUrl}`);

      // 2. 提交转写任务（使用 file_urls）
      const taskId = await submitAudioToParaformer(parsed.buffer, parsed.filename, localUrl);
      console.log(`[Transcribe] 任务已创建: ${taskId}`);

      // 3. 轮询等待结果（最多等待 40 秒）
      const text = await pollTranscriptionTask(taskId, 40000);
      console.log(`[Transcribe] ✅ 最终文本: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ text }));
    } catch (err) {
      console.error('[Transcribe] 转写失败:', err.message);
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ error: { message: err.message } }));
    } finally {
      // 清理临时文件
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try { fs.unlinkSync(tempFilePath); console.log(`[Transcribe] 已清理: ${tempFilePath}`); }
        catch (e) { console.warn('[Transcribe] 清理失败:', e.message); }
      }
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
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
