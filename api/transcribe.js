/**
 * Vercel Serverless: 语音转写 API
 * POST /api/transcribe
 * 接收音频文件 → DashScope Paraformer 异步转写（file_urls 模式）→ 轮询结果 → 返回文本
 * Vercel 无法写入文件系统，音频以 base64 data URL 嵌入 file_urls
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
      console.log(`[Transcribe] 收到文件: ${filename}, 大小: ${(fileBuffer.length / 1024).toFixed(1)}KB`);
      return { buffer: fileBuffer, filename };
    }
  }
  return null;
}

/* ── 提交转写任务 ── */
function submitTask(fileBuffer, filename) {
  return new Promise((resolve, reject) => {
    // 转 base64 data URL（Vercel 无文件系统，用 data URL 传递音频）
    const base64 = fileBuffer.toString('base64');
    const mimeType = filename.endsWith('.mp4') || filename.endsWith('.m4a') ? 'audio/mp4'
      : filename.endsWith('.ogg') ? 'audio/ogg'
      : filename.endsWith('.wav') ? 'audio/wav'
      : 'audio/webm';
    const dataUrl = `data:${mimeType};base64,${base64}`;

    const postData = JSON.stringify({
      model: 'paraformer-v1',
      input: {
        file_urls: [dataUrl]
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

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
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
    req.on('error', (e) => reject(new Error('提交转写任务失败: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('提交转写任务超时')); });
    req.write(postData);
    req.end();
  });
}

/* ── 轮询转写任务 ── */
function pollTask(taskId, maxWaitMs) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const interval = 800;

    function poll() {
      if (Date.now() - startTime >= maxWaitMs) {
        return reject(new Error('转写任务超时'));
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

            if (status === 'SUCCEEDED') {
              const results = json.output?.results;
              if (results?.length > 0 && results[0].transcription_url) {
                fetchResult(results[0].transcription_url).then(resolve).catch(reject);
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
function fetchResult(url) {
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
  });
}

/* ── 入口 ── */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: { message: '仅支持 POST' } }); return; }
  if (!DASHSCOPE_API_KEY) { res.status(500).json({ error: { message: '未配置 DASHSCOPE_API_KEY' } }); return; }

  try {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(-+[^\s;]+)/);
    if (!boundaryMatch) { res.status(400).json({ error: { message: '缺少 multipart boundary' } }); return; }

    const chunks = [];
    for await (const chunk of req) { chunks.push(chunk); }
    const bodyBuf = Buffer.concat(chunks);

    const parsed = parseMultipartFile(bodyBuf, boundaryMatch[1]);
    if (!parsed?.buffer || parsed.buffer.length < 100) {
      res.status(400).json({ error: { message: '未收到有效音频文件' } }); return;
    }

    const taskId = await submitTask(parsed.buffer, parsed.filename);
    console.log(`[Transcribe Vercel] 任务 ${taskId} 已创建`);
    const text = await pollTask(taskId, 40000);
    console.log(`[Transcribe Vercel] ✅ "${text.substring(0, 50)}..."`);
    res.status(200).json({ text });
  } catch (err) {
    console.error('[Transcribe Vercel]', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
};

module.exports.config = config;
