import { describe, expect, test } from 'bun:test'

import SnapshotPluginDefault, { SnapshotPlugin } from './index'

describe('@pluxel/snapshot', () => {
	test('default export matches named SnapshotPlugin', () => {
		expect(SnapshotPluginDefault).toBe(SnapshotPlugin)
	})
})

