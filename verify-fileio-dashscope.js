/**
 * 最小链路验证：WebM → file.io → DashScope Paraformer-v2 → 转写文本
 * 
 * 这是一个独立脚本，不依赖任何项目代码，不修改任何项目文件。
 * 
 * 使用方法：
 *   set DASHSCOPE_API_KEY=sk-xxx
 *   node verify-fileio-dashscope.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';
const SCRIPT_DIR = __dirname;
const TEST_AUDIO_FILE = path.join(SCRIPT_DIR, 'test-audio.wav');

// ============================================================
// 工具函数
// ============================================================

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      ...options,
      ALPNProtocols: ['http/1.1'],
      timeout: 30000,
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, headers: res.headers, body: raw });
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
    if (body) {
      if (typeof body === 'string') req.write(body);
      else req.write(body);
    }
    req.end();
  });
}

function httpsDownload(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000, ALPNProtocols: ['http/1.1'] }, (res) => {
      // 处理重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log(`  [重定向] ${res.statusCode} → ${res.headers.location}`);
        httpsDownload(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`下载失败 HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject).on('timeout', () => reject(new Error('下载超时')));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// 步骤 0：生成测试音频文件
// ============================================================
function generateTestWav() {
  console.log('═══════════════════════════════════════════════');
  console.log('  步骤 0：生成测试音频文件');
  console.log('═══════════════════════════════════════════════');
  
  const sampleRate = 16000;
  const bitsPerSample = 16;
  const numChannels = 1;
  const durationSec = 2; // 2秒音频
  const numSamples = sampleRate * durationSec;
  const dataSize = numSamples * (bitsPerSample / 8) * numChannels;
  
  // WAV header (44 bytes + data)
  const buffer = Buffer.alloc(44 + dataSize);
  
  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4); // file size - 8
  buffer.write('WAVE', 8);
  
  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20);  // audio format (1 = PCM)
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * bitsPerSample / 8, 28); // byte rate
  buffer.writeUInt16LE(numChannels * bitsPerSample / 8, 32); // block align
  buffer.writeUInt16LE(bitsPerSample, 34);
  
  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  
  // Generate a simple 440Hz sine tone (A4 note)
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const amplitude = 0.3;
    const sample = Math.sin(2 * Math.PI * 440 * t) * amplitude * 32767;
    buffer.writeInt16LE(Math.round(sample), 44 + i * 2);
  }
  
  fs.writeFileSync(TEST_AUDIO_FILE, buffer);
  console.log(`✅ 测试音频已生成: ${TEST_AUDIO_FILE}`);
  console.log(`   格式: PCM WAV, ${sampleRate}Hz, ${bitsPerSample}bit, ${numChannels}ch`);
  console.log(`   时长: ${durationSec}秒, 大小: ${buffer.length} bytes`);
  console.log('');
  return buffer;
}

// ============================================================
// 步骤 1：上传 file.io
// ============================================================
async function uploadToFileIO(audioBuffer) {
  console.log('═══════════════════════════════════════════════');
  console.log('  步骤 1：上传 file.io');
  console.log('═══════════════════════════════════════════════');
  
  const filename = 'test-asr-' + Date.now() + '.wav';
  const boundary = '----FileIOTest' + Date.now() + crypto.randomBytes(4).toString('hex');
  const CRLF = '\r\n';
  
  const parts = [];
  parts.push(Buffer.from('--' + boundary + CRLF));
  parts.push(Buffer.from('Content-Disposition: form-data; name="file"; filename="' + filename + '"' + CRLF));
  parts.push(Buffer.from('Content-Type: audio/wav' + CRLF + CRLF));
  parts.push(audioBuffer);
  parts.push(Buffer.from(CRLF + '--' + boundary + '--' + CRLF));
  
  const body = Buffer.concat(parts);
  
  console.log(`  文件: ${filename}, 大小: ${audioBuffer.length} bytes`);
  console.log(`  Content-Type: multipart/form-data; boundary=${boundary}`);
  console.log(`  Boundary: ${boundary}`);
  console.log(`  请求总大小: ${body.length} bytes`);
  console.log('');
  console.log('  发送 POST https://file.io ...');
  
  const startTime = Date.now();
  
  let result;
  try {
    result = await httpsRequest({
      hostname: 'file.io',
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': String(body.length),
        'Accept': 'application/json',
      },
    }, body);
  } catch (err) {
    console.error(`  ❌ file.io 上传失败: ${err.message}`);
    return null;
  }
  
  const elapsed = Date.now() - startTime;
  console.log(`  HTTP ${result.statusCode} (${elapsed}ms)`);
  console.log(`  响应头: ${JSON.stringify(result.headers)}`);
  console.log(`  响应体: ${result.body}`);
  console.log('');
  
  // 解析响应
  try {
    const json = JSON.parse(result.body);
    
    if (!json.success) {
      console.error(`  ❌ file.io 返回失败: ${JSON.stringify(json)}`);
      return null;
    }
    
    const downloadUrl = json.link;
    console.log(`  ✅ 上传成功！`);
    console.log(`  下载 URL: ${downloadUrl}`);
    console.log(`  HTTPS: ${downloadUrl.startsWith('https://') ? '✅' : '❌'}`);
    console.log(`  文件 Key: ${json.key}`);
    console.log(`  是否私有: ${json.private}`);
    console.log(`  过期时间: ${json.expires || 'N/A'}`);
    console.log('');
    
    return { url: downloadUrl, json };
  } catch (e) {
    console.error(`  ❌ 无法解析 file.io 响应: ${e.message}`);
    return null;
  }
}

// ============================================================
// 步骤 2：创建 DashScope ASR 任务
// ============================================================
async function createDashScopeTask(fileUrl) {
  console.log('═══════════════════════════════════════════════');
  console.log('  步骤 2：创建 DashScope ASR 任务');
  console.log('═══════════════════════════════════════════════');
  
  console.log(`  模型: paraformer-v2`);
  console.log(`  文件 URL: ${fileUrl}`);
  console.log('  X-DashScope-Async: enable');
  console.log('');
  
  const requestBody = JSON.stringify({
    model: 'paraformer-v2',
    input: {
      file_urls: [fileUrl]
    },
    parameters: {
      format: 'wav',
      sample_rate: 16000,
    }
  });
  
  console.log(`  请求体: ${requestBody}`);
  console.log('');
  console.log('  发送 POST https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription ...');
  
  const startTime = Date.now();
  
  let result;
  try {
    result = await httpsRequest({
      hostname: 'dashscope.aliyuncs.com',
      path: '/api/v1/services/audio/asr/transcription',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + DASHSCOPE_API_KEY,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
        'Accept': 'application/json',
      },
    }, requestBody);
  } catch (err) {
    console.error(`  ❌ DashScope 请求失败: ${err.message}`);
    return null;
  }
  
  const elapsed = Date.now() - startTime;
  console.log(`  HTTP ${result.statusCode} (${elapsed}ms)`);
  console.log(`  响应体: ${result.body}`);
  console.log('');
  
  try {
    const json = JSON.parse(result.body);
    
    if (result.statusCode !== 200 || !json.output || !json.output.task_id) {
      console.error(`  ❌ DashScope 返回错误:`);
      console.error(`     HTTP 状态码: ${result.statusCode}`);
      console.error(`     原始响应: ${result.body}`);
      return null;
    }
    
    const taskId = json.output.task_id;
    const taskStatus = json.output.task_status;
    
    console.log(`  ✅ 任务创建成功！`);
    console.log(`  task_id: ${taskId}`);
    console.log(`  task_status: ${taskStatus}`);
    console.log(`  request_id: ${json.request_id || 'N/A'}`);
    console.log('');
    
    return { taskId, json };
  } catch (e) {
    console.error(`  ❌ 无法解析 DashScope 响应: ${e.message}`);
    return null;
  }
}

// ============================================================
// 步骤 3：轮询任务状态
// ============================================================
async function pollTask(taskId) {
  console.log('═══════════════════════════════════════════════');
  console.log('  步骤 3：轮询任务状态');
  console.log('═══════════════════════════════════════════════');
  console.log(`  task_id: ${taskId}`);
  console.log('');
  
  const maxAttempts = 30;
  const pollInterval = 2000; // 2 秒轮询
  
  let totalElapsed = 0;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startTime = Date.now();
    
    let result;
    try {
      result = await httpsRequest({
        hostname: 'dashscope.aliyuncs.com',
        path: '/api/v1/tasks/' + taskId,
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + DASHSCOPE_API_KEY,
          'Accept': 'application/json',
        },
      }, null);
    } catch (err) {
      console.error(`  ❌ 查询任务失败: ${err.message}`);
      return null;
    }
    
    const elapsed = Date.now() - startTime;
    totalElapsed += elapsed;
    
    try {
      const json = JSON.parse(result.body);
      const status = json.output?.task_status || 'UNKNOWN';
      
      console.log(`  查询 #${attempt}: HTTP ${result.statusCode}, status=${status} (${elapsed}ms, 累计 ${(totalElapsed / 1000).toFixed(1)}s)`);
      
      if (status === 'SUCCEEDED') {
        console.log('');
        console.log(`  ✅ 任务成功！总轮询耗时: ${(totalElapsed / 1000).toFixed(1)}秒`);
        
        // 获取 transcription_url
        const transcriptionUrl = json.output?.results?.[0]?.transcription_url;
        console.log(`  transcription_url: ${transcriptionUrl || 'N/A'}`);
        console.log(`  完整响应: ${result.body.substring(0, 500)}`);
        console.log('');
        return { status: 'SUCCEEDED', json, transcriptionUrl };
      }
      
      if (status === 'FAILED') {
        console.error('');
        console.error(`  ❌ 任务失败！`);
        console.error(`  错误信息: ${json.output?.message || json.message || '未知错误'}`);
        console.error(`  完整响应: ${result.body}`);
        console.log('');
        return { status: 'FAILED', json, transcriptionUrl: null };
      }
      
      // PENDING 或 RUNNING，继续轮询
      if (attempt < maxAttempts) {
        await sleep(pollInterval);
      }
    } catch (e) {
      console.error(`  ❌ 解析响应失败: ${e.message}, 原始: ${result.body}`);
      return null;
    }
  }
  
  console.error('');
  console.error(`  ❌ 轮询超时（${maxAttempts} 次尝试，${(totalElapsed / 1000).toFixed(1)}秒）`);
  return null;
}

// ============================================================
// 步骤 4：下载转写结果
// ============================================================
async function downloadTranscription(transcriptionUrl) {
  console.log('═══════════════════════════════════════════════');
  console.log('  步骤 4：下载转写结果');
  console.log('═══════════════════════════════════════════════');
  console.log(`  URL: ${transcriptionUrl}`);
  console.log('');
  
  const startTime = Date.now();
  
  let raw;
  try {
    raw = await httpsDownload(transcriptionUrl);
  } catch (err) {
    console.error(`  ❌ 下载失败: ${err.message}`);
    return null;
  }
  
  const elapsed = Date.now() - startTime;
  console.log(`  ✅ 下载成功 (${elapsed}ms, ${raw.length} bytes)`);
  console.log(`  原始内容: ${raw.toString('utf8').substring(0, 500)}`);
  console.log('');
  
  try {
    const json = JSON.parse(raw.toString('utf8'));
    
    // 提取文本
    let fullText = '';
    if (json.transcripts && Array.isArray(json.transcripts)) {
      for (const t of json.transcripts) {
        if (t.text) fullText += t.text;
      }
    }
    
    console.log(`  ✅ 解析成功！`);
    console.log(`  转写文本: "${fullText}"`);
    
    return { text: fullText, json };
  } catch (e) {
    console.error(`  ❌ 解析失败: ${e.message}`);
    return null;
  }
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  console.log('');
  console.log('█████████████████████████████████████████████████');
  console.log('  最小链路验证');
  console.log('  WebM/WAV → file.io → DashScope → 转写文本');
  console.log('█████████████████████████████████████████████████');
  console.log('');
  
  // 检查 API Key
  if (!DASHSCOPE_API_KEY) {
    console.error('❌ 未设置 DASHSCOPE_API_KEY 环境变量！');
    console.error('   请执行: set DASHSCOPE_API_KEY=sk-xxx');
    console.error('   然后重新运行此脚本。');
    process.exit(1);
  }
  console.log(`[DashScope] API Key: ${DASHSCOPE_API_KEY.substring(0, 8)}***`);
  console.log('');
  
  const overallStart = Date.now();
  
  // ── 生成测试音频 ──
  const audioBuffer = generateTestWav();
  
  // ── 上传 file.io ──
  const fileIOResult = await uploadToFileIO(audioBuffer);
  if (!fileIOResult) {
    console.error('验证失败：file.io 上传失败，中止。');
    process.exit(1);
  }
  
  // ── 创建 DashScope 任务 ──
  const taskResult = await createDashScopeTask(fileIOResult.url);
  if (!taskResult) {
    console.error('验证失败：DashScope 任务创建失败，中止。');
    process.exit(1);
  }
  
  // ── 轮询任务 ──
  const pollResult = await pollTask(taskResult.taskId);
  if (!pollResult || pollResult.status !== 'SUCCEEDED') {
    console.error('验证失败：ASR 任务未成功完成，中止。');
    process.exit(1);
  }
  
  // ── 下载转写结果 ──
  const transcription = await downloadTranscription(pollResult.transcriptionUrl);
  
  const overallElapsed = Date.now() - overallStart;
  
  // ============================================================
  // 最终报告
  // ============================================================
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('  验证结果汇总');
  console.log('═══════════════════════════════════════════════');
  console.log('');
  console.log(`  状态: ${transcription ? '✅ 成功' : '⚠️ 部分成功（转写下载失败）'}`);
  console.log(`  file.io URL: ${fileIOResult.url ? '***' + fileIOResult.url.slice(-12) : 'N/A'}`);
  console.log(`  DashScope task_id: ${taskResult.taskId}`);
  console.log(`  转写文本: "${transcription?.text || 'N/A'}"`);
  console.log(`  总耗时: ${(overallElapsed / 1000).toFixed(1)}秒`);
  console.log('');
  
  if (transcription) {
    console.log('  ✅ file.io → DashScope 全链路验证通过！');
    console.log('     file.io 适合作为免费临时文件中转服务。');
  }
  
  console.log('');
  
  // 清理测试文件
  try { fs.unlinkSync(TEST_AUDIO_FILE); console.log('  (已清理临时测试文件)'); } catch(e) {}
}

main().catch((e) => {
  console.error('未捕获异常:', e);
  // 清理
  try { fs.unlinkSync(TEST_AUDIO_FILE); } catch(e) {}
  process.exit(1);
});
