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
  systemPrompt: "你是严谨的课程答题助手。逐题独立推理并复核后作答。只返回合法 JSON，不要 Markdown，不要解释。选择题同时返回从 0 开始的 choices 索引和与选项原文完全一致的 choiceTexts；多空填空题（blanks>1）按空顺序返回 textAnswers 数组；其余文本题填写 textAnswer。"
};

async function toggleFloatingWindow(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "TOGGLE_FLOAT" }, { frameId: 0 });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
    await new Promise((resolve) => setTimeout(resolve, 120));
    return chrome.tabs.sendMessage(tabId, { type: "TOGGLE_FLOAT" }, { frameId: 0 });
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !/^https?:/i.test(tab.url || "")) return;
  // 只在网课站点启用浮窗硬注入，其他页面点图标不做任何事
  try {
    const host = new URL(tab.url).hostname;
    const courseSite = /^(?:[a-z0-9-]+\.)*(?:chaoxing\.com|edu\.cn|xuexi\.cn|zhihuishu\.com|changjietong\.com|yuketang\.cn|rainclassroom\.com|icve\.com\.cn|icourse163\.org|icourse163\.cn|xuexitong\.com|gxt\.hnvcp\.com|nodedu\.cn|sflep\.com|cnki\.net|mosoteach\.cn|mtcsun\.com|xuanyaedu\.com|classin\.cn|eelive\.cn)(?::\d+)?$/i.test(host);
    if (!courseSite) return;
  } catch { return; }
  toggleFloatingWindow(tab.id).catch(() => {});
});

const nextRequestLocks = new Map();
const activeVideoQuizFrames = new Map();
const frameStatusesByTab = new Map();
const VIDEO_QUIZ_STATE_TTL_MS = 8000;

chrome.tabs.onRemoved.addListener((tabId) => {
  activeVideoQuizFrames.delete(tabId);
  frameStatusesByTab.delete(tabId);
  nextRequestLocks.delete(tabId);
});

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId === 0) {
    activeVideoQuizFrames.delete(tabId);
    frameStatusesByTab.delete(tabId);
    return;
  }
  const frames = activeVideoQuizFrames.get(tabId);
  frames?.delete(frameId);
  if (frames && !frames.size) activeVideoQuizFrames.delete(tabId);
  const statuses = frameStatusesByTab.get(tabId);
  statuses?.delete(frameId);
  if (statuses && !statuses.size) frameStatusesByTab.delete(tabId);
});

function aggregateFrameStatuses(statuses) {
  const items = [...statuses.values()].map((item) => item.status).filter(Boolean);
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

// frame 可能已被回收或脚本失联：sendMessage 会永远不回，必须带超时，否则答题/诊断整体挂死
const FRAME_MSG_TIMEOUT_MS = 20000;
function sendToFrame(tabId, message, frameId) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: `frame#${frameId} ${FRAME_MSG_TIMEOUT_MS / 1000} 秒未响应` });
    }, FRAME_MSG_TIMEOUT_MS);
    chrome.tabs.sendMessage(tabId, message, { frameId }).then(
      (response) => { if (settled) return; settled = true; clearTimeout(timer); resolve(response ?? { ok: false, error: "frame 无响应" }); },
      (error) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok: false, error: error.message }); }
    );
  });
}

async function answerAllFrames(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const results = await Promise.all((frames || []).map(async ({ frameId }) => {
    const response = await sendToFrame(tabId, { type: "ANSWER_NOW", allFrames: true }, frameId);
    return { frameId, response };
  }));
  const answered = results.filter((item) => item.response?.answerResult?.questionCount > 0);
  return {
    ok: answered.some((item) => item.response?.ok),
    frameCount: results.length,
    questionCount: answered.reduce((sum, item) => sum + Number(item.response.answerResult.questionCount || 0), 0),
    filledCount: answered.reduce((sum, item) => sum + Number(item.response.answerResult.filledCount || 0), 0),
    results
  };
}

async function diagnoseAllFrames(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const results = await Promise.all((frames || []).map(async ({ frameId }) => {
    const response = await sendToFrame(tabId, { type: "DIAGNOSE_NOW" }, frameId);
    return { frameId, response };
  }));
  return { ok: true, questionCount: results.reduce((sum, item) => sum + (item.response?.questions?.length || 0), 0), results };
}

function hashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
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
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("AI 没有返回可解析的 JSON");
  }
}

function answerSchemaRules() {
  return '严格输出：{"answers":[{"question":0,"choices":[0],"choiceTexts":["选项原文"],"textAnswers":[""],"textAnswer":""}]}。选择题必须同时给出 choices 和 choiceTexts，并确保二者指向同一选项；多空填空题（题目带 blanks 数量）必须在 textAnswers 数组里按空顺序逐空给出答案，禁止把多个空的答案用顿号、斜杠合并进一个字符串；单空文本题填写 textAnswer。判断题将“对/正确/True/√”视为正确，将“错/错误/False/×”视为错误。否定题特别规则：题干含“不属于/不包括/不是/不正确/错误的是/不包括/无关的是/不必需”等否定词时，先逐项判断该项是否符合肯定表述，再选出唯一不符合的那一项，严禁把“最典型/最核心”的肯定项当答案。部分课程平台会用自定义字体把题面文字替换成形近乱码（如“浹工中心”实为“加工中心”、“嵃心”实为“中心”、“崐”实为“工”）：请按专业课程语境推断还原真实文字再作答；每道题必须给出答案，禁止因乱码返回空字符串。';
}

function webSearchHint() {
  return "你已启用联网搜索。作答前优先检索在线题库（百度题库、学科网、学习通/超星题目库、百科等）：能检索到原题时直接采用题库标准答案；检索不到时再自行推理。题面文字可能被课程平台的反爬字体混淆成生僻乱码，把乱码字符当作被替换的占位字，只取可读关键词、数字和标准号（如 ISO 10791、PLC、24）组句搜索。";
}

function webSearchParams(config, endpoint) {
  if (config.webSearch === false) return {};
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

async function chatCompletion(config, endpoint, headers, messages) {
  const maxAttempts = Math.max(1, Math.min(6, Number(config.retryCount ?? 2) + 1));
  const timeoutMs = Math.max(5000, Math.min(180000, Number(config.requestTimeoutMs || 30000)));
  const retryDelayMs = Math.max(200, Math.min(10000, Number(config.retryDelayMs || 1200)));
  const search = webSearchParams(config, endpoint);
  const body = JSON.stringify({
    model: config.model,
    temperature: 0.1,
    messages,
    ...(search.tools ? { tools: search.tools } : {}),
    ...(search.enable_search ? { enable_search: true } : {})
  });
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, { method: "POST", headers, body, signal: controller.signal });
      const rawText = await response.text();
      let data;
      try { data = JSON.parse(rawText); } catch { data = null; }
      if (!response.ok) {
        const detail = data?.error?.message || data?.message || rawText.slice(0, 300) || response.statusText;
        const error = new Error(`AI 接口返回 ${response.status}：${detail}`);
        error.retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
        throw error;
      }
      return parseJsonReply(extractContent(data));
    } catch (error) {
      lastError = error?.name === "AbortError" ? new Error(`AI 请求超过 ${Math.round(timeoutMs / 1000)} 秒`) : error;
      const retryable = error?.name === "AbortError" || error?.retryable !== false;
      if (!retryable || attempt >= maxAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error("AI 请求失败");
}

  function pickAnswer(parsed, questionIndex) {
    if (!parsed || !Array.isArray(parsed.answers)) throw new Error("AI 返回 JSON 缺少 answers 数组");
    return parsed.answers.find((item) => Number(item?.question) === questionIndex) || parsed.answers[0] || null;
  }

  // 答案是否真正可用：选择题要有 choices；文本题 textAnswers/textAnswer 至少一个非空
  function answerIsUsable(question, answer) {
    if (!answer) return false;
    if (question.type === "text") {
      const joined = (Array.isArray(answer.textAnswers) ? answer.textAnswers.join("") : "") + String(answer.textAnswer || "");
      if (!joined.trim()) return false;
      // 页面标题/导航文案被模型当答案抄回来的，一律视为未答（会触发补问重取）
      if (/^(?:章节|单元|课后|随堂|期中期末)(?:测验|测试|作业|考试|习题)\s*\d*$/.test(joined.trim())) return false;
      return true;
    }
    return Array.isArray(answer.choices) && answer.choices.length > 0;
  }

  // 模型不一定按 schema 把文本答案写进 textAnswer/textAnswers：从常见杂牌字段里捞回来
  function harvestTextAnswer(question, answer) {
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
  }

  // 模型偶尔会漏答某道文本题（返回空串）：把这些题单独再问一次，用补问结果覆盖
  async function retryUnanswered(config, endpoint, headers, questions, answers, pickByIndex) {
    const answersByIndex = new Map(answers.map((item) => [Number(item?.question), item]).filter(([, item]) => item));
    const pending = [];
    questions.forEach((question, index) => {
      const existing = answersByIndex.get(index);
      // error 是 enhance 工作流接住的网络/解析错误，模型未必真答不了：值得再补问一次
      if (!answerIsUsable(question, existing)) pending.push({ question, index });
    });
    if (!pending.length) return { answers, refilled: 0 };
    const schemaRules = answerSchemaRules();
    const searchHint = config.webSearch === false ? "" : webSearchHint();
    const retrySystem = `${config.systemPrompt || ""}\n${schemaRules}${searchHint}只输出 JSON，不要解释。以下题目上一轮没有作答（答案为空），这次必须每题给出非空答案。`;
    const results = await Promise.all(pending.map(async ({ question, index }) => {
      try {
        const parsed = await chatCompletion(config, endpoint, headers, [
          { role: "system", content: retrySystem },
          {
            role: "user", content: `请回答这道题：\n${JSON.stringify({ ...question, question: index })}\n\n这道题是文本题（填空/简答），最终答案文本必须写入 textAnswer 字段且非空，禁止留空。答案措辞必须贴合题干空缺处的语法搭配，并优先采用题干或题目上下文中出现过的规范术语（例如空缺前是“实现……功能的核心执行机构”时，应填该机构的规范全称，而不是它的某个部件名）。`
          }
        ]);
        console.info(`[玥玥刷客] 空题补问 Q${index} 原始返回：`, JSON.stringify(parsed).slice(0, 400));
        const answer = harvestTextAnswer(question, pickByIndex ? pickByIndex(parsed, index) : (parsed?.answers?.find((item) => Number(item?.question) === index) || parsed?.answers?.[0] || null));
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
  }


async function requestAnswers(questions) {
  const stored = await chrome.storage.local.get("aiConfig");
  const config = { ...DEFAULT_AI_CONFIG, ...(stored.aiConfig || {}) };
  if (!config.endpoint || !config.model) throw new Error("请先在“AI 接口设置”中填写接口地址和模型");

  const enhanceMode = config.enhanceMode !== false;
  // v5：否定题规则与选项归并修复上线，旧版本缓存（含乱码时代“章节测验”等垃圾答案）全部换键作废
  const cacheKey = hashText(JSON.stringify({ v: 5, model: config.model, systemPrompt: config.systemPrompt || "", enhanceMode, webSearch: config.webSearch !== false, questions }));
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  if (config.enableCache !== false) {
    const cachedStore = await chrome.storage.local.get("answerCache");
    const cached = cachedStore.answerCache?.[cacheKey];
    if (cached?.answers && Array.isArray(cached.answers) && Date.now() - (cached.at || 0) < CACHE_TTL_MS) {
      // 缓存命中必须逐题可用：空答案、error 条目、“章节测验”类导航文本都算没答，放行重新请求
      const usable = questions.every((question) => {
        const answer = cached.answers.find((item) => Number(item?.question) === Number(question.question));
        return answerIsUsable(question, answer);
      });
      if (usable) return { answers: cached.answers, cached: true, attempts: 0 };
    }
  }

  let endpoint;
  try {
    endpoint = new URL(config.endpoint).toString();
  } catch {
    throw new Error("AI 接口地址不是有效 URL");
  }

  let extraHeaders;
  try {
    extraHeaders = JSON.parse(config.extraHeaders || "{}");
  } catch {
    throw new Error("附加请求头必须是合法 JSON 对象");
  }

  const headers = { "Content-Type": "application/json", ...extraHeaders };
  if (config.apiKey && config.authHeader) {
    headers[config.authHeader] = `${config.authPrefix ? `${config.authPrefix} ` : ""}${config.apiKey}`;
  }

  const schemaRules = answerSchemaRules();
  const searchHint = config.webSearch === false ? "" : webSearchHint();
  let answers;
  let attempts = 0;

  if (!enhanceMode) {
    const parsed = await chatCompletion(config, endpoint, headers, [
      { role: "system", content: `${config.systemPrompt || ""}\n${schemaRules}${searchHint}只依据题干与选项字面信息作答，不确定时选择最可能的选项。` },
      { role: "user", content: `请逐题回答并复核以下题目：\n${JSON.stringify(questions)}` }
    ]);
    attempts = 1;
    if (!Array.isArray(parsed.answers)) throw new Error("AI 返回 JSON 缺少 answers 数组");
    answers = parsed.answers;
  } else {
    const solveSystem = `${config.systemPrompt || ""}\n${schemaRules}${searchHint}只依据题干与选项字面信息作答，不确定时选择最可能的选项；多选题逐个选项独立判断，拿不准的选项不选；判断题警惕“都、一定、必须、所有”等绝对化表述。`;
    const isNegative = (question) => /不属于|不包括|不正确|不是|无关|不必需|不包括|错误的是|不对/.test(String(question?.stem || ""));
    const verifySystem = `你是阅卷审核员。先独立解答题目，再与候选答案比对：一致就原样返回候选答案，不一致就返回你复核后的最终答案。题干含“不属于/不正确/不是”等否定词时必须用排除法复核：逐项标记“符合肯定表述”与“不符合”，最终答案只能是唯一“不符合”的那项，候选答案若选了最典型、最核心的肯定项，判定为错误并纠正。${schemaRules}只输出 JSON，不要解释。`;
    const results = new Array(questions.length).fill(null);
    let cursor = 0;
    const worker = async () => {
      while (cursor < questions.length) {
        const index = cursor;
        cursor += 1;
        try {
          const parsed = await chatCompletion(config, endpoint, headers, [
            { role: "system", content: solveSystem },
            { role: "user", content: `请回答这道题：\n${JSON.stringify({ ...questions[index], question: index })}` }
          ]);
          attempts += 1;
          let answer = pickAnswer(parsed, index);
          if (answer) {
            try {
              const verified = pickAnswer(await chatCompletion(config, endpoint, headers, [
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
    if (results.every((item) => !item || item.error)) {
      throw new Error(results.find((item) => item?.error)?.error || "AI 请求失败");
    }
    answers = results.filter(Boolean);
  }

  // 主轮答案先做一次形状归一：模型把答案写进杂牌字段时直接捞回，避免不必要的补问
  answers = answers.map((item) => {
    const question = questions[Number(item?.question)];
    return question && question.type === "text" ? harvestTextAnswer(question, item) : item;
  });

  ({ answers, refilled } = await retryUnanswered(config, endpoint, headers, questions, answers, pickAnswer));
  if (refilled) console.info(`[玥玥刷客] 空答案补问：${refilled} 题重新作答`);

  if (config.enableCache !== false) {
    const cachedStore = await chrome.storage.local.get("answerCache");
    const answerCache = cachedStore.answerCache || {};
    answerCache[cacheKey] = { answers, model: config.model, at: Date.now() };
    const entries = Object.entries(answerCache).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0)).slice(0, 200);
    await chrome.storage.local.set({ answerCache: Object.fromEntries(entries) });
  }
  return { answers, cached: false, attempts };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_TAB_SITE_KEY" && sender.tab?.url) {
    try {
      sendResponse({ ok: true, siteKey: new URL(sender.tab.url).origin });
    } catch {
      sendResponse({ ok: false });
    }
    return false;
  }

  if (message?.type === "STATUS_UPDATE" && sender.tab?.id) {
    const tabId = sender.tab.id;
    const statuses = frameStatusesByTab.get(tabId) || new Map();
    statuses.set(sender.frameId ?? 0, { status: message.status, updatedAt: Date.now() });
    frameStatusesByTab.set(tabId, statuses);
    const aggregate = aggregateFrameStatuses(statuses);
    chrome.tabs.sendMessage(tabId, { type: "FRAME_STATUS_UPDATE", status: aggregate }, { frameId: 0 }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "ANSWER_ALL_FRAMES" && sender.tab?.id) {
    answerAllFrames(sender.tab.id)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "DIAGNOSE_ALL_FRAMES" && sender.tab?.id) {
    diagnoseAllFrames(sender.tab.id)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CHAOXING_FILL_TEXT" && sender.tab?.id) {
    // 在题目所在的 frame 主世界里执行：与 UEditor 同一 JS 域，插入走页面真实事件流，才能不被回滚
    const fillExecutor = async (payload) => {
      const norm = (value) => String(value ?? "").trim();
      const setNative = (textarea, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (setter) setter.call(textarea, value); else textarea.value = value;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const blankTextOf = (item) => {
        const value = norm(item.querySelector("textarea")?.value);
        if (value) return value;
        for (const frame of item.querySelectorAll("iframe")) {
          try {
            const text = norm(frame.contentDocument?.body?.textContent);
            if (text) return text;
          } catch {}
        }
        return "";
      };
      const ueOf = (blank) => {
        try {
          const UE = window.UE;
          if (UE && UE.instants) {
            for (const inst of Object.values(UE.instants)) {
              if (inst && (blank.contains(inst.container) || (inst.iframe && blank.contains(inst.iframe)))) return inst;
            }
          }
        } catch {}
        return null;
      };
      const results = [];
      for (const item of payload) {
        const qid = String(item.qid || "");
        const host = qid ? document.querySelector(`.singleQuesId[data="${qid}"]`) : null;
        if (!host) { results.push({ qid, ok: false, reason: "找不到题目节点" }); continue; }
        const blanks = [...host.querySelectorAll(".blankItemDiv, ul.Zy_ulTk > li")]
          .filter((node) => node.querySelector("textarea") || node.querySelector("iframe"));
        (item.blanks || []).forEach((value, index) => {
          const text = norm(value);
          const blank = blanks[index];
          if (!blank || !text) { results.push({ qid, blank: index, ok: false, reason: blank ? "空答案为空" : "空位节点缺失" }); return; }
          let ok = false;
          const existing = norm(blankTextOf(blank));
          if (existing) { results.push({ qid, blank: index, ok: true, skipped: true, value: existing.slice(0, 50) }); return; }
          const inst = ueOf(blank);
          if (inst?.setContent) {
            try { inst.setContent(text); inst.sync?.(); ok = norm(blankTextOf(blank)) === text; } catch {}
          }
          if (!ok) {
            for (const frame of blank.querySelectorAll("iframe")) {
              try {
                const doc = frame.contentDocument;
                const body = doc?.body;
                if (body && (body.isContentEditable || body.getAttribute("contenteditable") === "true")) {
                  body.focus();
                  const sel = doc.getSelection();
                  const range = doc.createRange();
                  range.selectNodeContents(body);
                  sel?.removeAllRanges();
                  sel?.addRange(range);
                  doc.execCommand("insertText", false, text);
                  if (norm(body.textContent) === text) { ok = true; break; }
                }
              } catch {}
            }
          }
          const textarea = blank.querySelector("textarea");
          if (textarea && norm(textarea.value) !== text) setNative(textarea, text);
          ok = ok || norm(blankTextOf(blank)) === text;
          results.push({ qid, blank: index, ok, value: norm(blankTextOf(blank)).slice(0, 50) });
        });
      }
      return { ok: true, results };
    };
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
      world: "MAIN",
      func: fillExecutor,
      args: [Array.isArray(message.payload) ? message.payload : []]
    }).then((results) => sendResponse(results?.[0]?.result || { ok: false, error: "主世界回填没有返回结果" }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CHAOXING_SUBMIT" && sender.tab?.id) {
    // 提交前在页面主世界做最终核验与补偿：以学习通自己维护的 .check_answer 高亮为选中态事实源，
    // 空白的填空/简答尝试补写（原生 setter + UEditor execCommand），仍为空的选项题只警告不拦截。
    const submitExecutor = async () => {
      const collectDocs = () => {
        const docs = [document];
        const walk = (root, depth) => {
          if (depth > 6 || !root) return;
          for (const frame of root.querySelectorAll("iframe")) {
            try {
              const doc = frame.contentDocument;
              if (doc && !docs.includes(doc)) { docs.push(doc); walk(doc, depth + 1); }
            } catch {}
          }
        };
        walk(document, 0);
        return docs;
      };
      const usable = (element) => {
        if (!element || element.disabled || element.getAttribute("aria-disabled") === "true") return false;
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
      };
      const findTextButton = (pattern) => [...document.querySelectorAll("button, a, [role=button], input[type=button], input[type=submit]")].find((element) => {
        const label = String(element.innerText || element.textContent || element.value || "").trim().replace(/\s+/g, " ");
        return pattern.test(label) && usable(element);
      });
      const blankTextOf = (item) => {
        const ta = item.querySelector("textarea");
        const value = String(ta?.value || "").trim();
        if (value) return value;
        for (const frame of item.querySelectorAll("iframe")) {
          try {
            const text = String(frame.contentDocument?.body?.textContent || "").trim();
            if (text) return text;
          } catch {}
        }
        return "";
      };
      const setNative = (textarea, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (setter) setter.call(textarea, value); else textarea.value = value;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const setRich = (blankDiv, value) => {
        for (const frame of blankDiv.querySelectorAll("iframe")) {
          try {
            const doc = frame.contentDocument;
            const body = doc?.body;
            if (body && (body.isContentEditable || body.getAttribute("contenteditable") === "true")) {
              body.focus();
              const sel = doc.getSelection();
              const range = doc.createRange();
              range.selectNodeContents(body);
              sel?.removeAllRanges();
              sel?.addRange(range);
              if (doc.execCommand("insertText", false, value) && String(body.textContent || "").trim()) return true;
            }
          } catch {}
        }
        return false;
      };
      const docs = collectDocs();
      const plans = [];
      let choiceQuestions = 0;
      for (const doc of docs) {
        if (!doc.querySelector(".TiMu,.newTiMu")) continue;
        const items = [];
        for (const q of doc.querySelectorAll(".TiMu,.newTiMu")) {
          const qtype = String(q.getAttribute("data") || "");
          const isChoice = qtype === "0" || qtype === "1";
          const checked = [...q.querySelectorAll("span.check_answer, span.check_answer_dx")].some((s) => s.getAttribute("data"));
          const blanks = [...q.querySelectorAll(".blankItemDiv, .Zy_ulTk > li")];
          const filledTexts = blanks.map(blankTextOf).filter(Boolean);
          if (isChoice) choiceQuestions += 1;
          items.push({ q, isChoice, checked, blanks, filledTexts });
        }
        plans.push({ doc, items });
      }
      if (!plans.length) return { ok: false, error: "没有找到可提交的学习通题目页" };
      // 补偿回填：复用题内其它空的已有值不可靠，只有页面窗口里可恢复的才补；这里仅对「有 InpDIV 但全空」的空跳过
      let fixedBlanks = 0;
      for (const { doc, items } of plans) {
        for (const item of items) {
          for (const blank of item.blanks) {
            if (blankTextOf(blank)) continue;
            const ta = blank.querySelector("textarea");
            const value = item.filledTexts.find((text) =>
              ![...item.blanks].slice(0, [...item.blanks].indexOf(blank)).some((b) => blankTextOf(b) === text)) || item.filledTexts[0];
            if (!value) continue;
            if (ta) { setNative(ta, value); fixedBlanks += 1; }
            else if (setRich(blank, value)) fixedBlanks += 1;
          }
        }
      }
      let unansweredChoice = 0;
      let unansweredText = 0;
      for (const { items } of plans) {
        for (const item of items) {
          if (item.isChoice && !item.checked) unansweredChoice += 1;
          if (!item.isChoice && item.blanks.length && !item.filledTexts.length) unansweredText += 1;
        }
      }
      const originalAlert = globalThis.alert;
      globalThis.alert = () => {};
      let method = "";
      try {
        if (typeof globalThis.btnBlueSubmit === "function") {
          await Promise.resolve(globalThis.btnBlueSubmit());
          method = "btnBlueSubmit";
        } else {
          const submit = document.querySelector(".btnBlueSubmit, [onclick*='btnBlueSubmit'], [onclick*='submitAnswer'], .submit-answer, button[type=submit]") ||
            findTextButton(/^(提交|提交答案|完成|交卷)$/);
          if (!usable(submit)) return { ok: false, error: "没有找到学习通提交入口" };
          submit.click();
          method = "button";
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
        if (typeof globalThis.submitCheckTimes === "function") {
          await Promise.resolve(globalThis.submitCheckTimes());
        } else {
          findTextButton(/^(确定|确认|确认提交)$/)?.click();
        }
        const notes = [];
        if (unansweredChoice) notes.push(`${unansweredChoice} 道选择/多选题未选中`);
        if (unansweredText) notes.push(`${unansweredText} 道填空/简答题为空`);
        return {
          ok: true, method, fixedBlanks,
          totalQuestions: plans.reduce((sum, p) => sum + p.items.length, 0),
          choiceQuestions, unansweredChoice, unansweredText,
          note: notes.length ? `注意：${notes.join("，")}，本次提交可能扣分` : ""
        };
      } finally {
        globalThis.alert = originalAlert;
      }
    };
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
      world: "MAIN",
      func: submitExecutor
    }).then((results) => sendResponse(results?.[0]?.result || { ok: false, error: "学习通提交没有返回结果" }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "FRAME_VIDEO_QUIZ_STATE" && sender.tab?.id) {
    const frames = activeVideoQuizFrames.get(sender.tab.id) || new Map();
    if (message.active) frames.set(sender.frameId ?? 0, Date.now());
    else frames.delete(sender.frameId ?? 0);
    if (frames.size) activeVideoQuizFrames.set(sender.tab.id, frames);
    else activeVideoQuizFrames.delete(sender.tab.id);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "HAS_ACTIVE_VIDEO_QUIZ" && sender.tab?.id) {
    const frames = activeVideoQuizFrames.get(sender.tab.id) || new Map();
    const now = Date.now();
    for (const [frameId, updatedAt] of frames) {
      if (now - updatedAt > VIDEO_QUIZ_STATE_TTL_MS) frames.delete(frameId);
    }
    if (!frames.size) activeVideoQuizFrames.delete(sender.tab.id);
    sendResponse({ ok: true, active: frames.size > 0, frameCount: frames.size });
    return false;
  }

  if (message?.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "AI_REQUEST") {
    requestAnswers(message.questions)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "REQUEST_NEXT" && sender.tab?.id) {
    const tabId = sender.tab.id;
    const lock = nextRequestLocks.get(tabId);
    if (lock?.inFlight || (lock?.succeededAt && Date.now() - lock.succeededAt < 500)) {
      sendResponse({ ok: true, method: "navigation:cooldown" });
      return false;
    }
    nextRequestLocks.set(tabId, { inFlight: true, succeededAt: lock?.succeededAt || 0 });
    chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: "MAIN",
      args: [message.nextSelector || ""],
      func: (customNextSelector) => {
        const usable = (element) => {
          if (!element || element.disabled || element.getAttribute("aria-disabled") === "true") return false;
          const style = getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
        };
        const normalize = (value) => String(value || "").trim().replace(/\s+/g, " ");
        const findIncompleteTaskDialog = () => {
          const goStudyButtons = [...document.querySelectorAll("button, a, [role=button]")].filter((element) =>
            /^(去学习|去完成|继续学习)$/.test(normalize(element.innerText || element.textContent)) && usable(element)
          );
          for (const button of goStudyButtons) {
            let node = button;
            for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
              const text = normalize(node.innerText || node.textContent);
              if (/当前章节.{0,80}(?:还有|存在|尚有).{0,40}任务点.{0,30}未完成.{0,40}是否去完成/.test(text)) {
                return { container: node, goStudyButton: button };
              }
            }
          }
          return null;
        };
        const hasIncompleteTaskMarker = () => {
          const selectors = [".ans-job-icon", ".ans-job-unfinished", "[data-task-status='unfinished']", "[data-status='incomplete']"];
          return selectors.some((selector) => [...document.querySelectorAll(selector)].some((element) => {
            if (!usable(element)) return false;
            const finished = element.matches(".ans-job-finished, .jobFinished, .jobFinish, [data-task-status='completed'], [data-status='finished']") ||
              element.closest(".ans-job-finished, .jobFinished, .jobFinish, [data-task-status='completed'], [data-status='finished']");
            return !finished;
          }));
        };
        if (hasIncompleteTaskMarker()) {
          return { ok: false, blocked: true, retryWhenComplete: true, method: "chaoxing:unfinished-task-marker", error: "当前任务点尚未完成，等待平台确认完成" };
        }
        const incompleteDialog = findIncompleteTaskDialog();
        if (incompleteDialog) {
          incompleteDialog.goStudyButton.click();
          return { ok: false, blocked: true, method: "chaoxing:incomplete-dialog", error: "平台提示当前章节仍有任务点未完成，已返回继续学习" };
        }
        const selectors = [
          customNextSelector,
          '[data-action="next"]', '[data-testid*="next"]', 'button[aria-label*="下一"]', 'a[aria-label*="下一"]',
          '.next-btn', '.btn-next', '.next-button', '.course-next', '.chapter-next', '#prevNextFocusNext', '.orientationright', '.nodeItem.r i'
        ];
        for (const selector of selectors) {
          if (!selector) continue;
          let candidate;
          try { candidate = document.querySelector(selector); } catch { continue; }
          if (usable(candidate)) {
            candidate.click();
            return { ok: true, method: `button:${selector}` };
          }
        }
        const textButton = [...document.querySelectorAll("button, a, [role=button]")].find((element) => {
          const label = (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ");
          return /^(下一节|下一课|下一章|下一个|继续学习|继续课程|next)$/i.test(label) && usable(element);
        });
        if (textButton) {
          textButton.click();
          return { ok: true, method: "button:text" };
        }

        const curCourseId = document.querySelector("#curCourseId");
        const curChapterId = document.querySelector("#curChapterId");
        const curClazzId = document.querySelector("#curClazzId");
        if (globalThis.PCount?.next && curCourseId?.value && curChapterId?.value && curClazzId?.value) {
          const count = document.querySelectorAll("#prev_tab .prev_ul li").length;
          globalThis._preChapterId = curChapterId.value;
          globalThis.PCount.next(String(count), curChapterId.value, curCourseId.value, curClazzId.value, "");
          return { ok: true, method: "chaoxing:PCount.next" };
        }

        const chapterNodes = [...document.querySelectorAll("#coursetree .posCatalog_select, .posCatalog_select")]
          .filter((node, index, all) => all.indexOf(node) === index);
        const activeIndex = chapterNodes.findIndex((node) => node.classList.contains("posCatalog_active") || node.querySelector(".posCatalog_active"));
        const chapterInfo = chapterNodes.map((node, index) => ({
          node,
          index,
          name: node.querySelector(".posCatalog_name"),
          unfinished: Boolean(node.querySelector(".jobUnfinishCount, .orangeNew"))
        })).filter((item) => item.name && usable(item.name));
        const laterUnfinished = chapterInfo.find((item) => item.index > activeIndex && item.unfinished);
        const nextSequential = chapterInfo.find((item) => item.index > activeIndex);
        const nextChapter = laterUnfinished || nextSequential || chapterInfo.find((item) => item.unfinished && item.index !== activeIndex);
        if (nextChapter?.name) {
          nextChapter.node.scrollIntoView?.({ block: "center" });
          nextChapter.name.click();
          return {
            ok: true,
            method: nextChapter.unfinished ? "chaoxing:unfinished-chapter" : "chaoxing:chapter-list",
            target: (nextChapter.name.getAttribute("title") || nextChapter.name.textContent || "").trim()
          };
        }
        const diagnostics = {
          host: location.hostname,
          chapterCount: chapterInfo.length,
          activeIndex,
          hasPCount: Boolean(globalThis.PCount?.next),
          customSelector: customNextSelector || ""
        };
        return { ok: false, error: "顶层页面未找到下一节入口", diagnostics };
      }
    }).then((results) => {
      const result = results?.[0]?.result || { ok: false, error: "顶层页面没有返回结果" };
      if (result.ok) nextRequestLocks.set(tabId, { inFlight: false, succeededAt: Date.now() });
      else nextRequestLocks.delete(tabId);
      sendResponse(result);
    }).catch((error) => {
      nextRequestLocks.delete(tabId);
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }
});
