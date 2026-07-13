import type { Context } from '@pluxel/core'

import {
	parsePluginLogPolicySnapshot,
	runtimePluginLogPolicy,
	serializePluginLogPolicySnapshot,
} from './policy'

type PersistenceNamespace = {
	getText(key: string): Promise<string | undefined>
	put(key: string, value: string, options?: { atomic?: boolean }): Promise<void>
}

type PersistenceLike = {
	namespace(name: string): PersistenceNamespace
}

const loadByRoot = new WeakMap<object, Promise<void>>()
const writeByRoot = new WeakMap<object, Promise<void>>()

function rootContext(ctx: Context): Context {
	return ctx.root ?? ctx
}

function profileName(ctx: Context): string {
	const raw = String(ctx.config.profile ?? 'default').trim()
	return raw.replaceAll(/[^A-Za-z0-9_.-]/g, '_') || 'default'
}

function policyKey(ctx: Context): string {
	return `plugin-policy/${profileName(ctx)}.json`
}

function persistence(ctx: Context): PersistenceLike | undefined {
	const value = (rootContext(ctx) as unknown as { persistence?: unknown }).persistence
	if (!value || typeof value !== 'object') return undefined
	if (typeof (value as PersistenceLike).namespace !== 'function') return undefined
	return value as PersistenceLike
}

function logPolicyPersistenceFailure(
	ctx: Context,
	action: 'load' | 'persist',
	error: unknown,
): void {
	const logger = (rootContext(ctx) as unknown as { logger?: unknown }).logger
	if (!logger || typeof logger !== 'object') return
	const warn = (logger as { warn?: unknown }).warn
	if (typeof warn !== 'function') return
	warn.call(logger, `Failed to ${action} persisted plugin log policy`, { error })
}

export async function ensureRuntimePluginPolicyLoaded(ctx: Context): Promise<void> {
	const root = rootContext(ctx) as object

	const existing = loadByRoot.get(root)
	if (existing) return await existing

	const task = (async () => {
		const configService = ctx.configService
		if (configService) await configService.ready
		const store = persistence(ctx)
		if (!store) return
		const raw = await store.namespace('logger').getText(policyKey(ctx))
		if (raw === undefined) return
		const snapshot = parsePluginLogPolicySnapshot(raw)
		if (snapshot) runtimePluginLogPolicy.replace(snapshot)
	})().catch((error) => {
		loadByRoot.delete(root)
		throw error
	})

	loadByRoot.set(root, task)
	return await task
}

export function persistRuntimePluginPolicy(ctx: Context): Promise<void> {
	const root = rootContext(ctx) as object
	const store = persistence(ctx)
	if (!store) return Promise.resolve()

	const previous = writeByRoot.get(root) ?? Promise.resolve()
	const next = previous
		.catch((): void => undefined)
		.then(async () => {
			await store
				.namespace('logger')
				.put(policyKey(ctx), serializePluginLogPolicySnapshot(runtimePluginLogPolicy.snapshot()), {
					atomic: true,
				})
			return undefined
		})
		.catch((error) => {
			logPolicyPersistenceFailure(ctx, 'persist', error)
			return undefined
		})

	writeByRoot.set(root, next)
	return next
}
