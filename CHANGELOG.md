# 更新日志 / Changelog

## 0.2.1 — 2026-09-23

共同作者 / Co-authors: @IronMan-libingxue, @Jessica-yaoyao

### 中文

- 修复 Electron 原生 Google 登录弹窗关系，覆盖首次登录、两步验证、重启保持、清除后重新登录和账号切换。
- 完成普通与无痕会话隔离、出口 IP、位置、时区、时间及 ChatGPT 响应延迟显示。
- 增加本机 IP 与会话安全策略：确认受保护状态后第 10 秒清理网页登录数据，第 30 秒退出应用。
- 增加下载管理、文件定位、五款内置图标、强制刷新、状态记录和紧凑顶栏。
- 修复项目或文件夹内状态识别、离线重试、延迟检测停止、下载面板层级和窗口销毁错误。
- macOS 完整验收通过；Windows 安装版与免安装版在多台实机和多个 Windows 版本上人工验收通过。

### English

- Restored the native Electron Google sign-in popup relationship, including first sign-in, two-step verification, restart persistence, sign-in after clearing data, and account switching.
- Completed regular/incognito isolation plus egress IP, estimated location, time zone, local time, and ChatGPT response-latency status.
- Added a local IP and session-safety policy that clears web sign-in data at 10 seconds and exits the app at 30 seconds after a protected state is confirmed.
- Added download management, file reveal, five built-in icons, cache-bypassing refresh, status records, and a compact toolbar.
- Fixed project/folder state recognition, offline retry handling, latency-test completion, download-panel layering, and destroyed-window errors.
- Completed full macOS acceptance and user-run acceptance of both Windows packages on multiple physical machines and Windows versions.
