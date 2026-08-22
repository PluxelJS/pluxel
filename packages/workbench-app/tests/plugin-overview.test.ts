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
					get sourceSpace() {
						reads.push('sourceSpace')
						return null
					},
					get path() {
						reads.push('path')
						return null
					},
				},
				exportName: 'ExamplePlugin',
			},
			variant: 'default',
			forkId: null,
		})

		expect(reads).toEqual(['kind', 'packageName', 'sourceSpace', 'path'])
		expect(address).toEqual({
			definition: {
				entry: { kind: 'package-root', packageName: '@pluxel/example' },
				exportName: 'ExamplePlugin',
			},
			variant: 'default',
		})
	})

	it('materializes a forked source-entry address', () => {
		expect(
			materializeAddress({
				definition: {
					entry: {
						kind: 'source-entry',
						packageName: null,
						sourceSpace: 'app',
						path: 'plugins/plugin.ts',
					},
					exportName: 'SourcePlugin',
				},
				variant: 'fork',
				forkId: 'secondary',
			}),
		).toEqual({
			definition: {
				entry: { kind: 'source-entry', sourceSpace: 'app', path: 'plugins/plugin.ts' },
				exportName: 'SourcePlugin',
			},
			variant: 'fork',
			forkId: 'secondary',
		})
	})

	it('waits for the selected entry field instead of parsing a partial response', () => {
		expect(
			materializeAddress({
				definition: {
					entry: { kind: 'package-root', sourceSpace: null, path: null },
					exportName: 'ExamplePlugin',
				},
				variant: 'default',
			}),
		).toBeNull()
	})
})
