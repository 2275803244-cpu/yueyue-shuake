(() => {
  if (globalThis.__KEHANG_HELPER_CONTENT_ACTIVE__) return;
  globalThis.__KEHANG_HELPER_CONTENT_ACTIVE__ = true;

  const DEFAULTS = {
    enabled: false,
    autoResume: true,
    autoReadDocuments: true,
    muted: true,
    playbackRate: 1,
    autoNext: true,
    skipCompleted: true,
    nextRetryCount: 3,
    nextRetryDelayMs: 1200,
    nextSelector: "",
    autoAnswer: false,
    autoSubmit: false
  };
  const DEFAULT_AI_CONFIG = {
    questionSelector: '#ext-comp-1046 .tkItem, .tkItem, .ans-videoquiz, #ext-comp-1046, .TiMu, .newTiMu, .questionLi, .question, .quiz-question, .exam-question, [data-question], [class*="question-item"]',
    stemSelector: '.tkItem_tit, .tkItem_title, .videoquiz-title, .ans-videoquiz-title, .fontLabel, .Zy_TItle .clearfix, .newZy_TItle + .fontLabel, .question-title, .question-stem, .stem, .subject, [class*="question-title"]',
    optionSelector: '.ans-videoquiz-opt label, .ans-videoquiz-opt, .tkItem_ul li, [class*="before-after"], ul li .after, ul li textarea, ul textarea, ul li label:not(.before), .answerBg, label, .option, .answer-option, [class*="option-item"]',
    submitSelector: '#videoquiz-submit, .video-quiz-submit, .btnBlueSubmit, [onclick*="btnBlueSubmit"], button[type="submit"], .submit-answer, .btn-submit, [data-action="submit"]'
  };
  const FALLBACK_NEXT_SELECTORS = [
    '[data-action="next"]',
    '[data-testid*="next"]',
    'button[aria-label*="下一"]',
    'a[aria-label*="下一"]',
    '.next-btn',
    '.btn-next',
    '.next-button',
    '.course-next',
    '.chapter-next'
  ];

  let settings = DEFAULTS;
  let observedVideos = new WeakSet();
  let videoTaskIds = new WeakMap();
  let videoSequence = 0;
  let observer;
  let nextInProgress = false;
  let intentionalPauseUntil = 0;
  let quizInFlight = false;
  let documentInFlight = false;
  let documentCompletionTimer;
  const completedDocumentReaders = new Set();
  let completionSignature = "";
  let completionStableCount = 0;
  let completionSkipCooldownUntil = 0;
  let quizDeferredNextTimer;
  let lastQuizFingerprint = "";
  let lastQuizAttemptFingerprint = "";
  let lastQuizAttemptAt = 0;
  let orchestratorTimer;
  let orchestratorRunning = false;
  let suspendVideoForQuiz = false;
  let videoQuizHeartbeatTimer;
  let lastCountSignature = "";
  let lastPublishedSignature = "";
  const taskMap = new Map();
  let floatingUi;
  let floatingCustomization = { width: 300, opacity: 100, theme: "purple", compact: false };
  let runtimeStatus = {
    phase: "idle", message: "等待任务", videoCount: 0, documentCount: 0, questionCount: 0, filledCount: 0, tasks: [], updatedAt: Date.now()
  };

  let siteKey = location.origin;
  let storageKey = `site:${siteKey}`;

  async function loadSettings() {
    try {
      const tabSite = await chrome.runtime.sendMessage({ type: "GET_TAB_SITE_KEY" });
      if (tabSite?.siteKey) {
        siteKey = tabSite.siteKey;
        storageKey = `site:${siteKey}`;
      }
    } catch {}
    const stored = await chrome.storage.local.get(storageKey);
    settings = { ...DEFAULTS, ...(stored[storageKey] || {}) };
    return settings;
  }

  function buildAiConfig(saved = {}) {
    const config = { ...DEFAULT_AI_CONFIG, ...saved };
    const prepend = (required, current) => `${required}, ${current || ""}`.replace(/,\s*$/, "");
    config.questionSelector = prepend('#ext-comp-1046 .tkItem, .tkItem, #ext-comp-1046, .TiMu, .newTiMu, .questionLi', config.questionSelector);
    config.stemSelector = prepend('.tkItem_tit, .tkItem_title, .videoquiz-title, .fontLabel, .Zy_TItle .clearfix, .newZy_TItle + .fontLabel', config.stemSelector);
    config.optionSelector = prepend('.ans-videoquiz-opt label, .ans-videoquiz-opt, .tkItem_ul li, [class*="before-after"], ul li .after, ul li label:not(.before), .answerBg', config.optionSelector);
    config.submitSelector = prepend('#videoquiz-submit, .ans-videoquiz-submit, .btnBlueSubmit, [onclick*="btnBlueSubmit"]', config.submitSelector);
    return config;
  }

  function reportVideoQuizState(active) {
    chrome.runtime.sendMessage({ type: "FRAME_VIDEO_QUIZ_STATE", active }).catch(() => {});
    if (!active) {
      clearInterval(videoQuizHeartbeatTimer);
      videoQuizHeartbeatTimer = undefined;
      return;
    }
    if (!videoQuizHeartbeatTimer) {
      videoQuizHeartbeatTimer = setInterval(() => {
        chrome.runtime.sendMessage({ type: "FRAME_VIDEO_QUIZ_STATE", active: true }).catch(() => {});
      }, 1500);
    }
  }

  function publishStatus(patch) {
    const next = { ...runtimeStatus, ...patch, updatedAt: Date.now() };
    const signature = JSON.stringify([
      next.phase, next.message, next.videoCount, next.documentCount, next.questionCount, next.filledCount,
      (next.tasks || []).map((task) => [task.id, task.state, task.detail])
    ]);
    runtimeStatus = next;
    renderFloatingStatus(next);
    if (signature === lastPublishedSignature) return;
    lastPublishedSignature = signature;
    chrome.runtime.sendMessage({ type: "STATUS_UPDATE", siteKey, status: runtimeStatus }).catch(() => {});
  }

  function updateTask(id, patch) {
    const previous = taskMap.get(id) || { id, label: id, type: "system", state: "waiting", createdAt: Date.now() };
    if (taskMap.has(id) && Object.entries(patch).every(([key, value]) => previous[key] === value)) return;
    const task = { ...previous, ...patch, id, updatedAt: Date.now() };
    taskMap.set(id, task);
    const tasks = [...taskMap.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 20);
    for (const key of taskMap.keys()) {
      if (!tasks.some((taskItem) => taskItem.id === key)) taskMap.delete(key);
    }
    publishStatus({ tasks });
  }

  function shortFingerprint(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function floatingPhaseLabel(phase) {
    return {
      idle: "等待启动", scanning: "正在检测", playing: "视频学习中", reading: "课件阅读中",
      answering: "AI 正在答题", done: "本轮已完成", error: "需要处理"
    }[phase] || "正在运行";
  }

  function renderFloatingSettings() {
    if (!floatingUi) return;
    floatingUi.enabled.checked = Boolean(settings.enabled);
    floatingUi.autoResume.checked = Boolean(settings.autoResume);
    floatingUi.autoReadDocuments.checked = Boolean(settings.autoReadDocuments);
    floatingUi.autoAnswer.checked = Boolean(settings.autoAnswer);
    floatingUi.autoSubmit.checked = Boolean(settings.autoSubmit);
    floatingUi.autoNext.checked = Boolean(settings.autoNext);
    floatingUi.skipCompleted.checked = Boolean(settings.skipCompleted);
    floatingUi.playbackRate.value = String(settings.playbackRate || 1);
  }

  function renderFloatingStatus(status = runtimeStatus) {
    if (!floatingUi) return;
    floatingUi.statusTitle.textContent = floatingPhaseLabel(status.phase);
    floatingUi.statusMessage.textContent = status.message || "启用后自动检测页面任务";
    floatingUi.statusDot.className = `kh-dot ${status.phase || "idle"}`;
    floatingUi.videoCount.textContent = String(status.videoCount || 0);
    floatingUi.documentCount.textContent = String(status.documentCount || 0);
    floatingUi.questionCount.textContent = String(status.questionCount || 0);
    const activeTask = (status.tasks || []).find((task) => task.state === "running" || task.state === "error");
    floatingUi.activeTask.textContent = activeTask ? `${activeTask.label} · ${activeTask.detail || ""}` : "暂无进行中的任务";
  }

  async function saveFloatingSetting(patch) {
    settings = { ...settings, ...patch };
    await chrome.storage.local.set({ [storageKey]: settings });
    renderFloatingSettings();
    scan();
  }

  function setFloatingVisible(visible) {
    if (!floatingUi) return;
    floatingUi.host.style.display = visible ? "block" : "none";
    chrome.storage.local.set({ floatUiVisible: visible }).catch(() => {});
  }

  function normalizeFloatingCustomization(value = {}) {
    const width = Math.max(260, Math.min(380, Number(value.width || 300)));
    const opacity = Math.max(70, Math.min(100, Number(value.opacity || 100)));
    const theme = ["purple", "blue", "green", "rose"].includes(value.theme) ? value.theme : "purple";
    return { width, opacity, theme, compact: Boolean(value.compact) };
  }

  function applyFloatingCustomization(value = floatingCustomization) {
    floatingCustomization = normalizeFloatingCustomization(value);
    if (!floatingUi) return;
    const { width, opacity, theme, compact } = floatingCustomization;
    floatingUi.host.style.width = `${width}px`;
    floatingUi.panel.style.opacity = String(opacity / 100);
    floatingUi.panel.dataset.theme = theme;
    floatingUi.panel.classList.toggle("compact", compact);
    floatingUi.customWidth.value = String(width);
    floatingUi.customOpacity.value = String(opacity);
    floatingUi.customOpacityValue.textContent = `${opacity}%`;
    floatingUi.customCompact.checked = compact;
    floatingUi.themeButtons.forEach((button) => button.classList.toggle("active", button.dataset.theme === theme));
    const rect = floatingUi.host.getBoundingClientRect();
    if (rect.right > innerWidth - 8) floatingUi.host.style.left = `${Math.max(8, innerWidth - width - 8)}px`;
  }

  function saveFloatingCustomization(patch) {
    applyFloatingCustomization({ ...floatingCustomization, ...patch });
    chrome.storage.local.set({ floatUiCustomization: floatingCustomization }).catch(() => {});
  }

  async function initFloatingWindow() {
    if (window !== window.top || floatingUi || !document.documentElement) return;
    const host = document.createElement("div");
    host.id = "kehang-floating-host";
    host.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483646;width:300px;max-width:calc(100vw - 24px);font-family:Inter,system-ui,'Microsoft YaHei',sans-serif;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        *{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer}
        .panel{--accent:#6757ef;--head:#18223d;overflow:hidden;border:1px solid #dfe3ed;border-radius:16px;color:#172033;background:#fff;box-shadow:0 16px 44px rgba(22,31,55,.22);transition:opacity .2s,width .2s}.panel[data-theme="blue"]{--accent:#3182f6;--head:#152c4d}.panel[data-theme="green"]{--accent:#17a673;--head:#153b34}.panel[data-theme="rose"]{--accent:#e45778;--head:#4a2130}
        .head{display:grid;grid-template-columns:34px 1fr auto;align-items:center;gap:9px;padding:11px 11px 10px;color:#fff;background:var(--head);cursor:grab;user-select:none;touch-action:none}.head:active{cursor:grabbing}
        .logo{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:var(--accent);font-size:14px;font-weight:800}.title strong,.title small{display:block}.title strong{font-size:13px}.title small{margin-top:2px;color:#aeb8d0;font-size:9px}
        .head-actions{display:flex;gap:5px}.icon-btn{display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:7px;color:#cbd3e6;background:#2b3754}.icon-btn:hover{background:#3a4869;color:#fff}
        .body{padding:11px}.panel.collapsed .body{display:none}.panel.collapsed{width:220px}.panel.collapsed .collapse svg{transform:rotate(180deg)}.icon-btn svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transition:.2s}
        .status{display:grid;grid-template-columns:28px 1fr;gap:8px;align-items:center;padding:9px;border-radius:11px;background:#f5f6fa}.kh-dot{position:relative;width:26px;height:26px;border:4px solid #e0e4ec;border-radius:50%}.kh-dot:after{content:'';position:absolute;inset:5px;border-radius:50%;background:#97a0b2}.kh-dot.playing:after,.kh-dot.reading:after,.kh-dot.answering:after,.kh-dot.scanning:after{background:#6757ef}.kh-dot.playing,.kh-dot.reading,.kh-dot.answering,.kh-dot.scanning{border-color:#ded9ff;animation:pulse 1.4s infinite}.kh-dot.done:after{background:#20a66a}.kh-dot.error:after{background:#e45260}
        @keyframes pulse{50%{transform:scale(1.08)}}.status strong,.status small{display:block}.status strong{font-size:12px}.status small{max-width:225px;margin-top:2px;overflow:hidden;color:#778197;font-size:9px;text-overflow:ellipsis;white-space:nowrap}
        .metrics{display:grid;grid-template-columns:repeat(3,1fr);margin:9px 0}.metric{text-align:center;border-right:1px solid #e8ebf1}.metric:last-child{border:0}.metric b,.metric span{display:block}.metric b{font-size:15px}.metric span{margin-top:1px;color:#8a93a5;font-size:8px}
        .task-line{min-height:28px;padding:7px 8px;border-radius:8px;color:#687287;background:#f7f8fb;font-size:9px;line-height:1.4}
        .master{display:flex;align-items:center;justify-content:space-between;margin:9px 0;padding:8px 9px;border-radius:9px;background:color-mix(in srgb,var(--accent) 12%,white)}.master strong{font-size:11px}.switch{position:relative;width:34px;height:20px}.switch input{position:absolute;opacity:0}.switch i{display:block;width:34px;height:20px;border-radius:99px;background:#cbd1dc;transition:.2s}.switch i:after{content:'';position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0003;transition:.2s}.switch input:checked+i{background:var(--accent)}.switch input:checked+i:after{transform:translateX(14px)}
        .options{display:grid;grid-template-columns:1fr 1fr;gap:7px}.check{display:flex;align-items:center;gap:5px;min-height:29px;padding:6px 7px;border:1px solid #e5e8ef;border-radius:8px;color:#536076;font-size:9px}.check input{margin:0;accent-color:#6757ef}.speed{display:flex;align-items:center;justify-content:space-between}.speed select{width:64px;padding:3px;border:1px solid #d8dde7;border-radius:6px;background:#fff;font-size:9px}
        .actions{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px}.action{min-height:32px;padding:7px;border:0;border-radius:8px;font-size:10px;font-weight:700}.answer{color:#153f30;background:#c8f3df}.model{color:#fff;background:var(--accent)}
        .customizer{margin-bottom:9px;padding:9px;border:1px solid #e4e7ef;border-radius:10px;background:#f8f9fc}.customizer[hidden]{display:none}.custom-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}.custom-head strong{font-size:10px}.reset{padding:0;border:0;color:var(--accent);background:transparent;font-size:9px}.custom-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.custom-field{display:flex;flex-direction:column;gap:4px;color:#69748a;font-size:8px}.custom-field select,.custom-field input[type=range]{width:100%}.opacity-label{display:flex;justify-content:space-between}.theme-row{display:flex;gap:6px}.theme-dot{width:20px;height:20px;padding:0;border:2px solid transparent;border-radius:50%;background:var(--dot)}.theme-dot.active{border-color:#172033;box-shadow:0 0 0 2px #fff inset}.compact-check{display:flex;align-items:center;gap:5px;color:#58647a;font-size:9px}.compact-check input{accent-color:var(--accent)}.panel.compact .metrics,.panel.compact .task-line{display:none}.panel.compact .status{margin-bottom:8px}
      </style>
      <section class="panel">
        <header class="head">
          <span class="logo">玥</span><span class="title"><strong>玥玥刷客</strong><small>实时任务浮窗</small></span>
          <span class="head-actions">
            <button class="icon-btn customize" title="外观设置"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"></path></svg></button>
            <button class="icon-btn collapse" title="折叠"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"></path></svg></button>
            <button class="icon-btn close" title="关闭"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"></path></svg></button>
          </span>
        </header>
        <div class="body">
          <div class="customizer" hidden>
            <div class="custom-head"><strong>浮窗外观</strong><button class="reset">恢复默认</button></div>
            <div class="custom-grid">
              <label class="custom-field">窗口宽度<select class="custom-width"><option value="260">紧凑 260px</option><option value="300">标准 300px</option><option value="340">宽版 340px</option><option value="380">大号 380px</option></select></label>
              <label class="custom-field"><span class="opacity-label"><span>透明度</span><b class="opacity-value">100%</b></span><input class="custom-opacity" type="range" min="70" max="100" step="5"></label>
            </div>
            <div class="custom-grid" style="margin-top:8px"><span class="custom-field">主题色<span class="theme-row"><button class="theme-dot" data-theme="purple" style="--dot:#6757ef"></button><button class="theme-dot" data-theme="blue" style="--dot:#3182f6"></button><button class="theme-dot" data-theme="green" style="--dot:#17a673"></button><button class="theme-dot" data-theme="rose" style="--dot:#e45778"></button></span></span><label class="compact-check"><input class="custom-compact" type="checkbox">精简模式</label></div>
          </div>
          <div class="status"><span class="kh-dot idle"></span><span><strong class="status-title">等待启动</strong><small class="status-message">启用后自动检测页面任务</small></span></div>
          <div class="metrics"><span class="metric"><b class="video-count">0</b><span>视频</span></span><span class="metric"><b class="document-count">0</b><span>课件</span></span><span class="metric"><b class="question-count">0</b><span>题目</span></span></div>
          <div class="task-line">暂无进行中的任务</div>
          <div class="master"><strong>启用当前站点</strong><label class="switch"><input class="enabled" type="checkbox"><i></i></label></div>
          <div class="options">
            <label class="check"><input class="auto-resume" type="checkbox">自动视频</label>
            <label class="check"><input class="auto-document" type="checkbox">自动课件</label>
            <label class="check"><input class="auto-answer" type="checkbox">自动答题</label>
            <label class="check"><input class="auto-submit" type="checkbox">普通题提交</label>
            <label class="check"><input class="auto-next" type="checkbox">自动下一节</label>
            <label class="check"><input class="skip-completed" type="checkbox">完成即跳过</label>
            <label class="check speed">速度<select class="rate"><option value="1">1.0×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2.0×</option></select></label>
          </div>
          <div class="actions"><button class="action answer">立即答题</button><button class="action model">模型设置</button></div>
        </div>
      </section>`;
    document.documentElement.append(host);
    const find = (selector) => shadow.querySelector(selector);
    floatingUi = {
      host, panel: find(".panel"), head: find(".head"), statusDot: find(".kh-dot"), statusTitle: find(".status-title"), statusMessage: find(".status-message"),
      videoCount: find(".video-count"), documentCount: find(".document-count"), questionCount: find(".question-count"), activeTask: find(".task-line"),
      enabled: find(".enabled"), autoResume: find(".auto-resume"), autoReadDocuments: find(".auto-document"), autoAnswer: find(".auto-answer"), autoSubmit: find(".auto-submit"), autoNext: find(".auto-next"), skipCompleted: find(".skip-completed"), playbackRate: find(".rate"),
      customizer: find(".customizer"), customWidth: find(".custom-width"), customOpacity: find(".custom-opacity"), customOpacityValue: find(".opacity-value"), customCompact: find(".custom-compact"), themeButtons: [...shadow.querySelectorAll(".theme-dot")]
    };

    const storedUi = await chrome.storage.local.get(["floatUiPosition", "floatUiVisible", "floatUiCollapsed", "floatUiCustomization"]);
    floatingCustomization = normalizeFloatingCustomization(storedUi.floatUiCustomization || floatingCustomization);
    if (storedUi.floatUiPosition) {
      const left = Number(storedUi.floatUiPosition.left);
      const top = Number(storedUi.floatUiPosition.top);
      if (Number.isFinite(left) && Number.isFinite(top)) {
        const clampedLeft = Math.max(8, Math.min(innerWidth - floatingCustomization.width - 8, left));
        const clampedTop = Math.max(8, Math.min(innerHeight - 60, top));
        host.style.left = `${clampedLeft}px`; host.style.top = `${clampedTop}px`; host.style.right = "auto"; host.style.bottom = "auto";
      }
    }
    if (storedUi.floatUiCollapsed) floatingUi.panel.classList.add("collapsed");
    if (storedUi.floatUiVisible === false) host.style.display = "none";
    applyFloatingCustomization();

    floatingUi.enabled.addEventListener("change", () => saveFloatingSetting({ enabled: floatingUi.enabled.checked }));
    floatingUi.autoResume.addEventListener("change", () => saveFloatingSetting({ autoResume: floatingUi.autoResume.checked }));
    floatingUi.autoReadDocuments.addEventListener("change", () => saveFloatingSetting({ autoReadDocuments: floatingUi.autoReadDocuments.checked }));
    floatingUi.autoAnswer.addEventListener("change", () => saveFloatingSetting({ autoAnswer: floatingUi.autoAnswer.checked }));
    floatingUi.autoSubmit.addEventListener("change", () => saveFloatingSetting({ autoSubmit: floatingUi.autoSubmit.checked }));
    floatingUi.autoNext.addEventListener("change", () => saveFloatingSetting({ autoNext: floatingUi.autoNext.checked }));
    floatingUi.skipCompleted.addEventListener("change", () => saveFloatingSetting({ skipCompleted: floatingUi.skipCompleted.checked }));
    floatingUi.playbackRate.addEventListener("change", () => saveFloatingSetting({ playbackRate: Number(floatingUi.playbackRate.value) }));
    find(".answer").addEventListener("click", async () => {
      publishStatus({ phase: "answering", message: "正在扫描顶层页面和所有题目 iframe" });
      try {
        const result = await chrome.runtime.sendMessage({ type: "ANSWER_ALL_FRAMES" });
        if (!result?.ok) {
          const frameResults = Array.isArray(result?.results) ? result.results : [];
          const frameErrors = frameResults
            .map((item) => item?.response?.answerResult?.error || item?.response?.error)
            .filter(Boolean);
          const failing = frameResults.find((item) => item?.response?.answerResult?.questionCount > 0 && !item.response.ok);
          const foundCount = Number(result?.questionCount || 0);
          const reason = failing?.response?.answerResult?.error || frameErrors[0] || "所有 frame 均未识别到题目";
          publishStatus({
            phase: "error", questionCount: foundCount, filledCount: 0,
            message: foundCount > 0 ? `识别 ${foundCount} 题，填写失败：${reason}` : reason
          });
        } else {
          publishStatus({ phase: "done", questionCount: result.questionCount, filledCount: result.filledCount, message: `跨 frame 答题完成：${result.filledCount}/${result.questionCount}` });
        }
      } catch (error) {
        publishStatus({ phase: "error", message: `跨 frame 答题失败：${error.message}` });
      }
    });
    find(".model").addEventListener("click", () => chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }).catch(() => {}));
    find(".close").addEventListener("click", () => setFloatingVisible(false));
    find(".customize").addEventListener("click", () => { floatingUi.customizer.hidden = !floatingUi.customizer.hidden; });
    floatingUi.customWidth.addEventListener("change", () => saveFloatingCustomization({ width: Number(floatingUi.customWidth.value) }));
    floatingUi.customOpacity.addEventListener("input", () => saveFloatingCustomization({ opacity: Number(floatingUi.customOpacity.value) }));
    floatingUi.customCompact.addEventListener("change", () => saveFloatingCustomization({ compact: floatingUi.customCompact.checked }));
    floatingUi.themeButtons.forEach((button) => button.addEventListener("click", () => saveFloatingCustomization({ theme: button.dataset.theme })));
    find(".reset").addEventListener("click", () => {
      saveFloatingCustomization({ width: 300, opacity: 100, theme: "purple", compact: false });
      host.style.left = "auto"; host.style.top = "auto"; host.style.right = "18px"; host.style.bottom = "18px";
      chrome.storage.local.remove("floatUiPosition").catch(() => {});
    });
    find(".collapse").addEventListener("click", () => {
      floatingUi.panel.classList.toggle("collapsed");
      chrome.storage.local.set({ floatUiCollapsed: floatingUi.panel.classList.contains("collapsed") }).catch(() => {});
    });

    let drag;
    floatingUi.head.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      const rect = host.getBoundingClientRect();
      drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
      floatingUi.head.setPointerCapture?.(event.pointerId);
    });
    floatingUi.head.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const left = Math.max(8, Math.min(innerWidth - host.offsetWidth - 8, event.clientX - drag.offsetX));
      const top = Math.max(8, Math.min(innerHeight - host.offsetHeight - 8, event.clientY - drag.offsetY));
      host.style.left = `${left}px`; host.style.top = `${top}px`; host.style.right = "auto"; host.style.bottom = "auto";
    });
    floatingUi.head.addEventListener("pointerup", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag = undefined;
      const left = parseFloat(host.style.left);
      const top = parseFloat(host.style.top);
      if (Number.isFinite(left) && Number.isFinite(top)) {
        chrome.storage.local.set({ floatUiPosition: { left, top } }).catch(() => {});
      }
    });
    renderFloatingSettings();
    renderFloatingStatus();
  }

  function isUsable(element) {
    if (!element || element.disabled || element.getAttribute("aria-disabled") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function findIncompleteTaskDialog() {
    const goStudyButtons = [...document.querySelectorAll("button, a, [role=button]")].filter((element) => {
      const label = normalizeText(element.innerText || element.textContent);
      return /^(去学习|去完成|继续学习)$/.test(label) && isUsable(element);
    });
    for (const button of goStudyButtons) {
      let node = button;
      for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
        const text = normalizeText(node.innerText || node.textContent);
        if (/当前章节.{0,80}(?:还有|存在|尚有).{0,40}任务点.{0,30}未完成.{0,40}是否去完成/.test(text)) {
          return { container: node, goStudyButton: button };
        }
      }
    }
    return null;
  }

  function handleIncompleteTaskDialog() {
    const warning = findIncompleteTaskDialog();
    if (!warning) return false;
    warning.goStudyButton.click();
    nextInProgress = false;
    completionSignature = "";
    completionStableCount = 0;
    updateTask("navigation", { label: "切换下一节", type: "navigation", state: "waiting", detail: "平台提示仍有任务点未完成，已返回继续学习" });
    publishStatus({ phase: "playing", message: "当前章节还有任务点未完成，已取消跳转并继续学习" });
    return true;
  }

  function hasVisibleIncompleteTaskMarker() {
    const selectors = [".ans-job-icon", ".ans-job-unfinished", "[data-task-status='unfinished']", "[data-status='incomplete']"];
    return selectors.some((selector) => [...document.querySelectorAll(selector)].some((element) => {
      if (!isUsable(element)) return false;
      const finished = element.matches(".ans-job-finished, .jobFinished, .jobFinish, [data-task-status='completed'], [data-status='finished']") ||
        element.closest(".ans-job-finished, .jobFinished, .jobFinish, [data-task-status='completed'], [data-status='finished']");
      return !finished;
    }));
  }

  function findNextButton() {
    if (settings.nextSelector) {
      try {
        const custom = document.querySelector(settings.nextSelector);
        if (isUsable(custom)) return custom;
      } catch (error) {
        console.warn("[玥玥刷客] 下一节选择器无效：", error.message);
      }
    }

    for (const selector of FALLBACK_NEXT_SELECTORS) {
      const candidate = document.querySelector(selector);
      if (isUsable(candidate)) return candidate;
    }

    return [...document.querySelectorAll("button, a, [role=button]")].find((element) => {
      const label = (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ");
      return /^(下一节|下一课|下一个|继续学习|继续课程|next)$/i.test(label) && isUsable(element);
    });
  }

  async function playVideo(video) {
    if (!settings.enabled) return;
    video.muted = settings.muted;
    video.playbackRate = settings.playbackRate;
    if (!settings.autoResume || suspendVideoForQuiz || video.ended || Date.now() < intentionalPauseUntil) return;
    try {
      await video.play();
      const taskId = videoTaskIds.get(video);
      if (taskId) updateTask(taskId, { state: "running", detail: `${video.currentTime ? Math.floor(video.currentTime) + " 秒 · " : ""}${settings.playbackRate}× 播放` });
      publishStatus({ phase: "playing", message: "视频正在播放" });
    } catch {
      // 浏览器可能要求用户先与页面交互；下一轮扫描会重试。
    }
  }

  async function goNext() {
    if (!settings.enabled || !settings.autoNext || nextInProgress) return;
    if (hasVisibleIncompleteTaskMarker()) {
      updateTask("navigation", { label: "切换下一节", type: "navigation", state: "waiting", detail: "当前任务点尚未完成，等待平台确认完成" });
      publishStatus({ phase: "playing", message: "任务点尚未完成，暂不点击下一节" });
      clearTimeout(quizDeferredNextTimer);
      quizDeferredNextTimer = setTimeout(() => goNext(), 1500);
      return;
    }
    if (handleIncompleteTaskDialog()) return;
    let activeQuiz = hasVisibleVideoQuiz();
    if (!activeQuiz) {
      try {
        const quizState = await chrome.runtime.sendMessage({ type: "HAS_ACTIVE_VIDEO_QUIZ" });
        activeQuiz = Boolean(quizState?.active);
      } catch {}
    }
    if (activeQuiz) {
      updateTask("navigation", { label: "切换下一节", type: "navigation", state: "waiting", detail: "视频弹题尚未处理，暂停跳转" });
      publishStatus({ phase: "answering", message: "检测到视频弹题，答题提交后再进入下一节" });
      clearTimeout(quizDeferredNextTimer);
      quizDeferredNextTimer = setTimeout(() => goNext(), 1200);
      return;
    }
    nextInProgress = true;
    updateTask("navigation", { label: "切换下一节", type: "navigation", state: "running", detail: "等待平台保存学习进度" });
    const retryCount = Math.max(1, Math.min(6, Number(settings.nextRetryCount || 3)));
    const retryDelayMs = Math.max(400, Math.min(10000, Number(settings.nextRetryDelayMs || 1200)));
    let delegated;
    await new Promise((resolve) => setTimeout(resolve, 900));
    for (let attempt = 1; attempt <= retryCount; attempt += 1) {
      try {
        updateTask("navigation", { state: "running", detail: `正在定位下一节（第 ${attempt}/${retryCount} 次）` });
        delegated = await chrome.runtime.sendMessage({ type: "REQUEST_NEXT", siteKey, nextSelector: settings.nextSelector });
        if (delegated?.blocked) {
          nextInProgress = false;
          completionSignature = "";
          completionStableCount = 0;
          updateTask("navigation", { state: "waiting", detail: delegated.error || "平台提示仍有任务点未完成" });
          publishStatus({ phase: "playing", message: "平台提示任务未完成，已取消进入下一节" });
          setTimeout(scan, 600);
          if (delegated.retryWhenComplete) {
            clearTimeout(quizDeferredNextTimer);
            quizDeferredNextTimer = setTimeout(() => goNext(), 1500);
          }
          return;
        }
        if (delegated?.ok) {
          const target = delegated.target ? ` · ${delegated.target}` : "";
          updateTask("navigation", { state: "done", detail: `${delegated.method}${target}` });
          publishStatus({ phase: "scanning", message: `视频结束，已切换下一节（${delegated.method}）` });
          setTimeout(() => { nextInProgress = false; scan(); }, 2500);
          return;
        }
      } catch (error) {
        delegated = { error: error.message };
      }
      if (attempt < retryCount) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }

    const button = findNextButton();
    if (!button) {
      console.info("[玥玥刷客] 视频已结束，但没有找到可用的“下一节”按钮。");
      const diagnostics = delegated?.diagnostics ? ` · 章节 ${delegated.diagnostics.chapterCount ?? 0} · 当前索引 ${delegated.diagnostics.activeIndex ?? -1}` : "";
      updateTask("navigation", { state: "error", detail: `${delegated?.error || "没有找到入口"}${diagnostics}` });
      publishStatus({ phase: "error", message: "视频结束，但顶层页面和当前 iframe 都没有找到“下一节”入口；诊断信息已记录" });
      nextInProgress = false;
      return;
    }
    setTimeout(() => {
      button.click();
      updateTask("navigation", { state: "done", detail: "已点击当前 frame 的下一节按钮" });
      publishStatus({ phase: "scanning", message: "已进入下一节，正在重新检测任务" });
      setTimeout(() => { nextInProgress = false; scan(); }, 2500);
    }, 800);
  }

  function attach(video) {
    if (observedVideos.has(video)) return;
    observedVideos.add(video);
    const taskId = `video:${++videoSequence}`;
    videoTaskIds.set(video, taskId);
    updateTask(taskId, { label: `视频任务 ${videoSequence}`, type: "video", state: video.ended ? "done" : "waiting", detail: video.ended ? "播放完成" : "等待播放" });
    video.addEventListener("ended", () => {
      updateTask(taskId, { state: "done", detail: "播放完成" });
      goNext();
    });
    video.addEventListener("ratechange", () => {
      if (settings.enabled && video.playbackRate !== settings.playbackRate) video.playbackRate = settings.playbackRate;
    });
    video.addEventListener("pause", () => {
      if (video.ended || suspendVideoForQuiz || !settings.enabled || !settings.autoResume) return;
      setTimeout(() => playVideo(video), 1000);
    });
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  const DOCUMENT_SELECTORS = [
    "#panView",
    ".insertdoc-online-pdf",
    "[class*='insertdoc']",
    "iframe[src*='/insertdoc']",
    "iframe[src*='pdf']",
    ".pdfViewer",
    "#viewer",
    "embed[type='application/pdf']",
    "object[type='application/pdf']",
    "[data-document-reader]"
  ];

  function documentUrlLooksLikeReader() {
    return /(?:insertdoc|documentreader|pdfviewer|\/pdf\/|[?&](?:type|ext)=pdf)/i.test(location.href);
  }

  function findDocumentReaders() {
    const readers = [];
    for (const selector of DOCUMENT_SELECTORS) {
      try { readers.push(...document.querySelectorAll(selector)); } catch {}
    }
    const unique = readers.filter((reader, index, all) => all.indexOf(reader) === index && (isUsable(reader) || reader.tagName === "IFRAME"));
    if (!unique.length && documentUrlLooksLikeReader()) unique.push(document.documentElement);
    return unique;
  }

  function readerRoot(reader) {
    if (reader?.tagName === "IFRAME") {
      try { return reader.contentDocument?.documentElement || null; } catch { return null; }
    }
    return reader;
  }

  function scrollTargets(reader) {
    const root = readerRoot(reader);
    if (!root) return [];
    const ownerDocument = root?.ownerDocument || document;
    const candidates = [
      root,
      ownerDocument.scrollingElement,
      ownerDocument.documentElement,
      ownerDocument.body,
      ...(root.querySelectorAll?.(".pdfViewer, #viewer, .viewerContainer, [class*='scroll'], [style*='overflow']") || [])
    ].filter(Boolean);
    return candidates
      .filter((element, index, all) => all.indexOf(element) === index && element.scrollHeight > element.clientHeight + 24)
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
  }

  function isAtScrollEnd(element) {
    return element.scrollTop + element.clientHeight >= element.scrollHeight - 12;
  }

  function scrollReaderToEnd(reader) {
    const targets = scrollTargets(reader);
    if (!targets.length) return { targets, complete: false };
    for (const target of targets) {
      if (isAtScrollEnd(target)) continue;
      const nextTop = Math.min(target.scrollHeight, target.scrollTop + Math.max(320, Math.floor(target.clientHeight * 0.82)));
      target.scrollTo?.({ top: nextTop, behavior: "auto" });
      if (typeof target.scrollTop === "number") target.scrollTop = nextTop;
      target.dispatchEvent?.(new Event("scroll", { bubbles: true }));
    }
    return { targets, complete: targets.every(isAtScrollEnd) };
  }

  function findDocumentNextPageButton(reader) {
    const root = readerRoot(reader);
    if (!root) return null;
    const ownerDocument = root?.ownerDocument || document;
    const searchRoots = [root, ownerDocument].filter(Boolean);
    const selectors = [
      "[aria-label*='下一页']", "[title*='下一页']", "[data-action='next-page']",
      "#nextPage", "#next-page", ".page-next", ".next-page", "button[aria-label*='Next page']"
    ];
    for (const searchRoot of searchRoots) {
      for (const selector of selectors) {
        const candidate = searchRoot.querySelector?.(selector);
        if (isUsable(candidate)) return candidate;
      }
      const textButton = [...(searchRoot.querySelectorAll?.("button, a, [role=button]") || [])].find((element) => {
        const label = normalizeText(element.innerText || element.textContent);
        return /^(下一页|下页|next page)$/i.test(label) && isUsable(element);
      });
      if (textButton) return textButton;
    }
    return null;
  }

  async function completeDocumentReader(reader, index) {
    const taskId = `document:${shortFingerprint(`${location.href}:${index}`)}`;
    const documentKey = `${location.href}:${index}`;
    if (completedDocumentReaders.has(documentKey)) return true;
    const label = `课件阅读 ${index + 1}`;
    if (!readerRoot(reader)) {
      updateTask(taskId, { label, type: "document", state: "waiting", detail: "等待课件子页面接管阅读" });
      return false;
    }
    let pageClicks = 0;
    let stableAtEnd = 0;
    updateTask(taskId, { label, type: "document", state: "running", detail: "正在阅读并滚动课件" });
    publishStatus({ phase: "reading", message: "检测到教学课件，正在自动阅读", documentCount: findDocumentReaders().length });

    for (let step = 1; step <= 80 && settings.enabled && settings.autoReadDocuments; step += 1) {
      if (!reader.isConnected && reader !== document.documentElement) break;
      const result = scrollReaderToEnd(reader);
      if (!result.complete) {
        stableAtEnd = 0;
        updateTask(taskId, { state: "running", detail: `正在滚动课件 · ${step}/80` });
        await new Promise((resolve) => setTimeout(resolve, 550));
        continue;
      }

      const nextPage = findDocumentNextPageButton(reader);
      if (nextPage) {
        pageClicks += 1;
        updateTask(taskId, { state: "running", detail: `已读到当前页末尾，正在翻到第 ${pageClicks + 1} 页` });
        nextPage.click();
        await new Promise((resolve) => setTimeout(resolve, 800));
        continue;
      }

      stableAtEnd += 1;
      if (stableAtEnd >= 2) {
        completedDocumentReaders.add(documentKey);
        updateTask(taskId, { state: "done", detail: `课件已读到末尾${pageClicks ? ` · 翻页 ${pageClicks} 次` : ""}` });
        publishStatus({ phase: "done", message: "教学课件已阅读完成，准备进入下一节" });
        clearTimeout(documentCompletionTimer);
        documentCompletionTimer = setTimeout(() => goNext(), 1200);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }

    updateTask(taskId, { state: "error", detail: "课件阅读超过最大步骤，请检查页面是否需要手动翻页" });
    publishStatus({ phase: "error", message: "课件没有在预期步骤内完成，请查看任务队列" });
    return false;
  }

  async function processDocuments() {
    if (!settings.enabled || !settings.autoReadDocuments || documentInFlight) return false;
    const readers = findDocumentReaders();
    if (!readers.length) return false;
    documentInFlight = true;
    try {
      for (let index = 0; index < readers.length; index += 1) await completeDocumentReader(readers[index], index);
      return true;
    } finally {
      documentInFlight = false;
    }
  }

  function normalizeAnswerText(value) {
    return normalizeText(value)
      .replace(/^[A-ZＡ-Ｚ][.．、:：)）]\s*/i, "")
      .replace(/^\(?[①②③④⑤⑥⑦⑧⑨⑩]\)?\s*/, "")
      .trim();
  }

  function detectQuestionType(container) {
    const typeValue = container.querySelector('input[id^="answertype"], input[name="answertype"], [data-answer-type]')?.value ||
      container.getAttribute("typename") || container.getAttribute("data-answer-type") || "";
    const numericTypes = { "0": "single", "1": "multiple", "2": "text", "3": "judgement", "4": "text", "6": "text" };
    if (numericTypes[String(typeValue)]) return numericTypes[String(typeValue)];
    const typeText = normalizeText(container.querySelector(".newZy_TItle, .Zy_TItle, .colorShallow")?.textContent || typeValue);
    if (/多选/.test(typeText)) return "multiple";
    if (/判断|对错|true.?false/i.test(typeText)) return "judgement";
    if (/填空|简答|名词解释|论述/.test(typeText)) return "text";
    if (/单选/.test(typeText)) return "single";
    return "";
  }

  function readOptionElements(container, selector, questionType = "") {
    let candidates;
    try {
      candidates = [...container.querySelectorAll(selector)];
    } catch (error) {
      throw new Error(`选项选择器无效：${error.message}`);
    }

    const seenControls = new Set();
    const seenText = new Set();
    const options = [];
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const element = candidates[candidateIndex];
      const control = element.matches('input[type="radio"], input[type="checkbox"]')
        ? element
        : element.querySelector('input[type="radio"], input[type="checkbox"]');
      const ariaLabel = element.getAttribute("aria-label") || element.closest("[aria-label]")?.getAttribute("aria-label") || "";
      let text = normalizeAnswerText(element.innerText || element.textContent || control?.value || ariaLabel);
      if (/^第\s*\d+\s*空[:：]?$/.test(text)) continue;
      if (questionType === "judgement") {
        const probe = `${text} ${ariaLabel}`;
        if (/(^|[^不])对|正确|true|right|√/i.test(probe)) text = "正确";
        else if (/(^|[^不])错|错误|false|wrong|×/i.test(probe)) text = "错误";
      }
      if (!text || (control && seenControls.has(control)) || (!control && seenText.has(text))) continue;
      if (control) seenControls.add(control);
      else seenText.add(text);
      options.push({ element, control, text: text.slice(0, 1000) });
    }
    return options;
  }

  function extractQuestions(aiConfig) {
    let containers;
    try {
      containers = [...document.querySelectorAll(aiConfig.questionSelector)];
    } catch (error) {
      throw new Error(`题目容器选择器无效：${error.message}`);
    }

    const usableContainers = containers.filter(isUsable);
    containers = usableContainers.filter((container) => !usableContainers.some((other) =>
      other !== container && container.contains(other) && other.querySelector('input[type="radio"], input[type="checkbox"], textarea, input[type="text"]')
    ));

    return containers.map((container) => {
      const explicitType = detectQuestionType(container);
      const options = readOptionElements(container, aiConfig.optionSelector, explicitType);
      const textControls = [...container.querySelectorAll('textarea, input[type="text"], input:not([type])')].filter(isUsable);
      if (!options.length && !textControls.length) return null;

      let stemElement;
      try { stemElement = container.querySelector(aiConfig.stemSelector); } catch (error) {
        throw new Error(`题干选择器无效：${error.message}`);
      }
      const stem = normalizeText(stemElement?.innerText || stemElement?.textContent || container.innerText)
        .replace(/^\s*\d+[、.．]\s*/, "")
        .replace(/[（(]\s*\d+(?:\.\d+)?\s*分\s*[)）]/g, "")
        .replace(/^[【\[(（]?(?:单选题|多选题|判断题|填空题|简答题)[】\])）]?\s*/g, "")
        .trim().slice(0, 4000);
      const hasCheckbox = options.some(({ control }) => control?.type === "checkbox");
      const type = explicitType || (options.length ? (hasCheckbox ? "multiple" : "single") : "text");
      return {
        container,
        optionElements: options,
        textControls,
        type,
        payload: {
          question: 0,
          type,
          stem,
          options: options.map(({ text }) => text),
          ...(textControls.length > 1 ? { blanks: textControls.length } : {})
        }
      };
    }).filter(Boolean).map((question, index) => {
      question.payload.question = index;
      return question;
    });
  }

  function setTextControl(control, value) {
    const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(control, value);
    else control.value = value;
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function applyAnswers(questions, answers) {
    let filledCount = 0;
    for (const answer of answers) {
      const questionIndex = Number(answer?.question);
      const question = questions[questionIndex];
      if (!question) continue;
      let changed = false;

      if (question.optionElements.length && Array.isArray(answer.choices)) {
        const indexedChoices = answer.choices.map(Number).filter(Number.isInteger);
        const textChoices = Array.isArray(answer.choiceTexts) ? answer.choiceTexts.map(normalizeAnswerText).filter(Boolean) : [];
        const exactIndexes = textChoices.length
          ? textChoices.map((text) => question.optionElements.findIndex(({ text: optionText }) => normalizeAnswerText(optionText) === text)).filter((index) => index >= 0)
          : [];
        const selected = new Set(textChoices.length > 0 && exactIndexes.length === textChoices.length ? exactIndexes : indexedChoices);
        question.optionElements.forEach(({ element, control }, index) => {
          const shouldSelect = selected.has(index);
          const ariaSelected = element.getAttribute("aria-checked") === "true" || element.classList.contains("selected") || element.classList.contains("active");
          if (control) {
            if (control.type === "checkbox" && control.checked !== shouldSelect) {
              control.click();
              changed = true;
            } else if (control.type === "radio" && shouldSelect && !control.checked) {
              control.click();
              changed = true;
            } else if (shouldSelect && control.checked) {
              changed = true;
            }
          } else if (shouldSelect || (question.type === "multiple" && ariaSelected && !shouldSelect)) {
            element.click();
            changed = true;
          }
        });
      } else if (question.textControls.length) {
        let perBlank = Array.isArray(answer.textAnswers) ? answer.textAnswers.map((value) => String(value ?? "").trim()) : [];
        const single = typeof answer.textAnswer === "string" ? answer.textAnswer.trim() : "";
        if (perBlank.length !== question.textControls.length && question.textControls.length > 1 && single) {
          const parts = single
            .split(/[/／；;，,、]|和|与/)
            .map((part) => part.replace(/^第\s*\d+\s*空[:：]?\s*/, "").trim())
            .filter(Boolean);
          if (parts.length === question.textControls.length) perBlank = parts;
        }
        const fallback = single ? [single] : [];
        const values = perBlank.length === question.textControls.length && perBlank.some(Boolean) ? perBlank : fallback;
        let filledBlanks = 0;
        question.textControls.forEach((control, index) => {
          const value = values[index];
          if (value) {
            setTextControl(control, value);
            filledBlanks += 1;
          }
        });
        changed = question.textControls.length === 1 ? filledBlanks > 0 : filledBlanks === question.textControls.length;
      }

      if (changed) filledCount += 1;
    }
    return filledCount;
  }

  function isBlockingVideoQuiz(question) {
    const selector = '#ext-comp-1046, .tkItem, .ans-videoquiz, .ans-videoquiz-opt, .video-quiz, [class*="videoQuiz"], [class*="video-quiz"]';
    return Boolean(question?.container?.matches?.(selector) || question?.container?.closest?.(selector));
  }

  function hasVisibleVideoQuiz() {
    const selectors = ["#ext-comp-1046", ".tkItem", ".ans-videoquiz", ".video-quiz", "[class*='videoQuiz']", "[class*='video-quiz']"];
    for (const selector of selectors) {
      const visible = [...document.querySelectorAll(selector)].find((element) =>
        isUsable(element) && Boolean(element.querySelector('input[type="radio"], input[type="checkbox"], .ans-videoquiz-opt'))
      );
      if (visible) return true;
    }
    return false;
  }

  function findSubmitButton(selector, questions = []) {
    try {
      const blockingContainer = questions.find(isBlockingVideoQuiz)?.container;
      const blockingRoot = blockingContainer?.closest?.("#ext-comp-1046") || blockingContainer?.parentElement;
      const nearby = blockingContainer?.querySelector?.('#videoquiz-submit, .ans-videoquiz-submit, .video-quiz-submit, button[type="submit"], [data-action="submit"]') ||
        blockingContainer?.parentElement?.querySelector?.('#videoquiz-submit, .ans-videoquiz-submit, .video-quiz-submit') ||
        blockingRoot?.querySelector?.('#videoquiz-submit, .ans-videoquiz-submit, .video-quiz-submit');
      if (isUsable(nearby)) return nearby;
      const textButton = [...(blockingRoot?.querySelectorAll?.("button, a, [role=button]") || [])].find((element) => {
        const label = normalizeText(element.innerText || element.textContent);
        return /^(提交|确定|确认|确认答案|完成答题)$/i.test(label) && isUsable(element);
      });
      if (textButton) return textButton;
      return [...document.querySelectorAll(selector)].find(isUsable);
    } catch (error) {
      throw new Error(`提交按钮选择器无效：${error.message}`);
    }
  }

  function findQuizContinueButton(questions = []) {
    const blockingContainer = questions.find(isBlockingVideoQuiz)?.container;
    const roots = [blockingContainer, blockingContainer?.parentElement, document].filter(Boolean);
    const selectors = ["#videoquiz-continue", ".ans-videoquiz-continue", ".videoquiz-continue", "[data-action=continue]"];
    for (const root of roots) {
      for (const selector of selectors) {
        const candidate = root.querySelector?.(selector);
        if (isUsable(candidate)) return candidate;
      }
      const textButton = [...(root.querySelectorAll?.("button, a, [role=button]") || [])].find((element) => {
        const label = normalizeText(element.innerText || element.textContent);
        return /^(继续学习|继续播放|继续|完成)$/i.test(label) && isUsable(element);
      });
      if (textButton) return textButton;
    }
    return null;
  }

  function waitForQuizContinue(taskId, questions) {
    let attempts = 0;
    const poll = () => {
      attempts += 1;
      const button = findQuizContinueButton(questions);
      if (button) {
        button.click();
        updateTask(taskId, { state: "done", detail: "答案已提交，并已点击继续学习" });
        return;
      }
      if (attempts < 30 && questions.some((question) => question.container?.isConnected)) setTimeout(poll, 300);
    };
    setTimeout(poll, 300);
  }

  async function submitAnsweredQuestions(aiConfig, questions, blockingVideoQuiz, taskId) {
    await new Promise((resolve) => setTimeout(resolve, 450));
    const chaoxingChapterTest = questions.some((question) => question.container?.matches?.(".TiMu, .newTiMu, .questionLi"));
    if (chaoxingChapterTest) {
      try {
        const result = await chrome.runtime.sendMessage({ type: "CHAOXING_SUBMIT" });
        if (result?.ok) return result;
        return { ok: false, error: result?.error || "学习通没有确认提交" };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }
    const submit = findSubmitButton(aiConfig.submitSelector, questions);
    if (!submit) {
      if (blockingVideoQuiz) waitForQuizContinue(taskId, questions);
      return { ok: false, error: "没有找到提交按钮" };
    }
    submit.click();
    if (blockingVideoQuiz) waitForQuizContinue(taskId, questions);
    return { ok: true, method: "button" };
  }

  async function answerQuestions(force = false, suppressEmptyError = false) {
    if (quizInFlight) return { ok: false, error: "AI 正在答题，请稍候" };
    const stored = await chrome.storage.local.get("aiConfig");
    const aiConfig = buildAiConfig(stored.aiConfig || {});
    const questions = extractQuestions(aiConfig);
    if (!questions.length) {
      if (!suppressEmptyError) publishStatus({ phase: "error", questionCount: 0, message: "当前页面没有识别到题目，请检查页面适配设置" });
      return { ok: false, error: "当前页面没有识别到题目，请检查题目选择器" };
    }
    const payload = questions.map(({ payload: item }) => item);
    const fingerprint = JSON.stringify(payload);
    const taskId = `quiz:${shortFingerprint(fingerprint)}`;
    if (!force && fingerprint === lastQuizFingerprint) {
      updateTask(taskId, { label: `题目组 · ${questions.length} 题`, type: "quiz", state: "done", detail: "已处理，跳过重复请求" });
      return { ok: true, questionCount: questions.length, filledCount: 0, skipped: true };
    }
    if (!force && fingerprint === lastQuizAttemptFingerprint && Date.now() - lastQuizAttemptAt < 30000) {
      return { ok: false, error: "同一组题目正在等待重试" };
    }

    const blockingVideoQuiz = questions.some(isBlockingVideoQuiz);
    if (blockingVideoQuiz) {
      reportVideoQuizState(true);
      suspendVideoForQuiz = true;
      document.querySelectorAll("video").forEach((video) => {
        video.pause();
        const videoTaskId = videoTaskIds.get(video);
        if (videoTaskId) updateTask(videoTaskId, { state: "waiting", detail: "检测到互动题，已暂停" });
      });
    }
    publishStatus({
      phase: "answering", questionCount: questions.length, filledCount: 0,
      message: blockingVideoQuiz ? `检测到视频内题目，已暂停视频并开始回答 ${questions.length} 题` : `已识别 ${questions.length} 题，正在请求 AI`
    });
    updateTask(taskId, {
      label: `题目组 · ${questions.length} 题`, type: "quiz", state: "running",
      detail: blockingVideoQuiz ? "视频互动题 · 正在请求 AI" : "正在请求 AI"
    });

    quizInFlight = true;
    lastQuizAttemptFingerprint = fingerprint;
    lastQuizAttemptAt = Date.now();
    try {
      const response = await chrome.runtime.sendMessage({ type: "AI_REQUEST", questions: payload });
      if (!response?.ok) throw new Error(response?.error || "AI 接口没有返回结果");
      const filledCount = applyAnswers(questions, response.answers);
      lastQuizFingerprint = fingerprint;

      const shouldSubmit = settings.autoSubmit || blockingVideoQuiz;
      let submission = { ok: false };
      if (shouldSubmit && filledCount === questions.length) {
        submission = await submitAnsweredQuestions(aiConfig, questions, blockingVideoQuiz, taskId);
      }
      publishStatus({
        phase: "done", questionCount: questions.length, filledCount,
        message: `本轮完成：成功填写 ${filledCount}/${questions.length} 题${submission.ok ? "，已自动提交并确认" : shouldSubmit && filledCount === questions.length ? `，提交失败：${submission.error || "未知原因"}` : ""}`
      });
      const answerPreview = response.answers.slice(0, 6).map((answer) => {
        const choices = Array.isArray(answer.choices) ? answer.choices.filter((choice) => Number.isInteger(Number(choice))).map((choice) => String.fromCharCode(65 + Number(choice))) : [];
        if (choices.length) return `${Number(answer.question) + 1}:${choices.join("")}`;
        const textValue = Array.isArray(answer.textAnswers) ? answer.textAnswers.join(" / ") : answer.textAnswer;
        return `${Number(answer.question) + 1}:${normalizeText(textValue).slice(0, 18)}`;
      }).join(" · ");
      updateTask(taskId, {
        state: filledCount === questions.length ? "done" : "error",
        detail: `${filledCount}/${questions.length} 已填写 · ${response.cached ? "命中缓存" : `请求 ${response.attempts || 1} 次`}${submission.ok ? ` · 已提交(${submission.method || "平台接口"})` : ""}${answerPreview ? ` · ${answerPreview}` : ""}`
      });
      return { ok: true, questionCount: questions.length, filledCount };
    } catch (error) {
      console.error("[玥玥刷客] AI 答题失败：", error);
      publishStatus({ phase: "error", questionCount: questions.length, message: `AI 答题失败：${error.message}` });
      updateTask(taskId, { state: "error", detail: error.message });
      return { ok: false, error: error.message };
    } finally {
      quizInFlight = false;
    }
  }

  function detectCompletedTask() {
    const pageText = normalizeText(document.body?.innerText || "");
    const explicitText = pageText.match(/(?:本节|本任务点|任务点|当前任务|答题|测验)(?:已经|已)?完成|提交成功|已交卷|查看解析/);
    if (explicitText) {
      return { complete: true, reason: explicitText[0], source: "text" };
    }

    const statusSelectors = [
      ".ans-job-finished", ".jobFinished", ".jobFinish", ".task-point-finished", ".testTit_status_complete",
      ".answer-finished", ".quiz-finished", "[data-status='finished']", "[data-task-status='completed']"
    ];
    for (const selector of statusSelectors) {
      const elements = [...document.querySelectorAll(selector)];
      const marker = elements.find((element) => {
        if (!isUsable(element)) return false;
        const chapterNode = element.closest(".posCatalog_select");
        return !chapterNode || chapterNode.classList.contains("posCatalog_active");
      });
      if (marker) return { complete: true, reason: normalizeText(marker.textContent) || "任务点状态已完成", source: selector };
    }

    const activeChapter = document.querySelector(".posCatalog_select.posCatalog_active, .posCatalog_active.posCatalog_select");
    if (activeChapter && !activeChapter.querySelector(".jobUnfinishCount, .orangeNew, [class*='unfinish'], [class*='Unfinish']")) {
      const activeText = normalizeText(activeChapter.textContent);
      if (!/未完成|待完成|未学习/.test(activeText) && (/已完成|√|✓/.test(activeText) || activeChapter.querySelector(".jobFinish, .jobFinished"))) {
        return { complete: true, reason: "当前章节任务点已完成", source: "active-chapter" };
      }
    }
    return { complete: false };
  }

  async function skipCompletedTaskIfNeeded() {
    if (!settings.enabled || !settings.autoNext || !settings.skipCompleted || nextInProgress) return false;
    try {
      const quizState = await chrome.runtime.sendMessage({ type: "HAS_ACTIVE_VIDEO_QUIZ" });
      if (quizState?.active) {
        updateTask("completion-check", { label: "完成状态检测", type: "navigation", state: "waiting", detail: `检测到 ${quizState.frameCount || 1} 个视频弹题，暂不跳过` });
        completionSignature = "";
        completionStableCount = 0;
        return true;
      }
    } catch {}
    if (Date.now() < completionSkipCooldownUntil) return false;
    const result = detectCompletedTask();
    if (!result.complete) {
      completionSignature = "";
      completionStableCount = 0;
      return false;
    }

    const chapterId = document.querySelector("#curChapterId")?.value || "";
    const signature = `${location.href}:${chapterId}:${result.source}:${result.reason}`;
    if (signature === completionSignature) completionStableCount += 1;
    else {
      completionSignature = signature;
      completionStableCount = 1;
    }
    updateTask("completion-check", {
      label: "完成状态检测", type: "navigation", state: "running",
      detail: `${result.reason} · 确认 ${Math.min(completionStableCount, 2)}/2`
    });
    if (completionStableCount < 2) return true;

    completionSkipCooldownUntil = Date.now() + 12000;
    updateTask("completion-check", { state: "done", detail: `${result.reason} · 已跳过当前任务` });
    publishStatus({ phase: "done", message: `${result.reason}，正在进入下一未完成任务` });
    goNext();
    return true;
  }

  async function orchestrate() {
    if (!settings.enabled || orchestratorRunning || quizInFlight) return;
    orchestratorRunning = true;
    try {
      if (handleIncompleteTaskDialog()) return;
      const stored = await chrome.storage.local.get("aiConfig");
      const aiConfig = buildAiConfig(stored.aiConfig || {});
      const questions = extractQuestions(aiConfig);
      const videos = [...document.querySelectorAll("video")];
      const readers = findDocumentReaders();
      const blockingVideoQuiz = questions.some(isBlockingVideoQuiz);
      reportVideoQuizState(blockingVideoQuiz);

      if (questions.length && settings.autoAnswer) {
        if (blockingVideoQuiz) {
          suspendVideoForQuiz = true;
          videos.forEach((video) => {
            video.pause();
            const videoTaskId = videoTaskIds.get(video);
            if (videoTaskId) updateTask(videoTaskId, { state: "waiting", detail: "检测到互动题，已暂停" });
          });
        }
        await answerQuestions(false);
        return;
      }

      if (await skipCompletedTaskIfNeeded()) return;

      if (blockingVideoQuiz) {
        suspendVideoForQuiz = true;
        videos.forEach((video) => video.pause());
        publishStatus({ phase: "answering", message: "检测到视频弹题，请开启自动答题或手动完成" });
        return;
      }

      if (readers.length && settings.autoReadDocuments) {
        await processDocuments();
        return;
      }

      if (suspendVideoForQuiz && !blockingVideoQuiz) {
        suspendVideoForQuiz = false;
        publishStatus({ phase: "playing", message: "题目已处理，正在恢复视频播放" });
      }
      if (!blockingVideoQuiz) videos.forEach(playVideo);
    } catch (error) {
      publishStatus({ phase: "error", message: `实时任务检测失败：${error.message}` });
    } finally {
      orchestratorRunning = false;
    }
  }

  function scheduleOrchestrator() {
    if (!settings.enabled) return;
    clearTimeout(orchestratorTimer);
    orchestratorTimer = setTimeout(orchestrate, 220);
  }

  function scan() {
    const videos = [...document.querySelectorAll("video")];
    const documentCount = findDocumentReaders().length;
    if (settings.enabled) {
      videos.forEach((video) => {
        video.muted = settings.muted;
        video.playbackRate = settings.playbackRate;
        attach(video);
      });
    }
    if (!settings.enabled) {
      reportVideoQuizState(false);
      suspendVideoForQuiz = false;
      intentionalPauseUntil = Date.now() + 2000;
    }
    updateTask("watcher", {
      label: "实时监听页面", type: "system", state: settings.enabled ? "running" : "waiting",
      detail: settings.enabled ? `发现 ${videos.length} 个视频、${documentCount} 个课件，持续检测题目` : "站点未启用"
    });
    const countSignature = `${videos.length}:${documentCount}:${settings.enabled}`;
    if (countSignature !== lastCountSignature) {
      lastCountSignature = countSignature;
      publishStatus({
        phase: settings.enabled ? (videos.length ? "playing" : "scanning") : "idle",
        videoCount: videos.length,
        documentCount,
        message: settings.enabled ? `检测到 ${videos.length} 个视频、${documentCount} 个课件，正在监听页面任务` : "当前站点已暂停"
      });
    }
    scheduleOrchestrator();
    return videos.length;
  }

  let scanThrottleTimer;
  function startObserver() {
    observer?.disconnect();
    observer = new MutationObserver(() => {
      if (scanThrottleTimer) return;
      scanThrottleTimer = setTimeout(() => { scanThrottleTimer = undefined; scan(); }, 200);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "FRAME_STATUS_UPDATE") {
      runtimeStatus = { ...runtimeStatus, ...message.status };
      renderFloatingStatus(runtimeStatus);
      sendResponse({ ok: true });
      return false;
    }
    if (!message || !["APPLY_SETTINGS", "RESCAN", "ANSWER_NOW", "GET_STATUS", "TOGGLE_FLOAT"].includes(message.type)) return;
    loadSettings().then(() => {
      if (message.type === "TOGGLE_FLOAT") {
        initFloatingWindow().then(() => {
          if (!floatingUi) return sendResponse({ ok: false });
          const visible = floatingUi.host.style.display === "none";
          setFloatingVisible(visible);
          sendResponse({ ok: true, visible });
        });
        return;
      }
      if (message.type === "GET_STATUS") {
        chrome.storage.local.get("aiConfig").then((stored) => {
          try {
            const aiConfig = buildAiConfig(stored.aiConfig || {});
            const questionCount = extractQuestions(aiConfig).length;
            runtimeStatus = {
              ...runtimeStatus,
              videoCount: document.querySelectorAll("video").length,
              documentCount: findDocumentReaders().length,
              questionCount
            };
          } catch {}
          sendResponse({ ok: true, status: runtimeStatus });
        });
        return;
      }
      if (message.type === "ANSWER_NOW") {
        answerQuestions(true, Boolean(message.allFrames)).then((answerResult) => sendResponse({ ok: answerResult.ok, answerResult }));
        return;
      }
      const videoCount = scan();
      sendResponse({ ok: true, videoCount, status: runtimeStatus });
    });
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[storageKey]) return;
    settings = { ...DEFAULTS, ...(changes[storageKey].newValue || {}) };
    if (!settings.enabled) reportVideoQuizState(false);
    renderFloatingSettings();
    scan();
  });

  loadSettings().then(async () => {
    await initFloatingWindow();
    scan();
    startObserver();
    setInterval(orchestrate, 1000);
    setInterval(scan, 3500);
  }).catch((error) => console.warn("[玥玥刷客] 初始化失败：", error?.message || error));
})();
