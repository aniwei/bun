//! Bun WASM Transform — 轻量 TypeScript strip 转译器 (Phase 5.2)
//!
//! 目标：在 wasm32-freestanding 环境下把 TS/TSX/JSX 源码转换为普通 JS，
//! 不依赖 src/js_parser.zig 全栈，仅用标准库。
//!
//! 支持的转换：
//!   - TypeScript type annotations（变量、参数、返回类型）
//!   - interface / type 声明（整体删除）
//!   - class 属性访问修饰符 (public/private/protected/readonly/abstract/override)
//!   - declare 块（整体删除）
//!   - enum 转换为 IIFE 对象
//!   - as 类型断言（删除 `as Type` 部分）
//!   - 非空断言 `!`（在表达式末尾，不是不等于符号）
//!   - import type / export type（删除整行）
//!   - 泛型参数 `<T>` `<T, U>` 在函数签名与 class 声明中
//!   - JSX（React.createElement / jsx runtime 基础支持，tsx 文件）
//!   - 装饰器 `@Foo` `@Foo(...)` 在 class/方法/参数前
//!   - implements / extends 类型列表中的类型参数
//!
//! 不支持（不在 Phase 5.2 范围内，留给后续 src/js_parser 完整接入）：
//!   - sourcemap
//!   - namespace 合并
//!   - 复杂泛型约束 + 条件类型（已粗粒度删除）
//!   - 模块重映射（paths / exports）— 见 Phase 5.3
//!
//! API:
//!   pub fn transform(alloc, source, opts) !TransformResult
//!
//! WASM ABI (exported via bun_browser_standalone.zig):
//!   bun_transform(opts_ptr: u32, opts_len: u32) u64
//!
//! opts_ptr 指向 JSON 字符串：
//!   { "code": "<TS 源码>", "filename": "<file.ts>", "jsx": "react"|"react-jsx"|"preserve"|null }
//! 返回 packed u64 (ptr << 32 | len)，指向 JSON 字符串：
//!   { "code": "<转换后 JS>", "errors": [] }   — 成功
//!   { "code": null, "errors": ["..."] }        — 转换失败
//!   ptr === 0 → OOM（低 32 位为错误码）

const std = @import("std");
const Allocator = std.mem.Allocator;

pub const TransformOptions = struct {
    /// 原始源码
    source: []const u8,
    /// 文件名，用于判断 .ts / .tsx / .js / .jsx
    filename: []const u8,
    /// JSX 处理模式
    jsx: JsxMode = .react,
    /// 将 ESM import/export 转换为 CommonJS require/module.exports。
    /// Bundler 使用时设为 true，直接调用 bun_transform ABI 时通常为 false。
    esm_to_cjs: bool = false,
    /// 生成 sourcemap v3 JSON（base64-VLQ 编码）。结果存于 TransformResult.map。
    source_map: bool = false,

    pub const JsxMode = enum {
        /// 转换为 React.createElement(...)（默认）
        react,
        /// 转换为 jsx(...)（React 17+ automatic runtime）
        react_jsx,
        /// 保留 JSX 原样（Pass-through）
        preserve,
        /// .ts 文件，不处理 JSX
        none,
    };
};

pub const TransformResult = struct {
    code: ?[]u8,
    errors: []const []const u8,
    /// sourcemap v3 JSON（仅在 opts.source_map = true 时非 null）
    map: ?[]u8 = null,

    alloc: Allocator,

    pub fn deinit(self: *TransformResult) void {
        if (self.code) |c| self.alloc.free(c);
        if (self.map) |m| self.alloc.free(m);
        for (self.errors) |e| self.alloc.free(e);
        self.alloc.free(self.errors);
    }
};

/// 主入口：对外接口。
/// 返回的 TransformResult 由调用者负责调用 .deinit() 释放。
pub fn transform(alloc: Allocator, opts: TransformOptions) Allocator.Error!TransformResult {
    const is_ts = isTypeScriptFile(opts.filename);
    const is_tsx = isTsxFile(opts.filename);
    const is_jsx = isJsxFile(opts.filename);

    // 纯 JS（非 TS，非 JSX），且不需要 ESM→CJS：直接透传
    if (!is_ts and !is_tsx and !is_jsx and !opts.esm_to_cjs) {
        const code = try alloc.dupe(u8, opts.source);
        return .{
            .code = code,
            .errors = try alloc.alloc([]const u8, 0),
            .alloc = alloc,
        };
    }

    var stripper = Stripper.init(alloc, opts);
    stripper.run() catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
    };

    if (stripper.errors.items.len > 0) {
        // 存在错误 — 将 errors 转交 result
        const errs = try stripper.errors.toOwnedSlice(alloc);
        stripper.out.deinit(alloc);
        stripper.exports_deferred.deinit(alloc);
        stripper.line_origins.deinit(alloc);
        return .{
            .code = null,
            .errors = errs,
            .alloc = alloc,
        };
    }

    const code = try stripper.out.toOwnedSlice(alloc);
    const empty_errs = try alloc.alloc([]const u8, 0);

    // 生成 sourcemap（T5.2.7）
    var map: ?[]u8 = null;
    if (opts.source_map) {
        map = generateSourcemap(alloc, opts.filename, stripper.line_origins.items) catch null;
    }
    stripper.line_origins.deinit(alloc);
    stripper.exports_deferred.deinit(alloc);

    return .{
        .code = code,
        .errors = empty_errs,
        .map = map,
        .alloc = alloc,
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// ESM → CJS 数据结构
// ──────────────────────────────────────────────────────────────────────────────

/// 延迟发出的 module.exports 赋值项（named export）
const ExportEntry = struct {
    local: []const u8,    // 本模块中的局部变量名
    exported: []const u8, // 对外导出的名称（可能与 local 不同，如 export { X as Y }）
};

/// 命名导入项（import { key as alias } from ...）
const ImportedName = struct {
    key: []const u8,   // 源模块导出的名字
    alias: []const u8, // 本地绑定名
};

// ──────────────────────────────────────────────────────────────────────────────
// 文件类型判断
// ──────────────────────────────────────────────────────────────────────────────

fn isTypeScriptFile(name: []const u8) bool {
    return std.mem.endsWith(u8, name, ".ts") or
        std.mem.endsWith(u8, name, ".mts") or
        std.mem.endsWith(u8, name, ".cts");
}

fn isTsxFile(name: []const u8) bool {
    return std.mem.endsWith(u8, name, ".tsx");
}

fn isJsxFile(name: []const u8) bool {
    return std.mem.endsWith(u8, name, ".jsx") or
        std.mem.endsWith(u8, name, ".mjsx") or
        std.mem.endsWith(u8, name, ".cjsx");
}

// ──────────────────────────────────────────────────────────────────────────────
// Stripper：逐字节状态机
// ──────────────────────────────────────────────────────────────────────────────

/// 词法状态
const LexState = enum {
    normal,
    /// 单行注释
    line_comment,
    /// 块注释
    block_comment,
    /// 单引号字符串
    string_single,
    /// 双引号字符串
    string_double,
    /// 模板字符串
    template,
    /// 模板表达式 `${`
    template_expr,
    /// 正则表达式（极简处理，不保证 100% 正确）
    regex,
};

const Stripper = struct {
    alloc: Allocator,
    src: []const u8,
    pos: usize,
    out: std.ArrayList(u8),
    errors: std.ArrayList([]const u8),
    opts: TransformOptions,
    state: LexState,
    /// template 嵌套深度（`${` 内部的 `${`）
    template_depth: u32,
    /// 括号深度，用于确定泛型结束位置
    paren_depth: u32,
    /// 花括号深度
    brace_depth: u32,
    /// 尖括号深度（泛型参数时用）
    angle_depth: u32,
    /// 是否已发出过 jsx import（react-jsx 模式需要）
    jsx_import_emitted: bool,
    /// T5.2.6: 延迟 module.exports 赋值列表（named export）
    exports_deferred: std.ArrayListUnmanaged(ExportEntry),
    /// T5.2.7: sourcemap 行映射（第 i 项 = 第 i 个输出换行符对应的输入行号）
    line_origins: std.ArrayListUnmanaged(u32),
    /// T5.2.7: 当前处理到的输入行号（在 run() 外层循环更新）
    input_line: u32,
    /// T5.2.6: re-export 临时变量计数器，用于生成 _re0_ _re1_ ...
    reexport_counter: u32,

    fn init(alloc: Allocator, opts: TransformOptions) Stripper {
        return .{
            .alloc = alloc,
            .src = opts.source,
            .pos = 0,
            .out = std.ArrayList(u8){},
            .errors = std.ArrayList([]const u8){},
            .opts = opts,
            .state = .normal,
            .template_depth = 0,
            .paren_depth = 0,
            .brace_depth = 0,
            .angle_depth = 0,
            .jsx_import_emitted = false,
            .exports_deferred = .empty,
            .line_origins = .empty,
            .input_line = 0,
            .reexport_counter = 0,
        };
    }

    fn run(self: *Stripper) Allocator.Error!void {
        // jsx runtime 模式：在文件顶部插入 import 语句
        if (self.opts.jsx == .react_jsx and
            (isTsxFile(self.opts.filename) or isJsxFile(self.opts.filename)))
        {
            try self.emitSlice("import{jsx as _jsx,jsxs as _jsxs,Fragment as _Fragment}from'react/jsx-runtime';\n");
            self.jsx_import_emitted = true;
        }

        while (self.pos < self.src.len) {
            const pos_before = self.pos;
            switch (self.state) {
                .normal => try self.processNormal(),
                .line_comment => try self.processLineComment(),
                .block_comment => try self.processBlockComment(),
                .string_single => try self.processStringChar('\''),
                .string_double => try self.processStringChar('"'),
                .template => try self.processTemplate(),
                .template_expr => try self.processNormal(), // 复用 normal
                .regex => try self.processRegex(),
            }
            // T5.2.7: 追踪本轮消耗的输入换行数（用于 sourcemap 行号映射）
            if (self.opts.source_map) {
                for (self.src[pos_before..self.pos]) |c| {
                    if (c == '\n') self.input_line += 1;
                }
            }
        }

        // T5.2.6: 发出延迟的 module.exports 赋值
        if (self.opts.esm_to_cjs and self.exports_deferred.items.len > 0) {
            try self.emitSlice("\n");
            for (self.exports_deferred.items) |e| {
                try self.emitSlice("module.exports[\"");
                try self.emitJsStr(e.exported);
                try self.emitSlice("\"]=");
                try self.emitSlice(e.local);
                try self.emitSlice(";\n");
            }
        }
    }

    fn cur(self: *const Stripper) u8 {
        if (self.pos >= self.src.len) return 0;
        return self.src[self.pos];
    }

    fn peek(self: *const Stripper, offset: usize) u8 {
        const i = self.pos + offset;
        if (i >= self.src.len) return 0;
        return self.src[i];
    }

    fn advance(self: *Stripper) void {
        self.pos += 1;
    }

    fn emit(self: *Stripper, ch: u8) Allocator.Error!void {
        try self.out.append(self.alloc, ch);
        // T5.2.7: 每个输出换行符记录对应的输入行号
        if (ch == '\n' and self.opts.source_map) {
            try self.line_origins.append(self.alloc, self.input_line);
        }
    }

    fn emitSlice(self: *Stripper, s: []const u8) Allocator.Error!void {
        try self.out.appendSlice(self.alloc, s);
        // T5.2.7: 统计 slice 内的换行符
        if (self.opts.source_map) {
            for (s) |c| {
                if (c == '\n') {
                    try self.line_origins.append(self.alloc, self.input_line);
                }
            }
        }
    }

    fn remaining(self: *const Stripper) []const u8 {
        return self.src[self.pos..];
    }

    // ────────────────────────────────────────────────────
    // 主处理：normal 状态下的逐字符处理
    // ────────────────────────────────────────────────────

    fn processNormal(self: *Stripper) Allocator.Error!void {
        const c = self.cur();

        // ── 注释开始 ──────────────────────────────────────
        if (c == '/' and self.peek(1) == '/') {
            self.state = .line_comment;
            try self.emitSlice("//");
            self.pos += 2;
            return;
        }
        if (c == '/' and self.peek(1) == '*') {
            self.state = .block_comment;
            try self.emitSlice("/*");
            self.pos += 2;
            return;
        }

        // ── 字符串开始 ────────────────────────────────────
        if (c == '\'') {
            self.state = .string_single;
            try self.emit('\'');
            self.pos += 1;
            return;
        }
        if (c == '"') {
            self.state = .string_double;
            try self.emit('"');
            self.pos += 1;
            return;
        }
        if (c == '`') {
            self.state = .template;
            try self.emit('`');
            self.pos += 1;
            return;
        }

        // ── 装饰器 @Identifier ────────────────────────────
        if (c == '@' and self.pos + 1 < self.src.len and isIdentStart(self.src[self.pos + 1])) {
            try self.skipDecorator();
            return;
        }

        // ── 关键字检测 ────────────────────────────────────
        if (isIdentStart(c)) {
            try self.processIdentOrKeyword();
            return;
        }

        // ── JSX 处理 ──────────────────────────────────────
        const do_jsx = self.opts.jsx != .preserve and self.opts.jsx != .none and
            (isTsxFile(self.opts.filename) or isJsxFile(self.opts.filename));

        if (do_jsx and c == '<') {
            // 是否是 JSX 元素开始？
            if (self.tryProcessJsx()) |handled| {
                if (handled) return;
            }
        }

        // ── 括号深度跟踪 ──────────────────────────────────
        if (c == '(') self.paren_depth += 1;
        if (c == ')') {
            if (self.paren_depth > 0) self.paren_depth -= 1;
        }
        if (c == '{') self.brace_depth += 1;
        if (c == '}') {
            if (self.brace_depth > 0) self.brace_depth -= 1;
        }

        // ── 非空断言 ! ────────────────────────────────────
        // `!` 在 TS 中作为非空断言时可安全删除（后面是 . [ ( 等）
        // 注意：不能删除 !== 和 ! 开头的逻辑非
        if (c == '!' and self.pos + 1 < self.src.len) {
            const next = self.src[self.pos + 1];
            if (next == '.' or next == '[' or next == '(' or next == ',' or next == ')' or
                next == ';' or next == ' ' or next == '\n' or next == '\r' or next == '\t')
            {
                // 非空断言：跳过
                self.pos += 1;
                return;
            }
        }

        // ── TypeScript 类型注解 `: Type` ─────────────────────
        // 在非对象字面量（brace_depth==0）中，`: identifier/builtin-type...`
        // 且上一个非空白源码字符是标识符或 ] 或 )，认为是 TS 类型注解，跳过。
        if (c == ':' and self.brace_depth == 0) {
            const prev_ch = prevNonWhitespace(self.src, self.pos);
            if (prev_ch != null and (isIdentCont(prev_ch.?) or prev_ch.? == ']' or prev_ch.? == ')')) {
                // 确认冒号后面是类型名（标识符、{ ( [ " ` 等）
                const after_colon = nextNonWhitespace(self.src, self.pos + 1);
                if (after_colon != null and
                    (isIdentStart(after_colon.?) or
                        after_colon.? == '{' or after_colon.? == '(' or
                        after_colon.? == '[' or after_colon.? == '"' or
                        after_colon.? == '\'' or after_colon.? == '`'))
                {
                    self.pos += 1; // skip ':'
                    try self.skipTypeAnnotation(.colon);
                    return;
                }
            }
        }

        // ── 正则表达式（极简检测）────────────────────────
        // 在 = , ( return ! & | ? : 之后看到 / 时认为是正则
        // （此处只跳过正则避免把 / 误解析为注释开始）
        // 已在上面处理了 // 和 /* 的情况

        try self.emit(c);
        self.pos += 1;
    }

    // ────────────────────────────────────────────────────
    // 关键字 / 标识符处理
    // ────────────────────────────────────────────────────

    fn processIdentOrKeyword(self: *Stripper) Allocator.Error!void {
        const start = self.pos;
        while (self.pos < self.src.len and isIdentCont(self.src[self.pos])) {
            self.pos += 1;
        }
        const word = self.src[start..self.pos];

        // ── TypeScript 整块删除关键字 ─────────────────────
        if (std.mem.eql(u8, word, "interface")) {
            try self.skipTypeDeclaration("interface");
            return;
        }
        if (std.mem.eql(u8, word, "declare")) {
            try self.skipDeclare();
            return;
        }

        // ── import type 整行删除 ───────────────────────────
        if (std.mem.eql(u8, word, "import")) {
            try self.handleImportKeyword();
            return;
        }

        // ── export type 整行删除 ───────────────────────────
        if (std.mem.eql(u8, word, "export")) {
            try self.handleExportKeyword(start);
            return;
        }

        // ── type Alias = ... 删除 ─────────────────────────
        if (std.mem.eql(u8, word, "type")) {
            // 只有在语句开头（前一个非空字符不是 : = < 等时）才是 type alias 声明
            if (self.isTypeAliasDecl(start)) {
                try self.skipTypeAlias();
                return;
            }
        }

        // ── enum 转换 ─────────────────────────────────────
        if (std.mem.eql(u8, word, "enum")) {
            try self.handleEnum(false);
            return;
        }
        if (std.mem.eql(u8, word, "const") and self.peekKeyword("enum")) {
            try self.emitSlice("/* const enum -> */ ");
            self.skipWhitespace();
            // 跳过 "enum" keyword
            self.pos += 4;
            self.skipWhitespace();
            try self.handleEnum(true);
            return;
        }

        // ── class 修饰符 (access modifier) 删除 ─────────────
        if (std.mem.eql(u8, word, "public") or
            std.mem.eql(u8, word, "private") or
            std.mem.eql(u8, word, "protected"))
        {
            // 只有在 class body 上下文中才删除
            // 简化处理：如果后面是空白 + 标识符（方法/属性名），则删除修饰符
            if (self.isAccessModifierContext()) {
                // 用空格替代，保持行列
                try self.emitWhitespaceForStr(word);
                return;
            }
        }
        if (std.mem.eql(u8, word, "readonly") or
            std.mem.eql(u8, word, "abstract") or
            std.mem.eql(u8, word, "override"))
        {
            if (self.isAccessModifierContext()) {
                try self.emitWhitespaceForStr(word);
                return;
            }
        }

        // ── implements + 类型列表删除 ─────────────────────
        if (std.mem.eql(u8, word, "implements")) {
            try self.skipImplementsList();
            return;
        }

        // ── satisfies 删除 ────────────────────────────────
        if (std.mem.eql(u8, word, "satisfies")) {
            // `expr satisfies Type` → 删除 "satisfies Type" 部分
            try self.emitWhitespaceForStr(word);
            self.skipWhitespace();
            try self.skipTypeAnnotation(.satisfies);
            return;
        }

        // ── as 类型断言删除 ──────────────────────────────
        if (std.mem.eql(u8, word, "as")) {
            // 仅在表达式上下文中（不是 import...as x 形式）
            if (self.isAsAssertion()) {
                // 删除 "as Type" 整段
                try self.emitWhitespaceForStr(word);
                self.skipWhitespace();
                try self.skipTypeAnnotation(.as_assertion);
                return;
            }
        }

        // ── function 或 class 后的泛型参数 ───────────────
        // 输出 word，然后检查是否有 <T> 泛型参数需要跳过
        try self.emitSlice(word);

        // 如果后面有泛型参数 <T...> 且在函数/class/箭头函数上下文中
        const ws_start = self.pos;
        self.skipWhitespace();
        if (self.cur() == '<' and isGenericContext(word)) {
            try self.skipGenericParameters();
            return;
        }
        // Re-emit any whitespace consumed by skipWhitespace (not part of generic)
        try self.emitSlice(self.src[ws_start..self.pos]);
    }

    fn isGenericContext(word: []const u8) bool {
        return std.mem.eql(u8, word, "function") or
            std.mem.eql(u8, word, "class") or
            std.mem.eql(u8, word, "interface") or
            std.mem.eql(u8, word, "type") or
            std.mem.eql(u8, word, "extends");
    }

    fn isTypeAliasDecl(self: *const Stripper, start: usize) bool {
        // 向前找最近的非空白字符
        if (start == 0) return true;
        var i: usize = start;
        while (i > 0) {
            i -= 1;
            const ch = self.src[i];
            if (ch == ' ' or ch == '\t' or ch == '\r' or ch == '\n') continue;
            // 如果是 : = < > ( , 等，那么 "type" 是类型位置的标识符，不是 type alias 声明
            if (ch == ':' or ch == '=' or ch == '<' or ch == ',' or ch == '(' or
                ch == '|' or ch == '&' or ch == '[' or ch == '{')
                return false;
            // 如果是换行或语句边界（; }），认为是 type alias 声明
            if (ch == ';' or ch == '}' or ch == '{') return true;
            // 其他字符：向前看是否是行首
            break;
        }
        return true;
    }

    fn isAsAssertion(self: *const Stripper) bool {
        // "as" 作为断言时，前面是表达式（标识符、) ] 等），后面是类型名
        // "as" 作为 import alias 时，前面是标识符，后面也是标识符
        // 简化：检查后面的 token — 如果是 const/let/var/any 等 TS 关键字则是断言
        const after = self.src[self.pos..];
        if (after.len == 0) return false;
        // 如果后面是 "const" 紧跟着非标识符字符：`as const`
        if (std.mem.startsWith(u8, after, "const") and
            (after.len == 5 or !isIdentCont(after[5])))
            return true;
        // 如果后面是类型名（大写开头或常见类型关键字）+ 后面是非标识符
        // 简化：凡是前面是 ]) 或标识符结尾，后面跟着一个大写字母或 TS 内置类型关键字，认为是断言
        if (after.len > 0 and (std.ascii.isUpper(after[0]) or isTypeBuiltin(after)))
            return true;
        return false;
    }

    fn isTypeBuiltin(s: []const u8) bool {
        const builtins = [_][]const u8{
            "string", "number", "boolean", "object", "any", "unknown", "never",
            "void", "null", "undefined", "symbol", "bigint",
        };
        for (builtins) |b| {
            if (std.mem.startsWith(u8, s, b)) {
                if (s.len == b.len or !isIdentCont(s[b.len])) return true;
            }
        }
        return false;
    }

    fn isAccessModifierContext(self: *const Stripper) bool {
        // 简化：如果后面是空白 + 标识符或 readonly/abstract 等关键字，认为在 class body 中
        var i = self.pos;
        while (i < self.src.len and (self.src[i] == ' ' or self.src[i] == '\t')) {
            i += 1;
        }
        if (i >= self.src.len) return false;
        return isIdentStart(self.src[i]) or self.src[i] == '[' or self.src[i] == '#';
    }

    fn emitWhitespaceForStr(self: *Stripper, s: []const u8) Allocator.Error!void {
        // 用等数量空格替换，保持列对齐
        for (s) |_| try self.emit(' ');
    }

    fn peekKeyword(self: *const Stripper, kw: []const u8) bool {
        var i = self.pos;
        while (i < self.src.len and (self.src[i] == ' ' or self.src[i] == '\t')) {
            i += 1;
        }
        if (i + kw.len > self.src.len) return false;
        if (!std.mem.eql(u8, self.src[i .. i + kw.len], kw)) return false;
        // 确保 kw 之后不是标识符字符
        if (i + kw.len < self.src.len and isIdentCont(self.src[i + kw.len])) return false;
        return true;
    }

    // ────────────────────────────────────────────────────
    // 跳过类型相关构造
    // ────────────────────────────────────────────────────

    /// 跳过泛型参数列表 `<T, U extends V, ...>`（单行，最多 4 层嵌套）
    fn skipGenericParameters(self: *Stripper) Allocator.Error!void {
        if (self.cur() != '<') return;
        var depth: u32 = 0;
        var in_str_single = false;
        var in_str_double = false;
        while (self.pos < self.src.len) {
            const c = self.src[self.pos];
            if (!in_str_single and !in_str_double) {
                if (c == '<') {
                    depth += 1;
                } else if (c == '>') {
                    if (depth == 0) break;
                    depth -= 1;
                    if (depth == 0) {
                        self.pos += 1; // skip >
                        return;
                    }
                } else if (c == '\'') {
                    in_str_single = true;
                } else if (c == '"') {
                    in_str_double = true;
                }
            } else if (in_str_single and c == '\'') {
                in_str_single = false;
            } else if (in_str_double and c == '"') {
                in_str_double = false;
            }
            self.pos += 1;
        }
    }

    const TypeAnnotationContext = enum { colon, as_assertion, satisfies };

    /// 跳过类型注解（`: Type`、`as Type`、`satisfies Type`）
    /// pos 应在类型名开始处（已跳过了 `:` / `as` / `satisfies`）
    fn skipTypeAnnotation(self: *Stripper, ctx: TypeAnnotationContext) Allocator.Error!void {
        _ = ctx;
        // 跳过空白
        self.skipWhitespace();

        // 类型可以是：
        //   - 标识符（可能有泛型 Foo<Bar>）
        //   - 联合 A | B
        //   - 交叉 A & B
        //   - 数组 Type[]
        //   - 元组 [A, B]
        //   - 函数 (a: A) => B
        //   - 对象字面量 { key: T }
        //   - typeof expr
        //   - infer T
        //   - keyof T
        //   - 括号 (T)
        //   - 字面量 "x" | 1 | true
        //   - 模板字面量 `${T}`

        try self.skipTypeExpr(0);
    }

    fn skipTypeExpr(self: *Stripper, depth: u32) Allocator.Error!void {
        if (depth > 8) return; // 防无限递归

        self.skipWhitespace();
        if (self.pos >= self.src.len) return;

        const c = self.cur();

        // 括号 (T)
        if (c == '(') {
            self.pos += 1;
            try self.skipTypeExpr(depth + 1);
            self.skipWhitespace();
            if (self.cur() == ')') self.pos += 1;
            // (a: A) => B 形式
            self.skipWhitespace();
            if (self.cur() == '=' and self.peek(1) == '>') {
                self.pos += 2;
                try self.skipTypeExpr(depth + 1);
                return;
            }
        }
        // 元组 / 数组字面量
        else if (c == '[') {
            var d: u32 = 1;
            self.pos += 1;
            while (self.pos < self.src.len and d > 0) {
                if (self.src[self.pos] == '[') d += 1
                else if (self.src[self.pos] == ']') d -= 1;
                self.pos += 1;
            }
        }
        // 对象字面量类型 { ... }
        else if (c == '{') {
            var d: u32 = 1;
            self.pos += 1;
            while (self.pos < self.src.len and d > 0) {
                if (self.src[self.pos] == '{') d += 1
                else if (self.src[self.pos] == '}') d -= 1;
                self.pos += 1;
            }
        }
        // 字符串字面量类型
        else if (c == '"' or c == '\'') {
            const q = c;
            self.pos += 1;
            while (self.pos < self.src.len) {
                const ch = self.src[self.pos];
                self.pos += 1;
                if (ch == '\\') {
                    self.pos += 1;
                } else if (ch == q) {
                    break;
                }
            }
        }
        // 模板字面量类型 `${T}`
        else if (c == '`') {
            self.pos += 1;
            while (self.pos < self.src.len) {
                const ch = self.src[self.pos];
                self.pos += 1;
                if (ch == '\\') {
                    self.pos += 1;
                } else if (ch == '`') {
                    break;
                } else if (ch == '$' and self.cur() == '{') {
                    self.pos += 1;
                    try self.skipTypeExpr(depth + 1);
                    self.skipWhitespace();
                    if (self.cur() == '}') self.pos += 1;
                }
            }
        }
        // 关键字或标识符
        else if (isIdentStart(c)) {
            while (self.pos < self.src.len and isIdentCont(self.src[self.pos])) {
                self.pos += 1;
            }
            // 泛型参数 Foo<T>
            self.skipWhitespace();
            if (self.cur() == '<') {
                try self.skipGenericParameters();
            }
            // 函数类型：ident(...) => T  或 typeof expr
        }
        // typeof / keyof / infer / unique / readonly（前缀）
        // — 已被上面的 isIdentStart 处理

        // 数组后缀 T[]
        self.skipWhitespace();
        while (self.pos < self.src.len and self.cur() == '[') {
            const next = self.peek(1);
            if (next == ']') {
                self.pos += 2;
                self.skipWhitespace();
            } else {
                // 索引类型 T[K]
                var d: u32 = 1;
                self.pos += 1;
                while (self.pos < self.src.len and d > 0) {
                    if (self.src[self.pos] == '[') d += 1
                    else if (self.src[self.pos] == ']') d -= 1;
                    self.pos += 1;
                }
                self.skipWhitespace();
            }
        }

        // 联合 A | B 或交叉 A & B
        self.skipWhitespace();
        while (self.pos < self.src.len) {
            const op = self.cur();
            if (op == '|' or op == '&') {
                // 确保不是 || 或 &&
                if (self.peek(1) == op) break;
                self.pos += 1;
                try self.skipTypeExpr(depth + 1);
            } else {
                break;
            }
            self.skipWhitespace();
        }

        // 条件类型 T extends U ? V : W
        self.skipWhitespace();
        if (self.src.len > self.pos + 7 and
            std.mem.startsWith(u8, self.src[self.pos..], "extends"))
        {
            // 只在类型上下文中处理 extends（不是 class extends）
            const after = self.src[self.pos + 7 ..];
            if (after.len > 0 and !isIdentCont(after[0])) {
                self.pos += 7;
                try self.skipTypeExpr(depth + 1); // U
                self.skipWhitespace();
                if (self.cur() == '?') {
                    self.pos += 1;
                    try self.skipTypeExpr(depth + 1); // V
                    self.skipWhitespace();
                    if (self.cur() == ':') {
                        self.pos += 1;
                        try self.skipTypeExpr(depth + 1); // W
                    }
                }
            }
        }
    }

    /// 跳过 interface 或 type 块声明（到下一个 { } 块结束为止）
    fn skipTypeDeclaration(_: *Stripper, _: []const u8) Allocator.Error!void {
        // interface / type 已经输出了没有...不对，应该不输出它们
        // 由于我们在 processIdentOrKeyword 中已经消费了 word，
        // 需要由 handle 函数在遇到关键字时不输出 word，
        // 此函数应该跳过到 { 块结束，并用换行替换
        // 见 skipTypeDeclBlock
    }

    fn skipTypeDeclBlock(self: *Stripper) Allocator.Error!void {
        // 跳过直到遇到 { 然后跳过整个 { ... } 块
        // 但类型可能有 = 后面接一个类型表达式（无花括号）
        // interface Foo { ... }  → 有大括号
        // interface Foo extends Bar { ... }  → 有大括号
        // type Foo = { ... }  → 等号后有大括号
        // type Foo = T | U  → 无大括号
        var found_brace = false;
        // 扫描直到行尾或 { 或 ;
        while (self.pos < self.src.len) {
            const c = self.src[self.pos];
            if (c == '{') {
                found_brace = true;
                self.pos += 1;
                break;
            }
            if (c == ';' or c == '\n') {
                self.pos += 1;
                try self.emit('\n');
                return;
            }
            self.pos += 1;
        }
        if (!found_brace) return;
        // 跳过 { ... } 块
        var depth: u32 = 1;
        while (self.pos < self.src.len and depth > 0) {
            const c = self.src[self.pos];
            if (c == '{') depth += 1
            else if (c == '}') depth -= 1;
            self.pos += 1;
        }
        // 补一个换行
        try self.emit('\n');
    }

    fn handleImportKeyword(self: *Stripper) Allocator.Error!void {
        // ── T5.3.5: import.meta.url / import.meta.env / import.meta.resolve ──────
        // Checked BEFORE skipWhitespace: import.meta has no space between `import` and `.meta`
        if (self.cur() == '.') {
            if (std.mem.startsWith(u8, self.remaining(), ".meta")) {
                const after_pos = self.pos + 5;
                if (after_pos >= self.src.len or !isIdentCont(self.src[after_pos])) {
                    self.pos += 5; // consume ".meta"
                    try self.emitImportMeta();
                    return;
                }
            }
            // import.xxx where xxx != meta — unusual; pass through
            if (!self.opts.esm_to_cjs) try self.emitSlice("import");
            return;
        }

        const ws_start = self.pos;
        self.skipWhitespace();

        // ── T5.3.6: import("spec") — dynamic import ──────────────────────────────
        if (self.cur() == '(') {
            self.pos += 1; // consume '('
            self.skipWhitespace();
            if (self.opts.esm_to_cjs and (self.cur() == '"' or self.cur() == '\'')) {
                const spec = self.readQuotedStr();
                self.skipWhitespace();
                if (self.cur() == ')') {
                    self.pos += 1; // consume ')'
                    try self.emitSlice("Promise.resolve().then(function(){return require(\"");
                    try self.emitJsStr(spec);
                    try self.emitSlice("\")})" );
                    return;
                }
            }
            // Non-static or non-ESM-CJS: pass through as import(
            try self.emitSlice("import(");
            return;
        }

        if (std.mem.startsWith(u8, self.remaining(), "type ") or
            std.mem.startsWith(u8, self.remaining(), "type\n") or
            std.mem.startsWith(u8, self.remaining(), "type\r"))
        {
            // import type — 跳过整条语句到 ; 或行尾
            try self.skipToEndOfStatement();
            return;
        }

        // 非 ESM→CJS 模式：直接透传
        if (!self.opts.esm_to_cjs) {
            try self.emitSlice("import");
            try self.emitSlice(self.src[ws_start..self.pos]);
            return;
        }

        // ── ESM→CJS 模式 ─────────────────────────────────────────────────────

        // import "spec" 或 import 'spec'（副作用导入）
        if (self.cur() == '"' or self.cur() == '\'') {
            const spec = self.readQuotedStr();
            self.skipToSemicolon();
            try self.emitSlice("require(\"");
            try self.emitJsStr(spec);
            try self.emitSlice("\");\n");
            return;
        }

        // import * as ns from 'spec'
        if (self.cur() == '*') {
            self.pos += 1;
            self.skipWhitespace();
            if (std.mem.startsWith(u8, self.remaining(), "as ") or
                std.mem.startsWith(u8, self.remaining(), "as\t"))
            {
                self.pos += 2;
                self.skipWhitespace();
                const ns_start = self.pos;
                while (self.pos < self.src.len and isIdentCont(self.src[self.pos])) self.pos += 1;
                const ns_name = self.src[ns_start..self.pos];
                self.skipWhitespace();
                if (std.mem.startsWith(u8, self.remaining(), "from")) {
                    self.pos += 4;
                    self.skipWhitespace();
                    const spec = self.readQuotedStr();
                    self.skipToSemicolon();
                    try self.emitSlice("const ");
                    try self.emitSlice(ns_name);
                    try self.emitSlice("=require(\"");
                    try self.emitJsStr(spec);
                    try self.emitSlice("\");\n");
                    return;
                }
            }
            try self.emit('\n');
            return;
        }

        // import { A, B as C } from 'spec'
        // import X from 'spec'
        // import X, { A, B } from 'spec'
        var default_name: ?[]const u8 = null;
        var named: std.ArrayListUnmanaged(ImportedName) = .empty;
        defer named.deinit(self.alloc);

        if (self.cur() == '{') {
            try self.parseImportedNames(&named);
            self.skipWhitespace();
        } else if (isIdentStart(self.cur())) {
            const n_start = self.pos;
            while (self.pos < self.src.len and isIdentCont(self.src[self.pos])) self.pos += 1;
            default_name = self.src[n_start..self.pos];
            self.skipWhitespace();
            if (self.cur() == ',') {
                self.pos += 1;
                self.skipWhitespace();
                if (self.cur() == '{') {
                    try self.parseImportedNames(&named);
                }
                self.skipWhitespace();
            }
        }

        // Expect "from"
        if (!std.mem.startsWith(u8, self.remaining(), "from")) {
            try self.emit('\n');
            return;
        }
        self.pos += 4;
        self.skipWhitespace();
        const spec = self.readQuotedStr();
        self.skipToSemicolon();

        if (default_name == null and named.items.len == 0) {
            try self.emit('\n');
            return;
        }

        if (default_name != null and named.items.len > 0) {
            // 混合：var _i_=require('spec'); const X=(_i_.default??_i_); const{A,B}=_i_;
            const ctr = self.reexport_counter;
            self.reexport_counter += 1;
            var ctr_buf: [20]u8 = undefined;
            const tmp = std.fmt.bufPrint(&ctr_buf, "_i{d}_", .{ctr}) catch "_i_";
            try self.emitSlice("var ");
            try self.emitSlice(tmp);
            try self.emitSlice("=require(\"");
            try self.emitJsStr(spec);
            try self.emitSlice("\");const ");
            try self.emitSlice(default_name.?);
            try self.emitSlice("=(");
            try self.emitSlice(tmp);
            try self.emitSlice(".default??");
            try self.emitSlice(tmp);
            try self.emitSlice(");const{");
            for (named.items, 0..) |nm, i| {
                if (i > 0) try self.emit(',');
                try self.emitSlice(nm.key);
                if (!std.mem.eql(u8, nm.alias, nm.key)) {
                    try self.emit(':');
                    try self.emitSlice(nm.alias);
                }
            }
            try self.emit('}');
            try self.emit('=');
            try self.emitSlice(tmp);
            try self.emitSlice(";\n");
        } else if (default_name != null) {
            // default only: const X=(require('spec').default??require('spec'));
            try self.emitSlice("const ");
            try self.emitSlice(default_name.?);
            try self.emitSlice("=(require(\"");
            try self.emitJsStr(spec);
            try self.emitSlice("\").default??require(\"");
            try self.emitJsStr(spec);
            try self.emitSlice("\"));\n");
        } else {
            // named only: const{A,B:C}=require('spec');
            try self.emitSlice("const{");
            for (named.items, 0..) |nm, i| {
                if (i > 0) try self.emit(',');
                try self.emitSlice(nm.key);
                if (!std.mem.eql(u8, nm.alias, nm.key)) {
                    try self.emit(':');
                    try self.emitSlice(nm.alias);
                }
            }
            try self.emitSlice("}=require(\"");
            try self.emitJsStr(spec);
            try self.emitSlice("\");\n");
        }
    }

    fn handleExportKeyword(self: *Stripper, start: usize) Allocator.Error!void {
        _ = start;
        // export type ... → 删除
        const ws_start = self.pos;
        self.skipWhitespace();
        if (std.mem.startsWith(u8, self.remaining(), "type ") or
            std.mem.startsWith(u8, self.remaining(), "type{") or
            std.mem.startsWith(u8, self.remaining(), "type\n"))
        {
            try self.skipToEndOfStatement();
            return;
        }
        // 非 ESM→CJS 模式：直接透传
        if (!self.opts.esm_to_cjs) {
            try self.emitSlice("export");
            try self.emitSlice(self.src[ws_start..self.pos]);
            return;
        }

        // ── ESM→CJS 模式 ─────────────────────────────────────────────────────

        const rem = self.remaining();

        // export * from 'spec'
        if (rem.len > 0 and rem[0] == '*') {
            self.pos += 1;
            self.skipWhitespace();
            if (std.mem.startsWith(u8, self.remaining(), "from")) {
                self.pos += 4;
                self.skipWhitespace();
                const spec = self.readQuotedStr();
                self.skipToSemicolon();
                try self.emitSlice("Object.assign(module.exports,require(\"");
                try self.emitJsStr(spec);
                try self.emitSlice("\"));\n");
            } else {
                try self.emit('\n');
            }
            return;
        }

        // export { A, B as X } [from 'spec']
        if (rem.len > 0 and rem[0] == '{') {
            var names: std.ArrayListUnmanaged(ExportEntry) = .empty;
            defer names.deinit(self.alloc);
            try self.parseExportedNames(&names);
            self.skipWhitespace();

            if (std.mem.startsWith(u8, self.remaining(), "from")) {
                // Re-export from another module
                self.pos += 4;
                self.skipWhitespace();
                const spec = self.readQuotedStr();
                self.skipToSemicolon();
                const ctr = self.reexport_counter;
                self.reexport_counter += 1;
                var ctr_buf: [24]u8 = undefined;
                const tmp = std.fmt.bufPrint(&ctr_buf, "_re{d}_", .{ctr}) catch "_re_";
                try self.emitSlice("var ");
                try self.emitSlice(tmp);
                try self.emitSlice("=require(\"");
                try self.emitJsStr(spec);
                try self.emitSlice("\");");
                for (names.items) |n| {
                    try self.emitSlice("module.exports[\"");
                    try self.emitJsStr(n.exported);
                    try self.emitSlice("\"]=");
                    try self.emitSlice(tmp);
                    try self.emit('.');
                    try self.emitSlice(n.local);
                    try self.emit(';');
                }
                try self.emit('\n');
            } else {
                // Local named export — defer
                self.skipToSemicolon();
                for (names.items) |n| {
                    try self.exports_deferred.append(self.alloc, .{
                        .local = n.local,
                        .exported = n.exported,
                    });
                }
                try self.emit('\n');
            }
            return;
        }

        // export default ...
        if (std.mem.startsWith(u8, rem, "default")) {
            self.pos += 7; // "default"
            self.skipWhitespace();
            // module.exports = module.exports.default = <expr/fn/class>
            // function/class 成为表达式（赋值时合法）
            try self.emitSlice("module.exports=module.exports.default=");
            // 如果后面是 function/async function，直接作为表达式流入
            return;
        }

        // export const/let/var X = ...
        if (std.mem.startsWith(u8, rem, "const ") or
            std.mem.startsWith(u8, rem, "let ") or
            std.mem.startsWith(u8, rem, "var "))
        {
            const sp_idx = std.mem.indexOfScalar(u8, rem, ' ') orelse rem.len;
            const kw = rem[0..sp_idx];
            self.pos += sp_idx + 1;
            self.skipWhitespace();
            const name_start = self.pos;
            while (self.pos < self.src.len and isIdentCont(self.src[self.pos])) self.pos += 1;
            const var_name = self.src[name_start..self.pos];
            // 发出声明（不含 export 关键字）
            try self.emitSlice(kw);
            try self.emit(' ');
            try self.emitSlice(var_name);
            // 延迟导出
            try self.exports_deferred.append(self.alloc, .{ .local = var_name, .exported = var_name });
            return;
        }

        // export function foo(...)
        if (std.mem.startsWith(u8, rem, "function") or
            std.mem.startsWith(u8, rem, "async "))
        {
            if (std.mem.startsWith(u8, rem, "async ")) {
                try self.emitSlice("async ");
                self.pos += 6;
                self.skipWhitespace();
            }
            // "function"
            self.pos += 8;
            self.skipWhitespace();
            const name_start = self.pos;
            while (self.pos < self.src.len and isIdentCont(self.src[self.pos])) self.pos += 1;
            const fn_name = self.src[name_start..self.pos];
            try self.emitSlice("function ");
            try self.emitSlice(fn_name);
            try self.exports_deferred.append(self.alloc, .{ .local = fn_name, .exported = fn_name });
            return;
        }

        // export class Foo
        if (std.mem.startsWith(u8, rem, "class ") or std.mem.startsWith(u8, rem, "class{")) {
            self.pos += 5; // "class"
            self.skipWhitespace();
            const name_start = self.pos;
            while (self.pos < self.src.len and isIdentCont(self.src[self.pos])) self.pos += 1;
            const class_name = self.src[name_start..self.pos];
            try self.emitSlice("class ");
            try self.emitSlice(class_name);
            try self.exports_deferred.append(self.alloc, .{ .local = class_name, .exported = class_name });
            return;
        }

        // Fallthrough: 未识别的 export 形式，直接透传
        try self.emitSlice("export");
        try self.emitSlice(self.src[ws_start..self.pos]);
    }

    fn skipToEndOfStatement(self: *Stripper) Allocator.Error!void {
        // 跳过到 ; 或流到一个 } 结构（不包含 { … } 块）
        // 简单实现：找 ; 或 \n（不在字符串内）
        var depth: u32 = 0;
        while (self.pos < self.src.len) {
            const c = self.src[self.pos];
            if (c == '{') depth += 1;
            if (c == '}') {
                if (depth == 0) break;
                depth -= 1;
            }
            if (c == ';' or (c == '\n' and depth == 0)) {
                self.pos += 1;
                try self.emit('\n');
                return;
            }
            self.pos += 1;
        }
        try self.emit('\n');
    }

    fn skipTypeAlias(self: *Stripper) Allocator.Error!void {
        // type Foo = ...
        // 跳过整条 type 语句
        try self.skipTypeDeclBlock();
    }

    fn skipDeclare(self: *Stripper) Allocator.Error!void {
        // declare ... — 整段删除
        self.skipWhitespace();
        // 如果后面是 { 块，跳整块。否则跳到行尾 / ;
        if (self.cur() == '{') {
            var depth: u32 = 1;
            self.pos += 1;
            while (self.pos < self.src.len and depth > 0) {
                const c = self.src[self.pos];
                if (c == '{') depth += 1
                else if (c == '}') depth -= 1;
                self.pos += 1;
            }
        } else {
            // 跳到语句结束
            var found_brace = false;
            while (self.pos < self.src.len) {
                const c = self.src[self.pos];
                if (c == '{') { found_brace = true; break; }
                if (c == ';' or c == '\n') { self.pos += 1; break; }
                self.pos += 1;
            }
            if (found_brace) {
                var depth: u32 = 1;
                self.pos += 1; // skip {
                while (self.pos < self.src.len and depth > 0) {
                    const c = self.src[self.pos];
                    if (c == '{') depth += 1
                    else if (c == '}') depth -= 1;
                    self.pos += 1;
                }
            }
        }
        try self.emit('\n');
    }

    fn handleEnum(self: *Stripper, is_const: bool) Allocator.Error!void {
        _ = is_const;
        // enum Foo { A, B = 2, C }
        // → const Foo = Object.freeze({ A: 0, B: 2, C: 3 })
        self.skipWhitespace();
        // 读取 enum 名称
        const name_start = self.pos;
        while (self.pos < self.src.len and isIdentCont(self.src[self.pos])) {
            self.pos += 1;
        }
        const name = self.src[name_start..self.pos];
        self.skipWhitespace();

        if (self.cur() != '{') {
            // 语法错误，跳过
            try self.emit('\n');
            return;
        }
        self.pos += 1; // skip {

        // 解析成员
        var members: std.ArrayList(EnumMember) = std.ArrayList(EnumMember){};
        defer members.deinit(self.alloc);

        var next_val: i64 = 0;
        while (self.pos < self.src.len) {
            self.skipWhitespace();
            if (self.cur() == '}') {
                self.pos += 1;
                break;
            }
            if (self.cur() == ',' or self.cur() == ';') {
                self.pos += 1;
                continue;
            }
            // 读取成员名
            const mname_start = self.pos;
            while (self.pos < self.src.len and
                (isIdentCont(self.src[self.pos]) or self.src[self.pos] == '"' or self.src[self.pos] == '\''))
            {
                // 字符串成员名
                if (self.src[self.pos] == '"' or self.src[self.pos] == '\'') {
                    const q = self.src[self.pos];
                    self.pos += 1;
                    while (self.pos < self.src.len and self.src[self.pos] != q) {
                        if (self.src[self.pos] == '\\') self.pos += 1;
                        self.pos += 1;
                    }
                    if (self.pos < self.src.len) self.pos += 1;
                    break;
                }
                self.pos += 1;
            }
            const mname = self.src[mname_start..self.pos];
            self.skipWhitespace();

            var val: i64 = next_val;
            if (self.cur() == '=') {
                self.pos += 1;
                self.skipWhitespace();
                // 读取数值（只支持整数字面量）
                const neg = self.cur() == '-';
                if (neg) self.pos += 1;
                const num_start = self.pos;
                while (self.pos < self.src.len and
                    self.src[self.pos] >= '0' and self.src[self.pos] <= '9')
                {
                    self.pos += 1;
                }
                if (self.pos > num_start) {
                    val = std.fmt.parseInt(i64, self.src[num_start..self.pos], 10) catch next_val;
                    if (neg) val = -val;
                } else {
                    // 非整数表达式：使用 undefined（保守处理）
                    // 跳到 , 或 }
                    while (self.pos < self.src.len and
                        self.src[self.pos] != ',' and self.src[self.pos] != '}')
                    {
                        self.pos += 1;
                    }
                }
            }
            next_val = val + 1;

            try members.append(self.alloc, .{ .name = mname, .val = val });
        }

        // 输出
        try self.emitSlice("const ");
        try self.emitSlice(name);
        try self.emitSlice("=Object.freeze({");
        for (members.items, 0..) |m, i| {
            if (i > 0) try self.emit(',');
            try self.emitSlice(m.name);
            try self.emit(':');
            var num_buf: [32]u8 = undefined;
            const num_str = std.fmt.bufPrint(&num_buf, "{d}", .{m.val}) catch "0";
            try self.emitSlice(num_str);
        }
        try self.emitSlice("});");
    }

    const EnumMember = struct {
        name: []const u8,
        val: i64,
    };

    fn skipImplementsList(self: *Stripper) Allocator.Error!void {
        // class Foo implements Bar, Baz { ... }
        // → 删除 "implements Bar, Baz"
        // 输出空格代替
        const impl_str = "implements";
        try self.emitWhitespaceForStr(impl_str);
        // 跳到 { 或 extends
        self.skipWhitespace();
        while (self.pos < self.src.len) {
            const c = self.cur();
            if (c == '{' or c == '\n') break;
            // 遇到 "extends" 也停（不应该在 implements 后再有 extends，但保险起见）
            if (isIdentStart(c)) {
                const kw_start = self.pos;
                while (self.pos < self.src.len and isIdentCont(self.src[self.pos])) {
                    self.pos += 1;
                }
                const kw = self.src[kw_start..self.pos];
                if (std.mem.eql(u8, kw, "extends")) {
                    // 把 "extends" 输出并停止
                    try self.emitSlice(kw);
                    return;
                }
                // 否则跳过这个标识符（是类型名）
                continue;
            }
            self.pos += 1; // skip , < > 等
        }
    }

    fn skipDecorator(self: *Stripper) Allocator.Error!void {
        // @Foo 或 @Foo(...)
        self.skipWhitespace(); // 应该已在 @ 前
        self.pos += 1; // skip @
        // 读取装饰器名
        while (self.pos < self.src.len and isIdentCont(self.src[self.pos])) {
            self.pos += 1;
        }
        // 可选括号
        self.skipWhitespace();
        if (self.cur() == '(') {
            var depth: u32 = 1;
            self.pos += 1;
            while (self.pos < self.src.len and depth > 0) {
                const c = self.src[self.pos];
                if (c == '(') depth += 1
                else if (c == ')') depth -= 1;
                self.pos += 1;
            }
        }
        // 消耗后面的换行
        self.skipWhitespace();
        try self.emit('\n');
    }

    fn skipWhitespace(self: *Stripper) void {
        while (self.pos < self.src.len) {
            const c = self.src[self.pos];
            if (c == ' ' or c == '\t' or c == '\r') {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn prevNonWhitespace(src: []const u8, before: usize) ?u8 {
        if (before == 0) return null;
        var i: usize = before;
        while (i > 0) {
            i -= 1;
            const ch = src[i];
            if (ch != ' ' and ch != '\t' and ch != '\r' and ch != '\n') return ch;
        }
        return null;
    }

    fn nextNonWhitespace(src: []const u8, from: usize) ?u8 {
        var i: usize = from;
        while (i < src.len) : (i += 1) {
            const ch = src[i];
            if (ch != ' ' and ch != '\t' and ch != '\r' and ch != '\n') return ch;
        }
        return null;
    }

    // ────────────────────────────────────────────────────
    // 字符串与注释处理
    // ────────────────────────────────────────────────────

    fn processLineComment(self: *Stripper) Allocator.Error!void {
        const c = self.cur();
        if (c == '\n') {
            self.state = .normal;
            try self.emit('\n');
            self.pos += 1;
        } else {
            try self.emit(c);
            self.pos += 1;
        }
    }

    fn processBlockComment(self: *Stripper) Allocator.Error!void {
        const c = self.cur();
        if (c == '*' and self.peek(1) == '/') {
            try self.emitSlice("*/");
            self.pos += 2;
            self.state = .normal;
        } else {
            try self.emit(c);
            self.pos += 1;
        }
    }

    fn processStringChar(self: *Stripper, quote: u8) Allocator.Error!void {
        const c = self.cur();
        if (c == '\\') {
            const next = self.peek(1);
            try self.emit('\\');
            try self.emit(next);
            self.pos += 2;
        } else if (c == quote) {
            try self.emit(quote);
            self.pos += 1;
            self.state = .normal;
        } else {
            try self.emit(c);
            self.pos += 1;
        }
    }

    fn processTemplate(self: *Stripper) Allocator.Error!void {
        const c = self.cur();
        if (c == '\\') {
            try self.emit('\\');
            try self.emit(self.peek(1));
            self.pos += 2;
        } else if (c == '$' and self.peek(1) == '{') {
            try self.emitSlice("${");
            self.pos += 2;
            self.template_depth += 1;
            self.state = .template_expr;
        } else if (c == '`') {
            try self.emit('`');
            self.pos += 1;
            self.state = .normal;
        } else {
            try self.emit(c);
            self.pos += 1;
        }
    }

    fn processRegex(self: *Stripper) Allocator.Error!void {
        const c = self.cur();
        if (c == '\\') {
            try self.emit('\\');
            try self.emit(self.peek(1));
            self.pos += 2;
        } else if (c == '/') {
            try self.emit('/');
            self.pos += 1;
            // 跳过标志 gimsuy
            while (self.pos < self.src.len and std.ascii.isAlphabetic(self.src[self.pos])) {
                try self.emit(self.src[self.pos]);
                self.pos += 1;
            }
            self.state = .normal;
        } else if (c == '[') {
            try self.emit('[');
            self.pos += 1;
            while (self.pos < self.src.len and self.src[self.pos] != ']') {
                if (self.src[self.pos] == '\\') {
                    try self.emit('\\');
                    try self.emit(self.peek(1));
                    self.pos += 2;
                } else {
                    try self.emit(self.src[self.pos]);
                    self.pos += 1;
                }
            }
        } else {
            try self.emit(c);
            self.pos += 1;
        }
    }

    // ────────────────────────────────────────────────────
    // JSX 处理（基础版）
    // ────────────────────────────────────────────────────

    /// 检测并处理 JSX 元素。返回 null 表示无法检测（调用方继续正常处理），
    /// 返回 true/false 表示已处理/未处理。
    fn tryProcessJsx(self: *Stripper) ?bool {
        // JSX 元素的特征：
        //   1. `<` 后面紧跟大写字母（组件）或小写字母（DOM 元素）或 > 或 /（Fragment）
        //   2. 不是 `<T>` 泛型（这在函数/类后面出现）
        //   3. 不是比较 `a < b`（后面是空白或运算符则不是 JSX）
        if (self.cur() != '<') return null;
        const next = self.peek(1);

        // <> Fragment 开始
        if (next == '>') {
            _ = self.processJsxElement() catch return false;
            return true;
        }
        // </> Fragment 结束
        if (next == '/' and self.peek(2) == '>') {
            return null; // 由元素处理
        }
        // 组件或 DOM 元素
        if (std.ascii.isAlphabetic(next) or next == '_' or next == '$') {
            // 区分 JSX 和泛型参数 / 比较：
            // 如果前一个非空字符是 ( = , return [ ? : 等，认为是 JSX
            // 如果前一个非空字符是标识符/数字，则是比较或泛型
            if (!self.couldBeJsxContext()) return null;
            _ = self.processJsxElement() catch return false;
            return true;
        }
        return null;
    }

    fn couldBeJsxContext(self: *const Stripper) bool {
        // 向后找最近的非空字符
        if (self.pos == 0) return true;
        var i: usize = self.pos;
        while (i > 0) {
            i -= 1;
            const c = self.src[i];
            if (c == ' ' or c == '\t' or c == '\r' or c == '\n') continue;
            // 这些字符后面可以是 JSX
            if (c == '(' or c == '=' or c == ',' or c == '[' or c == '?' or
                c == ':' or c == '&' or c == '|' or c == '{' or c == '}')
                return true;
            // return 关键字后面
            if (i >= 5 and std.mem.eql(u8, self.src[i - 5 .. i + 1], "return")) return true;
            return false;
        }
        return true;
    }

    /// 处理完整 JSX 元素（包含子元素），转换为 React.createElement / _jsx
    fn processJsxElement(self: *Stripper) Allocator.Error!void {
        // 极简 JSX → React.createElement 转换
        // <Tag props...>children</Tag>  →  React.createElement(Tag, {props}, children)
        // <Tag/>                         →  React.createElement(Tag, null)
        // <>children</>                  →  React.createElement(React.Fragment, null, children)

        if (self.cur() != '<') return;
        self.pos += 1;

        // 读取标签名
        const tag_start = self.pos;
        while (self.pos < self.src.len and
            (isIdentCont(self.src[self.pos]) or self.src[self.pos] == '.'))
        {
            self.pos += 1;
        }
        const tag_name = self.src[tag_start..self.pos];
        const is_fragment = tag_name.len == 0;

        // 根据模式选择函数
        const fn_name = switch (self.opts.jsx) {
            .react_jsx => if (is_fragment) "_jsxs" else "_jsx",
            else => "React.createElement",
        };

        try self.emitSlice(fn_name);
        try self.emit('(');

        if (is_fragment) {
            if (self.opts.jsx == .react_jsx) {
                try self.emitSlice("_Fragment");
            } else {
                try self.emitSlice("React.Fragment");
            }
        } else {
            // 如果组件名是小写，用字符串；大写直接用标识符
            if (std.ascii.isLower(tag_name[0])) {
                try self.emit('"');
                try self.emitSlice(tag_name);
                try self.emit('"');
            } else {
                try self.emitSlice(tag_name);
            }
        }

        self.skipWhitespace();

        // 解析 props（简单版：输出为对象字面量）
        var has_props = false;
        var is_self_closing = false;

        if (self.cur() == '/') {
            is_self_closing = true;
            self.pos += 1; // skip /
            if (self.cur() == '>') self.pos += 1; // skip >
            try self.emitSlice(",null)");
            return;
        }

        var props_buf = std.ArrayList(u8){};
        defer props_buf.deinit(self.alloc);

        while (self.pos < self.src.len) {
            self.skipWhitespace();
            const c = self.cur();
            if (c == '>') {
                self.pos += 1;
                break;
            }
            if (c == '/') {
                is_self_closing = true;
                self.pos += 1;
                if (self.cur() == '>') self.pos += 1;
                break;
            }
            // 属性名
            if (!isIdentStart(c) and c != '{') break;

            if (c == '{') {
                // spread: {...expr}
                if (!has_props) {
                    try props_buf.appendSlice(self.alloc, "{}");
                    has_props = true;
                }
                // 跳过 spread（简化）
                var d: u32 = 1;
                self.pos += 1;
                while (self.pos < self.src.len and d > 0) {
                    if (self.src[self.pos] == '{') d += 1
                    else if (self.src[self.pos] == '}') d -= 1;
                    self.pos += 1;
                }
                continue;
            }

            has_props = true;
            const attr_start = self.pos;
            while (self.pos < self.src.len and (isIdentCont(self.src[self.pos]) or self.src[self.pos] == '-')) {
                self.pos += 1;
            }
            const attr_name = self.src[attr_start..self.pos];
            try props_buf.appendSlice(self.alloc, attr_name);

            self.skipWhitespace();
            if (self.cur() == '=') {
                self.pos += 1;
                try props_buf.append(self.alloc, ':');
                self.skipWhitespace();
                const v = self.cur();
                if (v == '"' or v == '\'' or v == '`') {
                    const q = v;
                    try props_buf.append(self.alloc, q);
                    self.pos += 1;
                    while (self.pos < self.src.len and self.src[self.pos] != q) {
                        try props_buf.append(self.alloc, self.src[self.pos]);
                        self.pos += 1;
                    }
                    if (self.pos < self.src.len) {
                        try props_buf.append(self.alloc, q);
                        self.pos += 1;
                    }
                } else if (v == '{') {
                    // 表达式
                    var d: u32 = 1;
                    self.pos += 1;
                    while (self.pos < self.src.len and d > 0) {
                        if (self.src[self.pos] == '{') d += 1
                        else if (self.src[self.pos] == '}') d -= 1;
                        if (d > 0) try props_buf.append(self.alloc, self.src[self.pos]);
                        self.pos += 1;
                    }
                }
            } else {
                // boolean 属性
                try props_buf.appendSlice(self.alloc, ":true");
            }
            try props_buf.append(self.alloc, ',');
        }

        if (has_props) {
            try self.emit(',');
            try self.emit('{');
            try self.out.appendSlice(self.alloc, props_buf.items);
            try self.emit('}');
        } else {
            try self.emitSlice(",null");
        }

        if (is_self_closing) {
            try self.emit(')');
            return;
        }

        // 处理子元素（递归，极简：把子元素作为字符串或 createElement 调用）
        // 这里简化处理：直接读取子内容，遇到 </ 则结束
        var has_children = false;
        while (self.pos < self.src.len) {
            if (self.cur() == '<' and self.peek(1) == '/') {
                // 结束标签
                self.pos += 2; // skip </
                while (self.pos < self.src.len and self.src[self.pos] != '>') {
                    self.pos += 1;
                }
                if (self.pos < self.src.len) self.pos += 1; // skip >
                break;
            }
            if (self.cur() == '<') {
                has_children = true;
                try self.emit(',');
                try self.processJsxElement();
                continue;
            }
            if (self.cur() == '{') {
                // 表达式子节点
                has_children = true;
                self.pos += 1;
                try self.emit(',');
                var d: u32 = 1;
                while (self.pos < self.src.len and d > 0) {
                    if (self.src[self.pos] == '{') d += 1
                    else if (self.src[self.pos] == '}') d -= 1;
                    if (d > 0) try self.emit(self.src[self.pos]);
                    self.pos += 1;
                }
                continue;
            }
            // 文本内容
            const txt_start = self.pos;
            while (self.pos < self.src.len and self.src[self.pos] != '<' and self.src[self.pos] != '{') {
                self.pos += 1;
            }
            const txt = self.src[txt_start..self.pos];
            // 跳过纯空白文本
            var all_ws = true;
            for (txt) |ch| {
                if (ch != ' ' and ch != '\t' and ch != '\n' and ch != '\r') {
                    all_ws = false;
                    break;
                }
            }
            if (!all_ws) {
                has_children = true;
                try self.emit(',');
                try self.emit('"');
                // 简单 JSON 转义
                for (txt) |ch| {
                    if (ch == '"') try self.emitSlice("\\\"")
                    else if (ch == '\\') try self.emitSlice("\\\\")
                    else if (ch == '\n') try self.emitSlice("\\n")
                    else try self.emit(ch);
                }
                try self.emit('"');
            }
        }

        // has_children used above
        try self.emit(')');
    }

    // ── T5.3.5: import.meta 多填充 ────────────────────────────────────────────

    /// 在消费了 ".meta" 之后调用，根据模式发出相应的 polyfill 或透传。
    fn emitImportMeta(self: *Stripper) Allocator.Error!void {
        if (!self.opts.esm_to_cjs) {
            // 非 ESM 模式：原样透传
            try self.emitSlice("import.meta");
            return;
        }
        // ESM→CJS 模式：替换为运行时 polyfill
        if (std.mem.startsWith(u8, self.remaining(), ".url")) {
            const after = self.remaining()[4..];
            if (after.len == 0 or !isIdentCont(after[0])) {
                self.pos += 4;
                try self.emitSlice("\"");
                try self.emitJsStr(self.opts.filename);
                try self.emitSlice("\"");
                return;
            }
        }
        if (std.mem.startsWith(u8, self.remaining(), ".env")) {
            const after = self.remaining()[4..];
            if (after.len == 0 or !isIdentCont(after[0])) {
                self.pos += 4;
                try self.emitSlice("(typeof process!==\"undefined\"?process.env:{})");
                return;
            }
        }
        if (std.mem.startsWith(u8, self.remaining(), ".resolve(")) {
            self.pos += 9; // consume ".resolve("
            try self.emitSlice("require.resolve(");
            return;
        }
        // Unknown import.meta.xxx — emit object with common polyfills
        try self.emitSlice("({url:\"");
        try self.emitJsStr(self.opts.filename);
        try self.emitSlice("\",env:typeof process!==\"undefined\"?process.env:{}})");
    }

    // ── T5.2.6: ESM→CJS 辅助方法 ────────────────────────────────────────────

    /// 读取当前 pos 指向的带引号字符串内容（不含引号），推进 pos 到引号后。
    fn readQuotedStr(self: *Stripper) []const u8 {
        if (self.pos >= self.src.len) return "";
        const q = self.src[self.pos];
        if (q != '"' and q != '\'') return "";
        self.pos += 1;
        const start = self.pos;
        while (self.pos < self.src.len and self.src[self.pos] != q) {
            if (self.src[self.pos] == '\\') self.pos += 1;
            if (self.pos < self.src.len) self.pos += 1;
        }
        const end = self.pos;
        if (self.pos < self.src.len) self.pos += 1;
        return self.src[start..end];
    }

    /// 推进 pos 到语句结尾（; 或 \n 或 EOF）。
    fn skipToSemicolon(self: *Stripper) void {
        while (self.pos < self.src.len) {
            const c = self.src[self.pos];
            self.pos += 1;
            if (c == ';' or c == '\n') return;
        }
    }

    /// 将字符串输出为 JS 字符串字面量内容（用于双引号包裹）。
    fn emitJsStr(self: *Stripper, s: []const u8) Allocator.Error!void {
        for (s) |c| {
            switch (c) {
                '"' => try self.emitSlice("\\\""),
                '\\' => try self.emitSlice("\\\\"),
                '\n' => try self.emitSlice("\\n"),
                '\r' => try self.emitSlice("\\r"),
                else => try self.emit(c),
            }
        }
    }

    /// 解析 `{ A, B as C, ... }` 格式的命名导入列表，填入 buf。
    fn parseImportedNames(self: *Stripper, buf: *std.ArrayListUnmanaged(ImportedName)) Allocator.Error!void {
        self.skipWhitespace();
        if (self.cur() != '{') return;
        self.pos += 1;
        while (self.pos < self.src.len) {
            self.skipWhitespace();
            if (self.cur() == '}') { self.pos += 1; break; }
            if (self.cur() == ',') { self.pos += 1; continue; }
            if (!isIdentStart(self.cur())) { self.pos += 1; continue; }
            const key_start = self.pos;
            while (self.pos < self.src.len and isIdentCont(self.src[self.pos])) self.pos += 1;
            const key = self.src[key_start..self.pos];
            self.skipWhitespace();
            if (std.mem.startsWith(u8, self.remaining(), "as ") or
                std.mem.startsWith(u8, self.remaining(), "as\t"))
            {
                self.pos += 2;
                self.skipWhitespace();
                const alias_start = self.pos;
                while (self.pos < self.src.len and isIdentCont(self.src[self.pos])) self.pos += 1;
                const alias = self.src[alias_start..self.pos];
                try buf.append(self.alloc, .{ .key = key, .alias = alias });
            } else {
                try buf.append(self.alloc, .{ .key = key, .alias = key });
            }
        }
    }

    /// 解析 `{ A, B as X, ... }` 格式的命名导出列表，填入 buf。
    fn parseExportedNames(self: *Stripper, buf: *std.ArrayListUnmanaged(ExportEntry)) Allocator.Error!void {
        self.skipWhitespace();
        if (self.cur() != '{') return;
        self.pos += 1;
        while (self.pos < self.src.len) {
            self.skipWhitespace();
            if (self.cur() == '}') { self.pos += 1; break; }
            if (self.cur() == ',') { self.pos += 1; continue; }
            if (!isIdentStart(self.cur())) { self.pos += 1; continue; }
            const local_start = self.pos;
            while (self.pos < self.src.len and isIdentCont(self.src[self.pos])) self.pos += 1;
            const local = self.src[local_start..self.pos];
            self.skipWhitespace();
            if (std.mem.startsWith(u8, self.remaining(), "as ") or
                std.mem.startsWith(u8, self.remaining(), "as\t"))
            {
                self.pos += 2;
                self.skipWhitespace();
                const exp_start = self.pos;
                while (self.pos < self.src.len and isIdentCont(self.src[self.pos])) self.pos += 1;
                const exported = self.src[exp_start..self.pos];
                try buf.append(self.alloc, .{ .local = local, .exported = exported });
            } else {
                try buf.append(self.alloc, .{ .local = local, .exported = local });
            }
        }
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// 字符分类辅助函数
// ──────────────────────────────────────────────────────────────────────────────

fn isIdentStart(c: u8) bool {
    return std.ascii.isAlphabetic(c) or c == '_' or c == '$';
}

fn isIdentCont(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '_' or c == '$';
}

// ──────────────────────────────────────────────────────────────────────────────
// T5.2.7: VLQ 编码 + sourcemap 生成（自由函数，不依赖 Stripper）
// ──────────────────────────────────────────────────────────────────────────────

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn vlqEncodeValue(out: *std.ArrayListUnmanaged(u8), alloc: Allocator, value: i32) Allocator.Error!void {
    // 有符号整数 → 无符号 VLQ（最低位为符号位）→ 每 5 位一组 base64
    var v: u32 = if (value < 0)
        (@as(u32, @intCast(-value)) << 1) | 1
    else
        @as(u32, @intCast(value)) << 1;
    while (true) {
        var digit: u8 = @intCast(v & 0x1F);
        v >>= 5;
        if (v > 0) digit |= 0x20; // continuation bit
        try out.append(alloc, BASE64_CHARS[digit]);
        if (v == 0) break;
    }
}

/// 生成 sourcemap v3 JSON。
/// line_origins[i] = 第 i 个输出换行符对应的输入行号。
fn generateSourcemap(
    alloc: Allocator,
    filename: []const u8,
    line_origins: []const u32,
) Allocator.Error![]u8 {
    var mappings: std.ArrayListUnmanaged(u8) = .empty;
    defer mappings.deinit(alloc);

    var prev_src_line: i32 = 0;

    // 输出行 0：映射到输入行 0，列 0
    try vlqEncodeValue(&mappings, alloc, 0); // output col delta
    try vlqEncodeValue(&mappings, alloc, 0); // source file delta
    try vlqEncodeValue(&mappings, alloc, 0); // source line delta
    try vlqEncodeValue(&mappings, alloc, 0); // source col delta

    // 输出行 1..N：每个换行符之后对应的输入行
    for (line_origins, 0..) |src_line, idx| {
        _ = idx;
        try mappings.append(alloc, ';');
        const delta = @as(i32, @intCast(src_line)) - prev_src_line;
        try vlqEncodeValue(&mappings, alloc, 0);
        try vlqEncodeValue(&mappings, alloc, 0);
        try vlqEncodeValue(&mappings, alloc, delta);
        try vlqEncodeValue(&mappings, alloc, 0);
        prev_src_line = @intCast(src_line);
    }

    // 组装完整 sourcemap JSON
    var json: std.ArrayListUnmanaged(u8) = .empty;
    defer json.deinit(alloc);

    try json.appendSlice(alloc, "{\"version\":3,\"sources\":[\"");
    for (filename) |c| {
        if (c == '"' or c == '\\') try json.append(alloc, '\\');
        try json.append(alloc, c);
    }
    try json.appendSlice(alloc, "\"],\"mappings\":\"");
    try json.appendSlice(alloc, mappings.items);
    try json.appendSlice(alloc, "\",\"names\":[]}");

    return json.toOwnedSlice(alloc);
}

// ──────────────────────────────────────────────────────────────────────────────
// 测试（host-native，不依赖 WASM）
// ──────────────────────────────────────────────────────────────────────────────

test "strip interface declaration" {
    const alloc = std.testing.allocator;
    const src = "interface Foo { x: number; }\nconst y = 1;";
    var result = try transform(alloc, .{ .source = src, .filename = "test.ts", .jsx = .none });
    defer result.deinit();
    try std.testing.expect(result.code != null);
    try std.testing.expect(std.mem.indexOf(u8, result.code.?, "interface") == null);
    try std.testing.expect(std.mem.indexOf(u8, result.code.?, "const y = 1;") != null);
}

test "strip type alias" {
    const alloc = std.testing.allocator;
    const src = "type Foo = string | number;\nconst x: Foo = 'hi';";
    var result = try transform(alloc, .{ .source = src, .filename = "test.ts", .jsx = .none });
    defer result.deinit();
    try std.testing.expect(result.code != null);
    try std.testing.expect(std.mem.indexOf(u8, result.code.?, "type Foo") == null);
}

test "strip import type" {
    const alloc = std.testing.allocator;
    const src = "import type { Foo } from './foo';\nimport { bar } from './bar';";
    var result = try transform(alloc, .{ .source = src, .filename = "test.ts", .jsx = .none });
    defer result.deinit();
    try std.testing.expect(result.code != null);
    try std.testing.expect(std.mem.indexOf(u8, result.code.?, "import type") == null);
    try std.testing.expect(std.mem.indexOf(u8, result.code.?, "import { bar }") != null);
}

test "convert enum" {
    const alloc = std.testing.allocator;
    const src = "enum Color { Red, Green = 5, Blue }";
    var result = try transform(alloc, .{ .source = src, .filename = "test.ts", .jsx = .none });
    defer result.deinit();
    try std.testing.expect(result.code != null);
    try std.testing.expect(std.mem.indexOf(u8, result.code.?, "Object.freeze") != null);
    try std.testing.expect(std.mem.indexOf(u8, result.code.?, "Red:0") != null);
    try std.testing.expect(std.mem.indexOf(u8, result.code.?, "Green:5") != null);
    try std.testing.expect(std.mem.indexOf(u8, result.code.?, "Blue:6") != null);
}

test "strip declare" {
    const alloc = std.testing.allocator;
    const src = "declare function foo(): void;\nconst x = 1;";
    var result = try transform(alloc, .{ .source = src, .filename = "test.ts", .jsx = .none });
    defer result.deinit();
    try std.testing.expect(result.code != null);
    try std.testing.expect(std.mem.indexOf(u8, result.code.?, "declare") == null);
    try std.testing.expect(std.mem.indexOf(u8, result.code.?, "const x = 1;") != null);
}

test "passthrough JS unchanged" {
    const alloc = std.testing.allocator;
    const src = "const x = 1 + 2;";
    var result = try transform(alloc, .{ .source = src, .filename = "test.js" });
    defer result.deinit();
    try std.testing.expect(result.code != null);
    try std.testing.expectEqualStrings(src, result.code.?);
}
