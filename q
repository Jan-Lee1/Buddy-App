[1mdiff --git a/api/bitable/[...path].js b/api/bitable/[...path].js[m
[1mindex 6d48591..081dd85 100644[m
[1m--- a/api/bitable/[...path].js[m
[1m+++ b/api/bitable/[...path].js[m
[36m@@ -1,7 +1,6 @@[m
 /**[m
  * Vercel Serverless: 飞书 API 代理（catch-all）[m
[31m- * /api/* → open.feishu.cn/open-apis/*[m
[31m- * 注意：具体路由如 /api/transcribe, /api/dashscope/chat/completions, /api/feishu/token 优先于此 catch-all[m
[32m+[m[32m * /api/bitable/* → open.feishu.cn/open-apis/*[m
  */[m
 console.log("CATCH ALL API LOADED");[m
 const https = require('https');[m
[36m@@ -18,9 +17,26 @@[m [mmodule.exports = async function handler(req, res) {[m
   }[m
 [m
   try {[m
[31m-    // 从 Vercel 动态路由获取路径[m
[31m-    const pathSegments = req.query?.path;[m
[31m-    const apiPath = Array.isArray(pathSegments) ? '/' + pathSegments.join('/') : '/' + (pathSegments || '');[m
[32m+[m[32m    // 修复：正确提取路径参数[m
[32m+[m[32m    let apiPath = '';[m
[32m+[m[32m    if (req.query && req.query.path) {[m
[32m+[m[32m      const pathSegments = req.query.path;[m
[32m+[m[32m      apiPath = Array.isArray(pathSegments) ? pathSegments.join('/') : pathSegments;[m
[32m+[m[32m    } else {[m
[32m+[m[32m      const match = req.url.match(/^\/api\/bitable\/(.+?)(?:\?|$)/);[m
[32m+[m[32m      if (match) {[m
[32m+[m[32m        apiPath = match[1];[m
[32m+[m[32m      }[m
[32m+[m[32m    }[m
[32m+[m
[32m+[m[32m    if (!apiPath) {[m
[32m+[m[32m      res.status(400).json({ code: -1, msg: '缺少 API 路径' });[m
[32m+[m[32m      return;[m
[32m+[m[32m    }[m
[32m+[m
[32m+[m[32m    if (!apiPath.startsWith('/')) {[m
[32m+[m[32m      apiPath = '/' + apiPath;[m
[32m+[m[32m    }[m
     const targetPath = '/open-apis' + apiPath;[m
 [m
     // 处理原始 URL 的 query string[m
[36m@@ -28,7 +44,9 @@[m [mmodule.exports = async function handler(req, res) {[m
     const queryIdx = fullUrl.indexOf('?');[m
     const targetPathWithQuery = queryIdx !== -1 ? targetPath + fullUrl.substring(queryIdx) : targetPath;[m
 [m
[31m-    // 构建要转发的 headers（只保留必要 header，防止 Vercel 内部 header 泄漏）[m
[32m+[m[32m    console.log(`[Feishu Vercel] ${req.method} ${targetPathWithQuery}`);[m
[32m+[m
[32m+[m[32m    // 构建要转发的 headers[m
     const cleanHeaders = { 'host': FEISHU_HOST };[m
     if (req.headers['content-type']) cleanHeaders['content-type'] = req.headers['content-type'];[m
     if (req.headers['authorization']) cleanHeaders['authorization'] = req.headers['authorization'];[m
[36m@@ -51,8 +69,6 @@[m [mmodule.exports = async function handler(req, res) {[m
         timeout: 25000,[m
       };[m
 [m
[31m-      console.log(`[Feishu Vercel] ${req.method} ${targetPathWithQuery}`);[m
[31m-[m
       const proxyReq = https.request(options, (proxyRes) => {[m
         const chunks = [];[m
 [m
[36m@@ -62,7 +78,6 @@[m [mmodule.exports = async function handler(req, res) {[m
           const dataBuffer = Buffer.concat(chunks);[m
           console.log(`[Feishu Vercel] ${proxyRes.statusCode} (${dataBuffer.length} bytes)`);[m
 [m
[31m-          // 转发响应 headers（排除内部 headers）[m
           const resHeaders = {};[m
           for (const key of Object.keys(proxyRes.headers)) {[m
             const lower = key.toLowerCase();[m
[36m@@ -106,4 +121,4 @@[m [mmodule.exports = async function handler(req, res) {[m
   }[m
 };[m
 [m
[31m-module.exports.config = { api: { bodyParser: { sizeLimit: '1mb' } } };[m
[32m+[m[32mmodule.exports.config = { api: { bodyParser: { sizeLimit: '1mb' } } };[m
\ No newline at end of file[m
