/** Server authoring surfaces that installed Plugin modules borrow from a bundled Runtime. */
export const PRODUCTION_FRAMEWORK_SPECIFIERS = Object.freeze([
	'@pluxel/core',
	'@pluxel/core/toolchain',
	'@pluxel/core/federation',
	'@pluxel/core/logger',
	'@pluxel/core/services',
	'@pluxel/runtime',
	'@pluxel/runtime/toolchain',
	'@pluxel/runtime/capnweb',
	'@pluxel/runtime/database',
	'@pluxel/runtime/environment',
	'@pluxel/runtime/logger',
	'@pluxel/runtime/product',
	'@pluxel/runtime/services/vault',
	'@pluxel/runtime/workbench',
	'@pluxel/runtime/workbench/federation',
	'@pluxel/host',
	'@pluxel/host-dynamic',
	'@pluxel/host-dynamic/source-producer',
	'@pluxel/commands',
	'@pluxel/commands/typebox',
	'elysia',
])

export const PRODUCTION_FRAMEWORK_FACADE = 'pluxel:production-framework:'

export function frameworkFacadeFile(specifier: string): string {
	return `framework/${specifier.replace('@', '').replaceAll('/', '-')}.mjs`
}
