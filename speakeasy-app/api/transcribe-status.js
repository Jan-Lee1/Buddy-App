/**
 * GET /api/transcribe-status?task_id=xxx
 * 查询 DashScope 异步 ASR 任务 → 获取转写文本 → Qwen 评分分析
 */

import https from 'https';

const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY || '';

function httpsRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...opts, timeout: 25000 }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, body: buf.toString() });
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
    if (body) req.write(body);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    }).on('error', reject);
  });
}

// 获取转写文本
async function fetchTranscription(data) {
  const url = data?.output?.results?.transcription_url;
  if (!url) return null;
  try {
    const json = await httpGet(url);
    const parsed = JSON.parse(json);
    const transcripts = parsed?.transcripts || [];
    if (transcripts.length === 0) return '';
    return transcripts.map((t) => t.text || '').join(' ').trim();
  } catch {
    return null;
  }
}

// Qwen AI 分析转写文本
async function analyzeWithQwen(text) {
  const prompt = [
    'You are an English speaking coach.',
    'Analyze this English speech transcription from a language learner:',
    '',
    '"' + text + '"',
    '',
    'Reply in STRICT JSON (no markdown, no extra text):',
    '{',
    '  "accuracy": <0-100, grammar correctness>',
    '  "fluency": <0-100, natural flow>',
    '  "completeness": <0-100, how well-developed>',
    '  "total": <0-100, overall average>',
    '  "errors": [<2-3 specific English errors>]',
    '  "suggestions": [<2-3 improvement tips>]',
    '}',
    'If empty/noise, set all to 0 and errors to ["No valid speech detected"].',
    'Output ONLY the JSON object.',
  ].join('\n');

  const result = await httpsRequest(
    {
      hostname: 'dashscope.aliyuncs.com',
      path: '/api/v1/services/aigc/text-generation/generation',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + DASHSCOPE_KEY,
        'Content-Type': 'application/json',
      },
    },
    JSON.stringify({
      model: 'qwen-turbo',
      input: { messages: [{ role: 'user', content: prompt }] },
      parameters: { result_format: 'message', temperature: 0.3, max_tokens: 800 },
    })
  );

  if (result.status !== 200) return null;

  const data = JSON.parse(result.body);
  const content = data?.output?.choices?.[0]?.message?.content || '';
  // 提取 JSON
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

// 后备评分（Qwen 不可用时使用）
function fallbackScoring(text) {
  if (!text || text.trim().length === 0) {
    return {
      accuracy: 0, fluency: 0, completeness: 0, total: 0,
      errors: ['No valid speech detected'],
      suggestions: ['Try speaking clearly into the microphone', 'Ensure the environment is quiet'],
    };
  }
  const words = text.trim().split(/\s+/).length;
  const sentences = text.split(/[.!?]+/).filter(Boolean).length;
  const avgWordsPerSentence = sentences > 0 ? words / sentences : words;
  // 简单启发式
  const completeness = Math.min(100, Math.round(words * 7));
  const fluency = Math.min(100, Math.round(Math.min(words, 30) * 2.5 + Math.min(avgWordsPerSentence, 12) * 3));
  const accuracy = Math.min(100, Math.round(fluency * 0.85));
  const total = Math.round((accuracy + fluency + completeness) / 3);
  return {
    accuracy, fluency, completeness, total,
    errors: words < 5 ? ['Response too short - try to speak more'] : [],
    suggestions: words < 8 ? ['Expand your answers with more detail', 'Use complete sentences'] : ['Good job! Keep practicing to improve fluency.'],
  };
}

// 查询 DashScope 异步任务状态
async function pollTask(taskId) {
  const result = await httpsRequest(
    {
      hostname: 'dashscope.aliyuncs.com',
      path: '/api/v1/tasks/' + taskId,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + DASHSCOPE_KEY,
      },
    }
  );
  if (result.status !== 200) {
    throw new Error('DashScope polling failed: HTTP ' + result.status + ' - ' + result.body.substring(0, 300));
  }
  return JSON.parse(result.body);
}

// ─── Handler ───
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const url = new URL(req.url, 'http://localhost');
  const taskId = url.searchParams.get('task_id');
  if (!taskId) return res.status(400).json({ error: 'Missing task_id parameter' });

  try {
    // 查询任务状态
    const taskData = await pollTask(taskId);
    const taskStatus = taskData?.output?.task_status;
    const outputData = taskData?.output;
    const errorMsg = outputData?.message || '';

    if (taskStatus === 'PENDING' || taskStatus === 'RUNNING') {
      return res.status(200).json({ status: 'processing', task_status: taskStatus, message: 'ASR in progress...' });
    }

    if (taskStatus === 'FAILED') {
      return res.status(200).json({ status: 'failed', message: errorMsg || 'ASR task failed', error: errorMsg });
    }

    if (taskStatus === 'SUCCEEDED' || taskStatus === 'SUCCESS_WITH_NO_VALID_FRAGMENT') {
      // 获取转写文本
      const transcription = await fetchTranscription(taskData);
      const hasSpeech = taskStatus === 'SUCCEEDED' && transcription && transcription.length > 0;

      if (!hasSpeech) {
        // 无语音或空转写 -> 使用后备评分
        const scores = fallbackScoring(transcription || '');
        return res.status(200).json({
          status: 'completed',
          transcription: transcription || '',
          hasSpeech: false,
          ...scores,
        });
      }

      // 尝试 Qwen 评分，失败则后备
      let scores = await analyzeWithQwen(transcription);
      if (!scores) {
        scores = fallbackScoring(transcription);
      }

      return res.status(200).json({
        status: 'completed',
        transcription,
        hasSpeech: true,
        ...scores,
      });
    }

    // 未知状态
    return res.status(200).json({
      status: 'unknown',
      task_status: taskStatus,
      raw: JSON.stringify(outputData).substring(0, 500),
    });
  } catch (err) {
    console.error('[transcribe-status] Error:', err.message);
    return res.status(500).json({ status: 'error', error: err.message });
  }
}
