import { describe, expect, it } from 'vitest'
import {
	readWorkbenchDefinition,
	readWorkbenchDescriptor,
	readWorkbenchMarkdownDocument,
	readWorkbenchRendererEntry,
} from '@pluxel/runtime/internal'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'
import * as v from 'valibot'

interface SettingsApi extends RpcTarget {
	snapshot(): Readonly<{ enabled: boolean }>
}

interface CatalogApi extends RpcTarget {
	list(): readonly string[]
}

describe('Workbench vNext definitions', () => {
	it('declares a frozen host-rendered Markdown Content with no renderer', () => {
		const document = workbench.markdown(import.meta.url, './fixtures/guide.md')
		const definition = workbench.define({
			guide: workbench.content({
				document,
				placement: workbench.tab({ label: 'Guide' }),
			}),
		})

		expect(readWorkbenchMarkdownDocument(document)).toEqual({
			moduleUrl: import.meta.url,
			sourcePath: './fixtures/guide.md',
			slots: {},
		})
		expect(readWorkbenchDescriptor(definition.guide)).toMatchObject({
			kind: 'content',
			key: 'guide',
			document,
		})
		expect(Object.isFrozen(document)).toBe(true)
		expect(Object.isFrozen(definition.guide)).toBe(true)
		expect(definition.guide).not.toHaveProperty('renderer')
	})

	it('rejects forged Content documents and unsafe Markdown provenance', () => {
		expect(() => workbench.markdown(import.meta.url, '/guide.md')).toThrow(
			'sourcePath must be module-relative',
		)
		expect(() => workbench.markdown(import.meta.url, './guide.md?raw')).toThrow(
			'sourcePath must not contain',
		)
		expect(() =>
			workbench.content({
				document: {} as never,
				placement: workbench.tab(),
			}),
		).toThrow('must be created by workbench.markdown')
		expect(() =>
			workbench.content({
				document: workbench.markdown(import.meta.url, './guide.md'),
				placement: workbench.tab(),
				legacy: true,
			} as never),
		).toThrow('unsupported option "legacy"')
	})

	it('rejects forged data/action declarations and an action form without input', () => {
		const data = workbench.data(v.string())
		const action = workbench.action({ label: 'Refresh' })
		const dataBrand = Reflect.ownKeys(data).find((key) => typeof key === 'symbol')
		const actionBrand = Reflect.ownKeys(action).find((key) => typeof key === 'symbol')
		if (!dataBrand || !actionBrand) throw new Error('Content slot brand was not found')

		expect(() =>
			workbench.markdown(import.meta.url, './guide.md', {
				status: { [dataBrand]: { schema: v.string() } } as never,
			}),
		).toThrow('must be created by workbench.data() or action()')
		expect(() =>
			workbench.markdown(import.meta.url, './guide.md', {
				refresh: {
					[actionBrand]: {
						label: 'Forged',
						input: undefined,
						form: 'none',
					},
				} as never,
			}),
		).toThrow('must be created by workbench.data() or action()')
		expect(() => workbench.action({ label: 'Refresh', form: 'embedded' } as never)).toThrow(
			'form requires an input schema',
		)
	})

	it('uses the artifact UTF-8 bounds for action text', () => {
		expect(() => workbench.action({ label: '界'.repeat(43) })).toThrow('exceeds 128 UTF-8 bytes')
		expect(() => workbench.action({ label: 'Delete', confirm: '界'.repeat(342) })).toThrow(
			'exceeds 1024 UTF-8 bytes',
		)
	})

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
