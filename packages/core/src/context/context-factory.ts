import { createChildContext, createContextView, createScopeContext } from '@pluxel/context/internal'
import type { Context, RootContext } from './Context'
import { coreContextScope, initializeCoreContext } from './core-context'

/** @internal Create one isolated Plugin lifecycle scope. */
export function createGenerationContext(root: RootContext, name: string): Context {
	return initializeCoreContext(createScopeContext(root, name) as Context)
}

/** @internal Create one contained owner sharing its parent's Plugin lifecycle scope. */
export function createOwnerContext(
	parent: Context,
	name: string,
	createOwnerValues?: (ctx: Context) => Pick<Context, 'logger' | 'effects'>,
): Context {
	const ctx = createChildContext(parent, name) as Context
	return initializeCoreContext(ctx, coreContextScope(parent), parent, createOwnerValues?.(ctx))
}

/** @internal Derive one dependency-edge owner view without creating a containment parent. */
export function createCallerContextView(provider: Context, caller: Context): Context {
	const ctx = initializeCoreContext(
		createContextView(provider) as Context,
		coreContextScope(provider),
		provider,
	)
	Object.defineProperty(ctx, 'caller', {
		value: caller,
		writable: false,
		enumerable: false,
		configurable: false,
	})
	return ctx
}
