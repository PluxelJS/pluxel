import { createMetadataFactory, type MetadataAction } from '~/core/utils/metaFactories'

/**
 * 字段徽章配置
 */
export interface FieldBadgeMeta {
	/** 徽章文本 */
	label: string
	/** 徽章颜色 */
	color?: string
}

/**
 * 字段分组配置
 */
export interface FieldSectionMeta {
	/** 分组ID（必需） */
	id: string
	/** 分组标题 */
	title?: string
	/** 分组描述 */
	description?: string
	/** 分组列数（用于字段布局） */
	columns?: number
	/** 分组排序（数字越小越靠前） */
	order?: number
}

/**
 * 字段布局配置
 */
export interface FieldLayoutMeta {
	/** 字段占据的列数（仅当父容器是网格布局时有效） */
	span?: number
	/** 字段在容器中的对齐方式 */
	align?: 'start' | 'center' | 'end' | 'stretch'
	/** 是否占满整行 */
	fullWidth?: boolean
}

/**
 * 表单字段元数据
 *
 * 设计原则：
 * 1. label 是字段显示名称（必需）
 * 2. 所有可选字段都是纯可选，不需要提供时就不传
 * 3. 命名直观，符合表单场景
 */
export interface FormMeta {
	/** 字段显示标签（主要显示名称） */
	label?: string

	/** 字段描述文本（显示在输入框上方，灰色小字） */
	description?: string

	/** 辅助文本（显示在输入框下方） */
	helperText?: string

	/** 提示信息（通常显示为 tooltip 或 hint） */
	hint?: string

	/** Tooltip 文本（鼠标悬停时显示） */
	tooltip?: string

	/** 字段徽章（显示在 label 旁边） */
	badge?: string | FieldBadgeMeta

	/** 字段所属分组 */
	section?: string | FieldSectionMeta

	/** 字段布局配置 */
	layout?: FieldLayoutMeta

	/** 是否隐藏字段 */
	hidden?: boolean

	/** 是否禁用字段 */
	disabled?: boolean

	/** 是否只读 */
	readOnly?: boolean

	/** 是否使用内联标签布局 */
	inlineLabel?: boolean

	/** 是否隐藏必填标记（*），用于嵌套场景 */
	hideRequired?: boolean
}

export type formMetaAction<TInput, TMetadata extends FormMeta> = MetadataAction<
	'form',
	TInput,
	TMetadata
>

/**
 * 创建表单元数据
 * @param metadata_ 元数据对象
 * @returns 元数据 action
 */
// @__NO_SIDE_EFFECTS__
export const formMeta = createMetadataFactory<'form'>('form')
