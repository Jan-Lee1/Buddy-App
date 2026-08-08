/**
 * verify-speech-asr.js  — Phase 1 独立 ASR 验证脚本
 * 
 * 用途: 验证真实人类语音 → litterbox → DashScope v2 → transcription 全链路
 * 
 * 使用方法:
 *   node verify-speech-asr.js <webm文件路径>
 *   例: node verify-speech-asr.js test-recording.webm
 * 
 * 依赖:
 *   - 零 npm 依赖 (仅 Node.js 内置模块)
 *   - 环境变量 DASHSCOPE_API_KEY (或通过第二个参数传入)
 * 
 * 验证流程:
 *   [1] 读取 webm 文件
 *   [2] 上传到 litterbox.catbox.moe
 *   [3] 创建 DashScope Paraformer-v2 异步 ASR 任务
 *   [4] 轮询任务状态 (最多 60 秒)
 *   [5] 下载转写结果
 *   [6] 输出转写文本
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── 配置 ───
const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY || process.argv[3] || '';
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 30;
const TIMEOUT_MS = 30000;

// ─── 辅助函数 ───
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpsRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...opts, timeout: TIMEOUT_MS, family: 4 }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf.toString(), raw: buf });
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
    if (body) req.write(body);
    req.end();
  });
}

function httpGet(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      timeout: 15000,
      family: 4,
      headers: { 'User-Agent': 'ASR-Verify/1.0' },
    };
    https.get(opts, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    }).on('error', reject);
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDuration(seconds) {
  if (seconds < 1) return Math.round(seconds * 1000) + 'ms';
  if (seconds < 60) return seconds.toFixed(1) + 's';
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(0);
  return m + 'm ' + s + 's';
}

// ─── 主流程 ───
(async () => {
  const T0 = Date.now();

  // ── 参数检查 ──
  const audioPath = process.argv[2];
  if (!audioPath) {
    console.error('用法: node verify-speech-asr.js <webm文件路径> [API_KEY]');
    console.error('或通过环境变量: set DASHSCOPE_API_KEY=sk-xxx');
    console.error('示例: node verify-speech-asr.js test-recording.webm');
    process.exit(1);
  }

  if (!DASHSCOPE_KEY) {
    console.error('\n❌ 缺少 DASHSCOPE_API_KEY');
    console.error('   方式1: set DASHSCOPE_API_KEY=sk-xxx && node verify-speech-asr.js test.webm');
    console.error('   方式2: node verify-speech-asr.js test.webm sk-xxx');
    process.exit(1);
  }

  // ── 读取音频文件 ──
  console.log('═'.repeat(56));
  console.log('  ASR 全链路验证 — Phase 1');
  console.log('═'.repeat(56));

  const absPath = path.resolve(audioPath);
  if (!fs.existsSync(absPath)) {
    console.error(`\n❌ 文件不存在: ${absPath}`);
    process.exit(1);
  }

  const audioBuffer = fs.readFileSync(absPath);
  if (audioBuffer.length < 1024) {
    console.error(`\n❌ 音频文件太小 (${formatBytes(audioBuffer.length)}), 需要至少 1KB`);
    console.error('   请使用 record-test.html 录制至少 2 秒的语音');
    process.exit(1);
  }

  const ext = path.extname(absPath).toLowerCase();
  const mimeType = ext === '.webm' ? 'audio/webm'
    : ext === '.wav' ? 'audio/wav'
    : ext === '.mp3' ? 'audio/mpeg'
    : ext === '.ogg' ? 'audio/ogg'
    : 'audio/webm';

  console.log(`\n  📁 音频文件: ${path.basename(absPath)}`);
  console.log(`  📏 大小:      ${formatBytes(audioBuffer.length)}`);
  console.log(`  🎵 格式:      ${mimeType}`);

  try {
    // ══════ [步骤 1] 上传到 litterbox.catbox.moe ══════
    console.log(`\n── [1/5] 上传到 litterbox.catbox.moe ──`);

    const filename = 'asr-test-' + Date.now() + ext;
    const boundary = '----LB' + Date.now() + Math.random().toString(36).slice(2);
    const CR = '\r\n';

    const formBody = Buffer.concat([
      Buffer.from('--' + boundary + CR + 'Content-Disposition: form-data; name="reqtype"' + CR + CR + 'fileupload' + CR),
      Buffer.from('--' + boundary + CR + 'Content-Disposition: form-data; name="time"' + CR + CR + '1h' + CR),
      Buffer.from('--' + boundary + CR + 'Content-Disposition: form-data; name="fileToUpload"; filename="' + filename + '"' + CR + 'Content-Type: ' + mimeType + CR + CR),
      audioBuffer,
      Buffer.from(CR + '--' + boundary + '--' + CR),
    ]);

    const uploadResult = await httpsRequest(
      {
        hostname: 'litterbox.catbox.moe',
        path: '/resources/internals/api.php',
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': String(formBody.length),
          'User-Agent': 'ASR-Verify/1.0',
        },
      },
      formBody
    );

    if (uploadResult.status !== 200) {
      throw new Error('litterbox 上传失败: HTTP ' + uploadResult.status + ' — ' + uploadResult.body.substring(0, 200));
    }

    const fileUrl = uploadResult.body.trim();
    if (!fileUrl.startsWith('https://')) {
      throw new Error('litterbox 返回了无效的 URL: ' + fileUrl);
    }

    console.log(`  ✅ 上传成功`);
    console.log(`     URL: ${fileUrl}`);
    console.log(`     耗时: ${formatDuration((Date.now() - T0) / 1000)}`);

    // ══════ [步骤 2] 创建 DashScope v2 异步 ASR 任务 ══════
    console.log(`\n── [2/5] 创建 DashScope Paraformer-v2 ASR 任务 ──`);

    const taskResult = await httpsRequest(
      {
        hostname: 'dashscope.aliyuncs.com',
        path: '/api/v1/services/audio/asr/transcription',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + DASHSCOPE_KEY,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable',
        },
      },
      JSON.stringify({
        model: 'paraformer-v2',
        input: { file_urls: [fileUrl] },
      })
    );

    if (taskResult.status !== 200) {
      throw new Error('DashScope 任务创建失败: HTTP ' + taskResult.status + ' — ' + taskResult.body.substring(0, 500));
    }

    const taskData = JSON.parse(taskResult.body);
    const taskId = taskData?.output?.task_id;
    if (!taskId) {
      throw new Error('DashScope 未返回 task_id: ' + taskResult.body.substring(0, 500));
    }

    console.log(`  ✅ 任务已创建`);
    console.log(`     task_id: ${taskId}`);

    // ══════ [步骤 3] 轮询任务状态 ══════
    console.log(`\n── [3/5] 轮询任务状态 (每 ${POLL_INTERVAL_MS / 1000}s, 最多 ${MAX_POLL_ATTEMPTS} 次) ──`);

    let finalTaskData = null;
    let finishedStatus = '';
    let finishedCode = '';

    for (let i = 1; i <= MAX_POLL_ATTEMPTS; i++) {
      await sleep(POLL_INTERVAL_MS);

      const pollResult = await httpsRequest(
        {
          hostname: 'dashscope.aliyuncs.com',
          path: '/api/v1/tasks/' + taskId,
          method: 'GET',
          headers: { 'Authorization': 'Bearer ' + DASHSCOPE_KEY },
        }
      );

      if (pollResult.status !== 200) {
        throw new Error('轮询失败: HTTP ' + pollResult.status + ' — ' + pollResult.body.substring(0, 200));
      }

      const pollData = JSON.parse(pollResult.body);
      const status = pollData?.output?.task_status;
      const code = pollData?.output?.code || '';
      const elapsed = formatDuration((Date.now() - T0) / 1000);

      process.stdout.write(`  #${String(i).padStart(2)}  ${(status || 'UNKNOWN').padEnd(20)} ${elapsed.padStart(8)}`);

      if (status === 'PENDING') {
        process.stdout.write('  ⏳ 排队中\n');
      } else if (status === 'RUNNING') {
        process.stdout.write('  🔄 处理中\n');
      } else if (status === 'SUCCEEDED') {
        console.log('  ✅ 成功');
        finalTaskData = pollData;
        finishedStatus = 'SUCCEEDED';
        finishedCode = code;
        break;
      } else if (status === 'FAILED') {
        console.log(`  ❌ 失败 (code: ${code})`);
        finalTaskData = pollData;
        finishedStatus = 'FAILED';
        finishedCode = code;
        break;
      } else {
        process.stdout.write(`  未知状态: ${status}\n`);
      }
    }

    // ══════ [步骤 4] 检查结果 ══════
    console.log(`\n── [4/5] 检查 ASR 结果 ──`);

    if (!finalTaskData) {
      throw new Error('轮询超时: 任务在 ' + MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000 + 's 内未完成');
    }

    const output = finalTaskData.output || {};

    // CRITICAL: SUCCESS_WITH_NO_VALID_FRAGMENT 意味着 ASR 未检测到有效语音
    if (finishedStatus === 'FAILED') {
      // ── 失败分析 ──
      console.log('\n' + '═'.repeat(56));
      console.log('  ❌ ASR 任务失败');
      console.log('═'.repeat(56));
      console.log(`  状态:      ${finishedStatus}`);
      console.log(`  错误码:    ${finishedCode}`);
      console.log(`  错误消息:  ${output.message || '(无)'}`);
      console.log('─'.repeat(56));
      console.log('  诊断信息:');
      console.log(`  - 音频文件: ${path.basename(absPath)} (${formatBytes(audioBuffer.length)})`);
      console.log(`  - 格式:     ${mimeType}`);
      console.log(`  - 公网 URL: ${fileUrl}`);
      console.log(`  - task_id:  ${taskId}`);
      console.log('─'.repeat(56));

      if (finishedCode === 'SUCCESS_WITH_NO_VALID_FRAGMENT') {
        console.log('\n  ⚠️  SUCCESS_WITH_NO_VALID_FRAGMENT');
        console.log('      DashScope 成功下载并解码了音频，但未检测到有效语音。');
        console.log('      可能原因:');
        console.log('      1. 录制时麦克风未正常工作或音量过小');
        console.log('      2. webm codec 不兼容 (尝试 Chrome 录制)');
        console.log('      3. 音频过短 (建议至少 2 秒)');
        console.log('      4. 背景噪音过大');
        console.log('─'.repeat(56));
        console.log('\n  → 请检查录音质量并重新录制测试。');
        console.log('  → 用 record-test.html 在 Chrome 中录制一段清晰的语音。');
      }

      console.log('\n' + '═'.repeat(56));
      process.exit(1);
    }

    // ══════ [步骤 5] 下载并解析转写文本 ══════
    console.log(`\n── [5/5] 下载转写结果 ──`);

    // 尝试多种可能的 transcription_url 路径（DashScope 响应结构可能嵌套）
    let transcriptionUrl =
      output?.results?.transcription_url ||
      output?.results?.[0]?.output?.results?.[0]?.transcription_url ||
      output?.results?.[0]?.transcription_url;
    if (!transcriptionUrl) {
      console.log('  ⚠️  任务成功但未返回 transcription_url');
      console.log('  原始响应:');
      console.log(JSON.stringify(finalTaskData, null, 2).substring(0, 2000));
      process.exit(1);
    }

    console.log(`  📥 下载: ${transcriptionUrl}`);

    let transcriptionText = '';
    const transcriptionJson = await httpGet(transcriptionUrl);
    try {
      const parsed = JSON.parse(transcriptionJson);
      const transcripts = parsed?.transcripts || [];
      if (transcripts.length === 0) {
        transcriptionText = '';
      } else {
        transcriptionText = transcripts.map((t) => t.text || '').join(' ').trim();
      }
    } catch (e) {
      transcriptionText = transcriptionJson.trim();
    }

    const totalTime = (Date.now() - T0) / 1000;

    // ══════ 成功报告 ══════
    console.log('\n' + '═'.repeat(56));
    console.log('  ✅ 全链路验证通过！');
    console.log('═'.repeat(56));
    console.log('');
    console.log('  📋 转写文本:');
    console.log('  ' + '─'.repeat(50));
    if (transcriptionText) {
      console.log('  ' + transcriptionText);
    } else {
      console.log('  (转写结果为空 — 也许录音没有清晰语音)');
    }
    console.log('  ' + '─'.repeat(50));
    console.log('');
    console.log('  📊 统计:');
    console.log(`     音频大小:     ${formatBytes(audioBuffer.length)}`);
    console.log(`     总耗时:       ${formatDuration(totalTime)}`);
    console.log(`     转写字数:     ${transcriptionText.length}`);
    console.log(`     task_id:      ${taskId}`);
    console.log(`     litterbox URL: ${fileUrl}`);
    console.log('═'.repeat(56));
    console.log('');
    console.log('  🎯 Phase 1 验证通过！');
    console.log('  → 可以进入 Phase 2：修改 4 个生产文件');
    console.log('  → 待修改文件: server.js, api/transcribe.js, api/transcribe/status.js, index.html');
    console.log('');
    console.log('═'.repeat(56));

    process.exit(0);

  } catch (err) {
    console.error(`\n❌ 脚本级错误: ${err.message}`);
    console.error(err.stack?.split('\n').slice(1, 4).join('\n'));
    process.exit(1);
  }
})();
