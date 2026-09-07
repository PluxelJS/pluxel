import { definePluginFork } from '@pluxel/core/test'
import type { BasePlugin, PluginNodeAddress, PluginDefinitionAddress } from '@pluxel/core'
import type { DevConsole, DevRunContext, DevScript, OpenedWorkbenchDevEntry } from './dev'
import type { RpcStub, RpcTarget } from './capnweb'
import type { RuntimeTestHost } from './test'
import type {
	WorkbenchView,
	WorkbenchAttachmentPlacement,
	WorkbenchPrincipal,
} from './workbench/definition'

type Equal<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false
type Assert<Value extends true> = Value

declare class Counter extends BasePlugin {
	add(value: number): number
}
declare const dev: DevConsole
declare const address: PluginNodeAddress
declare const run: DevRunContext
declare const test: RuntimeTestHost
declare abstract class AbstractCounter extends BasePlugin {
	abstract add(value: number): number
}
declare const requirementAddress: PluginDefinitionAddress

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
// @ts-expect-error The console does not expose raw host authority.
dev.ctx

const testFork = definePluginFork(Counter, 'east')
const sharedForkInstance = dev.plugins.require(testFork)
type SharedFork = Assert<Equal<typeof sharedForkInstance, Counter>>
void (null as unknown as SharedFork)
void dev.dependencies.inspect(Counter)
void dev.dependencies.setDefault({ requirement: AbstractCounter, provider: Counter })
void dev.dependencies.clearDefault(requirementAddress)
void dev.dependencies.setOverride({
	consumer: Counter,
	requirement: AbstractCounter,
	provider: testFork,
})
void dev.dependencies.clearOverride({ consumer: testFork, requirement: Counter })
// @ts-expect-error Global provider defaults only accept concrete default nodes.
void dev.dependencies.setDefault({ requirement: AbstractCounter, provider: testFork })
// @ts-expect-error Abstract contracts are not concrete provider implementations.
void dev.dependencies.setDefault({ requirement: AbstractCounter, provider: AbstractCounter })

void dev.plugins.status(address)
void dev.plugins.start(address)
void dev.config.get(address)
void dev.config.describe(Counter)

// Identical semantics remain structurally shareable with the test driver.
type CounterPatch = (
	target: typeof Counter,
	patch: Readonly<Record<string, unknown>>,
) => ReturnType<DevConsole['config']['patch']>
const patchFromTest: CounterPatch = test.config.patch
const patchFromDev: CounterPatch = dev.config.patch
const executeFromTest: DevConsole['commands']['execute'] = test.commands.execute
void patchFromTest
void patchFromDev
void executeFromTest

interface ProviderApi extends RpcTarget {
	add(value: number): number
}
interface ConsumerApi extends RpcTarget {
	select(id: string): boolean
}
declare const principal: WorkbenchPrincipal
declare const view: WorkbenchView<ProviderApi>
declare const attachment: WorkbenchAttachmentPlacement<ProviderApi, ConsumerApi>
const opened = dev.workbench.open({ target: Counter, entry: view, principal })
const attached = dev.workbench.open({ target: address, entry: attachment, principal })
type Opened = Assert<Equal<Awaited<typeof opened>, OpenedWorkbenchDevEntry<typeof view>>>
type Api = Assert<Equal<Awaited<typeof opened>['api'], RpcStub<ProviderApi>>>
type Consumer = Assert<Equal<Awaited<typeof attached>['consumer'], RpcStub<ConsumerApi>>>
// @ts-expect-error Principal is explicit even for local development access.
dev.workbench.open({ target: Counter, entry: view })

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
void (null as unknown as Opened)
void (null as unknown as Api)
void (null as unknown as Consumer)
