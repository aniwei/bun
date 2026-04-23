import { useState, useRef, useCallback, KeyboardEvent } from "react";
import { useRuntime, type OutputLine } from "../context/RuntimeContext";
import { buildSnapshot } from "../../../src/vfs-client";

const EXEC_PRESETS: Record<string, string> = {
  fizzbuzz: `// FizzBuzz 经典题
for (let i = 1; i <= 30; i++) {
  if (i % 15 === 0)     console.log("FizzBuzz");
  else if (i % 3 === 0) console.log("Fizz");
  else if (i % 5 === 0) console.log("Buzz");
  else                  console.log(i);
}`,
  fibonacci: `// 迭代 Fibonacci
function fib(n) {
  let [a, b] = [0n, 1n];
  const result = [];
  for (let i = 0; i < n; i++) {
    result.push(String(a));
    [a, b] = [b, a + b];
  }
  return result;
}
console.log(fib(20).join(", "));`,
  json: `// JSON 处理
const data = {
  users: [
    { id: 1, name: "Alice", score: 92 },
    { id: 2, name: "Bob",   score: 78 },
    { id: 3, name: "Carol", score: 88 },
  ]
};
const top = data.users
  .filter(u => u.score >= 80)
  .sort((a, b) => b.score - a.score);
console.log(JSON.stringify(top, null, 2));`,
  array: `// 数组函数式操作
const words = ["bun","wasm","browser","runtime","javascript","zig","webassembly"];
const result = words
  .filter(w => w.length > 4)
  .map(w => w[0].toUpperCase() + w.slice(1))
  .sort()
  .join(", ");
console.log(result);
console.log("总词数:", words.length, "/ 过滤后:", words.filter(w=>w.length>4).length);`,
  class: `// Class + 原型链
class Animal {
  constructor(name) { this.name = name; }
  speak() { return \`\${this.name} makes a sound.\`; }
}
class Dog extends Animal {
  speak() { return \`\${this.name} barks!\`; }
}
class Cat extends Animal {
  speak() { return \`\${this.name} meows.\`; }
}
const pets = [new Dog("Rex"), new Cat("Whiskers"), new Dog("Buddy")];
pets.forEach(p => console.log(p.constructor.name + ":", p.speak()));`,
  async: `// Generator（模拟异步流）
function* range(start, end, step = 1) {
  for (let i = start; i < end; i += step) yield i;
}
function* map(iter, fn) {
  for (const v of iter) yield fn(v);
}
function* filter(iter, pred) {
  for (const v of iter) if (pred(v)) yield v;
}
const pipeline = filter(map(range(1, 100), x => x * x), x => x % 7 === 0);
for (const v of pipeline) console.log(v);`,
  byteops: `// 字节/Buffer 操作
const text = "Hello, bun-browser 🎉";
const buf  = Buffer.from(text, "utf8");
console.log("原始:", text);
console.log("字节长度:", buf.length);
console.log("Hex 前16B:", buf.subarray(0, 16).toString("hex"));
console.log("Base64:", buf.toString("base64"));

// 二进制拼接
const a = Buffer.from([0xDE, 0xAD]);
const b = Buffer.from([0xBE, 0xEF]);
const c = Buffer.concat([a, b]);
console.log("Concat:", c.toString("hex"));`,
};

const DEFAULT_CODE = `// bun-browser · 代码执行 demo
// run 模式：脚本加载进 VFS → require() 可用

const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const result = data
  .filter(n => n % 2 === 0)
  .map(n => n ** 2)
  .reduce((acc, n) => acc + n, 0);

console.log("偶数平方和:", result);

// process.env 访问
console.log("NODE_ENV:", process.env.NODE_ENV ?? "(未设置)");

// Buffer
const buf = Buffer.from("Hello from bun-browser 🎉");
console.log("Buffer length:", buf.length);
console.log("Base64:", buf.toString("base64"));
`;

export function ExecTab() {
  const { rt, setStatus, execOutputLines, appendExecOutput, clearExecOutput } = useRuntime();
  const [code, setCode] = useState(DEFAULT_CODE);
  const [mode, setMode] = useState<"eval" | "run">("run");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  const runCode = useCallback(() => {
    if (!rt) return;
    clearExecOutput();
    setExitCode(null);
    setStatus("运行中…", "busy");
    let code_ = -1;
    try {
      if (mode === "eval") {
        const evalFn = rt.instance.exports.bun_browser_eval as
          (sp: number, sl: number, fp: number, fl: number) => number;
        rt.withString(code, (sp, sl) => {
          rt.withString("<demo>", (fp, fl) => { code_ = evalFn(sp, sl, fp, fl); });
        });
      } else {
        const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number;
        const runFn  = rt.instance.exports.bun_browser_run as (p: number, l: number) => number;
        const snap   = buildSnapshot([{ path: "/main.js", data: code }]);
        rt.withBytes(new Uint8Array(snap), (p, l) => { loadFn(p, l); });
        rt.withString("/main.js", (p, l) => { code_ = runFn(p, l); });
      }
      appendExecOutput(`\n[exit ${code_}]\n`, "x");
      setExitCode(code_);
      setStatus(code_ === 0 ? "就绪 ✓" : `退出码 ${code_}`, code_ === 0 ? "ready" : "error");
    } catch (e) {
      appendExecOutput(`\n[error] ${(e as Error).message}\n`, "e");
      setStatus("运行出错", "error");
    }
  }, [rt, code, mode, setStatus, appendExecOutput, clearExecOutput]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const s = ta.selectionStart;
      const newVal = ta.value.substring(0, s) + "  " + ta.value.substring(ta.selectionEnd);
      setCode(newVal);
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      runCode();
    }
  }, [runCode]);

  return (
    <div className="split">
      <div className="panel">
        <div className="panel-head">
          <span className="title">编辑器</span>
          <div className="row">
            <select value={mode} onChange={e => setMode(e.target.value as "eval" | "run")}>
              <option value="eval">eval 模式</option>
              <option value="run">run 模式 (CJS)</option>
            </select>
            <select onChange={e => { if (e.target.value && EXEC_PRESETS[e.target.value]) setCode(EXEC_PRESETS[e.target.value]!); e.target.value = ""; }}>
              <option value="">— 选例子 —</option>
              {Object.keys(EXEC_PRESETS).map(k => <option key={k} value={k}>{k}</option>)}
            </select>
            <button className="primary" disabled={!rt} onClick={runCode} title="Ctrl+Enter">▶ 运行</button>
            <button onClick={() => { clearExecOutput(); setExitCode(null); }}>清空</button>
          </div>
          <span className="hint">Ctrl+Enter 运行 · Tab 缩进</span>
        </div>
        <textarea className="editor" spellCheck={false} value={code}
          onChange={e => setCode(e.target.value)} onKeyDown={handleKeyDown} />
      </div>
      <div className="panel">
        <div className="panel-head">
          <span className="title">输出</span>
          {exitCode !== null && (
            <span style={{ fontSize: "0.75rem", color: exitCode === 0 ? "var(--green)" : "var(--red)" }}>
              {exitCode === 0 ? "✓ exit 0" : `✗ exit ${exitCode}`}
            </span>
          )}
        </div>
        <pre ref={outputRef} className="output">
          {execOutputLines.map(l => (
            <span key={l.id} className={l.cls || undefined}>{l.text}</span>
          ))}
        </pre>
      </div>
    </div>
  );
}
