# Design-Wiki One-Month 10-Qubit Automation Plan

## 目标定位

本计划面向一个月内完成可展示、可写论文的最小创新闭环。

长期目标仍然是端到端超导量子芯片自动化设计，但一个月内不能追求完整 PDK、完整 EM 仿真、完整视觉自动迭代和可投片 GDS。当前必须聚焦：

```text
wiki-agent 作为设计知识和记忆系统
        ↓
wiki-agent 从 nature14270 和专家反馈中抽取设计流程
        ↓
wiki-agent 生成 design-agent 可执行的 10 比特设计任务
        ↓
design-agent 自动生成 10 比特超导量子芯片概念版图
        ↓
design-agent 运行结构验证和基础几何验证
        ↓
wiki-agent 汇总证据、假设、失败和创新点
        ↓
形成论文核心演示
```

一个月内的主要亮点不是“可投片芯片”，而是：

> 一个由 wiki-agent 记忆系统指导 design-agent 自动生成并验证 10 比特超导量子芯片概念版图的 agentic design workflow。

## 一个月内必须砍掉的内容

为了速度，以下内容不作为本月目标：

- 不追求 mask-ready GDS。
- 不实现完整 PDK / foundry design rule system。
- 不做完整 chip-level EM 仿真。
- 不做完整视觉模型闭环自动修版图。
- 不做多论文大规模 benchmark。
- 不做复杂 Bayesian / evolutionary optimization。
- 不做 cryogenic wiring、packaging、calibration 的完整系统设计。
- 不把所有 wiki/source schema 做大迁移。

这些内容可以在论文中作为 future work，但不能阻塞本月交付。

## 一个月内必须完成的核心闭环

本月只完成一条可运行闭环：

```text
nature14270 + 专家规则
  -> wiki-agent design memory
  -> 10-qubit design task spec
  -> design-agent Layout IR
  -> design-agent Python layout template
  -> 10-qubit GDS
  -> topology / geometry verifier
  -> design record + wiki summary
```

最小成功标准：

- `wiki-agent` 能说明设计依据来自哪里。
- `design-agent` 能自动生成 10 比特芯片 Layout IR 和 GDS。
- verifier 能检查 10 个 qubits、coupling graph、readout/control/coupler 是否存在。
- 所有假设被记录，不声称可投片。
- 结果可以作为论文中的系统原型和实验案例。

## 论文可写的创新点

一个月内要围绕以下创新点组织工作：

### 创新点 1：Design-Wiki 作为芯片设计记忆系统

`wiki-agent` 不只是文献问答，而是维护：

- 设计流程知识；
- 论文证据；
- 专家修正；
- design rules；
- failure records；
- design-agent task specs；
- verification results。

论文叙事：

> We introduce a design-wiki memory layer that converts literature evidence and expert corrections into executable chip-design tasks.

### 创新点 2：Wiki-Agent 指导 Design-Agent

系统不是单 agent 直接画图，而是分工：

- `wiki-agent` 负责知识、任务、约束、风险和总结。
- `design-agent` 负责代码、版图、GDS、验证和 artifact。

论文叙事：

> The knowledge agent plans and constrains the engineering agent, reducing direct expert intervention during layout generation.

### 创新点 3：Paper-to-Design-Task 到 10-Qubit Layout

`nature14270` 被用作设计知识启动源，但最终展示目标是 10 比特芯片概念版图。

论文叙事：

> Starting from a 9-qubit Xmon repetition-code paper, the system distills reusable layout constraints and generates a 10-qubit superconducting-chip concept layout.

### 创新点 4：可验证的 Agentic Layout Artifact

不是只生成图片或自然语言，而是生成：

- Layout IR；
- Python layout code；
- GDS；
- verification report；
- design record；
- wiki summary。

论文叙事：

> The output is not only text, but a reproducible design package with machine-checkable layout and verification artifacts.

## 核心难点与本月处理方式

### 难点 1：设计流程知识缺乏

本月处理方式：

- 不试图让 `wiki-agent` 学完整超导芯片设计。
- 只围绕 `nature14270` 和 10 比特 Xmon/transmon 概念芯片提炼最小设计知识。
- 专家反馈直接写成结构化 design rules。

本月交付：

- `nature14270` design memory summary；
- `linear-xmon-repetition-code` design rule；
- `ten-qubit-concept-chip` design task；
- 专家 correction record 格式。

### 难点 2：Wiki-Agent 指导 Design-Agent

本月处理方式：

- 只定义一个轻量级 `Design Task Spec`，不做通用复杂 planner。
- `Design Task Spec` 服务于 10 比特概念版图生成。

本月交付的 task spec 至少包含：

- design objective；
- topology；
- qubit count；
- component requirements；
- allowed assumptions；
- forbidden claims；
- expected artifacts；
- required checks。

### 难点 3：Design-Agent 工具流不固定

本月处理方式：

- 不追求完整工具链。
- 固定最短工具流：

```text
Design Task Spec -> Layout IR -> Python template -> GDS -> verifier -> design record
```

本月需要的组件只有：

- Xmon/transmon placeholder；
- nearest-neighbour coupler；
- readout resonator；
- XY/control line；
- feedline；
- label/port；
- chip outline。

### 难点 4：版图正确性验证困难

本月处理方式：

- 暂不实现完整视觉模型闭环。
- 先实现机器可检查的结构验证和基础几何验证。
- GDS 渲染图作为人工/论文展示材料。

本月 verifier 检查：

- qubit count = 10；
- coupling graph 与目标一致；
- 每个 qubit 有 readout；
- 每个 qubit 有 control；
- 每条 coupling edge 有 coupler；
- 所有组件在 chip boundary 内；
- GDS 文件存在且可解析；
- Layout IR 与 GDS summary 一致。

### 难点 5：从复现论文到设计新芯片

本月处理方式：

- 不从零发明全新芯片。
- 采用“论文知识启动 + agent 生成 10 比特概念设计”的策略。
- 把 `nature14270` 的 9-qubit linear Xmon 设计提升为 10-qubit concept chip。

推荐 10 比特拓扑：

- 第一选择：2 x 5 ladder。
- 原因：比线性链更接近二维扩展，又比 surface-code patch 简单，适合一个月内完成。

## 四周时间安排

### 第 1 周：设计记忆和任务协议

目标：让 `wiki-agent` 能把 `nature14270` 和专家规则变成 `design-agent` 可执行任务。

任务：

1. 定义轻量级 `Design Task Spec`。
2. 定义轻量级 `Layout IR`。
3. 定义轻量级 `Verification Report`。
4. 整理 `nature14270` 设计知识：
   - 9 Xmon qubits；
   - 5 data + 4 measurement；
   - linear alternating pattern；
   - nearest-neighbour coupling；
   - individual control/readout；
   - fabrication and readout/filter notes。
5. 生成 `ten-qubit-concept-chip` task spec。

交付：

- `docs/design-wiki-one-month-contracts.md`
- `design-repo/design-records/tasks/ten_qubit_concept_task.json`
- `design-repo/design-records/memory/nature14270_design_memory.md`

验收：

- `wiki-agent` 的角色清楚：提供设计记忆和任务约束。
- `design-agent` 的输入清楚：读取 task spec，而不是重新猜论文。
- task spec 明确禁止声称 mask-ready。

### 第 2 周：Design-Agent 生成 10 比特 Layout IR 和 GDS

目标：让 `design-agent` 自动生成 10 比特概念版图。

任务：

1. 实现或整理 10-qubit `2 x 5 ladder` Layout IR。
2. 在 design-code 中实现可复用 layout template。
3. 生成 GDS。
4. 写 artifact manifest。
5. 写 design record。

最小 layout components：

- chip outline；
- 10 个 Xmon/transmon qubit placeholders；
- nearest-neighbour couplers；
- readout resonators；
- shared or grouped readout feedline；
- XY/control lines；
- labels and ports。

交付：

- `design-repo/design-code/src/pi_chip_design/templates/ten_qubit_ladder.py`
- `design-repo/design-code/src/pi_chip_design/layouts/ten_qubit_ladder.py`
- `design-repo/design-code/outputs/ten_qubit_ladder.gds`
- `design-repo/design-records/design-records/ten_qubit_ladder_concept.md`
- `design-repo/design-artifacts/ten-qubit-ladder/manifest.json`

验收：

- `design-agent` 能运行脚本生成 GDS。
- GDS 不是空文件。
- design record 说明证据、假设、限制和下一步验证。

### 第 3 周：结构验证和基础几何验证

目标：让设计不是“画出来就算完”，而是可检查。

任务：

1. 实现 topology verifier。
2. 实现 Layout IR verifier。
3. 实现 GDS summary checker。
4. 输出 verification report。
5. 让失败项能回写 design record。

检查项：

- 10 个 qubits；
- 2 x 5 ladder topology；
- 每个 qubit 有 readout resonator；
- 每个 qubit 有 control line；
- coupling edges 数量正确；
- 所有组件在 chip boundary 内；
- GDS 可解析；
- Layout IR 和 GDS summary 一致。

交付：

- `design-repo/design-code/src/pi_chip_design/verification/topology.py`
- `design-repo/design-code/src/pi_chip_design/verification/gds_summary.py`
- `design-repo/design-code/src/pi_chip_design/layouts/verify_ten_qubit_ladder.py`
- `design-repo/design-records/verification-reports/ten_qubit_ladder_verification.md`
- `design-repo/design-records/verification-reports/ten_qubit_ladder_verification.json`

验收：

- verifier 可以独立运行。
- verifier 能指出具体失败原因。
- verification report 可以被 `wiki-agent` 总结。

### 第 4 周：论文演示闭环和写作材料

目标：把系统整理成可写论文的实验案例。

任务：

1. `wiki-agent` 汇总 `nature14270` 设计记忆。
2. `wiki-agent` 汇总 10-qubit design task。
3. `design-agent` 生成最终 Layout IR、GDS、verification report。
4. `wiki-agent` 写系统闭环 summary。
5. 形成论文图和表：
   - agent workflow 图；
   - design memory -> task spec -> layout artifact 流程图；
   - 10-qubit GDS 渲染图；
   - verification table；
   - limitation/future work table。

交付：

- `docs/paper-notes/design-wiki-10qubit-case-study.md`
- `docs/paper-notes/figures/ten_qubit_ladder_render.png`
- `docs/paper-notes/tables/verification_summary.md`
- `docs/paper-notes/claims.md`
- `docs/paper-notes/limitations.md`

验收：

- 有完整 case study。
- 10 比特版图是主要亮点。
- 论文叙事中清楚区分：
  - 当前完成：agentic concept-layout design workflow；
  - 未完成：mask-ready design、full EM validation、PDK closure。

## 一个月结束时的结果

一个月结束时应具备：

```text
wiki-agent:
  nature14270 设计记忆
  专家规则记录
  10 比特设计任务
  verification 结果总结

design-agent:
  10 比特 Layout IR
  10 比特 Python layout code
  10 比特 GDS
  topology / geometry verification
  design record

paper artifacts:
  workflow figure
  GDS render figure
  verification table
  case study text
```

论文可以主打：

> A design-wiki-guided agentic workflow that distills superconducting-chip design knowledge from literature and expert feedback, then automatically generates and verifies a 10-qubit superconducting-chip concept layout.

## 本月不做但论文可讨论的后续工作

后续工作包括：

- 完整 PDK / DRC；
- full-chip EM simulation；
- visual model closed-loop layout repair；
- parameter optimization；
- package and cryogenic control co-design；
- calibration feedback ingestion；
- multi-paper benchmark；
- mask-ready tapeout flow。

这些不要在本月实现，但可以作为 future work 支撑论文路线图。

## 风险控制

### 风险 1：10 比特版图被认为只是示意图

应对：

- 输出 Layout IR、GDS、verification report，而不是只给图片。
- 明确每个组件和检查项。
- 说明它是 concept layout，不是 mask-ready layout。

### 风险 2：创新点不够强

应对：

- 重点不是“画了 10 个 qubit”，而是“wiki-agent 作为设计记忆系统指导 design-agent 自动生成可验证 artifact”。
- 强调 agent 分工、知识沉淀、task spec、verification record。

### 风险 3：一个月内做不完

应对：

- 必须优先完成：
  1. Design Task Spec；
  2. 10-qubit Layout IR；
  3. GDS generation；
  4. topology verifier；
  5. case study summary。
- 如果时间不足，砍掉：
  - GDS visual automated review；
  - simulation；
  - multi-candidate optimization；
  - 第二篇论文 benchmark。

## 最小可发表版本

最小可发表版本包含：

- 一个 design-wiki memory layer；
- 一个 `nature14270`-grounded design extraction / memory example；
- 一个 wiki-agent-generated 10-qubit design task；
- 一个 design-agent-generated 10-qubit superconducting-chip GDS；
- 一个 topology / geometry verification report；
- 一个专家反馈如何进入下一轮的示例；
- 清楚说明当前是 concept-layout automation，不是 tapeout-ready flow。

## 一句话总结

本月计划不追求完整端到端芯片设计，而是快速做出一个有论文亮点的最小闭环：`wiki-agent` 作为设计记忆系统，从 `nature14270` 和专家反馈中形成设计任务，指导 `design-agent` 自动生成并验证 10 比特超导量子芯片概念版图。
