/**
 * opencode ACP engine bridge for DeepSeek Harness.
 *
 * Two pieces, both behind the standard `ctx.subagents` seam:
 *
 * 1. `opencode-acp` — a subagent provider that spawns `opencode acp` and drives
 *    it over ACP. It exists instead of reusing @deepseek-ai/dsh-subagent-acp
 *    because that package is strictly one-shot (`startExternal`, no
 *    `prepareContinuable`), while opencode advertises `loadSession: true` and
 *    honours `session/load`. Owning the provider is what lets `/opencode -r`
 *    continue a REAL engine session rather than paste a summary into a fresh one.
 *
 * 2. the `/opencode` human command, which starts or continues such a session.
 *
 * Guarantees this bridge upholds:
 *  - no forged assistant messages: engine output stays in the engine's own
 *    session; this plugin only returns its own command receipt;
 *  - the engine cwd is the parent session's working directory;
 *  - the child is spawned through the subprocess seam with an absolute `.exe`
 *    (the seam never goes through a shell, so a `.cmd` wrapper fails with
 *    spawn EINVAL on Windows);
 *  - plugin state lives in a storage domain, never a new session event type.
 *
 * @module dsh-opencode-engine
 */
import { brandString } from '@deepseek-ai/dsh-brand';
import { deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import z from '@deepseek-ai/schemastery';
// Domain record schemas MUST be zod, not schemastery. dsh-storage-domain's
// open() validates every stored record with `tableSpec.valueSchema.parse(raw)`
// and its contract requires zod record schemas (README: "Record schemas are
// zod ... plugin Config stays schemastery"; `lib/types/spec.d.ts` imports
// `ZodType` from 'zod'). Schemastery schemas expose no `.parse`/`.safeParse`,
// so building the tables with them makes `facility.open` throw
// `TypeError: tableSpec.valueSchema.parse is not a function` for EVERY stored
// record, which parseRecord then wraps as `DomainError('invalid-record'): ...
// does not match its schema` with `issues = null` — no field ever gets
// compared. An empty table validates nothing, so the failure only appears once
// a record exists, which makes it look intermittent. Fix = the documented
// split: domain record schemas on zod (pinned below), plugin Config stays
// schemastery `z`.
import { z as zod } from 'zod';
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';

export const name = 'opencode-engine';
export const inject = ['subagents', 'subprocess', 'commands', 'storageDomain'];

// The LAST storage-open failure, surfaced into user-visible receipts.
// MUST live at module scope — runOpencodeCommand is a module-level function and
// cannot see apply()'s locals; a function-scoped variable there throws
// ReferenceError on every receipt that needs it.
let lastDomainError;

/** Bundle configuration; every value has a working default except engineCommand. */
export const Config = z.object({
	// REQUIRED: absolute path to the opencode executable. On Windows that must be
	// an `.exe`, not `opencode.cmd` — the subprocess seam spawns through
	// CreateProcessW and its executable probe only accepts `.com`/`.exe`, so a
	// `.cmd` wrapper fails with `spawn EINVAL`. No machine-specific default is
	// shipped: apply() logs an actionable error when this is left empty.
	engineCommand: z.string().default(''),
	// `--print-logs --log-level WARN` is LOAD-BEARING, not cosmetic: opencode
	// reports an exhausted lane only in its own log file, so without this mirror
	// the ACP stream and stderr are both silent and the failure is
	// indistinguishable from a hang.
	engineArgs: z.array(z.string()).default(['acp', '--print-logs', '--log-level', 'WARN']),
	// `ask` routes every engine permission request through `ctx.approval.request`
	// and writes the outcome back to ACP. `allow` auto-approves the first allow
	// option (no human in the path), `reject` declines everything.
	permission: z.union(['allow', 'reject', 'ask']).default('allow'),
	providerName: z.string().default('opencode-acp'),
	commandName: z.string().default('opencode'),
	model: z.string().default(''),
	agent: z.string().default(''),
	withSummary: z.boolean().default(false),
	cwdAlign: z.boolean().default(true),
	disposeGraceMs: z.number().default(3000),
	// Silence watchdog: the engine reports a dead model lane by simply never
	// answering `session/prompt`, so without this an exhausted quota and a
	// wedged engine look identical to slow work.
	//
	// 5 minutes, not 90s: a real opencode turn measured 16-22s for a single
	// write, and `session/load` + a multi-step edit can legitimately run for
	// minutes. A shorter ceiling would abort honest work; the value is a Config
	// key precisely so it can be tuned per task size. 0 disables it.
	idleTimeoutMs: z.number().default(300_000),
	// How long a `request_permission` waits for a human before failing closed.
	// Approval timeouts must never resolve to a grant.
	approvalTimeoutMs: z.number().default(300_000),
	// Append the files this run changed (git snapshot through the subprocess
	// seam; `ctx.workspaceChanges` does not see external-process writes).
	changeList: z.boolean().default(true),
});

/* ───────────────────────────── storage domain ───────────────────────────── */

/**
 * Durable defaults plus the last engine session per Harness session.
 *
 * `defaults` holds one record; `sessions` remembers which opencode session a
 * Harness session used, so `-r` can `session/load` it even after a restart.
 */
const engineDomain = defineDomain({
	// Storage unit names must match /^[a-z][a-z0-9_]*$/, so dotted or hyphenated
	// spellings are not expressible: the separator is `_`, never `.` or `-`.
	// Record schemas are built with `zod` (see the note at the imports) —
	// `domainTable` requires a schema object exposing `.parse`. Explicit
	// `zod.literal` members keep the union valid on both zod majors commonly
	// present in a Host tree (3.x at top level, 4.x nested under
	// dsh-storage-domain); bare strings are not valid union members on zod v3.
	name: 'opencode_engine',
	version: 1,
	tables: {
		defaults: domainTable(
			zod.object({
				engineCommand: zod.string(),
				model: zod.string(),
				agent: zod.string(),
				permissionMode: zod.union([zod.literal('auto'), zod.literal('ask-only')]),
				cwdAlign: zod.boolean(),
				withSummary: zod.boolean(),
			}),
		),
		sessions: domainTable(
			zod.object({
				harnessSessionId: zod.string(),
				engineSessionId: zod.string(),
				cwd: zod.string(),
				updatedAt: zod.number(),
				model: zod.string(),
			}),
		),
	},
});

/**
 * Exported for diagnostics — offline probes (and any migration tooling) can
 * validate the real stored medium against the real spec without duplicating
 * the schema block. Not part of the plugin contract.
 */
export { engineDomain };

/* ─────────────────────────────── ACP engine ─────────────────────────────── */

/** Map an ACP stop reason onto the seam's closed vocabulary. */
function stopReasonOf(reason) {
	switch (reason) {
		// `end_turn` is the engine's own "I finished this turn" and `max_tokens`
		// is a budget ceiling; both are successful settlements. Everything else
		// is a failure the parent must see as such.
		case 'end_turn': return 'completed';
		case 'max_tokens': return 'max-tokens';
		case 'refusal': return 'refusal';
		case 'cancelled': return 'aborted';
		default: return 'error';
	}
}

/**
 * Classify an engine failure into a kind the parent can act on.
 *
 * The point of this table is that "task failed" must never be the whole answer:
 * an exhausted free lane, a dead child, a protocol violation, and a watchdog
 * trip need different responses from the user (wait for quota / fix the
 * command / report a bug / raise the timeout). Measured on Windows: opencode
 * reports an exhausted quota ONLY as stderr prose plus a silent hang, so the
 * stderr probe and the watchdog are load-bearing, not defensive extras.
 */
const ENGINE_ERRORS = {
	quota: {
		summary: '引擎额度不足（Zen 免费车道已用尽）',
		hint: '等额度恢复后重试，或换 --model/订阅；这不是 Harness 或本插件故障。',
	},
	crash: {
		summary: '引擎进程异常退出',
		hint: '检查 engineCommand 是否存在且可执行；重试一次确认是否偶发。',
	},
	protocol: {
		summary: 'ACP 协议错误',
		hint: '引擎与 ACP 1.4.0 不兼容或会话已失效；重开一个任务，仍失败则报告。',
	},
	silent: {
		// Distinct from `timeout`: `silent` means the engine was ALIVE but emitted
		// NOTHING at all for the whole window (measured: long silences on `-r`
		// resumes, and at the quota wall). `timeout` is reserved for a watchdog
		// trip that at least saw partial progress, where the only honest guess is
		// slowness.
		summary: '引擎静默（激活后无任何 ACP 事件）',
		hint: '引擎进程还活着但一个字都没输出：多为 Zen 车道拥堵/额度边界或 session/load 卡住。可先重试；持续如此把 idleTimeoutMs 调大或换模型，并保留本次回执。',
	},
	timeout: {
		summary: '引擎无响应（看门狗超时）',
		hint: '任务有进展但停住了；可调大 idleTimeoutMs 或先用更小的任务试探。',
	},
	cancelled: {
		summary: '任务已被中止',
		hint: '由用户或父会话取消，无需重试。',
	},
};

/**
 * Build the optional `diagnostic` for a successful run with caveats.
 *
 * The engine can finish a task while the parent still needs to know that a
 * model was refused, a permission was denied, or files changed. Those are
 * facts about the run, not failures of it, so they ride the diagnostic channel
 * instead of changing `stopReason`.
 */
function buildDiagnostic(refusals, refusedApprovals, changes) {
	const parts = [];
	if (refusals.length > 0) parts.push(`engine refused ${refusals.join('; ')}`);
	if (refusedApprovals.length > 0) {
		const listed = refusedApprovals.map((entry) => `${entry.title.replaceAll('\n', ' ')} → ${entry.outcome}`);
		parts.push(`permission not granted (${listed.join('; ')})`);
		// `no-turn` is not a user's "no": it means the request arrived on a path
		// that cannot host the approval audit pair (the /opencode command runs
		// outside the turn machinery). Saying so is what stops the user from
		// reading a silent refusal as a broken approval card.
		if (refusedApprovals.some((entry) => entry.outcome === 'no-turn')) {
			parts.push('note: 引擎请求权限时不在 turn 内（/opencode 命令路径）。审批卡需要 turn，请改用 turn 内的 `opencode` 工具，或把 permission 设为 allow。');
		}
	}
	if (typeof changes === 'string' && changes.trim() !== '') parts.push(`changed files:\n${changes.trim()}`);
	return parts.length === 0 ? {} : { diagnostic: parts.join('\n') };
}

/**
 * Decide which failure class best explains a rejected engine run.
 *
 * Order matters, and stderr is checked BEFORE the watchdog verdict: an
 * exhausted lane is reported by opencode as one stderr line followed by
 * silence, so the turn trips the watchdog too. Reporting that as `timeout`
 * would hide the actual cause and send the user hunting a nonexistent hang.
 *
 * The watchdog verdict itself splits in two, because "alive but mute" and
 * "made progress then stalled" need different handling:
 *   - `silent`  — ZERO events after activation (measured on long `-r` ROUND-2
 *                 silences, and on the quota wall).
 *   - `timeout` — the turn moved (chunks, tool ticks) and then stopped.
 *
 * @param error - the rejection raised while prompting.
 * @param evidence - captured stderr, whether the child exited, and the event
 *   count observed this turn.
 * @returns one of the ENGINE_ERRORS keys.
 */
function classifyFailure(error, evidence = {}) {
	const stderr = evidence.stderr ?? '';
	if (looksLikeQuota(stderr)) return 'quota';
	if (evidence.exited === true) return 'crash';
	if (error?.engineFailure === 'timeout') {
		// A watchdog trip with no event at all is the engine going silent; one
		// that saw events at least proves the turn started.
		return (evidence.eventCount ?? 0) === 0 ? 'silent' : 'timeout';
	}
	// The child stayed alive but still failed the request: the engine and this
	// client disagree about the protocol (or the session is gone).
	return 'protocol';
}

/**
 * Read the session's LATEST compaction checkpoint text, without compacting.
 *
 * There is no `ctx.compaction.currentSnapshot()`: the compaction engine folds a
 * history span into one replacement user message carrying
 * `compactCheckpointSource`, so the current snapshot IS the newest such
 * message on the session surface. `foldSurface` applies those replacements,
 * which is what makes the newest checkpoint the visible one rather than an
 * older shadowed copy.
 *
 * @param session - the Harness session whose surface supplies the checkpoint.
 * @returns the checkpoint text, or undefined when the session was never compacted.
 */
function currentCompactionSnapshot(session) {
	try {
		const events = session.snapshotEvents();
		const surface = foldSurface(events);
		// `foldSurface` returns surface NODE SEQUENCES plus the projection map;
		// `deriveEventMessage` turns one node back into its message.
		const nodes = Array.isArray(surface?.nodes) ? surface.nodes : [];
		for (let index = nodes.length - 1; index >= 0; index -= 1) {
			const event = events[nodes[index]];
			if (event?.type !== 'user/message') continue;
			const message = deriveEventMessage(event, surface.projectedMessages);
			if (message?.source?.kind !== 'compact-checkpoint') continue;
			const text = Array.isArray(message.content)
				? message.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
				: '';
			if (text.trim() !== '') return text;
		}
		return undefined;
	} catch {
		// A surface fold failure costs the summary, never the task.
		return undefined;
	}
}

/** Render one classified failure as a single parent-facing line. */
function describeEngineError(kind, detail) {
	const entry = ENGINE_ERRORS[kind] ?? ENGINE_ERRORS.protocol;
	return [`【${kind}】${entry.summary}`, detail === undefined ? '' : `细节: ${detail}`, `建议: ${entry.hint}`]
		.filter((line) => line !== '')
		.join('\n');
}

/**
 * Recognise an exhausted-quota failure from the engine's stderr.
 *
 * opencode never surfaces this over ACP; it prints one line to stderr and
 * then stops answering. The patterns are the literal strings observed from
 * `opencode acp` on Windows plus their provider-side spellings.
 */
const QUOTA_PATTERNS = [
	/free usage limit reached/iu,
	/usage limit reached/iu,
	/quota exceeded/iu,
	/AI_APICallError/iu,
	/\b429\b/u,
	/too many requests/iu,
	/subscribe to opencode go/iu,
];

/** Whether captured stderr text describes a quota wall rather than a bug. */
function looksLikeQuota(text) {
	const sample = String(text ?? '');
	return QUOTA_PATTERNS.some((pattern) => pattern.test(sample));
}

/** Keep the last few non-empty stderr lines for a failure diagnostic. */
function tailLines(text, count = 3) {
	const lines = String(text ?? '')
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line !== '');
	return lines.slice(-count).join(' | ');
}

/**
 * One live conversation with an `opencode acp` child.
 *
 * The child is spawned through the subprocess seam, so it rides the managed
 * process range (a Win32 Job object on Windows) and is reaped on dispose.
 */
class EngineConversation {
	#handle;
	#connection;
	#closed = false;
	#stderrOffset = 0;
	/** Shared activity counter, bumped by the collectors inside connectEngine. */
	#activity;

	constructor({ handle, connection, sessionId, cwd, resumed, tools, applied, stderr, activity }) {
		this.#handle = handle;
		this.#connection = connection;
		this.sessionId = sessionId;
		this.cwd = cwd;
		this.resumed = resumed;
		/** Tool activity observed this turn: { title, kind, status }. */
		this.tools = tools;
		/** Engine config options applied for this run, keyed `model` / `mode`. */
		this.applied = applied ?? {};
		/** The collected stderr reader, when the seam collected instead of inherited. */
		this.stderr = stderr;
		this.#activity = activity ?? { count: 0 };
	}

	/** Everything the child has written to stderr since the previous call. */
	drainStderr() {
		if (this.stderr?.readFrom === undefined) return '';
		try {
			const read = this.stderr.readFrom(this.#stderrOffset);
			this.#stderrOffset = read.nextOffset ?? this.#stderrOffset;
			return read.text ?? '';
		} catch {
			return '';
		}
	}

	/** The child's recorded exit facts, or undefined while it still runs. */
	async exitFacts() {
		try {
			return await this.#handle.done;
		} catch {
			// A rejected `done` means spawn failed rather than that the child is alive;
			// the caller classifies that as a crash.
			return undefined;
		}
	}

	/**
	 * Gather what a failure classifier needs: the child's own stderr, whether it
	 * has exited, and how many engine events this turn produced.
	 *
	 * `handle.done` settles when the child exits, so racing it against a short
	 * delay distinguishes "already dead" from "alive but unhappy" without
	 * blocking a failure report on a child that will never exit.
	 *
	 * `eventCount` is what separates a SILENT engine (zero events: the quota
	 * wall / a wedged `session/load`) from one that made progress and then
	 * stalled — two failures that need different advice.
	 */
	async failureEvidence() {
		const stderr = this.drainStderr();
		const exited = await Promise.race([
			this.exitFacts().then(() => true),
			new Promise((resolve) => {
				const timer = setTimeout(() => resolve(false), 250);
				timer.unref?.();
			}),
		]);
		const facts = exited ? await this.exitFacts() : undefined;
		return {
			stderr,
			exited,
			exitCode: facts?.exitCode ?? null,
			eventCount: this.#activity.count,
		};
	}

	/** Ask the child to cancel its current turn; a dead child is a no-op. */
	cancel() {
		if (this.#closed) return;
		try {
			this.#connection.agent.notify(methods.agent.session.cancel, { sessionId: this.sessionId });
		} catch {
			// The child is already gone; dispose() owns the teardown.
		}
	}

	/**
	 * Send one task and wait for its terminal stop reason.
	 *
	 * Text arrives as `session/update` notifications into the collector owned by
	 * `connectEngine`, which starts after `session/load` so replayed history is
	 * not mistaken for this turn's answer.
	 *
	 * A watchdog races the prompt: the engine reports a dead model lane by
	 * silence, so `idleTimeoutMs` with no event at all is the only symptom we
	 * get. Any observed update (even a tool status tick) re-arms the timer,
	 * because a long-running tool is progress, not a hang.
	 */
	/**
	 * Send one task and wait for its terminal stop reason.
	 *
	 * Text arrives as `session/update` notifications into the collector owned by
	 * `connectEngine`, which starts after `session/load` so replayed history is
	 * not mistaken for this turn's answer.
	 *
	 * A watchdog races the prompt because the engine reports a dead model lane by
	 * SILENCE alone: measured on Windows, an exhausted Zen quota produced no
	 * JSON-RPC error and no stop reason, so an unbounded await looks exactly like
	 * slow work. The watchdog polls an activity counter that every engine event
	 * bumps, so a long tool run (which emits status ticks) is progress, while
	 * total silence over the window is a hang.
	 */
	async prompt(text, options = {}) {
		// A resumed conversation keeps the tools recorded during session/load out
		// of this turn: only activity after this point belongs to the new task.
		this.tools.length = 0;
		const idleTimeoutMs = options.idleTimeoutMs ?? 0;
		const pending = this.#connection.agent.request(methods.agent.session.prompt, {
			sessionId: this.sessionId,
			prompt: [{ type: 'text', text }],
		});

		let watchdogTimer;
		const watchdog = idleTimeoutMs > 0
			? new Promise((resolve) => {
				let seen = this.#activity.count;
				let silentSince = Date.now();
				// Poll at a quarter of the window so the trip is close to the ceiling
				// without spinning.
				const probeMs = Math.max(250, Math.floor(idleTimeoutMs / 4));
				watchdogTimer = setInterval(() => {
					if (this.#activity.count !== seen) {
						seen = this.#activity.count;
						silentSince = Date.now();
						return;
					}
					if (Date.now() - silentSince < idleTimeoutMs) return;
					clearInterval(watchdogTimer);
					watchdogTimer = undefined;
					resolve({ kind: 'timeout' });
				}, probeMs);
				watchdogTimer.unref?.();
			})
			: new Promise(() => {});

		try {
			const raced = await Promise.race([
				pending.then((result) => ({ kind: 'answered', result })).catch((error) => ({ kind: 'error', error })),
				watchdog,
			]);
			if (raced.kind === 'timeout') {
				// Stop the engine's own work before reporting: a cancelled turn keeps
				// the child reusable for dispose and avoids a runaway tool loop.
				this.cancel();
				throw Object.assign(new Error('engine did not answer within the idle timeout'), { engineFailure: 'timeout' });
			}
			if (raced.kind === 'error') throw raced.error;
			return { stopReason: raced.result?.stopReason ?? 'end_turn', usage: raced.result?.usage };
		} finally {
			if (watchdogTimer !== undefined) clearInterval(watchdogTimer);
		}
	}

	/** Release the child and prove its managed range exited. */
	async dispose() {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.#handle.stdin?.end();
		} catch {
			// The child may already have closed stdin by exiting.
		}
		try {
			await this.#handle.waitForExit?.();
		} catch {
			// Best-effort exit proof; the seam still owns reaping the range.
		}
	}
}

/**
 * Pick the ACP option that expresses a decided outcome.
 *
 * The engine offers its own option ids and kinds; the bridge must answer with
 * an option it actually offered, never an invented id. A grant prefers
 * `allow_once` over `allow_always` (the seam's `allowed-once` is a
 * single-action grant, and this bridge deliberately never remembers a choice). A
 * refusal prefers `reject_once`; when the engine offers no reject option at
 * all the only honest answer is `cancelled`.
 */
function optionFor(options, outcome) {
	const offered = Array.isArray(options) ? options : [];
	const byKind = (kind) => offered.find((option) => String(option?.kind ?? '') === kind);
	const byId = (needle) => offered.find((option) => String(option?.optionId ?? '').includes(needle));
	if (outcome === 'allowed-once') {
		return byKind('allow_once') ?? byKind('allow_always') ?? byId('allow') ?? offered[0];
	}
	return byKind('reject_once') ?? byKind('reject_always') ?? byId('reject');
}

/**
 * Render one engine permission request as the human-facing approval reason.
 *
 * The card is the only place the user sees what the engine wants to do, so it
 * carries the engine's own title plus the resolved target when the payload
 * exposes one.
 */
function describePermission(toolCall) {
	const call = toolCall ?? {};
	const title = String(call.title ?? call.kind ?? 'engine action');
	const target = Array.isArray(call.locations)
		? call.locations.map((entry) => entry?.path).filter((path) => typeof path === 'string')
		: [];
	const raw = call.rawInput;
	const rawPath = raw !== null && typeof raw === 'object'
		? [raw.filePath, raw.path, raw.file].find((value) => typeof value === 'string')
		: undefined;
	const where = target.length > 0 ? target.join(', ') : rawPath;
	const lines = [title];
	if (typeof where === 'string' && where !== '') lines.push(`目标: ${where}`);
	if (typeof call.kind === 'string' && call.kind !== '') lines.push(`类型: ${call.kind}`);
	return lines.join('\n');
}

/**
 * Spawn `opencode acp` and complete the ACP handshake.
 *
 * @param options.spawn - the subprocess seam's spawn function.
 * @param options.engineCommand - absolute `.exe` to spawn.
 * @param options.engineArgs - arguments, normally `['acp']`.
 * @param options.cwd - absolute working directory (the parent session's).
 * @param options.permission - 'allow', 'reject', or 'ask' (the human approval bridge).
 * @param options.requestApproval - ask one human whether the engine may proceed.
 *   Required for the 'ask' policy; without it 'ask' fails closed.
 * @param options.graceMs - termination grace for the managed range.
 * @param options.signal - start-up cancellation.
 * @param options.resumeSessionId - engine session to `session/load`; omit for a new one.
 * @param options.model - engine model id applied via `session/set_config_option`.
 * @param options.agent - engine agent/mode id applied the same way.
 * @param options.onText - receives committed assistant text chunks.
 * @param options.onProgress - called on every engine event, re-arming the watchdog.
 * @param options.onConfigRefused - called when the engine rejects a model/agent.
 * @returns the connected conversation, ready for `prompt`.
 */
async function connectEngine(options) {
	const handle = options.spawn({
		argv: [options.engineCommand, ...options.engineArgs],
		cwd: options.cwd,
		env: { NO_COLOR: '1' },
		// stderr is COLLECTED, not inherited: an exhausted engine lane surfaces
		// only as stderr prose (no ACP error, no stop reason), so the failure
		// classifier needs those bytes. An inherited stderr would be invisible here.
		stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
		graceMs: options.graceMs,
		signal: options.signal,
	});

	let collecting = false;
	const tools = [];
	/** Every engine event bumps this; the watchdog reads it to tell work from a hang. */
	const activity = { count: 0 };
	const progress = () => {
		activity.count += 1;
	};
	const connection = client()
		.onRequest(methods.client.session.requestPermission, async (context) => {
			// This handler IS the permission bridge: it is the processor
			// of ACP's own request, not a listener inside someone else's waterfall.
			const params = context.params ?? {};
			const offered = Array.isArray(params.options) ? params.options : [];
			progress();

			if (options.permission !== 'ask') {
				// `allow`/`reject` policies: a closed pair, no human in the path.
				const chosen = optionFor(offered, options.permission === 'allow' ? 'allowed-once' : 'rejected');
				return chosen === undefined
					? { outcome: { outcome: 'cancelled' } }
					: { outcome: { outcome: 'selected', optionId: chosen.optionId } };
			}

			// 'ask' — the human bridge. FAIL CLOSED at every step: a missing
			// answerer, a timeout, an abort, or a thrown seam all resolve to a
			// refusal, never to a grant.
			if (options.requestApproval === undefined) {
				options.onPermission?.(params, 'unavailable');
				return { outcome: { outcome: 'cancelled' } };
			}
			let outcome;
			try {
				outcome = await options.requestApproval({
					toolCall: params.toolCall,
					sessionId: params.sessionId,
					options: offered,
				});
			} catch {
				// The approval seam itself failed. Treat as unavailable → fail closed.
				outcome = 'unavailable';
			}
			options.onPermission?.(params, outcome);
			// `allowed-once` is the seam's only grant. `rejected`/`cancelled`/
			// `unavailable` all must reach the engine as "no".
			const chosen = optionFor(offered, outcome === 'allowed-once' ? 'allowed-once' : 'rejected');
			if (outcome !== 'allowed-once' && chosen === undefined) return { outcome: { outcome: 'cancelled' } };
			return chosen === undefined
				? { outcome: { outcome: 'cancelled' } }
				: { outcome: { outcome: 'selected', optionId: chosen.optionId } };
		})
		.onNotification(methods.client.session.update, (context) => {
			if (!collecting) return;
			progress();
			const update = context.params?.update ?? {};
			if (update.sessionUpdate === 'agent_message_chunk') {
				const content = update.content;
				if (content?.type === 'text' && typeof content.text === 'string') options.onText(content.text);
				return;
			}
			// Track tool activity so an engine turn that ends with tools and no
			// closing prose can still be reported factually to the parent.
			if (update.sessionUpdate === 'tool_call') {
				tools.push({ title: String(update.title ?? update.kind ?? 'tool'), kind: String(update.kind ?? 'other'), status: String(update.status ?? 'pending') });
				return;
			}
			if (update.sessionUpdate === 'tool_call_update') {
				const existing = tools.at(-1);
				if (existing !== undefined && update.status !== undefined) existing.status = String(update.status);
			}
		})
		.connect(ndJsonStream(Writable.toWeb(handle.stdin), Readable.toWeb(handle.stdout)));

	await connection.agent.request(methods.agent.initialize, {
		protocolVersion: 1,
		clientCapabilities: {},
	});

	let sessionId;
	let resumed = false;
	if (options.resumeSessionId === undefined) {
		const created = await connection.agent.request(methods.agent.session.new, {
			cwd: options.cwd,
			mcpServers: [],
		});
		sessionId = created?.sessionId;
	} else {
		// session/load replays history through the same update channel, so the
		// collector must stay off until the load returns.
		const loaded = await connection.agent.request(methods.agent.session.load, {
			sessionId: options.resumeSessionId,
			cwd: options.cwd,
			mcpServers: [],
		});
		sessionId = options.resumeSessionId;
		resumed = true;
		void loaded;
	}
	if (typeof sessionId !== 'string') throw new Error('opencode-engine: ACP handshake returned no session id');

	// Apply an explicit engine model/agent. opencode exposes these as session
	// config options (`model`, `mode`) through `session/set_config_option`, and
	// returns the full option set with the new current values. A refused value
	// must NOT abort the run: the task still executes on the engine's default.
	const applied = {};
	for (const [configId, value] of [['model', options.model], ['mode', options.agent]]) {
		if (typeof value !== 'string' || value === '') continue;
		try {
			const response = await connection.agent.request(methods.agent.session.setConfigOption, { sessionId, configId, value });
			const configOptions = response?.configOptions;
			const current = Array.isArray(configOptions) ? configOptions.find((option) => option?.id === configId)?.currentValue : undefined;
			applied[configId] = typeof current === 'string' ? current : value;
		} catch (error) {
			applied[configId] = { refused: String(error?.message ?? error) };
			options.onConfigRefused?.(configId, value, error);
		}
	}

	collecting = true;

	return new EngineConversation({
		handle,
		connection,
		sessionId,
		cwd: options.cwd,
		resumed,
		tools,
		applied,
		stderr: handle.collected?.stderr,
		activity,
	});
}

/**
 * Build a factual summary for a turn that produced tool activity but no prose.
 *
 * opencode's model sometimes finishes a step right after its last tool call,
 * leaving `agent_message_chunk` empty. Reporting nothing would tell the parent
 * that no work happened, so describe what the engine actually did.
 *
 * @param conversation - the engine conversation that just finished.
 * @param stopReason - the ACP stop reason, for the closing line.
 * @returns a plain-text summary for the parent session.
 */
function summariseEngineRun(conversation, stopReason) {
	const completed = conversation.tools.filter((tool) => tool.status === 'completed');
	const listed = (completed.length > 0 ? completed : conversation.tools).map((tool) => `${tool.title} (${tool.kind})`);
	const lines = [
		'opencode engine finished without a closing message.',
		...(listed.length === 0 ? ['No tool activity was reported.'] : ['Tool activity:', ...listed.map((line) => `  - ${line}`)]),
		`stop reason: ${stopReason}`,
		`engine session: ${conversation.sessionId}`,
	];
	return lines.join('\n');
}

/**
 * Whether the session log currently sits inside an open turn.
 *
 * Mirrors the approval service's own precondition (`hasOpenTurn`): walk
 * backwards from the log tail and take the first turn boundary seen. The
 * audit pair an approval request appends must be enclosed by that boundary,
 * so a request made outside one cannot be logged and the service refuses it.
 *
 * @param session - the session whose log tail decides.
 * @returns true when a `turn/start` is the most recent turn boundary.
 */
function sessionHasOpenTurn(session) {
	try {
		const events = session.snapshotEvents();
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const type = events[index]?.type;
			if (type === 'turn/start') return true;
			if (type === 'turn/end') return false;
		}
		return false;
	} catch {
		// An unreadable log cannot host an auditable approval: fail closed.
		return false;
	}
}

/**
 * Whether an approval/timeout/`unavailable` outcome reached the engine as a "no".
 *
 * `allowed-once` is the only grant; every other value — including the bridge's
 * own `no-turn` — means the engine was denied.
 */
function isDenial(outcome) {
	return outcome !== 'allowed-once';
}

/* ─────────────────────────────── the provider ──────────────────────────── */

/**
 * A subagent provider running one opencode engine conversation per activation.
 *
 * Advertises no optional start capabilities: an out-of-process child cannot
 * honour agentOptions/agentPreset/outputSchema/depthLimit, so the seam rejects
 * requests needing them instead of silently dropping them.
 */
class OpencodeProvider {
	constructor(providerName, ctx, config, state) {
		this.name = providerName;
		this.ctx = ctx;
		this.config = config;
		this.state = state;
		this.capabilities = {
			agentOptions: false,
			agentPreset: false,
			outputSchema: false,
			depthLimit: false,
		};
		this.inheritsParentContext = false;
	}

	/**
	 * Start one engine conversation and publish its run.
	 *
	 * The run result carries the assistant text the engine committed this turn,
	 * which is what the subagent seam hands back to the parent.
	 */
	start(request) {
		if (request.signal.aborted) throw new Error('opencode-engine: request aborted before start');
		const providerState = this.state;
		const config = this.config;
		const ctx = this.ctx;
		let cancelled = false;
		let conversation;
		/** Approval outcomes observed this run, for the parent-facing receipt. */
		const approvals = [];

		const started = (async () => {
			const cwd = request.cwd ?? providerState.cwdOf(request.parent);
			const resumeSessionId = request.engineSessionId;
			const chunks = [];
			const refusals = [];
			conversation = await connectEngine({
				spawn: (spec) => ctx.subprocess.spawn(spec),
				engineCommand: config.engineCommand,
				engineArgs: config.engineArgs,
				cwd,
				permission: config.permission,
				graceMs: config.disposeGraceMs,
				signal: request.signal,
				resumeSessionId,
				// An explicit per-run model/agent wins over the bundle defaults.
				model: request.model ?? config.model,
				agent: request.agent ?? config.agent,
				onText: (text) => chunks.push(text),
				onPermission: (params, outcome) => {
					approvals.push({ title: describePermission(params?.toolCall), outcome });
					// The engine's permission decision is a first-class run fact: a
					// refusal changes what the task accomplished, so the parent must
					// be able to account for it.
					ctx.logger.info(`opencode-engine: permission ${outcome} for ${params?.toolCall?.kind ?? 'tool'}`);
				},
				requestApproval: config.permission === 'ask'
					? (ask) => providerState.requestApproval?.({
						ctx,
						parent: request.parent,
						signal: request.signal,
						toolCall: ask.toolCall,
						cwd,
						timeoutMs: config.approvalTimeoutMs,
					})
					: undefined,
				onConfigRefused: (configId, value, error) => {
					refusals.push(`${configId}=${value}: ${String(error?.message ?? error)}`);
					ctx.logger.warn(`opencode-engine: engine refused ${configId}=${value}: ${String(error?.message ?? error)}`);
				},
			});
			return { conversation, chunks, cwd, refusals };
		})();

		const onAbort = () => {
			cancelled = true;
			conversation?.cancel();
		};
		request.signal?.addEventListener('abort', onAbort, { once: true });

		const result = started.then(async ({ conversation: live, chunks, cwd, refusals }) => {
			try {
				const task = request.prompt
					.filter((block) => block.type === 'text')
					.map((block) => block.text)
					.join('\n');
				const answered = await live.prompt(task, {
					// The watchdog observes engine events, so any tool status tick counts
					// as progress; only TOTAL silence over the window is a hang.
					onProgress: () => {},
					idleTimeoutMs: config.idleTimeoutMs,
				});
				const text = chunks.join('');
				// Record the engine session so `-r` can resume it next time.
				await providerState.rememberEngineSession?.(request, live.sessionId, cwd, config.model ?? '');
				const changes = await providerState.describeChanges?.(request, config.changeList);
				const refused = approvals.filter((entry) => entry.outcome !== 'allowed-once');
				return {
					// An engine turn often ends with tool activity and no closing prose
					// (opencode's model may finish a step right after `write`). Returning
					// an empty result would tell the parent nothing happened, so fall back
					// to a factual summary of the run.
					output: [{ type: 'text', text: text.trim() === '' ? summariseEngineRun(live, answered.stopReason) : text }],
					// A refused model/agent is a warning, never a failed run: the task still
					// executed on the engine's default, and the parent must be told. Denied
					// engine permissions belong in the same channel for the same reason:
					// the task may be incomplete, but the run itself succeeded.
					...buildDiagnostic(refusals, refused, changes),
					stopReason: cancelled ? 'aborted' : stopReasonOf(answered.stopReason),
				};
			} catch (error) {
				const partial = chunks.join('');
				if (cancelled) {
					return {
						output: partial.trim() === '' ? [] : [{ type: 'text', text: partial }],
						stopReason: 'aborted',
					};
				}
				// Distinguish WHY the run failed. The engine's own silence and stderr
				// are the only evidence available for an exhausted lane, so probe
				// both before settling on a generic protocol error.
				const evidence = await live.failureEvidence().catch(() => ({}));
				const kind = classifyFailure(error, evidence);
				const detail = this.#failureDetail(error, evidence);
				ctx.logger.warn(`opencode-engine: run failed (${kind}): ${detail}`);
				return {
					output: partial.trim() === '' ? [] : [{ type: 'text', text: partial }],
					diagnostic: describeEngineError(kind, detail),
					stopReason: 'error',
				};
			} finally {
				request.signal?.removeEventListener('abort', onAbort);
				await live.dispose().catch(() => {});
			}
		});

		// The seam expects the run handle synchronously; failures surface in `result`.
		return {
			id: brandString(randomUUID()),
			result,
			dispose: async () => {
				cancelled = true;
				try {
					conversation?.cancel();
				} catch {
					// Already gone.
				}
				await result.catch(() => {});
			},
		};
	}

	/** Best-effort human-readable detail for one classified engine failure. */
	#failureDetail(error, evidence = {}) {
		const message = String(error?.message ?? error);
		const stderr = tailLines(evidence.stderr ?? '', 3);
		const exit = evidence.exitCode === null || evidence.exitCode === undefined ? '未知' : String(evidence.exitCode);
		if (stderr !== '') return `ACP 错误: ${message} | exit=${exit} | stderr: ${stderr}`;
		if (error?.engineFailure === 'timeout') {
			// Report the actual wait AND what the engine did meanwhile: "0 events"
			// is the fact that makes a silent engine diagnosable rather than a
			// vague "it timed out".
			const events = evidence.eventCount ?? 0;
			const seconds = Math.round((this.config.idleTimeoutMs ?? 0) / 1000);
			return `等待 ${seconds}s 期间本轮事件数=${events}（0=完全静默）| exit=${exit} | stderr 为空`;
		}
		return `ACP 错误: ${message} | exit=${exit}`;
	}
}

/* ─────────────────────────────── the command ───────────────────────────── */

const USAGE = [
	'Usage: /opencode <task>',
	'  -r                 continue the engine session this Harness session used last',
	'  --model <id>       pass a model through to the engine',
	'  --agent <name>     pass an agent through to the engine',
	'  --with-summary     prefix the task with this session\'s compaction snapshot',
	'  --no-context       send the task exactly as typed',
	'  --cwd <path>       advanced: override the engine working directory',
	'  --detach           return immediately; output stays in the engine subagent session',
].join('\n');

/**
 * Parse the `/opencode` argument grammar.
 *
 * Only the documented flags are consumed; every other word is task text, so
 * task prose containing dashes survives.
 *
 * @param raw - command input after `/opencode`.
 * @returns a discriminated parse result.
 */
function parseOpencodeInput(raw) {
	const trimmed = raw.trim();
	const options = { resume: false, detach: false, withSummary: undefined, model: undefined, agent: undefined, cwd: undefined };
	if (trimmed === '') return { kind: 'usage', options };
	const words = trimmed.split(/\s+/u);
	const task = [];
	for (let index = 0; index < words.length; index += 1) {
		const word = words[index];
		if (word === '-r' || word === '--resume') { options.resume = true; continue; }
		if (word === '--detach' || word === '--background') { options.detach = true; continue; }
		if (word === '--with-summary') { options.withSummary = true; continue; }
		if (word === '--no-context') { options.withSummary = false; continue; }
		if (word === '--model' || word === '--agent' || word === '--cwd') {
			const value = words[index + 1];
			if (value === undefined) return { kind: 'error', text: `/opencode: ${word} needs a value\n\n${USAGE}` };
			if (word === '--model') options.model = value;
			else if (word === '--agent') options.agent = value;
			else options.cwd = value;
			index += 1;
			continue;
		}
		task.push(word);
	}
	const text = task.join(' ').trim();
	if (text === '') return { kind: 'usage', options };
	return { kind: 'task', text, options };
}

/**
 * Mount the provider and the `/opencode` command.
 *
 * @param ctx - the plugin's Host context.
 * @param config - bundle configuration, already normalized by the loader.
 */
export function apply(ctx, config) {
	ctx.logger.info(`opencode-engine: mounting (provider=${config.providerName}, command=/${config.commandName})`);

	// engineCommand ships with no default (no machine-specific path in a public
	// bundle). Log the actionable fix instead of throwing — throwing here would
	// abort apply() and take the provider, the command, and every other plugin in
	// the chain down with it. Runs fail with a clear `crash` receipt until it is
	// set, which is the honest outcome.
	if (typeof config.engineCommand !== 'string' || config.engineCommand.trim() === '') {
		ctx.logger.error('opencode-engine: engineCommand is empty — set engineCommand in cordis.patch.yml to your opencode executable (.exe on Windows); no default is shipped');
	}

	/** Resolved defaults plus the state the provider reads when starting. */
	const state = {
		engineCommand: config.engineCommand,
		model: config.model,
		agent: config.agent,
		// The stored `auto` spelling covers both `allow` and (nominally) an unbuilt
		// ask mode; the three-way distinction is explicit in Config.
		permissionMode: config.permission === 'allow' ? 'auto' : config.permission === 'ask' ? 'ask-only' : 'reject',
		cwdAlign: config.cwdAlign,
		withSummary: config.withSummary,
	};

	// Storage is an enhancement, never a precondition: a missing or failed domain
	// only costs `-r` its memory and durable defaults. The open is wrapped so a
	// THROWN failure (not just a rejected promise) cannot abort this plugin's
	// apply() — which would take the provider and the command down with it.
	// The storage open is LAZY and RETRYABLE: a one-shot promise pins a
	// transient lock conflict (old and new Host briefly alive across a restart or
	// hot re-mount) for the whole mount lifetime — writes from a healthy mount
	// land while a later mount reads 'unavailable'. Each use retries
	// until an open succeeds; a success is memoized.
	let domainPromise;
	const ensureDomain = () => {
		if (domainPromise === undefined) {
			domainPromise = (async () => {
				// Retries absorb the close-race window of a hot re-mount (install_bundle
				// re-applies the plugin; the previous instance's domain close can still be
				// in flight). Every observed failure followed a re-mount within seconds.
				let domain;
				let attemptError;
				for (let attempt = 0; attempt < 4; attempt += 1) {
					try {
						domain = await ctx.storageDomain.open(engineDomain);
						break;
					} catch (error) {
						attemptError = error;
						if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1200));
					}
				}
				if (domain === undefined) throw attemptError;
				for (const [, record] of domain.table('defaults').entries()) Object.assign(state, record);
				lastDomainError = undefined;
				return domain;
			})().catch((error) => {
				lastDomainError = `${error?.name ?? 'Error'}: ${String(error?.message ?? error)}`;
				ctx.logger.warn(`opencode-engine: plugin storage unavailable, retrying on next use: ${String(error)}`);
				domainPromise = undefined;
				return undefined;
			});
		}
		return domainPromise;
	};

	/**
	 * Resolve the engine cwd for one parent agent.
	 *
	 * Red line 5: the engine works in the current session's directory. The
	 * workingDirectory service is the authority; the session header is only a
	 * fallback when that service is absent.
	 */
	state.cwdOf = (parent) => {
		if (state.cwdAlign === true) {
			const workingDirectory = ctx.get('workingDirectory');
			const resolved = workingDirectory?.get?.(parent.session);
			if (typeof resolved === 'string' && resolved !== '') return resolved;
		}
		const header = parent.session?.header;
		if (typeof header?.cwd === 'string' && header.cwd !== '') return header.cwd;
		return process.cwd();
	};

	state.rememberEngineSession = async (request, engineSessionId, cwd, model) => {
		const domain = await ensureDomain();
		if (domain === undefined) return;
		try {
			await domain.table('sessions').put(request.parent.session.id, {
				harnessSessionId: request.parent.session.id,
				engineSessionId,
				cwd,
				updatedAt: Date.now(),
				model: model ?? '',
			});
		} catch (error) {
			ctx.logger.warn(`opencode-engine: could not remember the engine session: ${String(error)}`);
		}
	};

	/**
	 * Ask a human whether the engine may perform one action.
	 *
	 * This is the bridge's decision half; `connectEngine` owns the ACP half. It
	 * resolves to the approval seam's closed outcome vocabulary and never
	 * resolves to a grant on any failure path:
	 *  - no `ctx.approval` composed      → `'unavailable'` (fail closed)
	 *  - no live agent to audit to       → `'unavailable'`
	 *  - seam throws                     → `'unavailable'`
	 *  - approval times out              → `'cancelled'`
	 *  - parent run aborted              → `'cancelled'`
	 *
	 * The timeout matters because a bridge that waits forever wedges the engine
	 * turn (the ACP request stays unanswered, so `session/prompt` never settles).
	 */
	state.requestApproval = async ({ ctx: host, parent, signal, toolCall, cwd, timeoutMs }) => {
		const approval = host.get('approval');
		if (approval?.request === undefined) {
			host.logger.warn('opencode-engine: no approval service is composed; denying the engine request (fail closed)');
			return 'unavailable';
		}
		const agent = parent;
		if (agent?.session === undefined) {
			host.logger.warn('opencode-engine: engine permission request has no agent to route through; denying (fail closed)');
			return 'unavailable';
		}
		// `approval.request` requires an OPEN TURN: the approval/asked + approval/decided
		// audit pair must sit inside the durable log's commit boundary, and the
		// service throws outside one (verified against the real service: it
		// refuses with "approval.request() outside an open turn").
		//
		// Measured on Windows: the `/opencode` command path has NO turn (commands
		// execute outside the turn machinery, unlike a model-issued tool call).
		// So on that path every engine permission would throw and collapse into
		// 'unavailable' — which would look like a broken approval card rather
		// than what it is: there is no turn to hang the audit pair on.
		//
		// We do NOT fabricate a turn (that would forge session structure, red
		// line 3/4 territory). We report the precise reason, so the receipt can
		// tell the user "use the opencode tool, not /opencode, when permission is
		// ask" instead of silently refusing every file the engine touches.
		if (!sessionHasOpenTurn(agent.session)) {
			host.logger.warn('opencode-engine: engine asked for permission outside an open turn (the /opencode command path); denying (fail closed) — use the `opencode` tool inside a turn, or set permission: allow');
			return 'no-turn';
		}
		const controller = new AbortController();
		const relay = () => controller.abort();
		signal?.addEventListener('abort', relay, { once: true });
		let timer;
		try {
			const raced = await Promise.race([
				Promise.resolve().then(() => approval.request({
					agent,
					toolName: config.commandName,
					reason: describePermission(toolCall),
					displayReason: `opencode 引擎请求权限（工作目录 ${cwd}）`,
					signal: controller.signal,
				})).then((outcome) => ({ kind: 'answered', outcome })).catch((error) => ({ kind: 'failed', error })),
				new Promise((resolve) => {
					timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
					timer.unref?.();
				}),
			]);
			if (raced.kind === 'timeout') {
				host.logger.warn(`opencode-engine: approval timed out after ${timeoutMs}ms; denying the engine request (fail closed)`);
				controller.abort();
				return 'cancelled';
			}
			if (raced.kind === 'failed') {
				host.logger.warn(`opencode-engine: approval seam failed; denying the engine request (fail closed): ${String(raced.error)}`);
				return 'unavailable';
			}
			return raced.outcome;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener('abort', relay);
		}
	};

	/**
	 * Read the files this run changed, for the completion receipt.
	 *
	 * MEASURED: `ctx.workspaceChanges.summary()` does NOT see the
	 * engine's writes. It records git snapshots per top-level turn plus
	 * whole-file captures around HARNESS file tools, and the engine is an
	 * external process writing straight to disk — so its summary is empty for an
	 * engine run. The fallback: take a `git status`-style
	 * snapshot ourselves through the subprocess seam, and only report a list
	 * when the workspace is actually a git repository.
	 *
	 * @returns a newline-separated change list, or undefined when unavailable.
	 */
	state.describeChanges = async (request, enabled) => {
		if (enabled === false) return undefined;
		const cwd = request.cwd ?? state.cwdOf(request.parent);
		if (typeof cwd !== 'string' || cwd === '') return undefined;
		try {
			const handle = ctx.subprocess.spawn({
				// `-uall` disables directory collapsing so a new folder lists its files
				// individually, which is what a change receipt is actually for.
				argv: ['git', 'status', '--porcelain=v1', '-uall'],
				cwd,
				stdio: { stdin: 'ignore', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 4096 } },
				graceMs: 2000,
			});
			const outcome = await handle.done.catch(() => undefined);
			// Not a git repository (or git is absent): reporting "nothing changed"
			// would be a lie, so omit the list entirely.
			if (outcome?.exitCode !== 0) return undefined;
			const read = handle.collected?.stdout?.readFrom?.(0);
			const text = String(read?.text ?? '').trim();
			if (text === '') return undefined;
			// `--porcelain` prefixes each line with a two-character status code
			// (`??` untracked, ` M` modified, `A ` staged…). Keep the code but label
			// it so the parent line reads as a change list rather than git soup.
			return text
				.split(/\r?\n/u)
				.map((line) => line.trimEnd())
				.filter((line) => line !== '')
				.join('\n');
		} catch (error) {
			ctx.logger.warn(`opencode-engine: changed-file snapshot unavailable: ${String(error)}`);
			return undefined;
		}
	};

	ctx.effect(() => () => {
		void ensureDomain().then((domain) => domain?.close?.()).catch(() => {});
	}, 'opencode-engine domain');

	// Register the provider SYNCHRONOUSLY. `registerProvider` is an effect on this
	// plugin's fiber, and `ctx.effect()` asserts the fiber is still active — a
	// registration deferred into a promise continuation can land after the fiber
	// settles, where it throws and the provider silently never exists (the model
	// then sees no delegation tool at all). Storage readiness is therefore the
	// command handler's problem, not the provider's.
	ctx.subagents.registerProvider(new OpencodeProvider(config.providerName, ctx, config, state));

	ctx.commands.register({
		name: config.commandName,
		description: 'Run a coding task in a spawned opencode engine (ACP)',
		input: { hint: '<task>' },
		handler: (invocation) => runOpencodeCommand(ctx, config, state, ensureDomain, invocation),
	});
}

/**
 * Normalize a directory path for comparison.
 *
 * Windows paths are case-insensitive and tolerate a trailing separator, so two
 * spellings of one directory must compare equal; on POSIX only the separator is
 * trimmed and case is preserved.
 *
 * @param value - absolute directory path.
 * @returns a stable comparison key.
 */
function normalizePathKey(value) {
	const trimmed = String(value).replace(/[\\/]+$/u, '');
	return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/**
 * Execute one `/opencode` invocation.
 *
 * Never injects assistant messages: it starts an engine activation
 * through the provider and returns a receipt naming the engine session.
 */
async function runOpencodeCommand(ctx, config, state, openDomain, invocation) {
	const parsed = parseOpencodeInput(invocation.rawInput);
	if (parsed.kind === 'usage') return { kind: 'error', text: USAGE };
	if (parsed.kind === 'error') return { kind: 'error', text: parsed.text };

	// Storage is optional for a run: without it `-r` simply cannot find an earlier
	// engine session, and a task still executes. Awaiting a failed `openDomain()`
	// would turn a storage fault into a dead command, so degrade explicitly.
	const domain = await openDomain();
	const parent = invocation.agent;
	const harnessSessionId = parent.session.id;
	const cwd = parsed.options.cwd ?? state.cwdOf(parent);

	// Continuation: reuse the engine session this Harness session used last,
	// but only when the working directory is unchanged — the engine's history
	// refers to files by relative path, so a different cwd makes it meaningless.
	// Windows paths compare case-insensitively and tolerate a trailing separator,
	// so normalize before deciding.
	const cwdKey = normalizePathKey(cwd);
	let resumeSessionId;
	let resumeNote;
	if (parsed.options.resume === true) {
		const previous = domain?.table('sessions').get(harnessSessionId);
		if (domain === undefined) {
			resumeNote = `plugin storage is unavailable (${lastDomainError ?? 'first attempt still pending'}); started a new engine session`;
		} else if (previous === undefined) {
			resumeNote = 'no earlier engine session for this Harness session; started a new one';
		} else if (normalizePathKey(previous.cwd) !== cwdKey) {
			resumeNote = `earlier engine session ran in ${previous.cwd}, not ${cwd}; started a new one`;
		} else {
			resumeSessionId = previous.engineSessionId;
		}
	}

	let task = parsed.text;
	if (parsed.options.withSummary ?? state.withSummary) {
		const snapshot = currentCompactionSnapshot(parent.session);
		if (typeof snapshot === 'string' && snapshot.trim() !== '') task = `${snapshot.trim()}\n\n---\n\n${task}`;
	}

	const activation = await ctx.subagents.startActivation({
		provider: config.providerName,
		label: `opencode: ${parsed.text.slice(0, 60)}`,
		request: {
			prompt: [{ type: 'text', text: task }],
			parent,
			// Backend-private fields the provider reads; they travel on the request
			// rather than through plugin-global state.
			engineSessionId: resumeSessionId,
			model: parsed.options.model ?? (state.model === '' ? undefined : state.model),
			agent: parsed.options.agent ?? (state.agent === '' ? undefined : state.agent),
		},
		signal: invocation.signal,
		delivery: 'caller',
	});

	const lines = [
		// The child id is the Harness-side subagent identity (what the side bar and
		// `send_message` use); the engine's own session id is recorded separately
		// and is what `-r` resumes.
		`subagent: ${activation.childId}`,
		`cwd: ${cwd}`,
		...(parsed.options.model === undefined ? [] : [`model: ${parsed.options.model}`]),
		...(parsed.options.agent === undefined ? [] : [`agent: ${parsed.options.agent}`]),
		...(resumeSessionId === undefined ? [] : [`resumed engine session: ${resumeSessionId}`]),
		...(resumeNote === undefined ? [] : [`note: ${resumeNote}`]),
	];
	if (parsed.options.detach === true) {
		lines.push(
			config.permission === 'ask'
				? '（--detach）后台运行中：越权操作仍会弹审批卡；进度与输出在侧栏子代理面板的该会话内查看。'
				: '（--detach）后台运行中：进度与输出在侧栏子代理面板的该会话内查看。',
		);
		return { kind: 'success', text: lines.join('\n') };
	}
	// Default path: WAIT for the engine and paste its answer here. Otherwise,
	// `/opencode` users have to discover the subagent session to see output
	// (`delivery: 'caller'` already suppresses the parent
	// settlement notice, so waiting here is the only way to hear the result).
	let outcome;
	try {
		outcome = await awaitActivation(activation, invocation.signal);
	} catch (error) {
		outcome = { stopReason: 'error', output: [], diagnostic: `等待引擎结果失败: ${String(error)}` };
	}
	const blocks = Array.isArray(outcome?.output) ? outcome.output : [];
	const text = blocks
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n\n')
		.trim();
	const status = outcome?.stopReason === 'end_turn'
		? '完成'
		: outcome?.stopReason === 'aborted'
			? '已中止'
			: outcome?.stopReason === 'error'
				? '失败'
				: String(outcome?.stopReason ?? '结束');
	const diagnostic = typeof outcome?.diagnostic === 'string' && outcome.diagnostic !== '' ? outcome.diagnostic : undefined;
	const body = text !== '' ? text : (diagnostic ?? '（引擎无正文输出）');
	const capped = body.length > 8000 ? `${body.slice(0, 6000)}\n…（输出过长已截断，全文见子会话）…\n${body.slice(-1500)}` : body;
	const head = [`[opencode] ${status}`, ...lines];
	if (diagnostic !== undefined && text !== '') head.push(`note: ${diagnostic}`);
	head.push('--- 引擎输出 ---', capped);
	return { kind: 'success', text: head.join('\n') };
}


/**
 * Await one activation, honoring the command's abort signal.
 *
 * Cancelling the command disposes the activation (the provider's dispose path
 * requests an engine-side cancel), so a closed chat tab cannot leave the engine
 * running unattended.
 *
 * @param activation - the handle returned by `subagents.startActivation`.
 * @param signal - the command invocation's abort signal.
 * @returns the terminal outcome, or a synthetic aborted outcome.
 */
async function awaitActivation(activation, signal) {
	const aborted = new Promise((resolve) => {
		if (signal?.aborted === true) {
			void activation.dispose?.();
			resolve(undefined);
			return;
		}
		signal?.addEventListener?.(
			'abort',
			() => {
				void activation.dispose?.();
				resolve(undefined);
			},
			{ once: true },
		);
	});
	let raced;
	try {
		raced = await Promise.race([activation.result, aborted]);
	} catch (error) {
		return { stopReason: 'error', output: [], diagnostic: `等待引擎结果失败: ${String(error)}` };
	}
	if (raced === undefined) {
		return { stopReason: 'aborted', output: [], diagnostic: '命令已取消；引擎中止已请求，已产生的输出保留在子会话中。' };
	}
	return raced;
}
