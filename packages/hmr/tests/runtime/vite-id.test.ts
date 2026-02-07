import { describe, expect, it } from 'vitest'
import {
	cleanViteUrl,
	fsPathFromViteFsId,
	isBarePackageSpecifier,
	unwrapViteId,
} from '../../src/services/runtime/shared/vite-id'

describe('runtime/shared vite-id', () => {
	it('cleanViteUrl strips query strings', () => {
		expect(cleanViteUrl('/src/main.ts?import')).toBe('/src/main.ts')
		expect(cleanViteUrl('/@fs/C:/workspace/a.ts?direct')).toBe('/@fs/C:/workspace/a.ts')
	})

	it('unwrapViteId decodes /@id/ ids', () => {
		expect(unwrapViteId('/@id/%40pluxel%2Fcontext')).toBe('@pluxel/context')
		// Invalid encoding should not throw.
		expect(unwrapViteId('/@id/%E0%A4%A')).toBe('%E0%A4%A')
	})

	it('fsPathFromViteFsId handles POSIX and Windows drive ids', () => {
		expect(fsPathFromViteFsId('/@fs/home/a/file.ts')).toBe('/home/a/file.ts')
		expect(fsPathFromViteFsId('/@fs//home/a/file.ts')).toBe('/home/a/file.ts')

		expect(fsPathFromViteFsId('/@fs/C:/workspace/a.ts')).toBe('C:/workspace/a.ts')
		expect(fsPathFromViteFsId('/@fs//C:/workspace/a.ts')).toBe('C:/workspace/a.ts')
		expect(fsPathFromViteFsId('/@fs/C:/workspace/a.ts?import')).toBe('C:/workspace/a.ts')
	})

	it('isBarePackageSpecifier only matches bare imports', () => {
		expect(isBarePackageSpecifier('@pluxel/core')).toBe(true)
		expect(isBarePackageSpecifier('@scope/name/subpath')).toBe(true)
		expect(isBarePackageSpecifier('react')).toBe(true)
		expect(isBarePackageSpecifier('foo/bar')).toBe(true)

		expect(isBarePackageSpecifier('')).toBe(false)
		expect(isBarePackageSpecifier('./x')).toBe(false)
		expect(isBarePackageSpecifier('../x')).toBe(false)
		expect(isBarePackageSpecifier('/abs/x.ts')).toBe(false)
		expect(isBarePackageSpecifier('\0virtual')).toBe(false)
		expect(isBarePackageSpecifier('node:fs')).toBe(false)
		expect(isBarePackageSpecifier('file:///x.ts')).toBe(false)
		expect(isBarePackageSpecifier('C:/x.ts')).toBe(false)
		expect(isBarePackageSpecifier('C:\\\\x.ts')).toBe(false)
	})
})

