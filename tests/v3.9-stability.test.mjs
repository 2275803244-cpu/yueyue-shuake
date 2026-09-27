// v3.9.0 集成测试：挂机更稳（卡播看门狗 / AI 退避 / 事件日志）、答得更准（单题重试 / 错题本）、
// 用得更省事（停止-继续 / 跳过本节 / 快捷键）、学得更多（课程进度 / 本节小结 / 上次学到哪一节）。
// 扩展版与脚本版跑同一套断言：直接抽取真实源码里的函数在 vm 里执行。
// 运行：node course-helper-extension/tests/v3.9-stability.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, URLSearchParams } from "node:url";
import path from "node:path";
import vm from "node:vm";

const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = [
  { label: "扩展版", file: "content.js", twin: false },
  { label: "脚本版", file: "userscript/yueyue-shuake.user.js", twin: true }
];

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// 从真实源码里按大括号配平抽出单个函数，避免测试复制一份逻辑
function extractFunction(source, name) {
  const pattern = new RegExp(`\\n  (?:async )?function ${name}\\(`);
  const start = source.search(pattern);
  if (start < 0) throw new Error(`源码里找不到函数 ${name}`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start + 1, index + 1);
    }
  }
  throw new Error(`函数 ${name} 的大括号没配平`);
}

// 抽一行式 const 箭头函数（扩展版的 readStore/writeStore）
function extractConst(source, name) {
  const match = source.match(new RegExp(`\\n  const ${name} = [^\\n]+`));
  if (!match) throw new Error(`源码里找不到 const ${name}`);
  return match[0].slice(1);
}

const NOW = 1750000000000;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeVideo(overrides = {}) {
  return {
    ended: false, paused: true, currentTime: 0, plays: 0, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    async play() { this.paused = false; this.plays += 1; },
    pause() { if (!this.paused) { this.paused = true; this.listeners.pause?.(); } },
    finish() { this.ended = true; this.paused = true; this.listeners.ended?.(); },
    ...overrides
  };
}

function makeOptionQuestion(index, optionTexts) {
  const optionElements = optionTexts.map((text, position) => ({
    text,
    element: { getAttribute: () => null, classList: { contains: () => false }, click() { this.clicked = true; } },
    control: { type: "radio", checked: false, click() { this.checked = !this.checked; } }
  }));
  return {
    index,
    container: { closest: () => null },
    optionElements,
    textControls: [],
    type: "single",
    payload: { question: index, type: "single", stem: `这是第 ${index + 1} 道题的题干内容`, options: optionTexts }
  };
}

// ---------- 通用沙箱：状态变量由脚本里的 let 声明，函数体是真实源码 ----------
function buildSandbox({ source, twin, functions, extraGlobals = "", globals = {}, document: documentStub, storage = {} }) {
  const win = { top: null };
  const sandbox = {
    console, JSON, Math, Object, Array, Number, String, Boolean, Set, Map, WeakSet, WeakMap, Promise, isNaN, RegExp, Error,
    Date: { now: () => NOW, ...Date },
    isTypingTargetTarget: undefined,
    window: win,
    location: { origin: "https://mooc1.chaoxing.com", href: "https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=42&chapterId=7", search: "?courseId=42&chapterId=7", pathname: "/mycourse/studentstudy", hostname: "mooc1.chaoxing.com" },
    innerWidth: 1200, innerHeight: 800,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    document: documentStub || { querySelectorAll: () => [], querySelector: () => null, title: "", body: { innerText: "" }, documentElement: { append() {} }, createElement: () => ({ style: {}, addEventListener() {}, remove() {} }) },
    normalizeText: (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim(),
    normalizeAnswerText: (value) => String(value == null ? "" : value).replace(/\s+/g, "").trim(),
    URL, URLSearchParams,
    isBlockingVideoQuiz: () => false,
    reportVideoQuizState() {},
    reportQuizHeartbeat() {},
    submitAnsweredQuestions: async () => { sandbox.__submits = (sandbox.__submits || 0) + 1; return { ok: false, error: "测试里不真的交卷" }; },
    buildAiConfig: () => ({}),
    floatingUi: undefined,
    publishStatus() {}, updateTask() {},
    scheduleOrchestrator() { sandbox.__scheduled = (sandbox.__scheduled || 0) + 1; },
    reportPlaybackState() {},
    ...globals
  };
  win.top = win;
  if (twin) {
    sandbox.IS_TOP = true;
    sandbox.store = {
      get: (key, fallback) => (key in storage ? storage[key] : fallback),
      set: (key, value) => { storage[key] = value; }
    };
    sandbox.GM_getValue = (key, fallback) => (key in storage ? storage[key] : fallback);
    sandbox.GM_setValue = (key, value) => { storage[key] = value; };
  } else {
    sandbox.chrome = {
      storage: { local: { get: async (key) => (key in storage ? { [key]: storage[key] } : {}), set: async (patch) => { Object.assign(storage, patch); } } },
      runtime: { sendMessage: async () => ({}) }
    };
  }
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const script = `
    let aiFailures = 0; let aiRetryNotBefore = 0; let eventLog = [];
    let failedQuestions = []; let userStopped = false; let stallWatch = null;
    let sectionStats = { href: "", chapter: "", startedAt: Date.now(), videos: 0, questions: 0 };
    const STALL_AFTER_MS = 90000; const STALL_GIVEUP_MS = 180000;
    ${functions}
    ${extraGlobals}
    globalThis.__state = () => ({ aiFailures, aiRetryNotBefore, eventLog, failedQuestions, userStopped, stallWatch, sectionStats });
  `;
  vm.runInContext(script, sandbox);
  sandbox.__state = sandbox.__state;
  return sandbox;
}

// ============================================================
// 1. 挂机更稳：AI 退避 + 事件日志
// ============================================================
async function testAiBackoffAndEventLog(target) {
  const { source, twin } = target;
  const fn = ["logEvent", "noteAiFailure", "noteAiSuccess"].map((name) => extractFunction(source, name)).join("\n");
  const sandbox = buildSandbox({ source, twin, functions: fn });
  const { noteAiFailure, noteAiSuccess, logEvent } = sandbox.__state ? vm.runInContext("({noteAiFailure, noteAiSuccess, logEvent})", sandbox) : {};
  check(`${target.label}：事件日志写入并截断到 40 条`, (() => {
    for (let index = 0; index < 55; index += 1) logEvent("test", `第 ${index} 条`);
    return sandbox.__state().eventLog.length === 40 && sandbox.__state().eventLog[39].message === "第 54 条";
  })());

  noteAiFailure("接口超时");
  const first = sandbox.__state();
  check(`${target.label}：首次失败退避 5 秒`, first.aiFailures === 1 && first.aiRetryNotBefore === NOW + 5000, JSON.stringify(first.aiRetryNotBefore - NOW));
  noteAiFailure("接口超时");
  noteAiFailure("接口超时");
  const third = sandbox.__state();
  check(`${target.label}：连续失败指数退避到 20 秒`, third.aiFailures === 3 && third.aiRetryNotBefore === NOW + 20000, String(third.aiRetryNotBefore - NOW));
  for (let index = 0; index < 10; index += 1) noteAiFailure("持续失败");
  check(`${target.label}：退避封顶 300 秒`, sandbox.__state().aiRetryNotBefore === NOW + 300000, String(sandbox.__state().aiRetryNotBefore - NOW));
  noteAiSuccess();
  check(`${target.label}：成功一次即清零退避`, sandbox.__state().aiFailures === 0 && sandbox.__state().aiRetryNotBefore === 0);
  void first; void third;
}

// ============================================================
// 2. 挂机更稳：卡播看门狗
// ============================================================
async function testStallWatchdog(target) {
  const { source, twin } = target;
  const fn = ["logEvent", "watchPlayback", "clearStallWatch", "checkStall"].map((name) => extractFunction(source, name)).join("\n");
  const video = makeVideo({ paused: false, currentTime: 30 });
  const messages = [];
  const videoTaskIds = new WeakMap();
  videoTaskIds.set(video, "video:1");
  const sandbox = buildSandbox({
    source, twin, functions: fn,
    globals: { videoTaskIds, updateTask: (id, patch) => messages.push(`task:${patch.detail}`), publishStatus: (patch) => messages.push(patch.message || "") }
  });
  const { watchPlayback, checkStall, clearStallWatch } = vm.runInContext("({watchPlayback, checkStall, clearStallWatch})", sandbox);

  watchPlayback(video);
  checkStall();
  check(`${target.label}：正常播放不动看门狗`, sandbox.__state().stallWatch?.recovered === false && messages.length === 0);

  video.currentTime = 45;
  checkStall();
  check(`${target.label}：进度推进后重置计时`, sandbox.__state().stallWatch.lastProgressTime === 45);

  sandbox.__state().stallWatch.lastCheck = NOW - 91000;
  checkStall();
  const afterStall = sandbox.__state().stallWatch;
  check(`${target.label}：90 秒无进度后诚实重试一次播放`, afterStall.recovered === true && video.plays === 1, `plays=${video.plays}`);
  check(`${target.label}：卡播时如实告知停住的秒数`, messages.some((item) => item.includes("30 秒")) || messages.some((item) => item.includes("45 秒")), JSON.stringify(messages));
  check(`${target.label}：看门狗不会伪造进度`, video.currentTime === 45);

  sandbox.__state().stallWatch.lastCheck = NOW - 181000;
  checkStall();
  const gaveUp = sandbox.__state().stallWatch;
  check(`${target.label}：再卡 180 秒后明确报自动恢复无效`, gaveUp.warned === true && gaveUp.recovered === true);
  check(`${target.label}：报错文案提示人工检查而不是假装在学`, messages.some((item) => String(item).includes("请手动检查页面")), JSON.stringify(messages.slice(-3)));
  check(`${target.label}：只恢复播放一次，不反复空转`, video.plays === 1, `plays=${video.plays}`);

  video.currentTime = 60;
  checkStall();
  check(`${target.label}：重新有进度即视为恢复`, sandbox.__state().stallWatch.lastProgressTime === 60);
  clearStallWatch(video);
  check(`${target.label}：结束后清空看门狗`, sandbox.__state().stallWatch === null);

  const paused = makeVideo({ paused: true, currentTime: 12 });
  watchPlayback(paused);
  sandbox.__state().stallWatch.lastCheck = NOW - 200000;
  checkStall();
  check(`${target.label}：暂停中的视频不算卡播`, sandbox.__state().stallWatch.warned === false);
}

// ============================================================
// 3. 答得更准：没填上的题单独重问 + 错题本
// ============================================================
async function testSingleQuestionRetry(target) {
  const { source, twin } = target;
  const fn = [
    "shortFingerprint", "applyAnswers", "answerQuestions", "logEvent",
    "noteAiFailure", "noteAiSuccess", "rememberFailedQuestions"
  ].map((name) => extractFunction(source, name)).join("\n");

  const questions = [makeOptionQuestion(0, ["北京", "上海", "广州"]), makeOptionQuestion(1, ["是", "否"])];
  const calls = [];
  const firstRound = {
    ok: true, cached: false, attempts: 1,
    answers: [
      { question: 0, choices: ["A"], choiceTexts: ["完全不存在的选项"] }, // 索引与原文都匹配不上
      { question: 1, choices: [0] }
    ]
  };
  const secondRound = { ok: true, cached: false, attempts: 1, answers: [{ question: 0, choices: [1], choiceTexts: ["上海"] }] };

  const ask = async (payload) => {
    calls.push(payload);
    return calls.length === 1 ? firstRound : secondRound;
  };

  const settings = { enabled: true, autoAnswer: true, autoSubmit: false, retryUnfilled: true };
  const storage = {};
  const sandbox = buildSandbox({
    source, twin, functions: fn,
    globals: {
      settings,
      quizInFlight: false,
      lastQuizFingerprint: "",
      lastQuizAttemptFingerprint: "",
      lastQuizAttemptAt: 0,
      lastFillReport: [],
      suspendVideoForQuiz: false,
      extractQuestions: async () => questions
    },
    document: { querySelectorAll: () => [], querySelector: () => null, title: "测验", body: { innerText: "" } },
    storage
  });
  if (twin) sandbox.requestAnswers = ask;
  else sandbox.chrome.runtime.sendMessage = async (message) => (message.type === "AI_REQUEST" ? ask(message.questions) : {});

  const { answerQuestions } = vm.runInContext("({answerQuestions})", sandbox);
  const result = await answerQuestions(true);
  await tick();

  check(`${target.label}：重问只发没填上的那一题`, calls.length === 2 && calls[1].length === 1 && calls[1][0].question === 0, JSON.stringify(calls.map((item) => item.length)));
  check(`${target.label}：重问带上失败原因给 AI`, typeof calls[1][0].hint === "string" && calls[1][0].hint.includes("匹配不上"), String(calls[1][0].hint).slice(0, 40));
  check(`${target.label}：重问后两题都填上`, result.filledCount === 2, JSON.stringify(result));
  check(`${target.label}：未填上的题进入本地错题本`, sandbox.__state().failedQuestions.length === 0, JSON.stringify(sandbox.__state().failedQuestions));

  // 第二次仍失败 → 记进错题本
  const broken = buildSandbox({
    source, twin, functions: fn,
    globals: {
      settings, quizInFlight: false, lastQuizFingerprint: "", lastQuizAttemptFingerprint: "", lastQuizAttemptAt: 0, lastFillReport: [],
      suspendVideoForQuiz: false, extractQuestions: async () => questions
    },
    document: { querySelectorAll: () => [], querySelector: () => null, title: "测验", body: { innerText: "" } }
  });
  const alwaysBad = async () => ({ ok: true, cached: false, attempts: 1, answers: [{ question: 0, choices: ["A"], choiceTexts: ["不存在"] }, { question: 1, choices: ["A"], choiceTexts: ["不存在"] }] });
  if (twin) broken.requestAnswers = alwaysBad;
  else broken.chrome.runtime.sendMessage = async (message) => (message.type === "AI_REQUEST" ? alwaysBad() : {});
  const badResult = await vm.runInContext("({answerQuestions})", broken).answerQuestions(true);
  check(`${target.label}：两轮都没填上则如实上报 0 题`, badResult.filledCount === 0, JSON.stringify(badResult));
  check(`${target.label}：反复失败的题被记进错题本`, broken.__state().failedQuestions.length === 2, JSON.stringify(broken.__state().failedQuestions.map((item) => item.stem)));
  check(`${target.label}：错题本记录了失败原因`, broken.__state().failedQuestions.every((item) => String(item.reason).length > 0));

  // 交卷仍然只由用户开关决定
  const autoOff = buildSandbox({
    source, twin, functions: fn,
    globals: {
      settings: { ...settings, autoSubmit: false }, quizInFlight: false, lastQuizFingerprint: "", lastQuizAttemptFingerprint: "",
      lastQuizAttemptAt: 0, lastFillReport: [], suspendVideoForQuiz: false,
      extractQuestions: async () => [makeOptionQuestion(0, ["甲", "乙"])]
    },
    document: { querySelectorAll: () => [], querySelector: () => null, title: "测验", body: { innerText: "" } }
  });
  const goodAsk = async () => ({ ok: true, cached: false, attempts: 1, answers: [{ question: 0, choices: [0] }] });
  if (twin) autoOff.requestAnswers = goodAsk;
  else autoOff.chrome.runtime.sendMessage = async (message) => (message.type === "AI_REQUEST" ? goodAsk() : {});
  const offResult = await vm.runInContext("({answerQuestions})", autoOff).answerQuestions(true);
  check(`${target.label}：普通题在「普通题提交」关闭时绝不交卷`, offResult.filledCount === 1 && (autoOff.__submits || 0) === 0, `submits=${autoOff.__submits || 0}`);

  const autoOn = buildSandbox({
    source, twin, functions: fn,
    globals: {
      settings: { ...settings, autoSubmit: true }, quizInFlight: false, lastQuizFingerprint: "", lastQuizAttemptFingerprint: "",
      lastQuizAttemptAt: 0, lastFillReport: [], suspendVideoForQuiz: false,
      extractQuestions: async () => [makeOptionQuestion(0, ["甲", "乙"])]
    },
    document: { querySelectorAll: () => [], querySelector: () => null, title: "测验", body: { innerText: "" } }
  });
  if (twin) autoOn.requestAnswers = goodAsk;
  else autoOn.chrome.runtime.sendMessage = async (message) => (message.type === "AI_REQUEST" ? goodAsk() : {});
  await vm.runInContext("({answerQuestions})", autoOn).answerQuestions(true);
  check(`${target.label}：用户自己开了提交才走交卷流程`, (autoOn.__submits || 0) === 1, `submits=${autoOn.__submits || 0}`);
}

// ============================================================
// 4. 用得更省事：快捷键护栏
// ============================================================
async function testShortcuts(target) {
  const { source, twin } = target;
  const fn = ["isTypingTarget", "handleShortcut"].map((name) => extractFunction(source, name)).join("\n");
  const hits = [];
  const sandbox = buildSandbox({
    source, twin, functions: fn,
    globals: {
      toggleStopSection: () => hits.push("stop"),
      skipCurrentChapter: () => hits.push("skip"),
      answerQuestions: () => hits.push("answer")
    }
  });
  if (!twin) sandbox.chrome.runtime.sendMessage = async (message) => { hits.push(message.type === "ANSWER_NOW" ? "answer" : message.type); return {}; };
  const { handleShortcut } = vm.runInContext("({handleShortcut})", sandbox);
  const press = (key, extra = {}, target = null) => {
    let prevented = false;
    handleShortcut({ key, altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, preventDefault: () => { prevented = true; }, target, ...extra });
    return prevented;
  };

  check(`${target.label}：Alt+Shift+S/N/A 分别对应停止、跳过、答题`, press("s") && press("n") && press("a") && hits.join(",") === "stop,skip,answer", hits.join(","));
  hits.length = 0;
  press("s", {}, { tagName: "INPUT", isContentEditable: false });
  press("n", {}, { tagName: "TEXTAREA", isContentEditable: false });
  press("a", {}, { tagName: "DIV", isContentEditable: true });
  check(`${target.label}：正在输入时快捷键不抢焦点`, hits.length === 0, hits.join(","));
  handleShortcut({ key: "s", altKey: true, shiftKey: false, preventDefault() {}, target: null });
  handleShortcut({ key: "q", altKey: true, shiftKey: true, preventDefault() {}, target: null });
  handleShortcut({ key: "s", altKey: true, shiftKey: true, ctrlKey: true, preventDefault() {}, target: null });
  check(`${target.label}：非 Alt+Shift 组合不触发`, hits.length === 0, hits.join(","));
}

// ============================================================
// 5. 用得更省事：停止 / 继续本节，跳过本节
// ============================================================
async function testStopAndSkip(target) {
  const { source, twin } = target;
  const messages = [];
  const storage = {};
  // 跳过本节要把 goNext(true) 记下来：脚本版可注入桩，扩展版把真实函数体里的调用换成记录器
  const skipBody = extractFunction(source, "skipCurrentChapter").replace(
    twin ? "await goNext(true);" : "await goNext(true);",
    "await globalThis.__recordGoNext(true);"
  );
  assert.match(skipBody, /__recordGoNext\(true\)/, "跳过本节必须走 goNext(true)");
  const fn = [extractFunction(source, "logEvent"), extractFunction(source, "toggleStopSection"), skipBody].join("\n");
  let goNextArg = "not-called";
  const sandbox = buildSandbox({
    source, twin, functions: fn, storage,
    document: { querySelectorAll: () => [], querySelector: () => null, title: "", body: { innerText: "" } },
    globals: {
      updateTask: (id, patch) => messages.push(`task:${patch.state}:${patch.detail}`),
      publishStatus: (patch) => messages.push(`${patch.phase}:${patch.message}`),
      reportPlaybackState() {}, clearStallWatch() {},
      __recordGoNext: async (force) => { goNextArg = force; },
      floatingUi: { stopButton: { textContent: "" } }
    }
  });
  const { toggleStopSection, skipCurrentChapter } = vm.runInContext("({toggleStopSection, skipCurrentChapter})", sandbox);

  toggleStopSection();
  check(`${target.label}：停止本节后置位停止标记`, sandbox.__state().userStopped === true);
  check(`${target.label}：停止本节立刻如实告知`, messages.some((item) => item.startsWith("stopped:")), JSON.stringify(messages));
  check(`${target.label}：面板按钮变成「继续本节」`, sandbox.floatingUi.stopButton.textContent === "继续本节", sandbox.floatingUi.stopButton.textContent);
  toggleStopSection();
  check(`${target.label}：再点一次恢复自动操作`, sandbox.__state().userStopped === false && sandbox.floatingUi.stopButton.textContent === "停止本节");
  check(`${target.label}：恢复后重新调度`, (sandbox.__scheduled || 0) === 1, String(sandbox.__scheduled));

  await skipCurrentChapter();
  check(`${target.label}：跳过本节走 goNext(true)`, goNextArg === true, String(goNextArg));
  check(`${target.label}：跳过本节记入事件日志`, sandbox.__state().eventLog.some((item) => item.message.includes("跳过本节")));
  check(`${target.label}：跳过本节有明确提示`, messages.some((item) => item.includes("正在跳到下一节")), JSON.stringify(messages.slice(-2)));

  // goNext(force) 的护栏：force 只绕过本地条件
  check(`${target.label}：goNext 支持 force 且不绕过本 frame 待播视频`, /async function goNext\(force = false\)/.test(source) && /if \(userStopped && !force\)/.test(source) && /if \(!force && pendingVideos\(\)\.length\) return;/.test(source));
  check(`${target.label}：force 也不会跳过「任务点未完成」确认`, /if \(hasVisibleIncompleteTaskMarker\(\)\)/.test(source) && /if \(handleIncompleteTaskDialog\(\)\) return;/.test(source));
  check(`${target.label}：停止本节会连带暂停正在播的视频`, /for \(const video of document\.querySelectorAll\("video"\)\) if \(!video\.paused && !video\.ended\) video\.pause\(\);/.test(extractFunction(source, "toggleStopSection")));
}

// ============================================================
// 6. 学得更多：课程进度 / 本节小结 / 上次学到哪一节
// ============================================================
async function testCourseProgress(target) {
  const { source, twin } = target;
  const storageFns = twin ? "" : `${extractConst(source, "readStore")}\n${extractConst(source, "writeStore")}`;
  const fn = ["courseKey", "chapterKey", "readCourseProgress", "syncSectionContext", "formatElapsed", "logEvent"].map((name) => extractFunction(source, name)).join("\n") + "\n" + storageFns;
  const messages = [];
  const storage = {};
  const makeNode = (text, { active = false, unfinished = false } = {}) => ({
    textContent: text,
    className: active ? "posCatalog_select posCatalog_active" : "posCatalog_select",
    classList: { contains: (name) => name === "posCatalog_active" && active },
    querySelector: (selector) => {
      if (selector.includes("posCatalog_name")) return { textContent: text };
      if (selector.includes("posCatalog_active")) return active ? { textContent: "" } : null;
      return unfinished ? { textContent: "1" } : null;
    }
  });
  const chapterNodes = [makeNode("第一章 导论"), makeNode("第二章 线性表", { active: true, unfinished: true }), makeNode("第三章 栈", { unfinished: true })];
  const sandbox = buildSandbox({
    source, twin, functions: fn, storage,
    document: {
      querySelectorAll: (selector) => (/posCatalog_select/.test(selector) ? chapterNodes : []),
      querySelector: () => null, title: "", body: { innerText: "" }
    },
    globals: { publishStatus: (patch) => messages.push(patch.message || "") }
  });
  const { readCourseProgress, syncSectionContext, formatElapsed } = vm.runInContext("({readCourseProgress, syncSectionContext, formatElapsed})", sandbox);

  const course = readCourseProgress();
  check(`${target.label}：读出课程章节总数与已完成数`, course && course.total === 3 && course.done === 1, JSON.stringify(course));
  check(`${target.label}：当前章节取最深的激活节点`, course?.chapter === "第二章 线性表", String(course?.chapter));

  const changed = syncSectionContext("第二章 线性表");
  await tick(); await tick();   // 扩展版读写 chrome.storage.local 是异步的
  check(`${target.label}：进入新章节时重置本节统计`, changed === true && sandbox.__state().sectionStats.href.includes("studentstudy"));
  sandbox.__state().sectionStats.videos = 2;
  sandbox.__state().sectionStats.questions = 5;
  check(`${target.label}：同一章节内不重复重置`, syncSectionContext("第二章 线性表") === false && sandbox.__state().sectionStats.videos === 2);
  check(`${target.label}：记住上次学到的章节`, storage[`courseProgress:42`]?.chapter === "第二章 线性表", JSON.stringify(storage));

  syncSectionContext("第三章 栈");
  await tick(); await tick();
  check(`${target.label}：下次进来提示上次学到哪一节`, messages.some((item) => item.includes("上次学到「第二章 线性表」")), JSON.stringify(messages));
  check(`${target.label}：换章后本节计数归零`, sandbox.__state().sectionStats.videos === 0 && sandbox.__state().sectionStats.questions === 0);
  check(`${target.label}：只提示不自动跳转`, !source.includes("syncSectionContext(courseProgress?.chapter || \"\")\n      goNext"));

  check(`${target.label}：本节计时格式正确`, formatElapsed(0) === "00:00" && formatElapsed(125000) === "02:05" && formatElapsed(3900000) === "1 小时 5 分", [formatElapsed(0), formatElapsed(125000), formatElapsed(3900000)].join("|"));

  // 面板与状态里确实带上了这两行
  check(`${target.label}：状态签名包含课程进度与本节小结`, /next\.courseProgress\?\.done/.test(source) && /next\.sectionStats\?\.videos/.test(source));
  check(`${target.label}：浮窗渲染课程进度与本节小结`, source.includes('class="c-count"') && source.includes('class="c-stat"') && source.includes("floatingUi.courseStat.textContent"));
  check(`${target.label}：非顶层 frame 不上报课程进度`, twin ? /if \(!IS_TOP\) return null;/.test(source) : /if \(window !== window\.top\) return null;/.test(source));
}

for (const target of TARGETS.map((item) => ({ ...item, source: readFileSync(path.join(extDir, item.file), "utf8") }))) {
  console.log(`\n[${target.label}：v3.9.0]`);
  await testAiBackoffAndEventLog(target);
  await testStallWatchdog(target);
  await testSingleQuestionRetry(target);
  await testShortcuts(target);
  await testStopAndSkip(target);
  await testCourseProgress(target);
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed) process.exitCode = 1;
