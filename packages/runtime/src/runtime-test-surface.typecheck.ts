import type { BasePlugin } from '@pluxel/core'
import type { RpcStub, RpcTarget } from './capnweb'
import type { OpenedWorkbenchTestEntry, PluginForkRef, RuntimeTestHost } from './test'
import { createLocalRpcClient, createRuntimeTestHost } from './test'
import type {
	WorkbenchAttachmentPlacement,
	WorkbenchPrincipal,
	WorkbenchView,
} from './workbench/definition'

type Equal<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false
type Assert<Value extends true> = Value

// @ts-expect-error Static application catalog targets belong to @pluxel/runtime-static/test.
type RuntimeStaticPluginTestTarget = import('./test').RuntimeStaticPluginTestTarget

declare class FirstPlugin extends BasePlugin {
	readonly first: true
}
declare class SecondPlugin extends BasePlugin {
	readonly second: true
}
declare const host: RuntimeTestHost
declare const fork: PluginForkRef<typeof FirstPlugin>

const single = host.start(FirstPlugin)
type Single = Assert<Equal<Awaited<typeof single>, FirstPlugin>>

const batch = host.start([FirstPlugin, fork, SecondPlugin] as const)
type Batch = Assert<Equal<Awaited<typeof batch>, readonly [FirstPlugin, FirstPlugin, SecondPlugin]>>

// @ts-expect-error Batch config is heterogeneous and must use callback-scoped config.seed().
host.start([FirstPlugin, SecondPlugin] as const, { initialConfig: {} })

host.commit((change) => change.start(FirstPlugin))
host.commit((change) => {
	change.catalog.add([FirstPlugin, SecondPlugin])
})
// @ts-expect-error Public hosts require a synchronous callback-scoped draft.
host.commit()
// @ts-expect-error Commit callbacks are synchronous.
host.commit(async (change) => change.start(FirstPlugin))
// @ts-expect-error Commit callbacks must not return a value.
host.commit((_change) => FirstPlugin)
host.commit((change) => {
	// @ts-expect-error A fork cannot be a Runtime-wide provider default.
	change.dependencies.setDefault({ requirement: FirstPlugin, provider: fork })
})

const { fetch } = host.http
const { execute } = host.commands
const { patch } = host.config
void fetch(new URL('/probe', host.http.origin))
void execute('probe', {})
void patch(FirstPlugin, {})

// @ts-expect-error Public author hosts never expose the Runtime root Context.
host.ctx
// @ts-expect-error Internal services remain behind the framework-only harness.
host.coordinator
// @ts-expect-error Legacy staged config access is not part of Testing v2.
host.cfg()
// @ts-expect-error Forks are immutable values, not mutable host state.
host.fork()
// @ts-expect-error In-process HTTP is deliberately namespaced under host.http.
host.fetch(new URL('/probe', host.http.origin))
// @ts-expect-error Publication belongs to running Plugins, not a test-host driver.
host.commands.createMount()
// @ts-expect-error The Workbench registry is framework authority, not author test API.
host.workbench.registry
// @ts-expect-error Test host config cannot inject private ConfigService state.
createRuntimeTestHost({ configService: { mode: 'memory' } })

interface ProviderApi extends RpcTarget {
	read(): string
}
interface ConsumerApi extends RpcTarget {
	select(): void
}

declare const localTarget: ProviderApi
const localClient = createLocalRpcClient<ProviderApi>(localTarget)
type LocalClient = Assert<Equal<typeof localClient, RpcStub<ProviderApi>>>
// @ts-expect-error Local RPC requires a Cap'n Web RpcTarget contract.
createLocalRpcClient({})

declare const principal: WorkbenchPrincipal
declare const view: WorkbenchView<ProviderApi>
declare const providerOnly: WorkbenchAttachmentPlacement<ProviderApi, never>
declare const providerAndConsumer: WorkbenchAttachmentPlacement<ProviderApi, ConsumerApi>

const viewLease = host.workbench.open({ target: FirstPlugin, entry: view, principal })
const providerOnlyLease = host.workbench.open({
	target: FirstPlugin,
	entry: providerOnly,
	principal,
})
const providerAndConsumerLease = host.workbench.open({
	target: FirstPlugin,
	entry: providerAndConsumer,
	principal,
})

type ViewLease = Assert<Equal<Awaited<typeof viewLease>, OpenedWorkbenchTestEntry<typeof view>>>
type ViewApi = Assert<Equal<Awaited<typeof viewLease>['api'], RpcStub<ProviderApi>>>
type ProviderOnlyApi = Assert<
	Equal<Awaited<typeof providerOnlyLease>['provider'], RpcStub<ProviderApi>>
>
type ProviderOnlyConsumer = Assert<Equal<Awaited<typeof providerOnlyLease>['consumer'], undefined>>
type ConsumerApiLease = Assert<
	Equal<Awaited<typeof providerAndConsumerLease>['consumer'], RpcStub<ConsumerApi>>
>

void (null as unknown as Single)
void (null as unknown as Batch)
void (null as unknown as ViewLease)
void (null as unknown as ViewApi)
void (null as unknown as ProviderOnlyApi)
void (null as unknown as ProviderOnlyConsumer)
void (null as unknown as ConsumerApiLease)
void (null as unknown as LocalClient)
void (null as unknown as RuntimeStaticPluginTestTarget)
