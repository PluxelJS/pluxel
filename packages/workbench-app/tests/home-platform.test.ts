import { describe, expect, it } from 'vitest'
import type { PluxelPlatformSnapshot } from '@pluxel/runtime/environment'
import { platformNotice } from '../src/app/home/HomeIntro'

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
			'Cloudflare Workers runtime',
		)
	})

	it('distinguishes provider detection from the JavaScript runtime', () => {
		expect(
			platformNotice(platform({ deployment: { provider: 'cloudflare_workers', ci: false } })),
		).toContain('检测到 Cloudflare Workers 部署环境')
	})

	it('does not show a warning for a normal Node host', () => {
		expect(platformNotice(platform())).toBeNull()
	})
})
