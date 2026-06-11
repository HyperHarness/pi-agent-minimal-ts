# Design-Wiki Nature14270 Agent Development Plan

## 目标

本计划的目标不是让人手工拆解论文并生成一次性版图，而是开发一套由 agent 主导的芯片设计数据飞轮：

```text
文献学习 + 专家修正
        ↓
wiki-agent 形成设计流程知识
        ↓
wiki-agent 指导 design-agent 补工具 / 写代码 / 运行验证
        ↓
design-agent 产出版图、仿真、验证记录
        ↓
wiki-agent 总结成功失败，更新 wiki
        ↓
下一轮设计复用
```

第一篇 benchmark 选用 Nature 论文 `nature14270`，即 *State preservation by repetitive error detection in a superconducting quantum circuit*。它包含一个一维 9-qubit Xmon repetition-code superconducting circuit，适合作为 agentic paper-to-layout reconstruction 的第一条闭环样例。

核心原则：

- 主要任务由 `wiki-agent` 和 `design-agent` 完成。
- 人类专家主要提供审核、纠错和高价值设计判断。
- 我的开发工作集中在 agent 能力、协议、工具流、验证器和数据记录格式。
- 不把人工分析结果硬编码成答案。

## 核心瓶颈

### 1. 芯片设计流程知识缺乏

当前最大问题不是 `wiki-agent` 能不能总结论文，而是它能不能从论文和专家反馈中学习可执行的设计流程。

`wiki-agent` 需要学会区分：

- 论文科学结论；
- 器件拓扑；
- 设计参数；
- 工艺栈和 fabrication constraints；
- 读出、控制、耦合、频率规划；
- 版图意图；
- 仿真和实验验证流程；
- 明确缺失、不能推断的信息。

对 `nature14270`，`wiki-agent` 至少应能抽取：

- 9 个 Xmon transmon qubits；
- 5 个 data qubits 与 4 个 measurement qubits；
- linear alternating pattern；
- nearest-neighbour coupling；
- individual control and readout；
- readout resonators / bandpass filter 设计线索；
- sample fabrication notes；
- Table S3 中的 device parameters；
- 哪些几何尺寸、PDK 规则、封装细节没有在论文中充分给出。

难点在于论文通常不是设计手册。大量设计知识散落在主文、图注、补充材料、表格、micrograph 和实验室隐性经验中。没有专家引导，`wiki-agent` 很容易只学到表面描述，而不是可执行设计约束。

### 2. Wiki-Agent 指导 Design-Agent 的中间层缺失

当前 repo 已经把 `wiki-agent` 和 `design-agent` 边界分开，但缺少一个把文献知识翻译成工程任务的中间层。

需要开发 `Design Task Spec`，由 `wiki-agent` 生成，供 `design-agent` 执行。

这个 spec 应包含：

- 设计目标；
- 已知约束；
- 证据来源；
- 缺失信息；
- 可接受假设；
- 禁止假设项；
- 需要开发或复用的 design-code 工具；
- 需要运行的验证；
- 失败时应写入的记录格式。

没有这个中间层，`design-agent` 只能从自然语言或论文原文中临时猜任务，工具开发也会变成一次性脚本。

目标状态是：

```text
wiki-agent 学到设计流程
  -> 生成 design task spec
  -> 指导 design-agent 补工具 / 写模板 / 运行验证
  -> design-agent 产出 artifact
  -> wiki-agent 评估结果并更新知识
```

### 3. Design-Agent 工具流不固定

当前 `design-agent` 已经有写代码、同步环境、运行脚本、生成 GDS、写 design record、提交部分仿真的基础工具，但还没有稳定的 superconducting-chip EDA 工具流。

需要逐步固定以下工具流：

1. Layout workflow

   ```text
   Design Task Spec -> Layout IR -> Python template -> GDS
   ```

2. Structure verification workflow

   ```text
   Layout IR / GDS -> topology check -> component check -> layer check
   ```

3. Simulation preparation workflow

   ```text
   Layout IR -> Q3D / eigenmode / participation manifest -> remote or local solver
   ```

4. Design record workflow

   ```text
   result -> verification report -> failure record -> wiki follow-up
   ```

`design-agent` 还需要可复用的 design-code components：

- Xmon qubit；
- transmon capacitor pads；
- Josephson junction placeholder；
- readout resonator；
- capacitive coupler；
- feedline；
- XY control line；
- Z / flux control line；
- bandpass filter；
- ground bridge / crossover placeholder；
- labels and evidence-linked markers。

没有这些固定工具流，`design-agent` 每次都会像临时写脚本，很难积累能力。

### 4. 版图正确性验证困难

自动迭代的最大障碍是验证。不能只验证：

```text
GDS 文件存在
```

真正需要验证的是：

- 版图是否表达了论文中的器件拓扑；
- 9 个 qubits 是否线性排列；
- data / measurement roles 是否交替；
- nearest-neighbour couplings 是否正确；
- readout / control / filter 结构是否存在；
- Layout IR 与 GDS 是否一致；
- 是否出现明显几何错误、断线、重叠、不合理 routing；
- 渲染后的图是否接近论文 figure 或预期 layout intent。

验证应分三层：

1. 结构验证：检查 qubit 数量、角色、拓扑、coupling graph、readout/control 是否完整。
2. 几何验证：检查重叠、断线、边界、层、间距、端口连接。
3. 视觉验证：把 GDS 渲染成图片，与论文 figure 或预期 layout intent 对比。

视觉能力非常关键，因为 `nature14270` 的很多信息来自 optical micrograph 和图示，而不是结构化表格。没有视觉闭环，`design-agent` 很难自动迭代版图，只能依赖人眼检查。

### 5. 专家反馈不能停留在聊天里

专家介入不可避免，但不能每轮都重复解释同样问题。专家反馈必须结构化进入数据飞轮。

需要开发 `Expert Correction Record`：

```json
{
  "target": "nature14270",
  "issue": "qubit role assignment wrong",
  "correction": "roles alternate D-M-D-M-D-M-D-M-D",
  "evidence": "Figure 1 and repetition-code description",
  "generalizesTo": ["linear repetition code", "surface-code primitive"]
}
```

目标状态：

- 专家每次纠错都进入知识库；
- `wiki-agent` 下一轮抽取时读取 correction；
- `design-agent` 下一轮生成时受 correction 约束；
- benchmark 能统计同类错误是否减少；
- 高价值专家判断逐步沉淀成 design rules、method pages、failure records。

### 6. 复现标准必须分层

不能笼统地说“复现 9 比特芯片版图”。必须定义分层目标，否则 agent 容易走偏。

建议分为五级：

| Level | 目标 | 判据 |
| --- | --- | --- |
| Level 1 | 拓扑复现 | 9 qubits、线性、5 data + 4 measurement、8 nearest-neighbour edges |
| Level 2 | 设计意图复现 | Xmon、readout resonators、control lines、bandpass filter、Table S3 参数进入 IR |
| Level 3 | 几何版图复现 | 生成 GDS，结构和视觉上接近论文器件图，但明确不是 mask-ready |
| Level 4 | 局部仿真复现 | 对 readout / coupler / qubit 局部结构做 Q3D、eigenmode、participation 等验证 |
| Level 5 | 工程闭环 | 参数、版图、仿真、专家修正、wiki 总结全部进入 flywheel |

`nature14270` 第一阶段只追 Level 1 到 Level 3，不应一开始追 Level 4 到 Level 5。

## 开发阶段

### 阶段 A：定义瓶颈驱动的 Benchmark Contract

目标：明确 `nature14270` 到底考什么。

要交付：

- `nature14270` benchmark case；
- 复现等级定义；
- scoring rubric；
- expert correction 格式；
- `wiki-agent` / `design-agent` 分工协议；
- 禁止过度推断规则；
- failure categories。

成功标准：

- 人类不用反复解释“什么叫复现成功”；
- agent 失败时知道失败在哪一层；
- benchmark 能区分 topology failure、evidence failure、geometry failure、visual failure。

### 阶段 B：开发 Wiki-Agent 的设计流程学习能力

目标：让 `wiki-agent` 从论文中学习设计流程，而不是只写摘要。

要交付：

- `Design Process Extraction Contract`；
- evidence locator 格式；
- missing information classifier；
- expert correction reader；
- method / dataset / finding / design-rule 页面模板；
- 面向 `nature14270` 的第一次自动抽取运行。

成功标准：

- `wiki-agent` 能从 `nature14270` 自动抽取设计流程；
- 输出中没有无证据尺寸和过度推断；
- 每个关键字段都有 source locator 或 explicit unknown；
- 输出可以被 `design-agent` 直接消费。

### 阶段 C：开发 Wiki-Agent 到 Design-Agent 的任务翻译层

目标：让 `wiki-agent` 指导 `design-agent`，而不是让人类直接指导。

要交付：

- `Design Task Spec`；
- `Tool Requirement Spec`；
- `Verification Requirement Spec`；
- `Design-Agent Handoff Format`；
- `wiki-agent` 生成 design task 的 workflow。

成功标准：

- `wiki-agent` 能说清楚 `design-agent` 需要开发什么模板、运行什么验证、写什么记录；
- `design-agent` 不需要从论文原文重新猜任务；
- 同一个 design task 能重复运行并稳定产出。

### 阶段 D：固定 Design-Agent 的 Layout 工具流

目标：让 `design-agent` 有稳定的芯片版图生成流程。

要交付：

- `Layout IR`；
- Xmon / resonator / coupler / control-line components；
- `nature14270` 9-qubit repetition-code template；
- GDS renderer；
- design artifact manifest；
- design-code tests。

成功标准：

- `design-agent` 可以根据 `wiki-agent` 的 task spec 生成 GDS；
- 生成结果不是一次性脚本，而是可复用 design-code；
- 产物包含 Layout IR、GDS、summary、artifact manifest。

### 阶段 E：建立验证工具流

目标：让 `design-agent` 能判断自己画得是否正确。

要交付：

- topology verifier；
- Layout IR verifier；
- GDS parser / checker；
- GDS-to-image renderer；
- visual review task spec；
- verification report schema。

成功标准：

- 不只检查 “GDS 文件存在”；
- verifier 能指出具体错误：
  - qubit 少了；
  - data / measurement 角色错了；
  - nearest-neighbour edge 错了；
  - readout 缺失；
  - control line 缺失；
  - GDS 与 Layout IR 不一致；
  - 渲染图与 Figure 1 或 layout intent 不一致。

### 阶段 F：闭环运行 Nature14270

目标：让 agent 完成第一条完整 flywheel。

流程：

```text
wiki-agent 抽取论文
wiki-agent 生成 design task
design-agent 生成 Layout IR / GDS
design-agent 运行 verifier
wiki-agent 总结结果
专家修正
wiki-agent 更新规则
下一轮 rerun
```

成功标准：

- 人类专家只做审核和纠错，不做主流程分解；
- 每次错误都会沉淀成 correction 或 design rule；
- rerun 后同类错误减少；
- `nature14270` 可以作为后续论文的 reference benchmark。

### 阶段 G：扩展到第二篇论文

目标：验证 flywheel 是否真的可复用。

要做：

- 选择第二篇包含 chip layout / micrograph / parameter table 的 superconducting-chip 论文；
- 跑同一套 extraction、task spec、layout、verification workflow；
- 比较第一篇和第二篇的失败类型；
- 更新通用 Xmon / readout / coupling / frequency-planning wiki pages；
- 建立小型 benchmark leaderboard。

成功标准：

- 第二篇论文不需要重新设计全部 schema；
- 常见错误数量下降；
- expert correction 能跨论文复用；
- `wiki-agent` 能主动建议 `design-agent` 需要补的工具。

## 最优先的三个 Contract

当前最应该先做的不是 PPT，也不是直接生成 GDS，而是三个 contract：

### 1. Design Process Extraction Contract

解决 `wiki-agent` 学什么。

核心字段：

- device summary；
- qubit roles；
- topology；
- coupling graph；
- readout architecture；
- control architecture；
- fabrication notes；
- parameter tables；
- evidence map；
- unknowns；
- expert corrections applied。

### 2. Design Task Spec Contract

解决 `wiki-agent` 如何指导 `design-agent`。

核心字段：

- design objective；
- constraints；
- required components；
- required tools；
- assumptions allowed；
- assumptions forbidden；
- expected artifacts；
- required verifications；
- failure handling。

### 3. Verification Contract

解决 `design-agent` 如何知道自己错了。

核心字段：

- checks run；
- pass / fail；
- evidence coverage；
- topology mismatches；
- geometry mismatches；
- visual review status；
- generated artifacts；
- suggested next correction。

## 推荐的近期里程碑

### 第 1 周：Contract 与 Benchmark

- 定义 `nature14270` benchmark；
- 写复现分级和评分标准；
- 写 extraction / task / verification contract；
- 写 expert correction 格式。

### 第 2 周：Wiki-Agent 抽取

- 让 `wiki-agent` 对 `nature14270` 生成 design process extraction；
- 人类专家只审核抽取结果；
- 把专家反馈写成 correction record。

### 第 3 周：Design-Agent Layout 工具流

- 让 `design-agent` 根据 task spec 生成 Layout IR；
- 生成 9-qubit Xmon repetition-code GDS；
- 写 design artifact manifest。

### 第 4 周：验证与闭环

- 跑 topology / IR / GDS verifier；
- 生成 verification report；
- `wiki-agent` 汇总 reusable design rules；
- rerun `nature14270`，检查错误是否减少。

## 计划的判断标准

这个项目是否走在正确方向，不看单次 GDS 是否漂亮，而看以下指标：

- `wiki-agent` 是否减少了人类手工分解论文的工作量；
- `wiki-agent` 是否能生成 `design-agent` 可执行的工程任务；
- `design-agent` 是否越来越少写一次性脚本；
- verifier 是否能指出具体错误；
- 专家反馈是否能影响下一轮；
- 第二篇论文是否能复用第一篇沉淀的知识。

## 一句话总结

先让 `wiki-agent` 学会把论文和专家反馈转成可执行设计任务；再让 `design-agent` 基于任务形成固定 layout、simulation、verifier 工具流；最后用视觉验证和专家 correction 建立可迭代的数据飞轮。
