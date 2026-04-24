import { Subscription } from './subscrption'
import type { Events } from './event-emitter'

export class BusSubscription<T extends Events = Events> extends Subscription<T> {}