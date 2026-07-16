import { describe, expect, it, vi } from 'vitest'
import { PLUXEL_CONDITION_HMR } from '@pluxel/runtime/internal'
import { isOk } from 'option-t/plain_result'
import { PackageLoader } from '../../src/package/loader'
import { normalizeSpecifier } from '../../src/package/specifiers'

type PackageLoaderDefaults = ConstructorParameters<typeof PackageLoader>[3]
type ResolveEntry = (selector: unknown, options?: unknown) => Promise<unknown>

function createPackageLoader(resolveEntry: ResolveEntry, getDefaults: PackageLoaderDefaults) {
	return new PackageLoader(
		{ scanService: { resolveEntry } } as ConstructorParameters<typeof PackageLoader>[0],
		{} as ConstructorParameters<typeof PackageLoader>[1],
		{} as ConstructorParameters<typeof PackageLoader>[2],
		getDefaults,
		() => {},
		() => {},
		async () => {
			throw new Error('install should not run')
		},
		() => ({ cwd: process.cwd(), dry: true, force: false, installPeerDependencies: false }),
		(_code, message) => new Error(message),
		() => false,
	)
}

describe('PackageLoader scan policy', () => {
	it('does not pass HMR export conditions through package-managed resolution', async () => {
		const resolveEntry = vi.fn().mockResolvedValue({
			ok: true,
			dir: '/workspace/pkg',
			entry: '/workspace/pkg/dist/index.mjs',
			source: 'exports',
			tried: [],
		})
		const loader = createPackageLoader(resolveEntry, () => ({
			preferFreshImport: false,
			scan: {
				scan: {
					conditions: [PLUXEL_CONDITION_HMR, 'node', 'import'],
					preferHmrExports: true,
				},
			},
		}))

		await loader.resolveEntryForSpec(normalizeSpecifier('pluxel-plugin-managed'), {
			scan: {
				conditions: [PLUXEL_CONDITION_HMR, 'default'],
				preferHmrExports: true,
			},
		})

		expect(resolveEntry).toHaveBeenCalledWith(
			{ name: 'pluxel-plugin-managed' },
			{
				scan: {
					conditions: ['default'],
				},
			},
		)
	})

	it('exposes package entry resolution failures as option-t Result', async () => {
		const resolveEntry = vi.fn().mockResolvedValue({
			ok: false,
			dir: 'missing-package',
			code: 'MISSING_PACKAGE',
			message: 'Package is missing.',
		})
		const loader = createPackageLoader(resolveEntry, () => ({ preferFreshImport: false }))

		const result = await loader.resolveEntryForSpecResult(normalizeSpecifier('missing-package'))

		expect(isOk(result)).toBe(false)
		if (isOk(result)) throw new Error('expected Err')
		expect(result.err).toMatchObject({
			code: 'MISSING_PACKAGE',
			message: 'Package is missing.',
		})
	})
})
