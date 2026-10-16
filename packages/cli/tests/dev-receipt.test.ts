import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DevClientError } from '../src/dev/client'
import { decodeDevReceipt, encodeDevReceipt } from '../src/dev/receipt'

const original = {
	root: resolve('/workspace/应用'),
	instanceId: 'instance_1',
	runId: 'run-2',
	serviceId: 'workspace/app',
}

function token(value: unknown): string {
	return `pluxel-dev-v1.${Buffer.from(JSON.stringify(value)).toString('base64url')}`
}

function expectInvalid(value: string) {
	expect(() => decodeDevReceipt(value)).toThrow(DevClientError)
	expect(() => decodeDevReceipt(value)).toThrow(expect.objectContaining({ code: 'invalid_input' }))
}

describe('development run receipts', () => {
	it('retains the original instance and root independently of current service selection', () => {
		const encoded = encodeDevReceipt(original)
		const restarted = { ...original, instanceId: 'instance_2' }
		expect(decodeDevReceipt(encoded)).toEqual(original)
		expect(decodeDevReceipt(encoded).instanceId).not.toBe(restarted.instanceId)
		const { serviceId: _serviceId, ...unmanaged } = original
		expect(decodeDevReceipt(encodeDevReceipt(unmanaged))).toEqual(unmanaged)
	})

	it('serializes only the locator even when its source contains discovery credentials', () => {
		const discovery = {
			...original,
			nonce: 'secret-nonce',
			socketPath: '/private/console.sock',
		}
		const encoded = encodeDevReceipt(discovery)
		const payload = Buffer.from(encoded.split('.')[1]!, 'base64url').toString('utf8')
		expect(JSON.parse(payload)).toEqual(original)
		expect(payload).not.toContain('nonce')
		expect(payload).not.toContain('socket')
	})

	it.each([
		'',
		'run-2',
		'pluxel-dev-v2.e30',
		'pluxel-dev-v01.e30',
		'pluxel-dev-v1.',
		'pluxel-dev-v1.e30=',
		'pluxel-dev-v1.e31', // Noncanonical trailing base64 bits.
		'pluxel-dev-v1.%%% ',
		'pluxel-dev-v1._w', // Invalid UTF-8.
		`pluxel-dev-v1.${Buffer.from('{').toString('base64url')}`,
		`pluxel-dev-v1.${'a'.repeat(16 * 1024)}`,
	])('rejects malformed or unsupported token %s', expectInvalid)

	it.each([
		null,
		[],
		{},
		{ ...original, root: 'relative/root' },
		{ ...original, root: '/bad\0root' },
		{ ...original, root: `/${'界'.repeat(1366)}` },
		{ ...original, instanceId: '' },
		{ ...original, instanceId: 'a'.repeat(129) },
		{ ...original, runId: '../run' },
		{ ...original, runId: 'run\n' },
		{ ...original, runId: 123 },
		{ ...original, serviceId: '' },
		{ ...original, serviceId: null },
		{ ...original, serviceId: 'x'.repeat(1025) },
		{ ...original, nonce: 'secret' },
		{ ...original, socketPath: '/tmp/console.sock' },
		{ ...original, protocol: 2 },
	])('rejects invalid payload %#', (value) => {
		expect(() => decodeDevReceipt(token(value))).toThrow(DevClientError)
		expect(() => decodeDevReceipt(token(value))).toThrow(
			expect.objectContaining({ code: 'invalid_input' }),
		)
	})

	it('rejects oversized JSON before accepting an otherwise valid locator', () => {
		const encoded = Buffer.from(`${' '.repeat(8192)}${JSON.stringify(original)}`).toString(
			'base64url',
		)
		expect(() => decodeDevReceipt(`pluxel-dev-v1.${encoded}`)).toThrow(DevClientError)
		expect(() => decodeDevReceipt(`pluxel-dev-v1.${encoded}`)).toThrow(
			expect.objectContaining({ code: 'invalid_input' }),
		)
	})

	it('applies locator validation to the producer as well as the reader', () => {
		expect(() => encodeDevReceipt({ ...original, root: 'relative' })).toThrow(
			expect.objectContaining({ code: 'invalid_input' }),
		)
	})
})
