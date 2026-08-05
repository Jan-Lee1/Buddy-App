/**
 * Vercel Serverless: 语音转写 API
 * POST /api/transcribe
 * 接收音频文件 → DashScope Paraformer 异步转写 → 轮询结果 → 返回文本
 */

// 禁用 Vercel 默认 body parsing（需要手动处理 multipart）
const config = { api: { bodyParser: false } };

const https = require('https');

const DASHSCOPE_HOST = 'dashscope.aliyuncs.com';
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';

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

function submitAudioToParaformer(audioBuffer, filename) {
  return new Promise((resolve, reject) => {
    const BOUNDARY = '----ParaformerBoundary' + Date.now();
    const crlf = '\r\n';

    const parts = [];
    parts.push(Buffer.from('--' + BOUNDARY + crlf));
    parts.push(Buffer.from('Content-Disposition: form-data; name="model"' + crlf + crlf));
    parts.push(Buffer.from('paraformer-v1' + crlf));
    parts.push(Buffer.from('--' + BOUNDARY + crlf));
    parts.push(Buffer.from('Content-Disposition: form-data; name="file"; filename="' + filename + '"' + crlf));
    parts.push(Buffer.from('Content-Type: audio/webm' + crlf + crlf));
    parts.push(audioBuffer);
    parts.push(Buffer.from(crlf + '--' + BOUNDARY + '--' + crlf));

    const body = Buffer.concat(parts);

    const options = {
      hostname: DASHSCOPE_HOST,
      port: 443,
      path: '/api/v1/services/audio/asr/transcription',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + DASHSCOPE_API_KEY,
        'Content-Type': 'multipart/form-data; boundary=' + BOUNDARY,
        'Content-Length': String(body.length),
      },
      timeout: 30000,
    };

    console.log(`[Paraformer] 提交转写任务, 音频: ${(audioBuffer.length / 1024).toFixed(1)}KB`);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        console.log(`[Paraformer] 提交响应 ${res.statusCode}`);
        try {
          const json = JSON.parse(data);
          const taskId = json.output?.task_id;
          if (!taskId) {
            reject(new Error(json.message || json.code || '未获取到转写任务ID'));
          } else {
            resolve(taskId);
          }
        } catch (e) {
          reject(new Error('解析提交响应失败'));
        }
      });
    });

    req.on('error', (e) => reject(new Error('提交转写任务失败: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('提交转写任务超时')); });
    req.write(body);
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
            console.log(`[Paraformer] 轮询 ${taskId}: ${status} (${(elapsed / 1000).toFixed(1)}s)`);

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
            reject(new Error('解析轮询响应失败'));
          }
        });
      });

      req.on('error', () => setTimeout(poll, pollInterval));
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

    https.request(options, (res) => {
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
    }).on('error', (e) => reject(new Error('获取转写结果失败: ' + e.message)))
      .on('timeout', function() { this.destroy(); reject(new Error('获取转写结果超时')); })
      .end();
  });
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: '仅支持 POST' } });
    return;
  }

  if (!DASHSCOPE_API_KEY) {
    res.status(500).json({ error: { message: '服务端未配置 DASHSCOPE_API_KEY 环境变量' } });
    return;
  }

  try {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(-+[^\s;]+)/);
    if (!boundaryMatch) {
      res.status(400).json({ error: { message: '请求格式错误，缺少 multipart boundary' } });
      return;
    }

    // 手动读取原始 body（bodyParser: false）
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyBuf = Buffer.concat(chunks);

    const parsed = parseMultipartFile(bodyBuf, boundaryMatch[1]);
    if (!parsed || !parsed.buffer || parsed.buffer.length < 100) {
      res.status(400).json({ error: { message: '未收到有效音频文件 (大小: ' + (bodyBuf ? bodyBuf.length : 0) + ' bytes)' } });
      return;
    }

    const taskId = await submitAudioToParaformer(parsed.buffer, parsed.filename);
    console.log(`[Transcribe] 任务已创建: ${taskId}`);

    const text = await pollTranscriptionTask(taskId, 40000);
    console.log(`[Transcribe] ✅ 最终文本: "${text.substring(0, 50)}..."`);

    res.status(200).json({ text });
  } catch (err) {
    console.error('[Transcribe] 转写失败:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
};

module.exports.config = config;
