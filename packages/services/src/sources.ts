import { elysiaSharedPackages } from './elysia/sources'

export { elysiaSharedPackages }

/** Packages whose official service tokens and constructors share the application's installation. */
export const serviceSharedPackages: readonly string[] = Object.freeze([
	...elysiaSharedPackages,
	'@pluxel/workbench',
	'@pluxel/commands',
	'@sinclair/typebox',
])
