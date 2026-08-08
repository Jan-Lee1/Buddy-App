// api/transcribe/status.js — Vercel Serverless: 阶段二（轮询 DashScope 任务 → 下载并返回转写文本）
// 入口: GET /api/transcribe/status?taskId=xxx
// 返回: { status: "processing"|"completed"|"failed", text?: "..." } 或 { error: { message: "..." } }

const https = require('https');

const DASHSCOPE_HOST = 'dashscope.aliyuncs.com';

// ── HTTPS GET 封装 ──
function httpsGet(opts) {
  return new Promise((resolve, reject) => {
    https.get({ ...opts, family: 4 }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

// ── 下载 transcription JSON ──
function downloadText(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      family: 4,
      timeout: 10000,
      headers: { 'User-Agent': 'PersonalManager/1.0' },
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

// ── Vercel handler ──
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  const apiKey = process.env.DASHSCOPE_API_KEY || process.env.DASHSCOPE_KEY || '';
  if (!apiKey) {
    return res.status(500).json({ error: { message: '服务端未配置 DASHSCOPE_API_KEY' } });
  }

  // 解析 taskId（支持 ?taskId=xxx 或 URL 路径）
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  let taskId = url.searchParams.get('taskId') || url.searchParams.get('task_id') || '';

  if (!taskId) {
    return res.status(400).json({ error: { message: '缺少 taskId 参数' } });
  }

  try {
    // ── 轮询 DashScope 任务状态 ──
    const pollResult = await httpsGet({
      hostname: DASHSCOPE_HOST,
      path: '/api/v1/tasks/' + encodeURIComponent(taskId),
      headers: { 'Authorization': 'Bearer ' + apiKey },
      timeout: 20000,
    });

    if (pollResult.status !== 200) {
      return res.status(502).json({ error: { message: '查询任务失败: HTTP ' + pollResult.status } });
    }

    const json = JSON.parse(pollResult.body);
    const taskStatus = json?.output?.task_status;

    if (!taskStatus) {
      return res.json({ status: 'error', message: '任务状态未知' });
    }

    if (taskStatus === 'PENDING' || taskStatus === 'RUNNING') {
      return res.json({ status: 'processing' });
    }

    if (taskStatus === 'FAILED') {
      return res.json({ status: 'failed', error: json?.output?.message || '任务失败' });
    }

    if (taskStatus === 'SUCCEEDED') {
      // ── 获取 transcription_url（多层嵌套结构） ──
      const results = json.output.results || [];
      const transUrl =
        results[0]?.transcription_url ||
        results[0]?.output?.results?.[0]?.transcription_url;

      if (!transUrl) {
        return res.json({ status: 'completed', text: '' });
      }

      // ── 下载并解析转写文本 ──
      const transBody = await downloadText(transUrl);
      let text = '';

      try {
        const transJson = JSON.parse(transBody);
        const transcripts = transJson?.transcripts || [];
        if (transcripts.length > 0) {
          text = transcripts.map((t) => t.text || '').join(' ').trim();
        } else if (transJson?.text) {
          text = transJson.text.trim();
        }
      } catch (e) {
        // 尝试直接当文本处理
        text = transBody.trim();
      }

      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.json({ status: 'completed', text });
    }

    return res.json({ status: 'error', message: '未知状态: ' + taskStatus });

  } catch (err) {
    console.error('[TranscribeStatus] 失败:', err.message);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(500).json({ error: { message: err.message } });
  }
};
