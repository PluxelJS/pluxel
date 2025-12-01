# packages/components 重构计划

## 当前问题总结

### 1. 目录结构问题
- **`PluginOrganizer`** (1200+ 行) 是应用特定组件，但放在通用 `/components` 目录
- 深度嵌套：`/app/plugins/plugin/components` 有 3 层深度
- Hooks 分散：`useDynamicTheme` 在根目录，`useNotify` 在 `/app/notifications`，`usePluginConfig` 在 `/app/plugins/plugin/hooks`
- 主题文件分散：`theme.ts`、`patterns.ts`、`colorPresets.ts`、`useDynamicTheme.ts` 都在 `src/` 根目录

### 2. 组件复杂度问题
- `PluginOrganizer` 超过 1200 行，包含大量内部组件和复杂状态逻辑
- `Layout` 组件 285 行，功能较多

### 3. 导出策略问题
- package.json 只导出 `.` 和 `./extension`
- 缺少 `./components`、`./theme`、`./app` 等子路径导出
- 消费者无法按需导入特定模块

---

## 重构方案

### 阶段一：目录结构重组

#### 1.1 创建 `/theme` 目录，整合主题相关文件

**变更：**
```
src/
├── theme.ts              → src/theme/mantine.ts
├── patterns.ts           → src/theme/patterns.ts
├── colorPresets.ts       → src/theme/colorPresets.ts
├── useDynamicTheme.ts    → src/theme/useDynamicTheme.ts
└── (new)                 → src/theme/index.ts (barrel export)
```

#### 1.2 创建 `/hooks` 目录，整合通用 hooks

**变更：**
```
src/hooks/
├── index.ts                    (barrel export)
├── useControllable.ts          (从 Layout.tsx 提取)
└── useDebouncedFlag.ts         (从 app/plugins/plugin/hooks 移动)

src/app/hooks/
├── index.ts                    (barrel export)
├── usePluginConfig.ts          (从 app/plugins/plugin/hooks 移动)
└── useNotify.ts                (从 app/notifications 移动)
```

#### 1.3 将 `PluginOrganizer` 移动到应用层

**变更：**
```
src/components/PluginOrganizer.tsx → src/app/plugins/organizer/PluginOrganizer.tsx
```

#### 1.4 扁平化 `/app/plugins` 结构

**当前结构：**
```
app/plugins/
├── Plugin.tsx
├── PluginsLayout.tsx
├── PluginList.tsx
├── ConfigForm.tsx
├── statusEvents.ts
└── plugin/
    ├── PluginScreen.tsx
    ├── PluginLayout.tsx
    ├── context.tsx
    ├── hooks/
    └── components/
        ├── ActionBar.tsx
        ├── PluginPanel.tsx
        └── ...
```

**重构后：**
```
app/plugins/
├── index.ts                    (barrel export)
├── list/
│   ├── PluginsLayout.tsx
│   ├── PluginList.tsx
│   └── index.ts
├── detail/
│   ├── PluginScreen.tsx
│   ├── PluginLayout.tsx
│   ├── context.tsx
│   ├── ActionBar.tsx
│   ├── PluginPanel.tsx
│   ├── PluginSection.tsx
│   ├── PluginSourceCard.tsx
│   ├── DependencyList.tsx
│   ├── LeftPane.tsx
│   ├── RightPane.tsx
│   └── index.ts
├── organizer/
│   ├── PluginOrganizer.tsx     (从 components 移入)
│   ├── SortableRow.tsx         (从 PluginOrganizer 提取)
│   ├── GroupCard.tsx           (从 PluginOrganizer 提取)
│   ├── DroppableContainer.tsx  (从 PluginOrganizer 提取)
│   ├── types.ts
│   ├── utils.ts
│   └── index.ts
├── config/
│   ├── ConfigForm.tsx
│   └── index.ts
├── Plugin.tsx                  (保持，入口组件)
└── statusEvents.ts             (保持)
```

---

### 阶段二：组件拆分

#### 2.1 拆分 `PluginOrganizer`

将 1200+ 行的大组件拆分为：
- `PluginOrganizer.tsx` - 主组件，管理状态和 DnD 逻辑（~300 行）
- `SortableRow.tsx` - 可排序行组件（~150 行）
- `GroupCard.tsx` - 分组卡片组件（~200 行）
- `DroppableContainer.tsx` - 放置容器组件（~100 行）
- `OrganizerContext.tsx` - 共享上下文
- `types.ts` - 类型定义
- `utils.ts` - 工具函数（ID 生成、sanitize 等）

#### 2.2 简化 `Layout` 组件

提取 `useControllable` hook 到 `/hooks` 目录，保持 Layout 专注于布局逻辑。

---

### 阶段三：导出策略优化

#### 3.1 更新 package.json exports

```json
{
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    },
    "./components": {
      "types": "./src/components/index.ts",
      "default": "./src/components/index.ts"
    },
    "./extension": {
      "types": "./src/extension/index.ts",
      "default": "./src/extension/index.ts"
    },
    "./theme": {
      "types": "./src/theme/index.ts",
      "default": "./src/theme/index.ts"
    },
    "./hooks": {
      "types": "./src/hooks/index.ts",
      "default": "./src/hooks/index.ts"
    }
  }
}
```

#### 3.2 更新 barrel exports

**src/index.ts：**
```typescript
// App
export { App } from './app'
export { prepareReactRender, useHydrateCache } from './app/gqty'

// Components (可复用 UI)
export * from './components'

// Extension System
export * from './extension'

// Theme
export * from './theme'

// Hooks
export * from './hooks'
```

**src/theme/index.ts：**
```typescript
export { theme } from './mantine'
export { colorPresets, type ColorPreset } from './colorPresets'
export { getPatternStyle, patterns } from './patterns'
export { useDynamicTheme, THEME_COLOR_STORAGE_KEY, THEME_CHANGE_EVENT } from './useDynamicTheme'
```

---

### 阶段四：代码清理

#### 4.1 移除 `/components` 中的应用特定组件
- 移动 `PluginOrganizer` 后，`/components` 只保留真正可复用的 UI 组件

#### 4.2 统一命名规范
- 所有 barrel export 文件使用 `index.ts`
- 类型文件使用 `types.ts`
- 工具函数使用 `utils.ts`

#### 4.3 更新导入路径
- 更新所有受影响文件的导入路径
- 确保没有循环依赖

---

## 最终目录结构

```
packages/components/src/
├── index.ts                        # 主入口
├── main.tsx                        # Dev 入口
├── TestApp.tsx                     # 测试组件
├── vite-env.d.ts
│
├── theme/                          # 主题系统
│   ├── index.ts
│   ├── mantine.ts                  # Mantine 主题配置
│   ├── patterns.ts                 # 背景图案
│   ├── colorPresets.ts             # 颜色预设
│   └── useDynamicTheme.ts          # 动态主题 hook
│
├── hooks/                          # 通用 hooks
│   ├── index.ts
│   └── useControllable.ts          # 受控/非受控模式 hook
│
├── components/                     # 可复用 UI 组件
│   ├── index.ts
│   ├── Layout.tsx
│   ├── AppHeader.tsx
│   ├── Navbar.tsx
│   ├── ColorSchemeToggle.tsx
│   ├── ThemeCustomizer.tsx
│   ├── EmptyState.tsx
│   ├── ErrorState.tsx
│   └── SubNavbar.tsx
│
├── extension/                      # 插件扩展系统（保持不变）
│   ├── index.ts
│   ├── types.ts
│   ├── registry.tsx
│   ├── runtime.tsx
│   ├── hooks.ts
│   ├── ErrorBoundary.tsx
│   ├── vendors.ts
│   ├── slots/
│   └── api/
│
└── app/                            # 应用特定代码
    ├── index.tsx
    ├── bootstrap.ts
    ├── constants.ts
    ├── rpc.ts
    ├── Header.tsx
    ├── ExtensionLoader.tsx
    ├── RouterLinkAdapter.tsx
    │
    ├── hooks/                      # 应用级 hooks
    │   ├── index.ts
    │   ├── usePluginConfig.ts
    │   ├── useDebouncedFlag.ts
    │   └── useNotify.ts
    │
    ├── router/
    ├── routes/
    ├── layout/
    ├── navigation/
    │
    ├── plugins/                    # 插件管理（重组后）
    │   ├── index.ts
    │   ├── Plugin.tsx
    │   ├── statusEvents.ts
    │   ├── list/
    │   ├── detail/
    │   ├── organizer/              # PluginOrganizer 拆分后
    │   └── config/
    │
    ├── packages/
    ├── notifications/
    ├── log_viewer/
    ├── home/
    └── gqty/
```

---

## 执行顺序

1. **阶段一**：目录结构重组（低风险，主要是移动文件）
2. **阶段二**：组件拆分（中等风险，需要仔细处理状态和 props）
3. **阶段三**：导出策略优化（低风险，添加新导出）
4. **阶段四**：代码清理和导入更新（需要全面测试）

---

## 注意事项

- 每个阶段完成后需要运行构建验证
- 保持向后兼容：旧的导入路径在一段时间内仍然可用
- 更新所有内部导入路径
- 确保没有引入循环依赖
