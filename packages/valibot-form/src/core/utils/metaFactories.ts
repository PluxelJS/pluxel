import type { BaseMetadata } from 'valibot'
import type { CheckMetaType, MetaType, MetaTypeReturn } from './MetaType'

/** 标准化的 metadata action 形状，约束 type/metadata/reference 三者的一致性 */
export interface MetadataAction<
	TType extends MetaType,
	TInput,
	TMetadata extends MetaTypeReturn<TType>,
> extends BaseMetadata<TInput> {
	readonly type: CheckMetaType<TType>
	readonly reference: MetadataFactory<TType>
	readonly metadata: TMetadata
}

/** 所有 metadata 工厂函数的通用签名 */
export type MetadataFactory<TType extends MetaType, TInputConstraint = unknown> = <
	TInput extends TInputConstraint,
	const TMetadata extends MetaTypeReturn<TType>,
>(
	metadata: TMetadata,
) => MetadataAction<TType, TInput, TMetadata>

/**
 * 统一创建 metadata action 工厂，避免在每个 action 内重复定义类型。
 */
export function createMetadataFactory<TType extends MetaType, TInputConstraint = unknown>(
	type: TType,
): MetadataFactory<TType, TInputConstraint> {
	const factory = (<TInput extends TInputConstraint, const TMetadata extends MetaTypeReturn<TType>>(
		metadata: TMetadata,
	) => ({
		kind: 'metadata' as const,
		type,
		reference: factory,
		metadata,
	})) as MetadataFactory<TType, TInputConstraint>

	return factory
}
