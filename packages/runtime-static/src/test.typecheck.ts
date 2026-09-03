import { BasePlugin, Plugin } from '@pluxel/runtime'
import { definePluginFork } from '@pluxel/core/test'
import { defineStaticRuntime } from './application.ts'
import { startStaticApplicationTestHost, type StaticApplicationTestHost } from './test.ts'
import type { StaticRuntimeStartupContext } from './types.ts'

@Plugin()
class IncludedPlugin extends BasePlugin {
	readonly value = 'included'
}

@Plugin()
class OtherPlugin extends BasePlugin {}

const application = defineStaticRuntime({
	name: 'static-test-type-probe',
	plugins: [IncludedPlugin] as const,
})

const optionalOptions = startStaticApplicationTestHost(application)
void optionalOptions

declare const host: StaticApplicationTestHost<typeof application.plugins>
const included: IncludedPlugin = host.require(IncludedPlugin)
const forked: IncludedPlugin = host.require(definePluginFork(IncludedPlugin, 'east'))
const running: boolean = host.isRunning(IncludedPlugin)
const reportRuntime: string = host.startupReport.runtime
const logicalOrigin: string = host.http.origin
void [included, forked, running, reportRuntime, logicalOrigin]

// @ts-expect-error Raw Core commit facts are internal to the static Runtime adapter.
host.startupReport.commit
// @ts-expect-error Static application queries are limited to the fixed catalog tuple.
host.require(OtherPlugin)
// @ts-expect-error A ready static application test host has no fixture lifecycle mutation.
host.start(IncludedPlugin)
// @ts-expect-error Root Context is framework authority, not an application-test surface.
host.ctx
// @ts-expect-error In-process HTTP is namespaced under the shared Runtime driver.
host.fetch

const applicationWithBindings = defineStaticRuntime<
	readonly [typeof IncludedPlugin],
	{ serviceUrl: string }
>({
	name: 'static-test-required-bindings',
	plugins: [IncludedPlugin],
	configure({ bindings }: StaticRuntimeStartupContext<{ serviceUrl: string }>) {
		void bindings.serviceUrl
		return {}
	},
})

// @ts-expect-error Required application bindings make the complete options argument mandatory.
startStaticApplicationTestHost(applicationWithBindings)
// @ts-expect-error Required application bindings cannot be omitted from an options object.
startStaticApplicationTestHost(applicationWithBindings, {})
startStaticApplicationTestHost(applicationWithBindings, {
	bindings: { serviceUrl: 'https://service.test' },
})
