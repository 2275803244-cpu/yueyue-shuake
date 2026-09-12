// ==UserScript==
// @name         玥玥刷客
// @namespace    https://github.com/2275803244-cpu/yueyue-shuake
// @version      3.8.0
// @description  网课学习助手：可拖动浮窗任务台，自动播放视频、阅读课件、切换下一节；接入 Chat Completions 格式的第三方 AI 接口自动答题（学习通章节测验/视频弹题适配，支持多空填空与富文本编辑器）。
// @author       yueyue
// @match        *://*.chaoxing.com/*
// @match        *://*.chaoxing.cn/*
// @match        *://*.xuexitong.com/*
// @match        *://*.zhihuishu.com/*
// @match        *://*.changjietong.com/*
// @match        *://*.yuketang.cn/*
// @match        *://*.rainclassroom.com/*
// @match        *://*.icve.com.cn/*
// @match        *://*.icourse163.org/*
// @match        *://*.icourse163.cn/*
// @match        *://*.xuexi.cn/*
// @match        *://*.gxt.hnvcp.com/*
// @match        *://*.nodedu.cn/*
// @match        *://*.sflep.com/*
// @match        *://*.cnki.net/*
// @match        *://*.mosoteach.cn/*
// @match        *://*.mtcsun.com/*
// @match        *://*.xuanyaedu.com/*
// @match        *://*.classin.cn/*
// @match        *://*.eelive.cn/*
// @match        *://*.edu.cn/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @connect      dashscope.aliyuncs.com
// @connect      open.bigmodel.cn
// @connect      api.moonshot.cn
// @connect      api.siliconflow.cn
// @connect      ark.cn-beijing.volces.com
// @connect      localhost
// @connect      127.0.0.1
// @license      MIT
// ==/UserScript==

(() => {
  if (globalThis.__YUEYUE_SHUAKE_ACTIVE__) return;
  globalThis.__YUEYUE_SHUAKE_ACTIVE__ = true;

  // 浮窗与自动任务只允许出现在网课站点；其他网站一律不注入面板、不扫任务
  const COURSE_SITE_PATTERN = /^(?:[a-z0-9-]+\.)*(?:chaoxing\.com|edu\.cn|xuexi\.cn|zhihuishu\.com|changjietong\.com|yuketang\.cn|rainclassroom\.com|icve\.com\.cn|icourse163\.org|icourse163\.cn|xuexitong\.com|gxt\.hnvcp\.com|nodedu\.cn|sflep\.com|cnki\.net|mosoteach\.cn|mtcsun\.com|xuanyaedu\.com|classin\.cn|eelive\.cn)(?::\d+)?$/i;
  const isCourseSite = () => {
    try { return COURSE_SITE_PATTERN.test(new URL(location.href).hostname); } catch { return false; }
  };
  if (!isCourseSite()) return;

  const IS_TOP = window === window.top;

  const DEFAULTS = {
    enabled: false, autoResume: true, autoReadDocuments: true, muted: true,
    playbackRate: 1, autoNext: true, skipCompleted: true,
    nextRetryCount: 3, nextRetryDelayMs: 1200, nextSelector: "",
    autoAnswer: false, autoSubmit: false
  };
  const DEFAULT_AI_CONFIG = {
    providerPreset: "deepseek",
    endpoint: "https://api.deepseek.com/chat/completions",
    apiKey: "", model: "deepseek-chat",
    authHeader: "Authorization", authPrefix: "Bearer",
    extraHeaders: "{}", enableCache: true, enhanceMode: true, webSearch: false,
    requestTimeoutMs: 30000, retryCount: 2, retryDelayMs: 1200,
    systemPrompt: "你是严谨的课程答题助手。逐题独立推理并复核后作答。只返回合法 JSON，不要 Markdown，不要解释。选择题同时返回从 0 开始的 choices 索引和与选项原文完全一致的 choiceTexts；多空填空题（blanks>1）按空顺序返回 textAnswers 数组；其余文本题填写 textAnswer。"
  };
  const PROVIDER_PRESETS = {
    deepseek: { endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-chat" },
    dashscope: { endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen-plus" },
    zhipu: { endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "glm-4-flash" },
    moonshot: { endpoint: "https://api.moonshot.cn/v1/chat/completions", model: "moonshot-v1-8k" },
    siliconflow: { endpoint: "https://api.siliconflow.cn/v1/chat/completions", model: "Qwen/Qwen3-8B" },
    volcengine: { endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions", model: "ep-请替换为推理接入点ID" }
  };
  const DEFAULT_AI_SELECTORS = {
    questionSelector: '#ext-comp-1046 .tkItem, .tkItem, .ans-videoquiz, #ext-comp-1046, .TiMu, .newTiMu, .questionLi, .question, .quiz-question, .exam-question, [data-question], [class*="question-item"]',
    stemSelector: '.tkItem_tit, .tkItem_title, .videoquiz-title, .ans-videoquiz-title, .fontLabel, .Zy_TItle .clearfix, .newZy_TItle + .fontLabel, .question-title, .question-stem, .stem, .subject, [class*="question-title"]',
    optionSelector: '.ans-videoquiz-opt label, .ans-videoquiz-opt, .tkItem_ul li, [class*="before-after"], ul li .after, ul li textarea, ul textarea, ul li label:not(.before), .answerBg, label, .option, .answer-option, [class*="option-item"]',
    submitSelector: '#videoquiz-submit, .video-quiz-submit, .btnBlueSubmit, [onclick*="btnBlueSubmit"], button[type="submit"], .submit-answer, .btn-submit, [data-action="submit"]'
  };
  const FALLBACK_NEXT_SELECTORS = [
    '[data-action="next"]', '[data-testid*="next"]', 'button[aria-label*="下一"]', 'a[aria-label*="下一"]',
    '.next-btn', '.btn-next', '.next-button', '.course-next', '.chapter-next'
  ];

  // ---------- 存储（GM 模拟 chrome.storage.local 语义） ----------
  const store = {
    get(key, fallback) {
      try { const value = GM_getValue(key, undefined); return value === undefined ? fallback : value; } catch { return fallback; }
    },
    set(key, value) { try { GM_setValue(key, value); } catch {} }
  };

  // 顶层会广播自己的 origin，iframe 用它拼存储键，保证与扩展版一致地“按站点”存取
  let siteOrigin = location.origin;
  let storageKey = `site:${siteOrigin}`;
  let settings = DEFAULTS;
  let aiConfigMerged = null;

  function buildAiConfig() {
    if (aiConfigMerged) return aiConfigMerged;
    const saved = store.get("aiConfig", {}) || {};
    const config = { ...DEFAULT_AI_CONFIG, ...DEFAULT_AI_SELECTORS, ...saved };
    const prepend = (required, current) => `${required}, ${current || ""}`.replace(/,\s*$/, "");
    config.questionSelector = prepend('#ext-comp-1046 .tkItem, .tkItem, #ext-comp-1046, .TiMu, .newTiMu, .questionLi', config.questionSelector);
    config.stemSelector = prepend('.tkItem_tit, .tkItem_title, .videoquiz-title, .fontLabel, .Zy_TItle .clearfix, .newZy_TItle + .fontLabel', config.stemSelector);
    config.optionSelector = prepend('.ans-videoquiz-opt label, .ans-videoquiz-opt, .tkItem_ul li, [class*="before-after"], ul li .after, ul li label:not(.before), .answerBg', config.optionSelector);
    config.submitSelector = prepend('#videoquiz-submit, .ans-videoquiz-submit, .btnBlueSubmit, [onclick*="btnBlueSubmit"]', config.submitSelector);
    aiConfigMerged = config;
    return config;
  }
  function invalidateAiConfig() { aiConfigMerged = null; }

  async function loadSettings() {
    if (!IS_TOP) {
      const tabOrigin = store.get("yyTabOrigin", "");
      if (tabOrigin && tabOrigin !== siteOrigin) {
        siteOrigin = tabOrigin;
        storageKey = `site:${siteOrigin}`;
      }
    }
    settings = { ...DEFAULTS, ...(store.get(storageKey, {}) || {}) };
    return settings;
  }
  async function saveSettings(patch) {
    settings = { ...settings, ...patch };
    store.set(storageKey, settings);
    broadcast({ type: "yy-settings", settings });
  }

  // ---------- 跨 frame 通信（postMessage 模拟扩展消息） ----------
  const frameStatuses = new Map();
  const quizHeartbeats = new Map();
  let frameSeq = 0;
  const frameId = `${IS_TOP ? "top" : "frame"}:${++frameSeq}:${Math.random().toString(36).slice(2, 7)}`;

  function postUp(message) {
    let target = window.parent;
    let depth = 0;
    while (target && depth < 10) {
      try { target.postMessage({ ...message, __yueyue: true, source: frameId }, "*"); } catch {}
      if (target === window.top) break;
      target = target.parent;
      depth += 1;
    }
  }
  function broadcast(message) {
    for (const frame of document.querySelectorAll("iframe")) {
      try { frame.contentWindow.postMessage({ ...message, __yueyue: true, source: frameId }, "*"); } catch {}
    }
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.__yueyue !== true || data.source === frameId) return;
    switch (data.type) {
      case "yy-tab-origin":
        if (data.origin && data.origin !== siteOrigin) { siteOrigin = data.origin; storageKey = `site:${siteOrigin}`; loadSettings(); }
        break;
      case "yy-ai-config-changed":
        invalidateAiConfig();
        break;
      case "yy-settings":
        settings = { ...DEFAULTS, ...data.settings };
        if (IS_TOP) renderFloatingSettings();
        break;
      case "yy-status":
        if (IS_TOP) {
          frameStatuses.set(data.source, { status: data.status, at: Date.now() });
          renderFloatingStatus(aggregateStatuses());
        } else {
          broadcast(data);
        }
        break;
      case "yy-quiz-heartbeat":
        if (IS_TOP) quizHeartbeats.set(data.source, { active: data.active, at: Date.now() });
        break;
      case "yy-answer-now":
        answerQuestions(true, true).then((result) => postUp({ type: "yy-answer-result", result }));
        if (!IS_TOP) broadcast({ type: "yy-answer-now" });
        break;
      case "yy-answer-result":
        if (IS_TOP) noteAnswerResult(data.result);
        else postUp({ type: "yy-answer-result", result: data.result });
        break;
      case "yy-diagnose":
        buildDiagnosis().then((diagnosis) => postUp({ type: "yy-diagnosis", diagnosis }));
        if (!IS_TOP) broadcast({ type: "yy-diagnose" });
        break;
      case "yy-diagnosis":
        if (IS_TOP) noteDiagnosis(data.source, data.diagnosis);
        else postUp({ type: "yy-diagnosis", source: data.source, diagnosis: data.diagnosis });
        break;
      case "yy-next":
        if (IS_TOP) goNext();
        break;
    }
  });

  function hasActiveVideoQuiz() {
    if (hasVisibleVideoQuizLocal()) return true;
    const now = Date.now();
    let active = false;
    for (const [key, beat] of quizHeartbeats) {
      if (now - beat.at > 8000) quizHeartbeats.delete(key);
      else if (beat.active) active = true;
    }
    return active;
  }
  function reportQuizState(active) {
    postUp({ type: "yy-quiz-heartbeat", active });
    if (!IS_TOP) broadcast({ type: "yy-quiz-heartbeat-relay", active });
  }

  // ---------- AI 请求（GM_xmlhttpRequest 直发） ----------
  function gmRequest(endpoint, headers, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST", url: endpoint, headers, data: body, timeout: timeoutMs,
        onload: (res) => resolve({ status: res.status, text: res.responseText }),
        onerror: () => reject(new Error("网络错误（跨域或断网）")),
        ontimeout: () => { const error = new Error(`AI 请求超过 ${Math.round(timeoutMs / 1000)} 秒`); error.name = "AbortError"; reject(error); }
      });
    });
  }

  function hashText(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36);
  }
  function extractContent(data) {
    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.output_text;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((item) => item?.text || item?.content || "").join("");
    throw new Error("AI 响应中没有找到文本内容");
  }
  function parseJsonReply(content) {
    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { return JSON.parse(cleaned); } catch {
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
      throw new Error("AI 没有返回可解析的 JSON");
    }
  }
  function answerSchemaRules() {
    return '严格输出：{"answers":[{"question":0,"choices":[0],"choiceTexts":["选项原文"],"textAnswers":[""],"textAnswer":""}]}。选择题必须同时给出 choices 和 choiceTexts，并确保二者指向同一选项；多空填空题（题目带 blanks 数量）必须在 textAnswers 数组里按空顺序逐空给出答案，禁止把多个空的答案用顿号、斜杠合并进一个字符串；单空文本题填写 textAnswer。判断题将“对/正确/True/√”视为正确，将“错/错误/False/×”视为错误。否定题特别规则：题干含“不属于/不包括/不是/不正确/错误的是/无关的是/不必需”等否定词时，先逐项判断该项是否符合肯定表述，再选出唯一不符合的那一项，严禁把“最典型/最核心”的肯定项当答案。';
  }

  function webSearchHint() {
    return "你已启用联网搜索。作答前优先检索在线题库（百度题库、学科网、学习通/超星题目库、百科等）：能检索到原题时直接采用题库标准答案；检索不到时再自行推理。题面文字可能被课程平台的反爬字体混淆成生僻乱码，把乱码字符当作被替换的占位字，只取可读关键词、数字和标准号（如 ISO 10791、PLC、24）组句搜索。";
  }

  function webSearchParams(config) {
    if (config.webSearch === false) return {};
    const endpoint = config.endpoint || "";
    if (endpoint.includes("bigmodel.cn")) {
      return { tools: [{ type: "web_search", web_search: { enable: true, search_result: true } }] };
    }
    if (endpoint.includes("moonshot.cn")) {
      return { tools: [{ type: "builtin_function", builtin_function: { name: "$web_search" } }] };
    }
    if (endpoint.includes("dashscope.aliyuncs.com")) {
      return { enable_search: true };
    }
    return {};
  }

  async function chatCompletion(config, headers, messages) {
    const maxAttempts = Math.max(1, Math.min(6, Number(config.retryCount ?? 2) + 1));
    const timeoutMs = Math.max(5000, Math.min(180000, Number(config.requestTimeoutMs || 30000)));
    const retryDelayMs = Math.max(200, Math.min(10000, Number(config.retryDelayMs || 1200)));
    const search = webSearchParams(config);
    const body = JSON.stringify({
      model: config.model,
      temperature: 0.1,
      messages,
      ...(search.tools ? { tools: search.tools } : {}),
      ...(search.enable_search ? { enable_search: true } : {})
    });
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const res = await gmRequest(config.endpoint, headers, body, timeoutMs);
        let data;
        try { data = JSON.parse(res.text); } catch { data = null; }
        if (res.status < 200 || res.status >= 300) {
          const detail = data?.error?.message || data?.message || res.text.slice(0, 300) || res.status;
          const error = new Error(`AI 接口返回 ${res.status}：${detail}`);
          error.retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
          throw error;
        }
        return parseJsonReply(extractContent(data));
      } catch (error) {
        lastError = error;
        const retryable = error?.name === "AbortError" || error?.retryable !== false;
        if (!retryable || attempt >= maxAttempts) break;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
    throw lastError || new Error("AI 请求失败");
  }

  async function requestAnswers(questions) {
    const config = buildAiConfig();
    if (!config.endpoint || !config.model) throw new Error("请先在浮窗“AI 设置”中填写接口地址和模型");
    const enhanceMode = config.enhanceMode !== false;
    // v5：否定题规则上线，旧版本缓存（含“章节测验”等垃圾答案）全部换键作废
    const cacheKey = hashText(JSON.stringify({ v: 5, model: config.model, systemPrompt: config.systemPrompt || "", enhanceMode, webSearch: config.webSearch !== false, questions }));
    const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    if (config.enableCache !== false) {
      const cache = store.get("answerCache", {}) || {};
      const cached = cache[cacheKey];
      if (cached?.answers && Array.isArray(cached.answers) && Date.now() - (cached.at || 0) < CACHE_TTL_MS) {
        return { answers: cached.answers, cached: true, attempts: 0 };
      }
    }
    let endpoint;
    try { endpoint = new URL(config.endpoint).toString(); } catch { throw new Error("AI 接口地址不是有效 URL"); }
    let extraHeaders;
    try { extraHeaders = JSON.parse(config.extraHeaders || "{}"); } catch { throw new Error("附加请求头必须是合法 JSON 对象"); }
    const headers = { "Content-Type": "application/json", ...extraHeaders };
    if (config.apiKey && config.authHeader) headers[config.authHeader] = `${config.authPrefix ? `${config.authPrefix} ` : ""}${config.apiKey}`;

    const schemaRules = answerSchemaRules();
    const searchHint = config.webSearch === false ? "" : webSearchHint();
    let answers;
    let attempts = 0;
    const pickAnswer = (parsed, questionIndex) => {
      if (!parsed || !Array.isArray(parsed.answers)) throw new Error("AI 返回 JSON 缺少 answers 数组");
      return parsed.answers.find((item) => Number(item?.question) === questionIndex) || parsed.answers[0] || null;
    };

    // 答案是否真正可用：选择题要有 choices；文本题 textAnswers/textAnswer 至少一个非空
    const answerIsUsable = (question, answer) => {
      if (!answer) return false;
      if (question.type === "text") {
        const joined = (Array.isArray(answer.textAnswers) ? answer.textAnswers.join("") : "") + String(answer.textAnswer || "");
        if (!joined.trim()) return false;
        // 页面标题/导航文案被模型当答案抄回来的，一律视为未答（会触发补问重取）
        if (/^(?:章节|单元|课后|随堂|期中期末)(?:测验|测试|作业|考试|习题)\s*\d*$/.test(joined.trim())) return false;
        return true;
      }
      return Array.isArray(answer.choices) && answer.choices.length > 0;
    };

    // 模型不一定按 schema 把文本答案写进 textAnswer/textAnswers：从常见杂牌字段里捞回来
    const harvestTextAnswer = (question, answer) => {
      if (!answer || question.type !== "text") return answer;
      const joined = (Array.isArray(answer.textAnswers) ? answer.textAnswers.join("") : "") + String(answer.textAnswer || "");
      if (joined.trim()) return answer;
      const blanks = Number(question.blanks || 1) || 1;
      for (const key of ["answer", "answers", "text", "content", "result", "答案"]) {
        const raw = answer[key];
        if (typeof raw === "string" && raw.trim()) return { ...answer, textAnswer: raw };
        if (Array.isArray(raw) && raw.length) {
          const parts = raw.map((item) => (typeof item === "string" ? item : String(item?.answer ?? item?.text ?? ""))).filter((item) => item.trim());
          if (!parts.length) continue;
          if (blanks > 1 && parts.length === blanks) return { ...answer, textAnswers: parts };
          return { ...answer, textAnswer: parts.join("和") };
        }
      }
      return answer;
    };

    // 模型偶尔会漏答某道文本题（返回空串）：把这些题单独再问一次，用补问结果覆盖
    const retryUnanswered = async (questions, answers) => {
      const answersByIndex = new Map(answers.map((item) => [Number(item?.question), item]).filter(([, item]) => item));
      const pending = [];
      questions.forEach((question, index) => {
        const existing = answersByIndex.get(index);
        // error 是请求循环接住的网络/解析错误，模型未必真答不了：值得再补问一次（不再豁免）
        if (!answerIsUsable(question, existing)) pending.push({ question, index });
      });
      if (!pending.length) return { answers, refilled: 0 };
      const retrySystem = `${config.systemPrompt || ""}\n${answerSchemaRules()}${searchHint}只输出 JSON，不要解释。以下题目上一轮没有作答（答案为空），这次必须每题给出非空答案。`;
      const results = await Promise.all(pending.map(async ({ question, index }) => {
        try {
          const parsed = await chatCompletion(config, headers, [
            { role: "system", content: retrySystem },
            {
              role: "user", content: `请回答这道题：\n${JSON.stringify({ ...question, question: index })}\n\n这道题是文本题（填空/简答），最终答案文本必须写入 textAnswer 字段且非空，禁止留空。答案措辞必须贴合题干空缺处的语法搭配，并优先采用题干或题目上下文中出现过的规范术语（例如空缺前是“实现……功能的核心执行机构”时，应填该机构的规范全称，而不是它的某个部件名）。`
            }
          ]);
          console.info(`[玥玥刷客] 空题补问 Q${index} 原始返回：`, JSON.stringify(parsed).slice(0, 400));
          const answer = harvestTextAnswer(question, pickAnswer(parsed, index));
          return answerIsUsable(question, answer) ? { ...answer, question: index } : null;
        } catch (error) {
          console.info(`[玥玥刷客] 空题补问 Q${index} 失败：`, error.message);
          return null;
        }
      }));
      const merged = answers.slice();
      let refilled = 0;
      pending.forEach(({ index }, position) => {
        const replacement = results[position];
        if (replacement) {
          const existing = merged.findIndex((item) => Number(item?.question) === index);
          if (existing >= 0) merged[existing] = replacement;
          else merged.push(replacement);
          refilled += 1;
        }
      });
      return { answers: merged, refilled };
    };

    if (!enhanceMode) {
      const parsed = await chatCompletion(config, headers, [
        { role: "system", content: `${config.systemPrompt || ""}\n${schemaRules}${searchHint}只依据题干与选项字面信息作答，不确定时选择最可能的选项。` },
        { role: "user", content: `请逐题回答并复核以下题目：\n${JSON.stringify(questions)}` }
      ]);
      attempts = 1;
      if (!Array.isArray(parsed.answers)) throw new Error("AI 返回 JSON 缺少 answers 数组");
      answers = parsed.answers;
    } else {
      const solveSystem = `${config.systemPrompt || ""}\n${schemaRules}${searchHint}只依据题干与选项字面信息作答，不确定时选择最可能的选项；多选题逐个选项独立判断，拿不准的选项不选；判断题警惕“都、一定、必须、所有”等绝对化表述。`;
      const verifySystem = `你是阅卷审核员。先独立解答题目，再与候选答案比对：一致就原样返回候选答案，不一致就返回你复核后的最终答案。题干含“不属于/不正确/不是”等否定词时必须用排除法复核：逐项标记“符合肯定表述”与“不符合”，最终答案只能是唯一“不符合”的那项，候选答案若选了最典型、最核心的肯定项，判定为错误并纠正。${schemaRules}只输出 JSON，不要解释。`;
      const results = new Array(questions.length).fill(null);
      let cursor = 0;
      const worker = async () => {
        while (cursor < questions.length) {
          const index = cursor;
          cursor += 1;
          try {
            const parsed = await chatCompletion(config, headers, [
              { role: "system", content: solveSystem },
              { role: "user", content: `请回答这道题：\n${JSON.stringify({ ...questions[index], question: index })}` }
            ]);
            attempts += 1;
            let answer = pickAnswer(parsed, index);
            if (answer) {
              try {
                const verified = pickAnswer(await chatCompletion(config, headers, [
                  { role: "system", content: verifySystem },
                  { role: "user", content: `题目：\n${JSON.stringify({ ...questions[index], question: index })}\n\n候选答案：\n${JSON.stringify(answer)}\n\n请独立复核并返回最终答案。` }
                ]), index);
                attempts += 1;
                if (verified) answer = verified;
              } catch {}
            }
            results[index] = answer ? { ...answer, question: index } : { question: index, error: "AI 没有返回这道题的答案" };
          } catch (error) {
            results[index] = { question: index, error: error.message };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, questions.length) }, worker));
      if (results.every((item) => !item || item.error)) throw new Error(results.find((item) => item?.error)?.error || "AI 请求失败");
      answers = results.filter(Boolean);
    }

    // 主轮答案先做一次形状归一：模型把答案写进杂牌字段时直接捞回，避免不必要的补问
    answers = answers.map((item) => {
      const question = questions[Number(item?.question)];
      return question && question.type === "text" ? harvestTextAnswer(question, item) : item;
    });

    ({ answers, refilled } = await retryUnanswered(questions, answers));
    if (refilled) console.info(`[玥玥刷客] 空答案补问：${refilled} 题重新作答`);

    if (config.enableCache !== false) {
      const cache = store.get("answerCache", {}) || {};
      cache[cacheKey] = { answers, model: config.model, at: Date.now() };
      const entries = Object.entries(cache).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0)).slice(0, 200);
      store.set("answerCache", Object.fromEntries(entries));
    }
    return { answers, cached: false, attempts };
  }

  // ---------- 工具与页面检测 ----------
  // ---------- 学习通 font-cxsecret 字体反混淆（模型无关的根治方案） ----------
  // 学习通会给题干/选项套上动态混淆字体：DOM 里的字符是“替身”乱码字，靠 @font-face 里的字形渲染出真实汉字。
  // 映射随页面加载随机变化，静态对照表不可靠；这里按 GlyphCopy(MIT) 的思路做动态字形识别：
  // 解析字体 cmap → 用 canvas 把乱码字符按混淆字体渲染成 28×28 点阵 → 与真字候选的点阵指纹比对 → 得到 乱码→真字 映射。
  // 只解码发给 AI 的文本（题干/选项原文），不改页面 DOM；映射按字体哈希缓存，同一字体只识别一次；
  // 单字置信度不足时保留原字，宁可少解也不错解。
  const CX_GRID_SIZE = 28;
  const CX_FINGERPRINT_TOP = 40;
  const CX_FINGERPRINT_ACCEPT = 0.72;
  const CX_MIN_CONFIDENCE = 0.6;
  const CX_MAX_OBSERVED_CHARS = 120;
  const CX_MAX_CANDIDATES = 900;
  const CX_MAX_STYLE_ELEMENTS = 5000;
  const CX_CACHE_PREFIX = "cxsecret:mapping:";
  const CX_ENSURE_THROTTLE_MS = 2000;
  const CX_DOMAIN_CANDIDATES = "数字系统采用可以将减法运算转化为加法原码反码补码真值逻辑电路门与或非异或同或输入输出编码译码器信号二进制十进制八进制十六进制位权权值基数进位借位小数整数无符号有符号机器数表示范围溢出校验奇偶校验格雷码BCD码ASCII码触发器状态方程次态现态初态波形图所示端时钟脉冲上升沿下降沿边沿电平同步异步置位复位清零保持翻转计数器寄存器移位全加器半加器比较器选择器多路选择器数据选择器函数表达式卡诺图化简最小项最大项约束项无关项组合逻辑时序逻辑";
  const CX_COMMON_CANDIDATES = "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严首底液官德随病苏失尔死讲配女黄推显谈罪神艺呢席含企望密批营项防举球英氧势告李台落木帮轮破亚师围注远字材排供河态封另施减树溶怎止案言士均武固叶鱼波视仅费紧爱左章早朝害续轻服试食充兵源判护司足某练差致板田降黑犯负击范继兴似余坚曲输修故城夫够送笔船占右财吃富春职觉汉画功巴跟虽杂飞检吸助升阳互初创抗考投坏策古径换未跑留钢曾端责站简述钱副尽帝射草冲承独令限阿宣环双请超微让控州良轴找否纪益依优顶础载倒房突坐粉敌略客袁冷胜绝析块剂测丝协诉念陈仍罗盐友洋错苦夜刑移频逐靠混母短皮终聚汽村云哪既距卫停烈央察烧迅境若印洲刻括激孔搞甚室待核校散侵吧甲游久菜味旧模湖货损预阻毫普稳乙妈植息扩银语挥酒守拿序纸医缺雨吗针刘啊急唱误训愿审附获茶鲜粮斤孩脱硫肥善龙演父渐血欢械掌歌沙刚攻谓盾讨晚粒乱燃矛乎杀药宁鲁贵钟煤读班伯香介迫句丰培握兰担弦蛋沉假穿执答乐谁顺烟缩征脸喜松脚困异免背星福买染井概慢怕磁倍祖皇促静补评翻肉践尼衣宽扬棉希伤操垂秋宜氢套督振架亮末宪庆编牛触映雷销诗座居抓裂胞呼娘景威绿晶厚盟衡鸡孙延危胶屋乡临陆顾掉呀灯岁措束耐剧玉赵跳哥季课凯胡额款绍卷齐伟蒸殖永宗苗川炉岩弱零杨奏沿露杆探滑镇饭浓航怀赶库夺伊灵税途灭赛归召鼓播盘裁险康唯录菌纯借糖盖横符私努堂域枪润幅哈竟熟虫泽脑壤碳欧遍侧寨敢彻虑斜薄庭纳弹饲伸折麦湿暗荷瓦塞床筑恶户访塔奇透梁刀旋迹卡氯遇份毒泥退洗摆灰彩卖耗夏择忙铜献硬予繁圈雪函亦抽篇阵阴丁尺追堆雄迎泛爸楼避谋吨野猪旗累偏典馆索秦脂潮爷豆忽托惊塑遗愈朱替纤粗倾尚痛楚谢奋购磨君池旁碎骨监捕弟暴割贯殊释词亡壁顿宝午尘闻揭炮残冬桥妇警综招吴付浮遭徐您摇谷赞箱隔订男吹园纷唐败宋玻巨耕坦荣闭湾键凡驻锅救恩剥凝碱齿截炼麻纺禁废盛版缓净睛昌婚涉筒嘴插岸朗庄街藏姑贸腐奴啦惯乘伙恢匀纱扎辩耳彪臣亿璃抵脉秀萨俄网舞店喷纵寸汗挂洪贺闪柬爆烯津稻墙软勇像滚厘蒙芳肯坡柱荡腿仪旅尾轧冰贡登黎削钻勒逃障氨郭峰币港伏轨亩毕擦莫刺浪秘援株健售股岛甘泡睡童铸汤阀休汇舍牧绕炸哲磷绩朋淡尖启陷柴呈徒颜泪稍忘泵蓝拖洞授镜辛壮锋贫虚弯摩泰幼廷尊窗纲弄隶疑氏宫姐震瑞怪尤琴循描膜违夹腰缘珠穷森枝竹沟催绳忆邦剩幸浆栏拥牙贮礼滤钠纹罢拍咱喊袖埃勤罚焦潜伍墨欲缝姓刊饱仿奖铝鬼丽跨默挖链扫喝袋炭污幕诸弧励梅奶洁灾舟鉴苯讼抱毁懂寒智埔寄届跃渡挑丹艰贝碰拔爹戴码梦芽熔赤渔哭敬颗奔铅仲虎稀妹乏珍申桌遵允隆螺仓魏锐晓氮兼隐碍赫拨忠肃缸牵抢博巧壳兄杜讯诚碧祥柯页巡矩悲灌龄伦票寻桂铺圣恐恰郑趣抬荒腾贴柔滴猛阔辆妻填撤储签闹扰紫砂递戏吊陶伐喂疗瓶婆抚臂摸忍虾蜡邻胸巩挤偶弃槽劲乳邓吉仁烂砖租乌舰伴瓜浅丙暂燥橡柳迷暖牌秧胆详簧踏瓷谱呆宾糊洛辉愤竞隙怒粘乃绪肩籍敏涂熙皆侦悬掘享纠醒狂锁淀恨牲霸爬赏逆玩陵祝秒浙貌役彼悉鸭趋凤晨畜辈秩卵署梯炎滩棋驱筛峡冒啥寿译浸泉帽迟硅疆贷漏稿冠嫩胁芯牢叛蚀奥鸣岭羊凭串塘绘酵融盆锡庙筹冻辅摄袭筋拒僚旱钾鸟漆沈眉疏添棒穗硝韩逼扭侨凉挺碗栽炒杯患馏劝豪辽勃鸿旦吏拜狗埋辊掩饮搬骂辞勾扣估蒋绒雾丈朵姆拟宇辑陕雕偿蓄崇剪倡厅咬驶薯刷斥番赋奉佛浇漫曼扇钙桃扶仔返俗亏腔鞋棱覆框悄叔撞骗勘旺沸孤吐孟渠屈疾妙惜仰狠胀谐抛霉桑岗嘛衰盗渗脏赖涌甜曹阅肌哩厉烃纬毅昨伪症煮叹钉搭茎笼酷偷弓锥恒杰坑鼻翼纶叙狱逮罐络棚抑膨蔬寺骤穆冶枯册尸凸绅坯牺焰轰欣晋瘦御锭锦丧旬锻垄搜扑邀亭酯迈舒脆酶闲忧酚顽羽涨卸仗陪辟惩杭姚肚捉飘漂昆欺吾郎烘汁呵饰萧雅邮迁燕撒姻赴宴烦债帐斑铃旨醇董饼雏姿拌傅腹妥揉贤拆歪葡胺丢浩徽昂垫挡览贪慰缴汪慌冯诺姜谊凶劣诬耀昏躺盈骑乔溪丛卢抹闷咨刮驾缆悟摘铒掷颇幻柄惠惨佳仇腊窝涤剑瞧堡泼葱罩霍捞胎苍滨俩捅湘砍霞邵萄疯淮遂熊粪烤宿档戈驳嫂裕徙箭捐肠撑晒辨殿莲摊搅酱屏疫哀蔡堵沫皱畅叠阁莱敲辖钩痕坝巷饿祸丘玄溜曰逻彭尝卿妨艇吞韦怨矮歇";
  let cxSecretMapping = null;
  let cxEnsurePromise = null;
  let cxEnsureLastAt = 0;
  let cxDictionaryPromise = null;

  
  async function cxStorageGet(key) {
    try { const value = store.get(key, undefined); return value === undefined ? null : value; } catch { return null; }
  }

  async function cxStorageSet(key, value) {
    try { store.set(key, value); } catch {}
  }


  function cxBase64ToBytes(text) {
    const clean = String(text || "").replace(/\s+/g, "");
    let length = clean.length;
    while (length > 0 && clean[length - 1] === "=") length -= 1;
    const bytes = new Uint8Array(Math.floor(length * 3 / 4));
    const decodeChar = (char) => {
      const code = char.charCodeAt(0);
      if (code >= 65 && code <= 90) return code - 65;
      if (code >= 97 && code <= 122) return code - 97 + 26;
      if (code >= 48 && code <= 57) return code - 48 + 52;
      if (char === "+") return 62;
      if (char === "/") return 63;
      return -1;
    };
    let buffer = 0;
    let bits = 0;
    let outIndex = 0;
    for (let index = 0; index < length; index += 1) {
      const value = decodeChar(clean[index]);
      if (value < 0) continue;
      buffer = (buffer << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        if (outIndex < bytes.length) bytes[outIndex] = (buffer >> bits) & 0xff;
        outIndex += 1;
      }
    }
    return bytes;
  }

  function cxDataUriToBytes(dataUri) {
    const commaIndex = dataUri.indexOf(",");
    if (commaIndex < 0) throw new Error("无效的字体 data URI");
    const meta = dataUri.slice(0, commaIndex);
    const data = dataUri.slice(commaIndex + 1);
    if (/;base64/i.test(meta)) return cxBase64ToBytes(data);
    // 非 base64 的 data URI 极少见，按百分号解码取 UTF-8 字节
    const decoded = decodeURIComponent(data);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index) & 0xff;
    return bytes;
  }

  async function cxHashBytes(bytes) {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const digest = await subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    // 无 crypto.subtle（测试环境/非安全上下文）时退化为确定性 FNV-1a，仅作缓存键
    let hash = 0x811c9dc5;
    for (let index = 0; index < bytes.length; index += 1) {
      hash ^= bytes[index];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fnv-${hash.toString(16)}-${bytes.length.toString(16)}`;
  }

  function cxSplitDeclarations(block) {
    // data URI 里就带分号，必须按括号深度切分声明，不能简单 split(";")
    const parts = [];
    let current = "";
    let quote = null;
    let depth = 0;
    for (const char of block || "") {
      if (quote) { current += char; if (char === quote) quote = null; continue; }
      if (char === "'" || char === "\"") { quote = char; current += char; continue; }
      if (char === "(") { depth += 1; current += char; continue; }
      if (char === ")") { depth = Math.max(0, depth - 1); current += char; continue; }
      if (char === ";" && depth === 0) { if (current.trim()) parts.push(current); current = ""; continue; }
      current += char;
    }
    if (current.trim()) parts.push(current);
    return parts;
  }

  function cxParseFontFaceCss(cssText) {
    const faces = [];
    const pattern = /@font-face\s*\{([\s\S]*?)\}/gi;
    let match;
    while ((match = pattern.exec(cssText || "")) !== null) {
      let family = "";
      let src = "";
      for (const part of cxSplitDeclarations(match[1])) {
        const colonIndex = part.indexOf(":");
        if (colonIndex <= 0) continue;
        const key = part.slice(0, colonIndex).trim().toLowerCase();
        const value = part.slice(colonIndex + 1).trim();
        if (key === "font-family" && !family) family = value.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
        if (key === "src" && !src) src = value;
      }
      const urlMatch = src.match(/url\(\s*(['"]?)(.*?)\1\s*\)/i);
      if (family && urlMatch) faces.push({ family, src: urlMatch[2] });
    }
    return faces;
  }

  function cxDiscoverFontFaces(doc) {
    const faces = [];
    try {
      for (const style of Array.from(doc.querySelectorAll("style"))) faces.push(...cxParseFontFaceCss(style.textContent || ""));
    } catch {}
    for (const sheet of Array.from(doc.styleSheets || [])) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; } // 跨域样式表会抛异常，跳过
      for (const rule of Array.from(rules || [])) {
        // CSSRule.FONT_FACE_RULE === 5
        if (rule.type === 5 || /^@font-face/i.test(rule.cssText || "")) faces.push(...cxParseFontFaceCss(rule.cssText || ""));
      }
    }
    const seen = new Set();
    return faces.filter((face) => {
      const key = `${face.family}\n${face.src}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function cxReadUInt16(bytes, offset) {
    return (bytes[offset] << 8) | bytes[offset + 1];
  }

  function cxReadInt16(bytes, offset) {
    const value = cxReadUInt16(bytes, offset);
    return value & 0x8000 ? value - 0x10000 : value;
  }

  function cxReadUInt32(bytes, offset) {
    return (((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]);
  }

  function cxFindSfntTable(bytes, tag) {
    if (bytes.byteLength < 12) return null;
    const tableCount = cxReadUInt16(bytes, 4);
    for (let index = 0; index < tableCount; index += 1) {
      const offset = 12 + index * 16;
      const tableTag = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
      if (tableTag === tag) return { offset: cxReadUInt32(bytes, offset + 8), length: cxReadUInt32(bytes, offset + 12) };
    }
    return null;
  }

  function cxParseCmapFormat4(bytes, offset) {
    const codePoints = new Set();
    const length = cxReadUInt16(bytes, offset + 2);
    const segCount = cxReadUInt16(bytes, offset + 6) / 2;
    const endCountOffset = offset + 14;
    const startCountOffset = endCountOffset + segCount * 2 + 2;
    const idDeltaOffset = startCountOffset + segCount * 2;
    const idRangeOffsetOffset = idDeltaOffset + segCount * 2;

    for (let segment = 0; segment < segCount; segment += 1) {
      const end = cxReadUInt16(bytes, endCountOffset + segment * 2);
      const start = cxReadUInt16(bytes, startCountOffset + segment * 2);
      const delta = cxReadInt16(bytes, idDeltaOffset + segment * 2);
      const rangeOffsetAddress = idRangeOffsetOffset + segment * 2;
      const rangeOffset = cxReadUInt16(bytes, rangeOffsetAddress);
      if (start === 0xffff && end === 0xffff) continue;

      for (let codePoint = start; codePoint <= end; codePoint += 1) {
        let glyphIndex;
        if (rangeOffset === 0) {
          glyphIndex = (codePoint + delta) & 0xffff;
        } else {
          const glyphAddress = rangeOffsetAddress + rangeOffset + (codePoint - start) * 2;
          if (glyphAddress < offset || glyphAddress + 1 >= offset + length) continue;
          const glyphId = cxReadUInt16(bytes, glyphAddress);
          glyphIndex = glyphId === 0 ? 0 : (glyphId + delta) & 0xffff;
        }
        if (glyphIndex !== 0) codePoints.add(codePoint);
      }
    }
    return codePoints;
  }

  function cxParseCmapFormat12(bytes, offset) {
    const codePoints = new Set();
    const groupCount = cxReadUInt32(bytes, offset + 12);
    for (let index = 0; index < groupCount; index += 1) {
      const groupOffset = offset + 16 + index * 12;
      const start = cxReadUInt32(bytes, groupOffset);
      const end = cxReadUInt32(bytes, groupOffset + 4);
      for (let codePoint = start; codePoint <= end; codePoint += 1) codePoints.add(codePoint);
    }
    return codePoints;
  }

  function cxParseCmapCodePoints(bytes) {
    const cmap = cxFindSfntTable(bytes, "cmap");
    if (!cmap) return [];
    const records = [];
    const recordCount = cxReadUInt16(bytes, cmap.offset + 2);
    for (let index = 0; index < recordCount; index += 1) {
      const recordOffset = cmap.offset + 4 + index * 8;
      records.push({
        platformId: cxReadUInt16(bytes, recordOffset),
        encodingId: cxReadUInt16(bytes, recordOffset + 2),
        offset: cmap.offset + cxReadUInt32(bytes, recordOffset + 4)
      });
    }
    const preferred = records
      .map((record) => ({ ...record, format: cxReadUInt16(bytes, record.offset) }))
      .sort((left, right) => {
        const score = (record) => {
          if (record.format === 12) return 0;
          if (record.format === 4 && record.platformId === 3 && record.encodingId === 1) return 1;
          if (record.format === 4) return 2;
          return 3;
        };
        return score(left) - score(right);
      });
    for (const record of preferred) {
      if (record.format === 12) return Array.from(cxParseCmapFormat12(bytes, record.offset)).sort((a, b) => a - b);
      if (record.format === 4) return Array.from(cxParseCmapFormat4(bytes, record.offset)).sort((a, b) => a - b);
    }
    return [];
  }

  function cxTextNodesUnder(root, out) {
    for (const child of Array.from(root.childNodes || [])) {
      if (child.nodeType === 3) {
        const parent = child.parentElement;
        const blocked = parent?.closest?.("script,style,noscript,input,textarea,select,option");
        if (parent && !blocked && child.nodeValue && child.nodeValue.trim()) out.push(child);
      } else if (child.nodeType === 1) {
        cxTextNodesUnder(child, out);
      }
    }
    return out;
  }

  function cxObfuscatedCharCounts(doc, family, fontCodePoints) {
    const safeFamily = String(family || "").trim();
    const roots = new Set();
    // 快路径：类名与字体族同名（font-cxsecret 的标准用法）
    if (safeFamily && !/[^a-zA-Z0-9_-]/.test(safeFamily)) {
      try { for (const element of doc.querySelectorAll(`[class~="${safeFamily}"]`)) roots.add(element); } catch {}
    }
    // 兜底：逐元素看计算样式里的 font-family（限制在 5000 个元素内）
    const elements = Array.from(doc.querySelectorAll ? doc.querySelectorAll("*") : []).slice(0, CX_MAX_STYLE_ELEMENTS);
    for (const element of elements) {
      if (roots.has(element)) continue;
      let computed = "";
      try { computed = getComputedStyle(element).fontFamily || ""; } catch { continue; }
      if (computed.split(",").some((item) => item.trim().replace(/^['"]|['"]$/g, "").toLowerCase() === safeFamily.toLowerCase())) roots.add(element);
    }

    const counts = new Map();
    const seen = new Set();
    for (const root of roots) {
      for (const node of cxTextNodesUnder(root, [])) {
        if (seen.has(node)) continue;
        seen.add(node);
        for (const char of node.nodeValue || "") {
          if (/\s/.test(char)) continue;
          if (fontCodePoints.has(char.codePointAt(0))) counts.set(char, (counts.get(char) || 0) + 1);
        }
      }
    }
    return counts;
  }

  function cxRenderGlyphMask(doc, char, fontFamily, isObfuscatedFont) {
    // 在 128×128 画布上按指定字体渲染单字，取包围盒归一化为 28×28 点阵
    const canvas = doc.createElement("canvas");
    const size = 128;
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.clearRect(0, 0, size, size);
    context.fillStyle = "#000000";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = isObfuscatedFont
      ? `${96}px "${fontFamily}"`
      : `${96}px "Noto Sans SC", "Microsoft YaHei", SimSun, sans-serif`;
    context.fillText(char, size / 2, size / 2 + 8);

    const image = context.getImageData(0, 0, size, size);
    const data = image.data;
    let minX = size;
    let minY = size;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (data[(y * size + x) * 4 + 3] > 24) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return null;

    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const grid = CX_GRID_SIZE;
    const mask = new Float32Array(grid * grid);
    const hProjection = new Float32Array(grid);
    const vProjection = new Float32Array(grid);
    let ink = 0;
    for (let gy = 0; gy < grid; gy += 1) {
      for (let gx = 0; gx < grid; gx += 1) {
        const sampleX = Math.min(size - 1, Math.max(0, Math.round(minX + ((gx + 0.5) / grid) * width)));
        const sampleY = Math.min(size - 1, Math.max(0, Math.round(minY + ((gy + 0.5) / grid) * height)));
        const alpha = data[(sampleY * size + sampleX) * 4 + 3] / 255;
        const value = alpha > 0.18 ? alpha : 0;
        const index = gy * grid + gx;
        mask[index] = value;
        hProjection[gy] += value;
        vProjection[gx] += value;
        ink += value;
      }
    }
    return { mask, hProjection, vProjection, aspect: width / Math.max(1, height), ink };
  }

  function cxCompareGlyphMasks(left, right) {
    if (!left || !right || left.ink === 0 || right.ink === 0) return 0;
    let pixelDiff = 0;
    let union = 0;
    for (let index = 0; index < left.mask.length; index += 1) {
      const a = left.mask[index];
      const b = right.mask[index];
      pixelDiff += Math.abs(a - b);
      union += Math.max(a, b);
    }
    let projectionDiff = 0;
    let projectionUnion = 0;
    for (let index = 0; index < CX_GRID_SIZE; index += 1) {
      projectionDiff += Math.abs(left.hProjection[index] - right.hProjection[index]);
      projectionDiff += Math.abs(left.vProjection[index] - right.vProjection[index]);
      projectionUnion += Math.max(left.hProjection[index], right.hProjection[index]);
      projectionUnion += Math.max(left.vProjection[index], right.vProjection[index]);
    }
    const pixelScore = 1 - pixelDiff / Math.max(1, union);
    const projectionScore = 1 - projectionDiff / Math.max(1, projectionUnion);
    const aspectScore = Math.max(0, 1 - Math.abs(left.aspect - right.aspect) / 1.5);
    const inkScore = Math.max(0, 1 - Math.abs(left.ink - right.ink) / Math.max(left.ink, right.ink));
    return pixelScore * 0.58 + projectionScore * 0.25 + aspectScore * 0.1 + inkScore * 0.07;
  }

  function cxHexToBits(hex, bitCount) {
    const bits = new Uint8Array(bitCount);
    let bitIndex = 0;
    for (const nibble of String(hex || "")) {
      const value = Number.parseInt(nibble, 16);
      if (!Number.isFinite(value)) continue;
      for (let shift = 3; shift >= 0 && bitIndex < bitCount; shift -= 1) {
        bits[bitIndex] = (value >> shift) & 1;
        bitIndex += 1;
      }
    }
    return bits;
  }

  function cxGlyphMaskToFingerprint(glyphMask) {
    if (!glyphMask || glyphMask.ink === 0) return null;
    const bitCount = CX_GRID_SIZE * CX_GRID_SIZE;
    const bits = new Uint8Array(bitCount);
    const projectionX = new Array(CX_GRID_SIZE).fill(0);
    const projectionY = new Array(CX_GRID_SIZE).fill(0);
    let ink = 0;
    for (let gy = 0; gy < CX_GRID_SIZE; gy += 1) {
      for (let gx = 0; gx < CX_GRID_SIZE; gx += 1) {
        const index = gy * CX_GRID_SIZE + gx;
        const bit = glyphMask.mask[index] > 0.18 ? 1 : 0;
        bits[index] = bit;
        projectionX[gx] += bit;
        projectionY[gy] += bit;
        ink += bit;
      }
    }
    return { bits, projectionX, projectionY, aspect: glyphMask.aspect, ink };
  }

  function cxCompareGlyphFingerprints(left, right) {
    if (!left || !right || left.ink === 0 || right.ink === 0) return 0;
    let intersection = 0;
    let union = 0;
    for (let index = 0; index < left.bits.length; index += 1) {
      const a = left.bits[index];
      const b = right.bits[index];
      if (a || b) {
        union += 1;
        if (a && b) intersection += 1;
      }
    }
    let projectionDiff = 0;
    let projectionUnion = 0;
    for (let index = 0; index < CX_GRID_SIZE; index += 1) {
      projectionDiff += Math.abs((left.projectionX[index] || 0) - (right.projectionX[index] || 0));
      projectionDiff += Math.abs((left.projectionY[index] || 0) - (right.projectionY[index] || 0));
      projectionUnion += Math.max(left.projectionX[index] || 0, right.projectionX[index] || 0);
      projectionUnion += Math.max(left.projectionY[index] || 0, right.projectionY[index] || 0);
    }
    const shapeScore = intersection / Math.max(1, union);
    const projectionScore = 1 - projectionDiff / Math.max(1, projectionUnion);
    const aspectScore = Math.max(0, 1 - Math.abs(left.aspect - right.aspect) / 1.5);
    const inkScore = Math.max(0, 1 - Math.abs(left.ink - right.ink) / Math.max(left.ink, right.ink));
    return shapeScore * 0.62 + projectionScore * 0.22 + aspectScore * 0.1 + inkScore * 0.06;
  }

  function cxLoadFingerprintDictionary() {
    if (!cxDictionaryPromise) {
      cxDictionaryPromise = (async () => {
        // 字典只随扩展打包；userscript 环境没有 getURL，返回 null 走 canvas 兜底
        if (typeof chrome === "undefined" || typeof chrome.runtime?.getURL !== "function") return null;
        const response = await fetch(chrome.runtime.getURL("data/glyph-fingerprints-noto-sans-sc.json"));
        if (!response.ok) throw new Error(`字典加载失败：${response.status}`);
        const payload = await response.json();
        const gridSize = payload.gridSize || CX_GRID_SIZE;
        const entries = (payload.entries || [])
          .filter((entry) => entry.char && entry.grid)
          .map((entry) => ({
            char: entry.char,
            aspect: Number(entry.aspect) || 0,
            ink: Number(entry.ink) || 0,
            bits: cxHexToBits(entry.grid, gridSize * gridSize),
            projectionX: entry.projectionX || [],
            projectionY: entry.projectionY || []
          }));
        return { gridSize, entries };
      })().catch((error) => {
        console.warn("[玥玥刷客] 字形指纹字典不可用，改用 canvas 兜底识别：", error);
        cxDictionaryPromise = null;
        return null;
      });
    }
    return cxDictionaryPromise;
  }

  function cxRankDictionaryCandidates(sourceFingerprint, dictionary, excludedCodePoints) {
    if (!sourceFingerprint || !dictionary || dictionary.gridSize !== CX_GRID_SIZE) return [];
    return dictionary.entries
      .filter((entry) => !excludedCodePoints.has(entry.char.codePointAt(0)))
      .map((entry) => ({ char: entry.char, fingerprintScore: cxCompareGlyphFingerprints(sourceFingerprint, entry) }))
      .sort((left, right) => right.fingerprintScore - left.fingerprintScore)
      .slice(0, CX_FINGERPRINT_TOP);
  }

  function cxCollectCandidateChars(doc, excludedCodePoints) {
    // 真字候选：领域常用字 + 页面正文出现过的字 + 通用高频字；排除混淆字体 cmap 覆盖的字
    const candidates = new Set();
    const add = (char) => {
      const codePoint = char.codePointAt(0);
      if (codePoint >= 0x4e00 && codePoint <= 0x9fff && !excludedCodePoints.has(codePoint)) candidates.add(char);
    };
    for (const char of CX_DOMAIN_CANDIDATES) add(char);
    let pageText = "";
    try { pageText = doc.body ? doc.body.innerText || "" : ""; } catch {}
    for (const char of pageText) add(char);
    for (const char of CX_COMMON_CANDIDATES) add(char);
    return Array.from(candidates).slice(0, CX_MAX_CANDIDATES);
  }

  async function cxRecognizeFont(doc, family, fontCodePoints, observedChars, cached) {
    const mapping = { ...(cached?.mapping || {}) };
    const confidence = { ...(cached?.confidence || {}) };
    const todo = observedChars.filter((char) => !Object.prototype.hasOwnProperty.call(mapping, char));
    if (todo.length) {
      try { if (doc.fonts?.ready) await doc.fonts.ready; } catch {}
      const dictionary = await cxLoadFingerprintDictionary();
      const fallbackCandidates = cxCollectCandidateChars(doc, fontCodePoints);
      const candidateMaskCache = new Map();
      const candidateMask = (char) => {
        if (!candidateMaskCache.has(char)) candidateMaskCache.set(char, cxRenderGlyphMask(doc, char, family, false));
        return candidateMaskCache.get(char);
      };
      for (const sourceChar of todo) {
        const sourceMask = cxRenderGlyphMask(doc, sourceChar, family, true);
        if (!sourceMask) continue;
        const sourceFingerprint = dictionary ? cxGlyphMaskToFingerprint(sourceMask) : null;
        const fingerprintRanked = dictionary ? cxRankDictionaryCandidates(sourceFingerprint, dictionary, fontCodePoints) : [];
        let ranked = (fingerprintRanked.length ? fingerprintRanked.map((item) => item.char) : fallbackCandidates)
          .map((char) => ({ char, score: cxCompareGlyphMasks(sourceMask, candidateMask(char)) }))
          .sort((left, right) => right.score - left.score);
        // 字典初筛的候选画布复比都不达标时，回退全量候选再比一遍
        if (fingerprintRanked.length && (!ranked[0] || ranked[0].score < CX_FINGERPRINT_ACCEPT)) {
          const fallbackRanked = fallbackCandidates
            .map((char) => ({ char, score: cxCompareGlyphMasks(sourceMask, candidateMask(char)) }))
            .sort((left, right) => right.score - left.score);
          if ((fallbackRanked[0]?.score || 0) > (ranked[0]?.score || 0)) ranked = fallbackRanked;
        }
        const best = ranked[0];
        if (!best || best.score < CX_MIN_CONFIDENCE) continue; // 识别不出就保留原字，宁可少解也不错解
        mapping[sourceChar] = best.char;
        confidence[sourceChar] = Number(best.score.toFixed(4));
      }
    }
    return { mapping, confidence, recognizedCount: Object.keys(mapping).length };
  }

  async function cxEnsureDecoding(force = false) {
    if (cxSecretMapping && !force && Date.now() - cxEnsureLastAt < CX_ENSURE_THROTTLE_MS) return cxSecretMapping;
    if (cxEnsurePromise) return cxEnsurePromise;
    cxEnsureLastAt = Date.now();
    // 识别链路里任何一步卡死（canvas/字体解析/storage）都不许拖死答题：30 秒拿不到映射就按原文发送
    cxEnsurePromise = Promise.race([
      (async () => {
        try {
          const faces = cxDiscoverFontFaces(document).filter((face) => /^data:/i.test(face.src));
          if (!faces.length) { cxSecretMapping = null; return null; }
          const merged = {};
          for (const face of faces) {
            const bytes = cxDataUriToBytes(face.src);
            const fontHash = await cxHashBytes(bytes);
            const cacheKey = `${CX_CACHE_PREFIX}${fontHash}`;
            const cached = await cxStorageGet(cacheKey);
            const fontCodePoints = new Set(cxParseCmapCodePoints(bytes));
            if (!fontCodePoints.size) continue;
            const counts = cxObfuscatedCharCounts(document, face.family, fontCodePoints);
            const observedChars = Array.from(counts.keys()).slice(0, CX_MAX_OBSERVED_CHARS);
            const missing = observedChars.filter((char) => !Object.prototype.hasOwnProperty.call(cached?.mapping || {}, char));
            const recognition = (missing.length || !cached)
              ? await cxRecognizeFont(document, face.family, fontCodePoints, observedChars, cached)
              : cached;
            if (recognition?.mapping && Object.keys(recognition.mapping).length) {
              if (missing.length) await cxStorageSet(cacheKey, { mapping: recognition.mapping, confidence: recognition.confidence || {}, updatedAt: Date.now() });
              Object.assign(merged, recognition.mapping);
            }
          }
          cxSecretMapping = Object.keys(merged).length ? merged : null;
          if (cxSecretMapping) console.info("[玥玥刷客] cxsecret 字体已解码：", Object.keys(cxSecretMapping).length, "个字符映射");
          return cxSecretMapping;
        } catch (error) {
          console.warn("[玥玥刷客] cxsecret 字体解码失败，本次按原文发送：", error);
          return null;
        }
      })(),
      new Promise((resolve) => setTimeout(() => { console.warn("[玥玥刷客] cxsecret 字体解码超时，本次按原文发送"); resolve(null); }, 30000))
    ]).finally(() => { cxEnsurePromise = null; });
    return cxEnsurePromise;
  }

  function decodeCxSecretText(text) {
    if (typeof text !== "string" || !text || !cxSecretMapping) return text;
    let decoded = "";
    let changed = false;
    for (const char of text) {
      if (Object.prototype.hasOwnProperty.call(cxSecretMapping, char)) {
        decoded += cxSecretMapping[char];
        changed = true;
      } else {
        decoded += char;
      }
    }
    return changed ? decoded : text;
  }

  function cxTestSetMapping(mapping) {
    cxSecretMapping = mapping || null;
  }

  function normalizeText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function normalizeAnswerText(value) {
    return normalizeText(value)
      .replace(/^[A-ZＡ-Ｚ][.．、:：)）]\s*/i, "")
      .replace(/^\(?[①②③④⑤⑥⑦⑧⑨⑩]\)?\s*/, "")
      .trim();
  }
  function isUsable(element) {
    if (!element || element.disabled || element.getAttribute?.("aria-disabled") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function detectQuestionType(container) {
    const typeValue = container.querySelector('input[id^="answertype"], input[name="answertype"], [data-answer-type]')?.value ||
      container.getAttribute("typename") || container.getAttribute("data-answer-type") || "";
    const numericTypes = { "0": "single", "1": "multiple", "2": "text", "3": "judgement", "4": "text", "6": "text" };
    if (numericTypes[String(typeValue)]) return numericTypes[String(typeValue)];
    const typeText = normalizeText(container.querySelector(".newZy_TItle, .Zy_TItle, .colorShallow")?.textContent || typeValue);
    if (/多选/.test(typeText)) return "multiple";
    if (/判断|对错|true.?false/i.test(typeText)) return "judgement";
    if (/填空|简答|名词解释|论述/.test(typeText)) return "text";
    if (/单选/.test(typeText)) return "single";
    return "";
  }

  function readOptionElements(container, selector, questionType = "") {
    let candidates;
    try { candidates = [...container.querySelectorAll(selector)]; } catch (error) { throw new Error(`选项选择器无效：${error.message}`); }
    const seenControls = new Set();
    const seenText = new Set();
    const options = [];
    for (const element of candidates) {
      const control = element.matches('input[type="radio"], input[type="checkbox"]')
        ? element
        : element.querySelector('input[type="radio"], input[type="checkbox"]');
      const ariaLabel = element.getAttribute("aria-label") || element.closest("[aria-label]")?.getAttribute("aria-label") || "";
      let text = decodeCxSecretText(normalizeAnswerText(element.innerText || element.textContent || control?.value || ariaLabel));
      if (/^第\s*\d+\s*空[:：]?$/.test(text)) continue;
      if (questionType === "judgement") {
        const probe = `${text} ${ariaLabel}`;
        if (/(^|[^不])对|正确|true|right|√/i.test(probe)) text = "正确";
        else if (/(^|[^不])错|错误|false|wrong|×/i.test(probe)) text = "错误";
      }
      if (!text || (control && seenControls.has(control)) || (!control && seenText.has(text))) continue;
      if (control) seenControls.add(control); else seenText.add(text);
      options.push({ element, control, text: text.slice(0, 1000) });
    }
    return options;
  }

  const editableFrameByBody = new WeakMap();
  function editorBodiesIn(scope) {
    return [...scope.querySelectorAll("iframe")].flatMap((frame) => {
      try {
        const body = frame.contentDocument?.body;
        if (body && (body.isContentEditable || body.getAttribute("contenteditable") === "true")) {
          editableFrameByBody.set(body, frame);
          return [body];
        }
        return [];
      } catch { return []; }
    });
  }
  function editableControls(container) {
    const blankItems = [...container.querySelectorAll(".blankItemDiv")];
    const controls = [];
    const push = (element) => { if (element && !controls.includes(element)) controls.push(element); };
    for (const blank of blankItems) {
      const ceBodies = editorBodiesIn(blank);
      const inputs = [...blank.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"]')];
      push(ceBodies.find(isUsable) || inputs.find(isUsable) || ceBodies[0] || inputs[0]);
    }
    const outside = (element) => !blankItems.some((blank) => blank.contains(element));
    if (controls.length) {
      for (const body of editorBodiesIn(container)) {
        if (isUsable(body) && outside(body)) push(body);
      }
      for (const input of container.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"]')) {
        if (isUsable(input) && outside(input)) push(input);
      }
      return controls;
    }
    const visible = [
      ...editorBodiesIn(container),
      ...container.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"]')
    ].filter(isUsable);
    if (visible.length) return visible;
    return [...editorBodiesIn(container), ...container.querySelectorAll('textarea, input[type="text"], input:not([type])')];
  }

  async function extractQuestions(aiConfig) {
    lastExtractNotes = [];
    await cxEnsureDecoding();
    let containers;
    try { containers = [...document.querySelectorAll(aiConfig.questionSelector)]; } catch (error) { throw new Error(`题目容器选择器无效：${error.message}`); }
    const usableContainers = containers.filter(isUsable);
    containers = usableContainers.filter((container) => !usableContainers.some((other) =>
      other !== container && container.contains(other) && other.querySelector('input[type="radio"], input[type="checkbox"], textarea, input[type="text"]')
    ));
    return containers.map((container) => {
      const explicitType = detectQuestionType(container);
      const options = readOptionElements(container, aiConfig.optionSelector, explicitType);
      const textControls = editableControls(container);
      if (!options.length && !textControls.length) return null;
      let stemCandidates;
      try { stemCandidates = [...container.querySelectorAll(aiConfig.stemSelector)]; } catch (error) { throw new Error(`题干选择器无效：${error.message}`); }
      const pageTitle = normalizeText(document.title || "");
      const junkStem = /^(?:章节|单元|课后|随堂|期中期末)?(?:测验|测试|作业|考试|习题)\s*\d*\s*$/;
      const candidateTexts = stemCandidates
        .map((element) => normalizeText(element.innerText || element.textContent || ""))
        .filter((text) => text.length >= 5 && !junkStem.test(text) && !(pageTitle && text.length <= pageTitle.length + 2 && text.startsWith(pageTitle)));
      const stemRaw = candidateTexts.sort((a, b) => b.length - a.length)[0] ||
        normalizeText(stemCandidates[0]?.innerText || stemCandidates[0]?.textContent || "") ||
        normalizeText(container.innerText);
      const stem = decodeCxSecretText(stemRaw)
        .replace(/^\s*\d+[、.．]\s*/, "")
        .replace(/[（(]\s*\d+(?:\.\d+)?\s*分\s*[)）]/g, "")
        .replace(/^[【\[(（]?(?:单选题|多选题|判断题|填空题|简答题)[】\])）]?\s*/g, "")
        .trim().slice(0, 4000);
      if (!options.length && (stem.length < 5 || junkStem.test(stem) || (pageTitle && stem === pageTitle))) {
        lastExtractNotes.push(`文本题题干识别异常（「${stem.slice(0, 24) || "空"}」），已跳过该题以防乱填`);
        return null;
      }
      const hasCheckbox = options.some(({ control }) => control?.type === "checkbox");
      const type = explicitType || (options.length ? (hasCheckbox ? "multiple" : "single") : "text");
      return {
        container, optionElements: options, textControls, type,
        payload: { question: 0, type, stem, options: type === "text" ? [] : options.map(({ text }) => text), ...(textControls.length > 1 ? { blanks: textControls.length } : {}) }
      };
    }).filter(Boolean).map((question, index) => { question.payload.question = index; return question; });
  }

  function setTextControl(control, value) {
    const dispatch = (target) => {
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    };
    if (control.isContentEditable || control.getAttribute?.("contenteditable") === "true") {
      control.focus?.();
      control.textContent = value;
      dispatch(control);
      const frame = editableFrameByBody.get(control);
      const host = frame?.closest?.(".blankItemDiv, li") || null;
      for (const textarea of host?.querySelectorAll("textarea") || []) {
        if (textarea.value !== value) {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
          if (setter) setter.call(textarea, value); else textarea.value = value;
          dispatch(textarea);
        }
      }
      return;
    }
    const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(control, value);
    else control.value = value;
    dispatch(control);
  }

  let lastFillReport = [];
  let lastExtractNotes = [];
  function applyAnswers(questions, answers) {
    let filledCount = 0;
    lastFillReport = [];
    for (const answer of answers) {
      const questionIndex = Number(answer?.question);
      const question = questions[questionIndex];
      if (!question) { lastFillReport.push({ q: questionIndex, ok: false, reason: "题号不存在" }); continue; }
      let changed = false;
      let reason = "";
      if (question.optionElements.length && Array.isArray(answer.choices)) {
        const indexedChoices = answer.choices.map(Number).filter(Number.isInteger);
        const textChoices = Array.isArray(answer.choiceTexts) ? answer.choiceTexts.map(normalizeAnswerText).filter(Boolean) : [];
        const exactIndexes = textChoices.length
          ? textChoices.map((text) => question.optionElements.findIndex(({ text: optionText }) => normalizeAnswerText(optionText) === text)).filter((index) => index >= 0)
          : [];
        const selected = new Set(textChoices.length > 0 && exactIndexes.length === textChoices.length ? exactIndexes : indexedChoices);
        if (!selected.size) reason = "AI 的选项索引与原文都匹配不上";
        question.optionElements.forEach(({ element, control }, index) => {
          const shouldSelect = selected.has(index);
          const ariaSelected = element.getAttribute("aria-checked") === "true" || element.classList.contains("selected") || element.classList.contains("active");
          if (control) {
            if (control.type === "checkbox" && control.checked !== shouldSelect) { control.click(); changed = true; }
            else if (control.type === "radio" && shouldSelect && !control.checked) { control.click(); changed = true; }
            else if (shouldSelect && control.checked) changed = true;
          } else if (shouldSelect || (question.type === "multiple" && ariaSelected && !shouldSelect)) { element.click(); changed = true; }
        });
      } else if (question.textControls.length) {
        let perBlank = Array.isArray(answer.textAnswers) ? answer.textAnswers.map((value) => String(value ?? "").trim()) : [];
        const single = typeof answer.textAnswer === "string" ? answer.textAnswer.trim() : "";
        if (perBlank.length !== question.textControls.length && question.textControls.length > 1 && single) {
          const parts = single
            .split(/[/／；;，,、]|和|与/)
            .map((part) => part.replace(/^第\s*\d+\s*空[:：]?\s*/, "").trim())
            .filter(Boolean);
          if (parts.length === question.textControls.length) perBlank = parts;
        }
        // 题面有多个空但平台只提供一个答题框（如简答题）时，合并 AI 的多份答案填入，避免整题被空数不符跳过
        if (perBlank.length > question.textControls.length && question.textControls.length >= 1) {
          const merged = perBlank.slice(0, question.textControls.length - 1);
          merged.push(perBlank.slice(question.textControls.length - 1).join("和"));
          perBlank = merged;
        }
        const fallback = single && question.textControls.length === 1 ? [single] : [];
        const values = perBlank.length === question.textControls.length && perBlank.some(Boolean) ? perBlank : fallback;
        if (!values.length || values.length !== question.textControls.length) {
          reason = `空数不符：题目 ${question.textControls.length} 空，AI 返回 ${perBlank.length || (single ? 1 : 0)} 份`;
        }
        let filledBlanks = 0;
        question.textControls.forEach((control, index) => {
          const value = values[index];
          if (value) { setTextControl(control, value); filledBlanks += 1; }
        });
        changed = question.textControls.length === 1 ? filledBlanks > 0 : filledBlanks === question.textControls.length;
      }
      if (changed) filledCount += 1;
      else lastFillReport.push({ q: questionIndex, type: question.type, blanks: question.textControls.length, options: question.optionElements.length, reason: reason || "AI 未返回这道题可用的答案" });
    }
    return filledCount;
  }

  function isBlockingVideoQuiz(question) {
    const selector = '#ext-comp-1046, .tkItem, .ans-videoquiz, .ans-videoquiz-opt, .video-quiz, [class*="videoQuiz"], [class*="video-quiz"]';
    return Boolean(question?.container?.matches?.(selector) || question?.container?.closest?.(selector));
  }
  function hasVisibleVideoQuizLocal() {
    const selectors = ["#ext-comp-1046", ".tkItem", ".ans-videoquiz", ".video-quiz", "[class*='videoQuiz']", "[class*='video-quiz']"];
    for (const selector of selectors) {
      const visible = [...document.querySelectorAll(selector)].find((element) =>
        isUsable(element) && Boolean(element.querySelector('input[type="radio"], input[type="checkbox"], .ans-videoquiz-opt')));
      if (visible) return true;
    }
    return false;
  }

  function findSubmitButton(selector, questions = []) {
    const blockingContainer = questions.find(isBlockingVideoQuiz)?.container;
    const blockingRoot = blockingContainer?.closest?.("#ext-comp-1046") || blockingContainer?.parentElement;
    const nearby = blockingContainer?.querySelector?.('#videoquiz-submit, .ans-videoquiz-submit, .video-quiz-submit, button[type="submit"], [data-action="submit"]') ||
      blockingContainer?.parentElement?.querySelector?.('#videoquiz-submit, .ans-videoquiz-submit, .video-quiz-submit') ||
      blockingRoot?.querySelector?.('#videoquiz-submit, .ans-videoquiz-submit, .video-quiz-submit');
    if (isUsable(nearby)) return nearby;
    const textButton = [...(blockingRoot?.querySelectorAll?.("button, a, [role=button]") || [])].find((element) => {
      const label = normalizeText(element.innerText || element.textContent);
      return /^(提交|确定|确认|确认答案|完成答题)$/i.test(label) && isUsable(element);
    });
    if (textButton) return textButton;
    return [...document.querySelectorAll(selector)].find(isUsable);
  }

  async function chaoxingSubmit() {
    const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    let method = "";
    const originalAlert = page.alert;
    page.alert = () => {};
    try {
      if (typeof page.btnBlueSubmit === "function") { await Promise.resolve(page.btnBlueSubmit()); method = "btnBlueSubmit"; }
      else {
        const findTextButton = (pattern) => [...document.querySelectorAll("button, a, [role=button], input[type=button], input[type=submit]")].find((element) => {
          const label = normalizeText(element.innerText || element.textContent || element.value);
          return pattern.test(label) && isUsable(element);
        });
        const submit = document.querySelector(".btnBlueSubmit, [onclick*='btnBlueSubmit'], [onclick*='submitAnswer'], .submit-answer, button[type=submit]") || findTextButton(/^(提交|提交答案|完成|交卷)$/);
        if (!isUsable(submit)) return { ok: false, error: "没有找到学习通提交入口" };
        submit.click();
        method = "button";
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (typeof page.submitCheckTimes === "function") await Promise.resolve(page.submitCheckTimes());
      else {
        [...document.querySelectorAll("button, a, [role=button]")].find((element) => /^(确定|确认|确认提交)$/.test(normalizeText(element.innerText || element.textContent)) && isUsable(element))?.click();
      }
      return { ok: true, method };
    } finally {
      page.alert = originalAlert;
    }
  }

  function findQuizContinueButton(questions = []) {
    const blockingContainer = questions.find(isBlockingVideoQuiz)?.container;
    const roots = [blockingContainer, blockingContainer?.parentElement, document].filter(Boolean);
    const selectors = ["#videoquiz-continue", ".ans-videoquiz-continue", ".videoquiz-continue", "[data-action=continue]"];
    for (const root of roots) {
      for (const selector of selectors) {
        const candidate = root.querySelector?.(selector);
        if (isUsable(candidate)) return candidate;
      }
      const textButton = [...(root.querySelectorAll?.("button, a, [role=button]") || [])].find((element) =>
        /^(继续学习|继续播放|继续|完成)$/i.test(normalizeText(element.innerText || element.textContent)) && isUsable(element));
      if (textButton) return textButton;
    }
    return null;
  }

  function waitForQuizContinue(taskId, questions) {
    let attempts = 0;
    const poll = () => {
      attempts += 1;
      const button = findQuizContinueButton(questions);
      if (button) { button.click(); updateTask(taskId, { state: "done", detail: "答案已提交，并已点击继续学习" }); return; }
      if (attempts < 30 && questions.some((question) => question.container?.isConnected)) setTimeout(poll, 300);
    };
    setTimeout(poll, 300);
  }

  async function submitAnsweredQuestions(aiConfig, questions, blockingVideoQuiz, taskId) {
    await new Promise((resolve) => setTimeout(resolve, 450));
    if (questions.some((question) => question.container?.matches?.(".TiMu, .newTiMu, .questionLi"))) {
      try {
        const result = await chaoxingSubmit();
        if (result?.ok) return result;
        return { ok: false, error: result?.error || "学习通没有确认提交" };
      } catch (error) { return { ok: false, error: error.message }; }
    }
    const submit = findSubmitButton(aiConfig.submitSelector, questions);
    if (!submit) {
      if (blockingVideoQuiz) waitForQuizContinue(taskId, questions);
      return { ok: false, error: "没有找到提交按钮" };
    }
    submit.click();
    if (blockingVideoQuiz) waitForQuizContinue(taskId, questions);
    return { ok: true, method: "button" };
  }

  // ---------- 答题主流程 ----------
  let quizInFlight = false;
  let lastQuizFingerprint = "";
  let lastQuizAttemptFingerprint = "";
  let lastQuizAttemptAt = 0;
  let quizHeartbeatTimer;

  function shortFingerprint(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36);
  }

  function reportQuizHeartbeat(active) {
    reportQuizState(active);
    if (!active) { clearInterval(quizHeartbeatTimer); quizHeartbeatTimer = undefined; return; }
    if (!quizHeartbeatTimer) quizHeartbeatTimer = setInterval(() => reportQuizState(true), 1500);
  }

  async function answerQuestions(force = false, suppressEmptyError = false) {
    if (quizInFlight) return { ok: false, error: "AI 正在答题，请稍候" };
    const aiConfig = buildAiConfig();
    const questions = await extractQuestions(aiConfig);
    if (!questions.length) {
      return { ok: false, error: suppressEmptyError ? "" : "当前页面没有识别到题目，请检查题目选择器" };
    }
    const payload = questions.map(({ payload: item }) => item);
    const fingerprint = JSON.stringify(payload);
    const taskId = `quiz:${shortFingerprint(fingerprint)}`;
    if (!force && fingerprint === lastQuizFingerprint) {
      updateTask(taskId, { label: `题目组 · ${questions.length} 题`, type: "quiz", state: "done", detail: "已处理，跳过重复请求" });
      return { ok: true, questionCount: questions.length, filledCount: 0, skipped: true };
    }
    if (!force && fingerprint === lastQuizAttemptFingerprint && Date.now() - lastQuizAttemptAt < 30000) {
      return { ok: false, error: "同一组题目正在等待重试" };
    }
    const blockingVideoQuiz = questions.some(isBlockingVideoQuiz);
    if (blockingVideoQuiz) {
      reportQuizHeartbeat(true);
      suspendVideoForQuiz = true;
      document.querySelectorAll("video").forEach((video) => video.pause());
    }
    publishStatus({
      phase: "answering", questionCount: questions.length, filledCount: 0,
      message: blockingVideoQuiz ? `检测到视频内题目，已暂停视频并开始回答 ${questions.length} 题` : `已识别 ${questions.length} 题，正在请求 AI`
    });
    updateTask(taskId, { label: `题目组 · ${questions.length} 题`, type: "quiz", state: "running", detail: blockingVideoQuiz ? "视频互动题 · 正在请求 AI" : "正在请求 AI" });

    quizInFlight = true;
    lastQuizAttemptFingerprint = fingerprint;
    lastQuizAttemptAt = Date.now();
    try {
      const response = await requestAnswers(payload);
      const filledCount = applyAnswers(questions, response.answers);
      lastQuizFingerprint = fingerprint;
      // 交卷是最终动作：普通章节测验是否提交完全由用户的「普通题提交」开关决定；
      // 视频内弹题（blockingVideoQuiz）不归该开关管，作答完立即提交，避免弹题悬空卡住视频。
      const shouldSubmit = blockingVideoQuiz ? true : settings.autoSubmit === true;
      let submission = { ok: false };
      if (shouldSubmit && filledCount === questions.length) {
        submission = await submitAnsweredQuestions(aiConfig, questions, blockingVideoQuiz, taskId);
      }
      publishStatus({
        phase: "done", questionCount: questions.length, filledCount,
        message: `本轮完成：成功填写 ${filledCount}/${questions.length} 题${submission.ok ? "，已自动提交并确认" : shouldSubmit && filledCount === questions.length ? `，提交失败：${submission.error || "未知原因"}` : ""}`
      });
      const answerPreview = response.answers.slice(0, 6).map((answer) => {
        const choices = Array.isArray(answer.choices) ? answer.choices.filter((choice) => Number.isInteger(Number(choice))).map((choice) => String.fromCharCode(65 + Number(choice))) : [];
        if (choices.length) return `${Number(answer.question) + 1}:${choices.join("")}`;
        const textValue = Array.isArray(answer.textAnswers) ? answer.textAnswers.map((value, index) => `${"①②③④⑤⑥"[index] || ""}${normalizeText(value).slice(0, 10)}`).join(" ") : answer.textAnswer;
        return `${Number(answer.question) + 1}:${normalizeText(textValue).slice(0, 18)}`;
      }).join(" · ");
      updateTask(taskId, {
        state: filledCount === questions.length ? "done" : "error",
        detail: `${filledCount}/${questions.length} 已填写 · ${response.cached ? "命中缓存" : `请求 ${response.attempts || 1} 次`}${submission.ok ? ` · 已提交(${submission.method || "平台接口"})` : ""}${answerPreview ? ` · ${answerPreview}` : ""}`
      });
      return { ok: true, questionCount: questions.length, filledCount };
    } catch (error) {
      publishStatus({ phase: "error", questionCount: questions.length, message: `AI 答题失败：${error.message}` });
      updateTask(taskId, { state: "error", detail: error.message });
      return { ok: false, error: error.message, questionCount: questions.length };
    } finally {
      quizInFlight = false;
    }
  }

  // ---------- 视频 ----------
  let observedVideos = new WeakSet();
  let videoTaskIds = new WeakMap();
  let videoSequence = 0;
  let intentionalPauseUntil = 0;
  let suspendVideoForQuiz = false;

  async function playVideo(video) {
    if (!settings.enabled) return;
    video.muted = settings.muted;
    video.playbackRate = settings.playbackRate;
    if (!settings.autoResume || suspendVideoForQuiz || video.ended || Date.now() < intentionalPauseUntil) return;
    try {
      await video.play();
      const taskId = videoTaskIds.get(video);
      if (taskId) updateTask(taskId, { state: "running", detail: `${video.currentTime ? Math.floor(video.currentTime) + " 秒 · " : ""}${settings.playbackRate}× 播放` });
      publishStatus({ phase: "playing", message: "视频正在播放" });
    } catch {}
  }

  function attach(video) {
    if (observedVideos.has(video)) return;
    observedVideos.add(video);
    const taskId = `video:${++videoSequence}`;
    videoTaskIds.set(video, taskId);
    updateTask(taskId, { label: `视频任务 ${videoSequence}`, type: "video", state: video.ended ? "done" : "waiting", detail: video.ended ? "播放完成" : "等待播放" });
    video.addEventListener("ended", () => { updateTask(taskId, { state: "done", detail: "播放完成" }); goNext(); });
    video.addEventListener("ratechange", () => { if (settings.enabled && video.playbackRate !== settings.playbackRate) video.playbackRate = settings.playbackRate; });
    video.addEventListener("pause", () => {
      if (video.ended || suspendVideoForQuiz || !settings.enabled || !settings.autoResume) return;
      setTimeout(() => playVideo(video), 1000);
    });
  }

  // ---------- 课件阅读 ----------
  const DOCUMENT_SELECTORS = ["#panView", ".insertdoc-online-pdf", "[class*='insertdoc']", "iframe[src*='/insertdoc']", "iframe[src*='pdf']", ".pdfViewer", "#viewer", "embed[type='application/pdf']", "object[type='application/pdf']", "[data-document-reader]"];
  const completedDocumentReaders = new Set();
  let documentInFlight = false;
  let documentCompletionTimer;

  function documentUrlLooksLikeReader() { return /(?:insertdoc|documentreader|pdfviewer|\/pdf\/|[?&](?:type|ext)=pdf)/i.test(location.href); }
  function findDocumentReaders() {
    const readers = [];
    for (const selector of DOCUMENT_SELECTORS) { try { readers.push(...document.querySelectorAll(selector)); } catch {} }
    const unique = readers.filter((reader, index, all) => all.indexOf(reader) === index && (isUsable(reader) || reader.tagName === "IFRAME"));
    if (!unique.length && documentUrlLooksLikeReader()) unique.push(document.documentElement);
    return unique;
  }
  function readerRoot(reader) {
    if (reader?.tagName === "IFRAME") { try { return reader.contentDocument?.documentElement || null; } catch { return null; } }
    return reader;
  }
  function scrollTargets(reader) {
    const root = readerRoot(reader);
    if (!root) return [];
    const ownerDocument = root?.ownerDocument || document;
    const candidates = [root, ownerDocument.scrollingElement, ownerDocument.documentElement, ownerDocument.body,
      ...(root.querySelectorAll?.(".pdfViewer, #viewer, .viewerContainer, [class*='scroll'], [style*='overflow']") || [])].filter(Boolean);
    return candidates
      .filter((element, index, all) => all.indexOf(element) === index && element.scrollHeight > element.clientHeight + 24)
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
  }
  function isAtScrollEnd(element) { return element.scrollTop + element.clientHeight >= element.scrollHeight - 12; }
  function scrollReaderToEnd(reader) {
    const targets = scrollTargets(reader);
    if (!targets.length) return { targets, complete: false };
    for (const target of targets) {
      if (isAtScrollEnd(target)) continue;
      const nextTop = Math.min(target.scrollHeight, target.scrollTop + Math.max(320, Math.floor(target.clientHeight * 0.82)));
      target.scrollTo?.({ top: nextTop, behavior: "auto" });
      if (typeof target.scrollTop === "number") target.scrollTop = nextTop;
      target.dispatchEvent?.(new Event("scroll", { bubbles: true }));
    }
    return { targets, complete: targets.every(isAtScrollEnd) };
  }
  function findDocumentNextPageButton(reader) {
    const root = readerRoot(reader);
    if (!root) return null;
    const ownerDocument = root?.ownerDocument || document;
    const searchRoots = [root, ownerDocument].filter(Boolean);
    const selectors = ["[aria-label*='下一页']", "[title*='下一页']", "[data-action='next-page']", "#nextPage", "#next-page", ".page-next", ".next-page", "button[aria-label*='Next page']"];
    for (const searchRoot of searchRoots) {
      for (const selector of selectors) {
        const candidate = searchRoot.querySelector?.(selector);
        if (isUsable(candidate)) return candidate;
      }
      const textButton = [...(searchRoot.querySelectorAll?.("button, a, [role=button]") || [])].find((element) => /^(下一页|下页|next page)$/i.test(normalizeText(element.innerText || element.textContent)) && isUsable(element));
      if (textButton) return textButton;
    }
    return null;
  }
  async function completeDocumentReader(reader, index) {
    const taskId = `document:${shortFingerprint(`${location.href}:${index}`)}`;
    const documentKey = `${location.href}:${index}`;
    if (completedDocumentReaders.has(documentKey)) return true;
    const label = `课件阅读 ${index + 1}`;
    if (!readerRoot(reader)) { updateTask(taskId, { label, type: "document", state: "waiting", detail: "等待课件子页面接管阅读" }); return false; }
    let pageClicks = 0;
    let stableAtEnd = 0;
    updateTask(taskId, { label, type: "document", state: "running", detail: "正在阅读并滚动课件" });
    publishStatus({ phase: "reading", message: "检测到教学课件，正在自动阅读", documentCount: findDocumentReaders().length });
    for (let step = 1; step <= 80 && settings.enabled && settings.autoReadDocuments; step += 1) {
      if (!reader.isConnected && reader !== document.documentElement) break;
      const result = scrollReaderToEnd(reader);
      if (!result.complete) {
        stableAtEnd = 0;
        updateTask(taskId, { state: "running", detail: `正在滚动课件 · ${step}/80` });
        await new Promise((resolve) => setTimeout(resolve, 550));
        continue;
      }
      const nextPage = findDocumentNextPageButton(reader);
      if (nextPage) {
        pageClicks += 1;
        updateTask(taskId, { state: "running", detail: `已读到当前页末尾，正在翻到第 ${pageClicks + 1} 页` });
        nextPage.click();
        await new Promise((resolve) => setTimeout(resolve, 800));
        continue;
      }
      stableAtEnd += 1;
      if (stableAtEnd >= 2) {
        completedDocumentReaders.add(documentKey);
        updateTask(taskId, { state: "done", detail: `课件已读到末尾${pageClicks ? ` · 翻页 ${pageClicks} 次` : ""}` });
        publishStatus({ phase: "done", message: "教学课件已阅读完成，准备进入下一节" });
        clearTimeout(documentCompletionTimer);
        documentCompletionTimer = setTimeout(() => goNext(), 1200);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    updateTask(taskId, { state: "error", detail: "课件阅读超过最大步骤，请检查页面是否需要手动翻页" });
    publishStatus({ phase: "error", message: "课件没有在预期步骤内完成，请查看任务队列" });
    return false;
  }
  async function processDocuments() {
    if (!settings.enabled || !settings.autoReadDocuments || documentInFlight) return false;
    const readers = findDocumentReaders();
    if (!readers.length) return false;
    documentInFlight = true;
    try {
      for (let index = 0; index < readers.length; index += 1) await completeDocumentReader(readers[index], index);
      return true;
    } finally { documentInFlight = false; }
  }

  // ---------- 章节完成检测与下一节 ----------
  let nextInProgress = false;
  let completionSignature = "";
  let completionStableCount = 0;
  let completionSkipCooldownUntil = 0;
  let quizDeferredNextTimer;

  function findIncompleteTaskDialog() {
    const goStudyButtons = [...document.querySelectorAll("button, a, [role=button]")].filter((element) =>
      /^(去学习|去完成|继续学习)$/.test(normalizeText(element.innerText || element.textContent)) && isUsable(element));
    for (const button of goStudyButtons) {
      let node = button;
      for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
        const text = normalizeText(node.innerText || node.textContent);
        if (/当前章节.{0,80}(?:还有|存在|尚有).{0,40}任务点.{0,30}未完成.{0,40}是否去完成/.test(text)) return { container: node, goStudyButton: button };
      }
    }
    return null;
  }
  function handleIncompleteTaskDialog() {
    const warning = findIncompleteTaskDialog();
    if (!warning) return false;
    warning.goStudyButton.click();
    nextInProgress = false;
    completionSignature = "";
    completionStableCount = 0;
    updateTask("navigation", { label: "切换下一节", type: "navigation", state: "waiting", detail: "平台提示仍有任务点未完成，已返回继续学习" });
    publishStatus({ phase: "playing", message: "当前章节还有任务点未完成，已取消跳转并继续学习" });
    return true;
  }
  function hasVisibleIncompleteTaskMarker() {
    const selectors = [".ans-job-icon", ".ans-job-unfinished", "[data-task-status='unfinished']", "[data-status='incomplete']"];
    return selectors.some((selector) => [...document.querySelectorAll(selector)].some((element) => {
      if (!isUsable(element)) return false;
      const finished = element.matches(".ans-job-finished, .jobFinished, .jobFinish, [data-task-status='completed'], [data-status='finished']") ||
        element.closest(".ans-job-finished, .jobFinished, .jobFinish, [data-task-status='completed'], [data-status='finished']");
      return !finished;
    }));
  }
  function findNextButton() {
    if (settings.nextSelector) {
      try { const custom = document.querySelector(settings.nextSelector); if (isUsable(custom)) return custom; } catch {}
    }
    for (const selector of FALLBACK_NEXT_SELECTORS) {
      const candidate = document.querySelector(selector);
      if (isUsable(candidate)) return candidate;
    }
    return [...document.querySelectorAll("button, a, [role=button]")].find((element) =>
      /^(下一节|下一课|下一个|继续学习|继续课程|next)$/i.test((element.innerText || element.textContent || "").trim().replace(/\s+/g, " ")) && isUsable(element));
  }

  // 顶层页面直接在页面上下文里执行（扩展版由 background 注入 MAIN world）
  function nextPageInTopContext() {
    const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    if (hasVisibleIncompleteTaskMarker()) return { ok: false, blocked: true, retryWhenComplete: true, error: "当前任务点尚未完成，等待平台确认完成" };
    const incompleteDialog = findIncompleteTaskDialog();
    if (incompleteDialog) {
      incompleteDialog.goStudyButton.click();
      return { ok: false, blocked: true, error: "平台提示当前章节仍有任务点未完成，已返回继续学习" };
    }
    const selectors = [settings.nextSelector, ...FALLBACK_NEXT_SELECTORS, "#prevNextFocusNext", ".orientationright", ".nodeItem.r i"];
    for (const selector of selectors) {
      if (!selector) continue;
      let candidate;
      try { candidate = document.querySelector(selector); } catch { continue; }
      if (isUsable(candidate)) { candidate.click(); return { ok: true, method: `button:${selector}` }; }
    }
    const textButton = [...document.querySelectorAll("button, a, [role=button]")].find((element) =>
      /^(下一节|下一课|下一章|下一个|继续学习|继续课程|next)$/i.test((element.innerText || element.textContent || "").trim().replace(/\s+/g, " ")) && isUsable(element));
    if (textButton) { textButton.click(); return { ok: true, method: "button:text" }; }
    const curCourseId = document.querySelector("#curCourseId");
    const curChapterId = document.querySelector("#curChapterId");
    const curClazzId = document.querySelector("#curClazzId");
    if (page.PCount?.next && curCourseId?.value && curChapterId?.value && curClazzId?.value) {
      const count = document.querySelectorAll("#prev_tab .prev_ul li").length;
      page._preChapterId = curChapterId.value;
      page.PCount.next(String(count), curChapterId.value, curCourseId.value, curClazzId.value, "");
      return { ok: true, method: "chaoxing:PCount.next" };
    }
    const chapterNodes = [...document.querySelectorAll("#coursetree .posCatalog_select, .posCatalog_select")]
      .filter((node, index, all) => all.indexOf(node) === index);
    const activeIndex = chapterNodes.findIndex((node) => node.classList.contains("posCatalog_active") || node.querySelector(".posCatalog_active"));
    const chapterInfo = chapterNodes.map((node, index) => ({
      node, index, name: node.querySelector(".posCatalog_name"),
      unfinished: Boolean(node.querySelector(".jobUnfinishCount, .orangeNew"))
    })).filter((item) => item.name && isUsable(item.name));
    const nextChapter = chapterInfo.find((item) => item.index > activeIndex && item.unfinished) ||
      chapterInfo.find((item) => item.index > activeIndex) ||
      chapterInfo.find((item) => item.unfinished && item.index !== activeIndex);
    if (nextChapter?.name) {
      nextChapter.node.scrollIntoView?.({ block: "center" });
      nextChapter.name.click();
      return { ok: true, method: nextChapter.unfinished ? "chaoxing:unfinished-chapter" : "chaoxing:chapter-list", target: (nextChapter.name.getAttribute("title") || nextChapter.name.textContent || "").trim() };
    }
    return { ok: false, error: "顶层页面未找到下一节入口", diagnostics: { host: location.hostname, chapterCount: chapterInfo.length, activeIndex } };
  }

  async function goNext() {
    if (!settings.enabled || !settings.autoNext || nextInProgress) return;
    if (!IS_TOP) { postUp({ type: "yy-next" }); return; }
    if (hasVisibleIncompleteTaskMarker()) {
      updateTask("navigation", { label: "切换下一节", type: "navigation", state: "waiting", detail: "当前任务点尚未完成，等待平台确认完成" });
      publishStatus({ phase: "playing", message: "任务点尚未完成，暂不点击下一节" });
      clearTimeout(quizDeferredNextTimer);
      quizDeferredNextTimer = setTimeout(() => goNext(), 1500);
      return;
    }
    if (handleIncompleteTaskDialog()) return;
    if (hasActiveVideoQuiz()) {
      updateTask("navigation", { label: "切换下一节", type: "navigation", state: "waiting", detail: "视频弹题尚未处理，暂停跳转" });
      publishStatus({ phase: "answering", message: "检测到视频弹题，答题提交后再进入下一节" });
      clearTimeout(quizDeferredNextTimer);
      quizDeferredNextTimer = setTimeout(() => goNext(), 1200);
      return;
    }
    nextInProgress = true;
    updateTask("navigation", { label: "切换下一节", type: "navigation", state: "running", detail: "等待平台保存学习进度" });
    const retryCount = Math.max(1, Math.min(6, Number(settings.nextRetryCount || 3)));
    const retryDelayMs = Math.max(400, Math.min(10000, Number(settings.nextRetryDelayMs || 1200)));
    let delegated;
    await new Promise((resolve) => setTimeout(resolve, 900));
    for (let attempt = 1; attempt <= retryCount; attempt += 1) {
      try {
        updateTask("navigation", { state: "running", detail: `正在定位下一节（第 ${attempt}/${retryCount} 次）` });
        delegated = nextPageInTopContext();
        if (delegated?.blocked) {
          nextInProgress = false;
          completionSignature = "";
          completionStableCount = 0;
          updateTask("navigation", { state: "waiting", detail: delegated.error || "平台提示仍有任务点未完成" });
          publishStatus({ phase: "playing", message: "平台提示任务未完成，已取消进入下一节" });
          setTimeout(scan, 600);
          if (delegated.retryWhenComplete) {
            clearTimeout(quizDeferredNextTimer);
            quizDeferredNextTimer = setTimeout(() => goNext(), 1500);
          }
          return;
        }
        if (delegated?.ok) {
          const target = delegated.target ? ` · ${delegated.target}` : "";
          updateTask("navigation", { state: "done", detail: `${delegated.method}${target}` });
          publishStatus({ phase: "scanning", message: `视频结束，已切换下一节（${delegated.method}）` });
          setTimeout(() => { nextInProgress = false; scan(); }, 2500);
          return;
        }
      } catch (error) { delegated = { error: error.message }; }
      if (attempt < retryCount) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
    const button = findNextButton();
    if (!button) {
      const diagnostics = delegated?.diagnostics ? ` · 章节 ${delegated.diagnostics.chapterCount ?? 0} · 当前索引 ${delegated.diagnostics.activeIndex ?? -1}` : "";
      updateTask("navigation", { state: "error", detail: `${delegated?.error || "没有找到入口"}${diagnostics}` });
      publishStatus({ phase: "error", message: "没有找到“下一节”入口；诊断信息已记录" });
      nextInProgress = false;
      return;
    }
    setTimeout(() => {
      button.click();
      updateTask("navigation", { state: "done", detail: "已点击当前 frame 的下一节按钮" });
      publishStatus({ phase: "scanning", message: "已进入下一节，正在重新检测任务" });
      setTimeout(() => { nextInProgress = false; scan(); }, 2500);
    }, 800);
  }

  function detectCompletedTask() {
    const pageText = normalizeText(document.body?.innerText || "");
    const explicitText = pageText.match(/(?:本节|本任务点|任务点|当前任务|答题|测验)(?:已经|已)?完成|提交成功|已交卷|查看解析/);
    if (explicitText) return { complete: true, reason: explicitText[0], source: "text" };
    const statusSelectors = [".ans-job-finished", ".jobFinished", ".jobFinish", ".task-point-finished", ".testTit_status_complete", ".answer-finished", ".quiz-finished", "[data-status='finished']", "[data-task-status='completed']"];
    for (const selector of statusSelectors) {
      const marker = [...document.querySelectorAll(selector)].find((element) => {
        if (!isUsable(element)) return false;
        const chapterNode = element.closest(".posCatalog_select");
        return !chapterNode || chapterNode.classList.contains("posCatalog_active");
      });
      if (marker) return { complete: true, reason: normalizeText(marker.textContent) || "任务点状态已完成", source: selector };
    }
    const activeChapter = document.querySelector(".posCatalog_select.posCatalog_active, .posCatalog_active.posCatalog_select");
    if (activeChapter && !activeChapter.querySelector(".jobUnfinishCount, .orangeNew, [class*='unfinish'], [class*='Unfinish']")) {
      const activeText = normalizeText(activeChapter.textContent);
      if (!/未完成|待完成|未学习/.test(activeText) && (/已完成|√|✓/.test(activeText) || activeChapter.querySelector(".jobFinish, .jobFinished"))) {
        return { complete: true, reason: "当前章节任务点已完成", source: "active-chapter" };
      }
    }
    return { complete: false };
  }

  async function skipCompletedTaskIfNeeded() {
    if (!settings.enabled || !settings.autoNext || !settings.skipCompleted || nextInProgress) return false;
    if (hasActiveVideoQuiz()) {
      updateTask("completion-check", { label: "完成状态检测", type: "navigation", state: "waiting", detail: "检测到视频弹题，暂不跳过" });
      completionSignature = "";
      completionStableCount = 0;
      return true;
    }
    if (Date.now() < completionSkipCooldownUntil) return false;
    const result = detectCompletedTask();
    if (!result.complete) { completionSignature = ""; completionStableCount = 0; return false; }
    const chapterId = document.querySelector("#curChapterId")?.value || "";
    const signature = `${location.href}:${chapterId}:${result.source}:${result.reason}`;
    if (signature === completionSignature) completionStableCount += 1;
    else { completionSignature = signature; completionStableCount = 1; }
    updateTask("completion-check", { label: "完成状态检测", type: "navigation", state: "running", detail: `${result.reason} · 确认 ${Math.min(completionStableCount, 2)}/2` });
    if (completionStableCount < 2) return true;
    completionSkipCooldownUntil = Date.now() + 12000;
    updateTask("completion-check", { state: "done", detail: `${result.reason} · 已跳过当前任务` });
    publishStatus({ phase: "done", message: `${result.reason}，正在进入下一未完成任务` });
    goNext();
    return true;
  }

  // ---------- 调度 ----------
  let orchestratorTimer;
  let orchestratorRunning = false;
  let scanThrottleTimer;
  let observer;
  let lastCountSignature = "";

  async function orchestrate() {
    if (!settings.enabled || orchestratorRunning || quizInFlight) return;
    orchestratorRunning = true;
    try {
      if (handleIncompleteTaskDialog()) return;
      const aiConfig = buildAiConfig();
      const questions = await extractQuestions(aiConfig);
      const videos = [...document.querySelectorAll("video")];
      const readers = findDocumentReaders();
      const blockingVideoQuiz = questions.some(isBlockingVideoQuiz);
      reportQuizHeartbeat(blockingVideoQuiz);
      if (questions.length && settings.autoAnswer) {
        if (blockingVideoQuiz) {
          suspendVideoForQuiz = true;
          videos.forEach((video) => video.pause());
        }
        await answerQuestions(false);
        return;
      }
      if (await skipCompletedTaskIfNeeded()) return;
      if (blockingVideoQuiz) {
        suspendVideoForQuiz = true;
        videos.forEach((video) => video.pause());
        publishStatus({ phase: "answering", message: "检测到视频弹题，请开启自动答题或手动完成" });
        return;
      }
      if (readers.length && settings.autoReadDocuments) { await processDocuments(); return; }
      if (suspendVideoForQuiz && !blockingVideoQuiz) {
        suspendVideoForQuiz = false;
        publishStatus({ phase: "playing", message: "题目已处理，正在恢复视频播放" });
      }
      if (!blockingVideoQuiz) videos.forEach(playVideo);
    } catch (error) {
      publishStatus({ phase: "error", message: `实时任务检测失败：${error.message}` });
    } finally {
      orchestratorRunning = false;
    }
  }

  function scheduleOrchestrator() {
    if (!settings.enabled) return;
    clearTimeout(orchestratorTimer);
    orchestratorTimer = setTimeout(orchestrate, 220);
  }

  function scan() {
    if (!IS_TOP) {
      const tabOrigin = store.get("yyTabOrigin", "");
      if (tabOrigin && tabOrigin !== siteOrigin) {
        siteOrigin = tabOrigin;
        storageKey = `site:${siteOrigin}`;
        settings = { ...DEFAULTS, ...(store.get(storageKey, {}) || {}) };
      }
    }
    const videos = [...document.querySelectorAll("video")];
    const documentCount = findDocumentReaders().length;
    if (settings.enabled) {
      videos.forEach((video) => {
        video.muted = settings.muted;
        video.playbackRate = settings.playbackRate;
        attach(video);
      });
    }
    if (!settings.enabled) {
      reportQuizHeartbeat(false);
      suspendVideoForQuiz = false;
      intentionalPauseUntil = Date.now() + 2000;
    }
    updateTask("watcher", {
      label: "实时监听页面", type: "system", state: settings.enabled ? "running" : "waiting",
      detail: settings.enabled ? `发现 ${videos.length} 个视频、${documentCount} 个课件，持续检测题目` : "站点未启用"
    });
    const countSignature = `${videos.length}:${documentCount}:${settings.enabled}`;
    if (countSignature !== lastCountSignature) {
      lastCountSignature = countSignature;
      publishStatus({
        phase: settings.enabled ? (videos.length ? "playing" : "scanning") : "idle",
        videoCount: videos.length, documentCount,
        message: settings.enabled ? `检测到 ${videos.length} 个视频、${documentCount} 个课件，正在监听页面任务` : "当前站点已暂停"
      });
    }
    scheduleOrchestrator();
    return videos.length;
  }

  // ---------- 状态与浮窗（仅顶层渲染，iframe 只上报） ----------
  const taskMap = new Map();
  let runtimeStatus = { phase: "idle", message: "等待任务", videoCount: 0, documentCount: 0, questionCount: 0, filledCount: 0, tasks: [], updatedAt: Date.now() };
  let lastPublishedSignature = "";
  let floatingUi;
  let floatingCustomization = { width: 300, opacity: 100, mode: "light", compact: false };

  function aggregateStatuses() {
    const items = [runtimeStatus, ...[...frameStatuses.values()].map((item) => item.status).filter(Boolean)];
    const priority = ["error", "answering", "playing", "reading", "scanning", "done", "idle"];
    const primary = priority.map((phase) => items.find((item) => item.phase === phase)).find(Boolean) || items[0] || {};
    return {
      ...primary,
      videoCount: items.reduce((sum, item) => sum + Number(item.videoCount || 0), 0),
      documentCount: items.reduce((sum, item) => sum + Number(item.documentCount || 0), 0),
      questionCount: items.reduce((sum, item) => sum + Number(item.questionCount || 0), 0),
      filledCount: items.reduce((sum, item) => sum + Number(item.filledCount || 0), 0),
      tasks: items.flatMap((item) => item.tasks || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 20),
      updatedAt: Date.now()
    };
  }

  function publishStatus(patch) {
    const next = { ...runtimeStatus, ...patch, updatedAt: Date.now() };
    const signature = JSON.stringify([next.phase, next.message, next.videoCount, next.documentCount, next.questionCount, next.filledCount, (next.tasks || []).map((task) => [task.id, task.state, task.detail])]);
    runtimeStatus = next;
    if (IS_TOP) renderFloatingStatus(aggregateStatuses());
    if (signature === lastPublishedSignature) return;
    lastPublishedSignature = signature;
    postUp({ type: "yy-status", status: runtimeStatus });
  }

  function updateTask(id, patch) {
    const previous = taskMap.get(id) || { id, label: id, type: "system", state: "waiting", createdAt: Date.now() };
    if (taskMap.has(id) && Object.entries(patch).every(([key, value]) => previous[key] === value)) return;
    const task = { ...previous, ...patch, id, updatedAt: Date.now() };
    taskMap.set(id, task);
    const tasks = [...taskMap.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
    for (const key of taskMap.keys()) if (!tasks.some((taskItem) => taskItem.id === key)) taskMap.delete(key);
    publishStatus({ tasks });
  }

  function floatingPhaseLabel(phase) {
    return { idle: "等待启动", scanning: "正在检测", playing: "视频学习中", reading: "课件阅读中", answering: "AI 正在答题", done: "本轮已完成", error: "需要处理" }[phase] || "正在运行";
  }
  function renderFloatingSettings() {
    if (!floatingUi) return;
    floatingUi.enabled.checked = Boolean(settings.enabled);
    floatingUi.autoResume.checked = Boolean(settings.autoResume);
    floatingUi.autoReadDocuments.checked = Boolean(settings.autoReadDocuments);
    floatingUi.autoAnswer.checked = Boolean(settings.autoAnswer);
    floatingUi.autoSubmit.checked = Boolean(settings.autoSubmit);
    floatingUi.autoNext.checked = Boolean(settings.autoNext);
    floatingUi.skipCompleted.checked = Boolean(settings.skipCompleted);
    floatingUi.playbackRate.value = String(settings.playbackRate || 1);
  }
  function renderFloatingStatus(status = runtimeStatus) {
    if (!floatingUi) return;
    const view = IS_TOP ? aggregateStatuses() : status;
    floatingUi.statusTitle.textContent = floatingPhaseLabel(view.phase);
    floatingUi.statusMessage.textContent = view.message || "启用后自动检测页面任务";
    const phase = view.phase || "idle";
    floatingUi.phaseChip.className = `phase-chip ${phase}`;
    floatingUi.headLed.className = `led ${phase}`;
    floatingUi.videoCount.textContent = String(view.videoCount || 0);
    floatingUi.documentCount.textContent = String(view.documentCount || 0);
    floatingUi.questionCount.textContent = String(view.questionCount || 0);
    const done = Number(view.filledCount || 0);
    const total = Number(view.questionCount || 0);
    floatingUi.statusNow.textContent = String(done);
    floatingUi.statusTotal.textContent = String(total);
    const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
    floatingUi.progressFill.style.width = `${pct}%`;
    const activeTask = (view.tasks || []).find((task) => task.state === "running" || task.state === "error");
    floatingUi.activeTask.textContent = activeTask ? `${activeTask.label} · ${activeTask.detail || ""}` : "暂无进行中的任务";
  }

  function normalizeFloatingCustomization(value = {}) {
    const width = Math.max(260, Math.min(380, Number(value.width || 300)));
    const opacity = Math.max(70, Math.min(100, Number(value.opacity || 100)));
    const mode = value.mode === "dark" ? "dark" : "light";
    return { width, opacity, mode, compact: Boolean(value.compact) };
  }
  function applyFloatingCustomization(value = floatingCustomization) {
    floatingCustomization = normalizeFloatingCustomization(value);
    if (!floatingUi) return;
    const { width, opacity, mode, compact } = floatingCustomization;
    floatingUi.host.style.width = `${width}px`;
    floatingUi.panel.style.opacity = String(opacity / 100);
    floatingUi.panel.dataset.mode = mode;
    floatingUi.panel.classList.toggle("compact", compact);
    floatingUi.customWidth.value = String(width);
    floatingUi.customOpacity.value = String(opacity);
    floatingUi.customOpacityValue.textContent = `${opacity}%`;
    floatingUi.customCompact.checked = compact;
    floatingUi.modeButtons.forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
    const rect = floatingUi.host.getBoundingClientRect();
    if (rect.right > innerWidth - 8) floatingUi.host.style.left = `${Math.max(8, innerWidth - width - 8)}px`;
  }
  function saveFloatingCustomization(patch) {
    applyFloatingCustomization({ ...floatingCustomization, ...patch });
    store.set("floatUiCustomization", floatingCustomization);
  }
  function setFloatingVisible(visible) {
    if (!floatingUi) return;
    floatingUi.host.style.display = visible ? "block" : "none";
    store.set("floatUiVisible", visible);
  }

  async function noteAnswerResultsCollected() {}

  let answerResults = [];
  function noteAnswerResult(result) {
    answerResults.push(result);
    if (answerResults.length > 20) answerResults.shift();
    const questionCount = answerResults.reduce((sum, item) => sum + Number(item?.questionCount || 0), 0);
    const filledCount = answerResults.reduce((sum, item) => sum + Number(item?.filledCount || 0), 0);
    const failed = answerResults.filter((item) => item && item.questionCount > 0 && !item.ok);
    if (failed.length && !filledCount) {
      publishStatus({ phase: "error", questionCount, filledCount, message: `识别 ${questionCount} 题，填写失败：${failed[0].error || "未知原因"}` });
    } else if (questionCount) {
      publishStatus({ phase: "done", questionCount, filledCount, message: `跨 frame 答题完成：${filledCount}/${questionCount}` });
    }
  }

  let diagnosisParts = [];
  let diagnosisTimer;
  function noteDiagnosis(source, diagnosis) {
    diagnosisParts.push(`frame ${source}（${diagnosis.url}）：识别 ${diagnosis.questions?.length || 0} 题`);
    for (const question of diagnosis.questions || []) {
      diagnosisParts.push(`  Q${question.index + 1} [${question.type}] 空${question.blanks} 选项${question.options} 控件:${question.controls.join(",") || "无"} 「${question.stem}」`);
    }
    for (const record of diagnosis.lastFillReport || []) {
      diagnosisParts.push(`  上轮 Q${record.q + 1} 未填：${record.reason}（${record.type} 空${record.blanks} 选项${record.options}）`);
    }
    for (const note of diagnosis.extractNotes || []) {
      diagnosisParts.push(`  提取警告：${note}`);
    }
    clearTimeout(diagnosisTimer);
    diagnosisTimer = setTimeout(async () => {
      diagnosisParts.push("=== 结束 ===");
      const text = ["=== 玥玥刷客（用户脚本）诊断 ===", `页面：${location.href}`, ...diagnosisParts].join("\n");
      try { await navigator.clipboard.writeText(text); } catch {
        const helper = document.createElement("textarea");
        helper.value = text;
        document.documentElement.append(helper);
        helper.select();
        document.execCommand("copy");
        helper.remove();
      }
      publishStatus({ phase: "done", message: "诊断已复制到剪贴板，粘贴给开发者即可" });
      diagnosisParts = [];
    }, 600);
  }

  async function buildDiagnosis() {
    const aiConfig = buildAiConfig();
    const questions = await extractQuestions(aiConfig);
    return {
      url: location.href,
      questions: questions.map((question, index) => ({
        index, type: question.type, blanks: question.textControls.length, options: question.optionElements.length,
        controls: question.textControls.slice(0, 4).map((control) =>
          `${control.tagName || "?"}${control.className && typeof control.className === "string" ? "." + control.className.split(" ").filter(Boolean)[0] : ""}${control.isContentEditable ? "[CE]" : ""}`),
        stem: question.payload.stem.slice(0, 24)
      })),
      lastFillReport,
      extractNotes: lastExtractNotes
    };
  }

  function renderAiSettingsFields() {
    if (!floatingUi) return;
    const config = buildAiConfig();
    floatingUi.aiPreset.value = config.providerPreset || "custom";
    floatingUi.aiEndpoint.value = config.endpoint || "";
    floatingUi.aiModel.value = config.model || "";
    floatingUi.aiKey.value = config.apiKey || "";
    floatingUi.aiEnhance.checked = config.enhanceMode !== false;
    floatingUi.aiCache.checked = config.enableCache !== false;
    floatingUi.aiSearch.checked = config.webSearch === true;
  }

  function saveAiSettings() {
    const saved = store.get("aiConfig", {}) || {};
    const next = {
      ...saved,
      providerPreset: floatingUi.aiPreset.value,
      endpoint: floatingUi.aiEndpoint.value.trim(),
      model: floatingUi.aiModel.value.trim(),
      apiKey: floatingUi.aiKey.value.trim(),
      authHeader: saved.authHeader || "Authorization",
      authPrefix: saved.authPrefix || "Bearer",
      extraHeaders: saved.extraHeaders || "{}",
      enhanceMode: floatingUi.aiEnhance.checked,
      enableCache: floatingUi.aiCache.checked,
      webSearch: floatingUi.aiSearch.checked
    };
    store.set("aiConfig", next);
    invalidateAiConfig();
    broadcast({ type: "yy-ai-config-changed" });
    window.dispatchEvent(new CustomEvent("yy-ai-config-changed"));
  }

  window.addEventListener("yy-ai-config-changed", invalidateAiConfig);
  // iframe 收到广播后失效本地缓存并重载设置
  if (!IS_TOP) {
    // yy-settings 广播之外，AI 配置变化也通过 GM 共享存储天然同步，这里只失效内存缓存
  }

  async function initFloatingWindow() {
    if (!IS_TOP || floatingUi || !document.documentElement) return;
    const host = document.createElement("div");
    host.id = "yueyue-floating-host";
    host.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483646;width:300px;max-width:calc(100vw - 24px);font-family:Inter,system-ui,'Microsoft YaHei',sans-serif;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        *{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer}
        .panel{--ink:#1a1a1e;--dim:#6e6e76;--faint:#9a9aa3;--bg:#ffffff;--surface:#f7f7f8;--lift:#ffffff;--line:#e9e9ec;--track:#ededf0;--on:#1a1a1e;--knob:#ffffff;--go:#16a34a;--err:#e45260;--shadow:0 10px 32px rgba(20,20,24,.1);overflow:hidden;border:1px solid var(--line);border-radius:16px;color:var(--ink);background:var(--bg);box-shadow:var(--shadow);transition:opacity .2s,width .2s}
        .panel[data-mode="dark"]{--ink:#f0f0f3;--dim:#a8a8b3;--faint:#6d6d78;--bg:#151517;--surface:#1c1c1f;--lift:#232327;--line:#2c2c31;--track:#26262b;--on:#f0f0f3;--knob:#151517;--go:#22c55e;--shadow:0 10px 32px rgba(0,0,0,.5)}
        .head{display:grid;grid-template-columns:30px 1fr auto;align-items:center;gap:9px;padding:11px 12px;border-bottom:1px solid var(--line);background:var(--bg);cursor:grab;user-select:none;touch-action:none}.head:active{cursor:grabbing}
        .logo{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:var(--on);color:var(--knob);font-size:13px;font-weight:800}.title strong,.title small{display:block}.title strong{font-size:12.5px;font-weight:800;letter-spacing:.2px}.title small{margin-top:1px;color:var(--faint);font-size:9px}
        .head-actions{display:flex;gap:2px;align-items:center}.led{width:6px;height:6px;border-radius:50%;background:var(--faint);margin:0 6px 0 2px;flex:none;transition:background .3s}.led.playing,.led.reading,.led.answering,.led.scanning{background:var(--go)}.led.done{background:var(--go)}.led.error{background:var(--err)}
        .icon-btn{display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;color:var(--dim);background:transparent;transition:background .15s,color .15s}.icon-btn:hover{background:var(--surface);color:var(--ink)}
        .body{padding:12px}.panel.collapsed .body{display:none}.panel.collapsed{width:236px}.panel.collapsed .collapse svg{transform:rotate(180deg)}.icon-btn svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transition:transform .2s}.body::-webkit-scrollbar{width:6px}.body::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--faint) 40%,transparent);border-radius:99px}
        .status{padding:1px 2px 11px}.status .row1{display:flex;align-items:center;justify-content:space-between}.phase-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 9px 3px 7px;border-radius:99px;background:var(--surface);color:var(--ink);font-size:10px;font-weight:700}.phase-chip i{width:6px;height:6px;border-radius:50%;background:var(--faint);transition:background .3s}.phase-chip.playing i,.phase-chip.reading i,.phase-chip.answering i,.phase-chip.scanning i{background:var(--go);animation:phasepulse 1.4s infinite}.phase-chip.done i{background:var(--go)}.phase-chip.error i{background:var(--err)}@keyframes phasepulse{50%{opacity:.45}}
        .progress{height:3px;margin-top:9px;border-radius:99px;background:var(--track);overflow:hidden}.progress i{display:block;height:100%;border-radius:99px;background:var(--on);transition:width .4s ease}
        .status strong,.status small{display:block}.status small{margin-top:8px;overflow:hidden;color:var(--faint);font-size:10px;text-overflow:ellipsis;white-space:nowrap}.status-count{display:flex;align-items:baseline;gap:1px;color:var(--faint);font-size:10px;font-weight:700}.status-count b{color:var(--ink);font-size:11.5px;font-variant-numeric:tabular-nums}.status-count span{font-variant-numeric:tabular-nums}
        .metrics{display:grid;grid-template-columns:repeat(3,1fr);margin:0 0 12px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.metric{text-align:center;padding:9px 0 8px;border-right:1px solid var(--line);transition:background .15s}.metric:hover{background:var(--surface)}.metric:last-child{border:0}.metric span{display:block;color:var(--faint);font-size:8.5px;font-weight:700;letter-spacing:1.2px}.metric b{display:block;margin-top:3px;font-size:16px;font-weight:700;font-variant-numeric:tabular-nums}
        .task-line{padding:0 2px 11px}.task-line .lab{color:var(--faint);font-size:8.5px;font-weight:700;letter-spacing:1.2px}.task-line .txt{margin-top:3px;color:var(--dim);font-size:10px;line-height:1.5}
        .master{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:10px;background:var(--surface)}.master strong{font-size:11.5px;font-weight:700}.master small{display:block;margin-top:1px;color:var(--faint);font-size:9px}.switch{position:relative;width:36px;height:21px;flex:none}.switch input{position:absolute;opacity:0}.switch i{display:block;width:36px;height:21px;border-radius:99px;background:var(--track);transition:.2s}.switch i:after{content:'';position:absolute;top:3px;left:3px;width:15px;height:15px;border-radius:50%;background:var(--knob);box-shadow:0 1px 2px rgba(0,0,0,.2);transition:.2s}.switch input:checked+i{background:var(--on)}.switch input:checked+i:after{transform:translateX(15px)}
        .options{display:grid;grid-template-columns:1fr 1fr;gap:2px;margin-top:10px}.check{display:flex;align-items:center;gap:8px;min-height:30px;padding:5px 8px;border-radius:8px;color:var(--dim);font-size:10.5px;transition:color .15s,background .15s;cursor:pointer}.check:hover{color:var(--ink);background:var(--surface)}.check input{margin:0;flex:none;width:15px;height:15px;border-radius:5px;accent-color:var(--on)}.speed{display:flex;align-items:center;justify-content:space-between}.speed select{width:70px;padding:4px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);font-size:10px}
        .actions{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:6px;margin-top:10px}.action{min-height:34px;padding:7px 4px;border:0;border-radius:9px;font-size:11px;font-weight:700;transition:background .15s,transform .12s,border-color .15s}.action:hover{background:#333339}.action:active{transform:scale(.96)}.answer{color:var(--knob);background:var(--on)}.model,.diag{color:var(--ink);background:var(--lift);border:1px solid var(--line)}.model:hover,.diag:hover{background:var(--surface);border-color:var(--dim)}
        .customizer{margin-bottom:11px;padding:11px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}.customizer[hidden]{display:none}.custom-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.custom-head strong{font-size:11px;font-weight:700}.reset{padding:0;border:0;color:var(--dim);background:transparent;font-size:10px}.reset:hover{color:var(--ink);text-decoration:underline}.custom-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.custom-field{display:flex;flex-direction:column;gap:5px;color:var(--faint);font-size:9px}.custom-field select,.custom-field input[type=range]{width:100%;accent-color:var(--on)}.custom-field select{padding:5px;border:1px solid var(--line);border-radius:8px;background:var(--lift);color:var(--ink)}.opacity-label{display:flex;justify-content:space-between}.mode-row{display:flex;gap:7px}.mode-btn{display:grid;place-items:center;width:22px;height:22px;padding:0;border:1px solid var(--line);border-radius:8px;background:var(--lift);color:var(--dim);font-size:10.5px;transition:color .15s,border-color .15s,background .15s}.mode-btn:hover{color:var(--ink);border-color:var(--dim)}.mode-btn.active{color:var(--knob);background:var(--on);border-color:var(--on)}.compact-check{display:flex;align-items:center;gap:5px;color:var(--dim);font-size:10px;cursor:pointer}.compact-check input{accent-color:var(--on)}.panel.compact .metrics,.panel.compact .task-line{display:none}
        .ai-panel{margin-bottom:11px;padding:11px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}.ai-panel[hidden]{display:none}.ai-panel .custom-head{margin-bottom:8px}.ai-panel label{display:flex;flex-direction:column;gap:3px;margin-top:8px;color:var(--dim);font-size:9.5px}.ai-panel input,.ai-panel select{width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--lift);color:var(--ink);font-size:10.5px}.ai-panel .row{display:grid;grid-template-columns:1fr 1fr;gap:7px}.ai-panel .ai-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:10px}.ai-panel .ai-actions button{min-height:30px;padding:6px;border:0;border-radius:9px;font-size:10.5px;font-weight:700;cursor:pointer}.ai-save{color:var(--knob);background:var(--on)}.ai-test{color:var(--ink);background:var(--lift);border:1px solid var(--line)}.ai-hint{margin:7px 0 0;color:var(--faint);font-size:8.5px;line-height:1.5}
      </style>
      <section class="panel">
        <header class="head">
          <span class="logo">玥</span><span class="title"><strong>玥玥刷客</strong><small>实时任务浮窗</small></span>
          <span class="head-actions">
            <span class="led idle"></span>
            <button class="icon-btn customize" title="外观设置"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"></path></svg></button>
            <button class="icon-btn collapse" title="折叠"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"></path></svg></button>
            <button class="icon-btn close" title="关闭"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"></path></svg></button>
          </span>
        </header>
        <div class="body">
          <div class="customizer" hidden>
            <div class="custom-head"><strong>浮窗外观</strong><button class="reset">恢复默认</button></div>
            <div class="custom-grid">
              <label class="custom-field">窗口宽度<select class="custom-width"><option value="260">紧凑 260px</option><option value="300">标准 300px</option><option value="340">宽版 340px</option><option value="380">大号 380px</option></select></label>
              <label class="custom-field"><span class="opacity-label"><span>透明度</span><b class="opacity-value">100%</b></span><input class="custom-opacity" type="range" min="70" max="100" step="5"></label>
            </div>
            <div class="custom-grid" style="margin-top:8px"><span class="custom-field">界面明暗<span class="mode-row"><button class="mode-btn" data-mode="light" title="浅色">☀</button><button class="mode-btn" data-mode="dark" title="深色">☾</button></span></span><label class="compact-check"><input class="custom-compact" type="checkbox">精简模式</label></div>
          </div>
          <div class="status">
            <div class="row1"><span class="phase-chip idle"><i></i><strong class="status-title">等待启动</strong></span><span class="status-count"><b class="status-now">0</b>/<span class="status-total">0</span> 题</span></div>
            <div class="progress"><i class="progress-fill" style="width:0%"></i></div>
            <small class="status-message">启用后自动检测页面任务</small>
          </div>
          <div class="metrics"><span class="metric"><span>视频</span><b class="video-count">0</b></span><span class="metric"><span>课件</span><b class="document-count">0</b></span><span class="metric"><span>题目</span><b class="question-count">0</b></span></div>
          <div class="task-line"><div class="lab">当前任务</div><div class="txt">暂无进行中的任务</div></div>
          <div class="master"><span><strong>启用当前站点</strong><small>开启后自动接管页面任务</small></span><label class="switch"><input class="enabled" type="checkbox"><i></i></label></div>
          <div class="options">
            <label class="check"><input class="auto-resume" type="checkbox">自动视频</label>
            <label class="check"><input class="auto-document" type="checkbox">自动课件</label>
            <label class="check"><input class="auto-answer" type="checkbox">自动答题</label>
            <label class="check"><input class="auto-submit" type="checkbox">普通题提交</label>
            <label class="check"><input class="auto-next" type="checkbox">自动下一节</label>
            <label class="check"><input class="skip-completed" type="checkbox">完成即跳过</label>
            <label class="check speed">速度<select class="rate"><option value="1">1.0×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2.0×</option></select></label>
          </div>
          <div class="actions"><button class="action answer">立即答题</button><button class="action model">模型设置</button><button class="action diag">复制诊断</button></div>
          <div class="ai-panel" hidden>
            <div class="custom-head"><strong>AI 接口设置</strong></div>
            <label>服务商预设
              <select class="ai-preset">
                <option value="deepseek">DeepSeek</option><option value="dashscope">阿里云百炼 · 通义千问</option>
                <option value="zhipu">智谱 AI · GLM</option><option value="moonshot">月之暗面 · Kimi</option>
                <option value="siliconflow">硅基流动</option><option value="volcengine">火山引擎 · 方舟</option>
                <option value="custom">自定义兼容接口</option>
              </select>
            </label>
            <label>完整接口 URL<input class="ai-endpoint" type="url" placeholder="https://example.com/v1/chat/completions"></label>
            <div class="row"><label>模型名<input class="ai-model" placeholder="model-name"></label><label>API Key<input class="ai-key" type="password" autocomplete="off"></label></div>
            <label style="flex-direction:row;align-items:center;gap:6px"><input class="ai-search" type="checkbox" style="width:auto">联网搜索（先查题库再作答；支持智谱/百炼/Kimi）</label>
            <label style="flex-direction:row;align-items:center;gap:6px"><input class="ai-enhance" type="checkbox" style="width:auto">高准确率模式（逐题+AI复核，更准但更慢）</label>
            <label style="flex-direction:row;align-items:center;gap:6px"><input class="ai-cache" type="checkbox" style="width:auto">启用答案缓存（7 天）</label>
            <div class="ai-actions"><button class="ai-save">保存设置</button><button class="ai-test">测试 AI 接口</button></div>
            <p class="ai-hint">密钥仅保存在本机脚本管理器存储中。测试会发送一道“1+1”示例题并显示返回答案。</p>
          </div>
        </div>
      </section>`;
    document.documentElement.append(host);
    const find = (selector) => shadow.querySelector(selector);
    floatingUi = {
      host, panel: find(".panel"), head: find(".head"), headLed: find(".led"), phaseChip: find(".phase-chip"), statusTitle: find(".status-title"), statusMessage: find(".status-message"), statusNow: find(".status-now"), statusTotal: find(".status-total"), progressFill: find(".progress-fill"),
      videoCount: find(".video-count"), documentCount: find(".document-count"), questionCount: find(".question-count"), activeTask: find(".task-line .txt"),
      enabled: find(".enabled"), autoResume: find(".auto-resume"), autoReadDocuments: find(".auto-document"), autoAnswer: find(".auto-answer"), autoSubmit: find(".auto-submit"), autoNext: find(".auto-next"), skipCompleted: find(".skip-completed"), playbackRate: find(".rate"),
      customizer: find(".customizer"), customWidth: find(".custom-width"), customOpacity: find(".custom-opacity"), customOpacityValue: find(".opacity-value"), customCompact: find(".custom-compact"), modeButtons: [...shadow.querySelectorAll(".mode-btn")],
      aiPanel: find(".ai-panel"), aiPreset: find(".ai-preset"), aiEndpoint: find(".ai-endpoint"), aiModel: find(".ai-model"), aiKey: find(".ai-key"), aiEnhance: find(".ai-enhance"), aiCache: find(".ai-cache"), aiSearch: find(".ai-search")
    };

    floatingCustomization = normalizeFloatingCustomization(store.get("floatUiCustomization", floatingCustomization));
    const position = store.get("floatUiPosition", null);
    if (position) {
      const left = Number(position.left);
      const top = Number(position.top);
      if (Number.isFinite(left) && Number.isFinite(top)) {
        const clampedLeft = Math.max(8, Math.min(innerWidth - floatingCustomization.width - 8, left));
        const clampedTop = Math.max(8, Math.min(innerHeight - 60, top));
        host.style.left = `${clampedLeft}px`; host.style.top = `${clampedTop}px`; host.style.right = "auto"; host.style.bottom = "auto";
      }
    }
    if (store.get("floatUiCollapsed", false)) floatingUi.panel.classList.add("collapsed");
    if (store.get("floatUiVisible", true) === false) host.style.display = "none";
    applyFloatingCustomization();

    floatingUi.enabled.addEventListener("change", () => saveSettings({ enabled: floatingUi.enabled.checked }));
    floatingUi.autoResume.addEventListener("change", () => saveSettings({ autoResume: floatingUi.autoResume.checked }));
    floatingUi.autoReadDocuments.addEventListener("change", () => saveSettings({ autoReadDocuments: floatingUi.autoReadDocuments.checked }));
    floatingUi.autoAnswer.addEventListener("change", () => saveSettings({ autoAnswer: floatingUi.autoAnswer.checked }));
    floatingUi.autoSubmit.addEventListener("change", () => saveSettings({ autoSubmit: floatingUi.autoSubmit.checked }));
    floatingUi.autoNext.addEventListener("change", () => saveSettings({ autoNext: floatingUi.autoNext.checked }));
    floatingUi.skipCompleted.addEventListener("change", () => saveSettings({ skipCompleted: floatingUi.skipCompleted.checked }));
    floatingUi.playbackRate.addEventListener("change", () => saveSettings({ playbackRate: Number(floatingUi.playbackRate.value) }));

    find(".answer").addEventListener("click", async () => {
      publishStatus({ phase: "answering", message: "正在扫描顶层页面和所有题目 iframe" });
      answerResults = [];
      try {
        const localResult = await answerQuestions(true, true);
        if (localResult?.questionCount) noteAnswerResult(localResult);
        broadcast({ type: "yy-answer-now" });
        setTimeout(() => {
          if (!answerResults.length) publishStatus({ phase: "error", message: "所有 frame 均未识别到题目" });
        }, 8000);
      } catch (error) {
        publishStatus({ phase: "error", message: `跨 frame 答题失败：${error.message}` });
      }
    });
    find(".model").addEventListener("click", () => { renderAiSettingsFields(); floatingUi.aiPanel.hidden = !floatingUi.aiPanel.hidden; });
    find(".diag").addEventListener("click", () => {
      publishStatus({ phase: "scanning", message: "正在收集全部 frame 的诊断信息…" });
      diagnosisParts = [];
      buildDiagnosis().then((diagnosis) => noteDiagnosis("top", diagnosis));
      broadcast({ type: "yy-diagnose" });
    });
    floatingUi.aiPreset.addEventListener("change", () => {
      const preset = PROVIDER_PRESETS[floatingUi.aiPreset.value];
      if (!preset) return;
      floatingUi.aiEndpoint.value = preset.endpoint;
      floatingUi.aiModel.value = preset.model;
    });
    find(".ai-save").addEventListener("click", () => { saveAiSettings(); publishStatus({ phase: "done", message: "AI 设置已保存" }); });
    find(".ai-test").addEventListener("click", async () => {
      saveAiSettings();
      publishStatus({ phase: "answering", message: "正在请求 AI 测试接口…" });
      try {
        const result = await requestAnswers([{ question: 0, type: "single", stem: "1 + 1 等于多少？", options: ["1", "2", "3"] }]);
        publishStatus({ phase: "done", message: `接口正常，测试答案：${JSON.stringify(result.answers[0] || {})}` });
      } catch (error) {
        publishStatus({ phase: "error", message: `测试失败：${error.message}` });
      }
    });
    find(".close").addEventListener("click", () => setFloatingVisible(false));
    find(".customize").addEventListener("click", () => { floatingUi.customizer.hidden = !floatingUi.customizer.hidden; });
    floatingUi.customWidth.addEventListener("change", () => saveFloatingCustomization({ width: Number(floatingUi.customWidth.value) }));
    floatingUi.customOpacity.addEventListener("input", () => saveFloatingCustomization({ opacity: Number(floatingUi.customOpacity.value) }));
    floatingUi.customCompact.addEventListener("change", () => saveFloatingCustomization({ compact: floatingUi.customCompact.checked }));
    floatingUi.modeButtons.forEach((button) => button.addEventListener("click", () => saveFloatingCustomization({ mode: button.dataset.mode })));
    find(".reset").addEventListener("click", () => {
      saveFloatingCustomization({ width: 300, opacity: 100, mode: "light", compact: false });
      host.style.left = "auto"; host.style.top = "auto"; host.style.right = "18px"; host.style.bottom = "18px";
      store.set("floatUiPosition", null);
    });
    find(".collapse").addEventListener("click", () => {
      floatingUi.panel.classList.toggle("collapsed");
      store.set("floatUiCollapsed", floatingUi.panel.classList.contains("collapsed"));
    });

    let drag;
    floatingUi.head.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      const rect = host.getBoundingClientRect();
      drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
      floatingUi.head.setPointerCapture?.(event.pointerId);
    });
    floatingUi.head.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const left = Math.max(8, Math.min(innerWidth - host.offsetWidth - 8, event.clientX - drag.offsetX));
      const top = Math.max(8, Math.min(innerHeight - host.offsetHeight - 8, event.clientY - drag.offsetY));
      host.style.left = `${left}px`; host.style.top = `${top}px`; host.style.right = "auto"; host.style.bottom = "auto";
    });
    floatingUi.head.addEventListener("pointerup", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag = undefined;
      const left = parseFloat(host.style.left);
      const top = parseFloat(host.style.top);
      if (Number.isFinite(left) && Number.isFinite(top)) store.set("floatUiPosition", { left, top });
    });
    renderFloatingSettings();
    renderFloatingStatus();
  }

  // ---------- 启动 ----------
  function startObserver() {
    observer?.disconnect();
    observer = new MutationObserver(() => {
      if (scanThrottleTimer) return;
      scanThrottleTimer = setTimeout(() => { scanThrottleTimer = undefined; scan(); }, 200);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  loadSettings().then(async () => {
    if (IS_TOP) {
      store.set("yyTabOrigin", location.origin);
      setInterval(() => broadcast({ type: "yy-tab-origin", origin: location.origin }), 2000);
      try { GM_registerMenuCommand("显示/隐藏浮窗", () => {
        if (!floatingUi) { initFloatingWindow(); return; }
        setFloatingVisible(floatingUi.host.style.display === "none");
      }); } catch {}
      await initFloatingWindow();
    } else {
      const tabOrigin = store.get("yyTabOrigin", "");
      if (tabOrigin && tabOrigin !== siteOrigin) { siteOrigin = tabOrigin; storageKey = `site:${siteOrigin}`; await loadSettings(); }
    }
    scan();
    startObserver();
    setInterval(orchestrate, 1000);
    setInterval(scan, 3500);
  }).catch((error) => console.warn("[玥玥刷客] 初始化失败：", error?.message || error));
})();
