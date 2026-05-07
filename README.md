# Seedance Multi-Mode Studio

一个轻量的视频生成网页，支持 5 种调用方式：

- 文生视频 `text_to_video`
- 图生视频 `image_to_video`
- 多模态参考 `multi_reference`
- 样片生成成片 `draft_to_final`
- Grok Imagine Video `grok_imagine`

## 当前能力

- 支持 ephone `/v1/task/submit` 协议和 apiqik `/v1/videos` 协议
- 支持 ePhone 的 `grok-imagine-video/extensions` 异步视频生成接口，并保留 `grok-imagine-video/generations` 作为可选模型
- 轮询 `/v1/task/{task_id}`
- 展示 `queued / in_progress / completed / failed`
- 从本地电脑选择图片、音频、视频
- 后端自动上传素材到阿里云 OSS，再把公网 URL 传给模型
- 完成后在线播放与展示输出链接
- 自动保存生成历史到本地 `generated/task-history.json`，下次打开页面仍可查看输出链接

## 运行

```powershell
node server.js
```

浏览器打开：

[http://localhost:3000](http://localhost:3000)

## 环境变量

- `SEEDANCE_API_KEY`
- `SEEDANCE_BASE_URL`
- `SEEDANCE_DEFAULT_PROVIDER`
- `SEEDANCE_PROVIDER_EPHONE_API_KEY`
- `SEEDANCE_PROVIDER_EPHONE_BASE_URL`
- `SEEDANCE_PROVIDER_APIQIK_API_KEY`
- `SEEDANCE_PROVIDER_APIQIK_BASE_URL`
- `SEEDANCE_MODEL`
- `PORT`
- `POLL_INTERVAL_MS`
- `TASK_HISTORY_LIMIT`
- `ALLOWED_ORIGIN`
- `PUBLIC_BASE_URL`
- `OSS_REGION`
- `OSS_BUCKET`
- `OSS_ENDPOINT`
- `OSS_ACCESS_KEY_ID`
- `OSS_ACCESS_KEY_SECRET`
- `OSS_PATH_PREFIX`
- `OSS_PUBLIC_BASE_URL`

## 素材上传说明

- 如果配置了完整的 OSS 参数，素材会优先上传到阿里云 OSS。
- 如果没有配置 OSS，程序会退回本地 `/uploads/...` 链接。
- 公网读 Bucket 场景下，模型可以直接访问 OSS URL。

## 供应商协议

- `ephone`：使用 `/task/submit` 和 `/task/{id}` 这类异步任务接口。
- `apiqik`：使用 `/videos` 和 `/videos/{id}` 这类视频任务接口。
- 前端页面可以直接选择供应商，默认值由 `SEEDANCE_DEFAULT_PROVIDER` 决定。
- apiqik 默认优先显示 HappyHorse 模型，同时保留 `doubao-seedance-2-0-260128` 和 `doubao-seedance-2-0-fast-260128` 可选。
- Grok Imagine Video 固定使用 `ephone` 供应商，默认模型为 `grok-imagine-video/extensions`，同时保留 `grok-imagine-video/generations` 可选；支持仅 Prompt、图片素材或视频素材输入。

## 主要文件

- `server.js`：后端代理、素材上传、OSS 上传、参数校验、静态文件服务
- `public/index.html`：多模式页面结构
- `public/styles.css`：界面样式
- `public/app.js`：模式切换、文件上传、提交与轮询
