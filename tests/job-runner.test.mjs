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

function makeHarness(videos, overrides = {}) {
  let now = 1750000000000;
  const playCalls = [];
  const sandbox = {
    console, JSON, Math, Object, Array, Number, String, Boolean, Set, Map, WeakSet, WeakMap, Promise, RegExp, Error,
    Date: { now: () => now },
    location: { href: "https://mooc1.chaoxing.com/study?chapterId=1" },
    settings: { enabled: true, autoAnswer: false, autoReadDocuments: false, autoResume: true },
    document: { querySelectorAll: (selector) => selector === "video" ? videos : [] },
    ignoredVideos: new WeakSet(),
    failedDocumentReaders: new Set(),
    completedDocumentReaders: new Set(),
    ignoredQuizFingerprints: new Set(),
    completedQuizJobs: new Set(),
    videoTaskIds: new WeakMap(videos.map((video, index) => [video, `video:${index + 1}`])),
    activeJob: null,
    readyForNavigation: false,
    forceNextAfterFailure: false,
    userStopped: false,
    suspendVideoForQuiz: false,
    aiRetryNotBefore: 0,
    MAX_QUIZ_JOB_ATTEMPTS: 3,
    VIDEO_JOB_STALL_MS: 180000,
    playVideo: async (video) => { playCalls.push(video); video.paused = false; return true; },
    watchPlayback() {},
    anotherFramePlaying: async () => false,
    reportPlaybackState() {},
    reportVideoQuizState() {},
    clearStallWatch() {},
    completeDocumentReader: async () => false,
    answerQuestions: async () => ({ complete: false }),
    logEvent() {},
    updateTask() {},
    shortFingerprint: (value) => String(value.length),
    ...overrides
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const names = [
    "pendingVideos", "quizFingerprintFor", "discoverNextJob", "finishActiveJob",
    "failActiveJob", "runActiveJob"
  ];
  vm.runInContext(names.map(extractFunction).join("\n"), sandbox);
  return {
    sandbox,
    playCalls,
    advance(ms) { now += ms; },
    api: vm.runInContext("({ discoverNextJob, runActiveJob, pendingVideos })", sandbox)
  };
}

function makeVideo() {
  return {
    ended: false,
    paused: true,
    isConnected: true,
    currentTime: 0,
    pause() { this.paused = true; }
  };
}

test("执行器锁定一个视频，结束后才选择下一个", async () => {
  const first = makeVideo();
  const second = makeVideo();
  const { sandbox, playCalls, api } = makeHarness([first, second]);

  sandbox.activeJob = api.discoverNextJob({ questions: [], readers: [] });
  assert.equal(sandbox.activeJob.element, first);
  await api.runActiveJob({});
  assert.deepEqual(playCalls, [first]);
  assert.equal(sandbox.activeJob.element, first, "第一个视频未结束时不能切换任务");

  first.ended = true;
  await api.runActiveJob({});
  assert.equal(sandbox.activeJob, null);
  assert.equal(sandbox.readyForNavigation, true);

  sandbox.activeJob = api.discoverNextJob({ questions: [], readers: [] });
  assert.equal(sandbox.activeJob.element, second);
  await api.runActiveJob({});
  assert.deepEqual(playCalls, [first, second]);
});

test("视频超时后隔离故障任务并允许强制推进", async () => {
  const stalled = makeVideo();
  stalled.paused = false;
  const next = makeVideo();
  const { sandbox, playCalls, api } = makeHarness([stalled, next]);

  sandbox.activeJob = api.discoverNextJob({ questions: [], readers: [] });
  sandbox.activeJob.lastProgressAt -= 180001;
  await api.runActiveJob({});

  assert.equal(sandbox.activeJob, null);
  assert.equal(sandbox.ignoredVideos.has(stalled), true);
  assert.equal(stalled.paused, true);
  assert.equal(sandbox.forceNextAfterFailure, true);
  assert.equal(sandbox.readyForNavigation, true);
  assert.equal(playCalls.length, 0, "已确认超时后不应继续空转播放");
  const remaining = api.pendingVideos();
  assert.equal(remaining.length, 1, "故障视频不能再次进入队列");
  assert.equal(remaining[0], next);
});

test("测验完成后不再被重复选中，允许队列继续推进", async () => {
  const questions = [{ payload: { question: 0, type: "single", stem: "测试题", options: ["甲", "乙"] } }];
  let rounds = 0;
  const { sandbox, api } = makeHarness([], {
    settings: { enabled: true, autoAnswer: true, autoReadDocuments: false, autoResume: true },
    answerQuestions: async () => {
      rounds += 1;
      return rounds === 1 ? { complete: false, filledCount: 0 } : { complete: true, filledCount: 1 };
    }
  });

  sandbox.activeJob = api.discoverNextJob({ questions, readers: [] });
  assert.equal(sandbox.activeJob.kind, "quiz");
  await api.runActiveJob({ questions });
  assert.equal(sandbox.activeJob.kind, "quiz", "第一轮未完成时保留任务");
  assert.equal(sandbox.activeJob.attempts, 1);

  sandbox.advance?.(31001);
  sandbox.activeJob.nextAttemptAt = 0;
  await api.runActiveJob({ questions });
  assert.equal(sandbox.activeJob, null);
  assert.equal(sandbox.readyForNavigation, false, "普通测验完成后仍由平台完成状态决定翻页");
  assert.equal(api.discoverNextJob({ questions, readers: [] }), null, "已完成的测验不能被重复排队");
});
