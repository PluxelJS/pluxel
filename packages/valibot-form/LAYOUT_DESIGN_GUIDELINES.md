# valibot-form 布局设计准则

本文档描述 valibot-form 的自动布局设计准则，供 LLM 和开发者参考。

## 核心原则

1. **空间优先**：默认使用多列布局以节省垂直空间，但在空间不足时自动回退到单列
2. **类型感知**：根据字段类型自动决定布局策略和最大列数
3. **嵌套递减**：嵌套层级越深，布局越简单（避免在有限空间内过度分割）
4. **显式覆盖**：所有自动行为都可通过显式配置覆盖

## 字段类型分类

### 紧凑类型（Compact Types）
适合在多列布局中并排显示：

| 类型 | 最大列数 | 说明 |
|------|---------|------|
| `boolean` | 3 | Switch 控件非常紧凑 |
| `number` | 3 | NumberInput 宽度适中 |
| `picklist` | 3 | Select 宽度适中 |
| `string` | 2 | TextInput 需要更多宽度 |
| `string` (textarea/code) | 1 | 多行文本必须单列 |

### 复杂类型（Complex Types）
始终占满整行，不参与多列排布：
- `object`
- `array`
- `union`
- `record`

## Array 智能列数计算

Array 的列数由 `analyzeArrayItemLayout()` 和 `resolveArrayColumns()` 函数计算：

### 1. 分析项类型特性
```typescript
interface ArrayItemLayoutInfo {
  compact: boolean    // 是否适合多列
  maxColumns: 1 | 2 | 3  // 基于项类型的最大列数
}
```

### 2. 项类型 → 最大列数映射
| 项类型 | maxColumns | 原因 |
|--------|------------|------|
| `boolean` | 3 | Switch 很窄 |
| `number` | 3 | NumberInput 适中 |
| `picklist` | 3 | Select 适中 |
| `string` (default) | 2 | TextInput 需要宽度 |
| `string` (textarea/code) | 1 | 多行文本必须全宽 |
| `object/array/union/record` | 1 | 复杂类型单列 |

### 3. 列数计算规则
```typescript
function resolveArrayColumns(layoutInfo, itemCount, explicitColumns, disableAutoGrid):
  1. 显式指定优先：explicitColumns > 0 → min(explicitColumns, maxColumns)
  2. 嵌套禁用：disableAutoGrid → 1
  3. 非紧凑类型：!compact → 1
  4. 项数不足：itemCount < 3 → 1
  5. 智能计算：
     - itemCount >= 6 && maxColumns >= 3 → 3
     - itemCount >= 4 && maxColumns >= 2 → 2
     - itemCount >= 3 && maxColumns >= 2 → 2
     - 否则 → 1
```

### 4. 示例

| 项类型 | 项数量 | 计算列数 |
|--------|--------|---------|
| boolean | 2 | 1 (数量不足) |
| boolean | 3 | 2 |
| boolean | 6 | 3 |
| string | 3 | 2 |
| string | 10 | 2 (maxColumns=2 限制) |
| textarea | 5 | 1 (非紧凑) |
| object | 10 | 1 (复杂类型) |

## Object 字段布局

Object 内子字段的布局由 `countCompactFields()` 和 `resolveSectionColumns()` 计算：

```
紧凑字段数量 >= GRID_COLUMN_THRESHOLD (3) → 启用双列布局
```

逻辑位置：`object.tsx` → `countCompactFields()` + `resolveSectionColumns()`

## AutoForm 顶层布局

```
紧凑字段数量 >= GRID_COLUMN_THRESHOLD (3) → 启用双列布局
```

逻辑位置：`fieldPlanner.ts` → `isCompactField()` + `resolveSectionColumns()`

## 嵌套规则

| 嵌套场景 | 布局行为 |
|---------|---------|
| Object 内的字段 | 遵循标准规则 |
| Object 内的 Array | 遵循智能列数规则 |
| Array 内的 Object | 使用 stack 变体，启用双列 |
| Array 内的 Array | **强制单列**（`disableAutoGrid: true`） |
| Array 内的 Union | 使用 compact 模式 |

## 配置常量

```typescript
// packages/valibot-form/src/core/constants.ts
export const GRID_COLUMN_THRESHOLD = 3  // 触发多列的最小项数
export const DEFAULT_GRID_COLUMNS = 2   // Object 默认列数
```

## 显式覆盖

### Object 字段
```typescript
f.objectMeta({
  columns: 3,      // 显式指定列数
  variant: 'stack', // 使用 stack 变体（无卡片边框）
  collapsible: true // 允许折叠
})
```

### Array 字段
```typescript
f.arrayMeta({
  layout: 'list',       // 强制单列
  layout: 'grid',       // 强制多列
  layout: 'picker',     // picklist 数组的多选控件
  columns: 3,           // 指定列数（受 maxColumns 限制）
  disableAutoGrid: true // 禁用自动多列（用于嵌套场景）
})
```

### 单个字段
```typescript
f.formMeta({
  layout: {
    full: true,       // 占满整行
    span: 2,          // 占指定列数
    align: 'center'   // 垂直对齐方式
  }
})
```

## 关键实现文件

| 文件 | 职责 |
|-----|------|
| `layout.ts` | 布局工具函数（isComplexType, countCompactFields, resolveFieldSpan） |
| `fieldPlanner.ts` | AutoForm 字段规划和分组 |
| `object.tsx` | Object 类型渲染器 |
| `array.tsx` | Array 类型渲染器（含智能列数计算） |
| `AutoForm.tsx` | 顶层表单渲染 |
| `constants.ts` | 布局常量定义 |

## 设计决策记录

### 为什么 GRID_COLUMN_THRESHOLD = 3？
- 1-2 个项时，单列布局更清晰
- 3+ 个紧凑项时，多列布局能显著节省空间
- 经过用户测试，3 是最佳平衡点

### 为什么 boolean/number 最大 3 列，string 最大 2 列？
- boolean (Switch) 和 number (NumberInput) 控件宽度较小，3 列不拥挤
- string (TextInput) 需要更多输入空间，2 列更合适
- textarea/code 是多行输入，必须单列

### 为什么 6+ 项才启用 3 列？
- 3-5 项用 2 列：2 行 + 可能 1 个单独
- 6+ 项用 3 列：刚好能填满 2 行，视觉平衡
- 避免最后一行只有 1 个元素显得孤单

### 为什么 Array 内的 Array 强制单列？
- 嵌套数组已经在视觉上缩进
- 可用宽度大幅减少
- 强制多列会导致内容过于拥挤，影响可读性

### 为什么复杂类型始终占满整行？
- 复杂类型（object/array/union）本身包含多个子字段
- 在半宽空间内渲染会导致进一步嵌套压缩
- 占满整行确保子字段有足够的渲染空间
