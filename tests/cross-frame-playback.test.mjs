// 跨 frame 播放协调集成测试：
// 扩展版用真实 background.js 仲裁 + 两个 content.js 沙箱（frame 0 / frame 2）；
// 脚本版用两个完整 userscript 沙箱 + postMessage 总线（顶层仲裁）。
// 运行：node course-helper-extension/tests/cross-frame-playback.test.mjs
import assert from "node:assert/strict";
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

// 两个沙箱与后台共用同一个假时钟，TTL / 避让窗口可确定推进
const clock = { now: 1750000000000 };
const fakeDate = { now: () => clock.now };
const tick = () => new Promise((resolve) => setImmediate(resolve));
// 先让微任务里的异步链跑完（ended → 查询后台 → goNext），再冲刷定时器（goNext 里的 900ms 等待）
async function settle(frame) { await tick(); await tick(); await frame.timers.flush(); await tick(); await tick(); }

function makeTimers() {
  const pending = [];
  const intervals = [];
  let seq = 0;
  return {
    setTimeout(fn, ms) { const id = ++seq; pending.push({ id, fn, ms }); return id; },
    clearTimeout(id) { const i = pending.findIndex((item) => item.id === id); if (i >= 0) pending.splice(i, 1); },
    setInterval(fn) { const id = ++seq; intervals.push({ id, fn }); return id; },
    clearInterval(id) { const i = intervals.findIndex((item) => item.id === id); if (i >= 0) intervals.splice(i, 1); },
    // 手动跑一遍已注册的 interval（播放心跳续租就靠它）
    runIntervals() { for (const item of intervals.slice()) item.fn(); },
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

// ---------- 扩展版：真实 background 仲裁 ----------
function loadBackground() {
  const source = readFileSync(path.join(extDir, "background.js"), "utf8");
  const listeners = [];
  const sent = [];
  const sandbox = {
    console, URL, JSON, Math, Date: fakeDate, Promise, Set, Map, Number, Boolean, String, Array, Object,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5)), clearTimeout, setInterval: () => 0, clearInterval: () => {},
    chrome: {
      action: { onClicked: { addListener() {} } },
      tabs: {
        onRemoved: { addListener() {} },
        sendMessage: (tabId, message, options) => { sent.push({ frameId: options?.frameId ?? 0, message }); return Promise.resolve(); }
      },
      webNavigation: { onCommitted: { addListener() {} }, getAllFrames: async () => [] },
      scripting: { executeScript: async () => [] },
      permissions: { contains: async () => true, request: async () => true },
      runtime: { onMessage: { addListener: (fn) => listeners.push(fn) }, openOptionsPage: async () => {}, sendMessage: async () => ({}) },
      storage: { onChanged: { addListener() {} }, local: { async get() { return {}; }, async set() {}, async remove() {} } }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    sent,
    // content 侧发来的 runtime 消息（含 frameId），用来观察“哪个 frame 发起了跳转”
    received: [],
    async dispatch(message, sender) {
      this.received.push({ frameId: sender?.frameId ?? 0, message });
      return new Promise((resolve) => {
        let settled = false;
        const sendResponse = (value) => { if (!settled) { settled = true; resolve(value); } };
        let keepAlive = false;
        for (const fn of listeners) {
          if (fn(message, sender, sendResponse) === true) { keepAlive = true; break; }
        }
        if (!keepAlive && !settled) resolve(undefined);
        setTimeout(() => { if (!settled) resolve({ __timeout: true }); }, 60);
      });
    }
  };
}

function loadContentFrame(frameId, videos, background) {
  const source = readFileSync(path.join(extDir, "content.js"), "utf8");
  const timers = makeTimers();
  const messageListeners = [];
  const site = "site:https://mooc1.chaoxing.com";
  const sandbox = {
    console, URL, JSON, Math, Date: fakeDate, Promise, Number, String, Array, Object, Set, Map, WeakSet, WeakMap, Boolean, isNaN,
    Event: class {}, MutationObserver: class { observe() {} disconnect() {} },
    HTMLTextAreaElement: class {}, HTMLInputElement: class {},
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    location: { origin: "https://mooc1.chaoxing.com", href: "https://mooc1.chaoxing.com/mycourse/studentstudy" },
    innerWidth: 1200, innerHeight: 800,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    document: {
      documentElement: undefined, body: { innerText: "" }, title: "学生学习页面",
      querySelector: () => null,
      querySelectorAll: (selector) => (selector === "video" ? videos : [])
    },
    window: {},
    chrome: {
      storage: {
        onChanged: { addListener() {} },
        local: {
          async get(key) { return key === site ? { [site]: { enabled: true, autoNext: true, autoResume: true, muted: true, playbackRate: 1 } } : {}; },
          async set() {}, async remove() {}
        }
      },
      runtime: {
        onMessage: { addListener: (fn) => messageListeners.push(fn) },
        sendMessage: (message) => background.dispatch(message, { tab: { id: 1, url: "https://mooc1.chaoxing.com/mycourse/studentstudy" }, frameId }),
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
  const injected = source.replace(
    /\}\)\(\);(\s*)$/,
    "__export({ playVideo, attach, pendingVideos, orchestrate, goNext, yieldPlayback, reportPlaybackState, pendingVideosAnywhere });$1})();"
  );
  if (injected === source) throw new Error("content.js 导出注入失败");
  vm.runInContext(injected, sandbox);
  const deliver = (message) => { for (const fn of messageListeners) fn(message, {}, () => {}); };
  return { frameId, sandbox, api: sandbox.__api, timers, deliver, videos };
}

async function testExtension() {
  console.log("\n[扩展版：跨 frame 播放协调]");
  const background = loadBackground();
  const frameA = loadContentFrame(0, [makeVideo()], background);
  const frameB = loadContentFrame(2, [makeVideo()], background);
  await tick(); await tick();

  await frameA.timers.flush();
  check("frame0 播放自己的视频", frameA.videos[0].plays === 1 && !frameA.videos[0].paused);

  await frameB.timers.flush();
  check("frame2 让位：不播放第二个视频", frameB.videos[0].plays === 0 && frameB.videos[0].paused, `plays=${frameB.videos[0].plays}`);

  frameA.videos[0].finish();
  await settle(frameA);
  const earlyNext = background.received.filter((item) => item.message?.type === "REQUEST_NEXT");
  check("frame0 视频结束但 frame2 还有视频：不发起跳转", earlyNext.length === 0, JSON.stringify(earlyNext.map((i) => i.message?.type)));

  clock.now += 3100;
  await frameB.api.orchestrate();
  await tick(); await tick();
  check("frame0 结束后 frame2 接管播放", frameB.videos[0].plays === 1 && !frameB.videos[0].paused);
  const yielded = background.sent.some((item) => item.frameId === 0 && item.message?.type === "PLAYBACK_YIELD");
  check("frame2 开播后通知 frame0 让位", yielded);

  frameB.videos[0].finish();
  await settle(frameB);
  const nextRequests = background.received.filter((item) => item.message?.type === "REQUEST_NEXT");
  check("两个 frame 的视频都结束后仅发起一次跳转", nextRequests.length === 1, JSON.stringify(nextRequests.map((i) => i.frameId)));
  check("跳转只由最后看完的 frame2 发起", nextRequests.length === 1 && nextRequests[0].frameId === 2);

  // 播放中被要求让位：本 frame 视频暂停且不再自动重播
  const background2 = loadBackground();
  const solo = loadContentFrame(0, [makeVideo()], background2);
  const other = loadContentFrame(5, [makeVideo()], background2);
  await tick(); await tick();
  await solo.timers.flush();
  check("第二个场景：frame0 正常起播", solo.videos[0].plays === 1);
  await other.timers.flush();
  await other.api.orchestrate();
  await other.api.orchestrate();
  await tick();
  check("frame5 在别人播放时反复调度也不起播", other.videos[0].plays === 0, `plays=${other.videos[0].plays}`);
  solo.videos[0].finish();
  await settle(solo);
  clock.now += 3100;
  await other.api.orchestrate();
  await tick(); await tick();
  check("frame0 结束后 frame5 恢复播放", other.videos[0].plays === 1 && !other.videos[0].paused);
  const yieldToSolo = background2.sent.filter((item) => item.frameId === 0 && item.message?.type === "PLAYBACK_YIELD");
  check("frame5 开播后后台通知 frame0 让位", yieldToSolo.length >= 1);
  other.videos[0].finish();
  await settle(other);
  const soloNext = background2.received.filter((item) => item.message?.type === "REQUEST_NEXT");
  check("frame5 看完后由 frame5 跳转（frame0 未再看视频）", soloNext.length === 1 && soloNext[0].frameId === 5, JSON.stringify(soloNext.map((i) => i.frameId)));

  // 场景三：播放租约的 4 秒有效期与心跳续租
  const background3 = loadBackground();
  const third = loadContentFrame(0, [makeVideo()], background3);
  const fourth = loadContentFrame(3, [makeVideo()], background3);
  await tick(); await tick();
  await third.timers.flush();
  await fourth.timers.flush();
  check("场景三：frame0 起播、frame3 让位", third.videos[0].plays === 1 && fourth.videos[0].plays === 0);
  clock.now += 4200;
  third.timers.runIntervals();
  await fourth.api.orchestrate();
  await tick(); await tick();
  check("播放心跳续租：跨过租约有效期也不被抢播", fourth.videos[0].plays === 0, `plays=${fourth.videos[0].plays}`);
  clock.now += 4200;
  await fourth.api.orchestrate();
  await tick(); await tick();
  check("停止心跳后租约过期，其他 frame 可接管", fourth.videos[0].plays === 1 && !fourth.videos[0].paused, `plays=${fourth.videos[0].plays}`);
}

// ---------- 脚本版：两个完整沙箱 + postMessage 总线 ----------
function loadTwinFrame({ isTop, videos, parentWindow, childWindows, timers, settings }) {
  const source = readFileSync(path.join(extDir, "userscript/yueyue-shuake.user.js"), "utf8");
  const listeners = [];
  const win = {
    addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); },
    postMessage: (message) => { for (const fn of listeners) fn({ data: message }); },
    parent: parentWindow, top: isTop ? null : parentWindow
  };
  win.top = isTop ? win : parentWindow.top;
  const document = {
    documentElement: null, body: { innerText: "" }, title: "学生学习页面",
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector === "video") return videos;
      if (selector === "iframe") return childWindows.map((child) => ({ contentWindow: child }));
      return [];
    },
    createElement: () => ({ style: {}, select() {}, remove() {} })
  };
  const sandbox = {
    console, URL, JSON, Math, Date: fakeDate, Promise, Number, String, Array, Object, Set, Map, WeakSet, WeakMap, Boolean, isNaN, RegExp, Error,
    Event: class {}, MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    location: { origin: "https://mooc1.chaoxing.com", href: "https://mooc1.chaoxing.com/mycourse/studentstudy", hostname: "mooc1.chaoxing.com" },
    innerWidth: 1200, innerHeight: 800,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    document,
    window: win,
    GM_getValue: (key, fallback) => (key === "site:https://mooc1.chaoxing.com" ? settings : fallback),
    GM_setValue: () => {}, GM_deleteValue: () => {},
    GM_xmlhttpRequest: () => {}, GM_registerMenuCommand: () => {},
    unsafeWindow: win,
    __export: (mods) => { sandbox.__api = mods; }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const injected = source.replace(
    /\}\)\(\);(\s*)$/,
    "__export({ playVideo, attach, pendingVideos, orchestrate, goNext, yieldPlayback, reportPlaybackState, pendingVideosAnywhere });$1})();"
  );
  if (injected === source) throw new Error("userscript 导出注入失败");
  vm.runInContext(injected, sandbox);
  return { win, sandbox, api: sandbox.__api, timers, videos };
}

async function testTwin() {
  console.log("\n[脚本版：跨 frame 播放协调]");
  const twinSettings = { enabled: true, autoNext: true, autoResume: true, muted: true, playbackRate: 1 };
  const topTimers = makeTimers();
  const childTimers = makeTimers();
  const top = loadTwinFrame({ isTop: true, videos: [makeVideo()], parentWindow: null, childWindows: [], timers: topTimers, settings: twinSettings });
  const child = loadTwinFrame({ isTop: false, videos: [makeVideo()], parentWindow: top.win, childWindows: [], timers: childTimers, settings: twinSettings });
  top.win.top = top.win;
  // 顶层广播只触达直接子 iframe
  const childRefs = [child.win];
  top.sandbox.document.querySelectorAll = (selector) => {
    if (selector === "video") return top.videos;
    if (selector === "iframe") return childRefs.map((win) => ({ contentWindow: win }));
    return [];
  };
  await tick(); await tick();

  await top.timers.flush();
  check("顶层播放自己的视频", top.videos[0].plays === 1 && !top.videos[0].paused);

  await child.timers.flush();
  check("iframe 让位：不播放第二个视频", child.videos[0].plays === 0 && child.videos[0].paused, `plays=${child.videos[0].plays}`);

  top.videos[0].finish();
  await tick(); await tick();
  check("顶层视频结束但 iframe 还有视频：不跳转", top.api.pendingVideosAnywhere() === true);

  clock.now += 3100;
  await child.api.orchestrate();
  await tick(); await tick();
  check("顶层结束后 iframe 接管播放", child.videos[0].plays === 1 && !child.videos[0].paused);

  child.videos[0].finish();
  await tick(); await tick();
  check("两个 frame 都看完后不再有未完成视频", top.api.pendingVideosAnywhere() === false && child.api.pendingVideosAnywhere() === false);
  const before = child.api.pendingVideos().length;
  check("iframe 侧已无待播视频", before === 0);
}

await testExtension();
await testTwin();
console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed) process.exitCode = 1;
