import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

for (const file of ["../content.js", "../userscript/yueyue-shuake.user.js"]) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const playback = source.slice(source.indexOf("  function pendingVideos()"), source.indexOf("  async function goNext()", source.indexOf("  function pendingVideos()")));
  const attachStart = source.indexOf("  function attach(video)");
  const attachEnd = source.indexOf("\n  // ----------", attachStart);
  const playEnd = playback.indexOf("\n  function attach(video)");
  const functions = (playEnd < 0 ? playback : playback.slice(0, playEnd)) + source.slice(attachStart, attachEnd);
  const timers = [];
  const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
  let navigation = 0;
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
    chrome: { runtime: { sendMessage: async () => ({}) } },
    observedVideos: new WeakSet(), videoTaskIds: new WeakMap(), videoSequence: 0,
    updateTask() {}, publishStatus() {}, goNext() { navigation++; },
    setTimeout(fn) { timers.push(fn); }, setInterval: () => 0, clearInterval: () => {}, Date, console
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
  assert.equal(timers.length, 0, "queued pause must not schedule a competing retry");
  videos[0].finish();
  await flush();
  assert.equal(videos[1].plays, 1, "first ended hands playback to the second video");
  assert.equal(navigation, 0, "first ended must not navigate");
  videos[1].finish();
  await flush();
  assert.equal(navigation, 1, "本 frame 最后一个视频结束后才跳转，且只跳一次");
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
  assert.match(source, /async function goNext\(\) \{\s*if \([^\n]*pendingVideos\(\)\.length\) return;/);
  assert.match(source, /async function skipCompletedTaskIfNeeded\(\) \{\s*if \(pendingVideos\(\)\.length\) return false;/);
  assert.ok(!source.includes("videos.forEach(playVideo)"));
  console.log(`PASS ${file}: 13 sequential playback and guard assertions`);
}
