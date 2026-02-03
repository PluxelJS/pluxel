import { describe, expect, test } from 'vitest'
import { checkPluginDecorator, getPluginInfo } from '@pluxel/core'

import SnapshotPluginDefault, { SnapshotPlugin } from './index'

describe('@pluxel/snapshot', () => {
	test('exports a decorated plugin ctor (default export)', () => {
		expect(SnapshotPluginDefault).toBe(SnapshotPlugin)
		expect(checkPluginDecorator(SnapshotPlugin)).toBe(true)
		expect(getPluginInfo(SnapshotPlugin).declaredName).toBe('Snapshot')
	})
})
