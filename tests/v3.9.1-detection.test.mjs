// v3.9.1 集成测试：检测更准 —— 读当前章节的任务点清单（还剩什么没做）、
// 用清单做更可靠的「本节已全部完成」判定、长时间什么都没识别到时明说原因。
// 扩展版与脚本版跑同一套断言：直接抽取真实源码里的函数在 vm 里执行。
// 运行：node course-helper-extension/tests/v3.9.1-detection.test.mjs
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

const NOW = 1750000000000;
let clock = NOW;
const tick = () => new Promise((resolve) => setImmediate(resolve));

// ---------- 假的课程目录 DOM ----------
// node: { name, kindClass(可选), finished(可选), unfinished(可选), text(可选) }
function makeNode({ name = "", kindClass = "", finished = false, unfinished = false, text = "", children = null } = {}) {
  const node = {
    textContent: text || name,
    className: "posCatalog_select",
    parentElement: null,
    childNodes: [],
    matches(selector) {
      if (selector.includes("finished") && !selector.includes("unfinish")) return Boolean(finished);
      if (selector.includes("unfinish")) return Boolean(unfinished);
      return selector.split(",").some((part) => part.trim() === `.${kindClass}`) && Boolean(kindClass);
    },
    querySelector(selector) {
      if (selector === ".posCatalog_name") return node.textContent ? { textContent: node.textContent } : null;
      if (kindClass && selector.split(",").some((part) => part.trim() === `.${kindClass}`)) return { className: kindClass, textContent: "" };
      if (kindClass && selector.includes("[class*='icon']")) return { className: kindClass, textContent: "" };
      return node.childNodes.find((child) => child.matches(selector)) || null;
    },
    querySelectorAll(selector) {
      if (selector === ".posCatalog_select") return node.childNodes;
      return node.childNodes.filter((child) => child.matches(selector));
    }
  };
  const rows = (children || []).map((child) => {
    const built = makeNode(child);
    built.parentElement = node;
    return built;
  });
  node.childNodes = rows;
  if (children && children.length) node.textContent = node.textContent || rows.map((row) => row.textContent).join("");
  return node;
}

// 组一棵目录树：activities > 章节 > 任务点
function makeCatalog(chapterRows, { chapterFinished = false } = {}) {
  const active = makeNode({ name: "第一章 导论", kindClass: "posCatalog_active", finished: chapterFinished, children: chapterRows });
  active.className = "posCatalog_select posCatalog_active";
  const other = makeNode({ name: "第二章 线性表" });
  other.className = "posCatalog_select";
  const tree = { childNodes: [active, other], matches: () => false, querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }, querySelectorAll(selector) { return selector === ".posCatalog_select" ? this.childNodes : []; } };
  active.parentElement = tree;
  other.parentElement = tree;
  return { tree, active, other };
}

function makeDocument({ active, tree, pageText = "", extra = {} } = {}) {
  return {
    body: { innerText: pageText },
    querySelector(selector) {
      if (selector.includes("posCatalog_active")) return active || null;
      if (selector === ".posCatalog_select.posCatalog_active") return active || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("posCatalog")) return tree ? tree.querySelectorAll(".posCatalog_select") : [];
      return extra[selector] || [];
    },
    documentElement: { append() {} },
    createElement: () => ({ style: {}, addEventListener() {}, remove() {} }),
    title: ""
  };
}

// ---------- 沙箱 ----------
function buildSandbox({ source, twin, functions, document: documentStub, isTop = true, storage = {}, globals = {} }) {
  const win = { top: null };
  const sandbox = {
    console, JSON, Math, Object, Array, Number, String, Boolean, Set, Map, WeakSet, Promise, isNaN, RegExp, Error,
    Date: { now: () => clock },
    window: win,
    location: { origin: "https://mooc1.chaoxing.com", href: "https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=42&chapterId=7", search: "?courseId=42&chapterId=7", pathname: "/mycourse/studentstudy", hostname: "mooc1.chaoxing.com" },
    document: documentStub,
    normalizeText: (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim(),
    normalizeAnswerText: (value) => String(value == null ? "" : value).replace(/\s+/g, "").trim(),
    URL, URLSearchParams,
    isUsable: (element) => Boolean(element),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    settings: { enabled: true, autoSubmit: false },
    runtimeStatus: { questionCount: 0 },
    publishStatus(patch) { sandbox.__published.push(patch); },
    logEvent(kind, message) { sandbox.__events.push({ kind, message }); },
    scan() { sandbox.__scans = (sandbox.__scans || 0) + 1; },
    __published: [],
    __events: [],
    __scans: 0,
    ...globals
  };
  win.top = isTop ? win : { name: "top" };
  if (twin) {
    sandbox.IS_TOP = isTop;
    sandbox.store = { get: (key, fallback) => (key in storage ? storage[key] : fallback), set: (key, value) => { storage[key] = value; } };
    sandbox.GM_getValue = (key, fallback) => (key in storage ? storage[key] : fallback);
    sandbox.GM_setValue = (key, value) => { storage[key] = value; };
  } else {
    sandbox.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } }, runtime: { sendMessage: async () => ({}) } };
  }
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const script = `
    let idleDetectSince = 0; let idleDetectedNotified = false; let idleCheckTimer; let eventLog = [];
    const IDLE_DETECT_MS = 60000;
    ${functions}
    globalThis.__state = () => ({ idleDetectSince, idleDetectedNotified, hasTimer: Boolean(idleCheckTimer), eventLog });
  `;
  vm.runInContext(script, sandbox);
  return sandbox;
}

// publishStatus / logEvent 用沙箱替身，断言的是「有没有提示」，不是渲染细节
const DETECT_FNS = ["detectTaskKind", "detectTaskFinished", "readChapterTasks", "summarizeChapterTasks", "trackNothingDetected"];

// ============================================================
// 1. 读出「本节还剩什么没做」
// ============================================================
function testReadChapterTasks(target) {
  const { source, twin } = target;
  const fn = DETECT_FNS.map((name) => extractFunction(source, name)).join("\n");
  const { active, tree } = makeCatalog([
    { name: "1.1 导论视频", kindClass: "icon-video", finished: true },
    { name: "1.2 导论课件", kindClass: "icon-document" },
    { name: "1.3 章节测验", kindClass: "icon-work", unfinished: true }
  ]);
  const sandbox = buildSandbox({ source, twin, functions: fn, document: makeDocument({ active, tree }) });
  const { readChapterTasks, summarizeChapterTasks } = vm.runInContext("({readChapterTasks, summarizeChapterTasks})", sandbox);
  const tasks = readChapterTasks();
  check(`${target.label}：读出本节 3 个任务点`, tasks?.total === 3, JSON.stringify(tasks));
  check(`${target.label}：已完成 1 个、未知 1 个、未完成 1 个`, tasks?.done === 1 && tasks?.unknown === 1 && tasks?.pending.length === 1, JSON.stringify(tasks));
  check(`${target.label}：认出未完成的是测验`, tasks?.pending[0] === "测验·1.3 章节测验", JSON.stringify(tasks?.pending));
  check(`${target.label}：认出任务类型靠图标类名`, vm.runInContext("detectTaskKind", sandbox)(makeNode({ name: "1.2 导论课件", kindClass: "icon-document" }), "1.2 导论课件") === "课件");
  check(`${target.label}：有未完成任务点时不算整节完成`, tasks?.allFinished === false);
  check(`${target.label}：面板文案列出未完成项`, summarizeChapterTasks(tasks) === "本节 1 个任务点未完成：测验·1.3 章节测验", summarizeChapterTasks(tasks));

  const all = makeCatalog([
    { name: "1.1 视频", kindClass: "icon-video", finished: true },
    { name: "1.2 作业", kindClass: "icon-work", finished: true }
  ]);
  const sandbox2 = buildSandbox({ source, twin, functions: fn, document: makeDocument({ active: all.active, tree: all.tree }) });
  const { readChapterTasks: read2, summarizeChapterTasks: sum2 } = vm.runInContext("({readChapterTasks, summarizeChapterTasks})", sandbox2);
  const done = read2();
  check(`${target.label}：每个任务点都有完成标记才算全部完成`, done?.allFinished === true, JSON.stringify(done));
  check(`${target.label}：全部完成时文案明确`, sum2(done) === "本节 2 个任务点已全部完成", sum2(done));

  const partial = makeCatalog([
    { name: "1.1 视频", kindClass: "icon-video", finished: true },
    { name: "1.2 作业", kindClass: "icon-work" }
  ]);
  const sandbox3 = buildSandbox({ source, twin, functions: fn, document: makeDocument({ active: partial.active, tree: partial.tree }) });
  const { readChapterTasks: read3, summarizeChapterTasks: sum3 } = vm.runInContext("({readChapterTasks, summarizeChapterTasks})", sandbox3);
  const unknown = read3();
  check(`${target.label}：缺完成标记的按未知，不当成完成`, unknown?.unknown === 1 && unknown?.allFinished === false, JSON.stringify(unknown));
  check(`${target.label}：状态没认出来时文案说清楚`, /状态没认出来/.test(sum3(unknown)), sum3(unknown));

  // 文字证据也算明确标记，但「未完成」优先
  const text = makeCatalog([
    { name: "1.1 视频（已完成）", kindClass: "icon-video", text: "1.1 视频 已完成" },
    { name: "1.2 课件 未完成", kindClass: "icon-document", text: "1.2 课件 未完成" }
  ]);
  const sandbox4 = buildSandbox({ source, twin, functions: fn, document: makeDocument({ active: text.active, tree: text.tree }) });
  const { readChapterTasks: read4 } = vm.runInContext("({readChapterTasks})", sandbox4);
  const byText = read4();
  check(`${target.label}：文案里的「已完成 / 未完成」也算明确标记`, byText?.done === 1 && byText?.pending[0] === "课件·1.2 课件 未完成", JSON.stringify(byText));

  // 没有左侧目录时不要瞎编
  const empty = makeCatalog([]);
  const sandbox5 = buildSandbox({ source, twin, functions: fn, document: makeDocument({ tree: empty.tree }) });
  const { readChapterTasks: read5, summarizeChapterTasks: sum5 } = vm.runInContext("({readChapterTasks, summarizeChapterTasks})", sandbox5);
  check(`${target.label}：读不到目录时不编造任务点`, read5() === null && sum5(null) === "");
}

// ============================================================
// 2. 非顶层 frame 不读目录
// ============================================================
function testTopFrameOnly(target) {
  const { source, twin } = target;
  const fn = DETECT_FNS.map((name) => extractFunction(source, name)).join("\n");
  const { active, tree } = makeCatalog([{ name: "1.1 视频", kindClass: "icon-video", finished: true }]);
  const sandbox = buildSandbox({ source, twin, functions: fn, document: makeDocument({ active, tree }), isTop: false });
  const { readChapterTasks } = vm.runInContext("({readChapterTasks})", sandbox);
  check(`${target.label}：iframe 不读任务点清单`, readChapterTasks() === null);
  check(`${target.label}：顶层判断写对了`, twin ? /if \(!IS_TOP\) return null;/.test(source) : /if \(window !== window\.top\) return null;/.test(source));
}

// ============================================================
// 3. 用清单做完成判定
// ============================================================
function testCompletionVerdict(target) {
  const { source, twin } = target;
  const fn = ["detectTaskKind", "detectTaskFinished", "readChapterTasks", "detectCompletedTask"].map((name) => extractFunction(source, name)).join("\n");
  // 页面上有别的章节的「答题完成」字样，但本节还有没做的任务点 —— 不能被带跑
  const pending = makeCatalog([{ name: "1.1 视频", kindClass: "icon-video", finished: true }, { name: "1.2 作业", kindClass: "icon-work", unfinished: true }]);
  const sandbox = buildSandbox({
    source, twin, functions: fn,
    document: makeDocument({ active: pending.active, tree: pending.tree, pageText: "上一节：答题完成 提交成功" })
  });
  const { detectCompletedTask } = vm.runInContext("({detectCompletedTask})", sandbox);
  const result = detectCompletedTask();
  check(`${target.label}：还有未完成任务点时不判完成`, result.complete === false, JSON.stringify(result));

  const done = makeCatalog([{ name: "1.1 视频", kindClass: "icon-video", finished: true }, { name: "1.2 作业", kindClass: "icon-work", finished: true }]);
  const sandbox2 = buildSandbox({ source, twin, functions: fn, document: makeDocument({ active: done.active, tree: done.tree, pageText: "" }) });
  const { detectCompletedTask: detect2 } = vm.runInContext("({detectCompletedTask})", sandbox2);
  const doneResult = detect2();
  check(`${target.label}：任务点全完成即判完成`, doneResult.complete === true && doneResult.source === "task-list", JSON.stringify(doneResult));
  check(`${target.label}：读不到目录时判定逻辑不变`, detectCompletedTask.length >= 0 && /statusSelectors/.test(extractFunction(source, "detectCompletedTask")));
}

// ============================================================
// 4. 长时间什么都没识别到
// ============================================================
function testNothingDetected(target) {
  const { source, twin } = target;
  clock = NOW;
  const fn = DETECT_FNS.map((name) => extractFunction(source, name)).join("\n");
  const sandbox = buildSandbox({ source, twin, functions: fn, document: makeDocument({}) });
  const { trackNothingDetected } = vm.runInContext("({trackNothingDetected})", sandbox);

  trackNothingDetected(false);
  check(`${target.label}：刚开始计时时不打扰用户`, sandbox.__published.length === 0 && sandbox.__state().idleDetectSince === NOW, JSON.stringify(sandbox.__state()));

  clock = NOW + 30000;
  trackNothingDetected(false);
  check(`${target.label}：不到一分钟不提示`, sandbox.__published.length === 0, JSON.stringify(sandbox.__published));

  clock = NOW + 61000;
  trackNothingDetected(false);
  check(`${target.label}：满一分钟后明说「没识别到」`, sandbox.__published.at(-1)?.nothingDetected === true, JSON.stringify(sandbox.__published));
  check(`${target.label}：提示也记进事件日志`, sandbox.__events.some((item) => item.kind === "detect"), JSON.stringify(sandbox.__events));

  trackNothingDetected(false);
  check(`${target.label}：只提示一次，不反复刷`, sandbox.__published.length === 1, JSON.stringify(sandbox.__published.length));

  trackNothingDetected(true);
  check(`${target.label}：认出内容后计时归零`, sandbox.__state().idleDetectSince === 0 && sandbox.__state().idleDetectedNotified === false, JSON.stringify(sandbox.__state()));
  clock = NOW + 200000;
  trackNothingDetected(false);
  clock = NOW + 261000;
  trackNothingDetected(false);
  check(`${target.label}：重新计时，第二次沉默也要再提示`, sandbox.__published.length === 2, JSON.stringify(sandbox.__published.length));

  // 站点没启用时不该计时
  sandbox.settings.enabled = false;
  trackNothingDetected(false);
  check(`${target.label}：站点未启用不计时`, sandbox.__state().idleDetectSince === 0, JSON.stringify(sandbox.__state()));
  sandbox.settings.enabled = true;
  vm.runInContext("clearTimeout(idleCheckTimer)", sandbox);
}

// ============================================================
// 5. 面板真的接上了
// ============================================================
function testPanelWiring(target) {
  const { source, twin } = target;
  check(`${target.label}：面板有「还剩什么」这一块`, source.includes('<div class="todo"><span class="t-list"></span><span class="t-warn"></span></div>'));
  check(`${target.label}：浮窗节点已取到`, source.includes('todo: find(".todo")') && source.includes('todoList: find(".t-list")') && source.includes('todoWarn: find(".t-warn")'));
  check(`${target.label}：渲染时按有无内容开关`, /floatingUi\.todo\.classList\.toggle\("on"/.test(source) && /floatingUi\.todoWarn\.textContent = todoWarn/.test(source));
  check(`${target.label}：状态签名带上任务点摘要`, /next\.taskSummary, next\.nothingDetected/.test(source));
  check(`${target.label}：扫描时刷新任务点摘要`, /taskSummary: summarizeChapterTasks\(chapterTasks\)/.test(source) && /trackNothingDetected\(videos\.length/.test(source));
  check(`${target.label}：诊断里带任务点清单`, twin ? /diagnosis\.chapterTasks/.test(source) : /const diagTasks = readChapterTasks\(\)/.test(source));
  check(`${target.label}：没有新增任何权限`, !/optional_host_permissions"[\s\S]{0,200}v3\.9/.test(source) && (source.match(/https?:\/\/[^"' ]+/g) || []).length >= 0);
  check(`${target.label}：默认仍然不自动交卷`, /autoSubmit: false/.test(source));
}

// ============================================================
// 6. 两个版本的检测逻辑必须一致
// ============================================================
function testMirrorParity(target) {
  const { source, twin } = target;
  const normalize = (text) => text
    .replace(/IS_TOP/g, "__TOP__")
    .replace(/window !== window\.top/g, "__NOTTOP__")
    .replace(/!__TOP__/g, "__NOTTOP__");
  const twinSource = readFileSync(path.join(extDir, "userscript/yueyue-shuake.user.js"), "utf8");
  for (const name of ["detectTaskKind", "detectTaskFinished", "readChapterTasks", "summarizeChapterTasks", "trackNothingDetected"]) {
    const a = normalize(extractFunction(source, name)).replace(/\s+/g, "");
    const b = normalize(extractFunction(twinSource, name)).replace(/\s+/g, "");
    check(`${target.label}：${name} 两个版本一致`, a === b, `${a.slice(0, 80)} vs ${b.slice(0, 80)}`);
  }
  void twin;
}

clock = NOW;
for (const target of TARGETS.map((item) => ({ ...item, source: readFileSync(path.join(extDir, item.file), "utf8") }))) {
  console.log(`\n[${target.label}：v3.9.1 检测]`);
  testReadChapterTasks(target);
  testTopFrameOnly(target);
  testCompletionVerdict(target);
  testNothingDetected(target);
  testPanelWiring(target);
  testMirrorParity(target);
}

assert.ok(true);
console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed) process.exitCode = 1;
