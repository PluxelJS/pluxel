import type { BasePlugin, PluginNodeAddress } from '@pluxel/core'
import type { TestHost } from './index'
import { createTestHost } from './index'

type Equal<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false
type Assert<Value extends true> = Value

declare class FirstPlugin extends BasePlugin {
	readonly first: true
}
declare class SecondPlugin extends BasePlugin {
	readonly second: true
}
declare const host: TestHost
const fork = FirstPlugin.nodeAddress('east')

const single = host.start(FirstPlugin.nodeAddress())
type Single = Assert<Equal<Awaited<typeof single>, FirstPlugin>>

const batch = host.start([FirstPlugin.nodeAddress(), fork, SecondPlugin.nodeAddress()] as const)
type Batch = Assert<Equal<Awaited<typeof batch>, readonly [FirstPlugin, FirstPlugin, SecondPlugin]>>

const choice = Math.random() > 0.5 ? FirstPlugin.nodeAddress() : SecondPlugin.nodeAddress()
const chosen = host.start(choice)
type Chosen = Assert<Equal<Awaited<typeof chosen>, FirstPlugin | SecondPlugin>>
// @ts-expect-error Node selection has one address form; constructors belong to catalog assembly.
host.start(FirstPlugin)
declare const plain: PluginNodeAddress
// @ts-expect-error Portable addresses do not identify a source implementation to install.
host.start(plain)
// @ts-expect-error A raw branch cannot supply source implementation evidence.
host.start(Math.random() > 0.5 ? plain : fork)
host.commit((change) => {
	// @ts-expect-error Fork policy requires a fork address, not a default node.
	change.forks.ensure(FirstPlugin.nodeAddress())
})

// @ts-expect-error Batch config is heterogeneous and must use callback-scoped config.seed().
host.start([FirstPlugin.nodeAddress(), SecondPlugin.nodeAddress()] as const, { initialConfig: {} })

host.commit((change) => change.start(FirstPlugin.nodeAddress()))
host.commit((change) => {
	change.catalog.add([FirstPlugin, SecondPlugin])
})
// @ts-expect-error Public hosts require a synchronous callback-scoped draft.
host.commit()
// @ts-expect-error Commit callbacks are synchronous.
host.commit(async (change) => change.start(FirstPlugin.nodeAddress()))
// @ts-expect-error Commit callbacks must not return a value.
host.commit((_change) => FirstPlugin)
host.commit((change) => {
	// @ts-expect-error A fork cannot be a Host-wide provider default.
	change.dependencies.setDefault({ requirement: FirstPlugin, provider: fork })
})

const { fetch } = host.http
const { execute } = host.commands
const { patch } = host.config
void fetch(new URL('/probe', host.http.origin))
void execute('probe', {})
void patch(FirstPlugin.nodeAddress(), {})

// @ts-expect-error Public author hosts never expose the Host root Context.
host.ctx
// @ts-expect-error Internal services remain behind the framework-only harness.
host.coordinator
// @ts-expect-error Raw staged config access belongs to the internal framework harness.
host.cfg()
// @ts-expect-error Forks are immutable values, not mutable host state.
host.fork()
// @ts-expect-error In-process HTTP is deliberately namespaced under host.http.
host.fetch(new URL('/probe', host.http.origin))
// @ts-expect-error Publication belongs to running Plugins, not a test-host driver.
host.commands.createMount()
// @ts-expect-error Workbench is absent unless explicitly enabled.
host.workbench
// @ts-expect-error Service installation uses an explicit list, not a second product configuration.
await createTestHost({ vault: {} })

void (null as unknown as Single)
void (null as unknown as Batch)
void (null as unknown as Chosen)

const withWorkbench = await createTestHost({ workbench: true })
withWorkbench.workbench.open
const withoutWorkbench = await createTestHost()
// @ts-expect-error No Workbench driver on a bare host.
withoutWorkbench.workbench.open
declare const enabled: boolean
const maybeWorkbench = await createTestHost({ workbench: enabled })
maybeWorkbench.workbench?.open
