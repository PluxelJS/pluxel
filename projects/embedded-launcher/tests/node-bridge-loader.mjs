// Node-only diagnostic adapter. This is not the native bridge or embedded acceptance evidence.
export async function resolve(specifier, context, next) {
	if (specifier === 'launcher:bridge') return { url: 'launcher:bridge', shortCircuit: true }
	return next(specifier, context)
}
export async function load(url, context, next) {
	if (url === 'launcher:bridge')
		return {
			format: 'module',
			source: `export async function request(text) { const r=JSON.parse(text); await new Promise(resolve=>setTimeout(resolve,r.params.delayMs??1)); return JSON.stringify({jsonrpc:'2.0',id:r.id,result:{text:r.params.text}}) }`,
			shortCircuit: true,
		}
	return next(url, context)
}
