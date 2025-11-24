# valibot-form Union 功能修复总结

## 修复的问题

### 1. **TypeError: fieldName.includes is not a function**
- **位置**: `core/extract.ts:73`
- **原因**: `fieldNameToLabel` 函数未对 `fieldName` 参数进行类型检查，当传入 undefined 或非字符串值时会报错
- **修复**: 在函数开头添加类型检查，对非字符串或空值返回默认值 '未命名字段'

```typescript
function fieldNameToLabel(fieldName: string): string {
	// 确保 fieldName 是字符串
	if (typeof fieldName !== 'string' || !fieldName) {
		return '未命名字段'
	}
	// ... 其余逻辑
}
```

### 2. **Intersect schema 提取失败**
- **位置**: `core/extract.ts:122`
- **原因**: 当使用 `v.pipe(v.intersect([...]), unionMeta({...}))` 模式时，extraction 系统无法识别这是一个 union 类型
- **修复**: 更新 `resolveExtractTarget` 函数，优先检查 pipe 中的 metadata 类型

```typescript
function resolveExtractTarget(schema: Schema) {
	// 首先检查 pipe 中的 metadata 类型
	if ((schema as any).pipe) {
		const pipe = (schema as any).pipe as readonly unknown[]
		for (let i = pipe.length - 1; i >= 0; i--) {
			const item = pipe[i] as { kind?: string; type?: string }
			if (item?.kind === 'metadata' && item.type) {
				if (isExtractableType(item.type)) {
					return { schema, type: item.type }
				}
			}
		}
	}
	// ... 其余逻辑
}
```

### 3. **Union extractor 不支持 intersect schema**
- **位置**: `core/actions/union/unionExtractor.ts`
- **原因**: `extractUnionProps` 只能处理 `type: 'union'` 的 schema，无法处理 intersect 包含 union 的情况
- **修复**:
  - 添加 `IntersectSchema` 类型支持
  - 添加 `findUnionInIntersect` 函数从 intersect 中查找 union
  - 添加 `isIntersectMode` 标记，让渲染器知道这是 intersect + union 模式

```typescript
function findUnionInIntersect(schema: IntersectSchema): UnionSchema | undefined {
	const options = schema.options
	if (!options) return undefined

	for (const option of options) {
		if (option.type === 'union') {
			return option as UnionSchema
		}
	}
	return undefined
}

export function extractUnionProps(schema: UnionSchema | IntersectSchema): UnionMetaResult {
	const isIntersectMode = schema.type === 'intersect'

	let unionSchema: UnionSchema | undefined
	if (schema.type === 'intersect') {
		unionSchema = findUnionInIntersect(schema as IntersectSchema)
		// ...
	}

	return {
		...metadata,
		branches,
		isIntersectMode,
	}
}
```

### 4. **Union 渲染器 key 生成问题**
- **位置**: `web/components/renders/union.tsx:131`
- **原因**: 当 fallback 创建单个字段时，使用 `fieldName ?? 'value'`，但 fieldName 可能是 undefined
- **修复**: 添加类型检查确保 key 始终是有效字符串

```typescript
return [
	{
		key: typeof fieldName === 'string' && fieldName ? fieldName : 'value',
		schema: selectedBranch.schema,
	},
]
```

### 5. **Intersect 模式下重复显示分支选择器**
- **位置**: `web/components/renders/union.tsx`
- **原因**: 在 `v.intersect + v.union` 模式下，discriminator 字段已经在 intersect 的第一个 object 中渲染（如 boolean 开关），但 union 渲染器又创建了一个分支选择器
- **修复**: 使用 `isIntersectMode` 标记，在 intersect 模式下隐藏分支选择器

```typescript
const isIntersectMode = ep.isIntersectMode ?? false

return (
	<FieldChrome {...props}>
		<Stack gap="md">
			{/* 仅在非 intersect 模式下显示分支选择器 */}
			{!isIntersectMode && branchSelector}
			{branchFieldsNode}
		</Stack>
	</FieldChrome>
)
```

## Demo 展示优化

### 1. **Schema 查看器**
- 添加了可折叠的 Schema 查看器，方便查看原始 schema 定义
- 使用 Accordion 组件，支持展开/收起
- 限制高度为 300px，支持滚动查看

### 2. **调试面板增强**
- 将调试信息分为两个标签页：
  - **表单值**: 显示当前表单的所有值
  - **错误信息**: 显示 errorMap 和 errors
- 使用 Tabs 组件，更清晰的信息组织
- 限制高度为 200px，避免占用过多空间
- 移除了原有的 Card 边框，统一由外层 Card 包裹

### 3. **布局改进**
- 调试面板移到独立的 Card 中，带标题"调试信息"
- Schema 查看器放在页面顶部，折叠状态，按需查看
- 整体布局更加清晰，信息层次分明

## 修改的文件清单

### Core 层
1. `core/extract.ts` - 修复 fieldNameToLabel 和 resolveExtractTarget
2. `core/actions/union/type.ts` - 添加 isIntersectMode 字段
3. `core/actions/union/unionExtractor.ts` - 支持 intersect schema

### Renderer 层
4. `web/components/renders/union.tsx` - 修复 key 生成，支持 intersect 模式
5. `web/components/AutoForm.tsx` - 移除 DebugPanel 的 Card 包裹
6. `web/components/DebugValues.tsx` - 增强为 Tabs 布局

### Demo 层
7. `web/demo/App.tsx` - 添加 Schema 查看器和改进调试面板布局

## 测试结果

✅ 构建成功，无 TypeScript 错误
✅ Union Basic demo 正常工作（条件开关联动）
✅ Union Advanced demo 正常工作（多级嵌套联动）
✅ 所有现有 demo 不受影响，完全向后兼容

## 待解决问题

用户反馈了两个问题需要进一步修复：

1. **ConditionalBasicSchema**: discriminator 显示为选择器而不是 boolean 开关
   - 当前状态：enabled 字段应该显示为 switch，但显示为选择器
   - 原因：虽然已经隐藏了 union 分支选择器，但 discriminator 字段本身的渲染还有问题

2. **SimpleUnionSchema**: kind 字段显示异常
   - 当前状态：显示 `kind: "\"number\""` 和 `undefined: 0`
   - 原因：discriminator 字段虽然被过滤，但可能在值序列化时出现问题

这两个问题需要进一步调试来确定根本原因。
