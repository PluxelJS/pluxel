# valibot-form 布局规则

本页记录 renderer 的自动布局，元数据用法见 [USAGE.md](./USAGE.md)。规则以 [layout.ts](./src/web/components/internal/layout.ts) 和 [array.tsx](./src/web/components/renders/array.tsx) 为实现入口。

## 列数与跨度

| 场景                          | 当前规则                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------- |
| Section                       | 正数显式 columns 优先；否则单字段单列，紧凑字段数或总字段数达到 3 时双列         |
| Array boolean/number/picklist | 上限 3 列                                                                        |
| Array 普通 string             | 上限 2 列                                                                        |
| Array textarea/code 或复合项  | 单列                                                                             |
| Array 自动列数                | 不足 3 项单列；3–5 项最多双列；6 项起按类型上限最多三列                          |
| Array 显式 columns            | 按类型上限截断，优先于 disableAutoGrid；未指定时 disableAutoGrid 禁用自动多列    |
| 字段跨度                      | object/array/union/record 和 layout.full 占整行；其余 span 截断在 1 与总列数之间 |

紧凑字段为 boolean、number、picklist 与非 textarea/code 的 string；显式 full 或 span > 1 的字段不计入紧凑数量。常量在 [constants.ts](./src/core/constants.ts)。

## 嵌套与覆盖

[nested.ts](./src/web/components/renders/nested.ts) 将嵌套 Array 设为 disableAutoGrid、Object 设为 stack、Union 设为 compact，避免缩进后继续分割空间。Object 内字段仍按 section 规则布局。

- `objectMeta({ variant, collapsible })` 控制对象分组外观；对象内列数由子字段的 `formMeta({ section: { id, columns } })` 控制，当前 renderer 不消费 objectMeta.columns。
- `arrayMeta({ layout: 'list' | 'grid' | 'picker', columns, disableAutoGrid })` 控制数组；picker 要求 picklist 项。
- `formMeta({ layout: { full, span, align } })` 控制单字段跨度与对齐。

改动布局时同时检查窄容器、嵌套复合字段、长标签与错误文本。不要用“最佳列数”或未经记录的用户测试替代实际布局证据。
