import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");

function extractFunction(name) {
  const start = source.search(new RegExp(`\\n  (?:async )?function ${name}\\(`));
  if (start < 0) throw new Error(`找不到函数 ${name}`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n  (?:async )?function [A-Za-z_$][\w$]*\(/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function makeSandbox(overrides = {}) {
  const sandbox = {
    console, JSON, Math, Object, Array, Number, String, Boolean, Set, Map, WeakSet, WeakMap, Promise, RegExp, Error,
    document: { querySelector: () => null },
    window: { frameElement: null },
    ignoredVideos: new WeakSet(),
    readyForNavigation: false,
    logEvent() {},
    ...overrides
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const names = ["platformCompletion", "currentFrameJobId", "ignoreCompletedFrameVideo"];
  vm.runInContext(names.map(extractFunction).join("\n"), sandbox);
  return { sandbox, ...vm.runInContext("({ platformCompletion, ignoreCompletedFrameVideo })", sandbox) };
}

test("平台任务：已完成、未完成、进度满三种判定", () => {
  const { platformCompletion } = makeSandbox();

  const done = platformCompletion([
    { job: true, isPassed: true, module: "insertvideo", duration: 100, studyTotal: 0, name: "视频" }
  ]);
  assert.equal(done.complete, true);

  const halfway = platformCompletion([
    { job: true, isPassed: false, module: "insertvideo", duration: 100, studyTotal: 40, name: "视频" }
  ]);
  assert.equal(halfway.complete, false);

  const fullButNotPassed = platformCompletion([
    { job: true, isPassed: false, module: "insertvideo", duration: 100, studyTotal: 99, name: "视频" }
  ]);
  assert.equal(fullButNotPassed.complete, true, "进度已到末尾时不应因服务端 isPassed 延迟而重学");

  const pendingDoc = platformCompletion([
    { job: true, isPassed: false, module: "insertdoc", name: "课件" }
  ]);
  assert.equal(pendingDoc.complete, false);

  // 平台数据异常时不能抛错把整轮调度停掉
  assert.doesNotThrow(() => platformCompletion([null, {}, { job: true, isPassed: false }]));
  assert.equal(platformCompletion([null, {}]), null);
});

test("当前 frame 的视频平台已学完时不重播", () => {
  const video = { paused: false, ended: false };
  const { sandbox, ignoreCompletedFrameVideo } = makeSandbox({
    window: { frameElement: { getAttribute: () => JSON.stringify({ jobid: "job-1" }) } },
    document: { querySelector: (selector) => selector === "video" ? video : null }
  });
  const ignored = ignoreCompletedFrameVideo([
    { jobid: "job-1", job: true, isPassed: true, module: "insertvideo", duration: 100, studyTotal: 0 }
  ]);
  assert.equal(ignored, true);
  assert.equal(sandbox.ignoredVideos.has(video), true);
  assert.equal(sandbox.readyForNavigation, true);
});

test("当前 frame 与平台任务不匹配时不误跳过", () => {
  const video = { paused: false, ended: false };
  const { ignoreCompletedFrameVideo, platformCompletion } = makeSandbox({
    window: { frameElement: { getAttribute: () => JSON.stringify({ jobid: "job-2" }) } },
    document: { querySelector: () => video }
  });
  const ignored = ignoreCompletedFrameVideo([
    { jobid: "job-1", job: true, isPassed: true, module: "insertvideo", duration: 100, studyTotal: 0 }
  ]);
  assert.equal(ignored, false);
  const pending = platformCompletion([
    { job: true, isPassed: false, module: "insertvideo", duration: 100, studyTotal: 10 }
  ]);
  assert.equal(pending.complete, false);
});
