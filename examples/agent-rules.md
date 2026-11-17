# 给强 AI 的共享协作规范模板

> 把下面这段规则放进你的 `CLAUDE.md`、`GEMINI.md` 或 `AGENTS.md`，防止新开会话后忘记自己怎么调度与监督 WorkBuddy。

```markdown
## WorkBuddy 执行层协同（Claw 桥接）

- 需要让 WorkBuddy Desktop 作为一线执行层干活、并在桌面 UI 实时直播过程时，通过 MCP `workbuddy-claw`（本地常驻桥 `127.0.0.1:18999`，CLI 备选 `~/.workbuddy/claw-bridge/wbctl.mjs`）接入 WorkBuddy「助理（Claw）」主会话。
- **控制边界**：通道统一路由在「助理」单会话内，无法在左侧普通任务栏另开独立新窗口；需要切换全新话题时发 `/clear` 清空上下文或 `/compact` 压缩记忆。
- **主控与过程纠偏**：
  1. 先用 `wb_status` 确认在线；
  2. 长任务用 `wb_send(wait_for_finish=false)` 异步派活，并用 `wb_poll_steps` 增量读取 `.jsonl` 中的工具调用与思考轨迹（不要只看最终总结回复）；
  3. 发现轻微跑偏直接 `wb_send` 追发指导；发现高危越界立刻用 `wb_steer_rule` 写入拦截规则，由 `PreToolUse` 钩子（`exit 2 + stderr`）在工具执行前当场退回重写。
- **单写者与技能沉淀**：同一时间仅允许一个主控 AI 向 WorkBuddy「助理」派活，禁止并发插话；流程跑顺后，由强 AI 直接把定式写入 WorkBuddy 桌面端实际加载的 `~/.workbuddy/skills/` 与 `~/.workbuddy/experts/` 目录。
```
