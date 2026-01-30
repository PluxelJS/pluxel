# valibot-form 使用指南

本文档面向 LLM，展示如何使用 `valibot-form` 将 Valibot schema 转换为表单字段。  
当前版本为全量重构：API 更少、命名统一、交互效率优先。

---

## 基础用法

`valibot-form` 通过在 Valibot schema 上附加 `*Meta` 来描述表单渲染偏好：

```ts
import * as v from 'valibot'
import * as f from 'valibot-form'

const schema = v.pipe(
  v.string(),
  f.formMeta({ label: '用户名' }),
  f.stringMeta({ placeholder: '请输入用户名' })
)
```

---

## 类型映射表

| Valibot 类型 | Meta 函数 | 默认控件 | 说明 |
|-------------|----------|---------|------|
| `v.string()` | `stringMeta` | TextInput | `control` 可切换 textarea / password / code |
| `v.number()` | `numberMeta` | NumberInput | 仅数字输入（无 slider） |
| `v.boolean()` | `booleanMeta` | Switch | 仅 Switch（不提供 checkbox） |
| `v.picklist()` | `picklistMeta` | Select | 可切换 segmented / radio |
| `v.array()` | `arrayMeta` | List | 可切换 grid / picker |
| `v.record()` | `recordMeta` | Table | 可切换 list |
| `v.object()` | `objectMeta` | Card | 可切换 stack / 可折叠 |
| `v.variant()` / `v.union()` | `unionMeta` | Select | 可切换 segmented / radio / switch |

---

## 通用字段元数据 (formMeta)

所有字段都可以使用 `formMeta` 添加通用配置：

```ts
f.formMeta({
  label: '字段标签',
  description: '显示在控件上方的说明',
  help: '显示在控件下方的帮助文本',
  hint: '悬停提示（tooltip）',
  badge: '新', // 或 { label: '新', color: 'blue' }
  hidden: false,
  disabled: false,
  readOnly: false,
  section: 'basic',
  layout: {
    span: 2,
    full: true,
    align: 'start',
  },
})
```

---

## 字符串字段 (stringMeta)

```ts
v.pipe(
  v.string(),
  f.formMeta({ label: '用户名' }),
  f.stringMeta({
    control: 'text', // text | textarea | password | code
    placeholder: '请输入用户名',
  })
)
```

多行文本：

```ts
v.pipe(
  v.string(),
  f.formMeta({ label: '简介' }),
  f.stringMeta({ control: 'textarea', rows: 4 })
)
```

Valibot 校验会自动提取 `minLength` / `maxLength` 等限制。  
`v.email()` / `v.url()` / `v.hexColor()` 会被识别为格式提示，但 UI 控件仍保持实用输入。

---

## 数字字段 (numberMeta)

```ts
v.pipe(
  v.number(),
  f.formMeta({ label: '价格' }),
  f.numberMeta({
    min: 0,
    max: 9999,
    step: 0.01,
  })
)
```

---

## 布尔字段 (booleanMeta)

```ts
v.pipe(
  v.boolean(),
  f.formMeta({ label: '启用通知' }),
  f.booleanMeta({})
)
```

---

## 枚举/选择字段 (picklistMeta)

```ts
v.pipe(
  v.picklist(['dev', 'prod'] as const),
  f.formMeta({ label: '环境' }),
  f.picklistMeta({
    labels: { dev: '开发', prod: '生产' },
    placeholder: '选择环境',
    control: 'segmented', // select | segmented | radio
  })
)
```

多选推荐方案（用 array 包裹）：

```ts
v.pipe(
  v.array(
    v.pipe(
      v.picklist(['read', 'write', 'admin'] as const),
      f.picklistMeta({
        labels: { read: '读取', write: '写入', admin: '管理' },
        searchable: true,
        clearable: true,
      })
    )
  ),
  f.formMeta({ label: '权限' }),
  f.arrayMeta({ layout: 'picker' })
)
```

---

## 数组字段 (arrayMeta)

数组项类型应通过 schema 本身描述：

```ts
v.pipe(
  v.array(v.string()),
  f.formMeta({ label: '标签' }),
  f.arrayMeta({
    layout: 'list', // list | grid | picker
    addLabel: '添加标签',
    itemLabel: '标签',
    min: 1,
    max: 10,
  })
)
```

`layout: 'picker'` 仅在数组项为 `picklist` 时生效。

---

## Record 字段 (recordMeta)

```ts
v.pipe(
  v.record(v.string(), v.number()),
  f.formMeta({ label: '阈值表' }),
  f.recordMeta({
    layout: 'table', // table | list
    key: { label: 'Key', placeholder: '如 api-key' },
    value: { label: 'Value', placeholder: '数值' },
    addLabel: '添加一项',
  })
)
```

Record 会根据 value schema 渲染对应控件。

---

## Object 字段 (objectMeta)

```ts
v.pipe(
  v.object({
    name: v.pipe(v.string(), f.formMeta({ label: '姓名' })),
    age: v.pipe(v.number(), f.formMeta({ label: '年龄' })),
  }),
  f.formMeta({ label: '用户信息' }),
  f.objectMeta({
    variant: 'card', // card | stack
    columns: 2,
    collapsible: true,
  })
)
```

---

## Union 字段 (unionMeta)

```ts
v.pipe(
  v.variant('type', [
    v.object({ type: v.literal('http'), url: v.string() }),
    v.object({ type: v.literal('ws'), endpoint: v.string() }),
  ]),
  f.formMeta({ label: '连接类型' }),
  f.unionMeta({
    discriminator: 'type',
    control: 'segmented',
    labels: { http: 'HTTP', ws: 'WebSocket' },
  })
)
```

`unionMeta` 支持：
- `control`: select / segmented / radio / switch
- `labels` / `descriptions`: 自定义分支文案
- `expose`: auto / always / never（是否显式渲染 discriminator 字段）
- `preserve`: 是否保留分支值
- `compact`: 是否去掉 Card 边框

---

## 布局规则

自动布局遵循 `LAYOUT_DESIGN_GUIDELINES.md`：
- 空间优先、多列布局
- 类型感知
- 嵌套递减
- 可显式覆盖（`formMeta.layout` / `objectMeta.columns` / `arrayMeta.layout` 等）
