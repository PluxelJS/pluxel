import type { PluginNodeAddress } from '@pluxel/core'
import type { PluginStatusSnapshot } from '@pluxel/runtime/web'
import { describe, expect, it } from 'vitest'
import { buildOverview } from '../src/app/plugins/catalog/catalogOverview'
import type { PluginStatusEntry } from '../src/app/plugins/pluginOverview'

describe('plugin catalog overview', () => {
	it('computes the same mutually exclusive status counts used by the filters', () => {
		const running: PluginStatusEntry = {
			...status('Running', 'available', 'running'),
			recentUpdate: {
				outcome: 'restored-previous',
				phase: 'application-reload',
				sequence: 2,
				durationMs: 14,
			},
		}
		const stopped = status('Stopped', 'available', 'stopped')
		const unavailable = status('Unavailable', 'unavailable', 'running')

		const overview = buildOverview({
			statuses: [running, stopped, unavailable],
			sections: [],
			summary: { total: 3 },
		})

		expect(overview.statusCounts).toEqual({ running: 1, stopped: 1, unavailable: 1 })
		expect(overview.total).toBe(3)
		expect(overview).not.toHaveProperty('autoStart')
		expect(overview.statuses[running.id]).toMatchObject({
			packageName: '@fixture/catalog',
			definitionLabel: '@fixture/catalog',
			exportName: 'Running',
			executionLabel: '更新未报告',
			recentUpdateSearchTerms: expect.arrayContaining(['restored-previous', '补偿']),
			recentUpdateWarningLabel: '应用重载失败 · 已用上一应用定义恢复',
			recentUpdateWarningTone: 'yellow',
			recentUpdateWarningDescription: expect.stringContaining('全新补偿宿主'),
		})
	})
})

function status(
	name: string,
	availability: PluginStatusSnapshot['availability'],
	lifecycleState: PluginStatusSnapshot['lifecycleState'],
): PluginStatusEntry {
	const address: PluginNodeAddress = {
		definition: {
			entry: { kind: 'package-root', packageName: '@fixture/catalog' },
			exportName: name,
		},
		variant: 'default',
	}
	return {
		address,
		reference: `package:@fixture/catalog::${name}`,
		route: `v1/package/${name}/@fixture/catalog`,
		id: `v1/package/${name}/@fixture/catalog`,
		displayName: name,
		label: name,
		rootExportName: name,
		autoStart: false,
		sessionIntent: 'inherit',
		desiredState: lifecycleState,
		activationReason: null,
		lifecycleState,
		availability,
		issues: [],
		execution: {
			kind: 'unreported',
			artifact: { kind: 'unreported' },
			update: { kind: 'unreported' },
		},
		recentUpdate: null,
	}
}
