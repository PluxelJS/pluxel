import { describe, expect, it } from 'vitest'

import { toDirectoryURLString } from '@pluxel/runtime/shared'

describe('runtime/shared exsolve helpers', () => {
	it('normalizes backslashes and enforces a trailing slash', () => {
		const cases =
			process.platform === 'win32'
				? [
						['C:\\\\tmp\\\\a\\\\b', 'file:///C:/tmp/a/b/'],
						['C:/tmp/a/b', 'file:///C:/tmp/a/b/'],
						['C:/tmp/a/b/', 'file:///C:/tmp/a/b/'],
					]
				: [
						['/tmp\\\\a\\\\b', 'file:///tmp/a/b/'],
						['/tmp/a/b', 'file:///tmp/a/b/'],
						['/tmp/a/b/', 'file:///tmp/a/b/'],
					]

		expect(cases.map(([input]) => toDirectoryURLString(input))).toEqual(
			cases.map(([, expected]) => expected),
		)
	})
})
