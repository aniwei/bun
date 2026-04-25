export type InitializerTask<TContext> = {
  id: string
  order?: number
  shouldRun?: (context: TContext) => boolean
  run: (context: TContext) => void | Promise<void>
}

function sortByOrder<TContext>(tasks: InitializerTask<TContext>[]): InitializerTask<TContext>[] {
  return [...tasks].sort((a, b) => {
    const left = a.order ?? 0
    const right = b.order ?? 0
    if (left !== right) {
      return left - right
    }

    return a.id.localeCompare(b.id)
  })
}

export class InitializerPipeline<TContext> {
  private readonly tasks = new Map<string, InitializerTask<TContext>>()

  register(task: InitializerTask<TContext>): () => void {
    this.tasks.set(task.id, task)

    return () => {
      this.tasks.delete(task.id)
    }
  }

  async run(context: TContext, selected?: 'all' | string[]): Promise<void> {
    const runAll = selected === 'all'
    const selectedSet = Array.isArray(selected) ? new Set(selected) : null

    for (const task of sortByOrder(Array.from(this.tasks.values()))) {
      const explicitlySelected = runAll || selectedSet?.has(task.id) === true

      if (selectedSet && !explicitlySelected) {
        continue
      }

      if (!explicitlySelected && task.shouldRun && !task.shouldRun(context)) {
        continue
      }

      await task.run(context)
    }
  }
}
