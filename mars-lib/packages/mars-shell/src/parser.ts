export interface ParsedCommandLine {
  commands: ParsedCommand[]
}

export interface ParsedCommand {
  argv: string[]
}

export function parseCommandLine(input: string): ParsedCommandLine {
  const commands: ParsedCommand[] = []
  let currentToken = ""
  let currentArgv: string[] = []
  let quote: '"' | "'" | null = null

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const nextChar = input[index + 1]

    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        currentToken += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (char === " " || char === "\t" || char === "\n") {
      pushToken()
      continue
    }

    if (char === "&" && nextChar === "&") {
      pushToken()
      pushCommand()
      index += 1
      continue
    }

    currentToken += char
  }

  pushToken()
  pushCommand()

  return { commands }

  function pushToken(): void {
    if (!currentToken) return

    currentArgv.push(currentToken)
    currentToken = ""
  }

  function pushCommand(): void {
    if (!currentArgv.length) return

    commands.push({ argv: currentArgv })
    currentArgv = []
  }
}