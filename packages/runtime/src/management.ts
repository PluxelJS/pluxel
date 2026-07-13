export * from './management/contracts'
export { managementUi } from './management/declaration'
export * from './management/runtime'
export { doc as managementDoc } from './management/document-contracts'
export type {
	BuiltinActionBlock as ManagementActionBlock,
	BuiltinBadgeValue as ManagementBadgeValue,
	BuiltinDocBlock as ManagementDocumentBlock,
	BuiltinDocContent as ManagementDocumentContent,
	BuiltinDocExtensionDef as ManagementDocumentDefinition,
	BuiltinDocPart as ManagementDocumentPart,
	BuiltinFieldValueRef as ManagementFieldValueRef,
	BuiltinFormBlock as ManagementFormBlock,
	BuiltinGeneratedIdValue as ManagementGeneratedIdValue,
	BuiltinInfoCardBlock as ManagementInfoCardBlock,
	BuiltinMarkdownPart as ManagementMarkdownPart,
	BuiltinNowValue as ManagementNowValue,
	BuiltinResourceSelectBlock as ManagementResourceSelectBlock,
	BuiltinSignalDbRef as ManagementCollectionRef,
	BuiltinSignalDbWriteSpec as ManagementCollectionWrite,
	BuiltinSyncRef as ManagementSyncRef,
	BuiltinTemplateValue as ManagementTemplateValue,
} from './management/document-contracts'
