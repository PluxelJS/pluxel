import { createChildContext, createContextView, createScopeContext } from '@pluxel/context/internal'
import type { Context, RootContext } from './Context'

/** @internal Create one isolated Plugin lifecycle scope. */
export function createGenerationContext(root: RootContext, name: string): Context {
	return createScopeContext(root, name) as Context
}

/** @internal Create one contained owner sharing its parent's Plugin lifecycle scope. */
export function createOwnerContext(parent: Context, name: string): Context {
	return createChildContext(parent, name) as Context
}

/** @internal Derive one dependency-edge owner view without creating a containment parent. */
export function createCallerContextView(provider: Context, caller: Context): Context {
	const ctx = createContextView(provider) as Context
	Object.defineProperty(ctx, 'caller', {
		value: caller,
		writable: false,
		enumerable: false,
		configurable: false,
	})
	return ctx
}
