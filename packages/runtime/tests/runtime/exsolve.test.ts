import { describe, expect, it } from 'vitest'

import { toDirectoryURLString } from '@pluxel/runtime/shared'

describe('runtime/shared exsolve helpers', () => {
	it('normalizes backslashes and enforces a trailing slash', () => {
		if (process.platform === 'win32') {
			expect(toDirectoryURLString('C:\\\\tmp\\\\a\\\\b')).toBe('file:///C:/tmp/a/b/')
			expect(toDirectoryURLString('C:/tmp/a/b')).toBe('file:///C:/tmp/a/b/')
			expect(toDirectoryURLString('C:/tmp/a/b/')).toBe('file:///C:/tmp/a/b/')
		} else {
			expect(toDirectoryURLString('/tmp\\\\a\\\\b')).toBe('file:///tmp/a/b/')
			expect(toDirectoryURLString('/tmp/a/b')).toBe('file:///tmp/a/b/')
			expect(toDirectoryURLString('/tmp/a/b/')).toBe('file:///tmp/a/b/')
		}
	})
})
