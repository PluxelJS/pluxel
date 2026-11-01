import * as nativeFs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import * as v from 'valibot'
import { expect, it } from 'vitest'
import { Passthrough } from '@pluxel/core/fs'
import { requireTinyBaseHost } from '@pluxel/core/internal'

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

it('keeps saved layer, env locks, single normalization and saved-not-applied through TinyBase across Hosts', async () => {
	const prefix = await mkdtemp(join(tmpdir(), 'pluxel-tinybase-config-'))
	const owner = pluginNodeAddressOf(ConfiguredOwner)
	try {
		const host = await createHost({
			plugins: [ConfiguredOwner],
			config: {
				storage: {
					mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
					durableMounts: ['/'],
				},
			},
			configRecords: {
				initial: [{ owner, config: { text: 'initial', locked: 'base' } }],
				overlays: [
					{
						owner,
						config: { locked: 'ENV' },
						sources: [{ path: ['locked'], kind: 'env', name: 'LOCKED' }],
					},
				],
			},
			state: {
				initial: { autoStart: [owner] },
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
			const text = await requireTinyBaseHost(host.ctx).documents('config').getText('config.json')
			expect(JSON.parse(text!)).toMatchObject({
				json: { version: 3, plugins: [{ owner, config: { text: ' saved ' } }] },
			})
		} finally {
			await host.close()
		}

		const reopened = await createHost({
			plugins: [ConfiguredOwner],
			config: {
				storage: {
					mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
					durableMounts: ['/'],
				},
			},
			configRecords: {
				initial: [{ owner, config: { text: 'different base', locked: 'base after env removal' } }],
			},
			state: {
				initial: { autoStart: [] },
			},
		})
		try {
			await reopened.start()
			await expect(reopened.config.get(owner)).resolves.toMatchObject({
				ok: true,
				application: 'applied',
				config: { text: 'saved', locked: 'base after env removal' },
			})
			expect(applied).toEqual({ text: 'saved', locked: 'base after env removal' })
			const persisted = await requireTinyBaseHost(reopened.ctx)
				.documents('config')
				.getText('config.json')
			expect(JSON.parse(persisted!)).toMatchObject({
				json: { plugins: [{ owner, config: { text: ' saved ' } }] },
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
