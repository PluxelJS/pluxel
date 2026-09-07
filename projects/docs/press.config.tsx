import { mcpPlugin } from '@fumapress/ai'
import { zhCN } from '@fumapress/language/zh-cn'
import { changelogPlugin, createChangelogIndexPage } from '@fumapress/tegami'
import { changelogMetaSchema, changelogPageSchema } from '@fumapress/tegami/schema'
import { defineTranslations } from 'fumadocs-core/i18n'
import { lucideIconsPlugin } from 'fumadocs-core/source/plugins/lucide-icons'
import { defineConfig } from 'fumapress'
import { fumadocsMdx } from 'fumapress/adapters/mdx'
import { metaSchema, pageSchema } from 'fumapress/adapters/mdx/schema'
import { createHomeLayout } from 'fumapress/layouts/home'
import { createNotebookLayoutPage } from 'fumapress/layouts/notebook'
import { takumiPlugin } from 'fumapress/plugins/takumi'
import { generateOgImage } from './src/components/og-image'
import { linkValidationPlugin } from 'fumapress/plugins/link-validation'
import { createRelativeLink } from 'fumadocs-ui/mdx'
import { defineDocs } from 'fumadocs-mdx/macro'
import { BookOpen, FlaskConical, History } from 'lucide-react'
import { fileURLToPath } from 'node:url'
import { ConfigurationExampleLayout } from './src/components/configuration-example-layout'
import { ConfigurationPreviewLoader } from './src/components/configuration-preview-loader'
import { getMDXComponents } from './src/components/mdx'

const docs = defineDocs({
	dir: '../../docs',
	docs: {
		async: true,
		lastModified: true,
		postprocess: {
			includeProcessedMarkdown: true,
		},
		schema: pageSchema,
	},
	meta: {
		schema: metaSchema,
	},
})

const changelog = defineDocs({
	dir: 'content/changelog',
	docs: {
		async: true,
		lastModified: true,
		postprocess: {
			includeProcessedMarkdown: true,
		},
		schema: changelogPageSchema,
	},
	meta: {
		schema: changelogMetaSchema,
	},
})

const docsProjectRoot = fileURLToPath(new URL('.', import.meta.url))

const content = {
	docs: docs.toFumadocsSource({ baseDir: 'docs' }),
	changelog: changelog.toFumadocsSource({ baseDir: 'changelog' }),
}

const translations = defineTranslations().preset(zhCN())

const NotebookLayout = createNotebookLayoutPage<typeof config.$context>({
	async render(page) {
		const source = await this.getLoader()
		let tree = source.getPageTree(page.locale)
		const docsRoot = tree.children.find((child) => child.type === 'folder' && child.$id === 'docs')

		if (docsRoot?.type === 'folder') {
			tree = {
				...tree,
				children: docsRoot.children,
			}
		}

		return { layoutProps: { tree } }
	},
})

const changelogPage = createChangelogIndexPage<typeof config.$context>({
	description: '查看 Pluxel 各个 package 的版本更新与发布说明。',
	heading: '更新日志',
})

const config = defineConfig({
	content,
	defaultLayoutProps: {
		links: [
			{
				text: (
					<span className="inline-flex items-center gap-2">
						<BookOpen aria-hidden="true" className="size-4 shrink-0" />
						文档
					</span>
				),
				url: '/docs',
				active: 'nested-url',
			},
			{
				text: (
					<span className="inline-flex items-center gap-2">
						<History aria-hidden="true" className="size-4 shrink-0" />
						更新日志
					</span>
				),
				url: '/changelog',
			},
			{
				type: 'button',
				text: (
					<span className="inline-flex items-center gap-2">
						<FlaskConical aria-hidden="true" className="size-4 shrink-0" />
						配置 Playground
					</span>
				),
				url: '/playground',
			},
		],
		nav: {
			title: 'Pluxel',
		},
	},
	loaderOptions: {
		plugins: [lucideIconsPlugin()],
	},
	meta: {
		root() {
			return (
				<>
					<link rel="preconnect" href="https://fonts.googleapis.com" />
					<link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
					<link
						rel="stylesheet"
						href="https://fonts.googleapis.com/css2?family=Geist:wght@100..900&family=JetBrains+Mono:wght@100..800&display=swap"
					/>
				</>
			)
		},
	},
	mode: 'default',
	preset: 'recommended',
	renderPage: (props) => <NotebookLayout {...props} />,
	site: {
		baseUrl: 'https://www.pluxel.dev',
		git: {
			branch: 'main',
			repo: 'pluxel',
			// The MDX adapter reports source paths from this project directory even
			// though the canonical content directory lives at the repository root.
			rootDir: docsProjectRoot,
			user: 'PluxelJS',
		},
		name: 'www.pluxel.dev',
	},
	translations,
})
	.adapters(
		fumadocsMdx({
			getMdxComponents: async function (page) {
				return getMDXComponents({
					a: createRelativeLink(await this.getLoader(), page),
					ConfigurationExampleLayout,
					ConfigurationPreviewLoader,
				})
			},
		}),
	)
	.plugins(
		takumiPlugin({
			generate(page) {
				return generateOgImage({ ...page.data, site: this.siteConfig.name })
			},
		}),
		linkValidationPlugin(),
		mcpPlugin(),
		changelogPlugin({
			layouts: {
				index: changelogPage,
			},
		}),
	)

export const HomeLayout = createHomeLayout<typeof config.$context>()

export default config
