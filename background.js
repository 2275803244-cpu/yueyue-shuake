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

async function answerAllFrames(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const results = await Promise.all((frames || []).map(async ({ frameId }) => {
    try {
      return { frameId, response: await chrome.tabs.sendMessage(tabId, { type: "ANSWER_NOW", allFrames: true }, { frameId }) };
    } catch (error) {
      return { frameId, response: { ok: false, error: error.message } };
    }
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
    try {
      return { frameId, response: await chrome.tabs.sendMessage(tabId, { type: "DIAGNOSE_NOW" }, { frameId }) };
    } catch (error) {
      return { frameId, response: { ok: false, error: error.message } };
    }
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
  return '严格输出：{"answers":[{"question":0,"choices":[0],"choiceTexts":["选项原文"],"textAnswers":[""],"textAnswer":""}]}。选择题必须同时给出 choices 和 choiceTexts，并确保二者指向同一选项；多空填空题（题目带 blanks 数量）必须在 textAnswers 数组里按空顺序逐空给出答案，禁止把多个空的答案用顿号、斜杠合并进一个字符串；单空文本题填写 textAnswer。判断题将“对/正确/True/√”视为正确，将“错/错误/False/×”视为错误。';
}

async function chatCompletion(config, endpoint, headers, messages) {
  const maxAttempts = Math.max(1, Math.min(6, Number(config.retryCount ?? 2) + 1));
  const timeoutMs = Math.max(5000, Math.min(120000, Number(config.requestTimeoutMs || 30000)));
  const retryDelayMs = Math.max(200, Math.min(10000, Number(config.retryDelayMs || 1200)));
  const body = JSON.stringify({ model: config.model, temperature: 0.1, messages });
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

async function requestAnswers(questions) {
  const stored = await chrome.storage.local.get("aiConfig");
  const config = { ...DEFAULT_AI_CONFIG, ...(stored.aiConfig || {}) };
  if (!config.endpoint || !config.model) throw new Error("请先在“AI 接口设置”中填写接口地址和模型");

  const enhanceMode = config.enhanceMode !== false;
  const cacheKey = hashText(JSON.stringify({ v: 3, model: config.model, systemPrompt: config.systemPrompt || "", enhanceMode, questions }));
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  if (config.enableCache !== false) {
    const cachedStore = await chrome.storage.local.get("answerCache");
    const cached = cachedStore.answerCache?.[cacheKey];
    if (cached?.answers && Array.isArray(cached.answers) && Date.now() - (cached.at || 0) < CACHE_TTL_MS) {
      return { answers: cached.answers, cached: true, attempts: 0 };
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
  let answers;
  let attempts = 0;

  if (!enhanceMode) {
    const parsed = await chatCompletion(config, endpoint, headers, [
      { role: "system", content: `${config.systemPrompt || ""}\n${schemaRules}只依据题干与选项字面信息作答，不确定时选择最可能的选项。` },
      { role: "user", content: `请逐题回答并复核以下题目：\n${JSON.stringify(questions)}` }
    ]);
    attempts = 1;
    if (!Array.isArray(parsed.answers)) throw new Error("AI 返回 JSON 缺少 answers 数组");
    answers = parsed.answers;
  } else {
    const solveSystem = `${config.systemPrompt || ""}\n${schemaRules}只依据题干与选项字面信息作答，不确定时选择最可能的选项；多选题逐个选项独立判断，拿不准的选项不选；判断题警惕“都、一定、必须、所有”等绝对化表述。`;
    const verifySystem = `你是阅卷审核员。先独立解答题目，再与候选答案比对：一致就原样返回候选答案，不一致就返回你复核后的最终答案。${schemaRules}只输出 JSON，不要解释。`;
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

  if (message?.type === "CHAOXING_SUBMIT" && sender.tab?.id) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
      world: "MAIN",
      func: async () => {
        const usable = (element) => {
          if (!element || element.disabled || element.getAttribute("aria-disabled") === "true") return false;
          const style = getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
        };
        const findTextButton = (pattern) => [...document.querySelectorAll("button, a, [role=button], input[type=button], input[type=submit]")].find((element) => {
          const label = String(element.innerText || element.textContent || element.value || "").trim().replace(/\s+/g, " ");
          return pattern.test(label) && usable(element);
        });
        let method = "";
        const originalAlert = globalThis.alert;
        globalThis.alert = () => {};
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
          return { ok: true, method };
        } finally {
          globalThis.alert = originalAlert;
        }
      }
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
