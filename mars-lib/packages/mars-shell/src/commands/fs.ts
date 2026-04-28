import { normalizePath } from "@mars/vfs"

import type { CommandContext, CommandResult, ShellCommand } from "../types"

export function createFSCommands(onCd: (path: string) => void): ShellCommand[] {
  return [
    {
      name: "pwd",
      run: context => ok(`${context.cwd}\n`),
    },
    {
      name: "cd",
      run: context => {
        const target = normalizePath(context.argv[1] ?? "/workspace", context.cwd)
        const stats = context.vfs.statSync(target)
        if (!stats.isDirectory()) return fail(`cd: not a directory: ${target}\n`)
        onCd(target)

        return ok("")
      },
    },
    {
      name: "ls",
      run: context => {
        const target = normalizePath(context.argv[1] ?? ".", context.cwd)
        const entries = context.vfs.readdirSync(target) as string[]

        return ok(entries.length ? `${entries.join("\n")}\n` : "")
      },
    },
    {
      name: "cat",
      run: context => {
        const paths = context.argv.slice(1)
        const output = paths
          .map(path => context.vfs.readFileSync(normalizePath(path, context.cwd), "utf8"))
          .join("")

        return ok(output)
      },
    },
    {
      name: "echo",
      run: context => ok(`${context.argv.slice(1).join(" ")}\n`),
    },
    {
      name: "mkdir",
      run: context => {
        const recursive = context.argv.includes("-p")
        const paths = context.argv.slice(1).filter(value => value !== "-p")

        for (const path of paths) {
          context.vfs.mkdirSync(normalizePath(path, context.cwd), { recursive })
        }

        return ok("")
      },
    },
    {
      name: "rm",
      run: context => {
        const paths = context.argv.slice(1).filter(value => value !== "-r" && value !== "-rf")

        for (const path of paths) {
          context.vfs.unlinkSync(normalizePath(path, context.cwd))
        }

        return ok("")
      },
    },
    {
      name: "grep",
      run: context => runGrep(context),
    },
  ]
}

function runGrep(context: CommandContext): CommandResult {
  const recursive = context.argv.includes("-R") || context.argv.includes("-r")
  const args = context.argv.slice(1).filter(value => value !== "-R" && value !== "-r")
  const pattern = args[0]
  const root = normalizePath(args[1] ?? ".", context.cwd)
  const matches: Array<{ file: string; line: number; text: string }> = []

  if (!pattern) return fail("grep: missing pattern\n")

  const files = recursive ? collectFiles(context, root) : [root]
  for (const file of files) {
    const text = context.vfs.readFileSync(file, "utf8") as string
    const lines = text.split("\n")

    for (const [index, line] of lines.entries()) {
      if (line.includes(pattern)) matches.push({ file, line: index + 1, text: line })
    }
  }

  return {
    code: matches.length ? 0 : 1,
    stdout: matches.map(match => `${match.file}:${match.line}:${match.text}`).join("\n") + (matches.length ? "\n" : ""),
    stderr: "",
    json: { matches },
  }
}

function collectFiles(context: CommandContext, root: string): string[] {
  const stats = context.vfs.statSync(root)
  if (stats.isFile()) return [root]

  const files: string[] = []
  for (const entry of context.vfs.readdirSync(root) as string[]) {
    files.push(...collectFiles(context, normalizePath(entry, root)))
  }

  return files
}

function ok(stdout: string, json?: unknown): CommandResult {
  return { code: 0, stdout, stderr: "", ...(json === undefined ? {} : { json }) }
}

function fail(stderr: string): CommandResult {
  return { code: 1, stdout: "", stderr }
}