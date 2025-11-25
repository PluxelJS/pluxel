import { describe, expect, test, vi } from 'bun:test'
import { installPackage } from '../../../src/api/features/market/service'

const specInput = { name: 'foo', raw: null, version: null, tag: null }

describe('market service installPackage', () => {
	test('installs then loads package', async () => {
		const installMock = vi.fn().mockResolvedValue({
			spec: { name: 'foo', target: 'foo', key: 'foo#latest', raw: 'foo' },
			status: 'installed',
		})
		const loadMock = vi.fn().mockResolvedValue({
			spec: { name: 'foo', target: 'foo', key: 'foo#latest', raw: 'foo' },
		})

		const ctx = {
			packageService: {
				install: installMock,
				load: loadMock,
			},
		}

		const result = await installPackage(ctx as any, specInput, undefined)

		expect(installMock).toHaveBeenCalledTimes(1)
		expect(loadMock).toHaveBeenCalledTimes(1)
		expect(result.ok).toBe(true)
		expect(result.code).toBe('installed_and_loaded')
		expect(result.installStatus).toBe('installed')
	})

	test('reports load failure after install', async () => {
		const installMock = vi.fn().mockResolvedValue({
			spec: { name: 'foo', target: 'foo', key: 'foo#latest', raw: 'foo' },
			status: 'installed',
		})
		const loadMock = vi.fn().mockRejectedValue(new Error('boom'))

		const ctx = {
			packageService: {
				install: installMock,
				load: loadMock,
			},
		}

		const result = await installPackage(ctx as any, specInput, undefined)

		expect(installMock).toHaveBeenCalledTimes(1)
		expect(loadMock).toHaveBeenCalledTimes(1)
		expect(result.ok).toBe(false)
		expect(result.code).toBe('load_failed')
		expect(result.installStatus).toBe('installed')
	})
})
