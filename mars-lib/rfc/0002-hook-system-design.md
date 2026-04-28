# RFC 0002: Mars Hook System Design

**Status**: Implemented  
**Date**: 2026-04-28  
**Context**: Enable plugin-based runtime customization without modifying core code

## Overview

The Mars runtime uses a hook system based on **lifecycle events** and **interception points**. Hooks enable plugins and extensions to observe or modify runtime behavior without changing core code.

## When to Add New Hooks

When implementing a new feature in Mars, evaluate whether a hook is needed using this checklist:

### 1. **Does the feature have observable lifecycle events?**
- ✅ YES → Add observer hooks for: `<feature>.start`, `<feature>.end`, `<feature>.error`
- ❌ NO → Skip lifecycle hooks

Example: `script.run.start` / `script.run.end` / `script.run.error`

### 2. **Does the feature need parameter/state modification?**
- ✅ YES → Add interceptor hook: `<feature>.start` (before execution)
- ❌ NO → Skip interceptor hook

Interceptor inputs/outputs allow plugins to modify behavior:
- `vfs.file.created`: intercept and modify VFS file creation
- `script.run.start`: intercept and modify script parameters
- `process.created`: intercept and modify process startup args
- `shell.command.run`: intercept and modify shell commands
- `install.start`: intercept and modify installation parameters
- `globals.install`: intercept and modify global context installation

### 3. **Is this a critical initialization/teardown point?**
- ✅ YES → Add lifecycle hooks: `<component>.start` / `<component>.end`
- ❌ NO → Consider observer-only pattern

Examples:
- `runtime.boot.start` / `runtime.boot.end`
- `runtime.dispose.start` / `runtime.dispose.end`
- `features.load.start` / `features.load.end`

### 4. **Is this a data synchronization point?**
- ✅ YES → Add observer hook: `<data>.synced`
- ❌ NO → Skip synchronization hooks

Example: `vfs.synced` (after VFS snapshot/restore operations)

## Current Hook Timings (41 total)

### Runtime Lifecycle (4)
```
runtime.boot.start       → Emitted at boot() start
runtime.boot.end         → Emitted at boot() end
runtime.dispose.start    → Emitted at dispose() start
runtime.dispose.end      → Emitted at dispose() end
```

### Global Context Installation (2)
```
globals.install          → INTERCEPTOR: Modify global context params before install
globals.installed        → OBSERVER: Notified after globals installed
```

### Feature Loading (2)
```
features.load.start      → Emitted before feature preload hooks run
features.load.end        → Emitted after all feature hooks complete
```

### VFS Events (8)
```
vfs.file.created         → INTERCEPTOR: File creation (can modify)
vfs.file.changed         → INTERCEPTOR: File modification (can modify)
vfs.file.deleted         → OBSERVER: File deletion
vfs.synced               → OBSERVER: After sync operations
vfs.restore.start        → Emitted before VFS restore
vfs.restore.end          → Emitted after VFS restore
vfs.snapshot.start       → Emitted before VFS snapshot
vfs.snapshot.end         → Emitted after VFS snapshot
```

### Script Execution (3)
```
script.run.start         → INTERCEPTOR: Modify script params before execution
script.run.end           → OBSERVER: After script completes
script.run.error         → OBSERVER: On script error
```

### Process Management (4)
```
process.created          → INTERCEPTOR: Intercept process creation
process.spawned          → OBSERVER: Process spawned
process.exited           → OBSERVER: Process exited
process.error            → OBSERVER: Process error
```

### Shell Operations (3)
```
shell.command.run        → INTERCEPTOR: Modify command before execution
shell.command.end        → OBSERVER: After command completes
shell.command.error      → OBSERVER: On command error
```

### Package Management (3)
```
install.start            → INTERCEPTOR: Modify install params
install.end              → OBSERVER: After install completes
install.error            → OBSERVER: On install error
```

### Service Worker (3)
```
sw.registered            → OBSERVER: SW registered
sw.unregistered          → OBSERVER: SW unregistered
sw.error                 → OBSERVER: SW error
```

## Hook Types

### Interceptor Hooks
Allow plugins to intercept and **modify** execution:

```typescript
hooks.on("globals.install", "my-hook", (context, output) => {
  // context = input context object
  // output = same object, can be modified
  context.runtimeFeatures.sql = false  // modify!
})
```

**Available Interceptor Timings:**
- `globals.install` - modify global context params
- `vfs.file.created` - modify VFS file creation
- `vfs.file.changed` - modify VFS file update
- `script.run.start` - modify script execution params
- `process.created` - modify process creation
- `shell.command.run` - modify shell commands
- `install.start` - modify installation params

### Observer Hooks
Allow plugins to **observe** events without modification:

```typescript
hooks.on("globals.installed", "my-hook", (data) => {
  // Just observe, no modification possible
  console.log("Globals installed!")
})
```

**Available Observer Timings:**
- All `.end` events (runtime.boot.end, script.run.end, etc.)
- All `.error` events
- All `.start` events for observers (runtime.boot.start, features.load.start, etc.)
- Data sync events (vfs.synced, etc.)

## Hook Registration API

### Using `HookRegistry`

```typescript
const hooks = new HookRegistry()

// Register observer hook
hooks.on("runtime.boot.end", "my-plugin", async () => {
  console.log("Boot completed")
}, 50)  // priority (lower = earlier)

// Register multiple hooks
hooks.registerAll([
  defineHook({
    name: "my-interceptor",
    timing: "globals.install",
    kind: "interceptor",
    handle: (input, output) => {
      output.runtimeFeatures.sql = false
    },
    priority: 10
  }),
  defineHook({
    name: "my-observer",
    timing: "globals.installed",
    kind: "observer",
    handle: () => {
      console.log("Installed")
    }
  })
])

// Enable/disable at runtime
hooks.disable("my-plugin")
hooks.enable("my-plugin")

// Inspect registered hooks
console.log(hooks.getRegistered())  // all hooks
console.log(hooks.getRegistered("globals.install"))  // specific timing
```

### Passing Hooks to Runtime

```typescript
const hooks = new HookRegistry()
hooks.on("runtime.boot.end", "my-hook", () => {
  console.log("Boot complete")
})

const runtime = await createMarsRuntime({
  hooks,  // inject custom hooks
  hookPreset: "default"  // or "strict", "minimal", "none"
})
```

## Hook Execution Model

### Priority Order
Hooks execute in priority order (lower number = higher priority):

```typescript
// Priority 10 runs before Priority 50
hooks.on("globals.install", "hook1", handler, 10)
hooks.on("globals.install", "hook2", handler, 50)
// hook1 executes first, then hook2
```

### Error Handling
Hook failures are **isolated** - they do not break runtime flow:

```typescript
hooks.on("globals.install", "bad-hook", () => {
  throw new Error("Oops!")
})
// Exception is caught internally, other hooks continue
```

### Execution Flow

```
boot() {
  emit("runtime.boot.start", {})
  
  await kernel.boot()
  
  emit("features.load.start", {})
  
  // Interceptor: plugins can modify globalInstallContext
  execute("globals.install", context, context)
  
  installBunGlobal(context)
  
  emit("globals.installed", {})
  emit("features.load.end", {})
  
  emit("runtime.boot.end", {})
}
```

## Design Patterns

### Pattern 1: Feature Enablement Based on Hooks
```typescript
hooks.on("features.load.start", "enable-sql", async () => {
  if (shouldLoadSQL()) {
    await preloadSQLiteWasm()
  }
}, 30)
```

### Pattern 2: Conditional Global Installation
```typescript
hooks.on("globals.install", "custom-globals", (context, output) => {
  if (context.runtimeFeatures.sql) {
    // Do nothing, SQL will be installed
  } else {
    // Disable SQL feature
    output.runtimeFeatures.sql = false
  }
})
```

### Pattern 3: Lifecycle Monitoring
```typescript
hooks.on("runtime.boot.start", "boot-monitor", async () => {
  console.log("Boot starting...")
})

hooks.on("runtime.boot.end", "boot-monitor", async () => {
  console.log("Boot complete!")
})
```

### Pattern 4: VFS Mutation Interception
```typescript
hooks.on("vfs.file.created", "vfs-guard", (context, file) => {
  // Prevent certain file paths
  if (file.path.includes("node_modules")) {
    return  // Skip interception
  }
  // Custom handling...
})
```

## Adding Hooks to New Features

### Checklist for Feature Implementation

1. **Identify lifecycle points** in your feature:
   - Initialization (start)
   - Completion (end)
   - Errors (error)

2. **Identify interception needs**:
   - What parameters might plugins want to modify?
   - What state might need customization?

3. **Add hook timings** to `packages/mars-client/src/hooks.ts`:
   ```typescript
   export const HOOK_TIMINGS = [
     // ... existing
     "myfeature.start",
     "myfeature.end",
     "myfeature.error",
   ] as const
   ```

4. **Mark interceptors** in `INTERCEPTOR_TIMINGS`:
   ```typescript
   export const INTERCEPTOR_TIMINGS = [
     // ... existing
     "myfeature.start",  // if allows modification
   ] as const
   ```

5. **Emit hooks** in feature code:
   ```typescript
   // Interceptor (before execution)
   const context = { /* params */ }
   await hooks.execute("myfeature.start", context, context)
   
   // Do work...
   
   // Observer (after execution)
   await hooks.emit("myfeature.end", {})
   ```

6. **Document** the hook in `rfc/0002-hook-system-design.md` with:
   - Hook timing name
   - When it fires
   - What can be intercepted
   - Example usage

## Future Extensions

Potential hook system enhancements:

- [ ] **Hook composition**: Combine hooks with middleware pattern
- [ ] **Typed hooks**: Per-timing specific input/output types
- [ ] **Hook presets**: "strict", "minimal" bundles for size optimization
- [ ] **Hook debugging**: Trace mode to log all hook executions
- [ ] **Hook filtering**: Namespace/wildcard hook registration
- [ ] **Async hook timeout**: Prevent hanging hooks
