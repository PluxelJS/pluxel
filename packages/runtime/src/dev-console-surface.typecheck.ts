import { definePluginFork } from '@pluxel/core/test'
import type { BasePlugin, PluginNodeAddress } from '@pluxel/core'
import type { DevConsole, DevRunContext, DevScript } from '@pluxel/host-dev/console'

type Equal<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false
type Assert<Value extends true> = Value

declare class Counter extends BasePlugin {
	add(value: number): number
}
declare const dev: DevConsole
declare const address: PluginNodeAddress
declare const run: DevRunContext
const instance = dev.plugins.require(Counter)
const fork = dev.plugins.require({ plugin: Counter, forkId: 'east' })
type Instance = Assert<Equal<typeof instance, Counter>>
type Fork = Assert<Equal<typeof fork, Counter>>
type Input = Assert<Equal<typeof run.input, unknown>>
type Signal = Assert<Equal<typeof run.signal, AbortSignal>>

// @ts-expect-error Discovery addresses have no instance type or exact constructor identity.
dev.plugins.require(address)
// @ts-expect-error Input must be narrowed or validated before property access.
run.input.count
// @ts-expect-error A live console does not own root teardown.
dev.dispose()
// @ts-expect-error Console start cannot silently register imported fixture definitions.
dev.plugins.start(Counter, { catalog: [Counter] })
// @ts-expect-error Runtime configuration is modified through production config operations.
dev.config.seed(Counter, {})

const testFork = definePluginFork(Counter, 'east')
const sharedForkInstance = dev.plugins.require(testFork)
type SharedFork = Assert<Equal<typeof sharedForkInstance, Counter>>
void (null as unknown as SharedFork)
void dev.plugins.status(address)
void dev.plugins.start(address)
void dev.config.get(address)
void dev.ctx.logger
// @ts-expect-error Service access uses explicitly imported capability tokens.
void dev.http
// @ts-expect-error Service access uses explicitly imported capability tokens.
void dev.commands

const script: DevScript = (console, context) => {
	const input: unknown = context.input
	void input
	return console.plugins.list()
}
void script
void (null as unknown as Instance)
void (null as unknown as Fork)
void (null as unknown as Input)
void (null as unknown as Signal)
