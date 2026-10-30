import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { build } from 'vite'
import { createPluginSemanticsPlugin } from '@pluxel/rolldown/plugins'
import { it } from 'vitest'

const run = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, '../..')
const workspace = resolve(packageRoot, '../../..')
const fixtureRoot = import.meta.dirname
const rootRequire = createRequire(join(workspace, 'package.json'))
const packageRequire = createRequire(join(packageRoot, 'package.json'))
function importGuard(packages: string[]): string {
	return `import { registerHooks } from 'node:module'; const forbidden=${JSON.stringify(packages)}; const hooks=registerHooks({resolve(name,context,next){if(forbidden.some(prefix=>name===prefix||name.startsWith(prefix+'/')))throw new Error('Optional dependency leaked: '+name+' from '+context.parentURL);return next(name,context)}});`
}

async function manifest(path: string): Promise<Record<string, any>> {
	return JSON.parse(await readFile(path, 'utf8'))
}

function packageManifest(name: string, from = packageRequire): string {
	try {
		return from.resolve(`${name}/package.json`)
	} catch {
		let current = dirname(from.resolve(name === '@tiptap/pm' ? '@tiptap/pm/model' : name))
		while (current !== dirname(current)) {
			try {
				return createRequire(join(current, 'package.json')).resolve('./package.json')
			} catch {
				current = dirname(current)
			}
		}
		throw new Error(`Cannot locate installed metadata for ${name}`)
	}
}

async function installedSpec(name: string): Promise<string> {
	const value = await manifest(packageManifest(name))
	return value.name === name ? value.version : `npm:${value.name}@${value.version}`
}

async function command(file: string, args: string[], cwd: string, log: string[]): Promise<string> {
	console.info('Consumer command:', file, args.join(' '))
	try {
		const env = { ...process.env }
		delete env.NODE_PATH
		delete env.NODE_OPTIONS
		const result = await run(file, args, {
			cwd,
			env,
			maxBuffer: 16 * 1024 * 1024,
			timeout: 240_000,
		})
		log.push(`$ ${file} ${args.join(' ')}\n${result.stdout}${result.stderr}`)
		return result.stdout
	} catch (cause) {
		const failure = cause as Error & { stdout?: string; stderr?: string }
		const details = [String(cause), failure.stdout, failure.stderr].filter(Boolean).join('\n')
		log.push(`$ ${file} ${args.join(' ')}\n${details}`)
		throw new Error(details, { cause })
	}
}

it('consumes isolated built source, editor, browser and native artifacts', async () => {
	const output = process.env.PLUXEL_TYPST_CONSUMER_OUTPUT
		? resolve(process.env.PLUXEL_TYPST_CONSUMER_OUTPUT)
		: await mkdtemp(join(tmpdir(), 'pluxel-typst-consumer-'))
	const app = join(output, 'app')
	const nativeChecker = join(output, 'native-checker')
	const artifacts = join(output, 'artifacts')
	const evidence = join(output, 'evidence')
	console.info('Typst independent consumer output:', output)
	await Promise.all([
		mkdir(app, { recursive: true }),
		mkdir(nativeChecker, { recursive: true }),
		mkdir(artifacts, { recursive: true }),
		mkdir(evidence, { recursive: true }),
	])
	const log: string[] = []
	const stages: string[] = []
	const parseYaml = rootRequire('yaml').parse as (source: string) => {
		catalogs: Record<string, Record<string, string>>
	}
	const { catalogs } = parseYaml(await readFile(join(workspace, 'pnpm-workspace.yaml'), 'utf8'))
	const localPaths = [
		['@pluxel/core', 'packages/core'],
		['@pluxel/host', 'packages/host'],
		['@pluxel/services', 'packages/services'],
		['@pluxel/commands', 'packages/commands'],
		['valibot-form', 'packages/valibot-form'],
		['@pluxel/plugin-fonts', 'plugins/render/fonts'],
		['@pluxel/plugin-typst', 'plugins/render/typst'],
		['@pluxel/workbench', 'packages/workbench'],
	] as const
	const staged = new Map<string, string>(
		localPaths.map(([name]) => [name, join(artifacts, name.replaceAll('/', '__'))]),
	)
	for (const [name, path] of localPaths) {
		const source = join(workspace, path)
		const destination = staged.get(name)!
		const value = await manifest(join(source, 'package.json'))
		await mkdir(destination, { recursive: true })
		await cp(join(source, 'dist'), join(destination, 'dist'), {
			recursive: true,
			dereference: true,
		})
		if (name === '@pluxel/plugin-typst') {
			await mkdir(join(destination, 'native'))
			await cp(join(source, 'native/compiler.node'), join(destination, 'native/compiler.node'))
		}
		// Publish-time protocol expansion only. The built JS/declarations/native bytes stay exact.
		for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
			for (const [dependency, spec] of Object.entries(value[field] ?? {}) as [string, string][]) {
				if (staged.has(dependency) && field !== 'peerDependencies')
					value[field][dependency] = `file:${staged.get(dependency)}`
				else if (spec.startsWith('catalog:'))
					value[field][dependency] = catalogs[spec.slice(8) || 'default']![dependency]!
				else if (spec.startsWith('workspace:')) {
					const dependencyManifest = await manifest(
						join(
							workspace,
							localPaths.find(([candidate]) => candidate === dependency)?.[1] ??
								`packages/${dependency.split('/').at(-1)}`,
							'package.json',
						),
					)
					value[field][dependency] = dependencyManifest.version ?? '*'
				}
			}
		}
		if (value.publishConfig?.exports) value.exports = value.publishConfig.exports
		if (value.publishConfig?.imports) value.imports = value.publishConfig.imports
		delete value.devDependencies
		delete value.scripts
		await writeFile(join(destination, 'package.json'), JSON.stringify(value, null, 2))
	}
	const dependencies: Record<string, string> = {
		'@pluxel/plugin-typst': `file:${staged.get('@pluxel/plugin-typst')}`,
		valibot: await installedSpec('valibot'),
	}
	const nodeTypes = await manifest(rootRequire.resolve('@types/node/package.json'))
	const devDependencies: Record<string, string> = {
		typescript: await installedSpec('typescript'),
		vite: await installedSpec('vite'),
		'@types/node': nodeTypes.version,
	}
	async function install(directory = app, packages = dependencies) {
		await writeFile(
			join(directory, 'package.json'),
			JSON.stringify(
				{
					name: 'typst-independent-consumer',
					private: true,
					type: 'module',
					scripts: { build: 'vite build', typecheck: 'tsc --noEmit' },
					dependencies: packages,
					devDependencies,
				},
				null,
				2,
			),
		)
		await command(
			'npm',
			[
				'install',
				'--ignore-scripts',
				'--legacy-peer-deps',
				'--install-links',
				'--package-lock=false',
				'--no-audit',
				'--no-fund',
			],
			directory,
			log,
		)
	}
	async function checkTypes(files: string[], browser = false, directory = app) {
		await writeFile(
			join(directory, 'tsconfig.json'),
			JSON.stringify(
				{
					compilerOptions: {
						target: 'ES2023',
						module: browser ? 'ESNext' : 'NodeNext',
						moduleResolution: browser ? 'Bundler' : 'NodeNext',
						lib: ['ES2024', 'DOM', 'DOM.Iterable', 'ESNext.Disposable'],
						types: ['node', ...(browser ? ['vite/client'] : [])],
						strict: true,
						experimentalDecorators: true,
						skipLibCheck: false,
						noEmit: true,
						jsx: 'react-jsx',
						allowJs: true,
						checkJs: false,
					},
					files,
				},
				null,
				2,
			),
		)
		await command(
			process.execPath,
			[join(directory, 'node_modules/typescript/bin/tsc'), '--noEmit', '--pretty', 'false'],
			directory,
			log,
		)
	}
	async function absent(names: string[], directory = app) {
		// An independent Node process avoids the test host's package-resolution hooks.
		await writeFile(
			join(directory, 'absent.mjs'),
			`import assert from 'node:assert/strict'; import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); for(const name of ${JSON.stringify(names)}) assert.throws(()=>require.resolve(name), name+' must not be installed');`,
		)
		await command(process.execPath, ['absent.mjs'], directory, log)
	}
	async function consumerBuild(input: string, outDir: string) {
		const modules: string[] = []
		await build({
			configFile: false,
			root: app,
			logLevel: 'error',
			build: { outDir, emptyOutDir: true, rollupOptions: { input: join(app, input) } },
			plugins: [
				{
					name: 'consumer-module-evidence',
					generateBundle(_options, bundle) {
						for (const chunk of Object.values(bundle))
							if (chunk.type === 'chunk') modules.push(...Object.keys(chunk.modules))
					},
				},
			],
		})
		for (const id of modules) {
			assert.ok(!id.startsWith(workspace), `Consumer resolved a workspace source: ${id}`)
			assert.ok(
				!/(?:@pluxel\/(?:core|services|workbench)|monaco|electron|typst-ts-node-compiler|node:)/i.test(
					id,
				),
				`Forbidden browser module: ${id}`,
			)
		}
		await writeFile(
			join(evidence, `${outDir}-modules.json`),
			JSON.stringify([...new Set(modules)], null, 2),
		)
	}

	const nativeDependencies = Object.fromEntries(
		[...staged].map(([name, path]) => [name, `file:${path}`]),
	)
	nativeDependencies.capnweb = catalogs.prod!.capnweb!
	await install(nativeChecker, nativeDependencies)
	await absent(
		[
			'@tiptap/core',
			'@tiptap/extension-text-style',
			'@tiptap/extension-text-align',
			'@tiptap/react',
			'react',
			'react-dom',
			'modern-monaco',
			'electron',
		],
		nativeChecker,
	)
	await writeFile(
		join(nativeChecker, 'root-check.mts'),
		"import { TypstPlugin, type TypstSession } from '@pluxel/plugin-typst'; const open: typeof TypstPlugin.prototype.open = ({} as TypstPlugin).open; let session: TypstSession | undefined; void [open,session];",
	)
	await checkTypes(['root-check.mts'], false, nativeChecker)
	await writeFile(
		join(nativeChecker, 'root.mjs'),
		`${importGuard(['@tiptap', 'react', 'react-dom', 'modern-monaco', 'electron'])} await import('@pluxel/plugin-typst'); hooks.deregister();`,
	)
	await command(process.execPath, ['root.mjs'], nativeChecker, log)
	stages.push(
		'Native checker: existing server peers, root strict declarations and import without Tiptap/React',
	)

	await install()
	await absent([
		'@tiptap/core',
		'@tiptap/extension-text-style',
		'@tiptap/extension-text-align',
		'@tiptap/react',
		'react',
		'react-dom',
		'modern-monaco',
		'@pluxel/workbench',
		'electron',
	])
	await writeFile(
		join(app, 'base-check.mts'),
		`import { defineTypstDocument } from '@pluxel/plugin-typst/template'; import { TypstPreviewView, pointAtSource, type SourcePosition, type TypstDiagnostic } from '@pluxel/plugin-typst/browser'; import * as v from 'valibot'; const document = defineTypstDocument({ template: 'main.typ', schema: v.object({ name: v.string() }) }); const position: SourcePosition = { path: 'main.typ', line: 1, column: 1 }; const diagnostic: TypstDiagnostic = { severity: 'error', message: 'example', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }; void [document, TypstPreviewView, pointAtSource([], position, 1), diagnostic];`,
	)
	await checkTypes(['base-check.mts'])
	await writeFile(
		join(app, 'base.mjs'),
		`${importGuard(['@tiptap', 'react', 'react-dom', 'modern-monaco', '@pluxel/workbench', 'electron'])} await import('@pluxel/plugin-typst/template'); await import('@pluxel/plugin-typst/browser'); hooks.deregister();`,
	)
	await command(process.execPath, ['base.mjs'], app, log)
	await writeFile(
		join(app, 'base-browser.ts'),
		`import { TypstPreviewView, pointAtSource } from '@pluxel/plugin-typst/browser'; import { defineTypstDocument } from '@pluxel/plugin-typst/template'; document.body.textContent = [typeof TypstPreviewView, typeof pointAtSource, typeof defineTypstDocument].join(',');`,
	)
	await writeFile(
		join(app, 'base.html'),
		'<body><script type="module" src="/base-browser.ts"></script></body>',
	)
	await consumerBuild('base.html', 'base-dist')
	stages.push(
		'Browser app without Tiptap/React or native server peers: template/browser strict types, imports and production browser build',
	)

	await cp(join(fixtureRoot, 'acceptance-project'), join(app, 'project'), { recursive: true })
	await writeFile(
		join(app, 'source.mjs'),
		`
 import assert from 'node:assert/strict'; import {readFile,readdir,writeFile} from 'node:fs/promises'; import {join} from 'node:path'; import {createRequire} from 'node:module';
 ${importGuard(['@tiptap', 'react', 'react-dom', 'modern-monaco', 'electron'])}
 const {createTypstSourceProject}=await import('@pluxel/plugin-typst/source');
 const {createTypstSourceProject:createBrowser}=await import('@pluxel/plugin-typst/source/browser');
 const {createTypstSourceLibrary}=await import('@pluxel/plugin-typst/source/library');
 const files=await createTypstSourceLibrary();
 async function read(path=''){for(const entry of await readdir(join('project',path),{withFileTypes:true})){if(entry.name.startsWith('.'))continue; const key=path?path+'/'+entry.name:entry.name;if(entry.isDirectory())await read(key);else files[key]=await readFile(join('project',key),'utf8')}}
 await read();
 const project=createTypstSourceProject({files});
 const bytes=await readFile(createRequire(import.meta.url).resolve('@pluxel/plugin-typst/source/parser.wasm'));
 assert.ok(bytes.byteLength>100000,'Parser WASM is present in the copied artifact');
 const browser=await createBrowser({files,parserWasm:bytes});
 for(const path of ['sections/analysis.typ','sections/actions.typ']){
  assert.deepEqual(project.open(path).document,browser.open(path).document);
  assert.equal(project.edit({projection:project.open(path),document:project.open(path).document}).ok,true);
 }
 assert.deepEqual({...project.snapshot().files},files);
 assert.equal(project.diagnostics().some(issue=>issue.severity==='error'),false,JSON.stringify(project.diagnostics()));
 await writeFile('files.json',JSON.stringify(project.snapshot().files));
 console.log(JSON.stringify({nodeWebParity:true,parserBytes:bytes.byteLength,fileCount:Object.keys(files).length}));
 hooks.deregister();
 `,
	)
	const parser = JSON.parse(await command(process.execPath, ['source.mjs'], app, log))
	stages.push(
		'Source Node and Web parser run without Tiptap/React; WASM copied asset resolves; projections match and no-op retains every source byte',
	)

	const pluginManifest = await manifest(join(packageRoot, 'package.json'))
	for (const name of Object.keys(pluginManifest.peerDependencies).filter(
		(dependency) =>
			dependency.startsWith('@tiptap/') &&
			!['@tiptap/react', '@tiptap/extension-drag-handle-react', '@tiptap/extensions'].includes(
				dependency,
			),
	))
		dependencies[name] = await installedSpec(name)
	dependencies.katex = await installedSpec('katex')
	await install()
	await absent([
		'@tiptap/react',
		'react',
		'react-dom',
		'modern-monaco',
		'@pluxel/workbench',
		'electron',
	])
	await writeFile(
		join(app, 'source-check.mts'),
		`
 import {createTypstSourceProject, type TypstSourceProject} from '@pluxel/plugin-typst/source';
 import {createTypstSourceProject as browserProject} from '@pluxel/plugin-typst/source/browser';
 import {createTypstSourceLibrary} from '@pluxel/plugin-typst/source/library';
 import {createTypstSourceEditor,TypstTableStyle} from '@pluxel/plugin-typst/tiptap';
 const project:TypstSourceProject=createTypstSourceProject({files:{'main.typ':'正文'}});
 const editor=createTypstSourceEditor({project,path:'main.typ',extensions:[TypstTableStyle]});
 editor.chain().setFontFamily('Noto Serif CJK SC').setFontSize('18pt').setColor('#dc2626').setBackgroundColor('#fef08a').setTextAlign('center');
 void [browserProject,createTypstSourceLibrary]; editor.destroy();
 `,
	)
	await checkTypes(['source-check.mts'])
	await writeFile(
		join(app, 'node-without-dom.mjs'),
		`
 import assert from 'node:assert/strict'; import {readFile,writeFile} from 'node:fs/promises';
 ${importGuard(['react', 'react-dom', '@tiptap/react'])}
 const {createTypstSourceProject}=await import('@pluxel/plugin-typst/source');
 const {createTypstSourceEditor}=await import('@pluxel/plugin-typst/tiptap');
 assert.equal(typeof document,'undefined');
 const files=JSON.parse(await readFile('files.json','utf8'));
 const project=createTypstSourceProject({files});
 const editor=createTypstSourceEditor({project,path:'sections/analysis.typ'});
 let at;editor.state.doc.descendants((node,position)=>{if(node.isText&&node.text.includes('初始中文正文'))at=position+node.text.indexOf('初始中文正文')});
 assert.equal(typeof at,'number');
 assert.equal(editor.commands.insertContentAt({from:at,to:at+6},{type:'text',text:'人工核对中文正文'}),true);
 const edited=project.snapshot();
 assert.equal(edited.files['sections/analysis.typ'],files['sections/analysis.typ'].replace('初始中文正文','人工核对中文正文'));
 const stale=project.open('sections/actions.typ');
 assert.equal(project.renameLabel({baseRevision:project.revision,from:'fig:revenue',to:'fig:income'}).ok,true);
 assert.match(project.snapshot().files['sections/actions.typ'],/@fig:income/);
 assert.equal(project.edit({projection:stale,document:stale.document}).ok,false);
 assert.equal(project.undo().ok,true);assert.deepEqual(project.snapshot().files,edited.files);
 assert.equal(project.redo().ok,true);
 const saved=project.snapshot().files;
 const reopened=createTypstSourceProject({files:saved});
 assert.deepEqual(reopened.open('sections/analysis.typ').document,project.open('sections/analysis.typ').document);
 await writeFile('edited-files.json',JSON.stringify(saved));
 editor.destroy();hooks.deregister();
 `,
	)
	await command(process.execPath, ['node-without-dom.mjs'], app, log)
	stages.push(
		'Real headless Editor changes only the intended Chinese source span; cross-file label rename, stale rejection, undo/redo and reopen use public source APIs',
	)

	for (const name of [
		'@tiptap/react',
		'@tiptap/extensions',
		'@tiptap/extension-drag-handle-react',
		'@tiptap/extension-drag-handle',
		'@tiptap/extension-node-range',
		'@tiptap/extension-collaboration',
		'@tiptap/y-tiptap',
		'yjs',
		'y-protocols',
		'react',
		'react-dom',
	])
		dependencies[name] = await installedSpec(name)
	for (const name of ['@types/react', '@types/react-dom'])
		devDependencies[name] = await installedSpec(name)
	await install()
	await absent(['modern-monaco', 'monaco-editor', '@pluxel/workbench', 'electron'])
	await cp(join(fixtureRoot, 'acceptance-react.tsx'), join(app, 'main.tsx'))
	await mkdir(join(app, 'public'), { recursive: true })
	await cp(join(app, 'edited-files.json'), join(app, 'public/files.json'))
	await writeFile(
		join(app, 'index.html'),
		'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/main.tsx"></script></body></html>',
	)
	const editorDocs = await readFile(
		join(workspace, 'docs/plugins/rendering/typst-editor.md'),
		'utf8',
	)
	const reactExample = editorDocs.match(/```tsx(?: no-twoslash)?\n([\s\S]*?)```/)?.[1]
	assert.ok(reactExample, 'Public source editor guide must contain a complete React example')
	await writeFile(join(app, 'react-example.tsx'), reactExample)
	await checkTypes(['main.tsx', 'react-example.tsx'], true)
	await consumerBuild('index.html', 'dist')
	const installedRoot = await realpath(join(app, 'node_modules/@pluxel/plugin-typst'))
	assert.ok(!installedRoot.startsWith(workspace))
	const installedFiles = await readdir(installedRoot)
	assert.ok(!installedFiles.includes('src'))
	stages.push(
		'Public React example strict-checks; actual copied source editor, stylesheet and parser asset build without workspace source or native browser modules',
	)

	const browser = await chromium.connect(
		process.env.PLAYWRIGHT_WS_ENDPOINT ?? 'ws://127.0.0.1:3000',
		{ timeout: 5000 },
	)
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
	const page = await context.newPage(),
		browserErrors: string[] = []
	page.on('pageerror', (error) => browserErrors.push(String(error)))
	const mime: Record<string, string> = {
		'.html': 'text/html',
		'.js': 'application/javascript',
		'.css': 'text/css',
		'.json': 'application/json',
		'.wasm': 'application/wasm',
	}
	await page.route('https://typst-artifact.test/**', async (route) => {
		const path = new URL(route.request().url()).pathname
		const absolute = resolve(app, 'dist', '.' + (path === '/' ? '/index.html' : path))
		if (!absolute.startsWith(resolve(app, 'dist') + '/')) return route.abort()
		try {
			await route.fulfill({
				status: 200,
				contentType: mime[extname(absolute)] ?? 'application/octet-stream',
				body: await readFile(absolute),
			})
		} catch {
			await route.fulfill({ status: 404, body: 'Missing artifact' })
		}
	})
	let browserFiles: Record<string, string>
	try {
		await page.goto('https://typst-artifact.test/')
		const editor = page.locator('.tiptap')
		await editor.waitFor()
		await editor.evaluate((element) => {
			const instance = (element as any).editor
			let at: number | undefined
			instance.state.doc.descendants((node: any, position: number) => {
				if (node.isText && node.text.includes('人工核对中文正文'))
					at = position + node.text.indexOf('人工核对中文正文')
			})
			if (at === undefined) throw new Error('Expected authored text is missing')
			instance.commands.setTextSelection({ from: at, to: at + 8 })
			instance.view.focus()
		})
		await page.keyboard.insertText('浏览器核对中文正文')
		await page.waitForFunction(() =>
			window.acceptance.project
				.snapshot()
				.files['sections/analysis.typ']?.toString()
				.includes('浏览器核对中文正文'),
		)
		await page.getByRole('button', { name: '保存源码', exact: true }).click()
		browserFiles = await page.evaluate(() => JSON.parse(localStorage.getItem('acceptance-files')!))
		const headless = JSON.parse(await readFile(join(app, 'edited-files.json'), 'utf8'))
		assert.equal(
			browserFiles!['sections/analysis.typ'],
			headless['sections/analysis.typ'].replace('人工核对中文正文', '浏览器核对中文正文'),
		)
		await editor.press('ControlOrMeta+Z')
		await page.waitForFunction(
			() =>
				!window.acceptance.project
					.snapshot()
					.files['sections/analysis.typ']?.toString()
					.includes('浏览器核对中文正文'),
		)
		await page.getByRole('button', { name: '重开源码', exact: true }).click()
		await page.waitForFunction(() =>
			window.acceptance.project
				.snapshot()
				.files['sections/analysis.typ']?.toString()
				.includes('浏览器核对中文正文'),
		)
		await page.getByRole('button', { name: '行动', exact: true }).click()
		await page.waitForFunction(() =>
			document.querySelector('.tiptap')?.textContent?.includes('行动核对'),
		)
		assert.match((await editor.textContent()) ?? '', /@fig:income/)
		const atAction = async () =>
			editor.evaluate((element) => {
				const instance = (element as any).editor
				let at: number | undefined
				instance.state.doc.descendants((node: any, position: number) => {
					if (node.isText && node.text.includes('完整的行动说明')) at = position + node.text.length
				})
				if (at === undefined) throw new Error('Expected action paragraph')
				instance.commands.setTextSelection(at)
				instance.view.focus()
			})
		const insert = async (title: string) => {
			await atAction()
			await page.getByRole('button', { name: '插入', exact: true }).click()
			await page.getByRole('searchbox', { name: '搜索插入内容' }).fill(title)
			await page.getByRole('option', { name: title, exact: true }).click()
		}
		await insert('验收指标卡 · data/sales.json')
		const component = page.locator('.typst-component')
		await component.waitFor()
		const beforeParameters = await page.evaluate(
			() => window.acceptance.project.snapshot().files['sections/actions.typ'],
		)
		await component.getByRole('button', { name: '编辑参数', exact: true }).click()
		await component.getByRole('textbox', { name: '指标标题', exact: true }).fill('浏览器插入指标')
		await component.getByRole('button', { name: '应用参数', exact: true }).click()
		await page.waitForFunction(() =>
			window.acceptance.project
				.snapshot()
				.files['sections/actions.typ']?.toString()
				.includes('title: "浏览器插入指标"'),
		)
		await editor.press('ControlOrMeta+Z')
		assert.equal(
			await page.evaluate(() => window.acceptance.project.snapshot().files['sections/actions.typ']),
			beforeParameters,
		)
		await editor.press('ControlOrMeta+Shift+Z')
		await insert('data/sales.json · total')
		const field = page.locator('.typst-source-field')
		await field.waitFor()
		assert.match((await field.textContent()) ?? '', /120/)
		await field.getByRole('button').click()
		await field.getByRole('textbox', { name: 'JSON data/sales.json', exact: true }).fill('180')
		await field.getByRole('button', { name: '保存 JSON', exact: true }).click()
		await page.waitForFunction(
			() =>
				JSON.parse(window.acceptance.project.snapshot().files['data/sales.json'] as string)
					.total === 180,
		)
		assert.match((await field.textContent()) ?? '', /180/)
		await editor.press('ControlOrMeta+Z')
		await page.waitForFunction(
			() =>
				JSON.parse(window.acceptance.project.snapshot().files['data/sales.json'] as string)
					.total === 120,
		)
		await page.getByRole('button', { name: '保存源码', exact: true }).click()
		browserFiles = await page.evaluate(() => JSON.parse(localStorage.getItem('acceptance-files')!))
		await page.getByRole('button', { name: '重开源码', exact: true }).click()
		assert.equal(await page.locator('.typst-component').count(), 1)
		assert.equal(await page.locator('.typst-source-field').count(), 1)
		assert.match(browserFiles!['sections/actions.typ']!, /title: "浏览器插入指标"/)
		await page.reload()
		await editor.waitFor()
		await page.getByRole('button', { name: '行动', exact: true }).click()
		await page.locator('.typst-component').waitFor()
		assert.equal(await page.locator('.typst-source-field').count(), 1)
		const clipboardKinds = new Set<string>()
		for (const [label, path] of [
			['分析', 'sections/analysis.typ'],
			['行动', 'sections/actions.typ'],
		]) {
			await page.getByRole('button', { name: label, exact: true }).click()
			await page.waitForFunction(
				(expected) => document.querySelector('.tiptap')?.textContent?.includes(expected),
				label === '分析' ? '接收方验收' : '行动核对',
			)
			const copied = await editor.evaluate((element) => {
				const instance = (element as any).editor
				const wanted = new Set(['typstInlineSource', 'typstSource', 'typstComponent', 'typstField'])
				const targets: { type: string; position: number; size: number; inline: boolean }[] = []
				instance.state.doc.descendants((node: any, position: number) => {
					if (wanted.has(node.type.name))
						targets.push({
							type: node.type.name,
							position,
							size: node.nodeSize,
							inline: node.isInline,
						})
				})
				for (const target of targets) {
					const original = instance.state.doc.nodeAt(target.position).toJSON()
					if (target.inline)
						instance.commands.setTextSelection({
							from: target.position,
							to: target.position + target.size,
						})
					else instance.commands.setNodeSelection(target.position)
					const { dom } = instance.view.serializeForClipboard(instance.state.selection.content())
					const parsed = window.acceptance.clipboardParser
						.fromSchema(instance.schema)
						.parseSlice(dom)
					const parsedAtoms: unknown[] = []
					parsed.content.descendants((node) => {
						if (wanted.has(node.type.name)) parsedAtoms.push(node.toJSON())
					})
					if (
						parsedAtoms.length !== 1 ||
						JSON.stringify(parsedAtoms[0]) !== JSON.stringify(original)
					)
						throw new Error(
							`HTML parser lost ${target.type}: ${JSON.stringify({ original, parsedAtoms })}`,
						)
					if (!instance.view.pasteHTML(dom.innerHTML))
						throw new Error(`HTML clipboard rejected ${target.type}`)
					const pasted = instance.state.doc.nodeAt(target.position).toJSON()
					if (JSON.stringify(pasted) !== JSON.stringify(original))
						throw new Error(
							`HTML clipboard changed ${target.type}: ${JSON.stringify({ original, pasted })}`,
						)
				}
				return targets.map((target) => target.type)
			})
			for (const kind of copied) clipboardKinds.add(kind)
			assert.equal(
				await page.evaluate((file) => window.acceptance.project.snapshot().files[file], path),
				browserFiles![path!],
			)
		}
		assert.deepEqual([...clipboardKinds].sort(), [
			'typstComponent',
			'typstField',
			'typstInlineSource',
			'typstSource',
		])
		await page.locator('.typst-math-preview .katex').waitFor()
		assert.equal(await page.locator('.typst-math-error').count(), 0)
		await page.screenshot({ path: join(evidence, 'desktop.png'), fullPage: true })
		await page.setViewportSize({ width: 390, height: 844 })
		await page.screenshot({ path: join(evidence, 'mobile.png'), fullPage: true })
		assert.deepEqual(browserErrors, [])
	} finally {
		await context.close()
		await browser.close()
	}
	await writeFile(join(evidence, 'browser-files.json'), JSON.stringify(browserFiles!, null, 2))
	stages.push(
		'Shared Chromium executes the production bundle/WASM; Chinese selection, source history, file-only save/reopen, explicit JSON-bound component insertion/parameters/undo, JSON field insertion and live data updates, new-project page reload and lossless HTML clipboard parsing/paste of all four source node types succeed',
	)

	const snapshots: Record<string, string>[] = [browserFiles!]
	const jsonOnly = {
		...browserFiles!,
		'data/sales.json':
			JSON.stringify({
				total: 180,
				channels: [
					{ name: '直营', actual: 120 },
					{ name: '合作', actual: 60 },
				],
			}) + '\n',
	}
	snapshots.push(jsonOnly, { ...jsonOnly, 'sections/actions.typ': '#let broken = (' }, jsonOnly)
	const roots: string[] = []
	for (const [index, files] of snapshots.entries()) {
		const root = join(output, `source-${index}`)
		roots.push(root)
		for (const [path, source] of Object.entries(files)) {
			await mkdir(dirname(join(root, path)), { recursive: true })
			await writeFile(join(root, path), source)
		}
	}
	const font =
		process.env.PLUXEL_TYPST_TEST_FONT ?? '/run/host/fonts/noto-cjk/NotoSerifCJK-Regular.ttc'
	await readFile(font)
	for (const file of ['acceptance-native.ts', 'acceptance-native-runner.ts'])
		await cp(join(fixtureRoot, file), join(nativeChecker, file))
	await checkTypes(['acceptance-native.ts', 'acceptance-native-runner.ts'], false, nativeChecker)
	await build({
		configFile: false,
		root: nativeChecker,
		logLevel: 'error',
		oxc: { decorator: { legacy: true } },
		plugins: [createPluginSemanticsPlugin({ root: nativeChecker }).plugin as any],
		build: {
			ssr: join(nativeChecker, 'acceptance-native-runner.ts'),
			outDir: 'run',
			target: 'node24',
			rollupOptions: {
				external: (id) => !id.startsWith('.') && !id.startsWith('/'),
				output: { entryFileNames: 'native.mjs' },
			},
		},
	})
	await writeFile(join(nativeChecker, 'run/job.json'), JSON.stringify({ roots, font, evidence }))
	await command(process.execPath, ['run/native.mjs'], nativeChecker, log)
	const native = JSON.parse(await readFile(join(evidence, 'native.json'), 'utf8'))
	assert.deepEqual(
		native.map((item: any) => item.ok),
		[true, true, false, true],
	)
	assert.equal(new Set(native.map((item: any) => item.sessionId)).size, 1)
	assert.deepEqual(
		native.filter((item: any) => item.ok).map((item: any) => item.revision),
		[1, 2, 3],
	)
	assert.equal(native[2].lastSuccessfulRevision, 2)
	assert.notDeepEqual(
		await readFile(join(evidence, 'native-0.pdf')),
		await readFile(join(evidence, 'native-1.pdf')),
	)
	stages.push(
		'External built Native/Core/Fonts/services artifacts compile browser-authored files via constructor injection in one session; JSON-only graph refresh, explicit error, repair, PDF/PNG and navigation are observed',
	)
	await writeFile(join(evidence, 'commands.log'), log.join('\n\n'))
	await writeFile(
		join(evidence, 'summary.json'),
		JSON.stringify({ stages, parser, native, browserErrors }, null, 2),
	)
	console.info('Typst isolated source artifact evidence:', evidence)
})
