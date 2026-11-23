import { rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const outdir = 'build/runtime'
const core = 'node_modules/@pluxel/core'
await rm(outdir, { recursive: true, force: true })
await build({
	entryPoints: {
		bootstrap: 'src/bootstrap.ts',
		[`${core}/index`]: fileURLToPath(import.meta.resolve('@pluxel/core')),
		[`${core}/toolchain`]: fileURLToPath(import.meta.resolve('@pluxel/core/toolchain')),
	},
	outdir,
	outExtension: { '.js': '.mjs' },
	bundle: true,
	splitting: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2022',
	external: ['node:*'],
})

// External compiled plugins resolve these bare imports to the same Core as the Host.
await writeFile(
	`${outdir}/${core}/package.json`,
	JSON.stringify({
		name: '@pluxel/core',
		type: 'module',
		main: './index.mjs',
		exports: { '.': './index.mjs', './toolchain': './toolchain.mjs' },
	}),
)
