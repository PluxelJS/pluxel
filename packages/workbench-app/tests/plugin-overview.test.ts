import { describe, expect, it } from 'vitest'
import { materializeAddress } from '../src/app/plugins/pluginOverview'

describe('plugin overview address materialization', () => {
	it('demands both entry variants before materializing a package-root address', () => {
		const reads: string[] = []
		const address = materializeAddress({
			definition: {
				entry: {
					get kind() {
						reads.push('kind')
						return 'package-root'
					},
					get packageName() {
						reads.push('packageName')
						return '@pluxel/example'
					},
					get source() {
						reads.push('source')
						return null
					},
				},
				exportName: 'ExamplePlugin',
			},
			instance: 'default',
			forkId: null,
		})

		expect(reads).toEqual(['kind', 'packageName', 'source'])
		expect(address).toEqual({
			definition: {
				entry: { kind: 'package-root', packageName: '@pluxel/example' },
				exportName: 'ExamplePlugin',
			},
			instance: 'default',
		})
	})

	it('materializes a forked source-entry address', () => {
		expect(
			materializeAddress({
				definition: {
					entry: { kind: 'source-entry', packageName: null, source: './plugin.ts' },
					exportName: 'SourcePlugin',
				},
				instance: 'fork',
				forkId: 'secondary',
			}),
		).toEqual({
			definition: {
				entry: { kind: 'source-entry', source: './plugin.ts' },
				exportName: 'SourcePlugin',
			},
			instance: 'fork',
			forkId: 'secondary',
		})
	})

	it('waits for the selected entry field instead of parsing a partial response', () => {
		expect(
			materializeAddress({
				definition: {
					entry: { kind: 'package-root', source: null },
					exportName: 'ExamplePlugin',
				},
				instance: 'default',
			}),
		).toBeNull()
	})
})
