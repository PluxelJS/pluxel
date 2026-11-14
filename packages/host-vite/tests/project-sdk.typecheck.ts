import type { BasePlugin, PluginNodeAddress } from '@pluxel/core'
import { Result } from '@pluxel/core/better-result'
import type { ProjectSdk, ProjectScript } from '@pluxel/host-vite/project'
import type {
	PluginDescriptor,
	Script,
	ScriptContext,
	ScriptInstanceError,
} from '@pluxel/host/agent'

declare class Counter extends BasePlugin {
	private readonly config: { count: number }
	add(value: number): number
	self(): this
}
declare const sdk: ProjectSdk
declare const run: ScriptContext
declare const address: PluginNodeAddress
declare const descriptor: PluginDescriptor<{ count?: number }, { count: number }, Counter>
const select = sdk.plugin
const counter = select(Counter)
const { start, status, fork: selectFork } = counter
const { get, patch } = select(descriptor).config
void start()
void status()
void selectFork('east').start()
void get()
void patch({ set: { count: 1 } })
// @ts-expect-error A descriptor retains its actual configuration input.
void patch({ set: { count: 'one' } })
// @ts-expect-error Constructors do not encode schema input/output associations.
void counter.config
void sdk.plugin(address).config.get()
// @ts-expect-error An address alone carries no concrete instance type.
void sdk.plugin(address).instance()
void sdk.dev.ctx.logger
// @ts-expect-error Fork selection uses the reference's fork method.
sdk.plugin({ plugin: Counter, forkId: 'east' })
// @ts-expect-error Inputs must be validated by the task.
run.input.count
// @ts-expect-error A borrowed SDK cannot close the Host.
sdk.dispose()
const project = (async (sdk, run) => {
	run.signal.throwIfAborted()
	const { instance, fork: selectFork } = sdk.plugin(Counter)
	const borrowed = await instance()
	if (borrowed.isErr()) return borrowed
	const current: Counter = borrowed.value
	const selected = await selectFork('east').instance()
	if (selected.isErr()) return selected
	const fork: Counter = selected.value
	const self: Counter = current.self()
	void fork
	return Result.ok(self.add(1))
}) satisfies ProjectScript
const result: Promise<Result<number, ScriptInstanceError>> = project(sdk, run)
void result
const portable = ((sdk) => {
	// @ts-expect-error Native object access belongs to project scripts.
	void sdk.dev
	// @ts-expect-error Constructors are only available in the Vite project extension.
	sdk.plugin(Counter)
	return sdk.plugins.list()
}) satisfies Script
void portable
