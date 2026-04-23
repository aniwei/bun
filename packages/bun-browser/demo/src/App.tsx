import { useState } from "react";
import { useRuntime } from "./context/RuntimeContext";
import { ExecTab } from "./tabs/ExecTab";
import { TypeScriptTab } from "./tabs/TypeScriptTab";
import { BundlerTab } from "./tabs/BundlerTab";
import { VfsTab } from "./tabs/VfsTab";
import { CryptoTab } from "./tabs/CryptoTab";
import { PathUrlTab } from "./tabs/PathUrlTab";
import { SemverTab } from "./tabs/SemverTab";
import { EcosystemTab } from "./tabs/EcosystemTab";
import { NpmInstallTab } from "./tabs/NpmInstallTab";
import { ThreadsTab } from "./tabs/ThreadsTab";
import { BunApiTab } from "./tabs/BunApiTab";
import { WebContainerTab } from "./tabs/WebContainerTab";

type TabId =
  | "exec" | "transform" | "bundler" | "vfs" | "crypto"
  | "path" | "semver" | "ecosystem" | "npm-install"
  | "threads" | "bun-apis" | "webcontainer";

const TABS: Array<{ id: TabId; icon: string; label: string }> = [
  { id: "exec",         icon: "▶",  label: "代码执行" },
  { id: "transform",    icon: "⚡", label: "TS 转译" },
  { id: "bundler",      icon: "📦", label: "Bundler" },
  { id: "vfs",          icon: "🗂", label: "VFS 文件系统" },
  { id: "crypto",       icon: "🔐", label: "加密 & 压缩" },
  { id: "path",         icon: "📁", label: "路径 & URL" },
  { id: "semver",       icon: "🏷", label: "Semver" },
  { id: "ecosystem",    icon: "🧪", label: "生态验证" },
  { id: "npm-install",  icon: "📥", label: "npm 安装" },
  { id: "threads",      icon: "🧵", label: "多线程" },
  { id: "bun-apis",     icon: "🍞", label: "Bun API" },
  { id: "webcontainer", icon: "📦", label: "WebContainer" },
];

export function App() {
  const { status, statusText, wasmSizeKb } = useRuntime();
  const [activeTab, setActiveTab] = useState<TabId>("exec");

  return (
    <div className="shell">
      {/* ── Top bar ── */}
      <header className="topbar">
        <div className="logo">🍞 bun-browser <sub>WebAssembly</sub></div>
        <div className="topbar-sep" />
        <nav className="nav-tabs">
          {TABS.map(t => (
            <div
              key={t.id}
              className={`nav-tab${activeTab === t.id ? " active" : ""}`}
              onClick={() => setActiveTab(t.id)}
            >
              <span className="tab-icon">{t.icon}</span> {t.label}
            </div>
          ))}
        </nav>
        <div className="spacer" />
        <div className="status-pill">
          <div className={`status-dot${status !== "loading" ? " " + status : ""}`} />
          <span>{statusText}</span>
        </div>
      </header>

      {/* ── Tab content ── */}
      <div className="body">
        <div className={`tab-page${activeTab === "exec"         ? " active" : ""}`}><ExecTab /></div>
        <div className={`tab-page${activeTab === "transform"    ? " active" : ""}`}><TypeScriptTab /></div>
        <div className={`tab-page${activeTab === "bundler"      ? " active" : ""}`}><BundlerTab /></div>
        <div className={`tab-page${activeTab === "vfs"          ? " active" : ""}`}>
          <VfsTab onNavigateToExec={() => setActiveTab("exec")} />
        </div>
        <div className={`tab-page${activeTab === "crypto"       ? " active" : ""}`}><CryptoTab /></div>
        <div className={`tab-page${activeTab === "path"         ? " active" : ""}`}><PathUrlTab /></div>
        <div className={`tab-page${activeTab === "semver"       ? " active" : ""}`}><SemverTab /></div>
        <div className={`tab-page${activeTab === "ecosystem"    ? " active" : ""}`}><EcosystemTab /></div>
        <div className={`tab-page${activeTab === "npm-install"  ? " active" : ""}`}><NpmInstallTab /></div>
        <div className={`tab-page${activeTab === "threads"      ? " active" : ""}`}><ThreadsTab /></div>
        <div className={`tab-page${activeTab === "bun-apis"     ? " active" : ""}`}><BunApiTab /></div>
        <div className={`tab-page${activeTab === "webcontainer" ? " active" : ""}`}><WebContainerTab /></div>
      </div>

      {/* ── Bottom bar ── */}
      <footer className="bottombar">
        <span>bun-core.wasm · WebAssembly + JSI bridge</span>
        <span className="bb-right">
          <a href="https://github.com/oven-sh/bun" target="_blank" rel="noreferrer">
            github.com/oven-sh/bun
          </a>
          <span>·</span>
          <span>{wasmSizeKb}</span>
        </span>
      </footer>
    </div>
  );
}
