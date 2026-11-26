import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

for (const file of ["../content.js", "../userscript/yueyue-shuake.user.js"]) {
  const isExtension = file.endsWith("content.js");
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const playback = source.slice(source.indexOf("  function pendingVideos()"), source.indexOf("  async function goNext", source.indexOf("  function pendingVideos()")));
  const attachStart = source.indexOf("  function attach(video)");
  const attachEnd = source.indexOf("\n  // ----------", attachStart);
  const playEnd = playback.indexOf("\n  function attach(video)");
  const functions = (playEnd < 0 ? playback : playback.slice(0, playEnd)) + source.slice(attachStart, attachEnd);
  const timers = [];
  let timerSeq = 0;
  const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
  let navigation = 0;
  let scheduled = 0;
  const makeVideo = () => ({
    ended: false, paused: true, currentTime: 0, plays: 0, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    async play() { this.paused = false; this.plays++; },
    pause() { if (!this.paused) { this.paused = true; this.listeners.pause?.(); } },
    finish() { this.ended = true; this.paused = true; this.listeners.ended?.(); }
  });
  const videos = [makeVideo(), makeVideo()];
  const sandbox = {
    document: { querySelectorAll: () => videos },
    settings: { enabled: true, autoResume: true, muted: true, playbackRate: 1 },
    suspendVideoForQuiz: false, intentionalPauseUntil: 0,
    // 跨 frame 播放协调引入的状态与依赖（沙箱只跑同文档串行这一段）
    playbackYieldUntil: 0, playbackStateReportedAt: 0, playbackHeartbeatTimer: undefined, myFrameId: 0, peerActiveFrame: "", frameId: 0,
    yieldPlayback() {}, reportPlaybackState() {}, pendingVideosAnywhere() { return false; },
    // v3.9.0 看门狗 / 手动停止：沙箱里只提供桩，行为由专门测试覆盖
    userStopped: false, sectionStats: { videos: 0, questions: 0 },
    watchPlayback() {}, clearStallWatch() {}, stallWatch: null,
    chrome: { runtime: { sendMessage: async () => ({}) } },
    observedVideos: new WeakSet(), videoTaskIds: new WeakMap(), videoSequence: 0,
    ignoredVideos: new WeakSet(), activeJob: null, readyForNavigation: false,
    scheduleOrchestrator() { scheduled++; },
    updateTask() {}, publishStatus() {}, goNext() { navigation++; },
    setTimeout(fn) { const id = ++timerSeq; timers.push({ id, fn }); return id; },
    clearTimeout(id) { const index = timers.findIndex((item) => item.id === id); if (index >= 0) timers.splice(index, 1); },
    setInterval: () => 0, clearInterval: () => {}, Date, console
  };
  vm.createContext(sandbox);
  vm.runInContext(functions + "\nglobalThis.api = {playVideo, attach, pendingVideos};", sandbox);
  const { api } = sandbox;
  videos.forEach(api.attach);
  await Promise.all(videos.map(api.playVideo));
  assert.equal(videos[0].plays, 1);
  assert.equal(videos[1].plays, 0, "second video must not start concurrently");
  videos[1].paused = false;
  await api.playVideo(videos[0]);
  assert.equal(videos[1].paused, true);
  // v3.9.20 起 anotherFramePlaying() 用 setTimeout 给跨 frame 消息兜底（函数体是 resolve(null)），
  // 这类超时定时器不是重试。这里只断言「没有排重试」，不看超时兜底。
  const retryTimers = timers.filter((item) => !/resolve\(null\)/.test(String(item.fn)));
  assert.equal(retryTimers.length, 0, "queued pause must not schedule a competing retry");
  if (isExtension) {
    // 视频播完时尚未被锁定为 activeJob，仍必须置位翻页标记，否则整节停在已完成页面。
    videos[0].finish();
    await flush();
    assert.equal(sandbox.readyForNavigation, true, "无 activeJob 的 ended 也要置位翻页标记");
    assert.equal(scheduled, 1, "无 activeJob 的 ended 也要唤醒执行器");
    videos[0].ended = false;
    sandbox.readyForNavigation = false;
    scheduled = 0;
  }
  if (isExtension) sandbox.activeJob = { kind: "video", element: videos[0] };
  videos[0].finish();
  await flush();
  if (isExtension) {
    assert.equal(videos[1].plays, 0, "视频 ended 不再绕过执行器直接启动下一个");
    assert.equal(navigation, 0, "first ended must not navigate");
    assert.equal(sandbox.activeJob, null);
    assert.equal(sandbox.readyForNavigation, true);
    assert.equal(scheduled, 1, "ended 只唤醒执行器");
  } else {
    assert.equal(videos[1].plays, 1, "first ended hands playback to the second video");
    assert.equal(navigation, 0, "first ended must not navigate");
  }
  if (isExtension) sandbox.activeJob = { kind: "video", element: videos[1] };
  videos[1].finish();
  await flush();
  if (isExtension) assert.equal(navigation, 0, "最后一个视频 ended 也只汇报，不独立翻页");
  else assert.equal(navigation, 1, "本 frame 最后一个视频结束后才跳转，且只跳一次");
  videos[0].ended = false;
  sandbox.playbackYieldUntil = Date.now() + 3000;
  const duringYield = videos[0].plays;
  await api.playVideo(videos[0]);
  assert.equal(videos[0].plays, duringYield, "让位窗口内不抢播");
  sandbox.playbackYieldUntil = 0;
  sandbox.settings.enabled = false;
  const before = videos[0].plays;
  await api.playVideo(videos[0]);
  assert.equal(videos[0].plays, before, "disabled site stays disabled");
  sandbox.settings.enabled = true;
  sandbox.suspendVideoForQuiz = true;
  await api.playVideo(videos[0]);
  assert.equal(videos[0].plays, before, "quiz pause remains effective");
  // goNext(force) 只在「跳过本节」时绕过本地拦路条件；force=false 时仍必须先看本 frame 有没有待播视频
  assert.match(source, /async function goNext\(force = false\) \{/);
  assert.match(source, /if \(userStopped && !force\) \{/);
  assert.match(source, /if \(!force && pendingVideos\(\)\.length\) return;/);
  assert.match(source, /async function skipCompletedTaskIfNeeded\(\) \{\s*if \(pendingVideos\(\)\.length\) return false;/);
  assert.ok(!source.includes("videos.forEach(playVideo)"));
  console.log(`PASS ${file}: 13 sequential playback and guard assertions`);
}
