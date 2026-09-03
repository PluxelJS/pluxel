import type { BasePlugin } from '@pluxel/core'
import type { RpcStub, RpcTarget } from './capnweb'
import type {
	OpenedWorkbenchTestEntry,
	PluginForkRef,
	RuntimeTestHost,
} from './test'
import type {
	WorkbenchAttachmentPlacement,
	WorkbenchPrincipal,
	WorkbenchView,
} from './workbench/definition'

type Equal<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
		? true
		: false
type Assert<Value extends true> = Value

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
type Batch = Assert<
	Equal<Awaited<typeof batch>, readonly [FirstPlugin, FirstPlugin, SecondPlugin]>
>

// @ts-expect-error Batch config is heterogeneous and must use callback-scoped config.seed().
host.start([FirstPlugin, SecondPlugin] as const, { initialConfig: {} })

host.commit((change) => change.start(FirstPlugin))
host.commit((change) => {
	change.catalog.add([FirstPlugin, SecondPlugin])
})
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

interface ProviderApi extends RpcTarget {
	read(): string
}
interface ConsumerApi extends RpcTarget {
	select(): void
}
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

type ViewLease = Assert<
	Equal<Awaited<typeof viewLease>, OpenedWorkbenchTestEntry<typeof view>>
>
type ViewApi = Assert<Equal<Awaited<typeof viewLease>['api'], RpcStub<ProviderApi>>>
type ProviderOnlyApi = Assert<
	Equal<Awaited<typeof providerOnlyLease>['provider'], RpcStub<ProviderApi>>
>
type ProviderOnlyConsumer = Assert<
	Equal<Awaited<typeof providerOnlyLease>['consumer'], undefined>
>
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
