# 个人管理系统

多功能个人管理工具，支持记账、阅读、日记、习惯打卡、日程安排，集成 AI 自然语言解析 + 飞书数据同步 + 语音输入。

## 技术栈

- 纯前端 SPA（`index.html`），无需构建
- Node.js 本地代理服务器（零依赖，内置模块）
- Chrome Web Speech API 语音识别
- 阿里云 DashScope AI 智能解析
- 飞书 Open API 云端同步

---

## 快速启动

### 1. 安装 Node.js

https://nodejs.org/ （需要 v18+）

### 2. 设置 DashScope API Key

```bash
# Windows PowerShell
$env:DASHSCOPE_API_KEY="sk-your-api-key-here"

# Windows CMD
set DASHSCOPE_API_KEY=sk-your-api-key-here

# macOS / Linux
export DASHSCOPE_API_KEY="sk-your-api-key-here"
```

申请地址：https://dashscope.console.aliyun.com/

### 3. 启动

```bash
npm start
# 或
node server.js
```

浏览器打开 `http://localhost:3000`

---

## 项目结构

```
.
├── index.html          # 前端主页面（SPA）
├── server.js           # 本地代理服务器
├── package.json        # 项目配置
├── 启动应用.bat         # Windows 一键启动脚本
├── .env.example        # 环境变量示例
└── .gitignore          # Git 忽略规则
```

### server.js 功能

| 路径 | 代理目标 | 说明 |
|------|---------|------|
| `/api/dashscope/*` | `dashscope.aliyuncs.com` | AI 调用，API Key 通过环境变量 `DASHSCOPE_API_KEY` 读取 |
| `/api/*` | `open.feishu.cn/open-apis` | 飞书 API，解决 CORS |
| `/` | 静态文件 | 服务 `index.html` 等 |

### 安全设计

- **`DASHSCOPE_API_KEY` 绝不硬编码**：通过 `process.env` 读取，`.env` 文件已加入 `.gitignore`
- **前端不接触 API Key**：localhost 模式下 `AIClient` 走 `/api/dashscope/` 代理，无需前端持有密钥

---

## 部署到 GitHub

### 安装 Git

如果未安装：https://git-scm.com/downloads

### 推送步骤

```bash
cd "D:\software\CodeBuddy CN\My app"

# 1. 初始化仓库
git init

# 2. 暂存所有文件
git add --all

# 3. 提交
git commit -m "feat: 个人管理系统 v1.0"

# 4. 关联远程仓库（先在 GitHub 创建新仓库，然后复制地址）
git remote add origin https://github.com/你的用户名/仓库名.git

# 5. 推送
git branch -M main
git push -u origin main
```

> **注意**：请先在 https://github.com/new 创建一个空仓库（不要勾选 README/.gitignore），然后替换第 4 步的地址。

---

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `DASHSCOPE_API_KEY` | 是 | 阿里云 DashScope API Key |

## License

MIT
