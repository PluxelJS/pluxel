import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createPluginSemanticsPlugin } from '@pluxel/rolldown/plugins'
import { build, type Plugin } from 'vite-plus'
import { projectRoot } from './session.ts'

export const workerModule = 'market.mjs'
export const workerPath = resolve(projectRoot, 'dist/worker', workerModule)

export async function buildMarketWorker(): Promise<string> {
	const output = await build({
		configFile: false,
		root: projectRoot,
		logLevel: 'silent',
		oxc: { decorator: { legacy: true } },
		resolve: { conditions: ['workerd', 'worker', 'browser', 'module', 'production'] },
		plugins: [createPluginSemanticsPlugin({ root: projectRoot }).plugin as unknown as Plugin],
		build: {
			write: false,
			target: 'esnext',
			lib: {
				entry: resolve(projectRoot, 'src/worker.ts'),
				formats: ['es'],
				fileName: () => workerModule,
			},
			rolldownOptions: {
				external: ['cloudflare:workers'],
				output: { codeSplitting: false },
			},
		},
	})
	const bundle = Array.isArray(output) ? output[0] : output
	if (!bundle || !('output' in bundle)) throw new Error('Expected a market Worker bundle')
	const [entry, ...extra] = bundle.output.filter((chunk) => chunk.type === 'chunk')
	if (!entry?.isEntry || extra.length > 0) throw new Error('Expected one market Worker entry')
	const external = [...entry.imports, ...entry.dynamicImports]
	if (external.some((name) => name !== 'cloudflare:workers' && name !== entry.fileName))
		throw new Error(`Unexpected market Worker imports: ${external.join(', ')}`)
	return entry.code
}

if (import.meta.main) {
	const bundle = await buildMarketWorker()
	await mkdir(dirname(workerPath), { recursive: true })
	await writeFile(workerPath, bundle)
}
