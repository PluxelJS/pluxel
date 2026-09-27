import { expect, test } from 'vitest'
import { resolveStateDir } from '../src/config'

test('state directory uses the default only when the override is absent', () => {
	expect(resolveStateDir('/project', {})).toBe('/project/.pluxel')
	expect(resolveStateDir('/project', { PLUXEL_STATE_DIR: '/data/state' })).toBe('/data/state')
	expect(() => resolveStateDir('/project', { PLUXEL_STATE_DIR: '  ' })).toThrow(
		'PLUXEL_STATE_DIR must be a nonempty path when set',
	)
})
