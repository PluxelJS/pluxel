import { PluginKey } from '@tiptap/pm/state'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

/** Shared UI observes source admission without loading a source project or parser. */
export const sourceSync = new PluginKey<{ local: boolean }>('typstSourceSync')
export interface SourceAdmissionReceipt {
	accepted: boolean
	doc: ProseMirrorNode
}
export const sourceAdmission = new PluginKey<SourceAdmissionReceipt>('typstSourceAdmissionReceipt')

/** An explicit host document replacement, rather than an edit from the local view. */
export const documentSync = new PluginKey('typstDocumentSync')
