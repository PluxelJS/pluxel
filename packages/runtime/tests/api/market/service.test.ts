import { describe, expect, test, vi } from 'vitest'
import { applyPackageMutation } from '../../../../runtime-dynamic/src/api/features/package-manager/service'

const specInput: { name: string; raw: string | null; version: string | null; tag: string | null } =
	{ name: 'foo', raw: null, version: null, tag: null }

describe('package-manager service applyPackageMutation', () => {
	test('installs then loads package', async () => {
		const installResult = {
			spec: { name: 'foo', target: 'foo', key: 'foo#latest', raw: 'foo' },
			status: 'installed',
		}
		const loadMock = vi.fn().mockResolvedValue({
			spec: { name: 'foo', target: 'foo', key: 'foo#latest', raw: 'foo' },
		})

		const ctx = {
			packageService: {
				installMany: vi.fn().mockResolvedValue([installResult]),
				load: loadMock,
			},
		}

		const result = await applyPackageMutation(ctx as any, {
			action: 'install',
			specs: [specInput],
			options: {},
		})

		expect(ctx.packageService.installMany).toHaveBeenCalledTimes(1)
		expect(loadMock).toHaveBeenCalledTimes(1)
		expect(result.ok).toBe(true)
		expect(result.results[0]?.ok).toBe(true)
		expect(result.results[0]?.code).toBe('installed_and_loaded')
		expect(result.results[0]?.installStatus).toBe('installed')
	})

	test('reports load failure after install', async () => {
		const installResult = {
			spec: { name: 'foo', target: 'foo', key: 'foo#latest', raw: 'foo' },
			status: 'installed',
		}
		const loadMock = vi.fn().mockRejectedValue(new Error('boom'))

		const ctx = {
			packageService: {
				installMany: vi.fn().mockResolvedValue([installResult]),
				load: loadMock,
			},
		}

		const result = await applyPackageMutation(ctx as any, {
			action: 'install',
			specs: [specInput],
			options: {},
		})

		expect(ctx.packageService.installMany).toHaveBeenCalledTimes(1)
		expect(loadMock).toHaveBeenCalledTimes(1)
		expect(result.ok).toBe(false)
		expect(result.results[0]?.ok).toBe(false)
		expect(result.results[0]?.code).toBe('load_failed')
		expect(result.results[0]?.installStatus).toBe('installed')
	})
})
