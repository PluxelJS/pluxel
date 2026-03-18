import { readFile, writeFile } from 'node:fs/promises'

import { relative, resolve } from 'pathe'

import { repoRoot, runtimeFrozenEntry, runtimeEntry } from './_runtime-dist.mjs'

const { buildFrozenHost } = await import(runtimeFrozenEntry)
process.chdir(repoRoot)

const outDir = resolve(
	repoRoot,
	process.env.PLUXEL_FROZEN_OUT_DIR ?? 'packages/plugins/host/.pluxel/frozen',
)
const activeProfile = process.env.PLUXEL_RUNTIME_PROFILE ?? 'plugins-host-frozen'

const res = await buildFrozenHost({
	outDir,
	profile: activeProfile,
	plugins: [
		{
			moduleId: '@pluxel/snapshot',
			packageName: '@pluxel/snapshot',
			importPath: '@pluxel/snapshot',
			exportKey: 'SnapshotPlugin',
			source: 'installed-dist',
			enable: true,
		},
		{
			moduleId: 'pluxel-plugin-market-ui',
			packageName: 'pluxel-plugin-market-ui',
			importPath: 'pluxel-plugin-market-ui',
			exportKey: 'MarketUI',
			source: 'installed-dist',
			enable: true,
		},
	],
	enabled: ['Snapshot', 'MarketUI'],
	bootstrap: {
		controlPlane: {
			web: true,
			rpc: true,
			sse: true,
			auth: 'none',
		},
		uiAssets: 'static-built',
	},
})

const runtimeImportPath = relative(outDir, runtimeEntry)
const frozenSource = await readFile(res.entry, 'utf-8')
await writeFile(
	res.entry,
	frozenSource.replace("'@pluxel/runtime'", JSON.stringify(runtimeImportPath)),
	'utf-8',
)

console.log(`[pluxel/plugins-host] frozen host generated: ${res.entry}`)
console.log(`[pluxel/plugins-host] frozen manifest: ${res.manifestPath}`)
