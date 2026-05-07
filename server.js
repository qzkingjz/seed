import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const uploadsDir = path.join(__dirname, "generated", "uploads");

class AppError extends Error {
  constructor(message, statusCode = 500, details = undefined) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

class ValidationError extends AppError {
  constructor(message, details = undefined) {
    super(message, 400, details);
    this.name = "ValidationError";
  }
}

class UpstreamError extends AppError {
  constructor(message, statusCode = 502, details = undefined) {
    super(message, statusCode, details);
    this.name = "UpstreamError";
  }
}

function log(level, message, meta = {}) {
  console.log(
    JSON.stringify({
      level,
      message,
      time: new Date().toISOString(),
      ...meta,
    }),
  );
}

async function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  const raw = await readFile(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const index = trimmed.indexOf("=");
    if (index === -1) {
      continue;
    }

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

await loadEnvFile(path.join(__dirname, ".env"));

function requireEnv(name, fallback = undefined) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const config = {
  apiKey: requireEnv("SEEDANCE_API_KEY"),
  baseUrl: requireEnv("SEEDANCE_BASE_URL").replace(/\/+$/, ""),
  model: requireEnv("SEEDANCE_MODEL", "doubao-seedance-2-0-260128"),
  defaultProvider: process.env.SEEDANCE_DEFAULT_PROVIDER || process.env.SEEDANCE_PROVIDER || "",
  submitPath: process.env.SEEDANCE_SUBMIT_PATH || "/task/submit",
  queryPathPrefix: process.env.SEEDANCE_QUERY_PATH_PREFIX || "/task/",
  chatCompletionsPath: process.env.SEEDANCE_CHAT_COMPLETIONS_PATH || "/chat/completions",
  port: Number.parseInt(process.env.PORT ?? "3000", 10),
  pollIntervalMs: Number.parseInt(process.env.POLL_INTERVAL_MS ?? "3000", 10),
  allowedOrigin: process.env.ALLOWED_ORIGIN ?? "",
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, ""),
  ossRegion: process.env.OSS_REGION ?? "",
  ossBucket: process.env.OSS_BUCKET ?? "",
  ossEndpoint: (process.env.OSS_ENDPOINT ?? "").replace(/\/+$/, ""),
  ossAccessKeyId: process.env.OSS_ACCESS_KEY_ID ?? "",
  ossAccessKeySecret: process.env.OSS_ACCESS_KEY_SECRET ?? "",
  ossPathPrefix: (process.env.OSS_PATH_PREFIX ?? "seedance-assets/").replace(/^\/+|\/+$/g, ""),
  ossPublicBaseUrl: (process.env.OSS_PUBLIC_BASE_URL ?? "").replace(/\/+$/, ""),
};

const ossEnabled = Boolean(
  config.ossBucket && config.ossEndpoint && config.ossAccessKeyId && config.ossAccessKeySecret,
);

const providerConfigs = {
  ephone: {
    id: "ephone",
    label: "ephone",
    type: "seedance_task",
    apiKey: process.env.SEEDANCE_PROVIDER_EPHONE_API_KEY || config.apiKey,
    baseUrl: (process.env.SEEDANCE_PROVIDER_EPHONE_BASE_URL || config.baseUrl).replace(/\/+$/, ""),
    submitPath: process.env.SEEDANCE_PROVIDER_EPHONE_SUBMIT_PATH || "/task/submit",
    queryPathPrefix: process.env.SEEDANCE_PROVIDER_EPHONE_QUERY_PATH_PREFIX || "/task/",
  },
  apiqik: {
    id: "apiqik",
    label: "apiqik",
    type: "apiqik_videos",
    apiKey: process.env.SEEDANCE_PROVIDER_APIQIK_API_KEY || config.apiKey,
    baseUrl: (process.env.SEEDANCE_PROVIDER_APIQIK_BASE_URL || config.baseUrl).replace(/\/+$/, ""),
    submitPath: process.env.SEEDANCE_PROVIDER_APIQIK_SUBMIT_PATH || "/videos",
    queryPathPrefix: process.env.SEEDANCE_PROVIDER_APIQIK_QUERY_PATH_PREFIX || "/videos/",
  },
};

const defaultProviderId =
  config.defaultProvider ||
  (config.baseUrl.includes("apiqik") ? "apiqik" : "ephone");

function getProvider(providerId = defaultProviderId) {
  const provider = providerConfigs[providerId];
  if (!provider) {
    throw new ValidationError(`provider must be one of: ${Object.keys(providerConfigs).join(", ")}`);
  }
  if (!provider.apiKey || !provider.baseUrl) {
    throw new ValidationError(`provider ${providerId} is missing api key or base url`);
  }
  return provider;
}

const modeDefinitions = {
  text_to_video: {
    label: "文生视频",
  },
  image_to_video: {
    label: "图生视频",
  },
  multi_reference: {
    label: "多模态参考",
  },
  draft_to_final: {
    label: "样片生成成片",
  },
};

const enumValues = {
  mode: Object.keys(modeDefinitions),
  resolution: ["480p", "720p", "1080p"],
  aspect_ratio: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"],
};

const uploadLimits = {
  image: { maxCount: 9, maxBytes: 30 * 1024 * 1024 },
  audio: { maxCount: 3, maxBytes: 15 * 1024 * 1024 },
  video: { maxCount: 3, maxBytes: 50 * 1024 * 1024 },
};

function createRequestId() {
  return crypto.randomUUID();
}

function sendJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function maybeSetCors(req, res) {
  if (!config.allowedOrigin) {
    return;
  }

  const origin = req.headers.origin;
  if (origin && origin === config.allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
}

function validateBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw new ValidationError(`${field} must be a boolean`);
  }
}

function validateInteger(value, field, { min, max } = {}) {
  if (!Number.isInteger(value)) {
    throw new ValidationError(`${field} must be an integer`);
  }
  if (min !== undefined && value < min) {
    throw new ValidationError(`${field} must be >= ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new ValidationError(`${field} must be <= ${max}`);
  }
}

function validateEnum(value, field, allowed) {
  if (!allowed.includes(value)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(", ")}`);
  }
}

function validateString(value, field, { required = false, maxLength } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new ValidationError(`${field} is required`);
    }
    return "";
  }

  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed && required) {
    throw new ValidationError(`${field} is required`);
  }

  if (maxLength !== undefined && trimmed.length > maxLength) {
    throw new ValidationError(`${field} must be ${maxLength} characters or less`);
  }

  return trimmed;
}

function validateUrlString(value, field) {
  const url = validateString(value, field, { required: true });
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new ValidationError(`${field} must be an http or https URL`);
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ValidationError(`${field} must be a valid URL`);
  }
}

function normalizeUrlArray(value, field) {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} must be an array of URLs`);
  }

  return value.map((item, index) => validateUrlString(item, `${field}[${index}]`));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ValidationError("Request body must be valid JSON", error.message);
  }
}

function toWebRequest(req) {
  const host = req.headers.host || `127.0.0.1:${config.port}`;
  const origin = `http://${host}`;
  const hasBody = !["GET", "HEAD"].includes(req.method ?? "GET");

  return new Request(new URL(req.url, origin), {
    method: req.method,
    headers: req.headers,
    body: hasBody ? req : undefined,
    duplex: hasBody ? "half" : undefined,
  });
}

function inferExtension(file) {
  const ext = path.extname(file.name || "").toLowerCase();
  if (ext) {
    return ext;
  }

  const lookup = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/mp4": ".m4a",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
  };

  return lookup[file.type] ?? "";
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function resolveOrigin(req) {
  if (ossEnabled) {
    return (
      config.ossPublicBaseUrl || `https://${config.ossBucket}.${new URL(config.ossEndpoint).host}`
    );
  }

  if (config.publicBaseUrl) {
    return config.publicBaseUrl;
  }

  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = typeof forwardedProto === "string" ? forwardedProto : "http";
  const host = req.headers.host || `127.0.0.1:${config.port}`;
  return `${protocol}://${host}`;
}

function isLocalOrigin(origin) {
  return /localhost|127\.0\.0\.1|\[::1\]/i.test(origin);
}

function buildOssObjectKey(kind, file) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const safeBase = sanitizeFilename(path.basename(file.name, path.extname(file.name))) || "asset";
  const extension = inferExtension(file);
  const prefix = config.ossPathPrefix ? `${config.ossPathPrefix}/` : "";
  return `${prefix}${kind}/${dateKey}/${safeBase}-${crypto.randomUUID()}${extension}`;
}

function buildCanonicalizedOssHeaders(headers = {}) {
  return Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), `${value}`.trim()])
    .filter(([key]) => key.startsWith("x-oss-"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value}\n`)
    .join("");
}

function signOssAuthorization({
  method,
  contentType,
  date,
  canonicalizedResource,
  ossHeaders = {},
}) {
  const canonicalizedOssHeaders = buildCanonicalizedOssHeaders(ossHeaders);
  const stringToSign = `${method}\n\n${contentType}\n${date}\n${canonicalizedOssHeaders}${canonicalizedResource}`;
  const signature = crypto
    .createHmac("sha1", config.ossAccessKeySecret)
    .update(stringToSign, "utf8")
    .digest("base64");

  return `OSS ${config.ossAccessKeyId}:${signature}`;
}

async function uploadFileToOss(file, kind) {
  const objectKey = buildOssObjectKey(kind, file);
  const contentType = file.type || "application/octet-stream";
  const date = new Date().toUTCString();
  const canonicalizedResource = `/${config.ossBucket}/${objectKey}`;
  const endpointHost = new URL(config.ossEndpoint).host;
  const bucketHost = `${config.ossBucket}.${endpointHost}`;
  const ossHeaders = {
    "x-oss-object-acl": "public-read",
  };
  const authorization = signOssAuthorization({
    method: "PUT",
    contentType,
    date,
    canonicalizedResource,
    ossHeaders,
  });

  const objectUrl = `https://${bucketHost}/${encodeURI(objectKey)}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const response = await fetch(objectUrl, {
    method: "PUT",
    headers: {
      Host: bucketHost,
      Date: date,
      "Content-Type": contentType,
      "Content-Length": String(buffer.byteLength),
      Authorization: authorization,
      ...ossHeaders,
    },
    body: buffer,
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new UpstreamError("Upload to OSS failed", response.status, raw);
  }

  const publicBaseUrl =
    config.ossPublicBaseUrl || `https://${bucketHost}`;

  return {
    name: file.name,
    size: file.size,
    type: contentType,
    url: `${publicBaseUrl}/${objectKey}`,
    relativePath: objectKey,
  };
}

async function saveUploadedFile(file, kind, req) {
  if (!(file instanceof File)) {
    throw new ValidationError("Uploaded item must be a file");
  }

  const limit = uploadLimits[kind];
  if (!limit) {
    throw new ValidationError("Unsupported upload kind");
  }

  if (file.size > limit.maxBytes) {
    throw new ValidationError(
      `${file.name} exceeds the size limit for ${kind} uploads (${Math.round(limit.maxBytes / 1024 / 1024)}MB)`,
    );
  }

  if (ossEnabled) {
    return uploadFileToOss(file, kind);
  }

  const dateKey = new Date().toISOString().slice(0, 10);
  const subDir = path.join(uploadsDir, kind, dateKey);
  await mkdir(subDir, { recursive: true });

  const safeBase = sanitizeFilename(path.basename(file.name, path.extname(file.name))) || "asset";
  const extension = inferExtension(file);
  const filename = `${safeBase}-${crypto.randomUUID()}${extension}`;
  const filePath = path.join(subDir, filename);
  const bytes = Buffer.from(await file.arrayBuffer());
  await writeFile(filePath, bytes);

  const relativePath = `/uploads/${kind}/${dateKey}/${filename}`;
  const origin = resolveOrigin(req);

  return {
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
    url: `${origin}${relativePath}`,
    relativePath,
  };
}

function buildTaskPayload(payload) {
  const mode = payload.mode ?? "text_to_video";
  validateEnum(mode, "mode", enumValues.mode);
  const providerId = payload.provider || defaultProviderId;

  const prompt = validateString(payload.prompt, "prompt", { required: true, maxLength: 500 });
  const model = validateString(payload.model, "model", { required: true }) || config.model;

  const input = {
    prompt,
    fps: 24,
  };

  if (payload.duration !== undefined) {
    validateInteger(payload.duration, "duration", { min: 4, max: 15 });
    input.duration = payload.duration;
  }

  if (payload.seed !== undefined) {
    validateInteger(payload.seed, "seed", { min: -1, max: 2147483647 });
    input.seed = payload.seed;
  }

  if (payload.execution_expires_after !== undefined) {
    validateInteger(payload.execution_expires_after, "execution_expires_after", { min: 60 });
    input.execution_expires_after = payload.execution_expires_after;
  }

  if (payload.resolution !== undefined) {
    validateEnum(payload.resolution, "resolution", enumValues.resolution);
    input.resolution = payload.resolution;
  }

  if (payload.aspect_ratio !== undefined) {
    validateEnum(payload.aspect_ratio, "aspect_ratio", enumValues.aspect_ratio);
    input.aspect_ratio = payload.aspect_ratio;
  }

  for (const key of ["draft", "watermark", "camera_fixed", "generate_audio", "return_last_frame"]) {
    if (payload[key] !== undefined) {
      validateBoolean(payload[key], key);
      input[key] = payload[key];
    }
  }

  if (mode === "text_to_video") {
    if (payload.web_search !== undefined) {
      validateBoolean(payload.web_search, "web_search");
      input.web_search = payload.web_search;
    }
  }

  if (mode === "image_to_video") {
    input.first_frame = validateUrlString(payload.first_frame, "first_frame");

    if (payload.last_frame) {
      input.last_frame = validateUrlString(payload.last_frame, "last_frame");
    }
  }

  if (mode === "multi_reference") {
    const referenceImages = normalizeUrlArray(payload.reference_images, "reference_images");
    const referenceAudio = normalizeUrlArray(payload.reference_audio, "reference_audio");
    const referenceVideos = normalizeUrlArray(payload.reference_videos, "reference_videos");

    if (providerId === "apiqik" && referenceImages.length === 0) {
      throw new ValidationError("apiqik HappyHorse reference mode requires at least one reference image");
    }

    if (
      referenceImages.length === 0 &&
      referenceAudio.length === 0 &&
      referenceVideos.length === 0
    ) {
      throw new ValidationError("At least one reference image, audio, or video is required");
    }

    if (referenceImages.length > 9) {
      throw new ValidationError("reference_images supports up to 9 items");
    }
    if (referenceAudio.length > 3) {
      throw new ValidationError("reference_audio supports up to 3 items");
    }
    if (referenceVideos.length > 3) {
      throw new ValidationError("reference_videos supports up to 3 items");
    }

    if (referenceImages.length > 0) {
      input.reference_images = referenceImages;
    }
    if (referenceAudio.length > 0) {
      input.reference_audio = referenceAudio;
    }
    if (referenceVideos.length > 0) {
      input.reference_videos = referenceVideos;
    }
  }

  if (mode === "draft_to_final") {
    input.draft_task_id = validateString(payload.draft_task_id, "draft_task_id", {
      required: true,
    });
  }

  return {
    mode,
    upstreamBody: {
      model,
      input,
      callback_url:
        typeof payload.callback_url === "string" && payload.callback_url.trim()
          ? payload.callback_url.trim()
          : undefined,
    },
  };
}

async function callSeedance(provider, endpoint, { method = "GET", body } = {}) {
  const response = await fetch(`${provider.baseUrl}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await response.text();
  let data;

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    const errorMessage = data?.error?.message || data?.message || "Upstream request failed";
    throw new UpstreamError(errorMessage, response.status, data);
  }

  return data;
}

function modeLabel(mode) {
  return modeDefinitions[mode]?.label || mode;
}

function summarizeInputForChat(input, mode) {
  const lines = [
    `调用模式: ${modeLabel(mode)}`,
    `视频提示词: ${input.prompt}`,
  ];

  const scalarFields = [
    "duration",
    "resolution",
    "aspect_ratio",
    "seed",
    "watermark",
    "draft",
    "web_search",
    "camera_fixed",
    "generate_audio",
    "return_last_frame",
    "execution_expires_after",
    "draft_task_id",
  ];

  for (const field of scalarFields) {
    if (input[field] !== undefined) {
      lines.push(`${field}: ${input[field]}`);
    }
  }

  if (input.first_frame) {
    lines.push(`first_frame: ${input.first_frame}`);
  }
  if (input.last_frame) {
    lines.push(`last_frame: ${input.last_frame}`);
  }
  if (input.reference_images?.length) {
    lines.push(`reference_images: ${input.reference_images.join(", ")}`);
  }
  if (input.reference_audio?.length) {
    lines.push(`reference_audio: ${input.reference_audio.join(", ")}`);
  }
  if (input.reference_videos?.length) {
    lines.push(`reference_videos: ${input.reference_videos.join(", ")}`);
  }

  return lines.join("\n");
}

function buildOpenAiChatPayload(upstreamBody, mode) {
  const content = [
    {
      type: "text",
      text: summarizeInputForChat(upstreamBody.input, mode),
    },
  ];

  for (const imageUrl of [
    upstreamBody.input.first_frame,
    upstreamBody.input.last_frame,
    ...(upstreamBody.input.reference_images || []),
  ].filter(Boolean)) {
    content.push({
      type: "image_url",
      image_url: {
        url: imageUrl,
      },
    });
  }

  return {
    model: upstreamBody.model,
    messages: [
      {
        role: "user",
        content,
      },
    ],
    stream: false,
  };
}

function extractChatContent(data) {
  const message = data?.choices?.[0]?.message;
  if (!message) {
    return JSON.stringify(data, null, 2);
  }

  if (typeof message.content === "string") {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => part.text || part.content || part?.image_url?.url || "")
      .filter(Boolean)
      .join("\n");
  }

  return JSON.stringify(message.content ?? data, null, 2);
}

function extractUrls(text) {
  return [...`${text}`.matchAll(/https?:\/\/[^\s"'<>）)]+/g)].map((match) => match[0]);
}

async function submitOpenAiChatTask(upstreamBody, mode) {
  const provider = getProvider("apiqik");
  const response = await callSeedance(provider, config.chatCompletionsPath, {
    method: "POST",
    body: buildOpenAiChatPayload(upstreamBody, mode),
  });
  const content = extractChatContent(response);
  const outputs = extractUrls(content);
  const now = Math.floor(Date.now() / 1000);

  return {
    id: response.id || `chatcmpl_${crypto.randomUUID()}`,
    status: "completed",
    created_at: response.created || now,
    completed_at: now,
    outputs,
    content,
    raw_response: response,
  };
}

function normalizeStatus(status) {
  const value = `${status || ""}`.toLowerCase();
  if (["success", "succeeded", "completed", "done"].includes(value)) {
    return "completed";
  }
  if (["running", "processing", "in_progress", "in-progress"].includes(value)) {
    return "in_progress";
  }
  if (["pending", "queued", "created", "submitted"].includes(value)) {
    return "queued";
  }
  if (["fail", "failed", "error"].includes(value)) {
    return "failed";
  }
  return value || "queued";
}

function normalizeTaskResponse(data) {
  const now = Math.floor(Date.now() / 1000);
  const outputCandidates = [
    data?.output,
    data?.outputs,
    data?.url,
    data?.video_url,
    data?.videoUrl,
    data?.result,
    data?.data?.output,
    data?.data?.outputs,
    data?.data?.url,
    data?.data?.video_url,
    data?.data?.videoUrl,
  ].flatMap((item) => (Array.isArray(item) ? item : item ? [item] : []));
  const outputs = [
    ...outputCandidates.filter((item) => typeof item === "string"),
    ...extractUrls(JSON.stringify(data)),
  ].filter((url, index, list) => list.indexOf(url) === index);

  return {
    ...data,
    id: data?.id || data?.task_id || data?.data?.id || data?.data?.task_id,
    status: normalizeStatus(data?.status || data?.data?.status),
    created_at: data?.created_at || data?.created || data?.data?.created_at || now,
    completed_at: data?.completed_at || data?.data?.completed_at,
    outputs,
    raw_response: data,
  };
}

function apiqikContentItem(type, url, role) {
  const urlKey = `${type}_url`;
  return {
    type: urlKey,
    [urlKey]: {
      url,
    },
    ...(role ? { role } : {}),
  };
}

function buildApiqikVideoPayload(upstreamBody, mode) {
  const input = upstreamBody.input;
  const resolution = `${input.resolution || "720p"}`.toUpperCase();
  const body = {
    model: upstreamBody.model,
    prompt: input.prompt,
    duration: input.duration || 5,
    size: input.aspect_ratio || "16:9",
    metadata: {
      resolution,
      watermark: input.watermark === true,
    },
  };

  if (Number.isInteger(input.seed) && input.seed >= 0) {
    body.metadata.seed = input.seed;
  }

  if (input.generate_audio === true) {
    body.generate_audio = true;
  }

  if (mode === "image_to_video") {
    body.image = input.first_frame;
    if (input.last_frame) {
      body.metadata.last_frame = input.last_frame;
    }
  }

  if (mode === "multi_reference") {
    body.images = input.reference_images || [];
    body.metadata.action = "referenceGenerate";
    if (input.reference_videos?.length) {
      body.metadata.reference_videos = input.reference_videos;
    }
    if (input.reference_audio?.length) {
      body.metadata.reference_audio = input.reference_audio;
    }
  }

  if (mode === "draft_to_final") {
    body.draft_task_id = input.draft_task_id;
  }

  return body;
}

async function submitApiqikVideoTask(provider, upstreamBody, mode) {
  const response = await callSeedance(provider, provider.submitPath, {
    method: "POST",
    body: buildApiqikVideoPayload(upstreamBody, mode),
  });
  return normalizeTaskResponse(response);
}

async function handleAssetUpload(req, res, requestId) {
  const request = toWebRequest(req);
  const formData = await request.formData();
  const kind = validateString(formData.get("kind"), "kind", { required: true });

  if (!(kind in uploadLimits)) {
    throw new ValidationError(`kind must be one of: ${Object.keys(uploadLimits).join(", ")}`);
  }

  const files = formData.getAll("files");
  if (files.length === 0) {
    throw new ValidationError("Please choose at least one local file");
  }

  if (files.length > uploadLimits[kind].maxCount) {
    throw new ValidationError(`${kind} uploads support up to ${uploadLimits[kind].maxCount} files`);
  }

  const assets = [];
  for (const file of files) {
    assets.push(await saveUploadedFile(file, kind, req));
  }

  const origin = resolveOrigin(req);
  return sendJson(res, 200, {
    assets,
    assetBaseUrl: origin,
    assetBaseIsLocal: isLocalOrigin(origin),
    requestId,
  });
}

async function handleApiRequest(req, res, requestId) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    const assetBaseUrl = resolveOrigin(req);
    return sendJson(res, 200, {
      ok: true,
      service: "seedance-web-studio",
      model: config.model,
      pollIntervalMs: config.pollIntervalMs,
      supportedModes: modeDefinitions,
      providers: Object.fromEntries(
        Object.values(providerConfigs).map((provider) => [
          provider.id,
          {
            label: provider.label,
            type: provider.type,
          },
        ]),
      ),
      defaultProvider: defaultProviderId,
      assetBaseUrl,
      assetBaseIsLocal: !ossEnabled && isLocalOrigin(assetBaseUrl),
      assetProvider: ossEnabled ? "oss" : "local",
    });
  }

  if (req.method === "POST" && url.pathname === "/api/assets") {
    return handleAssetUpload(req, res, requestId);
  }

  if (req.method === "POST" && url.pathname === "/api/tasks") {
    const payload = await readJson(req);
    const provider = getProvider(payload.provider);
    const { mode, upstreamBody } = buildTaskPayload(payload);

    log("info", "task_submit_forwarded", {
      requestId,
      provider: provider.id,
      providerType: provider.type,
      mode,
      model: upstreamBody.model,
      promptLength: upstreamBody.input.prompt.length,
    });

    const result =
      provider.type === "apiqik_videos"
        ? await submitApiqikVideoTask(provider, upstreamBody, mode)
        : await callSeedance(provider, provider.submitPath, {
            method: "POST",
            body: upstreamBody,
          });

    return sendJson(res, 200, {
      task: result,
      submittedModel: upstreamBody.model,
      submittedMode: mode,
      submittedProvider: provider.id,
      requestId,
    });
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === "GET" && taskMatch) {
    const provider = getProvider(url.searchParams.get("provider") || undefined);
    const taskId = decodeURIComponent(taskMatch[1]);
    if (!taskId) {
      throw new ValidationError("task id is required");
    }

    const result =
      provider.type === "apiqik_videos"
        ? normalizeTaskResponse(await callSeedance(provider, `${provider.queryPathPrefix}${encodeURIComponent(taskId)}`))
        : await callSeedance(provider, `${provider.queryPathPrefix}${encodeURIComponent(taskId)}`);
    return sendJson(res, 200, {
      task: result,
      submittedProvider: provider.id,
      requestId,
    });
  }

  throw new AppError("Not found", 404);
}

async function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType =
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".m4a": "audio/mp4",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mov": "video/quicktime",
      ".ico": "image/x-icon",
    }[ext] ?? "application/octet-stream";

  const file = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(file);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith("/uploads/")) {
    const uploadPath = path.join(uploadsDir, url.pathname.slice("/uploads/".length));
    if (!uploadPath.startsWith(uploadsDir)) {
      throw new AppError("Not found", 404);
    }
    return serveFile(res, uploadPath);
  }

  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.join(publicDir, pathname);
  if (!filePath.startsWith(publicDir)) {
    throw new AppError("Not found", 404);
  }

  return serveFile(res, filePath);
}

const server = createServer(async (req, res) => {
  const requestId = createRequestId();
  res.setHeader("X-Request-Id", requestId);
  setSecurityHeaders(res);
  maybeSetCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.url.startsWith("/api/") || req.url === "/health") {
      await handleApiRequest(req, res, requestId);
    } else {
      await serveStatic(req, res);
    }

    log("info", "request_complete", {
      requestId,
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
    });
  } catch (error) {
    const statusCode = error instanceof AppError ? error.statusCode : 500;
    const message = error instanceof AppError ? error.message : "Unexpected server error";
    const details = error instanceof AppError ? error.details : undefined;

    log("error", "request_failed", {
      requestId,
      method: req.method,
      url: req.url,
      statusCode,
      error: error.message,
      details,
    });

    sendJson(res, statusCode, {
      error: {
        message,
        details,
      },
      requestId,
    });
  }
});

server.listen(config.port, async () => {
  await mkdir(uploadsDir, { recursive: true });
  log("info", "server_started", {
    port: config.port,
    model: config.model,
    baseUrl: config.baseUrl,
    publicBaseUrl: config.publicBaseUrl || null,
    defaultProvider: defaultProviderId,
    ossEnabled,
    ossBucket: config.ossBucket || null,
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log("info", "shutdown_requested", { signal });
    server.close(() => {
      log("info", "server_closed", { signal });
      process.exit(0);
    });
  });
}
