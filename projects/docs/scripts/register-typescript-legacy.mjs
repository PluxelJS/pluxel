import { registerHooks } from 'node:module'

// Twoslash and its VFS still load the classic Compiler API by the package name.
// Redirect only imports originating in those packages; every other docs dependency uses TS 7.
const legacyTypeScriptConsumers = ['/node_modules/twoslash/', '/node_modules/@typescript/vfs/']

registerHooks({
	resolve(specifier, context, nextResolve) {
		const useLegacyTypeScript =
			specifier === 'typescript' &&
			legacyTypeScriptConsumers.some((consumer) => context.parentURL?.includes(consumer))

		return nextResolve(useLegacyTypeScript ? 'typescript-legacy' : specifier, context)
	},
})
