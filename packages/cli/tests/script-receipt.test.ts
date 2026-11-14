import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ScriptExecutionError } from '@pluxel/host/agent/runtime'
import {
	decodeScriptReceipt,
	encodeScriptReceipt,
	verifyScriptReceipt,
	type ScriptReceipt,
} from '../src/script/receipt'

const prefix = 'pluxel-script-v3.'
const identity = { instanceId: 'instance_1', runId: 'run-2', requestHash: 'a'.repeat(64) }
const local: ScriptReceipt = {
	version: 3,
	connection: { kind: 'local', root: resolve('/workspace/应用'), serviceId: 'workspace/app' },
	...identity,
}
const remote: ScriptReceipt = {
	version: 3,
	connection: { kind: 'remote', endpoint: 'https://host.test/' },
	...identity,
}
const token = (value: unknown) => prefix + Buffer.from(JSON.stringify(value)).toString('base64url')

describe('original-owner script receipts', () => {
	it.each([local, remote])(
		'pins the original owner and request for $connection.kind',
		(receipt) => {
			const encoded = encodeScriptReceipt(receipt)
			expect(decodeScriptReceipt(encoded)).toEqual(receipt)
			expect(decodeScriptReceipt(encoded).instanceId).not.toBe('replacement')
			verifyScriptReceipt(identity, receipt)
			for (const mismatch of [
				{ instanceId: 'replacement' },
				{ runId: 'another-run' },
				{ requestHash: 'b'.repeat(64) },
			])
				expect(() => verifyScriptReceipt({ ...identity, ...mismatch }, receipt)).toThrow(
					expect.objectContaining({ code: 'receipt_mismatch' }),
				)
		},
	)
	it('retains custom remote owner identifiers under the remote contract', () => {
		const receipt = { ...remote, instanceId: 'region:application/worker' }
		expect(decodeScriptReceipt(encodeScriptReceipt(receipt))).toEqual(receipt)
	})
	it('omits discovery and authentication secrets at the producer', () => {
		const discovery = {
			...local,
			nonce: 'secret-nonce',
			connection: {
				...local.connection,
				socketPath: '/private/console.sock',
				nonce: 'private-nonce',
			},
		}
		const encoded = encodeScriptReceipt(discovery)
		const json = Buffer.from(encoded.split('.')[1]!, 'base64url').toString('utf8')
		expect(JSON.parse(json)).toEqual(local)
		expect(json).not.toMatch(/nonce|socket/)
		expect(
			decodeScriptReceipt(
				encodeScriptReceipt({
					...local,
					connection: {
						kind: 'local',
						root: local.connection.kind === 'local' ? local.connection.root : '',
					},
				}),
			),
		).toEqual({
			...local,
			connection: {
				kind: 'local',
				root: local.connection.kind === 'local' ? local.connection.root : '',
			},
		})
	})
	it.each([
		'',
		'run-2',
		'ps2.e30',
		'pluxel-dev-v2.e30',
		'pluxel-script-v2.e30',
		prefix,
		prefix + 'e30=',
		prefix + 'e31',
		prefix + '%%% ',
		prefix + '_w',
		prefix + Buffer.from('{').toString('base64url'),
		prefix + 'a'.repeat(16 * 1024),
	])('rejects malformed or replaced protocols %#', (value) => {
		expect(() => decodeScriptReceipt(value)).toThrow(
			expect.objectContaining({ code: 'invalid_receipt' }),
		)
	})
	it.each([
		null,
		[],
		{},
		{ ...local, version: 2 },
		{ ...local, nonce: 'secret' },
		{ ...local, instanceId: '' },
		{ ...local, instanceId: 'a'.repeat(129) },
		{ ...local, runId: '../run' },
		{ ...local, runId: 'run\n' },
		{ ...local, runId: 123 },
		{ ...local, requestHash: undefined },
		{ ...local, requestHash: 'not-a-hash' },
		...[
			{ kind: 'local', root: 'relative' },
			{ kind: 'local', root: '/bad\0root' },
			{ kind: 'local', root: '/' + '界'.repeat(1366) },
			{ kind: 'local', root: '/ok', serviceId: '' },
			{ kind: 'local', root: '/ok', serviceId: null },
			{ kind: 'local', root: '/ok', serviceId: 'x'.repeat(1025) },
			{ kind: 'local', root: '/ok', nonce: 'secret' },
			{ kind: 'local', root: '/ok', endpoint: 'https://host.test/' },
			{ kind: 'remote', endpoint: 'https://secret:password@host.test/' },
			{ kind: 'remote', endpoint: 'https://host.test/another-route' },
			{ kind: 'remote', endpoint: 'https://host.test/?token=secret' },
			{ kind: 'remote', endpoint: 'https://host.test/#secret' },
			{ kind: 'remote', endpoint: 'file:///host' },
			{ kind: 'remote', endpoint: 'https://host.test/', root: '/workspace' },
			{ kind: 'remote', endpoint: 'https://host.test/', serviceId: 'service' },
			{ kind: 'other', root: '/workspace' },
		].map((connection) => Object.assign({}, local, { connection })),
	])('rejects invalid locator payload %#', (value) => {
		expect(() => decodeScriptReceipt(token(value))).toThrow(
			expect.objectContaining({ code: 'invalid_receipt' }),
		)
	})
	it('requires canonical JSON as well as canonical base64 and strict UTF-8', () => {
		const noncanonical = prefix + Buffer.from(JSON.stringify(local, null, 2)).toString('base64url')
		for (const encoded of [
			noncanonical,
			prefix + Buffer.from(' '.repeat(8192) + JSON.stringify(local)).toString('base64url'),
			token({ ...local, connection: { kind: 'local', root: '/bad\ud800' } }),
		])
			expect(() => decodeScriptReceipt(encoded)).toThrow(
				expect.objectContaining({ code: 'invalid_receipt' }),
			)
	})
	it('validates the producer before submission', () => {
		expect(() =>
			encodeScriptReceipt({ ...local, connection: { kind: 'local', root: 'relative' } }),
		).toThrow(ScriptExecutionError)
		expect(() =>
			encodeScriptReceipt({
				...remote,
				connection: { kind: 'remote', endpoint: 'https://secret:password@host.test/' },
			}),
		).toThrow(expect.objectContaining({ code: 'invalid_receipt' }))
	})
})
