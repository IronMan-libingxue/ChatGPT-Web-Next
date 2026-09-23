# 参与贡献 / Contributing

感谢你帮助改进 ChatGPT Web Next。提交前请先确认改动符合本项目的非商业许可和隐私边界。

Thank you for helping improve ChatGPT Web Next. Before contributing, make sure your change follows the project's noncommercial license and privacy boundaries.

## 提交问题 / Issues

- 先搜索已有问题，避免重复。
- 写明应用版本、操作系统、安装版或免安装版、复现步骤、预期结果和实际结果。
- 不要提交密码、验证码、Cookie、令牌、账号邮箱、聊天正文、附件内容或完整网络请求。
- 登录、网站规则或安全策略变化时，请描述可观察现象，不要上传真实账号数据。

- Search existing issues before opening a new one.
- Include the app version, operating system, package type, reproduction steps, expected result, and actual result.
- Never post passwords, verification codes, cookies, tokens, account email addresses, conversation text, attachment contents, or complete network requests.
- For sign-in, website-rule, or safety-policy regressions, describe observable behavior without uploading real account data.

## 提交改动 / Pull requests

1. 从最新 `main` 建立独立分支。
2. 保持远程 ChatGPT 页面与本地能力隔离，不向网页暴露文件、设备或本地接口。
3. 不复制浏览器登录资料，不降低 Google、OpenAI 或系统安全保护。
4. 为新增行为补充正例、反例和失败恢复测试。
5. 提交前运行：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:e2e
```

1. Create a focused branch from the latest `main`.
2. Keep the remote ChatGPT page isolated from local files, device records, and privileged APIs.
3. Do not copy browser credentials or weaken Google, OpenAI, or operating-system security controls.
4. Add positive, negative, and recovery tests for new behavior.
5. Run the commands above before submitting.

提交代码即表示你有权提交，并同意项目所有者继续按仓库中的 PolyForm Noncommercial License 1.0.0 发布该贡献。

By submitting code, you confirm that you have the right to contribute it and agree that the project owner may distribute the contribution under the repository's PolyForm Noncommercial License 1.0.0.
