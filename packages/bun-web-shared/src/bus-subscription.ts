import { Subscription } from './subscription'
import type { Events } from './event-emitter'

export class BusSubscription<T extends Events = Events> extends Subscription<T> {}