import type { HostDocumentStorage } from '@pluxel/host'
import type { NativeTransport } from '@embedded-launcher/sdk'
export function documentStorage(
	transport: NativeTransport,
	namespace: 'config' | 'state',
): HostDocumentStorage {
	function validate(key: string) {
		if (key !== `${namespace}.json`) throw new Error(`Invalid ${namespace} document key`)
	}
	async function getText(key: string) {
		validate(key)
		const result = await transport.request('storage.read', { key: namespace })
		if (
			!result ||
			typeof result !== 'object' ||
			Array.isArray(result) ||
			(result.document !== null && typeof result.document !== 'string')
		)
			throw new TypeError('Invalid document read result')
		return typeof result.document === 'string' ? result.document : undefined
	}
	return {
		getText,
		async stat(key) {
			return (await getText(key)) === undefined ? undefined : {}
		},
		async put(key, document) {
			validate(key)
			const result = await transport.request('storage.write', { key: namespace, document })
			if (
				!result ||
				typeof result !== 'object' ||
				Array.isArray(result) ||
				result.committed !== true
			)
				throw new Error('Document not committed')
		},
	}
}
