// 验证码停手测试：
// 平台弹出验证码（如“（9010）操作异常，请输入图片中的验证码”）时，扩展版与脚本版都必须
// 暂停播放 / 答题 / 跳转，等用户手动完成后自动恢复；绝不代填、绝不绕过。
// 运行：node course-helper-extension/tests/captcha-pause.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
// goNext / orchestrate 内部有多段 await，先让微任务链跑到“排定时器”那一步，再冲刷定时器
async function settle(frame) { await tick(); await tick(); await frame.timers.flush(); await tick(); await tick(); }

function makeTimers() {
  const pending = [];
  let seq = 0;
  return {
    setTimeout(fn, ms) { const id = ++seq; pending.push({ id, fn, ms }); return id; },
    clearTimeout(id) { const i = pending.findIndex((item) => item.id === id); if (i >= 0) pending.splice(i, 1); },
    setInterval: () => 0,
    clearInterval: () => {},
    async flush() {
      const due = pending.splice(0, pending.length).sort((a, b) => a.ms - b.ms);
      for (const item of due) item.fn();
      await tick(); await tick();
    },
    get size() { return pending.length; }
  };
}

function makeVideo() {
  return {
    ended: false, paused: true, currentTime: 0, playbackRate: 1, muted: false, plays: 0, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    async play() { this.paused = false; this.plays += 1; },
    pause() { if (!this.paused) { this.paused = true; this.listeners.pause?.(); } },
    finish() { this.ended = true; this.paused = true; this.listeners.ended?.(); }
  };
}

// 只回答协调类消息的假后台：本测试关心的是“停手”，不关心仲裁细节
function makeFakeBackground() {
  const received = [];
  return {
    received,
    async dispatch(message, sender) {
      this.received.push({ frameId: sender?.frameId ?? 0, message });
      if (message?.type === "ANY_FRAMES_PENDING") return { ok: true, pending: 0, frameCount: 0 };
      if (message?.type === "PLAYBACK_ACTIVE_FRAME") return { ok: true, active: null, self: sender?.frameId ?? 0 };
      if (message?.type === "HAS_ACTIVE_VIDEO_QUIZ") return { ok: true, active: false, frameCount: 0 };
      return { ok: true };
    }
  };
}

// 页面状态由测试随时改写：正文文案 + 是否出现验证码控件
function makePageState(bodyText = "", captchaControls = []) {
  return { bodyText, captchaControls };
}

const EXPORTS = "{ guardCaptcha, detectCaptcha, playVideo, attach, pendingVideos, orchestrate, goNext }";

// ---------- 扩展版 ----------
function loadContentFrame(videos, background, state) {
  const source = readFileSync(path.join(extDir, "content.js"), "utf8");
  const timers = makeTimers();
  const messageListeners = [];
  const site = "site:https://mooc1.chaoxing.com";
  const sandbox = {
    console, URL, JSON, Math, Date, Promise, Number, String, Array, Object, Set, Map, WeakSet, WeakMap, Boolean, isNaN, RegExp, Error,
    Event: class {}, MutationObserver: class { observe() {} disconnect() {} },
    HTMLTextAreaElement: class {}, HTMLInputElement: class {},
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    location: { origin: "https://mooc1.chaoxing.com", href: "https://mooc1.chaoxing.com/mycourse/studentstudy" },
    innerWidth: 1200, innerHeight: 800,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    document: {
      documentElement: undefined,
      body: { get innerText() { return state.bodyText; } },
      title: "学生学习页面",
      querySelector: () => null,
      querySelectorAll: (selector) => {
        if (selector === "video") return videos;
        if (/captcha|yanzhengma|validate/i.test(selector)) return state.captchaControls;
        return [];
      }
    },
    window: {},
    chrome: {
      storage: {
        onChanged: { addListener() {} },
        local: {
          async get(key) { return key === site ? { [site]: { enabled: true, autoNext: true, autoResume: true, muted: true, playbackRate: 1, autoAnswer: false } } : {}; },
          async set() {}, async remove() {}
        }
      },
      runtime: {
        onMessage: { addListener: (fn) => messageListeners.push(fn) },
        sendMessage: (message) => background.dispatch(message, { tab: { id: 1, url: "https://mooc1.chaoxing.com/mycourse/studentstudy" }, frameId: 0 }),
        getURL: (value) => value
      },
      scripting: { executeScript: async () => [] },
      permissions: { contains: async () => true, request: async () => true }
    },
    __export: (mods) => { sandbox.__api = mods; }
  };
  sandbox.window.top = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const injected = source.replace(/\}\)\(\);(\s*)$/, `__export(${EXPORTS});$1})();`);
  if (injected === source) throw new Error("content.js 导出注入失败");
  vm.runInContext(injected, sandbox);
  return { sandbox, api: sandbox.__api, timers, videos, deliver: (message) => { for (const fn of messageListeners) fn(message, {}, () => {}); } };
}

function statusOf(background, phase) {
  return background.received.filter((item) => item.message?.type === "STATUS_UPDATE" && item.message?.status?.phase === phase);
}

// ---------- 脚本版 ----------
function loadTwinFrame(videos, state) {
  const source = readFileSync(path.join(extDir, "userscript/yueyue-shuake.user.js"), "utf8");
  const timers = makeTimers();
  const posted = [];
  const listeners = [];
  const win = {
    addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); },
    postMessage: (message) => posted.push(message),
    parent: null, top: null
  };
  win.top = win;
  win.parent = win;   // 顶层窗口里 window.parent 就是自己，postUp 才有落点
  const sandbox = {
    console, URL, JSON, Math, Date, Promise, Number, String, Array, Object, Set, Map, WeakSet, WeakMap, Boolean, isNaN, RegExp, Error,
    Event: class {}, MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    location: { origin: "https://mooc1.chaoxing.com", href: "https://mooc1.chaoxing.com/mycourse/studentstudy", hostname: "mooc1.chaoxing.com" },
    innerWidth: 1200, innerHeight: 800,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    document: {
      documentElement: null,
      body: { get innerText() { return state.bodyText; } },
      title: "学生学习页面",
      querySelector: () => null,
      querySelectorAll: (selector) => {
        if (selector === "video") return videos;
        if (/captcha|yanzhengma|validate/i.test(selector)) return state.captchaControls;
        return [];
      },
      createElement: () => ({ style: {}, select() {}, remove() {} })
    },
    window: win,
    GM_getValue: (key, fallback) => (key === "site:https://mooc1.chaoxing.com"
      ? { enabled: true, autoNext: true, autoResume: true, muted: true, playbackRate: 1, autoAnswer: false }
      : fallback),
    GM_setValue: () => {}, GM_deleteValue: () => {},
    GM_xmlhttpRequest: () => {}, GM_registerMenuCommand: () => {},
    unsafeWindow: win,
    __export: (mods) => { sandbox.__api = mods; }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // 脚本版结尾是 main() 的 catch 之后直接 })();，注入点与扩展版一致
  const injected = source.replace(/\}\)\(\);(\s*)$/, `__export(${EXPORTS});$1})();`);
  if (injected === source) throw new Error("userscript 导出注入失败");
  vm.runInContext(injected, sandbox);
  return { sandbox, api: sandbox.__api, timers, videos, posted };
}

async function testExtension() {
  console.log("\n[扩展版：验证码停手]");
  const state = makePageState();
  const background = makeFakeBackground();
  const frame = loadContentFrame([makeVideo()], background, state);
  await tick(); await tick();
  await frame.timers.flush();
  check("无验证码时正常起播", frame.videos[0].plays === 1 && !frame.videos[0].paused);

  state.bodyText = "（9010）操作异常，请输入图片中的验证码";
  check("识别出平台验证提示", frame.api.detectCaptcha() === "操作异常", frame.api.detectCaptcha());
  check("guardCaptcha 返回“已停手”", frame.api.guardCaptcha() === true);
  check("视频被暂停", frame.videos[0].paused === true);
  check("浮窗进入“需要手动验证”", statusOf(background, "paused").length >= 1);

  background.received.length = 0;
  await frame.api.orchestrate();
  await tick(); await tick();
  check("暂停期间 orchestrate 不发起跳转", !background.received.some((item) => item.message?.type === "REQUEST_NEXT"));
  check("暂停期间不重播视频", frame.videos[0].plays === 1 && frame.videos[0].paused);
  check("暂停期间不切到其他状态", !background.received.some((item) => item.message?.type === "STATUS_UPDATE" && item.message?.status?.phase !== "paused"));

  background.received.length = 0;
  frame.videos[0].ended = true;   // 本 frame 已无待播视频，只剩“能不能跳章”这一个判断
  const timersBefore = frame.timers.size;
  frame.api.goNext();   // 不 await：goNext 内部要等手动定时器，能否跳章看副作用
  await tick(); await tick();
  check("暂停期间 goNext 不跳转", !background.received.some((item) => item.message?.type === "REQUEST_NEXT"));
  check("暂停期间 goNext 只排重试", frame.timers.size === timersBefore + 1, `timers=${frame.timers.size}/${timersBefore}`);

  state.bodyText = "1. 中国的首都是哪座城市？（2分）";
  check("验证消失后 guardCaptcha 放行", frame.api.guardCaptcha() === false);
  check("浮窗提示验证已完成", statusOf(background, "playing").some((item) => /验证已完成/.test(item.message?.status?.message || "")));

  background.received.length = 0;
  frame.api.goNext();
  await settle(frame);
  check("恢复后 goNext 正常跳转", background.received.filter((item) => item.message?.type === "REQUEST_NEXT").length === 1);

  // 误报防护：题库文案里出现“验证码”三个字不算平台验证
  state.bodyText = "请简述你对验证码的理解（2分）";
  check("题干里的“验证码”不误判", frame.api.guardCaptcha() === false && frame.api.detectCaptcha() === "");
  state.bodyText = "";
  state.captchaControls = [{
    tagName: "IMG", src: "https://passport2.chaoxing.com/captcha.php?t=1", disabled: false,
    getAttribute: (name) => (name === "aria-disabled" ? null : null),
    getClientRects: () => [{}]
  }];
  check("验证码图片控件也算验证", frame.api.guardCaptcha() === true);
}

async function testTwin() {
  console.log("\n[脚本版：验证码停手]");
  const state = makePageState();
  const frame = loadTwinFrame([makeVideo()], state);
  await tick(); await tick();
  await frame.timers.flush();
  check("无验证码时正常起播", frame.videos[0].plays === 1 && !frame.videos[0].paused);

  state.bodyText = "（9010）操作异常，请输入图片中的验证码";
  check("识别出平台验证提示", frame.api.detectCaptcha() === "操作异常", frame.api.detectCaptcha());
  check("guardCaptcha 返回“已停手”", frame.api.guardCaptcha() === true);
  check("视频被暂停", frame.videos[0].paused === true);

  const lastStatus = [...frame.posted].reverse().find((message) => message?.type === "yy-status");
  frame.posted.length = 0;
  await frame.api.orchestrate();
  await tick(); await tick();
  check("暂停期间 orchestrate 不跳转", !frame.posted.some((message) => message?.type === "yy-next"));
  check("暂停期间不重播视频", frame.videos[0].plays === 1 && frame.videos[0].paused);
  check("暂停期间浮窗停在验证提示", lastStatus?.status?.phase === "paused", String(lastStatus?.status?.phase));

  frame.posted.length = 0;
  frame.videos[0].ended = true;   // 只剩“能不能跳章”这一个判断
  const twinTimersBefore = frame.timers.size;
  frame.api.goNext();
  await tick(); await tick();
  check("暂停期间 goNext 不跳转", !frame.posted.some((message) => message?.type === "yy-next"));
  check("暂停期间 goNext 只排重试", frame.timers.size === twinTimersBefore + 1, `timers=${frame.timers.size}/${twinTimersBefore}`);

  state.bodyText = "1. 中国的首都是哪座城市？（2分）";
  check("验证消失后 guardCaptcha 放行", frame.api.guardCaptcha() === false);
  check("浮窗提示验证已完成", frame.posted.some((message) => message?.type === "yy-status" && /验证已完成/.test(message.status?.message || "")));

  state.bodyText = "请简述你对验证码的理解（2分）";
  check("题干里的“验证码”不误判", frame.api.guardCaptcha() === false && frame.api.detectCaptcha() === "");
}

await testExtension();
await testTwin();
console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed) process.exitCode = 1;
