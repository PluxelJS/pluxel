import { fumadocsMdx } from 'fumapress/adapters/mdx'
import { metaSchema, pageSchema } from 'fumapress/adapters/mdx/schema'
import { createDocsLayoutPage } from 'fumapress/layouts/docs'
import { defineConfig } from 'fumapress'
import { flexsearchPlugin } from 'fumapress/plugins/flexsearch'
import { linkValidationPlugin } from 'fumapress/plugins/link-validation'
import { createRelativeLink } from 'fumadocs-ui/mdx'
import { defineDocs } from 'fumadocs-mdx/macro'
import { FlaskConical } from 'lucide-react'
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

const docsProjectRoot = fileURLToPath(new URL('.', import.meta.url))

const content = docs.toFumadocsSource({ baseDir: 'docs' })

const docsPage = createDocsLayoutPage({
	render: async function (page) {
		const body = await this.getPageBody(page)
		if (!body) throw new Error(`Missing MDX body for ${page.path}`)

		return {
			body: body.node,
		}
	},
})

export default defineConfig({
	content,
	defaultLayoutProps: {
		links: [
			{
				type: 'button',
				text: '配置 Playground',
				url: '/playground',
				icon: <FlaskConical />,
			},
		],
		nav: {
			title: 'Pluxel',
		},
	},
	loaderOptions: {
		slugs(file) {
			if (file.path === 'docs/README.md') return ['docs']
			return undefined
		},
	},
	mode: 'default',
	renderPage: docsPage,
	site: {
		baseUrl: 'https://docs.pluxel.dev',
		git: {
			branch: 'main',
			repo: 'pluxel',
			// The MDX adapter reports source paths from this project directory even
			// though the canonical content directory lives at the repository root.
			rootDir: docsProjectRoot,
			user: 'PluxelJS',
		},
		name: 'Pluxel',
	},
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
	.plugins(linkValidationPlugin(), flexsearchPlugin())
