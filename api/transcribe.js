/**
 * Vercel Serverless: 语音转写 API
 * POST /api/transcribe
 * 接收音频文件 → DashScope Paraformer 异步转写 → 轮询结果 → 返回文本
 * Vercel 限制：DashScope 只接受公网 URL 作为 file_urls，不可用 data: URL
 * 策略 1：尝试用 input.file (base64) 提交
 * 策略 2：回退为友好错误提示
 */

const https = require('https');
const DASHSCOPE_HOST = 'dashscope.aliyuncs.com';
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';

// 禁用 Vercel 默认 body parsing
const config = { api: { bodyParser: false } };

/* ── Multipart 解析（latin1 保留二进制完整性）── */
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
    if (contentStr.endsWith('\r\n')) contentStr = contentStr.substring(0, contentStr.length - 2);

    if (headersStr.includes('filename=')) {
      const filenameMatch = headersStr.match(/filename="([^"]+)"/);
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
  if (filename.endsWith('.mp4') || filename.endsWith('.m4a')) return 'audio/mp4';
  if (filename.endsWith('.ogg')) return 'audio/ogg';
  if (filename.endsWith('.wav')) return 'audio/wav';
  if (filename.endsWith('.mp3')) return 'audio/mpeg';
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

/* ── 策略 1：input.file (base64) 提交 ── */
function submitWithFile(fileBuffer, filename) {
  const base64 = fileBuffer.toString('base64');
  const mimeType = getMimeType(filename);
  const postData = JSON.stringify({
    model: 'paraformer-v1',
    input: {
      file: `data:${mimeType};base64,${base64}`
    }
  });
  return dashscopePost('/api/v1/services/audio/asr/transcription', postData);
}

/* ── 策略 2：input.file_urls (data: URL) 提交 ── */
function submitWithFileUrls(fileBuffer, filename) {
  const base64 = fileBuffer.toString('base64');
  const mimeType = getMimeType(filename);
  const dataUrl = `data:${mimeType};base64,${base64}`;
  const postData = JSON.stringify({
    model: 'paraformer-v1',
    input: {
      file_urls: [dataUrl]
    }
  });
  return dashscopePost('/api/v1/services/audio/asr/transcription', postData);
}

/* ── 从提交响应中提取 task_id ── */
function extractTaskId(response) {
  if (response.body?.output?.task_id) return response.body.output.task_id;
  const msg = response.body?.message || response.body?.code || 'Unknown';
  throw new Error('DashScope 提交失败: ' + msg);
}

/* ── 轮询转写任务 ── */
function pollTask(taskId, maxWaitMs) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const interval = 800;

    function poll() {
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
            const status = json.output?.task_status;

            if (status === 'SUCCEEDED') {
              const results = json.output?.results;
              if (results?.length > 0 && results[0].transcription_url) {
                fetchTranscriptionResult(results[0].transcription_url)
                  .then(resolve).catch(reject);
              } else {
                reject(new Error('转写已成功但无结果'));
              }
            } else if (status === 'FAILED') {
              reject(new Error('转写失败: ' + (json.output?.message || '未知错误')));
            } else {
              setTimeout(poll, interval);
            }
          } catch (e) {
            reject(new Error('解析轮询响应失败'));
          }
        });
      });
      req.on('error', (e) => reject(new Error('轮询失败: ' + e.message)));
      req.on('timeout', () => { req.destroy(); setTimeout(poll, interval); });
      req.end();
    }
    poll();
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

/* ── 入口 ── */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: { message: '仅支持 POST' } }); return; }
  if (!DASHSCOPE_API_KEY) {
    console.error('[Transcribe Vercel] 未配置 DASHSCOPE_API_KEY');
    res.status(500).json({ error: { message: '服务端未配置 DashScope API 密钥' } }); return;
  }

  try {
    // 解析 multipart 请求
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(-+[^\s;]+)/);
    if (!boundaryMatch) {
      res.status(400).json({ error: { message: '请求格式错误，缺少 multipart boundary' } }); return;
    }

    const chunks = [];
    for await (const chunk of req) { chunks.push(chunk); }
    const bodyBuf = Buffer.concat(chunks);

    const parsed = parseMultipartFile(bodyBuf, boundaryMatch[1]);
    if (!parsed?.buffer || parsed.buffer.length < 100) {
      res.status(400).json({ error: { message: '未收到有效音频文件' } }); return;
    }

    // 多策略提交（按优先级尝试）
    const strategies = [
      { name: 'file (base64)', fn: () => submitWithFile(parsed.buffer, parsed.filename) },
      { name: 'file_urls (data:)', fn: () => submitWithFileUrls(parsed.buffer, parsed.filename) },
    ];

    let taskId = null;
    let lastError = null;
    const errors = [];

    for (const strategy of strategies) {
      try {
        console.log(`[Transcribe Vercel] 尝试策略: ${strategy.name}`);
        const resp = await strategy.fn();
        if (resp.statusCode >= 200 && resp.statusCode < 300 && resp.body?.output?.task_id) {
          taskId = resp.body.output.task_id;
          console.log(`[Transcribe Vercel] 策略 "${strategy.name}" 成功, task_id=${taskId}`);
          break;
        }
        const errMsg = resp.body?.message || `HTTP ${resp.statusCode}`;
        errors.push({ strategy: strategy.name, error: errMsg });
        console.log(`[Transcribe Vercel] 策略 "${strategy.name}" 返回 ${resp.statusCode}: ${errMsg}`);
      } catch (e) {
        errors.push({ strategy: strategy.name, error: e.message });
        console.log(`[Transcribe Vercel] 策略 "${strategy.name}" 异常: ${e.message}`);
      }
    }

    if (!taskId) {
      console.error('[Transcribe Vercel] 所有提交策略均失败:', JSON.stringify(errors));
      res.status(500).json({
        error: {
          code: 'SUBMIT_FAILED',
          message: 'Vercel 环境暂不支持语音转写，请在本地运行 node server.js 使用此功能',
          detail: errors.map(e => `${e.strategy}: ${e.error}`).join('; ')
        }
      });
      return;
    }

    console.log(`[Transcribe Vercel] 任务 ${taskId} 已创建，开始轮询`);
    const text = await pollTask(taskId, 55000);
    console.log(`[Transcribe Vercel] 转写完成: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
    res.status(200).json({ text });

  } catch (err) {
    console.error('[Transcribe Vercel] 异常:', err.message);
    res.status(500).json({ error: { message: err.message || '转写服务内部错误' } });
  }
};

module.exports.config = config;
