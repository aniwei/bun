export type Events = {
	[event: string]: (...args: unknown[]) => void
}

export declare class TypedEventEmitter<T extends Events> {
	private readonly listenersMap: Partial<{ [K in keyof T]: Set<T[K]> }>

	on<K extends keyof T>(event: K, listener: T[K]): this
	addListener<K extends keyof T>(event: K, listener: T[K]): this
	off<K extends keyof T>(event: K, listener: T[K]): this
	removeListener<K extends keyof T>(event: K, listener: T[K]): this
	emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): boolean
	once<K extends keyof T>(event: K, listener: T[K]): this
	removeAllListeners<K extends keyof T>(event?: K): this
	listeners<K extends keyof T>(event: K): T[K][]
	listenerCount<K extends keyof T>(event: K): number
}