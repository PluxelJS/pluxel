import type { BasePlugin, PluginNodeAddress } from '@pluxel/core'
import type { ProjectSdk, ProjectScript } from '@pluxel/host-vite/project'
import type { Script, ScriptContext } from '@pluxel/host/agent'

declare class Counter extends BasePlugin {
	add(value: number): number
}
declare const sdk: ProjectSdk
declare const run: ScriptContext
declare const address: PluginNodeAddress
const instance: Counter = sdk.dev.instance(Counter)
const fork: Counter = sdk.dev.instance({ plugin: Counter, forkId: 'east' })
void instance
void fork
const select = sdk.plugin
const counter = select(sdk.dev.address(Counter))
const { start, status, fork: selectFork } = counter
const { get, patch } = counter.config
void start()
void status()
void selectFork('east').start()
void get()
void patch({ set: { count: 1 } })
void sdk.plugin(address).config.get()
void sdk.dev.ctx.logger
// @ts-expect-error Stable addresses carry no concrete instance type.
sdk.dev.instance(address)
// @ts-expect-error Portable operations use stable addresses.
sdk.plugin(Counter)
// @ts-expect-error Inputs must be validated by the task.
run.input.count
// @ts-expect-error A borrowed SDK cannot close the Host.
sdk.dispose()
const project = ((sdk, run) => {
	run.signal.throwIfAborted()
	return sdk.dev.instance(Counter).add(1)
}) satisfies ProjectScript
const result: number = project(sdk, run)
void result
const portable = ((sdk) => {
	// @ts-expect-error Native object access belongs to project scripts.
	void sdk.dev
	return sdk.plugins.list()
}) satisfies Script
void portable
