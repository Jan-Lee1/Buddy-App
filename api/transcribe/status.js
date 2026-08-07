// api/transcribe/status.js — Vercel Serverless: 阶段二（查询转写任务状态）
// 入口: GET /api/transcribe/status?taskId=xxx
// 返回: { status: "processing" } | { status: "completed", text: "..." } | { status: "failed", error: "..." }

const https = require('https');

// ── 查询 DashScope 转写任务状态并获取结果 ──
function queryTranscriptionTask(taskId, apiKey) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'dashscope.aliyuncs.com',
      path: '/api/v1/tasks/' + taskId,
      headers: { 'Authorization': 'Bearer ' + apiKey },
      timeout: 15000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          const taskStatus = json.output && json.output.task_status;

          if (taskStatus === 'SUCCEEDED') {
            const results = json.output.results || [];
            if (results.length > 0 && results[0].transcription_url) {
              // 下载转写结果
              https.get(results[0].transcription_url, (res2) => {
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
                    reject(new Error('转写结果解析失败'));
                  }
                });
              }).on('error', (e) => reject(new Error('下载转写结果失败: ' + e.message)));
            } else {
              reject(new Error('任务完成但无 transcription_url'));
            }
          } else if (taskStatus === 'FAILED') {
            const errMsg = json.output && json.output.message || '转写失败';
            resolve({ status: 'failed', error: errMsg });
          } else {
            resolve({ status: 'processing' });
          }
        } catch (e) {
          reject(new Error('DashScope 响应解析失败'));
        }
      });
    }).on('error', (e) => reject(new Error('查询失败: ' + e.message)));
  });
}

// ── Vercel handler ──
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    return res.status(200).end();
  }

  const apiKey = process.env.DASHSCOPE_API_KEY || process.env.DASHSCOPE_KEY || '';
  if (!apiKey) {
    return res.status(500).json({ error: { message: '服务端未配置 DASHSCOPE_API_KEY' } });
  }

  const { taskId } = req.query;
  if (!taskId) {
    return res.status(400).json({ error: { message: '缺少 taskId 参数' } });
  }

  try {
    const result = await queryTranscriptionTask(taskId, apiKey);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(result);
  } catch (err) {
    console.error('[Transcribe Status] 失败:', err.message);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(500).json({ status: 'failed', error: err.message });
  }
};
