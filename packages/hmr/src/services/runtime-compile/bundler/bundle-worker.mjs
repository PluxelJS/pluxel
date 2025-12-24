import { build } from 'vite'

const normalizeOutput = (res) => {
	if (Array.isArray(res)) return res
	if (res && typeof res === 'object' && 'output' in res) {
		return [res]
	}
	return []
}

export default async function runBundle(job) {
	const { entry, root, resolve } = job
	const external = job.vendors ?? job.external ?? []

	const result = await build({
		root,
		configFile: false,
		publicDir: false,
		logLevel: 'error',
		resolve: {
			tsconfigPaths: true,
			...(resolve ?? {}),
		},
		build: {
			write: false,
			target: 'esnext',
			// 用 lib 模式确保输出保留 ESM exports（我们需要 dynamic import 拿到 default）
			lib: {
				entry,
				formats: ['es'],
				fileName: () => 'index',
			},
			rollupOptions: {
				external,
				output: {
					inlineDynamicImports: true,
					format: 'es',
				},
			},
		},
	})

	const outputs = normalizeOutput(result)
		.flatMap((entry) => entry.output ?? [])
		.filter(Boolean)
	const chunk =
		outputs.find(
			(item) => item.type === 'chunk' && item.isEntry && typeof item.code === 'string',
		) ?? outputs.find((item) => item.type === 'chunk' && typeof item.code === 'string')
	if (!chunk?.code) {
		throw new Error('Failed to produce bundled code (worker)')
	}
	return chunk.code
}
