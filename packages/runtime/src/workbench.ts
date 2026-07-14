export type * from './workbench/contracts'
export { workbench } from './workbench/runtime'
export type * from './workbench/runtime'
export { doc as workbenchDoc } from './workbench/document-contracts'
export type {
	BuiltinActionBlock as WorkbenchActionBlock,
	BuiltinBadgeValue as WorkbenchBadgeValue,
	BuiltinDocBlock as WorkbenchDocumentBlock,
	BuiltinDocContent as WorkbenchDocumentContent,
	BuiltinDocExtensionDef as WorkbenchDocumentDefinition,
	BuiltinDocPart as WorkbenchDocumentPart,
	BuiltinFieldValueRef as WorkbenchFieldValueRef,
	BuiltinFormBlock as WorkbenchFormBlock,
	BuiltinGeneratedIdValue as WorkbenchGeneratedIdValue,
	BuiltinInfoCardBlock as WorkbenchInfoCardBlock,
	BuiltinMarkdownPart as WorkbenchMarkdownPart,
	BuiltinNowValue as WorkbenchNowValue,
	BuiltinResourceSelectBlock as WorkbenchResourceSelectBlock,
	BuiltinSignalDbRef as WorkbenchCollectionRef,
	BuiltinSignalDbWriteSpec as WorkbenchCollectionWrite,
	BuiltinSyncRef as WorkbenchSyncRef,
	BuiltinTemplateValue as WorkbenchTemplateValue,
} from './workbench/document-contracts'
