import { build } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

const normalizeOutput = (res) => {
	if (Array.isArray(res)) return res
	if (res && typeof res === 'object' && 'output' in res) {
		return [res]
	}
	return []
}

export default async function runBundle(job) {
	const { entry, root, resolve, vendors } = job

	const result = await build({
		root,
		configFile: false,
		publicDir: false,
		plugins: [tsconfigPaths()],
		resolve,
		ssr: {
			noExternal: true,
			external: vendors,
		},
		build: {
			ssr: true,
			write: false,
			target: 'esnext',
			rollupOptions: {
				input: entry,
				external: vendors,
				output: {
					inlineDynamicImports: true,
					format: 'es',
				},
			},
		},
	})

	const outputs = normalizeOutput(result).flatMap((entry) => entry.output ?? []).filter(Boolean)
	const chunk = outputs.find((item) => item.type === 'chunk' && typeof item.code === 'string')
	if (!chunk?.code) {
		throw new Error('Failed to produce bundled code for extension entry (worker)')
	}
	return chunk.code
}
