# Design: WeChat Bridge for OpenCode `question` Tool

> Status: **Draft for review** · 方案 A（阻塞式 / Bridge-mediated Blocking）· Owner: 待指派

## 1. 目标与非目标

### 目标

1. **端到端可用**：当 agent 调用 `question` 工具时，WeChat 用户能在私聊中看到问题、回复答案，agent 收到 answer 后继续执行。
2. **无破坏性**：现有消息流（text / tool / reasoning / file / 权限自动批准）保持不变。
3. **可见性**：任何 pending question 在 WeChat 端始终有"未回答"提示，30 分钟软超时主动 reject 并通知用户。
4. **可恢复**：bridge 重启 / 微信掉线时，server 端的 pending question 通过 `question.rejected` 事件自然清理，bridge 不需要落盘状态。

### 非目标

- ❌ 不支持 question 的 rich UI（按钮 / 卡片）——WeChat 个人号 iLink 不可行。
- ❌ 不实现多端同步（同时 TUI + 微信回答同一 question）——单用户单端定位。
- ❌ 不改 server 端协议（无回调 URL 注册 / 无反向 socket）——只用 server 已暴露的 `GET /question`、`POST /question/:id/{reply,reject}`。
- ❌ 不持久化 pending question 状态——重启即清空，依靠 server `question.rejected` 事件驱动清理。

## 2. 背景

### 2.1 根因

`src/server/session.ts:538-564` 的 `handleEvent` switch 只识别 7 种事件；`question.asked/replied/rejected` 三种全部落入 `default` 分支被静默丢弃。`src/server/client.ts` 也没有 `replyToQuestion` / `rejectQuestion` 方法。

### 2.2 现状

- **数据流**：`bridge.handleMessage → sessionManager.enqueue → client.sendMessageAsync → opencode 处理 → SSE /global/event → event-pipeline → session.handleEvent → 调 onReply/onMediaReply`。
- **生命周期**：`enqueue` 推一个 `QueueItem` → 调 `sendPromptAsync` 立刻返回（fire-and-forget）→ 通过事件流累积 turn → `session.idle` 时 finalize 推送到 WeChat。
- **缺失环节**：tool 触发的 server 端 `Deferred.await()`（`packages/opencode/src/question/index.ts:172`）等不到 answer，agent 永远停在 running 状态。

### 2.3 server 端能力

来自 `packages/opencode/src/question/` + `server/routes/instance/httpapi/groups/question.ts`：

| 资源 | 说明 |
|------|------|
| `GET /question` | 列出所有 pending question（用于恢复状态） |
| `POST /question/:requestID/reply` | body `{ answers: string[][] }` |
| `POST /question/:requestID/reject` | 无 body |
| SSE `question.asked` | payload `{ id, sessionID, questions[], tool? }` |
| SSE `question.replied` | payload `{ sessionID, requestID, answers }` |
| SSE `question.rejected` | payload `{ sessionID, requestID }` |

`requestID` 形如 `que_xxx`（`Schema.isStartsWith("que")`）。

## 3. 整体架构

```
              ┌──────────────────────────────────────────────────────┐
              │ opencode server (event bus + /question HTTP)         │
              └─────┬──────────────────────────────────────────▲─────┘
                    │ SSE /global/event                          │
                    │ (question.asked/replied/rejected)          │ HTTP
                    ▼                                            │
            ┌──────────────────┐                                 │
            │ event-pipeline   │                                 │
            │ + unwrapPayload  │                                 │
            └────────┬─────────┘                                 │
                     │ OpenCodeEvent                              │
                     ▼                                            │
            ┌──────────────────┐  set pendingQuestion            │
            │ session.handleEvent  ──────────────────┐           │
            │                                       ▼           │
            │                       ┌────────────────────────┐   │
            │                       │ pendingQuestion        │   │
            │                       │  { requestID,          │   │
            │                       │    questions[],        │   │
            │                       │    contextToken,       │   │
            │                       │    askedAt }           │   │
            │                       └──────────┬─────────────┘   │
            │                                  │                 │
            │  answerPendingQuestion(answers) │                 │
            │  rejectPendingQuestion()        │                 │
            └──────────────┬───────────────────┘                 │
                           │                                     │
                           │ HTTP                                │
                           ▼                                     │
            ┌──────────────────────────┐   POST /question/:id/... │
            │ OpenCodeServerClient    │ ─────────────────────────►
            │ .replyToQuestion()      │
            │ .rejectQuestion()       │
            │ .listQuestions()        │
            └──────────────────────────┘

   WeChat iLink
   ┌──────────┐                          ┌──────────────────────────┐
   │  user    │  ← 收到问题展示消息 ────  │ bridge.handleMessage      │
   │          │  ← 收到超时/拒绝通知 ────  │   ↓                       │
   │          │  ──── 用户输入 "Q1=1 Q2=2"  │  (if pendingQuestion)     │
   │          │ ──── 触发 reject 命令 ──► │   → handleQuestionReply() │
   └──────────┘                          │   → sessionManager         │
                                         │      .answerPending(...)   │
                                         └──────────────────────────┘
```

## 4. 状态机

### 4.1 `SessionManager.pendingQuestion` 生命周期

```
         (none)
            │
            │ SSE question.asked (event for current session)
            ▼
     ┌─────────────┐
     │   pending   │ ─── 30 分钟无应答 ────► auto-reject
     │             │                          │
     │  replied    │ ◄── sessionManager ─────┘
     │  rejected   │     .answerPendingQuestion()
     │  timed out  │     .rejectPendingQuestion()
     └──────┬──────┘
            │
            │ (内部状态清空，turn 继续累积)
            ▼
         (none)
```

**外部触发**：
- `pendingQuestion` 被填充：仅在 `handleEvent` 中 `case "question.asked"` 触发
- `pendingQuestion` 被清空：四种情况——
  1. 用户成功回复 → `answerPendingQuestion` 后清空
  2. 用户主动 reject（如 `/stop`）→ `rejectPendingQuestion` 后清空
  3. 软超时（30 分钟）→ `rejectPendingQuestion` 后清空
  4. SSE `question.replied` / `question.rejected` 事件到达 → 仅作"服务器已清"的对账，本地清空（防止 race）

### 4.2 与现有 turn 状态机的关系

`question.asked` 到达时 `currentTurn` 仍处于 `accumulating` 状态（agent tool call 还在 running）。**不要**触发现有 `finalizeTurn` 逻辑——agent 还在等。

turn 继续累积 question tool part 的 `pending → running` 状态。用户提交 answer 后，server 把 tool 标为 `completed`，agent 继续工作，`message.part.updated` 推送 tool 的 output。turn 在 `session.idle` 时正常 finalize（这部分逻辑零修改）。

`pendingQuestion` 与 `currentTurn` 是**正交**的两个状态——一个管"question slot"，一个管"turn slot"。

## 5. 数据模型

### 5.1 新增 types（`src/types/question.ts`）

```ts
/** Mirrors packages/opencode/src/question/index.ts */
export interface QuestionOption {
  readonly label: string;        // 1-5 词
  readonly description: string;  // 选项说明
}

/** One question — mirrors Question.Prompt */
export interface QuestionPrompt {
  readonly question: string;
  readonly header: string;             // ≤ 30 字符
  readonly options: ReadonlyArray<QuestionOption>;
  readonly multiple?: boolean;         // 默认 false
  readonly custom?: boolean;           // 默认 true
}

/** Mirror of Question.Tool (the tool part that triggered this question) */
export interface QuestionToolRef {
  readonly messageID: string;
  readonly callID: string;
}

/** Server-emitted "question.asked" payload */
export interface QuestionRequest {
  readonly id: string;                       // "que_xxx"
  readonly sessionID: string;
  readonly questions: ReadonlyArray<QuestionPrompt>;
  readonly tool?: QuestionToolRef;
}

/** Server-emitted "question.replied" payload */
export interface QuestionRepliedEvent {
  readonly sessionID: string;
  readonly requestID: string;
  readonly answers: ReadonlyArray<ReadonlyArray<string>>;
}

/** Server-emitted "question.rejected" payload */
export interface QuestionRejectedEvent {
  readonly sessionID: string;
  readonly requestID: string;
}

/** Internal state held on SessionManager */
export interface PendingQuestion {
  readonly requestID: string;
  readonly questions: ReadonlyArray<QuestionPrompt>;
  readonly contextToken: string;
  readonly askedAt: number;
  readonly tool?: QuestionToolRef;
}
```

### 5.2 新增 SSE 事件类型（`src/types/events.ts`）

在 `OpenCodeEvent` union 末尾追加：

```ts
export interface QuestionAskedEvent {
  type: "question.asked";
  properties: QuestionRequest;   // { id, sessionID, questions[], tool? }
}
export interface QuestionRepliedSseEvent {
  type: "question.replied";
  properties: QuestionRepliedEvent;
}
export interface QuestionRejectedSseEvent {
  type: "question.rejected";
  properties: QuestionRejectedEvent;
}

export type OpenCodeEvent =
  | MessagePartDeltaEvent
  | MessagePartUpdatedEvent
  | MessageUpdatedEvent
  | MessageRemovedEvent
  | SessionStatusEvent
  | SessionIdleEvent
  | SessionErrorEvent
  | QuestionAskedEvent
  | QuestionRepliedSseEvent
  | QuestionRejectedSseEvent;
```

## 6. WeChat 展示格式

### 6.1 单问题模板

```
❓ [Auth method]
Which auth method should I use?

  1. OAuth2 — Use GitHub OAuth flow
  2. API Key — Use a static API key
  3. Skip auth — No authentication

💡 Reply with the option number (e.g. "1"), numbers (e.g. "1, 3" for multi-select), or type your own answer.
```

如果 `custom === false`（不允许自定义），删除最后一句里的 "or type your own answer"。
如果 `multiple === true`，模板里"options"行后追加：`  (multi-select; reply with comma-separated numbers)`。

### 6.2 多问题模板

```
❓ Question 1/2 [Auth method]
Which auth method?

  1. OAuth2 — Use GitHub OAuth flow
  2. API Key — Use a static API key

❓ Question 2/2 [Cache]
Enable caching?

  1. Yes — Cache responses for 1 hour
  2. No

💡 Reply with "Q{n}=" for choices / "Q{n}-" for custom (space-separated; order doesn't matter):
   • Single-select: "Q1=1 Q2=2"
   • Multi-select:  "Q1=1, 3 Q2=2"
   • Custom:        "Q2-这题我有自己想法"  (the dash forces free-form text)
   • Mixed:         "Q1=1 Q2-这题我有自己想法 Q3=3"
   • Skip (use default): just don't include that Qn-

   Mobile-friendly: spaces around the marker are ignored — "Q1 = 1", "Q1 =1" and "Q1= 1" all work.
   Tip: use "-" whenever the content might look like a number, to keep it as text.

   Short form (positional, must be in order): "1 --- 2 --- 3"
```

### 6.3 辅助提示（pending 状态）

- 提交答案成功 → 不发额外消息（用户原本就在等 tool 输出，agent 继续）
- 30 分钟无应答 → 发一条 `⏱ Question timed out — I'll proceed with defaults. Use /next to reset.` 然后 reject
- 用户主动 reject（`/stop` 触发）→ 发一条 `❌ Question dismissed.`

## 7. 用户回复解析语法

### 7.1 语法（EBNF-like）

```
reply        := qnFormat | dashFormat | singleAnswer

qnFormat     := qnSegment ( ws qnSegment )*
qnSegment    := "Q" questionIndex ws* marker ws* content
questionIndex := [0-9]+                    // 1-based, 越界 silent drop
marker       := "=" | "-"                  // "=" 正常解析；"-" 强制 custom
content      := .+                          // greedy until next Qn or end of input

dashFormat   := segment ( "---" segment )*   // 位置对应，遗留/快捷形式
singleAnswer := segment                     // 单题时直接给答案

segment      := numberList | customText
numberList   := number ( sep number )*
number       := [0-9]+
sep          := "," | ";" | "、" | ws
customText   := <any non-empty text, not a pure number list>
```

### 7.2 解析规则

**Step 0 — 格式检测**（按优先级）：

| 条件 | 使用格式 | 备注 |
|------|---------|------|
| 输入含 `Q\d+-` 模式 | `qnFormat` | **主推格式**，顺序无关，最清晰 |
| `questions.length > 1` 且输入含 `---` | `dashFormat` | 位置对应，遗留 fallback |
| `questions.length === 1` | `singleAnswer` | 整段作为唯一题目的答案 |
| 多题但用户只发 `1`（无 Qn- 无 ---） | `singleAnswer` (降级) | `1` 作为 Q1 答案，其余题目填首选项默认值；log info 提示用户用 Qn- 更稳 |

**Step 1a — qnFormat 解析**：

1. 按空白（`\s+`）粗切分输入为 qnSegments（实际以正则细匹配为准，允许 marker 周围有空白）
2. 对每个 qnSegment 用正则 `^Q(\d+)\s*([=\-])\s*(.*)$` 匹配：
   - `n` = `parseInt(groups[1])`（1-based）
   - `marker` = `groups[2]`（"=" 或 "-"）
   - `rest` = `groups[3]`（该题目的答案原文，可能含尾部空白会被 trim）
   - 如果 `n < 1` 或 `n > questions.length` → silent drop + log warning
   - 否则按 marker 分发：
     - **`marker === "="`** → 走 Step 2 把 `rest` 解析为 `Answer`（按 numberList/customText 规则），分配到 `answers[n-1]`
     - **`marker === "-"`** → `rest` 视为 customText，强制 `Answer = [rest.trim()]`，分配到 `answers[n-1]`（即使 `rest` 是纯数字如 "1, 3" 也按整体 custom 处理）
3. 任何**未分配**的题目 → 填首选项默认值

**Step 1b — dashFormat 解析**：

1. 按 `---` 切分；空白 trim
2. 顺序对应 questions[i]（i 从 0 开始）
3. 走 Step 2 把每个 segment 解析为 `Answer`
4. **segments 数量与 questions 数量不匹配**：少则填默认；多则合并到最后

**Step 1c — singleAnswer 解析**：

1. 整段 `text` 作为 `questions[0]` 的答案原文
2. 走 Step 2 解析为 `Answer`
3. 单题时 `answers` 数组只有 1 个元素

**Step 2 — segment → Answer 解析**（qnFormat / dashFormat / singleAnswer 共用）：

1. 把 segment 切分成 tokens（按 `,` / `;` / `、` / 空白 分隔）
2. 如果**所有 token 都是纯数字**且**没有混入其他文字** → 视为 numberList
3. 否则 → 视为 customText（整个 segment 作为单元素数组）

**Step 3 — numberList 映射**：

- `["1", "3"]` → `[questions[i].options[0].label, questions[i].options[2].label]`
- 数字越界（> options.length 或 < 1）→ 跳过该 token，silent drop，记入日志

**Step 4 — customText 收尾**：

- 整个 segment 视为一个自定义答案 → `[segment.trim()]`（数组单元素）

### 7.3 解析示例

**单题**：

| 用户输入 | questions 配置 | 解析结果 |
|---------|--------------|---------|
| `1` | 1 题 3 选项单选 | `[["OAuth2"]]` |
| `1, 3` | 1 题 3 选项多选 | `[["OAuth2", "Skip auth"]]` |
| `1;3` | 1 题 3 选项多选 | `[["OAuth2", "Skip auth"]]` |
| `OAuth2 with refresh` | 1 题 3 选项单选 | `[["OAuth2 with refresh"]]` |
| `Q1=1` | 1 题 3 选项单选 | `[["OAuth2"]]`（Qn= 形式在单题也可） |
| `99` | 1 题 3 选项 | `[]` → 触发空答案校验（见 §10） |
| `1, custom text` | 1 题（混入文字） | `[["1, custom text"]]`（custom） |

**多题 — Q{n}={value} / Q{n}-{value} 格式（主推）**：

| 用户输入 | questions 配置 | 解析结果 |
|---------|--------------|---------|
| `Q1=1 Q2=2` | 2 题各 3 选项单选 | `[["OAuth2"], ["Yes"]]` |
| `Q1=1, 3 Q2=2` | Q1 多选、Q2 单选 | `[["OAuth2", "Skip auth"], ["Yes"]]` |
| `Q1=1 Q2-这题我有自己想法 Q3=3` | 3 题（Q1/Q3 选, Q2 自定义） | `[["OAuth2"], ["这题我有自己想法"], ["Skip auth"]]` |
| `Q1=1, 3 Q2-yes Q3=2` | 3 题混合 | `[["OAuth2", "Skip auth"], ["yes"], ["No"]]` |
| `Q1 = 1` (手机空格) | 1 题 3 选项 | `[["OAuth2"]]`（空白容忍） |
| `Q1 - 这题我有自己想法` (手机空格) | 1 题 3 选项 | `[["这题我有自己想法"]]`（custom） |
| `Q2=1` (跳过 Q1) | 2 题 | `[["opt1_default"], ["OAuth2"]]`（Q1 走默认首选项） |
| `Q1=1 Q3=3` (跳过 Q2) | 3 题 | `[["OAuth2"], ["opt1_default"], ["Skip auth"]]` |
| `Q1=1 Q2=2 Q1=3` | 同 Q1 出现两次 | 第二次覆盖：`[["OAuth2","Skip auth"], ["Yes"]]` |
| `Q4=1` (越界) | 3 题 | `[["opt1"], ["opt1"], ["opt1"]]`（silent drop + 全默认） |
| **`Q2-3`** (写 "3" 当 custom) | 1 题 3 选项 | `[["3"]]`（**强制 custom**，非 option 3） |
| **`Q1-1, 3`** (整体 custom 含数字) | 1 题 3 选项 | `[["1, 3"]]`（**整体 custom**，非 multi-select） |

**多题 — dash 格式（fallback）**：

| 用户输入 | questions 配置 | 解析结果 |
|---------|--------------|---------|
| `1 --- 2` | 2 题各 3 选项单选 | `[["OAuth2"], ["Yes"]]` |
| `1, 2 --- 2` | 第 1 题多选、第 2 题单选 | `[["OAuth2", "API Key"], ["Yes"]]` |
| `OAuth --- yes` | 2 题各单选 | `[["OAuth"], ["yes"]]` |
| `1 --- OAuth2 --- 3` | 3 题（Q1/Q3 选, Q2 自定义）| `[["label1"], ["OAuth2"], ["label3"]]` |
| `1, 3 --- yes --- 2` | 3 题（Q1 多选, Q2 自定义, Q3 选） | `[["label1","label3"], ["yes"], ["label2"]]` |
| `   1   ---   2   ` | 2 题（多余空白 trim） | `[["OAuth2"], ["Yes"]]` |

**降级 / 异常**：

| 用户输入 | questions 配置 | 解析结果 |
|---------|--------------|---------|
| `1` | 3 题（多题无前缀无分隔符）| `[["OAuth2"], ["opt0"], ["opt0"]]` + log info "建议用 Qn- 格式" |
| `99` | 1 题 3 选项 | `[]` → 触发"无有效答案"提示（见 §10.3） |
| `1, custom text` | 1 题（混入文字） | `[["1, custom text"]]`（custom） |

### 7.4 已知歧义（已通过双 marker 设计消除）

- **早期设计（`Qn-X` 单 marker）的问题**：marker 后跟纯数字会优先解释为 option 编号，导致用户想写"3"作为 custom 答案时无法表达。
- **当前双 marker 设计（`Q{n}={value}` / `Q{n}-{value}`）的解法**：
  - `Q{n}={number}` → option（正常解析）
  - `Q{n}-{number}` → 强制 custom（即使内容是纯数字也按整体 custom 处理）
- **结果**：用户永远可以选 marker 来表达意图——想选 option 用 `=`，想写自由文本（含数字）用 `-`。无歧义、无 workaround。
- **示例**：
  - `Q2=3` → option 3
  - `Q2-3` → custom "3"
  - `Q1=1, 3` → multi-select options 1, 3
  - `Q1-1, 3` → custom "1, 3"（注意 `-` 不支持多选语法）

### 7.5 答案长度保护

单个 `Answer` 元素最大 500 字符。超过截断（log warning）。

整个 `Reply` payload 序列化后不超过 8KB（HTTP 安全范围）。

## 8. SessionManager 接口

### 8.1 新增方法

```ts
// ─── Question slot ───

/** True iff a question is currently waiting for the user's answer. */
hasPendingQuestion(): boolean;

/** Read-only view of the current pending question (for tests / status). */
getPendingQuestion(): PendingQuestion | null;

/** Called from handleEvent on SSE "question.asked". Internal. */
private setPendingQuestion(req: QuestionRequest, contextToken: string): void;

/**
 * User has answered the pending question. POSTs to server, then clears
 * the local slot. Safe to call only when hasPendingQuestion() === true.
 * Resolves once the HTTP reply returns (does NOT wait for SSE echo).
 */
async answerPendingQuestion(answers: ReadonlyArray<ReadonlyArray<string>>): Promise<void>;

/**
 * User has dismissed the pending question (via /stop, /restart, /next,
 * or 30-min soft timeout). POSTs to server's reject endpoint, clears
 * the local slot. Safe to call when no question is pending (no-op).
 */
async rejectPendingQuestion(): Promise<void>;

/**
 * Internal: called on SSE "question.replied" or "question.rejected"
 * to clear the local slot (race-safe deduplication).
 */
private clearPendingQuestion(requestID: string, reason: "replied" | "rejected"): void;
```

### 8.2 `handleEvent` switch 改动

```ts
case "question.asked":
  this.handleQuestionAsked(event as QuestionAskedEvent);
  break;
case "question.replied":
  this.handleQuestionRepliedSse(event as QuestionRepliedSseEvent);
  break;
case "question.rejected":
  this.handleQuestionRejectedSse(event as QuestionRejectedSseEvent);
  break;
```

### 8.3 内部 handler

```ts
private handleQuestionAsked(event: QuestionAskedEvent): void {
  const req = event.properties;
  if (this.pendingQuestion) {
    // 防御：上一个 question 还没清（不应该发生，但 SSE 重复投递可能）
    this.log(`[question] dropping new asked (id=${req.id}) — previous unanswered (id=${this.pendingQuestion.requestID})`);
    return;
  }
  // 必须有 contextToken 才能把"问题展示"发到正确的微信会话
  const contextToken = this.lastEnqueuedContextToken;
  if (!contextToken) {
    this.log(`[question] no contextToken for asked id=${req.id}; auto-rejecting`);
    // 立即 reject 避免 agent 永远卡住
    this.client.rejectQuestion(req.id, this.cwd).catch(err => {
      this.log(`[question] auto-reject failed: ${String(err)}`);
    });
    return;
  }
  this.setPendingQuestion(req, contextToken);
  this.log(`[question] asked id=${req.id} (${req.questions.length} question(s))`);
  // 发微信（在 caller 栈外 fire-and-forget，避免阻塞 SSE 消费）
  this.onQuestionAsked?.(contextToken, req.questions, req.id).catch(err => {
    this.log(`[question] onQuestionAsked callback error: ${String(err)}`);
  });
  // 启 30 分钟软超时
  this.armQuestionTimeout();
}

private handleQuestionRepliedSse(event: QuestionRepliedSseEvent): void {
  this.clearPendingQuestion(event.properties.requestID, "replied");
}
private handleQuestionRejectedSse(event: QuestionRejectedSseEvent): void {
  this.clearPendingQuestion(event.properties.requestID, "rejected");
}
```

### 8.4 构造函数新增回调

`SessionManagerOpts` 增加：

```ts
/**
 * Invoked when a `question.asked` event arrives and a question is
 * queued for the WeChat user. Bridge should render the question and
 * push it to WeChat. Must be non-throwing (errors logged).
 */
onQuestionAsked?: (
  contextToken: string,
  questions: ReadonlyArray<QuestionPrompt>,
  requestID: string,
) => Promise<void>;
```

### 8.5 软超时

```ts
private questionTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
private static readonly QUESTION_TIMEOUT_MS = 30 * 60_000;

private armQuestionTimeout(): void {
  this.clearQuestionTimeout();
  this.questionTimeoutHandle = setTimeout(() => {
    const pending = this.pendingQuestion;
    if (!pending) return;
    this.log(`[question] timeout after ${QUESTION_TIMEOUT_MS}ms, auto-rejecting id=${pending.requestID}`);
    this.onQuestionTimedOut?.(pending.contextToken).catch(() => {});
    this.rejectPendingQuestion().catch(err => {
      this.log(`[question] auto-reject HTTP failed: ${String(err)}`);
    });
  }, SessionManager.QUESTION_TIMEOUT_MS);
}
```

构造函数新增 `onQuestionTimedOut?: (contextToken: string) => Promise<void>`。

## 9. OpenCodeServerClient 新增方法

加在 `src/server/client.ts`：

```ts
// ─── Questions ───

/**
 * List all pending question requests across all sessions.
 * Used at bridge startup to recover state and detect leaked questions.
 */
async listQuestions(directory?: string): Promise<ServerQuestionRequest[]> {
  try {
    const res = await this.fetch(this.withDirectory("/question", directory), { method: "GET" });
    if (!res.ok) return [];
    return res.json() as Promise<ServerQuestionRequest[]>;
  } catch {
    return [];
  }
}

/**
 * Reply to a pending question with the user's answers.
 * `answers.length` MUST equal the number of questions in the request.
 * Each inner array contains the selected option labels (or custom text).
 */
async replyToQuestion(
  requestID: string,
  answers: ReadonlyArray<ReadonlyArray<string>>,
  directory?: string,
): Promise<{ ok: boolean }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (directory) headers["x-opencode-directory"] = directory;
  const res = await this.fetch(
    `/question/${encodeURIComponent(requestID)}/reply`,
    { method: "POST", headers, body: JSON.stringify({ answers }) },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Question reply failed: ${res.status} ${text}`);
  }
  return { ok: true };
}

/**
 * Reject a pending question (user dismissed it).
 * The agent will receive a `QuestionRejectedError: "The user dismissed this question"`.
 */
async rejectQuestion(
  requestID: string,
  directory?: string,
): Promise<{ ok: boolean }> {
  const headers: Record<string, string> = {};
  if (directory) headers["x-opencode-directory"] = directory;
  const res = await this.fetch(
    `/question/${encodeURIComponent(requestID)}/reject`,
    { method: "POST", headers },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Question reject failed: ${res.status} ${text}`);
  }
  return { ok: true };
}
```

## 10. Bridge 层改动

### 10.1 `bridge.start()` 注入新回调

```ts
this.sessionManager = new SessionManager({
  // ... existing opts ...
  onQuestionAsked: async (contextToken, questions, requestID) => {
    const formatted = formatQuestionForWeChat(questions);
    await this.sendReply(contextToken, formatted);
  },
  onQuestionTimedOut: async (contextToken) => {
    await this.sendReply(
      contextToken,
      "⏱ Question timed out after 30 minutes. Proceeding without answer. (Use /next to reset counter.)",
    );
  },
});
```

### 10.2 `handleMessage` 早返回

在所有 slash command 解析之前：

```ts
// 1. If a question is pending, the next user message is an answer
if (this.sessionManager?.hasPendingQuestion()) {
  const text = this.extractTextFromMessage(msg);
  if (text === null) {
    // 收到非文本消息（图片/文件/语音）——不视作 answer，告诉用户
    this.sendReply(
      contextToken,
      "⚠️ 当前正在等待 question 答案，请用文本回复（数字或自定义文字）。",
    ).catch(() => {});
    return;
  }
  this.handleQuestionReply(contextToken, text, msg).catch(err => {
    this.log(`handleQuestionReply error: ${String(err)}`);
  });
  return;
}
```

### 10.3 新方法 `handleQuestionReply`

```ts
private async handleQuestionReply(
  contextToken: string,
  text: string,
  msg: WeixinMessage,
): Promise<void> {
  const pending = this.sessionManager?.getPendingQuestion();
  if (!pending) return; // 防御：理论上不会发生

  // 优先级命令：先 reject 再走原路径
  if (/^\/stop\b/.test(text.trim())) {
    await this.sessionManager.rejectPendingQuestion();
    this.handleStopCommand(contextToken, parseStopCommand(text)!).catch(...);
    return;
  }
  if (/^\/next\b/.test(text.trim())) {
    await this.sessionManager.rejectPendingQuestion();
    this.flushPending(contextToken).catch(...);
    return;
  }
  if (parseRestartCommand(text)) {
    await this.sessionManager.rejectPendingQuestion();
    this.handleRestartCommand(contextToken, parseRestartCommand(text)!).catch(...);
    return;
  }
  if (/^\/reject-question\b/.test(text.trim())) {
    // 显式 reject 命令（不进入任何其他路径）
    await this.sessionManager.rejectPendingQuestion();
    await this.sendReply(contextToken, "❌ Question dismissed.");
    return;
  }

  // 解析用户输入
  const parseResult = parseQuestionReply(text, pending.questions);
  if (parseResult.answers.length === 0) {
    // 所有数字都越界 — 让用户重答
    await this.sendReply(
      contextToken,
      "⚠️ No valid answer detected. Please reply with option numbers (e.g. \"1\") or type your own answer.",
    );
    return;
  }
  // 发送 typing 提示（agent 继续工作）
  this.sendTypingIndicator(contextToken).catch(() => {});
  await this.sessionManager.answerPendingQuestion(parseResult.answers);
  this.log(`[question] answered id=${pending.requestID} (${parseResult.answers.length} answer(s))`);
}
```

### 10.4 `stop()` 关闭时清 pending

```ts
async stop(): Promise<void> {
  // 先 reject pending question（避免 server 端永远等）
  if (this.sessionManager?.hasPendingQuestion()) {
    try {
      await this.sessionManager.rejectPendingQuestion();
    } catch { /* best effort */ }
  }
  // ... 现有清理逻辑 ...
}
```

### 10.5 `handleStatusCommand` 显示 pending

在 `handleStatusCommand` 现有 `formatStatus(...)` 之后、`sendReply` 之前插入一行：

```ts
// 在 formatStatus 之后追加
let statusText = formatStatus({ /* ... 现有参数 ... */ });
if (this.sessionManager?.hasPendingQuestion()) {
  const pending = this.sessionManager.getPendingQuestion();
  const duration = Math.round((Date.now() - pending!.askedAt) / 1000);
  statusText += `\n⏳ Question pending (${pending!.questions.length} question${pending!.questions.length > 1 ? "s" : ""}, ${duration}s elapsed, id=${pending!.requestID.slice(0, 12)}…)`;
}
await this.sendReply(contextToken, statusText);
```

设计要点：
- 不修改 `formatStatus` 函数本身（避免污染纯函数），在 bridge 层叠加
- 显示耗时帮助用户判断是否要 `/reject-question` 主动 reject
- 显示 `id` 短前缀方便排查 server 端日志

### 10.6 `bridge.start()` 启动时清 leaked question

在 `bridge.start()` 的 `startEventPipeline` 之后、WeChat 轮询启动**之前**插入：

```ts
// 5.5 清理 server 端残留的 leaked question（bridge 重启场景）
try {
  const serverRequests = await this.sessionManager!.listLeakedQuestions(this.config.agent.cwd);
  for (const req of serverRequests) {
    this.log(`[question-startup] rejecting leaked question id=${req.id}`);
    await this.sessionManager!.client.rejectQuestion(req.id, this.config.agent.cwd);
  }
  if (serverRequests.length > 0) {
    this.log(`[question-startup] rejected ${serverRequests.length} leaked question(s)`);
  }
} catch (err) {
  this.log(`[question-startup] leaked-question check failed (non-fatal): ${String(err)}`);
}
```

`SessionManager.listLeakedQuestions(directory?)` 新增方法：

```ts
/**
 * Return questions that exist on the server but are not tracked locally.
 * At bridge startup, this surfaces questions left pending from a previous
 * bridge instance — they will never be answered (the user already moved
 * on or the bridge crashed mid-question), so we reject them proactively.
 *
 * Filtering: the server's GET /question returns ALL pending questions
 * across all sessions. We only want to reject those for OUR sessionID —
 * other sessions may have their own clients.
 */
async listLeakedQuestions(directory?: string): Promise<ServerQuestionRequest[]> {
  try {
    const all = await this.client.listQuestions(directory);
    const mySession = this.sessionId;
    if (!mySession) return []; // 还没 session — 无需清理
    const localRequestId = this.pendingQuestion?.requestID;
    return all.filter((q) => {
      if (q.sessionID !== mySession) return false; // 别人的 session 不动
      if (localRequestId && q.id === localRequestId) return false; // 自己的
      return true;
    });
  } catch {
    return []; // 任何错误都降级为无 leaked（不影响启动）
  }
}
```

设计要点：
- **不过度清理**：只清理本 session 的、且本地没有对应 requestID 的
- **降级容错**：listQuestions 失败不阻塞 bridge 启动
- **不放进 startEventPipeline 之前**：因为 listQuestions 是 HTTP 短调用，可以先发请求；但实测 server 端 `/question` 不需要 session 也能响应（返回全部 session 的）。我们再加 session 过滤即可。
- **实际实现位置**：可以放在 `startEventPipeline` 之前（不依赖 SSE），更省事——本设计用"之后"只是因为和现有 6 步编号对齐

## 11. 文件级改动清单

| 文件 | 类型 | 估算行数 | 说明 |
|------|------|---------|------|
| `src/types/question.ts` | 新建 | ~60 | QuestionPrompt / QuestionOption / QuestionRequest / PendingQuestion / 三种 SSE 事件的 property types |
| `src/types/events.ts` | 改 | +20 | 加 3 个 event interface、扩展 OpenCodeEvent union |
| `src/adapter/question-format.ts` | 新建 | ~180 | `formatQuestionForWeChat(questions)` + `parseQuestionReply(text, questions)` + 私有 parse helpers + 单元测试覆盖 |
| `src/adapter/workspace-cmd.ts` | 改 | +25 | 新增 `parseRejectQuestionCommand`：识别 `/reject-question` / `/rq` 别名 |
| `src/server/client.ts` | 改 | +50 | `listQuestions` / `replyToQuestion` / `rejectQuestion` 三个方法 |
| `src/server/session.ts` | 改 | +170 | pendingQuestion 字段 + 8 个新方法（含 `listLeakedQuestions`）+ switch 加 3 case + 超时定时器 + 2 个构造回调 |
| `src/bridge.ts` | 改 | +130 | 注入 2 个回调 + handleMessage 早返回 + handleQuestionReply + stop 时清理 + **handleStatusCommand 追加 ⏳ 行** + **start() 启动 leaked-question 检查** + 优先级命令 bypass |
| `src/__tests__/adapter/question-format.test.ts` | 新建 | ~150 | 14 个 case 覆盖单/多题展示 + 8 个 case 覆盖用户回复解析 |
| `src/__tests__/server/session.question.test.ts` | 新建 | ~200 | mock OpenCodeServerClient，测 pendingQuestion 生命周期 + 三个 event handler + 超时 + race |
| **合计** | | **~985** | |

## 12. 测试计划

### 12.1 单元测试 `question-format.test.ts`

- [ ] format: 1 题 3 选项 + multiple=false + custom=true → 展示正确
- [ ] format: 1 题 5 选项 + multiple=true → 包含"multi-select"提示
- [ ] format: 1 题 3 选项 + custom=false → 不包含"or type your own"
- [ ] format: 2 题各 3 选项 → 展示"1/2" "2/2"和"Qn- 格式"说明（主推）
- [ ] format: 2 题各 3 选项 + 提示区含 "Q1=1 Q2=2" 示例
- [ ] format: options.description 空字符串 → 仍正常展示
- [ ] parse: `1` → `[["label1"]]`
- [ ] parse: `1, 3` 多选 → `[["label1","label3"]]`
- [ ] parse: `1;3` 多选 → 同上（分号支持）
- [ ] parse: `1 3` 空格分隔 → 同上
- [ ] parse: `OAuth2` 单题 → `[["OAuth2"]]`
- [ ] parse: 单题 + `Q1=1` → `[["label1"]]`（Qn= 在单题也可）
- [ ] parse: 单题 + `Q1 = 1`（手机空格）→ `[["label1"]]`（空白容忍）
- [ ] parse: 单题 + `Q1-这题我有自己想法` → `[["这题我有自己想法"]]`（Qn- 强制 custom）
- [ ] parse: 2 题 + `Q1=1 Q2=2` → `[["label1"],["label2"]]`（**Qn= 主路径**）
- [ ] parse: 2 题 + `Q1=1, 3 Q2=2`（首题多选）→ `[["label1","label3"],["label2"]]`
- [ ] parse: 3 题 + `Q1=1 Q2-这题我有自己想法 Q3=3`（混选+自定义）→ `[["label1"],["这题我有自己想法"],["label3"]]`
- [ ] parse: 3 题 + `Q1=1, 3 Q2-yes Q3=2`（混合）→ `[["label1","label3"],["yes"],["label2"]]`
- [ ] parse: 2 题 + `Q2=1`（跳过 Q1）→ Q1 走默认
- [ ] parse: 3 题 + `Q1=1 Q3=3`（跳过 Q2）→ Q2 走默认
- [ ] parse: 2 题 + `Q1=1 Q2=2 Q1=3`（Q1 重复）→ 第二次覆盖
- [ ] parse: 3 题 + `Q4=1`（越界）→ silent drop，全走默认
- [ ] parse: `Q2-3`（数字当 custom）→ `[["3"]]`，**非** option 3
- [ ] parse: `Q1-1, 3`（整体 custom 含数字）→ `[["1, 3"]]`，**非** multi-select
- [ ] parse: 2 题 + `Q1 = 1, 3   Q2 - 这题我有自己想法`（手机多重空格）→ `[["label1","label3"],["这题我有自己想法"]]`
- [ ] parse: 2 题 + `1 --- 2` → `[["label1"],["label2"]]`（dash fallback 仍工作）
- [ ] parse: 2 题 + `1, 2 --- 2`（首题多选）→ `[["label1","label2"],["label2"]]`
- [ ] parse: 3 题 + `1 --- OAuth2 --- 3`（dash 模式混选+自定义）→ `[["label1"],["OAuth2"],["label3"]]`
- [ ] parse: 3 题 + `1` 无 Qn- 无 ---（降级）→ `[["label1"],["opt0"],["opt0"]]`
- [ ] parse: `99` 越界 → `[]`
- [ ] parse: 长度 > 500 字符 → 截断
- [ ] parse: dash 模式 segments 多于 questions → 多余合并到最后一题
- [ ] parse: dash 模式 segments 少于 questions → 缺省题目用第一选项

### 12.2 单元测试 `session.question.test.ts`

- [ ] handleQuestionAsked: 正常路径填充 pendingQuestion，调 onQuestionAsked
- [ ] handleQuestionAsked: 无 contextToken → 立即 reject，不调 onQuestionAsked
- [ ] handleQuestionAsked: 上一个未清 → log warning + drop
- [ ] answerPendingQuestion: 调 client.replyToQuestion + 清空 pendingQuestion
- [ ] answerPendingQuestion: client 抛错 → pendingQuestion 清空但调用方拿到 error
- [ ] rejectPendingQuestion: 调 client.rejectQuestion + 清空
- [ ] rejectPendingQuestion: 无 pending → no-op
- [ ] handleQuestionRepliedSse: 清空 pending（race 兜底）
- [ ] handleQuestionRejectedSse: 清空 pending（race 兜底）
- [ ] 超时定时器: 30 分钟到时触发 rejectPendingQuestion
- [ ] 超时定时器: 用户提前 reply → 定时器被 clear
- [ ] hasPendingQuestion / getPendingQuestion 只读

### 12.3 手动测试脚本

启动真实 opencode + bridge，用 prompt 触发 `question` 工具：
- 观察微信收到展示
- 用 `1` 回复 → 观察 agent 收到 `"Q1"="label1"` 并继续
- 用 `OAuth` 回复（自定义）→ 观察 agent 收到自定义文本
- 用 `Q1=1` 回复（单题 + Qn= 前缀）→ 验证 Qn= 在单题也能用
- 用 `Q1 = 1` 回复（手机自动空格场景）→ 验证空白容忍
- 用 `Q1-这题我有自己想法` 回复（Qn- 强制 custom）→ 验证 dash 强制 custom 语义
- 用 `Q2-3` 回复（"3" 作为 custom 文字）→ 验证 Qn- 解决数字歧义
- 触发 2 题 question → 用 `Q1=1 Q2=2` 回复 → 验证两题都答对
- 触发 3 题 question → 用 `Q1=1 Q2-这题我有自己想法 Q3=3` 回复（混选+自定义）→ 验证 Qn= 与 Qn- 混用
- 触发 2 题 question → 用 `1 --- 2` 回复（dash fallback 路径）→ 验证 fallback 仍工作
- 触发 3 题 question → 只发 `1`（降级路径）→ 验证 Q1 拿到答案，Q2/Q3 走默认 + 微信提示用 Qn= 更稳
- bridge 重启 → 验证 onQuestionAsked 不被调用、状态正确清空

## 13. 边界情况（详尽清单）

| # | 场景 | 处理 |
|---|------|------|
| 1 | 用户在 question pending 时发非文本消息（图片/文件/语音） | 拒绝作为 answer，发"请用文本回复"提示 |
| 2 | 用户在 question pending 时发 `/help` | 走 help（不 reject question）；返回的 help 内容能让用户知道怎么答 |
| 3 | 用户在 question pending 时发 `/status` | 走 status（不 reject question）；status 应显示 `⏳ Question pending` |
| 4 | 用户在 question pending 时发 `/stop` | **先 reject question，再走 /stop** |
| 5 | 用户在 question pending 时发 `/next` | **先 reject question，再 flush pending 缓存** |
| 6 | 用户在 question pending 时发 `/restart` | **先 reject question，再走 /restart**（不返回 error） |
| 7 | 用户在 question pending 时发未知 slash command | 走未知命令提示（不 reject question） |
| 8 | 用户在 question pending 时发 `/reject-question`（新增） | reject question，结束等待 |
| 9 | 用户回复纯空白 | 视为"无答案"，重答提示 |
| 10 | 用户回复数字全越界 | 解析返回 `[]`，发"无有效答案"提示 |
| 11 | 用户回复 segments 多于 questions | 多余合并到最后一题（log warning） |
| 12 | 用户回复 segments 少于 questions | 缺省题目用第一选项填（log info） |
| 13 | 30 分钟无应答 | 软超时 → reject + 微信通知 |
| 14 | bridge 关闭 / crash | `stop()` 路径先 reject；非优雅关闭靠 server `question.rejected` 兜底 |
| 15 | session 重启 / opencode 重启 | server 端 instance dispose 时 fail 所有 deferred，发出 `question.rejected`，bridge 收到后清空本地状态 |
| 16 | 同一 requestID 重复收到 `question.asked` | server 端 ID 自增（`QuestionID.ascending()`）不可能；SSE 重投递时防御性 log + drop |
| 17 | `custom: false` + 用户给了自定义文字 | 忠实转发（不替 server 做限制） |
| 18 | `multiple: true` + 用户只选了 1 个 | 正常接受（单元素 Answer 数组） |
| 19 | `multiple: false` + 用户给了多个 | 全部取，server 端会接收所有 label（tool 端看到 "label1, label2"） |
| 20 | 微信回复被 splitText 切碎（> 4000 字符） | 问题展示裁剪到 ≤ 4000 字符；用户回复不受影响（普通消息） |
| 21 | pending question 跨 workspace 切换 | `getPendingQuestion` 返回 null 时早返回不处理；不主动 reject（让 server 端实例 dispose 兜底） |
| 22 | 收到 `question.asked` 时 `currentTurn === null` | 不可能（agent 必须在 turn 中调用 tool）；防御性 log + reject |
| 23 | `question.replied` SSE 到达前用户回复已被 POST | 客户端调用 `POST /reply` 成功 → server 发 SSE `question.replied` → bridge 二次清空是 no-op（幂等） |
| 24 | 用户在 question pending 时发第二个 question（递归） | 不可能——server 端 `pending` Map 是单 question per sessionID；防御性 log + drop |
| 25 | server 返回 404 on `POST /question/:id/reply` | client 抛错 → bridge 把错误转成用户可见消息 "⏱ Question 已过期"，不重试 |

## 14. 已确定决策（review 通过 · 2026-06-14）

| # | 决策 | 取值 | 代码落点 |
|---|------|------|---------|
| Q1 | 软超时 | **30 分钟** | `SessionManager.QUESTION_TIMEOUT_MS = 30 * 60_000`（§8.5） |
| Q2 | 显式 reject 命令 | **加 `/reject-question`** | `parseRejectQuestionCommand` 加 `src/adapter/workspace-cmd.ts`；`handleQuestionReply` 优先级命令列表（§10.3） |
| Q3 | `/status` 显示 pending | **加 `⏳ Question pending`** | `handleStatusCommand`（bridge.ts）输出前追加一行；调 `sessionManager.hasPendingQuestion()` |
| Q4 | 多题展示格式 | **`Q{n}={value}` 选择 + `Q{n}-{value}` 强制 custom · `---` 为 fallback** | `formatQuestionForWeChat` 输出模板更新（§6.2）；`parseQuestionReply` 实现三策略检测（§7.2 Step 0）：qnFormat / dashFormat / singleAnswer；qnFormat 内部按 `=` / `-` 区分选择 vs custom（§7.1 / §7.2 Step 1a）；空白容忍（手机自动空格） |
| Q5 | question 持久化 | **不写盘** | 无落点；依赖 server `question.rejected` 事件兜底 |
| Q6 | 启动调 `listQuestions` | **调一次，仅发现 leaked 时 reject** | `bridge.start()` 末尾、轮询启动**之前**；比较 `serverRequests` vs `this.sessionManager.getPendingQuestion()`，对 server 有但本地没有的 requestID 调 `client.rejectQuestion(id)` |

## 15. 实施顺序（建议）

1. types/question.ts + types/events.ts（无依赖）
2. adapter/question-format.ts + 单元测试（纯函数）
3. server/client.ts 新增 3 个方法（HTTP 调用）
4. server/session.ts 加 pendingQuestion 状态机 + 单元测试
5. bridge.ts 接线和优先级命令
6. 端到端手动测试
7. README 更新：增加 `opencode.json` 里 `"question": "allow"` 的提示

## 16. 参考

- OpenCode 源码：
  - `packages/opencode/src/question/schema.ts` — QuestionID 定义
  - `packages/opencode/src/question/index.ts` — 事件类型 + Service 实现
  - `packages/opencode/src/tool/question.ts` — 工具定义
  - `packages/opencode/src/server/routes/instance/httpapi/groups/question.ts` — HTTP 路由
  - `packages/opencode/src/server/routes/instance/httpapi/handlers/question.ts` — HTTP handler
- 官方文档：`packages/web/src/content/docs/zh-cn/tools.mdx` L283-307
- 参考实现：`packages/opencode/src/server/routes/instance/httpapi/groups/permission.ts`（API 风格对称参考）
- Bridge 现状：`src/server/session.ts:530-565`、`src/server/client.ts:1-30`、`src/bridge.ts:597-753`
