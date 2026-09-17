/** Server authoring surfaces that installed Plugin modules borrow from a bundled Runtime. */
export const PRODUCTION_FRAMEWORK_SPECIFIERS = Object.freeze([
	'@pluxel/core',
	'@pluxel/core/host',
	'@pluxel/core/toolchain',
	'@pluxel/core/federation',
	'@pluxel/core/logger',
	'@pluxel/core/services',
	'@pluxel/runtime',
	'@pluxel/runtime/toolchain',
	'@pluxel/runtime/capnweb',
	'@pluxel/services/database',
	'@pluxel/services/database/pglite',
	'@pluxel/services/database/postgres',
	'@pluxel/runtime/environment',
	'@pluxel/logging',
	'@pluxel/runtime/product',
	'@pluxel/services/http',
	'@pluxel/services/node',
	'@pluxel/services/workers',
	'@pluxel/services/commands',
	'@pluxel/services/persistence',
	'@pluxel/services/vault',
	'@pluxel/workbench',
	'@pluxel/workbench/service',
	'@pluxel/workbench/federation',
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
