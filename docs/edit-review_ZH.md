<div align="right">

[English](edit-review.md) · 中文

</div>

# 编辑审阅：呈现层

本文只讲从 PR #46 拆出来的**呈现那一半**：被记录的 AI 文件改动如何在编辑器里显示，
以及 Keep / Undo 按钮怎么工作。归因——哪些写入算 AI 改动——是另一层，不在本次代码里；
在归因层合入之前，`dsh-tui-vscode.editReview.enabled` 默认 `false`，视图保持为空。

## 显示约定

编辑器里会画四类东西，彼此不能混淆：

| 改动 | 在现行文件编辑器里的标记 |
| --- | --- |
| 纯新增行 | 整行**深绿**底、行号槽绿色三角、右侧概览标尺刻度 |
| 改写行 | 整行**浅绿**底；行内被改动的元素更深一档绿 |
| 一行内既有删除又有新增 | 被删片段以**红色删除线**保留在原列；新增/替换片段为深绿 |
| 纯删除块 | 它没有存活的行：存活锚点行左侧加**深红竖条**、行号槽红图标、一个紧凑的 `⊖N` 标记（N = 删除行数），悬停可预览被删文字 |
| 对比视图 | 真正的 VS Code diff，**只在主动请求时**打开，绝不自动弹出 |

整行被删除的文字刻意**不**画在行内。仍存在的那一行里被删掉的短片段会以红色删除线保留在原位置，因此“部分改写”能完整读出来；整行旧文若也塞进行内会盖住新文。扩展无法往普通编辑器里插入额外行（这项能力留在 VS Code
内核里），所以行内“旧文字”只能和新文字挤在同一行——旧版正是这么做的，密集改动时很难读。
现在删除块只是一个标记：一眼看到“这里少了 N 行”，精确旧文一次悬停或一次点击即可看到。

## 审阅控件

- **待审文件首行的 CodeLens**：`▲` / `▼` 在块之间移动，`Keep file`、`Undo file`、
  `Compare with original`。
- **每个块上方的 CodeLens**：`1/3 · +2 −1 · Keep this change` 与 `Undo this change`，
  计数是该块新增 / 删除的行数。
- **AI 改动待审视图**（活动栏 `dsh-tui` 容器）：每个待审文件一行，显示计数、`新建` /
  `已删除` 与来源标记；行内 Keep、Undo、Compare 按钮；视图标题栏是保留全部 / 撤销全部。
  点击某一行是**跳到编辑器里的第一个块**，而不是打开标签页。
- **状态栏**：`$(diff) dsh: N 处待审`，点击列出文件。
- 单个文件**最多绘制 200 个块**并给出逐块按钮；超过时状态条会明说，并指向对比视图。
- **悬停**：块上方给出带身份锁的 Keep / Undo / Compare 链接，以及最多 160 字旧文预览。
- **命令面板**（`dsh-tui` 分类）：保留 AI 改动、撤销 AI 改动、对比原稿、保留全部、
  撤销全部、下一处 / 上一处待审改动、保留 / 撤销当前行改动。
- **编辑器标签栏与右键菜单**：当前文件有待审时出现 Keep / Undo。

## 决策语义

- **Keep** 接受改动，**从不写盘**；对已暂停的审阅，整文件 Keep 直接接受当前文件。
- **Undo** 精确还原改动前的字节（含换行），AI 新建的文件经回收站删除。单块的
  计划 → 写盘 → 提交是每文件一条串行队列。
- **用户手改**：能证明不与 AI 改动重叠的手改会镜像进前后两张图；重叠则把审阅置为暂停
  （“审阅暂停…”），暂停状态仍提供对比与安全的整文件 Keep。
- **过期控件一律拒绝**：每个按钮都钉住条目 id 与两张图的摘要，旧控件不可能作用到新状态。
- **安全拒绝**：带 UTF-8 BOM 的文件不能经编辑器模型撤销（Undo 拒绝、Keep 可用）；
  工作区之外或穿过符号链接的写入被拒绝；保存参与者改了文件则保留原稿并标冲突。

## 个人构建：被删行的独立行

上游 PR 对整块删除使用稳定的块标记；在它之上的个人构建可以把被删的旧行以**独立的深红行**显示，借助提案接口 `editorInsets`（`window.createWebviewTextEditorInset`）。

- 这些行是编辑器内的 webview 切片：纯文本、无脚本；下方正文会正好下移被删行数。
- 宿主不提供该接口（或扩展未以该方式启动）时，自动退回稳定块标记。
- 因为是提案接口，这种构建不能发布到应用商店。本机启用只需在
  `%USERPROFILE%\.vscode\argv.json` 加一行
  `"enable-proposed-api": ["baobaolaodie.dsh-tui-vscode"]`（package.json 已声明
  `enabledApiProposals`），然后完全重启 VS Code。开发宿主还必须把 `out/` 真实复制进
  扩展目录（用 junction 会让 `vscode` 模块把调用归到 null 扩展，提案接口被拒绝）。
- 限制：每个文件最多 30 个删除块生成 inset；文件第一行的删除块只能放在其首个存活行下方；
  这些行不带行号。

## 设置

| 设置 | 默认 | 含义 |
| --- | --- | --- |
| `dsh-tui-vscode.editReview.enabled` | `false` | 整个功能的唯一总闸门 |
| `dsh-tui-vscode.editReview.exclude` | 常见 build/`.git` glob | 永不审阅、也不保存原稿 |
| `dsh-tui-vscode.editReview.diffView` | `inline` | 手动对比视图的布局：`inline`、`sideBySide`、`auto` |

## 数据从哪来

账本是这次拆分的数据层：每文件最多一条待审记录，含改动前/后两张图、来源标记、
“正在写盘”标记与冲突标记。本 PR 只读取它并执行宿主侧写入；归因层（后续 PR）把条目
写进同一个 store。待审清单存放在扩展的 workspace storage 里，重载窗口不会丢。

## 验证

```bash
npm run typecheck
npm test                     # 含显示、集成、回归、安全四支测试
npm run test:e2e             # 真实扩展宿主套件（Linux 用 xvfb-run -a）
npm run package              # 标准 vsix；宿主测试入口已被排除

# 隔离宿主：显示效果 + 真实 CodeLens 点击
#   DSH_REVIEW_ARTIFACT_ROOT=<隔离目录> VSCODE_EXECUTABLE=<Code.exe> node scripts/run-review-host.cjs
#   DSH_REVIEW_ARTIFACT_ROOT=<隔离目录> VSCODE_EXECUTABLE=<Code.exe> DSH_REVIEW_VISUAL_HANDSHAKE=1 node scripts/run-review-ui-host.cjs
```

隔离宿主写 `host-result.json` / `ui-result.json`；视觉宿主还写
`screenshots/<phase>.png` 与 `run-meta.json`（HEAD 提交、工作树状态、`out/` 构建时间）。
`docs/review-host-result.json` 记录其中一次运行。

本 PR 未验证：真实归因（还没有数据源——宿主测试通过测试接缝记录条目），以及在用户日常
VS Code profile 里的真实端到端（隔离宿主使用的是全新 profile）。
