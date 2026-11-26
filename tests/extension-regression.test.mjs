import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const contentSource = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
const backgroundSource = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.search(new RegExp(`\\n  (?:async )?function ${name}\\(`));
  if (start < 0) throw new Error(`找不到函数 ${name}`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return source.slice(start + 1, index + 1);
  }
  throw new Error(`函数 ${name} 的大括号未配平`);
}

test("扩展版：未填完会保留自动重试资格，成功后才跳过同题", async () => {
  const names = [
    "shortFingerprint", "applyAnswers", "answerQuestions", "logEvent",
    "noteAiFailure", "noteAiSuccess", "rememberFailedQuestions"
  ];
  const question = {
    container: { closest: () => null },
    optionElements: [{
      text: "甲",
      element: { getAttribute: () => null, classList: { contains: () => false }, click() {} },
      control: { type: "radio", checked: false, click() { this.checked = true; } }
    }],
    textControls: [],
    type: "single",
    payload: { question: 0, type: "single", stem: "一道用于回归测试的题目", options: ["甲"] }
  };
  let now = 1750000000000;
  let calls = 0;
  let answerMode = "bad";
  const sandbox = {
    console, JSON, Math, Object, Array, Number, String, Boolean, Set, Map, Promise, RegExp, Error,
    Date: { now: () => now },
    settings: { enabled: true, autoAnswer: true, autoSubmit: false, retryUnfilled: true },
    quizInFlight: false,
    lastQuizFingerprint: "",
    lastQuizAttemptFingerprint: "",
    lastQuizAttemptAt: 0,
    lastFillReport: [],
    suspendVideoForQuiz: false,
    failedQuestions: [],
    sectionStats: { questions: 0 },
    eventLog: [],
    aiFailures: 0,
    aiRetryNotBefore: 0,
    extractQuestions: async () => [question],
    buildAiConfig: () => ({}),
    isBlockingVideoQuiz: () => false,
    reportVideoQuizState() {},
    publishStatus() {},
    updateTask() {},
    normalizeText: (value) => String(value ?? "").trim(),
    normalizeAnswerText: (value) => String(value ?? "").trim(),
    document: { querySelectorAll: () => [] },
    chrome: {
      storage: { local: { get: async () => ({}) } },
      runtime: {
        sendMessage: async () => {
          calls += 1;
          return answerMode === "good"
            ? { ok: true, answers: [{ question: 0, choices: [0] }] }
            : { ok: true, answers: [{ question: 0, choices: ["A"], choiceTexts: ["不存在"] }] };
        }
      }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(names.map((name) => extractFunction(contentSource, name)).join("\n"), sandbox);
  const answerQuestions = vm.runInContext("answerQuestions", sandbox);

  const first = await answerQuestions(true);
  assert.equal(first.filledCount, 0);
  const callsAfterFirst = calls;

  now += 31000;
  const second = await answerQuestions(false);
  assert.notEqual(second.skipped, true, "未填完的同题不应被永久跳过");
  assert.ok(calls > callsAfterFirst, "超过防重窗口后应再次请求 AI");

  answerMode = "good";
  now += 31000;
  const third = await answerQuestions(false);
  assert.equal(third.filledCount, 1);
  const callsAfterSuccess = calls;
  const fourth = await answerQuestions(false);
  assert.equal(fourth.skipped, true, "成功填完后仍应跳过重复请求");
  assert.equal(calls, callsAfterSuccess);
});

test("扩展版：顶层导航立即清除旧视频状态和播放租约", async () => {
  let onCommitted;
  let onMessage;
  const chrome = {
    action: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener(listener) { onMessage = listener; } } },
    tabs: { onRemoved: { addListener() {} }, sendMessage: () => Promise.resolve({}) },
    webNavigation: { onCommitted: { addListener(listener) { onCommitted = listener; } } },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    permissions: { contains: async () => true },
    scripting: { executeScript: async () => [] }
  };
  const context = {
    chrome, console, URL, Date, Map, Set, Promise,
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    fetch: async () => { throw new Error("测试不应发起网络请求"); }
  };
  vm.createContext(context);
  vm.runInContext(backgroundSource, context);
  const send = (message, sender = { tab: { id: 7 }, frameId: 0 }) =>
    new Promise((resolve) => onMessage(message, sender, resolve));

  await send({ type: "FRAME_PLAYBACK_STATE", pending: 1, playing: true }, { tab: { id: 7 }, frameId: 2 });
  onCommitted({ tabId: 7, frameId: 0 });

  const pending = await send({ type: "ANY_FRAMES_PENDING" });
  const active = await send({ type: "PLAYBACK_ACTIVE_FRAME" });
  assert.equal(pending.pending, 0, "新页面不应继承旧页面的待播视频");
  assert.equal(active.active, null, "新页面不应继承旧页面的播放租约");
});
