// union/type.ts

/**
 * 用于描述 Union/Variant 字段的渲染偏好。
 *
 * 目标：让「开关开启后出现配置对象」这类场景开箱即用，同时保留复杂判别联合的可扩展性。
 *
 * @example
 * ```ts
 * // 开关开启后显示配置
 * v.pipe(
 *   v.variant('enabled', [
 *     v.object({ enabled: v.literal(false) }),
 *     v.object({ enabled: v.literal(true), config: v.object({ foo: v.string() }) }),
 *   ]),
 *   unionMeta({ discriminator: 'enabled', variant: 'auto' }), // 自动识别为 switch
 * )
 *
 * // 经典判别联合
 * v.pipe(
 *   v.union([
 *     v.object({ type: v.literal('text'), value: v.string() }),
 *     v.object({ type: v.literal('number'), value: v.number() }),
 *   ]),
 *   unionMeta({ discriminator: 'type', variant: 'segmented' }),
 * )
 * ```
 */
export type UnionSelectorVariant = 'auto' | 'select' | 'segmented' | 'radio' | 'switch' | 'checkbox'

export type DiscriminatorExposeMode = 'auto' | 'always' | 'never'

export type UnionMetaOptions = {
	/**
	 * 判别字段名（用于判断当前是哪个分支）
	 *
	 * 该字段应在所有分支中存在，并使用 v.literal() 指定不同的值
	 *
	 * @example
	 * ```ts
	 * discriminator: 'type' // 将使用 value.type 来判断分支
	 * ```
	 */
	discriminator?: string

	/**
	 * 分支选项的显示标签配置
	 *
	 * @example
	 * ```ts
	 * branchLabels: {
	 *   foo: 'Foo 选项',
	 *   bar: 'Bar 选项',
	 * }
	 * ```
	 */
	branchLabels?: Record<string | number, string>

	/**
	 * 分支选项的描述文本
	 *
	 * @example
	 * ```ts
	 * branchDescriptions: {
	 *   foo: '这是 Foo 选项的详细说明',
	 *   bar: '这是 Bar 选项的详细说明',
	 * }
	 * ```
	 */
	branchDescriptions?: Record<string | number, string>

	/**
	 * 选择控件样式
	 *
	 * - `'select'`: 下拉选择框（默认）
	 * - `'segmented'`: 分段控件（适合 2~3 个分支）
	 * - `'radio'`: 单选按钮组（适合 4~5 个分支）
	 * - `'switch'` / `'checkbox'`: 布尔开关，专为 `true/false` 判别值设计
	 * - `'auto'`: 基于分支自动选择，布尔判别时优先使用 switch
	 */
	variant?: UnionSelectorVariant

	/**
	 * 是否可搜索（仅 select 时有效）
	 *
	 * @default false
	 */
	searchable?: boolean

	/**
	 * 占位符文本
	 *
	 * @default '选择类型'
	 */
	placeholder?: string

	/**
	 * 是否显示分支描述（仅 radio 时有效）
	 *
	 * @default false
	 */
	showBranchDescription?: boolean

	/**
	 * 是否展示判别字段自身
	 *
	 * - `'auto'`: 布尔判别且存在 schema 时直接渲染该字段，其余情况隐藏
	 * - `'always'`: 总是渲染判别字段（即便已经有选择器）
	 * - `'never'`: 只使用选择器，不渲染判别字段
	 */
	exposeDiscriminator?: DiscriminatorExposeMode

	/**
	 * 切换分支时是否保留各自已填写的值
	 *
	 * @default true
	 */
	preserveBranchValues?: boolean
}

/**
 * Union 提取结果（内部使用）
 */
export type UnionMetaResult = UnionMetaOptions & {
	/** 分支选项（从 union 的 options 提取） */
	branches: Array<{
		/** 分支的判别值 */
		discriminatorValue: string | number | boolean
		/** 分支的 schema */
		schema: any
		/** 分支的字段信息（由渲染器动态提取） */
		fields?: any[]
	}>
	/** 根层是否携带共享字段（intersect 情况下用于条件联动） */
	sharedFields: Array<{ key: string; schema: any }>
	/** 判别字段的 schema（来自共享层或推断） */
	discriminatorSchema?: any
	/** 判别字段来源 */
	discriminatorSource?: 'shared' | 'branch' | 'inferred' | 'none'
	/** 实际使用的选择控件 */
	resolvedVariant: Exclude<UnionSelectorVariant, 'auto'>
}
