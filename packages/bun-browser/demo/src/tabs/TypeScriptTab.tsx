import { useState, useCallback } from "react";
import { useRuntime } from "../context/RuntimeContext";

const TS_PRESETS: Record<string, string> = {
  "ts-class": `// TypeScript 泛型 + 类 + 接口
interface Repository<T extends { id: number }> {
  findById(id: number): T | undefined;
  save(item: T): void;
  list(): T[];
}

class InMemoryRepo<T extends { id: number }> implements Repository<T> {
  private store = new Map<number, T>();
  findById(id: number): T | undefined { return this.store.get(id); }
  save(item: T): void { this.store.set(item.id, item); }
  list(): T[] { return [...this.store.values()]; }
}

interface Product { id: number; name: string; price: number; }

const repo = new InMemoryRepo<Product>();
repo.save({ id: 1, name: "Bun", price: 0 });
repo.save({ id: 2, name: "Deno", price: 0 });

const bun = repo.findById(1);
console.log(bun?.name);`,

  "ts-decorator": `// 模拟装饰器模式（TS 3.x legacy）
function log(target: any, key: string, descriptor: PropertyDescriptor) {
  const orig = descriptor.value;
  descriptor.value = function (...args: unknown[]) {
    console.log(\`[log] \${key}(\${args.join(", ")})\`);
    return orig.apply(this, args);
  };
  return descriptor;
}

class Calculator {
  add(a: number, b: number): number { return a + b; }
  mul(a: number, b: number): number { return a * b; }
}

const c = new Calculator();
console.log(c.add(3, 4));
console.log(c.mul(6, 7));`,

  "tsx-react": `// React JSX (转译验证)
import React from "react";

interface Props {
  name: string;
  count?: number;
}

function Counter({ name, count = 0 }: Props) {
  return (
    <div className="counter">
      <h1>Hello, {name}!</h1>
      <p>Count: <strong>{count}</strong></p>
    </div>
  );
}

export default Counter;`,

  "ts-enum": `// Enum + 类型守卫 + 条件类型
enum Direction { Up = "UP", Down = "DOWN", Left = "LEFT", Right = "RIGHT" }

type Opposite<D extends Direction> =
  D extends Direction.Up    ? Direction.Down  :
  D extends Direction.Down  ? Direction.Up    :
  D extends Direction.Left  ? Direction.Right :
  Direction.Left;

function isHorizontal(d: Direction): d is Direction.Left | Direction.Right {
  return d === Direction.Left || d === Direction.Right;
}

const dir = Direction.Up;
console.log(dir, "is horizontal:", isHorizontal(dir));

const dirs = Object.values(Direction);
dirs.forEach(d => console.log(d, "→ horizontal:", isHorizontal(d)));`,
};

const DEFAULT_TS = `// TypeScript 源码 → 使用内置 bun_transform 转译

interface User {
  id: number;
  name: string;
  email?: string;
}

type Role = "admin" | "user" | "guest";

function greet(user: User, role: Role): string {
  const prefix = role === "admin" ? "👑 " : "";
  return \`\${prefix}Hello, \${user.name}!\`;
}

const users: User[] = [
  { id: 1, name: "Alice", email: "alice@example.com" },
  { id: 2, name: "Bob" },
];

users.forEach(u => {
  console.log(greet(u, u.id === 1 ? "admin" : "user"));
});
`;

export function TypeScriptTab() {
  const { rt } = useRuntime();
  const [input, setInput] = useState(DEFAULT_TS);
  const [output, setOutput] = useState("");
  const [errors, setErrors] = useState("");

  const runTransform = useCallback(() => {
    if (!rt) return;
    const filename = input.includes("JSX") || input.includes("tsx") ? "demo.tsx" : "demo.ts";
    const result = rt.transform(input, filename, { jsx: "react" });
    if (!result) { setOutput("[bun_transform 未导出]"); return; }
    setErrors(result.errors?.length ? result.errors.join(" | ") : "");
    setOutput(result.code ?? "");
  }, [rt, input]);

  return (
    <div className="split">
      <div className="panel">
        <div className="panel-head">
          <span className="title">TypeScript / JSX 源码</span>
          <div className="row">
            <select onChange={e => { if (e.target.value && TS_PRESETS[e.target.value]) setInput(TS_PRESETS[e.target.value]!); e.target.value = ""; }}>
              <option value="">— 选例子 —</option>
              <option value="ts-class">Class + 泛型</option>
              <option value="ts-decorator">装饰器风格</option>
              <option value="tsx-react">React JSX</option>
              <option value="ts-enum">Enum + 类型守卫</option>
            </select>
            <button className="primary" disabled={!rt} onClick={runTransform}>⚡ 转译</button>
          </div>
        </div>
        <textarea className="editor" spellCheck={false} value={input} onChange={e => setInput(e.target.value)} />
      </div>
      <div className="panel">
        <div className="panel-head">
          <span className="title">转译结果 (JS)</span>
          {errors && <span style={{ fontSize: "0.75rem", color: "var(--red)" }}>{errors}</span>}
        </div>
        <pre className="output">{output}</pre>
      </div>
    </div>
  );
}
