import type { CommandsService } from './service'

/** Owner-bound access to the Host command catalog. */
export abstract class Commands {}
export interface Commands extends CommandsService {}
