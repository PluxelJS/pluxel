import type { BasePlugin } from '@pluxel/core'
import type { RpcStub, RpcTarget } from 'capnweb'
import type { WorkbenchTestHost } from './test'
import type { OpenedLocalWorkbenchEntry } from '@pluxel/workbench/test'
import { createLocalRpcClient } from '@pluxel/workbench/test'
import type { RuntimeClientBootstrap } from './management/web/session/index'
import type { WorkbenchSessionApi } from '@pluxel/workbench/client'
import type {
	WorkbenchAttachmentPlacement,
	WorkbenchPrincipal,
	WorkbenchView,
} from '@pluxel/workbench'

type Equal<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false
type Assert<Value extends true> = Value
declare class FirstPlugin extends BasePlugin {}
declare const host: WorkbenchTestHost
declare const unbound: Extract<RuntimeClientBootstrap, { kind: 'workbench' }>
// @ts-expect-error Management alone does not promise Workbench methods.
unbound.workbench.layout({})
declare const bound: Extract<RuntimeClientBootstrap<WorkbenchSessionApi>, { kind: 'workbench' }>
type BoundWorkbench = Assert<Equal<typeof bound.workbench, RpcStub<WorkbenchSessionApi>>>
void (null as unknown as BoundWorkbench)
// @ts-expect-error The Workbench registry is framework authority, not author test API.
host.workbench.registry
// @ts-expect-error Public Workbench tests never expose the Host root Context.
host.ctx

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

type ViewLease = Assert<Equal<Awaited<typeof viewLease>, OpenedLocalWorkbenchEntry<typeof view>>>
type ViewApi = Assert<Equal<Awaited<typeof viewLease>['api'], RpcStub<ProviderApi>>>
type ProviderOnlyApi = Assert<
	Equal<Awaited<typeof providerOnlyLease>['provider'], RpcStub<ProviderApi>>
>
type ProviderOnlyConsumer = Assert<Equal<Awaited<typeof providerOnlyLease>['consumer'], undefined>>
type ConsumerApiLease = Assert<
	Equal<Awaited<typeof providerAndConsumerLease>['consumer'], RpcStub<ConsumerApi>>
>

void (null as unknown as ViewLease)
void (null as unknown as ViewApi)
void (null as unknown as ProviderOnlyApi)
void (null as unknown as ProviderOnlyConsumer)
void (null as unknown as ConsumerApiLease)
void (null as unknown as LocalClient)
