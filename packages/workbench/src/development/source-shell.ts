import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import type { HostDevelopmentPluginApi } from '@pluxel/host-dev/vite'
import { attachWorkbenchSourceShell } from '../shell/mount'

/** Serve an explicit Workbench browser entry through the existing Vite server. React/CSS transforms stay application-owned. */
export function workbenchSourceShell(
	options: Readonly<{
		/** File path relative to Vite root, or an absolute file path. Required; no workspace guessing. */
		entry: string
	}>,
): Plugin<HostDevelopmentPluginApi> {
	if (!options || typeof options.entry !== 'string' || !options.entry.trim())
		throw new TypeError('[workbench] source Shell entry must be a non-empty file path')
	const entry = options.entry
	return {
		name: 'pluxel:workbench-source-shell',
		apply: 'serve',
		config(config) {
			return { optimizeDeps: { entries: [resolve(config.root ?? process.cwd(), entry)] } }
		},
		api: {
			pluxelHost: {
				async attach({ host, server }) {
					const file = resolve(server.config.root, entry)
					const entryStat = await stat(file)
					if (!entryStat.isFile())
						throw new Error(`[workbench] source Shell entry is not a file: ${file}`)
					const normalized = file.replaceAll('\\', '/')
					const path = normalized.startsWith('/') ? `/@fs${normalized}` : `/@fs/${normalized}`
					const url = encodeURI(path).replaceAll('#', '%23').replaceAll('?', '%3F')
					return attachWorkbenchSourceShell(host.ctx, url)
				},
			},
		},
	}
}
