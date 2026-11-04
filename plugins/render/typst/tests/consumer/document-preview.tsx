import { useState } from 'react'
import { TypstDocumentPreview } from '@pluxel/plugin-typst/document/react'
import type { TypstDocumentLocation, TypstDocumentSelection } from '@pluxel/plugin-typst/document'
import type { DocumentClient, DocumentClientState } from './document-client'

export function DocumentPreview({
	state,
	client,
	selection,
	onSelect,
}: {
	state: DocumentClientState
	client: DocumentClient
	selection?: TypstDocumentSelection
	onSelect(location: TypstDocumentLocation): void
}) {
	const preview = state.view!.preview
	const pending = Object.keys(state.drafts).length > 0
	const current = preview?.revision === state.view!.revision && !pending && !state.view!.issue
	const [following, setFollowing] = useState(true)
	return (
		<section className="workspace-panel document-preview" aria-label="项目书预览">
			<div className="document-preview-toolbar">
				<span role="status">
					{state.view!.issue
						? '排版未完成'
						: !current
							? '正在更新预览…'
							: `共 ${preview!.pages.length} 页`}
				</span>
				<div className="document-preview-actions">
					<button type="button" aria-pressed={following} onClick={() => setFollowing(!following)}>
						跟随光标
					</button>
					<button
						type="button"
						disabled={state.busy || !current}
						onClick={() => {
							void client.exportPdf().catch(() => {})
						}}
					>
						下载 PDF
					</button>
				</div>
			</div>
			{state.view!.issue && (
				<p role="alert" className="document-notice">
					{state.view!.issue.message}
				</p>
			)}
			<TypstDocumentPreview
				preview={preview}
				revision={state.view!.revision}
				pending={pending || Boolean(state.view!.issue)}
				selection={selection}
				following={following}
				onSelect={onSelect}
			/>
		</section>
	)
}
