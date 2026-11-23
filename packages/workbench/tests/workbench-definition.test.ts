import { describe, expect, it } from 'vitest'
import {
	parseWorkbenchPlacement,
	readWorkbenchDefinition,
	readWorkbenchDescriptor,
} from '../src/workbench/definition'
import type { RpcTarget } from 'capnweb'
import { workbench } from '@pluxel/workbench'
import * as v from 'valibot'

interface SettingsApi extends RpcTarget {
	snapshot(): Readonly<{ enabled: boolean }>
}

interface CatalogApi extends RpcTarget {
	list(): readonly string[]
}

const tab = { kind: 'tab' } as const

describe('Workbench definitions', () => {
	it('validates source paths, owning modules and options', () => {
		expect(() => workbench.content({ document: '/guide.md', placement: tab })).toThrow(
			'document must be module-relative',
		)
		expect(() => workbench.content({ document: './guide.md?raw', placement: tab })).toThrow(
			'document must not contain',
		)
		expect(() => workbench.content({ document: './guide.txt', placement: tab })).toThrow(
			'document must use the .md extension',
		)
		expect(() =>
			workbench.content({ document: './guide.md', placement: tab, slots: undefined } as never),
		).toThrow('slots must be a plain record')
		expect(() => workbench.attachment({ renderer: '/settings.tsx' })).toThrow(
			'renderer must be module-relative',
		)
		expect(() =>
			workbench.define('relative', { picker: workbench.attachment({ renderer: './ui.tsx' }) }),
		).toThrow('moduleUrl must be an absolute URL')
		expect(() =>
			workbench.content({
				document: './guide.md',
				placement: tab,
				legacy: true,
			} as never),
		).toThrow('unsupported option "legacy"')
	})

	it('rejects forged slots and an action form without input', () => {
		const data = workbench.data(v.string())
		const action = workbench.action({ label: 'Refresh' })
		for (const slot of [data, action]) {
			const copy = { ...slot }
			expect(() =>
				workbench.content({ document: './guide.md', placement: tab, slots: { forged: copy } }),
			).toThrow('must be created by workbench.data() or action()')
		}
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

	it('binds every source to its definition and rejects rebinding a defined descriptor', () => {
		const entries = {
			settings: workbench.view<SettingsApi>({
				renderer: './settings.tsx',
				placement: { kind: 'tab', label: 'Settings', order: 20 },
			}),
			guide: workbench.content({ document: './guide.md', placement: tab }),
		}
		const definition = workbench.define(import.meta.url, entries)
		expect(Object.keys(definition)).toEqual(['settings', 'guide'])
		expect(Object.isFrozen(definition)).toBe(true)
		expect(() => readWorkbenchDefinition(Object.create(definition))).toThrow(
			'invalid Workbench definition',
		)
		expect(readWorkbenchDescriptor(definition.settings)).toMatchObject({
			key: 'settings',
			moduleUrl: import.meta.url,
			renderer: './settings.tsx',
		})
		expect(readWorkbenchDescriptor(definition.guide)).toMatchObject({
			key: 'guide',
			moduleUrl: import.meta.url,
			document: './guide.md',
			placement: { kind: 'tab', order: 0 },
		})
		const other = 'file:///elsewhere/workbench.ts'
		expect(readWorkbenchDescriptor(workbench.define(other, entries).settings).moduleUrl).toBe(other)
		expect(() => workbench.define(other, { settings: definition.settings } as never)).toThrow(
			'already belongs to a Workbench definition',
		)
		expect(() => workbench.define(other, { forged: { ...definition.settings } } as never)).toThrow(
			'invalid entry descriptor',
		)
	})

	it('places a definition-owned Attachment and preserves its exact provider descriptor', () => {
		const raw = workbench.attachment<CatalogApi>({ renderer: './picker.tsx' })
		expect(raw).not.toHaveProperty('place')
		const provider = workbench.define('file:///provider/definition.ts', { picker: raw })
		const consumer = workbench.define('file:///consumer/definition.ts', {
			fonts: provider.picker.place({ kind: 'tab', label: 'Fonts' }),
		})
		const metadata = readWorkbenchDescriptor(consumer.fonts)
		expect(metadata).toMatchObject({
			kind: 'attachment-placement',
			key: 'fonts',
			moduleUrl: 'file:///consumer/definition.ts',
		})
		if (metadata.kind !== 'attachment-placement') throw new Error('unexpected descriptor')
		expect(metadata.provider).toBe(provider.picker)
		expect(readWorkbenchDescriptor(metadata.provider)).toMatchObject({
			kind: 'attachment',
			key: 'picker',
			moduleUrl: 'file:///provider/definition.ts',
		})
	})

	it('rejects unsafe definition keys and unsupported view options', () => {
		const view = workbench.view({ renderer: './ui.tsx', placement: tab })
		for (const key of ['then', 'constructor', 'prototype', '__proto__']) {
			expect(() => workbench.define(import.meta.url, { [key]: view })).toThrow('invalid entry key')
		}
		expect(() => workbench.define(import.meta.url, {})).toThrow('must not be empty')
		expect(() =>
			workbench.view({ renderer: './ui.tsx', placement: tab, legacy: true } as never),
		).toThrow('unsupported option "legacy"')
	})

	it('validates plain placements and snapshots nested groups without freezing caller input', () => {
		const group = { id: 'suite', label: 'Tools' }
		const input = {
			kind: 'route',
			path: '/reports',
			title: 'Report',
			navigation: { label: 'Reports', group },
		} as const
		const placement = parseWorkbenchPlacement(input)
		group.label = 'Changed'
		expect(placement).toMatchObject({
			frame: 'shell',
			order: 0,
			navigation: { group: { label: 'Tools' } },
		})
		expect(() => parseWorkbenchPlacement({ ...input, navigation: false })).toThrow(
			'options must be a plain record',
		)
		expect(() => parseWorkbenchPlacement({ ...input, frame: 'invalid' })).toThrow(
			'frame must be shell or standalone',
		)
		expect(() => parseWorkbenchPlacement({ ...input, path: '/reports/:id' })).toThrow(
			'parameterized routes cannot enter navigation',
		)
		expect(() => parseWorkbenchPlacement({ ...input, path: '/reports/' })).toThrow(
			'path must be canonical',
		)
		expect(() => parseWorkbenchPlacement({ ...tab, icon: 'unknown' })).toThrow(
			'fixed Workbench icon set',
		)
		expect(() =>
			parseWorkbenchPlacement({ ...tab, group: { id: 'invalid group', label: 'Invalid' } }),
		).toThrow('id has an invalid format')
		expect(() => parseWorkbenchPlacement({ ...input, title: 'x'.repeat(257) })).toThrow(
			'title must be non-empty',
		)
		expect(() => parseWorkbenchPlacement({ ...input, path: '/accounts/../admin' })).toThrow(
			'invalid literal route segment',
		)
		expect(() => parseWorkbenchPlacement({ kind: 'panel', region: 'top', label: 'Hints' })).toThrow(
			'region must be left, right, or bottom',
		)
	})
})
