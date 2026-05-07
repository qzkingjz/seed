const form = document.querySelector("#generate-form");
const promptInput = document.querySelector("#prompt");
const presets = document.querySelector("#prompt-presets");
const modeSwitcher = document.querySelector("#mode-switcher");
const modeTitle = document.querySelector("#mode-title");
const modeDescription = document.querySelector("#mode-description");
const submitButton = document.querySelector("#submit-button");
const refreshButton = document.querySelector("#refresh-button");
const formMessage = document.querySelector("#form-message");
const heroModel = document.querySelector("#hero-model");
const heroPoll = document.querySelector("#hero-poll");
const assetTipText = document.querySelector("#asset-tip-text");

const modelInput = document.querySelector("#model");
const providerInput = document.querySelector("#provider");
const taskIdEl = document.querySelector("#task-id");
const taskStatusEl = document.querySelector("#task-status");
const taskModelEl = document.querySelector("#task-model");
const taskModeEl = document.querySelector("#task-mode");
const taskCreatedEl = document.querySelector("#task-created");
const resultJsonEl = document.querySelector("#result-json");
const outputListEl = document.querySelector("#output-list");
const player = document.querySelector("#video-player");
const placeholder = document.querySelector("#placeholder");

const modeMeta = {
  text_to_video: {
    title: "文生视频",
    description: "通过提示词直接生成完整视频任务。",
  },
  image_to_video: {
    title: "图生视频",
    description: "使用首帧图片驱动视频生成，可选尾帧做镜头收束。",
  },
  multi_reference: {
    title: "多模态参考",
    description: "混合图片、音频、视频参考，帮助模型更贴近目标风格。",
  },
  draft_to_final: {
    title: "样片生成成片",
    description: "基于草稿任务 ID 生成更高质量的正式成片。",
  },
};

const providerModels = {
  apiqik: {
    text_to_video: [
      "happyhorse-1.0-t2v",
      "doubao-seedance-2-0-260128",
      "doubao-seedance-2-0-fast-260128",
    ],
    image_to_video: [
      "happyhorse-1.0-i2v",
      "doubao-seedance-2-0-260128",
      "doubao-seedance-2-0-fast-260128",
    ],
    multi_reference: [
      "happyhorse-1.0-r2v",
      "doubao-seedance-2-0-260128",
      "doubao-seedance-2-0-fast-260128",
    ],
    draft_to_final: [
      "happyhorse-1.0-t2v",
      "doubao-seedance-2-0-260128",
      "doubao-seedance-2-0-fast-260128",
    ],
  },
  ephone: {
    text_to_video: ["doubao-seedance-2-0-260128", "doubao-seedance-2-0-fast-260128"],
    image_to_video: ["doubao-seedance-2-0-260128", "doubao-seedance-2-0-fast-260128"],
    multi_reference: ["doubao-seedance-2-0-260128", "doubao-seedance-2-0-fast-260128"],
    draft_to_final: ["doubao-seedance-2-0-260128", "doubao-seedance-2-0-fast-260128"],
  },
};

let currentMode = "text_to_video";
let currentTaskId = "";
let currentSubmittedModel = "";
let currentSubmittedMode = "";
let currentSubmittedProvider = "";
let pollTimer = null;
let pollIntervalMs = 3000;
let modelTouched = false;
let healthState = {
  assetBaseIsLocal: true,
  assetBaseUrl: "",
};

async function fetchJson(url, options = {}) {
  const init = { ...options };
  if (!(init.body instanceof FormData)) {
    init.headers = {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    };
  }

  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || "请求失败");
  }
  return data;
}

function formatUnixSeconds(value) {
  if (!value) {
    return "-";
  }
  return new Date(value * 1000).toLocaleString("zh-CN");
}

function setMessage(message, kind = "info") {
  formMessage.textContent = message;
  formMessage.dataset.kind = kind;
}

function setBusy(busy) {
  submitButton.disabled = busy;
  submitButton.textContent = busy ? "处理中..." : "提交生成任务";
}

function getTaskErrorMessage(task) {
  if (!task?.error) {
    return "";
  }
  if (typeof task.error === "string") {
    return task.error;
  }
  return task.error.message || task.error.code || JSON.stringify(task.error);
}

function prettifyErrorMessage(message) {
  if (!message) {
    return "请求失败";
  }

  if (/no available channels/i.test(message)) {
    return `当前 provider 没有这个模型的可用通道，请更换模型或切换 provider。\n原始错误: ${message}`;
  }

  if (/insufficient_quota/i.test(message)) {
    return `当前账户额度不足，暂时无法提交任务。\n原始错误: ${message}`;
  }

  return message;
}

function parseLineSeparatedUrls(value) {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getChecked(id) {
  return document.querySelector(`#${id}`).checked;
}

function getInputValue(id) {
  return document.querySelector(`#${id}`).value.trim();
}

function updateModeUI() {
  for (const chip of modeSwitcher.querySelectorAll(".mode-chip")) {
    chip.classList.toggle("active", chip.dataset.mode === currentMode);
  }

  modeTitle.textContent = modeMeta[currentMode].title;
  modeDescription.textContent = modeMeta[currentMode].description;

  for (const node of document.querySelectorAll(".mode-only")) {
    const allowed = (node.dataset.modes || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const visible = allowed.includes(currentMode);
    node.hidden = !visible;
    node.classList.toggle("is-hidden", !visible);
  }

  updateModelOptions();
}

function updateModelOptions() {
  const provider = providerInput?.value || "apiqik";
  const models = providerModels[provider]?.[currentMode] || providerModels.apiqik.text_to_video;
  const previous = modelInput.value;
  modelInput.innerHTML = "";

  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    modelInput.appendChild(option);
  }

  modelInput.value = models.includes(previous) ? previous : models[0];
}

function updateAssetTip() {
  if (healthState.assetBaseIsLocal) {
    assetTipText.textContent =
      "当前素材 URL 基于本地地址生成。你可以从电脑选择文件，但如果服务仅运行在 localhost，上游模型通常无法读取这些本地链接。若要稳定使用本地素材，建议把服务部署到公网并配置 PUBLIC_BASE_URL。";
  } else {
    assetTipText.textContent =
      `当前素材会暴露为 ${healthState.assetBaseUrl} 下的公开链接，可用于图生视频、多模态参考和样片工作流。`;
  }
}

function stopPolling() {
  if (pollTimer) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function resetOutputs() {
  outputListEl.innerHTML = "";
  player.hidden = true;
  player.removeAttribute("src");
  player.load();
  placeholder.hidden = false;
}

function renderOutputs(outputs = []) {
  outputListEl.innerHTML = "";
  if (!Array.isArray(outputs) || outputs.length === 0) {
    return;
  }

  const stack = document.createElement("div");
  stack.className = "output-stack";

  outputs.forEach((url, index) => {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.className = "output-link";
    link.textContent = `输出 ${index + 1}`;
    stack.appendChild(link);
  });

  outputListEl.appendChild(stack);

  const firstVideo = outputs.find((url) => /\.(mp4|webm|mov)(\?|$)/i.test(url)) || outputs[0];
  if (firstVideo) {
    player.src = firstVideo;
    player.hidden = false;
    placeholder.hidden = true;
  }
}

function updateTimeline(status) {
  for (const node of document.querySelectorAll(".timeline-step")) {
    node.classList.remove("active", "done", "error");

    if (status === "failed" && node.dataset.status === "failed") {
      node.classList.add("active", "error");
      continue;
    }

    if (node.dataset.status === status) {
      node.classList.add("active");
    }

    if (status === "in_progress" && node.dataset.status === "queued") {
      node.classList.add("done");
    }

    if (status === "completed" && ["queued", "in_progress", "completed"].includes(node.dataset.status)) {
      node.classList.add(node.dataset.status === "completed" ? "active" : "done");
    }
  }
}

function renderTask(task, submittedModel = currentSubmittedModel, submittedMode = currentSubmittedMode) {
  currentTaskId = task.id || currentTaskId;
  currentSubmittedModel = submittedModel || currentSubmittedModel;
  currentSubmittedMode = submittedMode || currentSubmittedMode;

  taskIdEl.textContent = currentTaskId || "等待提交";
  taskStatusEl.textContent = task.status || "idle";
  taskStatusEl.className = `status-pill ${task.status || "neutral"}`;
  taskModelEl.textContent = currentSubmittedModel || "-";
  taskModeEl.textContent = currentSubmittedMode ? modeMeta[currentSubmittedMode]?.title || currentSubmittedMode : "-";
  taskCreatedEl.textContent = formatUnixSeconds(task.created_at);

  resultJsonEl.textContent = JSON.stringify(
    {
      ...task,
      submitted_model: currentSubmittedModel || undefined,
      submitted_mode: currentSubmittedMode || undefined,
      submitted_provider: currentSubmittedProvider || undefined,
    },
    null,
    2,
  );

  updateTimeline(task.status);

  if (task.status === "completed") {
    renderOutputs(task.outputs);
    setMessage("任务已完成，可以预览或打开输出链接。", "success");
  } else if (task.status === "failed") {
    resetOutputs();
    setMessage(getTaskErrorMessage(task) || "任务失败，请调整参数后重试。", "error");
  } else if (task.status === "in_progress") {
    setMessage("视频生成中，正在自动轮询最新状态。", "info");
  } else if (task.status === "queued") {
    setMessage("任务已提交，正在等待处理。", "info");
  }
}

async function refreshTask() {
  if (!currentTaskId) {
    setMessage("还没有可刷新的任务。", "info");
    return;
  }

  try {
    const providerQuery = currentSubmittedProvider
      ? `?provider=${encodeURIComponent(currentSubmittedProvider)}`
      : "";
    const data = await fetchJson(`/api/tasks/${encodeURIComponent(currentTaskId)}${providerQuery}`);
    renderTask(data.task);

    if (["queued", "in_progress"].includes(data.task.status)) {
      stopPolling();
      pollTimer = window.setTimeout(refreshTask, pollIntervalMs);
    } else {
      stopPolling();
    }
  } catch (error) {
    stopPolling();
    setMessage(prettifyErrorMessage(error.message), "error");
  }
}

async function loadHealth() {
  try {
    const data = await fetchJson("/health");
    heroModel.textContent = data.model;
    heroPoll.textContent = `${Math.round(data.pollIntervalMs / 1000)}s`;
    pollIntervalMs = data.pollIntervalMs;
    healthState = {
      assetBaseIsLocal: data.assetBaseIsLocal,
      assetBaseUrl: data.assetBaseUrl,
    };

    const matchingOption = Array.from(modelInput.options).find((option) => option.value === data.model);
    if (matchingOption && !modelTouched) {
      modelInput.value = data.model;
    }
    if (data.defaultProvider && providerInput) {
      providerInput.value = data.defaultProvider;
    }
    updateAssetTip();
  } catch {
    heroModel.textContent = "不可用";
  }
}

async function uploadFiles(kind, fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) {
    return [];
  }

  const formData = new FormData();
  formData.append("kind", kind);
  files.forEach((file) => formData.append("files", file));

  const data = await fetchJson("/api/assets", {
    method: "POST",
    body: formData,
  });

  if (data.assetBaseIsLocal) {
    setMessage(
      "本地文件已经上传到当前服务，但如果服务只运行在 localhost，上游模型可能无法访问这些素材链接。",
      "info",
    );
  }

  return data.assets.map((asset) => asset.url);
}

async function resolveSingleAsset(fileInputId, urlInputId, kind, required = false) {
  const fileInput = document.querySelector(`#${fileInputId}`);
  const fileUrls = await uploadFiles(kind, fileInput.files);
  const typedUrl = getInputValue(urlInputId);
  const finalUrl = fileUrls[0] || typedUrl;

  if (required && !finalUrl) {
    throw new Error("请提供必填素材。");
  }

  return finalUrl;
}

async function buildPayload() {
  const payload = {
    mode: currentMode,
    provider: providerInput?.value || "apiqik",
    prompt: promptInput.value.trim(),
    model: modelInput.value,
    duration: Number.parseInt(getInputValue("duration"), 10),
    resolution: getInputValue("resolution"),
    aspect_ratio: getInputValue("aspect_ratio"),
    seed: Number.parseInt(getInputValue("seed"), 10),
    execution_expires_after: Number.parseInt(getInputValue("execution_expires_after"), 10),
    watermark: getChecked("watermark"),
  };

  const callbackUrl = getInputValue("callback_url");
  if (callbackUrl) {
    payload.callback_url = callbackUrl;
  }

  if (currentMode !== "draft_to_final") {
    payload.return_last_frame = getChecked("return_last_frame");
  }

  if (["text_to_video", "image_to_video", "multi_reference"].includes(currentMode)) {
    payload.draft = getChecked("draft");
  }

  if (currentMode === "text_to_video") {
    payload.web_search = getChecked("web_search");
    payload.generate_audio = getChecked("generate_audio");
  }

  if (currentMode === "image_to_video") {
    payload.camera_fixed = getChecked("camera_fixed");
    payload.generate_audio = getChecked("generate_audio");
    payload.first_frame = await resolveSingleAsset("first_frame_file", "first_frame_url", "image", true);
    payload.last_frame = await resolveSingleAsset("last_frame_file", "last_frame_url", "image", false);
  }

  if (currentMode === "multi_reference") {
    payload.generate_audio = getChecked("generate_audio");

    const imageUrls = parseLineSeparatedUrls(document.querySelector("#reference_images_urls").value);
    const audioUrls = parseLineSeparatedUrls(document.querySelector("#reference_audio_urls").value);
    const videoUrls = parseLineSeparatedUrls(document.querySelector("#reference_videos_urls").value);

    const localImageUrls = await uploadFiles("image", document.querySelector("#reference_images_files").files);
    const localAudioUrls = await uploadFiles("audio", document.querySelector("#reference_audio_files").files);
    const localVideoUrls = await uploadFiles("video", document.querySelector("#reference_videos_files").files);

    payload.reference_images = [...imageUrls, ...localImageUrls];
    payload.reference_audio = [...audioUrls, ...localAudioUrls];
    payload.reference_videos = [...videoUrls, ...localVideoUrls];

    if (
      payload.reference_images.length === 0 &&
      payload.reference_audio.length === 0 &&
      payload.reference_videos.length === 0
    ) {
      throw new Error("多模态参考模式至少需要一项参考图片、音频或视频。");
    }
  }

  if (currentMode === "draft_to_final") {
    payload.draft_task_id = getInputValue("draft_task_id");
    if (!payload.draft_task_id) {
      throw new Error("样片生成成片模式必须填写 Draft Task ID。");
    }
  }

  return payload;
}

modeSwitcher.addEventListener("click", (event) => {
  const button = event.target.closest(".mode-chip");
  if (!button) {
    return;
  }
  currentMode = button.dataset.mode;
  updateModeUI();
});

modelInput.addEventListener("change", () => {
  modelTouched = true;
});

providerInput?.addEventListener("change", () => {
  modelTouched = true;
  updateModelOptions();
});

presets.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-prompt]");
  if (!button) {
    return;
  }
  promptInput.value = button.dataset.prompt;
  promptInput.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  stopPolling();
  resetOutputs();
  setBusy(true);

  try {
    const payload = await buildPayload();
    setMessage(
      `正在提交任务，当前模式: ${modeMeta[payload.mode].title}，模型: ${payload.model} ...`,
      "info",
    );

    const data = await fetchJson("/api/tasks", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    currentSubmittedProvider = data.submittedProvider || payload.provider;
    renderTask(data.task, data.submittedModel, data.submittedMode);
    if (data.task.id) {
      currentTaskId = data.task.id;
      pollTimer = window.setTimeout(refreshTask, pollIntervalMs);
    }
  } catch (error) {
    setMessage(prettifyErrorMessage(error.message), "error");
  } finally {
    setBusy(false);
  }
});

refreshButton.addEventListener("click", refreshTask);

updateModeUI();
loadHealth();
