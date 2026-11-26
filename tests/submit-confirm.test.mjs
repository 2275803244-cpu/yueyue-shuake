import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const contentSource = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
const backgroundSource = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.search(new RegExp(`\\n  (?:async )?function ${name}\\(`));
  if (start < 0) throw new Error(`找不到函数 ${name}`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n  (?:async )?function [A-Za-z_$][\w$]*\(/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function makeButton(text) {
  return {
    innerText: text,
    textContent: text,
    value: "",
    parentElement: null,
    click() { this.clicked = true; },
    getClientRects: () => [1]
  };
}

function makeDialog(text, buttons) {
  return {
    innerText: text,
    textContent: text,
    getClientRects: () => [1],
    querySelectorAll: () => buttons
  };
}

function makeDoc(dialogs = [], buttons = [], iframes = [], elements = {}) {
  return {
    body: { innerText: "", textContent: "", parentElement: null },
    querySelector(selector) { return elements[selector] || null; },
    querySelectorAll(selector) {
      if (selector === "iframe") return iframes;
      if (selector.includes("role=dialog")) return dialogs;
      return buttons;
    }
  };
}

function buildSandbox({ dialogs = [], buttons = [], childDoc = null, topDoc = null, elements = {} }) {
  const iframes = childDoc ? [{ contentDocument: childDoc }] : [];
  const document = makeDoc(dialogs, buttons, iframes, elements);
  const sandbox = {
    console, JSON, Math, Object, Array, Number, String, Boolean, Set, Map, Promise, RegExp, Error,
    document,
    window: { top: { document: topDoc || document } },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    normalizeText: (value) => String(value ?? "").trim().replace(/\s+/g, " ")
  };
  sandbox.isUsable = (element) => Boolean(element) && element.getClientRects().length > 0;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const names = ["accessibleDocuments", "findSubmitConfirmInfo"];
  vm.runInContext(names.map((name) => extractFunction(contentSource, name)).join("\n"), sandbox);
  return vm.runInContext("findSubmitConfirmInfo", sandbox);
}

test("确认提交弹窗返回可点击按钮", () => {
  const submit = makeButton("提交");
  const cancel = makeButton("取消");
  const dialog = makeDialog("提示 确认提交?", [cancel, submit]);
  const info = buildSandbox({ dialogs: [dialog] })();
  assert.equal(info.status, "clicked");
  assert.equal(info.button, submit);
});

test("学习通 #workpop 弹窗按钮文字为空也能按 id 点击", () => {
  const popok = makeButton("");
  const workpop = { innerText: "提示 确认提交?", textContent: "提示 确认提交?", getClientRects: () => [1] };
  const popcontent = { innerText: "确认提交?", textContent: "确认提交?" };
  const info = buildSandbox({
    elements: { "#workpop": workpop, "#popok": popok, "#popcontent": popcontent }
  })();
  assert.equal(info.status, "clicked");
  assert.equal(info.button, popok);
});

test("确认弹窗在子 iframe 里也能找到", () => {
  const submit = makeButton("提交");
  const dialog = makeDialog("提示 确认提交?", [submit]);
  const childDoc = makeDoc([dialog], []);
  const info = buildSandbox({ childDoc })();
  assert.equal(info.status, "clicked");
  assert.equal(info.button, submit);
});

test("确认弹窗在顶层父页面也能找到", () => {
  const submit = makeButton("提交");
  const dialog = makeDialog("提示 确认提交?", [submit]);
  const topDoc = makeDoc([dialog], []);
  const info = buildSandbox({ topDoc })();
  assert.equal(info.status, "clicked");
  assert.equal(info.button, submit);
});

test("未作答提示必须停手，不能点确认", () => {
  const confirm = makeButton("确定");
  const dialog = makeDialog("还有题目未作答，请选择答案后再提交", [confirm]);
  const info = buildSandbox({ dialogs: [dialog] })();
  assert.equal(info.status, "blocked");
  assert.match(info.message, /未作答/);
  assert.equal(confirm.clicked, undefined);
});

test("没有确认弹窗时不点页面主提交按钮", () => {
  const pageSubmit = makeButton("提交");
  const wrapper = { innerText: "提交答案", textContent: "提交答案", parentElement: { innerText: "", textContent: "" }, getClientRects: () => [1] };
  pageSubmit.parentElement = wrapper;
  const info = buildSandbox({ buttons: [pageSubmit] })();
  assert.equal(info.status, "none");
});

test("后台同样先判拒绝文案再决定是否确认", () => {
  const start = backgroundSource.indexOf("const confirmInfo = () => {");
  assert.ok(start >= 0, "找不到后台确认信息逻辑");
  const end = backgroundSource.indexOf("const originalAlert", start);
  const body = backgroundSource.slice(start, end);
  assert.match(body, /未作答\|请选择\|请作答/);
  assert.match(body, /status: "blocked"/);
  assert.match(body, /status: "clicked"/);
});

test("视频弹题只点专用提交，不回退到整节提交", () => {
  assert.match(contentSource, /function findVideoQuizSubmitButton\(/);
  assert.match(contentSource, /blockingVideoQuiz\s*\?\s*findVideoQuizSubmitButton\(questions\)\s*:\s*findSubmitButton/);
  const start = contentSource.indexOf("function findVideoQuizSubmitButton(");
  const end = contentSource.indexOf("function findQuizContinueButton", start);
  const body = contentSource.slice(start, end);
  assert.ok(!body.includes("document.querySelectorAll(selector)"), "视频弹题提交不能回退到页面通用提交按钮");
});
