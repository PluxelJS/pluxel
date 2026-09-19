import type { PluginForkRef } from '@pluxel/core/test'
import type { BasePlugin } from '@pluxel/core'
import type { ServiceTestHost } from './test'
import { createServiceTestHost } from './test'

type Equal<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false
type Assert<Value extends true> = Value

declare class FirstPlugin extends BasePlugin {
	readonly first: true
}
declare class SecondPlugin extends BasePlugin {
	readonly second: true
}
declare const host: ServiceTestHost
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
	// @ts-expect-error A fork cannot be a Host-wide provider default.
	change.dependencies.setDefault({ requirement: FirstPlugin, provider: fork })
})

const { fetch } = host.http
const { execute } = host.commands
const { patch } = host.config
void fetch(new URL('/probe', host.http.origin))
void execute('probe', {})
void patch(FirstPlugin, {})

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
// @ts-expect-error Workbench testing belongs to @pluxel/workbench/test.
host.workbench
// @ts-expect-error Service installation uses an explicit list, not a second product configuration.
await createServiceTestHost({ vault: {} })

void (null as unknown as Single)
void (null as unknown as Batch)
