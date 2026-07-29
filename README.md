# 昆虫标本图片识别与 Excel 录入工作台

> 本地单用户 Web 应用。上传昆虫标本图片,AI 视觉模型提取关键信息,用户确认后自动补全分类信息并写入 Excel 模板。

---

## 功能概览

| 模块 | 说明 |
|------|------|
| 识别工作台 | 上传图片 → AI 提取 5 个字段(中名、图像编号、产地3、采集人、采集日期)→ 用户确认 → 自动补全 8 个分类字段 → 写入数据库 |
| Excel 实时预览 | react-data-grid 虚拟滚动,13 字段 / 全部列切换,草稿行黄色高亮,完成行绿色高亮 |
| 记录管理 | 搜索 / 筛选 / 编辑 / 删除 / 重新分类 |
| Excel 导出 | 复制原模板,按行号写入已完成记录,采集日期 Excel 日期格式,图像编号文本格式 |
| 设置 | 模型 API 配置 + 连接测试 / 识别 & 分类提示词 / Excel 模板上传 + 字段映射 |

### 13 个目标字段

**图片原始信息(5 个,AI 提取):** 中名、图像、产地3、采集人、采集日期

**分类信息(8 个,AI 自动补全):** 纲、目、科、亚科、族、属、亚属、种本名

---

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Python 3.12+ / FastAPI 0.115.6 / SQLAlchemy 2.x / SQLite |
| 前端 | React 19 / TypeScript / Vite / Tailwind CSS / react-data-grid |
| AI | OpenAI 兼容多模态视觉模型(Base URL + API Key + 模型名) |
| 测试 | pytest(后端)/ Vitest + Testing Library(前端) |

---

## 环境要求

- **Python**: 3.12 或更高
- **Node.js**: 20 或更高
- **pnpm**: 9 或更高(`npm install -g pnpm`)
- **操作系统**: Windows / macOS / Linux

---

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/Ye-feng0510/insect-workbench.git
cd insect-workbench
```

### 2. Docker 启动(推荐)

只需安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/),无需配置 Python / Node.js 环境:

```bash
docker compose up -d --build
```

首次构建约 2-3 分钟(下载镜像 + 安装依赖 + 构建前端)。后续启动秒级完成。

启动后访问: **http://127.0.0.1:8000**

```bash
# 查看日志
docker compose logs -f

# 停止
docker compose down

# 重新构建(代码更新后)
docker compose up -d --build
```

> 数据持久化: 容器的 `data/` 目录映射到宿主机的 `./data/`,数据库、模板、图片、导出文件均保存在宿主机,容器删除后数据不丢失。

### 3. 脚本启动(无需 Docker)

**Windows:**

```cmd
scripts\start.bat
```

**Linux / macOS:**

```bash
chmod +x scripts/start.sh
./scripts/start.sh
```

脚本会自动完成:
1. 前端依赖安装 + 构建
2. 后端虚拟环境创建 + 依赖安装
3. 启动服务

启动后访问: **http://127.0.0.1:8000**

> 停止服务: 按 `Ctrl + C`

### 4. 手动启动(开发模式)

如果需要前后端独立运行(热更新),可分别启动:

**后端:**

```bash
cd backend
python -m venv venv
# Windows
venv\Scripts\python.exe -m pip install -r requirements.txt
venv\Scripts\python.exe -m uvicorn app.main:app --reload --app-dir backend
# Linux/macOS
source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --app-dir backend
```

后端运行在 http://127.0.0.1:8000

**前端:**

```bash
cd frontend
pnpm install
pnpm dev
```

前端运行在 http://localhost:5173(自动代理 `/api` 到后端)

---

## 使用流程

### 第一次使用

1. **配置模型 API** → 打开「设置」页面,填写 Base URL、API Key、模型名称,点击「测试连接」确认可用
2. **上传 Excel 模板** → 在设置页面上传你的 Excel 模板文件,系统自动检测字段映射,确认后保存
3. **开始识别** → 打开「识别工作台」,上传标本图片

### 日常使用

1. 在「识别工作台」上传图片
2. AI 提取 5 个字段,显示在右侧表单中
3. 核对并修改字段值(中名和图像编号为必填)
4. 点击「确认信息并自动入表」
5. 系统自动补全 8 个分类字段并写入数据库
6. 底部 Excel 预览实时更新
7. 需要导出时,打开「Excel 导出」页面,点击导出按钮下载文件

---

## 配置说明

### 环境变量

复制 `.env.example` 为 `.env`,按需修改:

```ini
# 后端服务(默认即可)
BACKEND_HOST=127.0.0.1
BACKEND_PORT=8000

# 模型调用超时(秒)
MODEL_TIMEOUT_SECONDS=120

# 图片预处理
IMAGE_MAX_LONG_EDGE=3000
IMAGE_JPEG_QUALITY=90
```

### 模型 API

需要 OpenAI 兼容的多模态视觉模型。支持的服务商:

- 智谱 GLM-4V 系列(`glm-4v-plus` 等)
- 阿里通义千问 VL 系列(`qwen-vl-plus` 等)
- OpenAI GPT-4o
- 其他兼容 OpenAI Chat Completions API 的服务

Base URL 填写到 API 根路径,如 `https://open.bigmodel.cn/api/paas/v4`。

---

## 数据存储

所有数据存储在项目根目录的 `data/` 文件夹:

```
data/
├── app.db              # SQLite 数据库(记录、设置、缓存)
├── templates/          # 上传的 Excel 模板副本
├── images/             # 原始上传图片
├── processed_images/   # 预处理后的图片(旋转/压缩)
└── exports/            # 导出的 Excel 文件
```

> `data/` 目录的内容不会提交到 Git。

---

## 运行测试

**后端:**

```bash
cd backend
venv\Scripts\python.exe -m pytest tests/ -v    # Windows
source venv/bin/activate && pytest tests/ -v    # Linux/macOS
```

**前端:**

```bash
cd frontend
pnpm test
```

**类型检查:**

```bash
cd frontend
pnpm exec tsc --noEmit
```

---

## 项目结构

```
insect-specimen-workbench/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI 入口
│   │   ├── config.py            # 配置(环境变量)
│   │   ├── database.py          # SQLite 引擎 + 初始化
│   │   ├── models.py            # 4 张表定义
│   │   ├── schemas.py           # Pydantic 模型
│   │   ├── field_mapping.py     # 中英文字段映射
│   │   ├── prompts/             # 默认提示词
│   │   ├── routers/             # API 路由(6 个模块)
│   │   └── services/            # 业务逻辑(5 个服务)
│   ├── tests/                   # 后端测试
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.tsx              # 路由
│   │   ├── main.tsx             # 入口
│   │   ├── components/          # 通用组件
│   │   ├── pages/               # 4 个页面
│   │   ├── services/            # API 封装
│   │   ├── types/               # TypeScript 类型
│   │   └── lib/                 # 工具函数
│   └── package.json
├── scripts/                     # 启动脚本
├── data/                        # 运行数据(gitignore)
└── .env.example
```

---

## 常见问题

**Q: 启动后页面显示"尚未配置 Excel 模板"?**

A: 这是正常的。请先打开「设置」页面上传 Excel 模板并保存字段映射。

**Q: 图片识别失败?**

A: 检查「设置」页面中的模型 API 配置是否正确,点击「测试连接」验证。确认 Base URL 格式正确(以 `/v1` 或 API 根路径结尾)。

**Q: 导出的 Excel 打不开或被占用?**

A: 关闭正在打开该文件的 Excel 程序后重试。

**Q: 支持哪些图片格式?**

A: JPG、JPEG、PNG、WebP。系统会自动处理 EXIF 方向并压缩到长边 3000px。

**Q: 数据库在哪?**

A: `data/app.db`,SQLite 文件。删除该文件可重置所有数据(需重新配置模型和模板)。
