import { defineStaticRuntime } from './application.ts'
import type { StaticRuntimeApplication, StaticRuntimeStartupContext } from './types.ts'

defineStaticRuntime({
	name: 'exact-host-options',
	plugins: [],
	configure: () => ({
		management: true,
		workbench: { enabled: true, uiBasePath: '/admin' },
	}),
})

defineStaticRuntime({
	name: 'unknown-workbench-access',
	plugins: [],
	// @ts-expect-error configure() rejects the removed Workbench access option.
	configure: () => ({ workbench: { enabled: true, access: { exposure: 'private' } } }),
})

defineStaticRuntime({
	name: 'unknown-workbench-plugin-groups',
	plugins: [],
	// @ts-expect-error configure() rejects the removed Workbench pluginGroups option.
	configure: () => ({ workbench: { enabled: true, pluginGroups: [] } }),
})

defineStaticRuntime({
	name: 'unknown-host-option',
	plugins: [],
	// @ts-expect-error configure() rejects unknown top-level host options.
	configure: async () => ({ workbench: false, unknownHostOption: true }),
})

const applicationWithBindings = defineStaticRuntime({
	name: 'typed-bindings',
	plugins: [],
	configure({ bindings }: StaticRuntimeStartupContext<{ serviceUrl: string }>) {
		return { profile: bindings.serviceUrl }
	},
})

const typedApplication: StaticRuntimeApplication<readonly [], { serviceUrl: string }> =
	applicationWithBindings
void typedApplication
