import type { Context as PluxelContext } from '../context/Context'
import { pluginNodePhysicalKey } from '../internal/plugin-address'
import { basename, join } from 'pathe'
import { VaultError } from './error'
import type { VaultNamespaceOptions } from './types'

const ownerNamespaces = new WeakMap<PluxelContext, string>()

function normalizeSegment(input: string): string {
	const trimmed = input || 'default'
	return basename(trimmed).replaceAll(/[^A-Za-z0-9._-]/g, '_')
}

export function validateKey(key: string): void {
	if (
		typeof key !== 'string' ||
		key.length === 0 ||
		key.length > 512 ||
		[...key].some((character) => character.charCodeAt(0) < 32) ||
		['__proto__', 'prototype', 'constructor'].includes(key)
	)
		throw new VaultError('INVALID_CONFIG', 'Invalid Vault record key.')
}

export function namespaceFrom(ctx: PluxelContext, options?: VaultNamespaceOptions): string {
	const address = ctx.pluginInfo?.nodeAddress
	const name = options?.namespace
	if (name !== undefined) validateKey(name)
	if (!address) return name ?? 'default'
	let base = ownerNamespaces.get(ctx)
	if (base === undefined) {
		base = `plugin-${pluginNodePhysicalKey(address)}`
		ownerNamespaces.set(ctx, base)
	}
	return name === undefined ? base : `${base}~${encodeURIComponent(name)}`
}

export function blobPath(runtime: { blobsDir: string }, namespace: string, name: string): string {
	return join(runtime.blobsDir, namespace, `${normalizeSegment(name)}.blob`)
}
