import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

/** Bundle the CDN-first SDK locally, including both module workers. Fail on upstream drift. */
export function offlineMonaco(): Plugin {
	return {
		name: 'studio-offline-monaco',
		enforce: 'pre',
		resolveId(source, importer) {
			if (source === 'typescript' && importer?.includes('/modern-monaco/dist/lsp/typescript/')) {
				return this.resolve('typescript-legacy', fileURLToPath(import.meta.url))
			}
			return undefined
		},
		transform(code, id) {
			// Vite serve adds ?v= dependency hashes; workers also carry query suffixes.
			const file = id.split('?')[0]!.replaceAll('\\', '/')
			if (file.endsWith('/modern-monaco/dist/core.mjs')) {
				const loadCore = /import\(\s*\/\* webpackIgnore: true \*\/\s*editorCoreModuleUrl\s*\)/
				if (!loadCore.test(code)) throw new Error('Modern Monaco core loader changed')
				return code.replace(loadCore, 'import("./editor-core.mjs")')
			}
			if (file.endsWith('/modern-monaco/dist/editor-core.mjs')) {
				const factory = /function createEditorWorkerMain\(\) \{[\s\S]*?\n\}\nexport/
				if (!factory.test(code)) throw new Error('Modern Monaco editor worker factory changed')
				// Monaco 0.55.1 drops these Delayer promises. Disposing an editor within
				// 50 ms of moving its cursor rejects them with CancellationError. Use
				// Monaco's own error handler at these three call sites; real errors still surface.
				const highlightTask = /this\.runDelayer\.trigger\(\(\) => \{[\s\S]*?\n\s*\}\);/g
				const tasks = [...code.matchAll(highlightTask)]
				if (tasks.length !== 3) throw new Error('Modern Monaco word highlight scheduler changed')
				const ownedTasks = code.replaceAll(
					highlightTask,
					(task) => task.slice(0, -1) + '.catch(onUnexpectedError);',
				)
				return ownedTasks.replace(
					factory,
					`function createEditorWorkerMain() {
          return new Worker(new URL("./editor-worker-main.mjs", import.meta.url), { type: "module", name: "editor-worker-main" });
        }
export`,
				)
			}
			if (!file.endsWith('/modern-monaco/dist/lsp/typescript/setup.mjs')) return undefined
			const factory = /function createWebWorker\(\) \{[\s\S]*?\n\}\nfunction getWorker/
			if (!factory.test(code)) throw new Error('Modern Monaco TypeScript worker factory changed')
			// The app's secure local protocol has fetch support; upstream only recognizes HTTP here.
			const localTypes = code.replace(
				'/^https?:\\/\\//.test(type)',
				'/^(?:https?|studio):\\/\\//.test(type)',
			)
			if (localTypes === code) throw new Error('Modern Monaco declaration URL loader changed')
			return localTypes.replace(
				factory,
				`function createWebWorker() {
        return new Worker(new URL("./worker.mjs", import.meta.url), { type: "module", name: "typescript-worker" });
      }
function getWorker`,
			)
		},
	}
}
