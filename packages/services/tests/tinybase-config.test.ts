import * as nativeFs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BasePlugin, Plugin } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import * as v from 'valibot'
import { expect, it } from 'vitest'
import { Passthrough } from '@pluxel/core/fs'
import { requireHostDocuments } from '@pluxel/core/internal'

let normalizations = 0
const Config = v.object({
	text: v.optional(
		v.pipe(
			v.string(),
			v.transform((value) => {
				normalizations++
				return value.trim()
			}),
		),
		'default',
	),
	locked: v.optional(v.string(), 'base'),
})
let applied: v.InferOutput<typeof Config> | undefined
@Plugin()
class ConfiguredOwner extends BasePlugin {
	readonly config = this.configs.use(Config)
	protected override init(): void {
		applied = this.config
	}
}

it('keeps raw saved records, env locks and single normalization through filesystem documents across Hosts', async () => {
	const prefix = await mkdtemp(join(tmpdir(), 'pluxel-tinybase-config-'))
	const owner = ConfiguredOwner.nodeAddress()
	try {
		const host = await createHost({
			plugins: [ConfiguredOwner],
			runtime: {
				zenfs: {
					mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
					durableMounts: ['/'],
				},
				configRecords: {
					records: [{ owner, config: { text: 'initial', locked: 'base' } }],
					overlays: [
						{
							owner,
							config: { locked: 'ENV' },
							sources: [{ path: ['locked'], kind: 'env', name: 'LOCKED' }],
						},
					],
				},
				state: { autoStart: [owner] },
			},
		})
		try {
			await host.start()
			const before = normalizations
			const result = await host.config.patch(owner, { text: ' saved ' })
			expect(result).toMatchObject({
				ok: true,
				saved: true,
				application: 'saved-not-applied',
				applyFailure: { code: 'listener_not_registered' },
			})
			expect(normalizations).toBe(before + 1)
			await expect(host.config.patch(owner, { locked: 'changed' })).resolves.toMatchObject({
				ok: false,
				code: 'mutation_rejected',
			})
			const text = await requireHostDocuments(host.ctx, 'config').getText('config.json')
			expect(JSON.parse(text!)).toMatchObject({
				json: { version: 4, plugins: [{ owner, config: { text: ' saved ', locked: 'base' } }] },
			})
		} finally {
			await host.close()
		}

		const reopened = await createHost({
			plugins: [ConfiguredOwner],
			runtime: {
				zenfs: {
					mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
					durableMounts: ['/'],
				},
				configRecords: { records: [{ owner, config: { text: 'different base', locked: 'base' } }] },
				state: { autoStart: [] },
			},
		})
		try {
			await reopened.start()
			await expect(reopened.config.get(owner)).resolves.toMatchObject({
				ok: true,
				application: 'applied',
				config: { text: 'saved', locked: 'base' },
			})
			expect(applied).toEqual({ text: 'saved', locked: 'base' })
			const persisted = await requireHostDocuments(reopened.ctx, 'config').getText('config.json')
			expect(JSON.parse(persisted!)).toMatchObject({
				json: { plugins: [{ owner, config: { text: ' saved ', locked: 'base' } }] },
			})
			await expect(reopened.config.reset(owner, ['text'])).resolves.toMatchObject({
				ok: true,
				saved: true,
			})
		} finally {
			await reopened.close()
		}
	} finally {
		await rm(prefix, { recursive: true, force: true })
	}
})
