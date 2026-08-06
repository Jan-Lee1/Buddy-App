/**
 * Vercel Serverless: 语音转写 API
 * POST /api/transcribe
 * 接收音频文件 → DashScope Paraformer 异步转写 → 轮询结果 → 返回文本
 */

const https = require('https');
const DASHSCOPE_HOST = 'dashscope.aliyuncs.com';
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';

/* ── Vercel 函数配置：禁用默认 body parsing ── */
module.exports.config = { api: { bodyParser: false } };

/* ── 安全读取请求体（事件驱动，兼容所有 Node 版本）── */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (e) => reject(new Error('读取请求体失败: ' + e.message)));
  });
}

/* ── 解析 multipart boundary（处理带/不带引号）── */
function extractBoundary(contentType) {
  if (!contentType) return null;
  // 匹配 boundary="..." 或 boundary=...
  const m = contentType.match(/boundary=(?:(?:\s*"([^"]+)")|([^\s;]+))/i);
  return m ? (m[1] || m[2]) : null;
}

/* ── Multipart 解析（latin1 保留二进制完整性）── */
function parseMultipartFile(bodyBuffer, boundary) {
  const bodyStr = bodyBuffer.toString('latin1');
  const delimiter = '--' + boundary;
  const parts = bodyStr.split(delimiter);

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

    if (headersStr.toLowerCase().includes('filename')) {
      // 支持 filename="..." 或 filename=...（无引号）
      const filenameMatch = headersStr.match(/filename="([^"]*)"/) || headersStr.match(/filename=([^\s;\r\n]+)/);
      const filename = filenameMatch ? filenameMatch[1] : 'audio.webm';
      const fileBuffer = Buffer.from(contentStr, 'latin1');
      console.log(`[Transcribe Vercel] 收到文件: ${filename}, 大小: ${(fileBuffer.length / 1024).toFixed(1)}KB`);
      return { buffer: fileBuffer, filename };
    }
  }
  return null;
}

/* ── 获取 MIME 类型 ── */
function getMimeType(filename) {
  const f = filename.toLowerCase();
  if (f.endsWith('.mp4') || f.endsWith('.m4a')) return 'audio/mp4';
  if (f.endsWith('.ogg')) return 'audio/ogg';
  if (f.endsWith('.wav')) return 'audio/wav';
  if (f.endsWith('.mp3')) return 'audio/mpeg';
  return 'audio/webm';
}

/* ── 通用 HTTPS POST 工具 ── */
function dashscopePost(path, bodyStr, headersOverride, timeoutSec) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({
      'Authorization': 'Bearer ' + DASHSCOPE_API_KEY,
      'Content-Type': 'application/json',
    }, headersOverride || {});
    headers['Content-Length'] = String(Buffer.byteLength(bodyStr));

    const req = https.request({
      hostname: DASHSCOPE_HOST, port: 443, path,
      method: 'POST', headers,
      timeout: (timeoutSec || 30) * 1000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ statusCode: res.statusCode, body: json, raw: data });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: null, raw: data });
        }
      });
    });
    req.on('error', (e) => reject(new Error('DashScope 请求失败: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('DashScope 请求超时')); });
    req.write(bodyStr);
    req.end();
  });
}

/* ── 策略：input.file (base64) 异步提交 ── */
function submitWithFile(fileBuffer, filename) {
  const base64 = fileBuffer.toString('base64');
  const mimeType = getMimeType(filename);
  const postData = JSON.stringify({
    model: 'paraformer-v1',
    input: {
      file: `data:${mimeType};base64,${base64}`
    }
  });
  // X-DashScope-Async: enable 将请求转为异步模式，避免 "does not support synchronous calls" 错误
  return dashscopePost(
    '/api/v1/services/audio/asr/transcription',
    postData,
    { 'X-DashScope-Async': 'enable' }
  );
}

/* ── 从提交响应中提取 task_id ── */
function extractTaskId(response) {
  if (response.body && response.body.output && response.body.output.task_id) {
    return response.body.output.task_id;
  }
  const msg = (response.body && response.body.message) || (response.body && response.body.code) || 'Unknown';
  throw new Error('DashScope 提交失败: ' + msg);
}

/* ── 轮询转写任务 ── */
function pollTask(taskId, maxWaitMs) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const interval = 800;

    function doPoll() {
      if (Date.now() - startTime >= maxWaitMs) {
        return reject(new Error('转写任务超时，请重试'));
      }

      const req = https.request({
        hostname: DASHSCOPE_HOST, port: 443,
        path: '/api/v1/tasks/' + taskId,
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + DASHSCOPE_API_KEY },
        timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const status = json.output && json.output.task_status;

            if (status === 'SUCCEEDED') {
              const results = json.output && json.output.results;
              if (results && results.length > 0 && results[0].transcription_url) {
                fetchTranscriptionResult(results[0].transcription_url)
                  .then(resolve).catch(reject);
              } else {
                reject(new Error('转写已成功但无结果'));
              }
            } else if (status === 'FAILED') {
              reject(new Error('转写失败: ' + (json.output && json.output.message || '未知错误')));
            } else {
              setTimeout(doPoll, interval);
            }
          } catch (e) {
            reject(new Error('解析轮询响应失败'));
          }
        });
      });
      req.on('error', (e) => reject(new Error('轮询失败: ' + e.message)));
      req.on('timeout', () => { req.destroy(); setTimeout(doPoll, interval); });
      req.end();
    }
    doPoll();
  });
}

/* ── 获取转写结果文本 ── */
function fetchTranscriptionResult(url) {
  return new Promise((resolve, reject) => {
    try {
      const urlObj = new URL(url);
      const req = https.request({
        hostname: urlObj.hostname, port: 443,
        path: urlObj.pathname + urlObj.search,
        method: 'GET', timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const text = (json.transcripts || []).map(t => t.text).join(' ').trim();
            resolve(text);
          } catch (e) {
            reject(new Error('解析转写结果失败'));
          }
        });
      });
      req.on('error', (e) => reject(new Error('获取转写结果失败: ' + e.message)));
      req.on('timeout', () => { req.destroy(); reject(new Error('获取转写结果超时')); });
      req.end();
    } catch (e) {
      reject(new Error('转写结果 URL 无效'));
    }
  });
}

/* ── 安全发送 JSON 响应 ── */
function safeJson(res, status, payload) {
  if (res.headersSent) {
    console.warn('[Transcribe Vercel] 响应已发送，跳过重复写入');
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
  if (req.method !== 'POST') { safeJson(res, 405, { error: { message: '仅支持 POST' } }); return; }
  if (!DASHSCOPE_API_KEY) {
    console.error('[Transcribe Vercel] 未配置 DASHSCOPE_API_KEY');
    safeJson(res, 500, { error: { message: '服务端未配置 DashScope API 密钥' } });
    return;
  }

  try {
    // 解析 multipart 请求
    const contentType = req.headers['content-type'] || '';
    const boundary = extractBoundary(contentType);
    if (!boundary) {
      safeJson(res, 400, { error: { message: '请求格式错误，缺少 multipart boundary' } });
      return;
    }

    const bodyBuf = await readBody(req);

    const parsed = parseMultipartFile(bodyBuf, boundary);
    if (!parsed || !parsed.buffer || parsed.buffer.length < 100) {
      safeJson(res, 400, { error: { message: '未收到有效音频文件' } });
      return;
    }

    // 提交转写任务
    console.log('[Transcribe Vercel] 尝试提交转写任务');
    const submitResp = submitWithFile(parsed.buffer, parsed.filename);
    let taskId;
    try {
      const resp = await submitResp;
      taskId = extractTaskId(resp);
      console.log(`[Transcribe Vercel] 提交成功, task_id=${taskId}`);
    } catch (e) {
      console.error('[Transcribe Vercel] 提交失败:', e.message);
      safeJson(res, 500, {
        error: {
          code: 'SUBMIT_FAILED',
          message: 'Vercel 环境暂不支持语音转写，请在本地运行 node server.js 使用此功能',
          detail: e.message
        }
      });
      return;
    }

    // 轮询结果
    console.log(`[Transcribe Vercel] 任务 ${taskId} 已创建，开始轮询`);
    const text = await pollTask(taskId, 50000);
    console.log(`[Transcribe Vercel] 转写完成: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
    safeJson(res, 200, { text });

  } catch (err) {
    console.error('[Transcribe Vercel] 异常:', err.message);
    safeJson(res, 500, { error: { message: err.message || '转写服务内部错误' } });
  }
};
