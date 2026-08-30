import { describe, expect, it } from 'vitest'
import {
	readWorkbenchDefinition,
	readWorkbenchDescriptor,
	readWorkbenchRendererEntry,
} from '@pluxel/runtime/internal'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'

interface SettingsApi extends RpcTarget {
	snapshot(): Readonly<{ enabled: boolean }>
}

interface CatalogApi extends RpcTarget {
	list(): readonly string[]
}

describe('Workbench vNext definitions', () => {
	it('creates one flat frozen definition with keyed descriptors', () => {
		const renderer = workbench.entry(import.meta.url, './fixtures/settings.tsx')
		const definition = workbench.define({
			settings: workbench.view<SettingsApi>({
				renderer,
				placement: workbench.tab({ label: 'Settings', order: 20 }),
			}),
			catalog: workbench.attachment<CatalogApi>({ renderer }),
		})

		expect(Object.keys(definition)).toEqual(['settings', 'catalog'])
		expect(Object.getPrototypeOf(definition)).toBeNull()
		expect(Object.isFrozen(definition)).toBe(true)
		expect(definition.unknown).toBeUndefined()
		expect(readWorkbenchDefinition(definition).entries).toEqual([
			expect.objectContaining({ kind: 'view', key: 'settings' }),
			expect.objectContaining({ kind: 'attachment', key: 'catalog' }),
		])
		expect(readWorkbenchDescriptor(definition.settings)).toMatchObject({
			kind: 'view',
			key: 'settings',
		})
		expect(readWorkbenchRendererEntry(renderer)).toEqual({
			moduleUrl: import.meta.url,
			entryPath: './fixtures/settings.tsx',
		})
	})

	it('places only a definition-owned Attachment and preserves its exact descriptor', () => {
		const renderer = workbench.entry(import.meta.url, './fixtures/picker.tsx')
		const raw = workbench.attachment<CatalogApi>({ renderer })
		expect(() => raw.place(workbench.tab())).not.toThrow()
		expect(() => workbench.define({ picker: raw.place(workbench.tab()) })).toThrow(
			'must belong to a Workbench definition',
		)

		const provider = workbench.define({ picker: raw })
		const consumer = workbench.define({
			fonts: provider.picker.place(workbench.tab({ label: 'Fonts' })),
		})
		const metadata = readWorkbenchDescriptor(consumer.fonts)

		expect(metadata).toMatchObject({ kind: 'attachment-placement', key: 'fonts' })
		if (metadata.kind !== 'attachment-placement') throw new Error('unexpected descriptor')
		expect(metadata.provider).toBe(provider.picker)
		expect(readWorkbenchDescriptor(metadata.provider)).toMatchObject({
			kind: 'attachment',
			key: 'picker',
		})
	})

	it('normalizes the closed tab and route placement records', () => {
		expect(
			workbench.route('/accounts/:accountId/', {
				title: 'Account',
			}),
		).toEqual({
			kind: 'route',
			path: '/accounts/:accountId',
			title: 'Account',
			frame: 'shell',
			order: 0,
		})
		expect(() =>
			workbench.route('/accounts/:accountId', {
				title: 'Account',
				navigation: { label: 'Accounts' },
			}),
		).toThrow('parameterized routes cannot enter navigation')
		expect(() => workbench.route('/accounts/:bad-name', { title: 'Account' })).toThrow(
			'invalid route parameter',
		)
	})

	it('rejects compatibility-shaped definitions and unsafe keys', () => {
		const renderer = workbench.entry(import.meta.url, './fixtures/settings.tsx')
		expect(() => workbench.define({ views: { settings: {} } } as never)).toThrow(
			'invalid entry descriptor',
		)
		const unsafeDefinition = Object.fromEntries([
			[
				['th', 'en'].join(''),
				workbench.view<SettingsApi>({
					renderer,
					placement: workbench.tab(),
				}),
			],
		])
		expect(() => workbench.define(unsafeDefinition)).toThrow('invalid entry key')
		expect(() =>
			workbench.view<SettingsApi>({
				renderer,
				placement: workbench.tab(),
				legacy: true,
			} as never),
		).toThrow('unsupported option "legacy"')
	})

	it('keeps placement metadata within the client protocol bounds', () => {
		expect(() => workbench.tab({ icon: 'arbitrary-icon' as never })).toThrow(
			'fixed Workbench icon set',
		)
		expect(() =>
			workbench.tab({
				group: { id: 'invalid group', label: 'Invalid' },
			}),
		).toThrow('id has an invalid format')
		expect(() =>
			workbench.route('/bounded', {
				title: 'x'.repeat(257),
			}),
		).toThrow('title must be non-empty')
		expect(() => workbench.route('/accounts/../admin', { title: 'Admin' })).toThrow(
			'invalid literal route segment',
		)
	})
})
