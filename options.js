const DEFAULT_AI_CONFIG = {
  providerPreset: "deepseek",
  endpoint: "https://api.deepseek.com/chat/completions",
  apiKey: "",
  model: "deepseek-chat",
  authHeader: "Authorization",
  authPrefix: "Bearer",
  extraHeaders: "{}",
  enableCache: true,
  enhanceMode: true,
  webSearch: false,
  requestTimeoutMs: 30000,
  retryCount: 2,
  retryDelayMs: 1200,
  questionSelector: '#ext-comp-1046 .tkItem, .tkItem, .ans-videoquiz, #ext-comp-1046, .TiMu, .newTiMu, .questionLi, .question, .quiz-question, .exam-question, [data-question], [class*="question-item"]',
  stemSelector: '.tkItem_tit, .tkItem_title, .videoquiz-title, .ans-videoquiz-title, .fontLabel, .Zy_TItle .clearfix, .newZy_TItle + .fontLabel, .question-title, .question-stem, .stem, .subject, [class*="question-title"]',
  optionSelector: '.ans-videoquiz-opt label, .ans-videoquiz-opt, .tkItem_ul li, [class*="before-after"], ul li .after, ul li textarea, ul textarea, ul li label:not(.before), .answerBg, label, .option, .answer-option, [class*="option-item"]',
  submitSelector: '#videoquiz-submit, .video-quiz-submit, .btnBlueSubmit, [onclick*="btnBlueSubmit"], button[type="submit"], .submit-answer, .btn-submit, [data-action="submit"]',
  systemPrompt: "你是严谨的课程答题助手。逐题独立推理并复核后作答。只返回合法 JSON，不要 Markdown，不要解释。选择题同时返回从 0 开始的 choices 索引和与选项原文完全一致的 choiceTexts；多空填空题（blanks>1）按空顺序返回 textAnswers 数组；其余文本题填写 textAnswer。"
};

const PROVIDER_PRESETS = {
  deepseek: {
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat"
  },
  dashscope: {
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: "qwen-plus"
  },
  zhipu: {
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4-flash"
  },
  moonshot: {
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    model: "moonshot-v1-8k"
  },
  siliconflow: {
    endpoint: "https://api.siliconflow.cn/v1/chat/completions",
    model: "Qwen/Qwen3-8B"
  },
  volcengine: {
    endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    model: "ep-请替换为推理接入点ID"
  }
};

const fieldIds = Object.keys(DEFAULT_AI_CONFIG);
const checkboxIds = fieldIds.filter((id) => typeof DEFAULT_AI_CONFIG[id] === "boolean");

function setStatus(message, isError = false) {
  const status = document.querySelector("#status");
  status.textContent = message;
  status.style.color = isError ? "#b42318" : "#4e5868";
}

function readForm() {
  return Object.fromEntries(fieldIds.map((id) => {
    const element = document.querySelector(`#${id}`);
    return [id, checkboxIds.includes(id) ? element.checked : element.value.trim()];
  }));
}

async function save() {
  const config = readForm();
  try { JSON.parse(config.extraHeaders || "{}"); } catch { throw new Error("附加请求头不是合法 JSON"); }
  const stored = await chrome.storage.local.get("aiConfig");
  await chrome.storage.local.set({ aiConfig: { ...(stored.aiConfig || {}), ...config } });
  return config;
}

async function initialize() {
  const stored = await chrome.storage.local.get("aiConfig");
  const saved = stored.aiConfig || {};
  let config = { ...DEFAULT_AI_CONFIG, ...saved };
  if (!saved.providerPreset) {
    const matched = Object.entries(PROVIDER_PRESETS).find(([, preset]) => preset.endpoint === config.endpoint);
    if (matched) {
      config.providerPreset = matched[0];
    } else if (!config.endpoint && !config.model) {
      config = { ...config, ...PROVIDER_PRESETS.deepseek, providerPreset: "deepseek" };
    } else {
      config.providerPreset = "custom";
    }
    await chrome.storage.local.set({ aiConfig: config });
  }
  for (const id of fieldIds) {
    const element = document.querySelector(`#${id}`);
    if (checkboxIds.includes(id)) element.checked = Boolean(config[id]);
    else element.value = config[id];
  }
}

document.querySelector("#providerPreset").addEventListener("change", (event) => {
  const preset = PROVIDER_PRESETS[event.target.value];
  if (!preset) return;
  document.querySelector("#endpoint").value = preset.endpoint;
  document.querySelector("#model").value = preset.model;
  document.querySelector("#authHeader").value = "Authorization";
  document.querySelector("#authPrefix").value = "Bearer";
  setStatus("已填入接口预设，请填写该平台的 API Key 后测试。");
});

for (const id of ["endpoint", "model", "authHeader", "authPrefix"]) {
  document.querySelector(`#${id}`).addEventListener("input", () => {
    const selected = document.querySelector("#providerPreset").value;
    const preset = PROVIDER_PRESETS[selected];
    if (!preset) return;
    const endpoint = document.querySelector("#endpoint").value.trim();
    const model = document.querySelector("#model").value.trim();
    if (endpoint !== preset.endpoint || model !== preset.model) {
      document.querySelector("#providerPreset").value = "custom";
    }
  });
}

document.querySelector("#save").addEventListener("click", async () => {
  try { await save(); setStatus("设置已保存。"); } catch (error) { setStatus(error.message, true); }
});

document.querySelector("#test").addEventListener("click", async () => {
  const button = document.querySelector("#test");
  button.disabled = true;
  setStatus("正在请求 AI…");
  try {
    await save();
    const response = await chrome.runtime.sendMessage({
      type: "AI_REQUEST",
      questions: [{ question: 0, type: "single", stem: "1 + 1 等于多少？", options: ["1", "2", "3"] }]
    });
    if (!response?.ok) throw new Error(response?.error || "接口没有响应");
    setStatus(`接口正常，测试答案：${JSON.stringify(response.answers)}`);
  } catch (error) {
    setStatus(`测试失败：${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#reloadExt").addEventListener("click", () => {
  setStatus("正在重载扩展…");
  chrome.runtime.reload();
});

initialize().catch((error) => setStatus(`读取设置失败：${error.message}`, true));
