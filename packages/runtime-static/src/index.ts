import type { BasePlugin, Context } from '@pluxel/core'

export type StaticPluginCtor = abstract new (...args: any[]) => BasePlugin

export type StaticRuntimePluginDeclaration = {
	name: string
	ctor: StaticPluginCtor
}

export type StaticRuntimeDriftPolicy = 'fail' | 'restart-required'

export type StaticRuntimeDefinition = {
	name: string
	plugins: readonly StaticRuntimePluginDeclaration[]
	enabled?: readonly string[]
	drift?: {
		policy?: StaticRuntimeDriftPolicy
	}
}

export type StaticRuntimeHost = {
	ctx: Context
	definition: StaticRuntimeDefinition
	start(): Promise<void>
}

export function defineStaticRuntime(definition: StaticRuntimeDefinition): StaticRuntimeDefinition {
	return definition
}

export async function createStaticRuntimeHost(_definition: StaticRuntimeDefinition): Promise<StaticRuntimeHost> {
	throw new Error(
		'@pluxel/runtime-static is a route skeleton. Static runtime startup is not implemented yet.',
	)
}
