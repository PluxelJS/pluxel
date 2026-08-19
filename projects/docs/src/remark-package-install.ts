interface MarkdownNode {
	type: string
	lang?: string
	meta?: string
	value?: string
	children?: MarkdownNode[]
	data?: Record<string, unknown>
	[key: string]: unknown
}

export function remarkPackageInstall() {
	return (tree: MarkdownNode) => {
		function visit(node: MarkdownNode) {
			if (
				node.type === 'code' &&
				node.lang === 'sh' &&
				node.meta?.split(/\s+/).includes('package-install')
			) {
				const command = node.value?.trim() ?? ''
				const match = /^npx nypm add (?:(-D|-g) )?(.+)$/.exec(command)
				if (!match) throw new Error(`Invalid package-install command: ${command}`)

				const flag = match[1]
				Object.assign(node, {
					type: 'mdxJsxFlowElement',
					name: 'PackageInstall',
					data: {
						...node.data,
						_stringify: { text: `\`\`\`sh\n${command}\n\`\`\`` },
					},
					attributes: [
						{ type: 'mdxJsxAttribute', name: 'packages', value: match[2] },
						...(flag === '-D' ? [{ type: 'mdxJsxAttribute', name: 'dev', value: 'true' }] : []),
						...(flag === '-g' ? [{ type: 'mdxJsxAttribute', name: 'global', value: 'true' }] : []),
					],
					children: [],
				})
				return
			}

			for (const child of node.children ?? []) visit(child)
		}

		visit(tree)
	}
}
