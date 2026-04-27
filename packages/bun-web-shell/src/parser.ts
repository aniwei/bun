export interface ParsedCommand {
  command: string
  args: string[]
  redirectIn?: string
  redirectOut?: string
  appendOut?: string
}

export interface ParsedPipeline {
  commands: ParsedCommand[]
}

function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (char === '|' || char === '<') {
      if (current) {
        tokens.push(current)
        current = ''
      }
      tokens.push(char)
      continue
    }

    if (char === '>') {
      if (current) {
        tokens.push(current)
        current = ''
      }
      if (input[i + 1] === '>') {
        tokens.push('>>')
        i += 1
      } else {
        tokens.push('>')
      }
      continue
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}

function finalizeSegment(tokens: string[]): ParsedCommand {
  const args: string[] = []
  let redirectIn: string | undefined
  let redirectOut: string | undefined
  let appendOut: string | undefined

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '<') {
      redirectIn = tokens[i + 1]
      i += 1
      continue
    }
    if (token === '>') {
      redirectOut = tokens[i + 1]
      i += 1
      continue
    }
    if (token === '>>') {
      appendOut = tokens[i + 1]
      i += 1
      continue
    }
    args.push(token)
  }

  if (args.length === 0) {
    throw new Error('Empty command segment')
  }

  return {
    command: args[0],
    args: args.slice(1),
    redirectIn,
    redirectOut,
    appendOut,
  }
}

export function parseShellPipeline(input: string): ParsedPipeline {
  const tokens = tokenize(input.trim())
  if (tokens.length === 0) {
    throw new Error('Empty command line')
  }

  const commands: ParsedCommand[] = []
  let segment: string[] = []

  for (const token of tokens) {
    if (token === '|') {
      commands.push(finalizeSegment(segment))
      segment = []
      continue
    }
    segment.push(token)
  }

  commands.push(finalizeSegment(segment))

  return { commands }
}
