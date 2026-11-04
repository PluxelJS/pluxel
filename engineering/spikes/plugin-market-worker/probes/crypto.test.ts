import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { Miniflare } from 'miniflare'
import { expect, it } from 'vitest'

it('matches Node ECDSA verification when the digest argument is omitted', async () => {
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
	const data = Buffer.from('Sigstore compatibility probe')
	const signature = sign('sha256', data, privateKey)
	expect(verify(undefined, data, publicKey, signature)).toBe(true)
	const script = `
		import { createPublicKey, verify } from 'node:crypto';
		import { Buffer } from 'node:buffer';
		export default { async fetch(request) {
			const input = await request.json();
			const key = createPublicKey(input.key);
			const data = Buffer.from(input.data, 'base64');
			const signature = Buffer.from(input.signature, 'base64');
			const results = { explicit: verify('sha256', data, key, signature) };
			try { results.implicit = verify(undefined, data, key, signature); }
			catch (error) { results.implicit = error.message; }
			return Response.json(results);
		} };
	`
	const runtime = new Miniflare({
		host: '127.0.0.1',
		port: 0,
		workers: [
			{
				config: {
					name: 'crypto-probe',
					compatibilityDate: '2026-11-03',
					compatibilityFlags: ['nodejs_compat'],
					manifest: {
						mainModule: 'worker.mjs',
						modules: { 'worker.mjs': { type: 'esm', contents: script } },
					},
				},
			},
		],
	})
	try {
		const response = await runtime.dispatchFetch('http://probe/', {
			method: 'POST',
			body: JSON.stringify({
				key: publicKey.export({ type: 'spki', format: 'pem' }),
				data: data.toString('base64'),
				signature: signature.toString('base64'),
			}),
		})
		const result = await response.json()
		expect(result, JSON.stringify(result)).toEqual({ explicit: true, implicit: true })
	} finally {
		await runtime.dispose()
	}
})
