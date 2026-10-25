import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { BasePlugin, Plugin } from '@pluxel/core'
import { FontsPlugin, type FontRegistration } from '@pluxel/plugin-fonts'
import { TypstPlugin, type TypstSession } from '@pluxel/plugin-typst'
import { createTestHost } from '@pluxel/test'
import { nodeModules } from '@pluxel/services/node'
import type { Editor, EditorOptions, TiptapEditorHTMLElement } from '@tiptap/core'
import { chromium, type Locator, type Page } from 'playwright'
import { build } from 'vite'
import { expect, it } from 'vitest'

@Plugin()
class ConsumerHost extends BasePlugin {
	constructor(
		readonly typst: TypstPlugin,
		readonly fonts: FontsPlugin,
	) {
		super()
	}
}

const run = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, '../..')
const workspace = resolve(packageRoot, '../../..')
const fixtureRoot = import.meta.dirname
const rootRequire = createRequire(join(workspace, 'package.json'))
const packageRequire = createRequire(join(packageRoot, 'package.json'))
const markdownFixture = `## Heading

Customer <data-field path='["customer","name"]'></data-field>

|A|B|
|-|-|
|one|two|`
const acceptedMarkdown = `## Accepted candidate

Prepared for <data-field path='["customer","name"]'></data-field>.`

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

async function poll<T>(read: () => Promise<T> | T, expected: T) {
	await expect.poll(read, { timeout: 60_000, interval: 50 }).toEqual(expected)
}

async function waitForEditorSelection(locator: Locator) {
	// Keyboard selection changes reach the DOM before the native selectionchange handler.
	await poll(
		() =>
			locator.evaluate((element) => {
				const editor = (element as TiptapEditorHTMLElement).editor
				const selection = element.ownerDocument.getSelection()
				if (
					!editor ||
					!selection?.anchorNode ||
					!selection.focusNode ||
					!element.contains(selection.anchorNode) ||
					!element.contains(selection.focusNode)
				)
					return false
				return (
					editor.state.selection.anchor ===
						editor.view.posAtDOM(selection.anchorNode, selection.anchorOffset) &&
					editor.state.selection.head ===
						editor.view.posAtDOM(selection.focusNode, selection.focusOffset)
				)
			}),
		true,
	)
}

async function waitForCollapsedEditorSelection(locator: Locator) {
	await poll(
		() =>
			locator.evaluate(
				(element) => (element as TiptapEditorHTMLElement).editor?.state.selection.empty,
			),
		true,
	)
	await waitForEditorSelection(locator)
}

async function currentPreview(page: Page) {
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 当前$/ })
		.waitFor({ timeout: 90_000 })
	await poll(() => page.locator('[role="alert"]').count(), 0)
}

async function text(locator: Locator): Promise<string> {
	return (await locator.textContent()) ?? ''
}

async function openFormat(page: Page, toolbar: Locator, name = '文字格式') {
	const dialog = page.getByRole('dialog', { name, exact: true })
	if (!(await dialog.isVisible()))
		await toolbar.getByRole('button', { name: '格式', exact: true }).click()
	await dialog.waitFor()
	return dialog
}

async function insertContent(page: Page, toolbar: Locator, title: string) {
	await toolbar.getByRole('button', { name: '插入', exact: true }).click()
	const dialog = page.getByRole('dialog', { name: '插入内容', exact: true })
	await dialog.getByRole('searchbox', { name: '搜索插入内容', exact: true }).fill(title)
	await dialog.getByRole('option', { name: title, exact: true }).click()
	await dialog.waitFor({ state: 'hidden' })
}

async function containsText(locator: Locator, pattern: RegExp): Promise<boolean> {
	return pattern.test(await text(locator))
}

async function pasteHtml(page: Page, editor: Locator, html: string, plain: string) {
	await page.evaluate(
		(value) =>
			navigator.clipboard.write([
				new ClipboardItem({
					'text/html': new Blob([value.html], { type: 'text/html' }),
					'text/plain': new Blob([value.plain], { type: 'text/plain' }),
				}),
			]),
		{ html, plain },
	)
	await editor.press('ControlOrMeta+V')
}

it('consumes built optional entries outside the workspace and edits a real native report in Chromium', async () => {
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
		`import { TypstPreviewView, pointAtSource } from '@pluxel/plugin-typst/browser'; import { defineTypstDocument } from '@pluxel/plugin-typst/template'; import '@pluxel/plugin-typst/tiptap/style.css'; document.body.textContent = [typeof TypstPreviewView, typeof pointAtSource, typeof defineTypstDocument].join(',');`,
	)
	await writeFile(
		join(app, 'base.html'),
		'<body><script type="module" src="/base-browser.ts"></script></body>',
	)
	await consumerBuild('base.html', 'base-dist')
	stages.push(
		'Browser app without Tiptap/React or native server peers: template/browser strict types, imports and production browser build',
	)

	const pluginManifest = await manifest(join(packageRoot, 'package.json'))
	assert.ok(pluginManifest.peerDependencies['@tiptap/extension-text-style'])
	assert.equal(pluginManifest.peerDependenciesMeta['@tiptap/extension-text-style'].optional, true)
	assert.ok(pluginManifest.peerDependencies['@tiptap/extension-text-align'])
	assert.equal(pluginManifest.peerDependenciesMeta['@tiptap/extension-text-align'].optional, true)
	for (const name of Object.keys(pluginManifest.peerDependencies).filter(
		(dependency) =>
			dependency.startsWith('@tiptap/') &&
			!['@tiptap/react', '@tiptap/extension-drag-handle-react', '@tiptap/extensions'].includes(
				dependency,
			),
	))
		dependencies[name] = await installedSpec(name)
	await install()
	await absent([
		'@tiptap/react',
		'react',
		'react-dom',
		'modern-monaco',
		'@pluxel/workbench',
		'electron',
	])
	await cp(join(fixtureRoot, 'editor-config.mjs'), join(app, 'editor-config.mjs'))
	await cp(join(fixtureRoot, 'report-example.mjs'), join(app, 'report-example.mjs'))
	await cp(join(fixtureRoot, 'report-example.d.mts'), join(app, 'report-example.d.mts'))
	await cp(join(fixtureRoot, 'public'), join(app, 'public'), { recursive: true })
	await writeFile(
		join(app, 'tiptap-check.mts'),
		`import { createEditorExtensions, TypstTableStyle, generateTypstRegions, parseTypstMarkdown, type TypstEditorConfig } from '@pluxel/plugin-typst/tiptap'; import { getSchema, type Editor } from '@tiptap/core'; declare const editor: Editor; const typography = editor.chain().setFontFamily('Liberation Serif').setFontSize('18pt').setColor('#dc2626').setBackgroundColor('#fef08a').setTextAlign('center').unsetTextAlign().toggleTextAlign('justify'); void typography; getSchema(createEditorExtensions()); const config: TypstEditorConfig = { regions: [{id:'body'}], fields: [], extensions: [TypstTableStyle.configure({ defaultStyle: 'three-line', allowedStyles: [] })] }; const parsed = parseTypstMarkdown({config, regionId:'body', markdown:'# Node without DOM'}); if(parsed.ok) generateTypstRegions({config, regions:{body:parsed.value}, data:{}, snapshotRevision:1});`,
	)
	await checkTypes(['tiptap-check.mts'])
	await writeFile(
		join(app, 'node-without-dom.mjs'),
		`import assert from 'node:assert/strict'; ${importGuard(['react', 'react-dom', '@tiptap/react'])} const sdk=await import('@pluxel/plugin-typst/tiptap'); const {config,initialDraft,parseData}=await import('./editor-config.mjs'); assert.equal(typeof document,'undefined'); const markdown=${JSON.stringify(markdownFixture)}; const parsed=sdk.parseTypstMarkdown({config,regionId:'notes',markdown,data:parseData(initialDraft.data)}); assert.equal(parsed.ok,true,JSON.stringify(parsed)); const generated=sdk.generateTypstRegions({config,regions:initialDraft.regions,data:parseData(initialDraft.data),snapshotRevision:1}); assert.equal(generated.ok,true,JSON.stringify(generated)); console.log(JSON.stringify(parsed.value)); hooks.deregister();`,
	)
	const nodeMarkdown = JSON.parse(
		await command(process.execPath, ['node-without-dom.mjs'], app, log),
	)
	stages.push(
		'Tiptap peers including official TextStyleKit only: strict types and field/table Markdown plus region generation without DOM or React',
	)

	// Explicit peers keep the --legacy-peer-deps fixture independent of the workspace.
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
	dependencies['@myriaddreamin/typst-ts-renderer'] = await installedSpec(
		'@myriaddreamin/typst-ts-renderer',
	)
	await install()
	await absent(['modern-monaco', 'monaco-editor', '@pluxel/workbench', 'electron'])
	for (const file of [
		'index.html',
		'main.tsx',
		'style.css',
		'editor-config.d.mts',
		'compile-contract.ts',
		'channel-parameters.tsx',
		'report-example.mjs',
		'report-example.d.mts',
	])
		await cp(join(fixtureRoot, file), join(app, file))
	const editorDocs = await readFile(
		join(workspace, 'docs/plugins/rendering/typst-editor.md'),
		'utf8',
	)
	const reactExample = editorDocs.match(/```tsx no-twoslash\n([\s\S]*?)```/)?.[1]
	assert.ok(reactExample, 'Public React example must remain type-checkable')
	await writeFile(join(app, 'react-example.tsx'), reactExample)
	await checkTypes(['main.tsx', 'editor-config.mjs', 'react-example.tsx'], true)
	await consumerBuild('index.html', 'dist')
	const installedRoot = await realpath(join(app, 'node_modules/@pluxel/plugin-typst'))
	assert.ok(!installedRoot.startsWith(workspace))
	const installedFiles = await readdir(installedRoot)
	assert.ok(!installedFiles.includes('src'))
	stages.push(
		'React peers: strict types and production Vite build with no source alias, Monaco, Core or Workbench in the browser graph',
	)

	const sdk = await import(
		/* @vite-ignore */ pathToFileURL(join(installedRoot, 'dist/tiptap.mjs')).href
	)
	const fixture = await import(
		/* @vite-ignore */ pathToFileURL(join(app, 'editor-config.mjs')).href
	)
	const templateRoot = join(output, 'template')
	await mkdir(templateRoot, { recursive: true })
	await writeFile(join(templateRoot, 'main.typ'), fixture.initialSource)
	const hostStarted = performance.now()
	await using host = await createTestHost({ services: [nodeModules()] })
	await host.commit((change) => {
		change.catalog.add([FontsPlugin, TypstPlugin, ConsumerHost])
		change.start(FontsPlugin, { initialConfig: { maxFontBytes: 32 * 1024 * 1024 } })
		change.start([TypstPlugin, ConsumerHost])
	})
	const hostStartMs = performance.now() - hostStarted
	const fontStarted = performance.now()
	const fonts = host.require(ConsumerHost).fonts
	const registrations: FontRegistration[] = []
	using _fontLifetime = {
		[Symbol.dispose]: () => {
			for (const registration of registrations.toReversed()) registration.dispose()
		},
	}
	const registeredFonts: {
		family: string
		path: string
		byteLength: number
		skiaFamilies: readonly string[]
	}[] = []
	const fontRoot = join(output, 'fonts')
	await mkdir(fontRoot)
	for (const [index, family] of fixture.fontFamilies.entries()) {
		const matched = await command('fc-match', ['-f', '%{family}\n%{file}', family], workspace, log)
		const [matchedFamily, sourcePath] = matched.trim().split('\n')
		assert.ok(matchedFamily?.split(',').includes(family), `Fontconfig must provide ${family}`)
		assert.ok(sourcePath)
		const path = join(fontRoot, `font-${index}${extname(sourcePath)}`)
		await cp(sourcePath, path)
		const registration = await fonts.registerFromPath({ path })
		registrations.push(registration)
		const metadata = await stat(path)
		registeredFonts.push({
			family,
			path,
			byteLength: metadata.size,
			skiaFamilies: registration.families,
		})
	}
	assert.ok(fonts.families.some((item) => item.family === 'Liberation Serif'))
	const fontsPreparedMs = performance.now() - fontStarted
	await writeFile(
		join(evidence, 'native-fonts.json'),
		JSON.stringify(
			{
				registeredFonts,
				skiaFamilies: fonts.families.filter((item) =>
					registeredFonts.some((font) => font.skiaFamilies.includes(item.family)),
				),
				portableFonts: fonts.portableFonts,
			},
			null,
			2,
		),
	)
	const sessionStarted = performance.now()
	await using session: TypstSession = await host
		.require(ConsumerHost)
		.typst.open({ root: templateRoot, entry: 'main.typ' })
	const sessionOpenMs = performance.now() - sessionStarted
	const compilations: {
		kind: 'cold' | 'edit' | 'data-only'
		clientRevision: number
		nativeRevision: number
		elapsedMs: number
		templateChanged: boolean
		vectorBytes: number
		pdfBytes: number
		diagnostics: readonly { severity: string; message: string }[]
	}[] = []
	let latest:
		| { clientRevision: number; preview: any; mapping: any[]; diagnostics: unknown }
		| undefined
	let latestTemplateFiles: Record<string, string> = {}
	let generatedTemplate = ''
	let browserReadyMs = 0
	const browserErrors: string[] = []
	const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
	await using _browserLifetime = { [Symbol.asyncDispose]: () => browser.close() }
	const context = await browser.newContext({
		viewport: { width: 1440, height: 1100 },
		acceptDownloads: true,
		permissions: ['clipboard-read', 'clipboard-write'],
	})
	const page = await context.newPage()
	page.setDefaultTimeout(30_000)
	page.on('pageerror', (cause) => browserErrors.push(String(cause)))
	page.on('dialog', (dialog) => dialog.accept())
	await page.route('https://typst-consumer.test/**', async (route) => {
		const url = new URL(route.request().url())
		try {
			if (url.pathname === '/compile') {
				const snapshot = route.request().postDataJSON()
				const checked = sdk.validateTypstDraft({
					draft: snapshot.draft,
					config: fixture.config,
					templateId: 'consumer-report',
					templateRevision: 'fixed-v1',
				})
				if (!checked.ok) throw new Error(JSON.stringify(checked.issues))
				const data = fixture.parseData(checked.value.data)
				const generated = sdk.generateTypstRegions({
					regions: checked.value.regions,
					config: fixture.config,
					data,
					snapshotRevision: snapshot.revision,
				})
				if (!generated.ok) throw new Error(JSON.stringify(generated.issues))
				latestTemplateFiles = generated.value.templateFiles
				const key = JSON.stringify([snapshot.source, generated.value.templateFiles])
				const templateChanged = key !== generatedTemplate
				if (templateChanged) {
					await writeFile(join(templateRoot, 'main.typ'), snapshot.source)
					for (const [path, source] of Object.entries(generated.value.templateFiles)) {
						await mkdir(dirname(join(templateRoot, path)), { recursive: true })
						await writeFile(join(templateRoot, path), source as string)
					}
					generatedTemplate = key
				}
				const started = performance.now()
				const compiled = await session.update({
					...(templateChanged ? { template: { root: templateRoot, entry: 'main.typ' } } : {}),
					files: Object.fromEntries(
						Object.entries(generated.value.inputFiles).map(([path, source]) => [
							path,
							{ kind: 'text' as const, text: source as string },
						]),
					),
				})
				assert.ok(
					!compiled.diagnostics.some(
						(item) =>
							/unknown font family/i.test(item.message) &&
							fixture.fontFamilies.some((family: string) =>
								item.message.toLowerCase().includes(family.toLowerCase()),
							),
					),
					JSON.stringify(compiled.diagnostics),
				)
				const pdf = await session.exportPdf(compiled.revision)
				latest = {
					clientRevision: snapshot.revision,
					preview: { ...compiled.preview, data: [...compiled.preview.data] },
					mapping: generated.value.mapping,
					diagnostics: compiled.diagnostics,
				}
				compilations.push({
					kind: compilations.length === 0 ? 'cold' : templateChanged ? 'edit' : 'data-only',
					clientRevision: snapshot.revision,
					nativeRevision: compiled.revision,
					elapsedMs: performance.now() - started,
					templateChanged,
					vectorBytes: compiled.preview.data.byteLength,
					pdfBytes: pdf.byteLength,
					diagnostics: compiled.diagnostics,
				})
				await writeFile(join(evidence, 'latest.pdf'), pdf)
				await writeFile(join(evidence, 'latest-preview.json'), JSON.stringify(latest))
				await route.fulfill({ contentType: 'application/json', body: JSON.stringify(latest) })
				return
			}
			if (url.pathname === '/pdf') {
				const { revision } = route.request().postDataJSON()
				await route.fulfill({
					contentType: 'application/pdf',
					body: Buffer.from(await session.exportPdf(revision)),
				})
				return
			}
			const pathname =
				url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
			assert.ok(!pathname.split('/').includes('..'))
			const contentType =
				(
					{
						'.html': 'text/html',
						'.js': 'text/javascript',
						'.css': 'text/css',
						'.wasm': 'application/wasm',
					} as Record<string, string>
				)[extname(pathname)] ?? 'application/octet-stream'
			await route.fulfill({ contentType, body: await readFile(join(app, 'dist', pathname)) })
		} catch (cause) {
			await route.fulfill({
				status: 400,
				contentType: 'application/json',
				body: JSON.stringify({
					kind: 'unexpected',
					name: cause instanceof Error ? cause.name : 'UnknownError',
					code: 'CONSUMER_TEST_FAILURE',
					message: String(cause),
					diagnostics: [],
				}),
			})
		}
	})
	try {
		const browserStarted = performance.now()
		await page.goto('https://typst-consumer.test/')
		await currentPreview(page)
		await poll(() => page.locator('.typst-page').count(), 3)
		browserReadyMs = performance.now() - browserStarted
		await poll(() => page.locator('[data-data-field]').filter({ hasText: 'Acme!' }).count(), 2)
		await page.screenshot({ path: join(evidence, '01-initial.png'), fullPage: true })
		async function openWorkspace(name: string) {
			const tab = page.getByRole('tab', { name, exact: true })
			if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
		}
		await openWorkspace('模板')
		const sourceInput = page.locator('textarea[aria-label="Typst 源码"]')
		const initialSource = await sourceInput.inputValue()
		await sourceInput.fill(`${initialSource}\n#let broken = (`)
		await page.getByRole('alert').waitFor()
		await page
			.getByTestId('revision')
			.filter({ hasText: / · 过期$/ })
			.waitFor()
		assert.equal(await page.locator('.typst-page').count(), 3)
		assert.equal(
			await page.getByRole('button', { name: '导出当前 PDF', exact: true }).isDisabled(),
			true,
		)
		const beforeStaleClick = await text(page.getByTestId('navigation'))
		const stalePoint = latest!.preview.navigation.points.find(
			(item: any) => item.path === 'main.typ' && item.line === 4,
		)
		assert.ok(stalePoint)
		await clickPoint(stalePoint)
		assert.equal(await text(page.getByTestId('navigation')), beforeStaleClick)
		await sourceInput.fill(initialSource)
		await currentPreview(page)
		await page.getByRole('combobox', { name: '客户', exact: true }).selectOption('Beta')
		await currentPreview(page)
		await poll(() => page.locator('[data-data-field]').filter({ hasText: 'Beta!' }).count(), 2)
		assert.equal(
			compilations.at(-1)!.templateChanged,
			false,
			'Data-only changes reuse generated template source',
		)

		const point = latest!.preview.navigation.points.find(
			(item: any) => item.path === 'main.typ' && item.line === 4,
		)
		assert.ok(point)
		async function clickPoint(target: any, modifiers: ('Control' | 'Shift')[] = []) {
			const position = await page
				.locator('.typst-page')
				.nth(target.page - 1)
				.evaluate((element, item) => {
					const matrix = (element as SVGGraphicsElement).getScreenCTM()!
					const screen = new DOMPoint(
						item.x + item.width / 2,
						item.y + item.height / 2,
					).matrixTransform(matrix)
					return { x: screen.x, y: screen.y }
				}, target)
			for (const modifier of modifiers) await page.keyboard.down(modifier)
			await page.mouse.click(position.x, position.y)
			for (const modifier of modifiers) await page.keyboard.up(modifier)
		}
		await clickPoint(point)
		await poll(() => containsText(page.getByTestId('navigation'), /^source:/), true)
		await sourceInput.evaluate((element) => {
			element.scrollTop = 0
		})
		await page.getByRole('textbox', { name: 'Typst 源码' }).click({ position: { x: 90, y: 62 } })
		await page.locator('.preview-source-highlight').waitFor()
		await page.getByRole('combobox', { name: '缩放', exact: true }).selectOption('1.5')
		const generatedPoint = latest!.preview.navigation.points.find(
			(item: any) => item.path === '_editor/regions/body.typ' && item.page === 1,
		)
		assert.ok(generatedPoint)
		await clickPoint(generatedPoint)
		await poll(() => containsText(page.getByTestId('navigation'), /^region:body:/), true)
		// Geometry order is the oracle here, independent of the mapping's source columns.
		// The initial heading has one glyph per character and begins at ProseMirror position 1.
		const headingGlyphs = latest!.preview.navigation.points
			.filter(
				(item: any) =>
					item.path === '_editor/regions/body.typ' && item.page === 1 && item.line === 2,
			)
			.sort((a: any, b: any) => a.x - b.x)
		assert.equal(headingGlyphs.length, 'Editable overview'.length)
		for (const index of [2, 9, 15]) {
			await clickPoint(headingGlyphs[index])
			await poll(
				() =>
					page
						.getByRole('textbox', { name: '正文区域 body', exact: true })
						.evaluate(
							(element) => (element as TiptapEditorHTMLElement).editor!.state.selection.from,
						),
				index + 1,
			)
		}
		// A pointerup handler must use the new DOM caret, not the previous PM selection.
		const caret = await page
			.getByRole('textbox', { name: '正文区域 body', exact: true })
			.evaluate((element) => (element as TiptapEditorHTMLElement).editor!.view.coordsAtPos(11))
		await page.mouse.click(caret.left + 0.2, (caret.top + caret.bottom) / 2)
		await poll(
			async () =>
				Math.abs(
					Number(await page.locator('.preview-source-highlight').getAttribute('x')) -
						(headingGlyphs[10].x - 2),
				) < 0.1,
			true,
		)
		const beforeModifiedClick = await text(page.getByTestId('navigation'))
		await clickPoint(generatedPoint, ['Control'])
		assert.equal(await text(page.getByTestId('navigation')), beforeModifiedClick)
		await page.getByRole('combobox', { name: '缩放', exact: true }).selectOption('1')
		await page.getByRole('button', { name: 'Repeated body', exact: true }).click()
		await poll(() => text(page.getByTestId('page')), '3 / 3')
		await page.getByRole('textbox', { name: '正文区域 body', exact: true }).locator('h2').click()
		await page.locator('.typst-page').nth(2).locator('.preview-source-highlight').waitFor()
		const beforeDrag = await text(page.getByTestId('navigation'))
		const repeatedPoint = latest!.preview.navigation.points.find(
			(item: any) => item.path === '_editor/regions/body.typ' && item.page === 3,
		)
		assert.ok(repeatedPoint)
		const dragStart = await page
			.locator('.typst-page')
			.nth(2)
			.evaluate((element, item) => {
				const screen = new DOMPoint(
					item.x + item.width / 2,
					item.y + item.height / 2,
				).matrixTransform((element as SVGGraphicsElement).getScreenCTM()!)
				return { x: screen.x, y: screen.y }
			}, repeatedPoint)
		await page.mouse.move(dragStart.x, dragStart.y)
		await page.mouse.down()
		await page.mouse.move(dragStart.x + 30, dragStart.y + 10, { steps: 4 })
		await page.mouse.up()
		assert.equal(
			await text(page.getByTestId('navigation')),
			beforeDrag,
			'A real preview drag does not navigate',
		)
		await page.screenshot({ path: join(evidence, '02-navigation.png'), fullPage: true })
		const initialBody = await text(page.getByTestId('region-body').locator('.tiptap'))
		await openWorkspace('AI 候选')
		await page.getByRole('button', { name: '固定候选目标', exact: true }).click()
		await page.getByRole('button', { name: '查看修改预览', exact: true }).click()
		await openWorkspace('AI 候选')
		assert.equal(
			await page.getByRole('button', { name: '接纳候选', exact: true }).isDisabled(),
			true,
		)
		assert.match(await text(page.getByRole('alert')), /COMPLEX_CONTENT/)
		assert.equal(await text(page.getByTestId('region-body').locator('.tiptap')), initialBody)

		await openWorkspace('正文')
		await page.getByRole('button', { name: '备注', exact: true }).click()
		const notes = page.getByTestId('region-notes').locator('.tiptap')
		const notesRegion = page.getByTestId('region-notes')
		const notesToolbar = notesRegion.getByRole('toolbar', { name: '正文格式', exact: true })
		const formatDialog = page.getByRole('dialog', { name: '文字格式', exact: true })
		const paragraphStyle = formatDialog.getByRole('combobox', { name: '段落样式', exact: true })
		const readOnlyRevision = await text(page.getByTestId('revision'))
		await page.getByRole('checkbox', { name: '区域只读', exact: true }).check()
		assert.equal(await notes.getAttribute('contenteditable'), 'false')
		assert.equal(
			await notesToolbar.getByRole('button', { name: '格式', exact: true }).isDisabled(),
			true,
		)
		assert.equal(
			await notesToolbar.getByRole('button', { name: '插入', exact: true }).isDisabled(),
			true,
		)
		assert.equal(await formatDialog.isVisible(), false, 'Read-only formatting stays unavailable')
		await notes.press('/')
		assert.equal(await page.getByRole('listbox', { name: '插入内容', exact: true }).count(), 0)
		await openWorkspace('正文')
		await notes.evaluate((element) => {
			const editor = (element as TiptapEditorHTMLElement).editor!
			editor.commands.insertContent({
				type: 'notice',
				attrs: { tone: 'info' },
				content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Forbidden notice' }] }],
			})
		})
		assert.match(await text(page.getByRole('alert')), /FORBIDDEN_REGION/)
		assert.equal(await text(notes), 'Notes ready for a Markdown candidate.')
		assert.equal(await text(page.getByTestId('revision')), readOnlyRevision)
		await page.getByRole('checkbox', { name: '区域只读', exact: true }).uncheck()
		await openWorkspace('正文')
		await notes.click()
		await openFormat(page, notesToolbar)
		await paragraphStyle.selectOption({ label: '标题 2' })
		await notes.locator('h2').waitFor()
		await currentPreview(page)
		assert.equal(await text(paragraphStyle.locator('option:checked')), '标题 2')
		await page.screenshot({ path: join(evidence, '06-heading-style.png'), fullPage: true })
		await openWorkspace('正文')
		await notesToolbar.getByRole('button', { name: '撤销', exact: true }).click()
		assert.equal(await notes.locator('h2').count(), 0, 'Block conversion is one native undo step')
		assert.equal(await text(notes), 'Notes ready for a Markdown candidate.')
		const plainNotesHtml = await notes.innerHTML()
		// ProseMirror 1.42.6 domobserver restores the old selection when a newly focused
		// editor moves to document start within 200ms. Let that native focus window settle.
		await page.waitForTimeout(200)
		await notes.press('ControlOrMeta+Home')
		await notes.press('ControlOrMeta+Shift+ArrowRight')
		await poll(() => page.evaluate(() => window.getSelection()?.toString().trim()), 'Notes')
		await waitForEditorSelection(notes)
		const bubble = page.getByRole('toolbar', { name: '选区格式', exact: true })
		assert.equal(await bubble.isVisible(), false, 'Selecting text does not open a menu')
		await notes.press('Shift+F10')
		await bubble.waitFor()
		await page.screenshot({ path: join(evidence, '07-selection-contextmenu.png'), fullPage: true })
		await bubble.getByRole('button', { name: '加粗', exact: true }).click()
		const boldSelection = await text(notes.locator('strong'))
		assert.equal(boldSelection.trim(), 'Notes')
		await openWorkspace('正文')
		await notesToolbar.getByRole('button', { name: '撤销', exact: true }).click()
		assert.equal(
			await notes.innerHTML(),
			plainNotesHtml,
			'Context-menu formatting is one native undo step',
		)
		await page.evaluate(
			() =>
				new Promise<void>((done) =>
					requestAnimationFrame(() => requestAnimationFrame(() => done())),
				),
		)
		await notes.press('ArrowRight')
		await notes.press('ControlOrMeta+End')
		await waitForEditorSelection(notes)
		await poll(
			() =>
				notes.evaluate((element) => {
					const selection = window.getSelection()
					if (
						document.activeElement !== element ||
						!selection?.isCollapsed ||
						!selection.focusNode ||
						!element.contains(selection.focusNode)
					)
						return false
					const remaining = document.createRange()
					remaining.selectNodeContents(element)
					remaining.setStart(selection.focusNode, selection.focusOffset)
					return remaining.toString() === ''
				}),
			true,
		)
		await page.evaluate(
			() =>
				new Promise<void>((done) =>
					requestAnimationFrame(() => requestAnimationFrame(() => done())),
				),
		)
		await expect
			.poll(() => notes.getAttribute('data-consumer-selection'), { timeout: 5000, interval: 20 })
			.toBe(String('Notes ready for a Markdown candidate.'.length + 1))
		await notes.press('Enter')
		assert.equal(await text(notes), 'Notes ready for a Markdown candidate.')
		await page.keyboard.insertText('/heading')
		assert.match(await text(notes), /^Notes ready for a Markdown candidate\.\/heading$/)
		const slash = page.getByRole('listbox', { name: '插入内容', exact: true })
		await slash.waitFor()
		assert.equal(await slash.getByRole('option').count(), 6, 'Slash query filters to headings')
		await slash.getByRole('option', { name: '标题 1', exact: true }).waitFor()
		assert.equal(await slash.getByRole('option', { name: '表格', exact: true }).count(), 0)
		await page.screenshot({ path: join(evidence, '08-slash-menu.png'), fullPage: true })
		await page.setViewportSize({ width: 390, height: 844 })
		await slash.scrollIntoViewIfNeeded()
		await page.screenshot({ path: join(evidence, '09-mobile-slash.png') })
		assert.equal(
			await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
			false,
			'The shared menus fit the mobile viewport',
		)
		await page.setViewportSize({ width: 1440, height: 1100 })
		await notes.press('ArrowDown')
		await notes.press('Enter')
		await notes.locator('h2').waitFor()
		assert.doesNotMatch(await text(notes), /\/heading/)
		await openWorkspace('正文')
		await notesToolbar.getByRole('button', { name: '撤销', exact: true }).click()
		assert.equal(await notes.locator('h2').count(), 0)
		assert.match(await text(notes), /\/heading$/, 'One undo restores the complete slash query')
		await openWorkspace('正文')
		await notesToolbar.getByRole('button', { name: '重做', exact: true }).click()
		await notes.locator('h2').waitFor()
		await page.keyboard.insertText('Slash heading')
		await notes.press('Enter')
		await page.keyboard.insertText('/客户')
		await slash.getByRole('option', { name: '客户名称', exact: true }).waitFor()
		assert.equal(await slash.getByRole('option').count(), 1)
		await notes.press('Enter')
		const slashField = notes.locator('[data-data-field]')
		await poll(() => text(slashField), 'Beta!')
		await currentPreview(page)
		await page.getByRole('combobox', { name: '客户', exact: true }).selectOption('Acme')
		await poll(() => text(slashField), 'Acme!')
		await currentPreview(page)
		assert.equal(compilations.at(-1)!.templateChanged, false)
		await openWorkspace('正文')
		await notesToolbar.getByRole('button', { name: '撤销', exact: true }).click()
		assert.equal(await notes.locator('[data-data-field]').count(), 0)
		assert.match(await text(notes), /\/客户$/, 'Data changes do not add a history entry')
		await openWorkspace('正文')
		await notesToolbar.getByRole('button', { name: '重做', exact: true }).click()
		await poll(() => text(slashField), 'Acme!')
		await notes.press('End')
		await waitForEditorSelection(notes)
		await notes.press('Enter')
		await page.keyboard.insertText('/heading')
		await slash.waitFor()
		await notes.press('Escape')
		assert.equal(await slash.count(), 0)
		assert.match(await text(notes), /\/heading$/, 'Escape leaves the user input intact')
		await page.getByRole('combobox', { name: '客户', exact: true }).selectOption('Beta')
		await poll(() => text(slashField), 'Beta!')
		const originalNotes = await text(notes)
		const candidateInput = page.getByRole('textbox', { name: '候选 Markdown', exact: true })
		async function inspectImport(value: string, kind: 'Markdown' | 'HTML') {
			await openWorkspace('AI 候选')
			await candidateInput.fill(value)
			await page.getByRole('button', { name: `检查 ${kind}`, exact: true }).click()
			return JSON.parse(await text(page.getByTestId('import-result')))
		}
		const browserMarkdown = await inspectImport(markdownFixture, 'Markdown')
		assert.equal(browserMarkdown.ok, true, JSON.stringify(browserMarkdown))
		assert.deepEqual(
			browserMarkdown.value,
			nodeMarkdown,
			'Node and browser produce identical field/table Markdown JSON',
		)
		const richHtml =
			'<table><colgroup><col style="width:120px"><col style="width:240px"></colgroup><tbody><tr><td colspan="2"><p>A</p><p>B</p></td></tr></tbody></table>'
		const alignedHtml =
			'<p style="text-align: left">Left</p><h2 style="text-align: center">Center</h2><p style="text-align: right">Right</p><h3 style="text-align: justify">Justify</h3><p>Inherit</p>'
		const alignedImport = await inspectImport(alignedHtml, 'HTML')
		assert.equal(alignedImport.ok, true, JSON.stringify(alignedImport))
		assert.deepEqual(
			alignedImport.value.content.map((node: any) => node.attrs.textAlign),
			['left', 'center', 'right', 'justify', null],
		)
		const alignedNativeHtml = await notes.evaluate((element, content) => {
			const owner = (element as TiptapEditorHTMLElement).editor!
			const NativeEditor = owner.constructor as new (options: Partial<EditorOptions>) => Editor
			const editor = new NativeEditor({
				element: null,
				extensions: owner.options.extensions,
				content,
			})
			try {
				return editor.getHTML()
			} finally {
				editor.destroy()
			}
		}, alignedImport.value)
		const alignedRoundtrip = await inspectImport(alignedNativeHtml, 'HTML')
		assert.deepEqual(
			alignedRoundtrip,
			alignedImport,
			'Native paragraph/heading HTML keeps alignment and null inheritance',
		)
		const htmlTable = await inspectImport(richHtml, 'HTML')
		assert.equal(htmlTable.ok, true, JSON.stringify(htmlTable))
		const mergedCell = htmlTable.value.content[0].content[0].content[0]
		assert.equal(mergedCell.attrs.colspan, 2)
		assert.deepEqual(mergedCell.attrs.colwidth, [120, 240])
		assert.equal(mergedCell.content.length, 2)
		const noticeHtml = await inspectImport(
			'<aside data-consumer-notice="" data-tone="warning"><p>Host notice</p></aside>',
			'HTML',
		)
		assert.equal(noticeHtml.ok, true, JSON.stringify(noticeHtml))
		assert.equal(noticeHtml.value.content[0].type, 'notice')
		assert.equal(noticeHtml.value.content[0].attrs.tone, 'warning')
		const htmlRejections = []
		for (const html of [
			'<p style="text-align: start">Unsupported alignment</p>',
			'<h2 style="text-align: center; text-align: right">Duplicate alignment</h2>',
			'<p style="text-align: center !important">Unsupported priority</p>',
			'<p style="text-align: center; width: 12px">Unsupported block style</p>',
			'<table><tr><td colspan="1" colspan="2"><p>duplicate</p></td></tr></table>',
			'<table><tr><td unknown="true"><p>unknown</p></td></tr></table>',
			'<tr><td>orphan row</td></tr>',
			'<p><span style="font-size:calc(12pt + 1pt)">unsupported size</span></p>',
			'<p><span style="color:var(--consumer-color)">unsupported color</span></p>',
			'<p><span style="background-image:url(https://example.invalid/image.png)">unsupported property</span></p>',
			'<p><span style="font-size:12pt;font-size:18pt">duplicate declaration</span></p>',
		]) {
			const result = await inspectImport(html, 'HTML')
			assert.equal(result.ok, false, `Strict HTML admission accepted ${html}`)
			htmlRejections.push({ html, result })
		}
		const styledHtml =
			'<p><span style="font-family:Liberation Serif;font-size:18pt;color:#dc2626;background-color:#fef08a">Styled paste</span></p>'
		const styledImport = await inspectImport(styledHtml, 'HTML')
		assert.equal(styledImport.ok, true, JSON.stringify(styledImport))
		const importedStyle = styledImport.value.content[0].content[0].marks.find(
			(mark: any) => mark.type === 'textStyle',
		)
		assert.match(importedStyle.attrs.fontFamily, /^(['"]?)Liberation Serif\1$/)
		assert.equal(importedStyle.attrs.fontSize, '18pt')
		assert.ok(importedStyle.attrs.color)
		assert.ok(importedStyle.attrs.backgroundColor)
		const partialStyleImport = await inspectImport(
			'<p><span style="color:#dc2626">Partial color</span></p>',
			'HTML',
		)
		assert.equal(partialStyleImport.ok, true, JSON.stringify(partialStyleImport))
		const partialStyle = partialStyleImport.value.content[0].content[0].marks.find(
			(mark: any) => mark.type === 'textStyle',
		)
		assert.equal(partialStyle.attrs.fontFamily, null)
		assert.equal(partialStyle.attrs.fontSize, null)
		assert.equal(partialStyle.attrs.backgroundColor, null)
		assert.ok(partialStyle.attrs.color)
		const nestedStyleImport = await inspectImport(
			'<p><span style="font-family:Liberation Serif;font-size:18pt;color:#dc2626"><strong><span style="color:#2563eb;background-color:#fef08a">Nested styled</span></strong></span></p>',
			'HTML',
		)
		assert.equal(nestedStyleImport.ok, true, JSON.stringify(nestedStyleImport))
		const nestedText = nestedStyleImport.value.content[0].content[0]
		assert.equal(nestedText.text, 'Nested styled')
		assert.ok(nestedText.marks.some((mark: any) => mark.type === 'bold'))
		const nestedStyle = nestedText.marks.find((mark: any) => mark.type === 'textStyle')
		assert.match(nestedStyle.attrs.fontFamily, /^(['"]?)Liberation Serif\1$/)
		assert.equal(nestedStyle.attrs.fontSize, '18pt')
		assert.deepEqual(
			await page.evaluate((attrs) => {
				const span = document.createElement('span')
				span.style.color = attrs.color
				span.style.backgroundColor = attrs.backgroundColor
				return { color: span.style.color, backgroundColor: span.style.backgroundColor }
			}, nestedStyle.attrs),
			{ color: 'rgb(37, 99, 235)', backgroundColor: 'rgb(254, 240, 138)' },
		)
		const styledFieldHtml =
			'<p><span style="font-size:18pt;color:#dc2626"><data-field path=\'["customer","name"]\'></data-field></span></p>'
		const styledFieldImport = await inspectImport(styledFieldHtml, 'HTML')
		assert.equal(styledFieldImport.ok, true, JSON.stringify(styledFieldImport))
		const importedField = styledFieldImport.value.content[0].content[0]
		assert.equal(importedField.type, 'dataField')
		assert.equal(
			importedField.marks.find((mark: any) => mark.type === 'textStyle').attrs.fontSize,
			'18pt',
		)
		await openWorkspace('正文')
		await notes.click()
		await notes.press('ControlOrMeta+End')
		await waitForEditorSelection(notes)
		await notes.press('Escape')
		await notes.press('Enter')
		const beforeStyledPaste = await notes.innerHTML()
		await pasteHtml(page, notes, styledHtml, 'Styled paste')
		const pastedStyle = notes.locator('span[style]').filter({ hasText: 'Styled paste' })
		await pastedStyle.waitFor()
		assert.deepEqual(
			await pastedStyle.evaluate((element) => ({
				fontFamily: element.style.fontFamily,
				fontSize: element.style.fontSize,
				color: element.style.color,
				backgroundColor: element.style.backgroundColor,
			})),
			{
				fontFamily: '"Liberation Serif"',
				fontSize: '18pt',
				color: 'rgb(220, 38, 38)',
				backgroundColor: 'rgb(254, 240, 138)',
			},
		)
		await currentPreview(page)
		const pastedHtml = await pastedStyle.evaluate((element) => `<p>${element.outerHTML}</p>`)
		const styledRoundtrip = await inspectImport(pastedHtml, 'HTML')
		assert.equal(styledRoundtrip.ok, true, JSON.stringify(styledRoundtrip))
		const canonicalStyleDocuments = await page.evaluate(
			(trees) =>
				trees.map((tree) => {
					const attrs = tree.content[0].content[0].marks.find(
						(mark: any) => mark.type === 'textStyle',
					).attrs
					const span = document.createElement('span')
					for (const attribute of ['fontFamily', 'fontSize', 'color', 'backgroundColor'] as const) {
						span.style[attribute] = attrs[attribute]
						attrs[attribute] = span.style[attribute]
					}
					return tree
				}),
			[styledImport.value, styledRoundtrip.value],
		)
		assert.deepEqual(
			canonicalStyleDocuments[1],
			canonicalStyleDocuments[0],
			'HTML roundtrip preserves structure and browser-equivalent style values',
		)
		await openWorkspace('AI 候选')
		await candidateInput.fill(acceptedMarkdown)
		await openWorkspace('AI 候选')
		await page.getByRole('button', { name: '固定候选目标', exact: true }).click()
		await page.getByRole('button', { name: '查看修改预览', exact: true }).click()
		const beforeLossyCandidate = await notes.innerHTML()
		await openWorkspace('AI 候选')
		assert.equal(
			await page.getByRole('button', { name: '接纳候选', exact: true }).isDisabled(),
			true,
		)
		assert.match(await text(page.getByRole('alert')), /COMPLEX_CONTENT/)
		assert.equal(await notes.innerHTML(), beforeLossyCandidate, 'A candidate retains inline styles')
		await openWorkspace('正文')
		await notesToolbar.getByRole('button', { name: '撤销', exact: true }).click()
		assert.equal(await notes.innerHTML(), beforeStyledPaste, 'Styled HTML paste is one undo step')
		await pasteHtml(page, notes, styledFieldHtml, 'Customer field')
		const styledField = notes.locator('span[style]:has([data-data-field])')
		await poll(() => text(styledField), 'Beta!')
		assert.equal(await styledField.evaluate((element) => element.style.fontSize), '18pt')
		assert.equal(await styledField.evaluate((element) => element.style.color), 'rgb(220, 38, 38)')
		assert.equal(
			await styledField
				.locator('[data-data-field]')
				.evaluate((element) => getComputedStyle(element).color),
			'rgb(220, 38, 38)',
			'The rendered field inherits its explicit text color',
		)
		await openWorkspace('AI 候选')
		await page.getByRole('button', { name: '固定候选目标', exact: true }).click()
		await currentPreview(page)
		const styledFieldNative = await session.renderPage({
			revision: latest!.preview.revision,
			page: 2,
			scale: 1.5,
		})
		await writeFile(join(evidence, 'native-styled-field.png'), styledFieldNative.data)
		await openWorkspace('正文')
		await notesToolbar.getByRole('button', { name: '撤销', exact: true }).click()
		assert.equal(
			await notes.innerHTML(),
			beforeStyledPaste,
			'A styled field paste is one undo step',
		)
		// Settle the undo compilation before asserting a new validation message.
		await currentPreview(page)
		const invalidStyledHtml = '<p><span style="font-size:calc(12pt + 1pt)">Invalid style</span></p>'
		await pasteHtml(page, notes, invalidStyledHtml, 'Invalid style')
		await poll(() => containsText(page.getByRole('alert'), /UNSUPPORTED_HTML/), true)
		assert.equal(
			await notes.innerHTML(),
			beforeStyledPaste,
			'Invalid CSS paste leaves content intact',
		)
		await writeFile(
			join(evidence, 'browser-imports.json'),
			JSON.stringify(
				{
					markdown: browserMarkdown,
					htmlTable,
					noticeHtml,
					styledImport,
					styledRoundtrip,
					partialStyleImport,
					nestedStyleImport,
					styledFieldImport,
					htmlRejections,
				},
				null,
				2,
			),
		)
		await openWorkspace('AI 候选')
		await candidateInput.fill(acceptedMarkdown)
		await page.getByRole('checkbox', { name: '允许接纳候选', exact: true }).uncheck()
		await openWorkspace('AI 候选')
		await page.getByRole('button', { name: '固定候选目标', exact: true }).click()
		await page.getByRole('button', { name: '查看修改预览', exact: true }).click()
		await openWorkspace('AI 候选')
		assert.equal(
			await page.getByRole('button', { name: '接纳候选', exact: true }).isDisabled(),
			true,
		)
		assert.match(await text(page.getByRole('alert')), /FORBIDDEN_REGION/)
		assert.equal(await text(notes), originalNotes)
		await page.getByRole('checkbox', { name: '允许接纳候选', exact: true }).check()
		await openWorkspace('AI 候选')
		await candidateInput.fill('<data-field path=\'["unknown"]\'></data-field>')
		await openWorkspace('AI 候选')
		await page.getByRole('button', { name: '固定候选目标', exact: true }).click()
		await page.getByRole('button', { name: '查看修改预览', exact: true }).click()
		await openWorkspace('AI 候选')
		assert.equal(
			await page.getByRole('button', { name: '接纳候选', exact: true }).isDisabled(),
			true,
		)
		assert.match(await text(page.getByRole('alert')), /INVALID_FIELD/)
		assert.equal(await text(notes), originalNotes)
		await openWorkspace('AI 候选')
		await candidateInput.fill(acceptedMarkdown)
		await openWorkspace('AI 候选')
		await page.getByRole('button', { name: '固定候选目标', exact: true }).click()
		await page.getByRole('button', { name: '查看修改预览', exact: true }).click()
		await openWorkspace('正文')
		await notes.click()
		await notes.press('ControlOrMeta+End')
		await waitForEditorSelection(notes)
		await page.evaluate(() => {
			;(window as any).compositionEvents = []
			for (const type of ['compositionstart', 'compositionupdate', 'compositionend'])
				document.addEventListener(type, (event) =>
					(window as any).compositionEvents.push({ type, data: (event as CompositionEvent).data }),
				)
		})
		const cdp = await context.newCDPSession(page)
		await cdp.send('Input.imeSetComposition', {
			text: '中文输入',
			selectionStart: 4,
			selectionEnd: 4,
		})
		await cdp.send('Input.insertText', { text: '中文输入' })
		await poll(() => containsText(notes, /中文输入/), true)
		const compositionEvents = await page.evaluate(() => (window as any).compositionEvents)
		assert.ok(compositionEvents.some((event: any) => event.type === 'compositionstart'))
		assert.ok(compositionEvents.some((event: any) => event.type === 'compositionend'))
		await notes.press('Shift+Home')
		await waitForEditorSelection(notes)
		await openWorkspace('正文')
		await openFormat(page, notesToolbar)
		await formatDialog.getByRole('button', { name: '加粗', exact: true }).click()
		assert.match(await text(notes.locator('strong')), /中文输入/)
		await openWorkspace('正文')
		await openFormat(page, notesToolbar)
		await formatDialog.getByRole('button', { name: '列表', exact: true }).click()
		await notes.locator('ul li').waitFor()
		await openWorkspace('正文')
		await notesToolbar.getByRole('button', { name: '撤销', exact: true }).click()
		assert.equal(await notes.locator('ul li').count(), 0)
		await openWorkspace('正文')
		await notesToolbar.getByRole('button', { name: '重做', exact: true }).click()
		await notes.locator('ul li').waitFor()

		await openWorkspace('AI 候选')
		await page.getByRole('button', { name: '固定候选目标', exact: true }).click()
		await page.getByRole('button', { name: '查看修改预览', exact: true }).click()
		await page.getByRole('combobox', { name: '客户', exact: true }).selectOption('Acme')
		const beforeCandidate = await text(notes)
		await openWorkspace('AI 候选')
		await page.getByRole('button', { name: '接纳候选', exact: true }).click()
		assert.match(await text(page.getByRole('alert')), /STALE_CANDIDATE/)
		assert.equal(await text(notes), beforeCandidate)
		await openWorkspace('AI 候选')
		await page.getByRole('button', { name: '固定候选目标', exact: true }).click()
		await page.getByRole('button', { name: '查看修改预览', exact: true }).click()
		await openWorkspace('AI 候选')
		await page.getByRole('button', { name: '接纳候选', exact: true }).click()
		await notes.getByText('Accepted candidate', { exact: true }).waitFor()
		await openWorkspace('正文')
		await notesToolbar.getByRole('button', { name: '撤销', exact: true }).click()
		assert.equal(await text(notes), beforeCandidate, 'A candidate is exactly one undo step')
		await openWorkspace('正文')
		await notesToolbar.getByRole('button', { name: '重做', exact: true }).click()
		await notes.getByText('Accepted candidate', { exact: true }).waitFor()
		await notes.press('ControlOrMeta+End')
		await waitForEditorSelection(notes)
		await notes.press('Enter')
		await page.evaluate(() =>
			navigator.clipboard.writeText('| A | B |\n| --- | --- |\n| first | second |'),
		)
		await notes.press('ControlOrMeta+V')
		await notes.locator('table').waitFor()
		await notes.locator('td p').first().click()
		await openWorkspace('正文')
		const tableMenu = await openFormat(page, notesToolbar, '表格操作')
		await page.screenshot({ path: join(evidence, '10-table-menu.png'), fullPage: true })
		await tableMenu.getByRole('button', { name: '增加行', exact: true }).click()
		await poll(() => notes.locator('tr').count(), 3)
		await openWorkspace('正文')
		await notesToolbar.getByRole('button', { name: '撤销', exact: true }).click()
		assert.equal(await notes.locator('tr').count(), 2, 'One undo restores only the table operation')
		await openWorkspace('正文')
		await notesToolbar.getByRole('button', { name: '重做', exact: true }).click()
		await poll(() => notes.locator('tr').count(), 3)
		await notes.locator('td p').first().click()
		await insertContent(page, notesToolbar, '客户名称')
		await notes.locator('table [data-data-field]').waitFor()
		await page.screenshot({
			path: join(evidence, '03-table-composition-candidate.png'),
			fullPage: true,
		})

		await page.getByRole('button', { name: '正文', exact: true }).click()
		const body = page.getByTestId('region-body').locator('.tiptap')
		const bodyRegion = page.getByTestId('region-body')
		const bodyToolbar = bodyRegion.getByRole('toolbar', { name: '正文格式', exact: true })
		const typographyToolbar = formatDialog.getByRole('toolbar', { name: '排版扩展', exact: true })
		const fontFamily = typographyToolbar.getByRole('combobox', { name: '字体', exact: true })
		const fontSize = typographyToolbar.getByRole('combobox', { name: '字号', exact: true })
		await body.locator('h2').click()
		await body.press('ControlOrMeta+Home')
		await body.press('ControlOrMeta+Shift+ArrowRight')
		await poll(() => page.evaluate(() => window.getSelection()?.toString().trim()), 'Editable')
		await waitForEditorSelection(body)
		await openFormat(page, bodyToolbar)
		assert.deepEqual(await fontFamily.locator('option').allTextContents(), [
			'模板字体',
			...fixture.fontFamilies,
		])
		const bodyHeading = body.locator('h2')
		// Selection decorations depend on focus; undo must restore the native content and marks.
		const headingSnapshot = () =>
			body.evaluate((element) => {
				const heading = (element as TiptapEditorHTMLElement).editor
					?.getJSON()
					.content?.find((node) => node.type === 'heading')
				if (!heading) throw new Error('Expected the native body heading')
				return heading
			})
		async function typographyStep(
			action: () => Promise<unknown>,
			attribute: string,
			value: string,
		) {
			const before = await headingSnapshot()
			await openFormat(page, bodyToolbar)
			await action()
			await poll(
				() =>
					bodyHeading
						.locator('span[style]')
						.evaluate((element, property) => element.style.getPropertyValue(property), attribute),
				value,
			)
			assert.equal(await formatDialog.isVisible(), true, 'Formatting keeps the context open')
			await currentPreview(page)
			const after = await headingSnapshot()
			await bodyToolbar.getByRole('button', { name: '撤销', exact: true }).click()
			assert.deepEqual(await headingSnapshot(), before, `${attribute} changes are one undo step`)
			await bodyToolbar.getByRole('button', { name: '重做', exact: true }).click()
			assert.deepEqual(await headingSnapshot(), after, `${attribute} redo preserves prior styles`)
		}
		await typographyStep(
			() => fontFamily.selectOption('Noto Serif CJK SC'),
			'font-family',
			'"Noto Serif CJK SC"',
		)
		await typographyStep(
			() => fontFamily.selectOption('Liberation Serif'),
			'font-family',
			'"Liberation Serif"',
		)
		await typographyStep(() => fontSize.selectOption('18pt'), 'font-size', '18pt')
		await typographyStep(
			async () => {
				await typographyToolbar.getByRole('button', { name: '文字颜色', exact: true }).click()
				await page
					.getByRole('dialog', { name: '文字颜色', exact: true })
					.getByRole('button', { name: '红色', exact: true })
					.click()
			},
			'color',
			'rgb(220, 38, 38)',
		)
		await typographyStep(
			async () => {
				await typographyToolbar.getByRole('button', { name: '背景颜色', exact: true }).click()
				await page
					.getByRole('dialog', { name: '背景颜色', exact: true })
					.getByRole('button', { name: '黄色', exact: true })
					.click()
			},
			'background-color',
			'rgb(254, 240, 138)',
		)
		await currentPreview(page)
		const beforeColorCancel = await headingSnapshot()
		const beforeColorCancelRevision = await text(page.getByTestId('revision'))
		await openFormat(page, bodyToolbar)
		await typographyToolbar.getByRole('button', { name: '文字颜色', exact: true }).click()
		const textPalette = page.getByRole('dialog', { name: '文字颜色', exact: true })
		const colorInput = textPalette.getByRole('textbox', { name: '色值', exact: true })
		await colorInput.fill('var(--unsupported-color)')
		assert.equal(await colorInput.getAttribute('aria-invalid'), 'true')
		assert.equal(
			await textPalette.getByRole('button', { name: '应用', exact: true }).isDisabled(),
			true,
		)
		await colorInput.fill('#abcdef')
		assert.equal(
			await textPalette.getByRole('button', { name: '应用', exact: true }).isDisabled(),
			false,
		)
		await colorInput.press('Escape')
		assert.equal(await textPalette.count(), 0)
		assert.equal(await formatDialog.isVisible(), true, 'Escape only dismisses the color palette')
		assert.deepEqual(await headingSnapshot(), beforeColorCancel, 'Escape cancels an edited color')
		assert.equal(await text(page.getByTestId('revision')), beforeColorCancelRevision)
		await typographyStep(
			async () => {
				await typographyToolbar.getByRole('button', { name: '文字颜色', exact: true }).click()
				await colorInput.fill('#123abc')
				await textPalette.getByRole('button', { name: '应用', exact: true }).click()
			},
			'color',
			'rgb(18, 58, 188)',
		)
		await bodyToolbar.getByRole('button', { name: '撤销', exact: true }).click()
		assert.deepEqual(await headingSnapshot(), beforeColorCancel)
		for (const [label, attribute, preserved] of [
			['文字颜色', 'color', 'background-color'],
			['背景颜色', 'background-color', 'color'],
		] as const) {
			await typographyStep(
				async () => {
					await typographyToolbar.getByRole('button', { name: label, exact: true }).click()
					await page
						.getByRole('dialog', { name: label, exact: true })
						.getByRole('button', { name: '清除颜色', exact: true })
						.click()
				},
				attribute,
				'',
			)
			assert.equal(
				await bodyHeading
					.locator('span[style]')
					.evaluate((element, property) => element.style.getPropertyValue(property), preserved),
				preserved === 'color' ? 'rgb(220, 38, 38)' : 'rgb(254, 240, 138)',
				'Clearing a color preserves the other color attribute',
			)
			await openFormat(page, bodyToolbar)
			assert.equal(await fontFamily.inputValue(), 'Liberation Serif')
			assert.equal(await fontSize.inputValue(), '18pt')
			await bodyToolbar.getByRole('button', { name: '撤销', exact: true }).click()
			assert.deepEqual(await headingSnapshot(), beforeColorCancel)
		}
		const completeTypography = await headingSnapshot()
		await openFormat(page, bodyToolbar)
		await typographyToolbar.getByRole('button', { name: '清除排版', exact: true }).click()
		assert.equal(await bodyHeading.locator('span[style]').count(), 0)
		assert.equal(await text(bodyHeading), 'Editable overview')
		await bodyToolbar.getByRole('button', { name: '撤销', exact: true }).click()
		assert.deepEqual(
			await headingSnapshot(),
			completeTypography,
			'One undo restores all four styles',
		)
		await bodyToolbar.getByRole('button', { name: '重做', exact: true }).click()
		assert.equal(await bodyHeading.locator('span[style]').count(), 0)
		await bodyToolbar.getByRole('button', { name: '撤销', exact: true }).click()
		assert.deepEqual(await headingSnapshot(), completeTypography)
		await currentPreview(page)
		assert.match(latestTemplateFiles['_editor/regions/body.typ']!, /Liberation Serif/)
		assert.match(latestTemplateFiles['_editor/regions/body.typ']!, /18pt/)
		await writeFile(
			join(evidence, 'typography-template-files.json'),
			JSON.stringify(latestTemplateFiles, null, 2),
		)
		const styledNative = await session.renderPage({
			revision: latest!.preview.revision,
			page: 1,
			scale: 1.5,
		})
		await writeFile(join(evidence, 'native-typography.png'), styledNative.data)
		await page.getByRole('button', { name: 'Fixed template', exact: true }).click()
		await page.evaluate(() => window.scrollTo(0, 0))
		await page.screenshot({ path: join(evidence, '11-typography-desktop.png'), fullPage: true })
		await page.setViewportSize({ width: 390, height: 844 })
		await openFormat(page, bodyToolbar)
		await typographyToolbar.scrollIntoViewIfNeeded()
		await typographyToolbar.getByRole('button', { name: '背景颜色', exact: true }).click()
		const backgroundPalette = page.getByRole('dialog', { name: '背景颜色', exact: true })
		await backgroundPalette.waitFor()
		assert.equal(
			await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
			false,
			'The formatting context and color palette fit the mobile viewport',
		)
		const paletteBounds = await backgroundPalette.boundingBox()
		assert.ok(
			paletteBounds &&
				paletteBounds.x >= 0 &&
				paletteBounds.x + paletteBounds.width <= 390 &&
				paletteBounds.y >= 0 &&
				paletteBounds.y + paletteBounds.height <= 844,
		)
		await page.screenshot({ path: join(evidence, '12-typography-mobile.png') })
		await backgroundPalette.getByRole('button', { name: '黄色', exact: true }).click()
		assert.equal(await formatDialog.isVisible(), true, 'Mobile color changes retain the context')
		await formatDialog.getByRole('button', { name: '关闭格式', exact: true }).click()
		// Explicitly closing the format panel returns the native editor focus for further typing.
		await poll(
			() =>
				body.evaluate((element) => (element as TiptapEditorHTMLElement).editor?.view.hasFocus()),
			true,
		)
		await waitForEditorSelection(body)
		await page.setViewportSize({ width: 1440, height: 1100 })
		await body.press('ControlOrMeta+End')
		await waitForCollapsedEditorSelection(body)
		await insertContent(page, bodyToolbar, '提示块')
		await body.locator('aside').waitFor()
		assert.deepEqual(
			await headingSnapshot(),
			completeTypography,
			'Inserting a notice retains typography',
		)
		await page.getByRole('button', { name: '保存', exact: true }).click()
		await body.press('ControlOrMeta+End')
		await waitForCollapsedEditorSelection(body)
		await page.keyboard.insertText(' temporary unsaved text')
		await openWorkspace('正文')
		await page.getByRole('button', { name: '备注', exact: true }).click()
		await page.getByRole('button', { name: '正文', exact: true }).click()
		assert.ok(
			await containsText(body, /temporary unsaved text/),
			'Switching regions retains the draft',
		)
		await currentPreview(page)
		const savedText = await page.evaluate(() => localStorage.getItem('typst-consumer-draft')!)
		const unsavedBody = await text(body)
		for (const [field, value, code] of [
			['formatVersion', 2, 'INVALID_DRAFT'],
			['templateRevision', 'stale-template', 'TEMPLATE_CONFLICT'],
		] as const) {
			await page.evaluate(
				({ saved, key, next }) => {
					const invalid = JSON.parse(saved)
					invalid.draft[key] = next
					localStorage.setItem('typst-consumer-draft', JSON.stringify(invalid))
				},
				{ saved: savedText, key: field, next: value },
			)
			await page.getByRole('button', { name: '重开', exact: true }).click()
			assert.match(await text(page.getByRole('alert')), new RegExp(code))
			assert.equal(await text(body), unsavedBody, 'Rejected drafts retain the active content')
		}
		await page.evaluate((saved) => localStorage.setItem('typst-consumer-draft', saved), savedText)
		await page.getByRole('button', { name: '重开', exact: true }).click()
		assert.doesNotMatch(await text(body), /temporary unsaved text/)
		await body.locator('aside').waitFor()
		assert.deepEqual(await headingSnapshot(), completeTypography, 'Reopening retains typography')
		assert.match(await text(body), /Acme!/)
		assert.doesNotMatch(await text(body), /Acme!!/)
		await currentPreview(page)
		const [download] = await Promise.all([
			page.waitForEvent('download'),
			page.getByRole('button', { name: '导出当前 PDF', exact: true }).click(),
		])
		await download.saveAs(join(evidence, 'downloaded.pdf'))
		const downloadedPdf = await readFile(join(evidence, 'downloaded.pdf'))
		assert.equal(downloadedPdf.subarray(0, 5).toString(), '%PDF-')
		const png = await session.renderPage({
			revision: latest!.preview.revision,
			page: 1,
			scale: 1.5,
		})
		await writeFile(join(evidence, 'native-page-1.png'), png.data)
		await page.screenshot({ path: join(evidence, '04-reopened.png'), fullPage: true })
		await page.setViewportSize({ width: 390, height: 844 })
		await page
			.getByRole('navigation', { name: '编辑与预览', exact: true })
			.getByRole('button', { name: '预览', exact: true })
			.click()
		await page.locator('.preview-pane').scrollIntoViewIfNeeded()
		await page.getByRole('button', { name: 'Fixed template', exact: true }).click()
		await poll(() => text(page.getByTestId('page')), '1 / 3')
		await page.evaluate(
			() =>
				new Promise<void>((done) =>
					requestAnimationFrame(() => requestAnimationFrame(() => done())),
				),
		)
		await page.screenshot({ path: join(evidence, '05-mobile.png'), fullPage: true })
		assert.equal(browserErrors.length, 0, browserErrors.join('\n'))
		const stored = await page.evaluate(() =>
			JSON.parse(localStorage.getItem('typst-consumer-draft')!),
		)
		assert.equal(stored.draft.data.customer.name, 'Acme')
		const savedStyle = stored.draft.regions.body.content[0].content[0].marks.find(
			(mark: any) => mark.type === 'textStyle',
		)
		assert.equal(savedStyle.attrs.fontFamily, 'Liberation Serif')
		assert.equal(savedStyle.attrs.fontSize, '18pt')
		assert.ok(savedStyle.attrs.color)
		assert.ok(savedStyle.attrs.backgroundColor)
		await writeFile(join(evidence, 'saved-draft.json'), JSON.stringify(stored, null, 2))
		await writeFile(join(evidence, 'composition.json'), JSON.stringify(compositionEvents, null, 2))
		stages.push(
			'Chromium: real native preview/PDF and compile failure recovery, template and generated navigation, zoom/modifier/drag filtering, paragraph styles and explicit format context, shared insertion/slash filtering/Arrow/Enter/Escape and one-step undo, mobile menus, contextual fonts/size/text and background colors, retained format panel and palette-only cancellation, one-step styling and reset history, live field data, composition, selection formatting, lists, native undo/redo, Markdown table and styled HTML paste, supported CSS roundtrip and invalid CSS rejection, field insertion, consumer node, strict HTML and Markdown parity, permission/stale/complex/style-loss candidate rejection, region switching, typography-preserving validated save/reopen',
		)
	} catch (cause) {
		await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true })
		await writeFile(join(evidence, 'failure.html'), await page.content())
		await writeFile(
			join(evidence, 'failure-selection.json'),
			JSON.stringify(
				await page.locator('.tiptap').evaluateAll((elements) => ({
					domSelection: document.getSelection()?.toString(),
					activeElement: document.activeElement?.outerHTML,
					editors: elements.map((element) => {
						const editor = (element as TiptapEditorHTMLElement).editor
						return {
							region: element.getAttribute('data-typst-region'),
							selection: editor?.state.selection.toJSON(),
							storedMarks: editor?.state.storedMarks?.map((mark) => mark.toJSON()),
						}
					}),
				})),
				null,
				2,
			),
		)
		throw cause
	} finally {
		await writeFile(join(evidence, 'commands.log'), log.join('\n\n'))
		await writeFile(join(evidence, 'compilations.json'), JSON.stringify(compilations, null, 2))
		await writeFile(
			join(evidence, 'summary.json'),
			JSON.stringify(
				{
					stages,
					output,
					browserErrors,
					nodeMarkdown,
					samples: compilations.length,
					hostStartMs,
					fontsPreparedMs,
					sessionOpenMs,
					browserReadyMs,
				},
				null,
				2,
			),
		)
		console.info('Typst independent consumer evidence:', output, JSON.stringify(stages))
	}
})
