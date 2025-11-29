# valibot-form 使用指南

本文档面向 LLM，详细展示如何使用 `valibot-form` 将 Valibot schema 转换为表单字段。

## 基础概念

`valibot-form` 通过在 Valibot schema 上附加 `*Meta` 函数来描述表单字段的渲染方式。核心思路：

```ts
import * as v from 'valibot'
import * as f from 'valibot-form'

const schema = v.pipe(
  v.string(),                           // Valibot 类型
  f.formMeta({ label: '用户名' }),       // 通用表单元数据
  f.stringMeta({ placeholder: '请输入' }) // 类型专属配置
)
```

---

## 类型映射表

| Valibot 类型 | Meta 函数 | 默认控件 | 可选控件 |
|-------------|----------|---------|---------|
| `v.string()` | `stringMeta` | 单行输入框 | 多行文本框、密码框、代码编辑器 |
| `v.number()` | `numberMeta` | 数字输入框 | 滑块 |
| `v.boolean()` | `booleanMeta` | 开关 | 复选框 |
| `v.picklist()` | `picklistMeta` | 下拉选择 | 分段控件、单选按钮组 |
| `v.array()` | `arrayMeta` | 列表 | 网格、表格、多选控件 |
| `v.record()` | `recordMeta` | 键值对表格 | 键值对列表 |
| `v.object()` | `objectMeta` | 卡片/堆栈 | 可折叠面板 |
| `v.variant()` / `v.union()` | `unionMeta` | 下拉选择 | 分段控件、开关、单选按钮组 |

---

## 通用表单元数据 (formMeta)

所有字段都可以使用 `formMeta` 添加通用配置：

```ts
v.pipe(
  v.string(),
  f.formMeta({
    label: '字段标签',           // 显示名称
    description: '字段描述',     // 显示在输入框上方
    helperText: '帮助文本',      // 显示在输入框下方
    hint: '提示信息',            // tooltip 内容
    tooltip: '悬停提示',
    badge: '新',                 // 或 { label: '新', color: 'blue' }
    hidden: false,              // 隐藏字段
    disabled: false,            // 禁用字段
    readOnly: false,            // 只读
    inlineLabel: false,         // 内联标签布局
    section: 'basic',           // 所属分组 ID
    layout: {
      span: 2,                  // 占据列数
      fullWidth: true,          // 占满整行
      align: 'start',           // 对齐方式
    },
  })
)
```

---

## 字符串字段 (stringMeta)

### 单行输入框（默认）

```ts
v.pipe(
  v.string(),
  f.formMeta({ label: '用户名' }),
  f.stringMeta({
    placeholder: '请输入用户名',
    prefix: '@',                // 前缀
    suffix: '.com',             // 后缀
    copyable: true,             // 显示复制按钮
  })
)
```

### 多行文本框

```ts
v.pipe(
  v.string(),
  f.formMeta({ label: '简介' }),
  f.stringMeta({
    mode: 'textarea',
    rows: 4,                    // 初始行数
    autoGrow: true,             // 自适应高度
  })
)
```

### 密码输入框

```ts
v.pipe(
  v.string(),
  f.formMeta({ label: '密码' }),
  f.stringMeta({
    mode: 'password',
    // 或使用旧写法：secret: true
  })
)
```

### 代码编辑器

```ts
v.pipe(
  v.string(),
  f.formMeta({ label: '配置' }),
  f.stringMeta({
    mode: 'code',
    rows: 10,
  })
)
```

### 带格式校验（自动识别）

```ts
// 邮箱格式 - 自动识别并显示相应图标
v.pipe(v.string(), v.email())

// URL 格式
v.pipe(v.string(), v.url())

// 颜色选择器
v.pipe(v.string(), v.hexColor())
```

---

## 数字字段 (numberMeta)

### 数字输入框（默认）

```ts
v.pipe(
  v.number(),
  f.formMeta({ label: '价格' }),
  f.numberMeta({
    variant: 'input',
    step: 0.01,
    min: 0,
    max: 9999,
    placeholder: '0.00',
    prefix: '¥',
    suffix: '元',
    formatOptions: { style: 'currency', currency: 'CNY' },
  })
)
```

### 滑块

```ts
v.pipe(
  v.number(),
  f.formMeta({ label: '音量' }),
  f.numberMeta({
    variant: 'slider',
    min: 0,
    max: 100,
    step: 5,
    marks: [
      { value: 0, label: '静音' },
      { value: 50, label: '50%' },
      { value: 100, label: '最大' },
    ],
  })
)
```

---

## 布尔字段 (booleanMeta)

### 开关（默认）

```ts
v.pipe(
  v.boolean(),
  f.formMeta({ label: '启用通知' }),
  f.booleanMeta({
    variant: 'switch',
    labelPlacement: 'right',
  })
)
```

### 复选框

```ts
v.pipe(
  v.boolean(),
  f.formMeta({ label: '同意条款' }),
  f.booleanMeta({
    variant: 'checkbox',
  })
)
```

---

## 枚举/选择字段 (picklistMeta)

### 下拉选择（默认）

```ts
v.pipe(
  v.picklist(['dev', 'staging', 'prod'] as const),
  f.formMeta({ label: '环境' }),
  f.picklistMeta({
    labels: { dev: '开发', staging: '预发', prod: '生产' },
    placeholder: '选择环境',
    searchable: true,           // 可搜索（选项多时自动开启）
    clearable: true,            // 可清空
    disabled: ['staging'],      // 禁用某些选项
  })
)
```

### 分段控件（适合 2-4 个选项）

```ts
v.pipe(
  v.picklist(['low', 'mid', 'high'] as const),
  f.formMeta({ label: '优先级' }),
  f.picklistMeta({
    variant: 'segmented',
    labels: { low: '低', mid: '中', high: '高' },
  })
)
```

### 单选按钮组

```ts
v.pipe(
  v.picklist(['small', 'medium', 'large'] as const),
  f.formMeta({ label: '尺寸' }),
  f.picklistMeta({
    variant: 'radio',
    labels: { small: '小', medium: '中', large: '大' },
  })
)
```

### 多选（数组包装）

```ts
v.pipe(
  v.array(
    v.pipe(
      v.picklist(['auth', 'api', 'websocket', 'cache'] as const),
      f.picklistMeta({
        multiple: true,
        labels: { auth: '认证', api: 'API', websocket: 'WebSocket', cache: '缓存' },
        maxSelections: 3,       // 最多选择数量
        allowCreate: true,      // 允许创建新选项
      })
    )
  )
)
```

### 智能默认

选项数量会影响默认行为：
- **≤8 个选项**：默认不开启搜索
- **>8 个选项**：自动开启搜索
- **可选字段**：自动开启清空功能

---

## 数组字段 (arrayMeta)

### 列表布局（默认）

```ts
v.pipe(
  v.array(v.string()),
  f.formMeta({ label: '标签' }),
  f.arrayMeta({
    layout: 'list',
    addLabel: '添加标签',
    itemLabel: '标签',
    emptyHint: '还没有任何标签',
    minItems: 1,
    maxItems: 10,
  })
)
```

### 网格布局

```ts
v.pipe(
  v.array(v.number()),
  f.formMeta({ label: '数值' }),
  f.arrayMeta({
    layout: 'grid',
    columns: 3,                 // 每行显示列数
    itemLabel: '数值',
    defaultItem: 0,             // 新增时的默认值
  })
)
```

### 表格布局

```ts
v.pipe(
  v.array(v.boolean()),
  f.formMeta({ label: '开关列表' }),
  f.arrayMeta({
    layout: 'table',
    itemLabel: '开关',
  })
)
```

### 多选控件模式

当数组元素是 picklist 时，可以使用多选控件代替列表：

```ts
v.pipe(
  v.array(v.picklist(['alpha', 'beta', 'gamma', 'delta'] as const)),
  f.formMeta({ label: '选项' }),
  f.arrayMeta({
    valueMode: 'picklist',
    pickerMode: 'picker',       // 使用多选控件而非列表
    picklist: {
      options: ['alpha', 'beta', 'gamma', 'delta'],
      labels: { alpha: 'A', beta: 'B', gamma: 'C', delta: 'D' },
      searchable: true,
      clearable: true,
    },
  })
)
```

---

## Record 字段 (recordMeta)

### 表格布局（默认）

```ts
v.pipe(
  v.record(v.string(), v.string()),
  f.formMeta({ label: '环境变量' }),
  f.recordMeta({
    layout: 'table',
    keyLabel: '变量名',
    valueLabel: '值',
    keyPlaceholder: 'API_KEY',
    valuePlaceholder: 'xxx-xxx',
    columns: { key: 200, value: 'auto' },
  })
)
```

### 列表布局

```ts
v.pipe(
  v.record(v.string(), v.number()),
  f.formMeta({ label: '配置项' }),
  f.recordMeta({
    layout: 'list',
    editableKey: false,         // 键不可编辑
    emptyHint: '暂无配置项',
  })
)
```

### 单选值（picklist）

```ts
v.pipe(
  v.record(v.string(), v.picklist(['read', 'write', 'admin'])),
  f.formMeta({ label: '权限配置' }),
  f.recordMeta({
    layout: 'table',
    keyLabel: '资源',
    valueLabel: '权限',
    valueMode: 'picklist',
    picklist: {
      options: ['read', 'write', 'admin'],
      labels: { read: '只读', write: '读写', admin: '管理员' },
    },
  })
)
```

### 多选值（picklist-array）

```ts
v.pipe(
  v.record(v.string(), v.array(v.picklist(['frontend', 'backend', 'devops']))),
  f.formMeta({ label: '项目标签' }),
  f.recordMeta({
    layout: 'table',
    keyLabel: '项目',
    valueLabel: '标签',
    valueMode: 'picklist-array',
    picklist: {
      options: ['frontend', 'backend', 'devops'],
      labels: { frontend: '前端', backend: '后端', devops: '运维' },
      maxValues: 3,
      searchable: true,
    },
  })
)
```

### 混合类型值

```ts
v.pipe(
  v.record(v.string(), v.unknown()),
  f.formMeta({ label: '配置' }),
  f.recordMeta({
    layout: 'table',
    valueMode: 'auto',          // 自动推断：字符串/数字/布尔/JSON
  })
)
```

---

## 对象字段 (objectMeta)

### 嵌套对象

```ts
const AddressSchema = v.pipe(
  v.object({
    street: v.pipe(v.string(), f.formMeta({ label: '街道' })),
    city: v.pipe(v.string(), f.formMeta({ label: '城市' })),
    zip: v.pipe(v.number(), f.formMeta({ label: '邮编' })),
  }),
  f.formMeta({ label: '地址', description: '配送地址' }),
  f.objectMeta({
    columns: 2,                 // 两列布局
    collapse: true,             // 可折叠
    variant: 'card',            // 卡片样式
    gap: 16,                    // 字段间距
  })
)
```

### 使用 intersect 组合

```ts
const ProfileSchema = v.pipe(
  v.intersect([
    v.object({
      name: v.pipe(v.string(), f.formMeta({ label: '姓名' })),
    }),
    v.object({
      email: v.pipe(v.string(), v.email(), f.formMeta({ label: '邮箱' })),
    }),
  ]),
  f.formMeta({ label: '个人信息' }),
  f.objectMeta({ columns: 2 })
)
```

---

## 联合类型 (unionMeta)

### 布尔开关联动

当 discriminator 是布尔值时，自动使用开关控件：

```ts
const DisabledSchema = v.object({
  enabled: v.literal(false),
})

const EnabledSchema = v.object({
  enabled: v.literal(true),
  config: v.pipe(v.string(), f.formMeta({ label: '配置' })),
})

const ToggleSchema = v.pipe(
  v.variant('enabled', [DisabledSchema, EnabledSchema]),
  f.formMeta({ label: '功能开关' }),
  f.unionMeta({
    discriminator: 'enabled',
    variant: 'switch',          // 使用开关控件
  })
)
```

### 类型选择联动

```ts
const FooSchema = v.object({
  type: v.literal('foo'),
  value: v.pipe(v.number(), f.formMeta({ label: '数值' })),
})

const BarSchema = v.object({
  type: v.literal('bar'),
  text: v.pipe(v.string(), f.formMeta({ label: '文本' })),
})

const TypeSwitchSchema = v.pipe(
  v.variant('type', [FooSchema, BarSchema]),
  f.formMeta({ label: '类型切换' }),
  f.unionMeta({
    discriminator: 'type',
    branchLabels: { foo: 'Foo 类型', bar: 'Bar 类型' },
    branchDescriptions: { foo: '数值配置', bar: '文本配置' },
    variant: 'segmented',       // 分段控件
  })
)
```

### 下拉选择（多分支）

```ts
const ProtocolSchema = v.pipe(
  v.variant('protocol', [
    v.object({ protocol: v.literal('http'), host: v.string(), port: v.number() }),
    v.object({ protocol: v.literal('https'), host: v.string(), port: v.number(), cert: v.string() }),
    v.object({ protocol: v.literal('ws'), endpoint: v.string() }),
    v.object({ protocol: v.literal('wss'), endpoint: v.string(), cert: v.string() }),
  ]),
  f.formMeta({ label: '协议配置' }),
  f.unionMeta({
    discriminator: 'protocol',
    branchLabels: { http: 'HTTP', https: 'HTTPS', ws: 'WebSocket', wss: 'WebSocket (安全)' },
    variant: 'select',
    searchable: true,
  })
)
```

### 简单联合（union）

```ts
const SimpleUnionSchema = v.pipe(
  v.union([
    v.object({ kind: v.literal('text'), content: v.string() }),
    v.object({ kind: v.literal('number'), value: v.number() }),
    v.object({ kind: v.literal('boolean'), flag: v.boolean() }),
  ]),
  f.formMeta({ label: '数据类型' }),
  f.unionMeta({
    discriminator: 'kind',
    branchLabels: { text: '文本', number: '数值', boolean: '布尔' },
    variant: 'segmented',
    preserveBranchValues: true, // 切换时保留已填值
  })
)
```

---

## 完整示例

### 用户配置表单

```ts
import * as v from 'valibot'
import * as f from 'valibot-form'

const UserConfigSchema = v.object({
  // 基础信息
  name: v.pipe(
    v.string(),
    v.minLength(2),
    f.formMeta({ label: '用户名', section: 'basic' }),
    f.stringMeta({ placeholder: '请输入用户名' })
  ),

  email: v.optional(
    v.pipe(
      v.string(),
      v.email(),
      f.formMeta({ label: '邮箱', section: 'basic' })
    )
  ),

  // 偏好设置
  theme: v.pipe(
    v.picklist(['light', 'dark', 'system'] as const),
    f.formMeta({ label: '主题', section: 'preferences' }),
    f.picklistMeta({
      variant: 'segmented',
      labels: { light: '浅色', dark: '深色', system: '跟随系统' },
    })
  ),

  volume: v.pipe(
    v.number(),
    v.minValue(0),
    v.maxValue(100),
    f.formMeta({ label: '音量', section: 'preferences' }),
    f.numberMeta({ variant: 'slider', step: 5 })
  ),

  // 通知设置
  notifications: v.pipe(
    v.variant('enabled', [
      v.object({ enabled: v.literal(false) }),
      v.object({
        enabled: v.literal(true),
        channels: v.array(v.picklist(['email', 'sms', 'push'] as const)),
      }),
    ]),
    f.formMeta({ label: '通知', section: 'notifications' }),
    f.unionMeta({ discriminator: 'enabled', variant: 'switch' })
  ),

  // 标签
  tags: v.optional(
    v.pipe(
      v.array(v.string()),
      f.formMeta({ label: '标签', section: 'metadata' }),
      f.arrayMeta({ layout: 'list', addLabel: '添加标签' })
    ),
    []
  ),
})
```

---

## 默认值

使用 `v.optional` 的第二个参数设置默认值：

```ts
// 字符串默认值
name: v.optional(v.string(), 'default')

// 对象默认值
config: v.optional(
  v.object({
    enabled: v.boolean(),
    level: v.number(),
  }),
  { enabled: false, level: 1 }
)

// Record 默认值
env: v.optional(
  v.record(v.string(), v.string()),
  { NODE_ENV: 'development' }
)
```
