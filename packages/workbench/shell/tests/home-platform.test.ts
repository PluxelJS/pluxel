import { describe, expect, it } from 'vitest'
import type { PluxelPlatformSnapshot } from '@pluxel/services/management/protocol'
import { groupApps } from '../src/app/home/HomeApps'
import { groupPlugins, platformNotice } from '../src/app/home/HomeIntro'
import type { PluginNodeAddress } from '@pluxel/core'
import type { PluginStatusEntry } from '../src/app/plugins/pluginOverview'

function platform(override: Partial<PluxelPlatformSnapshot> = {}): PluxelPlatformSnapshot {
	return {
		runtime: { name: 'node', version: '24.0.0' },
		deployment: { provider: null, ci: false },
		mode: 'production',
		platform: 'linux',
		...override,
	}
}

describe('Workbench platform notice', () => {
	it('calls out Cloudflare Workers runtime constraints', () => {
		expect(platformNotice(platform({ runtime: { name: 'workerd', version: null } }))).toContain(
			'运行于 Cloudflare Workers',
		)
	})

	it('distinguishes provider detection from the JavaScript runtime', () => {
		expect(
			platformNotice(platform({ deployment: { provider: 'cloudflare_workers', ci: false } })),
		).toContain('Cloudflare Workers 部署')
	})

	it('does not show a warning for a normal Node host', () => {
		expect(platformNotice(platform())).toBeNull()
	})
})

describe('home plugin groups', () => {
	const address = (exportName: string): PluginNodeAddress => ({
		definition: { entry: { kind: 'package-root', packageName: '@test/home' }, exportName },
		variant: 'default',
	})
	const entry = (name: string, lifecycleState: 'running' | 'stopped' = 'running') =>
		({
			route: name,
			label: name,
			address: address(name),
			availability: 'available',
			lifecycleState,
		}) as unknown as PluginStatusEntry

	it('lists ungrouped plugins first, then each catalog group, stopped plugins on top', () => {
		const groups = groupPlugins(
			[entry('Zeta'), entry('Cache'), entry('Redis', 'stopped'), entry('Alpha')],
			[
				{
					sectionId: 'dependency:cache',
					name: 'Cache',
					basis: { kind: 'shared' },
					nodes: [address('Cache'), address('Redis')],
				},
			],
		)
		expect(groups.map((group) => [group.name, group.plugins.map((p) => p.label)])).toEqual([
			[null, ['Alpha', 'Zeta']],
			['Cache', ['Redis', 'Cache']],
		])
	})
})

describe('home app shortcuts', () => {
	const app = (key: string, group?: string) => ({
		key,
		label: key,
		owner: 'Owner',
		standalone: false,
		href: `/${key}`,
		...(group === undefined ? {} : { group: { id: group, label: group.toUpperCase() } }),
	})

	it('shows ungrouped shortcuts first and one block per Workbench group', () => {
		const blocks = groupApps([app('mail', 'forum'), app('vault'), app('users', 'forum'), app('fonts')])
		expect(blocks.map((block) => [block.label, block.apps.map((entry) => entry.key)])).toEqual([
			[null, ['vault', 'fonts']],
			['FORUM', ['mail', 'users']],
		])
	})
})
