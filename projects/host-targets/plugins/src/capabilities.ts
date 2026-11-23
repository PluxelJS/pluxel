import {
	BasePlugin,
	formatPluginNodeReference,
	Plugin,
	TinyBaseError,
	type PluginContext,
} from '@pluxel/core'
import { VaultError } from '@pluxel/core/vault'
import * as v from 'valibot'

declare module '@pluxel/core' {
	interface Events {
		'host-targets:probe': [string]
	}
}

const sourcePayload = v.object({ source: v.string() })
export const ProbeVault = v.object({ probe: v.string() })

async function checkVault(ctx: PluginContext) {
	const kv = ctx.vault.kv()
	const binding = await kv.get('probe')
	const vaultBinding =
		binding.exists &&
		binding.source === 'env' &&
		!binding.writable &&
		binding.value === 'fixture-binding'
	try {
		await kv.set('probe', 'fixture-binding')
	} catch (error) {
		if (error instanceof VaultError && error.code === 'READ_ONLY')
			return { vaultBinding, vaultWrite: error.code }
		throw error
	}
	throw new Error('Host accepted a write to a deployment binding')
}

async function checkDurableState(ctx: PluginContext) {
	try {
		await ctx.tinybase.open({ durable: true })
		return 'opened' as const
	} catch (error) {
		if (error instanceof TinyBaseError && error.code === 'DURABILITY_UNAVAILABLE') return error.code
		throw error
	}
}

async function checkFiles(ctx: PluginContext, durable: boolean): Promise<'read-write' | 'ENOTSUP'> {
	const files = await ctx.fs({ writable: true, durable }).catch((error: unknown): undefined => {
		if (error instanceof Error && 'code' in error && error.code === 'ENOTSUP') return undefined
		throw error
	})
	if (!files) return 'ENOTSUP'
	const file = `probe-${crypto.randomUUID()}.txt`
	await files.writeFile(file, 'host probe', { flag: 'wx' })
	try {
		if ((await files.readFile(file, 'utf8')) !== 'host probe') throw new Error('File read mismatch')
		return 'read-write'
	} finally {
		await files.unlink(file)
	}
}

@Plugin()
export class HostCapabilities extends BasePlugin {
	/** Run on an isolated Host with the probe binding and a JSON greeting transport. */
	async inspect(sourceUrl: string) {
		const response = await this.ctx.fetch(sourceUrl)
		if (!response.ok) {
			await response.body?.cancel()
			throw new Error(`Probe Fetch returned ${response.status}`)
		}
		const fetchSource = v.parse(sourcePayload, await response.json()).source
		const wretchSource = await this.ctx.wretch
			.get(sourceUrl)
			.json((data) => v.parse(sourcePayload, data).source)

		const owner = formatPluginNodeReference(this.ctx.pluginInfo.nodeAddress)
		this.ctx.logger.with({ operation: 'host-probe' }).info('Checking host capabilities')
		let eventDeliveries = 0
		let effectCleanups = 0
		const unsubscribe = this.ctx.events.on('host-targets:probe', (value) => {
			if (value === owner) eventDeliveries++
		})
		const guard = this.ctx.effects.defer(() => {
			unsubscribe()
			effectCleanups++
		})
		try {
			this.ctx.events.emit('host-targets:probe', owner)
		} finally {
			await guard.dispose()
		}
		this.ctx.events.emit('host-targets:probe', owner)

		return {
			fetchSource,
			wretchSource,
			...(await checkVault(this.ctx)),
			sessionFiles: await checkFiles(this.ctx, false),
			durableFiles: await checkFiles(this.ctx, true),
			durableState: await checkDurableState(this.ctx),
			owner,
			eventDeliveries,
			effectCleanups,
		}
	}
}
