declare module '@mars/web-shared' {
  export type InitializerTask<TContext> = {
    id: string
    order?: number
    shouldRun?: (context: TContext) => boolean
    run: (context: TContext) => void | Promise<void>
  }

  export class InitializerPipeline<TContext> {
    register(task: InitializerTask<TContext>): () => void
    run(context: TContext, selected?: 'all' | string[]): Promise<void>
  }
}
