# dsh-session-cleaner

检查并清理 DSH 空白会话的本地插件。

## 功能

- 扫描 `~/.dsh/sessions` 下各工作区的会话日志，找出只包含会话头与初始化事件、从未产生任何消息或工具调用的空白会话。
- 在 DSH 设置的「空会话清理」页里按工作区筛选、查看空白会话列表。
- 删除默认移入隔离区（`~/.dsh/sessions-quarantine/session-cleaner/<时间戳>/`），可随时恢复或彻底删除。
- 默认不列出子代理、定时任务、记忆任务会话；可勾选后查看。
- 创建不足 10 分钟的会话视为可能正在使用，默认勾选禁用，需要显式确认。

## 安装

`desktop` profile 由 Electron 应用独占管理，`dsh plugin add` 不适合本机桌面端。手动安装：

1. 把本目录放到 `~/.dsh/session-cleaner`（或任意位置）。
2. 在 `~/.dsh/profiles/desktop/node_modules/` 建立目录链接 `dsh-session-cleaner` 指向插件目录。
3. 在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 增加 `"dsh-session-cleaner": "link:../../session-cleaner"`，并把 `"dsh-session-cleaner"` 加入 `dsh.profile.bundles`。
4. 刷新 DSH 页面。宿主侧通常热加载，无需重启。

安装后刷新 DSH 页面，设置里会出现「空会话清理」。

## 数据与安全

- 只读扫描会话日志（多帧 zstd 解压 + JSONL 事件判定）。
- 删除 = 移动会话目录到隔离区，不直接删除文件；「彻底删除」才会移除隔离批次。
- 服务端会重新扫描并校验每个目标确实是空白会话，不信任前端参数。

## 测试

```sh
node --test test/*.test.mjs
```
