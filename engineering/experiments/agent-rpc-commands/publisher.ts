import { read, write } from './provider/commands.js'

declare const rpc: {
	publish(input: { id: string; commands: Record<string, unknown> }): unknown
}

rpc.publish({ id: 'records', commands: { write, read } })
