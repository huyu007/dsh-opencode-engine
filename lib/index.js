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
// 0.2.7 ROOT CAUSE of the "stored record ... does not match its schema" receipts:
// dsh-storage-domain's open() validates every stored record with
// `tableSpec.valueSchema.parse(raw)`, and its contract REQUIRES zod record
// schemas (README: "Record schemas are zod ... plugin Config stays schemastery";
// lib/types/spec.d.ts: `import type { ZodType } from 'zod'`). The domain tables
// below were built with schemastery, whose schemas have NO .parse/.safeParse
// method (measured against the installed copies: `typeof s.parse ===
// 'undefined'`). So facility.open threw `TypeError: tableSpec.valueSchema.parse
// is not a function` for EVERY stored record, and parseRecord wrapped it as
// `DomainError('invalid-record'): ... does not match its schema` with `issues =
// null` — no field ever actually got compared. An empty table validated nothing,
// which is why open succeeded at 13:18 and died on every later open once one
// record existed. Dual-instance was also ruled out offline: plugin -> schemastery
// and storage-domain -> schemastery resolve to the SAME physical 3.18.5 copy.
// Fix = the documented split: domain record schemas on zod (pinned below),
// plugin Config stays schemastery `z`.
import { z as zod } from 'zod';
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';

export const name = 'opencode-engine';
export const inject = ['subagents', 'subprocess', 'commands', 'storageDomain'];

// 0.2.6: the LAST storage-open failure, surfaced into user-visible receipts.
// MUST live at module scope — runOpencodeCommand is a module-level function and
// cannot see apply()'s locals (0.2.5 shipped exactly that bug: ReferenceError
// 'lastDomainError is not defined', user-visible).
let lastDomainError;

/** Bundle configuration; every value has a working default.
 *
 * 0.2.10 (the missed 0.2.8 item): `engineCommand`, `model`, and `agent` are
 * `.volatile()` with EMPTY defaults, so (a) the bundle ships no machine path,
 * (b) editing them in the config panel lands WITHOUT remounting the plugin, and
 * (c) an unset `engineCommand` reaches apply() as `''` where the guard can say
 * so out loud instead of silently spawning a hardcoded path baked into the
 * tarball. Volatile fields parse to cosmokit references: ALWAYS read them as
 * `config.<field>.get()` at use time (core convention: agent-preset-registry's
 * `config.selectedDefault.get()`); mounting once and snapshotting the string
 * would freeze the value and defeat volatility.
 */
export const Config = z.object({
	// No machine default: this tarball must not carry a path that only exists on
	// one laptop (handoff §4.10). Set it in the profile patch or the config panel.
	engineCommand: z.string().volatile().default(''),
	// `--print-logs --log-level WARN` is LOAD-BEARING, not cosmetic: opencode
	// reports an exhausted lane only in its own log file, so without this mirror
	// the ACP stream and stderr are both silent and the failure is
	// indistinguishable from a hang (measured on Windows).
	engineArgs: z.array(z.string()).default(['acp', '--print-logs', '--log-level', 'WARN']),
	// `ask` is the approval bridge: every engine permission request goes through
	// `ctx.approval.request` and its outcome is written back to ACP. `allow`
	// auto-approves without a human in the path, `reject` declines everything.
	permission: z.union(['allow', 'reject', 'ask']).default('allow'),
	providerName: z.string().default('opencode-acp'),
	commandName: z.string().default('opencode'),
	// Volatile with empty defaults (0.2.10): the config panel writes these; a
	// change lands on the next run without a remount. Empty = "not set" — read
	// with `.get()` and treat `''` as no default, never as a value to send.
	model: z.string().volatile().default(''),
	agent: z.string().volatile().default(''),
	withSummary: z.boolean().default(false),
	cwdAlign: z.boolean().default(true),
	disposeGraceMs: z.number().default(3000),
	// Silence watchdog: the engine reports a dead Zen lane by simply never
	// answering `session/prompt` (measured twice on Windows, incl. a 9-minute
	// silent ROUND-2 on `-r`). Without this an exhausted quota and a wedged
	// engine look identical to slow work.
	//
	// 5 minutes, not 90s: a real opencode turn on this machine measured 16-22s
	// for a single write, and `session/load` + a multi-step edit can legitimately
	// run for minutes. A shorter ceiling would abort honest work; the value is a
	// Config key precisely so it can be tuned per task size. 0 disables it.
	idleTimeoutMs: z.number().default(300_000),
	// How long a `request_permission` waits for a human before failing closed.
	// Approval timeouts must never resolve to a grant.
	approvalTimeoutMs: z.number().default(300_000),
	// Append the files this run changed (git snapshot through the subprocess
	// seam; `ctx.workspaceChanges` does not see external-process writes).
	changeList: z.boolean().default(true),
	// 0.2.9 visibility fallback: the FULL engine transcript is written to
	// `<cwd>/<transcriptDir>/last-run.md` after every run (tool path and
	// `/opencode` command path alike), and the receipt names that path. The
	// receipt is a truncation boundary and the subagent seam may never surface
	// run output at all (measured against installed dsh-tool-subagent 0.2.1-rc.2:
	// its delegation tool renders only `started subagent <id>`), so this file is
	// the one place the complete engine output is guaranteed to exist. A write
	// failure never breaks the run — it is logged and the receipt says so.
	// Absolute paths are used as-is; a relative one resolves against the engine
	// cwd. Empty string disables the fallback.
	transcriptDir: z.string().default('.opencode-engine'),
});

/* ───────────────────────────── storage domain ───────────────────────────── */

/**
 * Durable defaults plus the last engine session per Harness session.
 *
 * `defaults` holds one record; `sessions` remembers which opencode session a
 * Harness session used, so `-r` can `session/load` it even after a restart.
 */
const engineDomain = defineDomain({
	// Storage unit names must match /^[a-z][a-z0-9_]*$/, so the task card's
	// `opencode-engine.defaults@1` spelling is not expressible: the separator is
	// `_`, never `.` or `-`. `version: 1` is the card's `@1`.
	// 0.2.7: record schemas are built with `zod` (see ROOT CAUSE note at the
	// imports) — `domainTable` requires a schema object exposing `.parse`.
	// Explicit `zod.literal` members keep the union valid on both zod majors
	// present in the tree (3.25.76 at top level, 4.4.3 nested under
	// dsh-storage-domain); bare strings are not valid union members on zod v3.
	// Stored records for both tables validate identically under either copy
	// (measured: the live failing record PASSES).
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
 * 0.2.7: exported for diagnostics — offline probes (and any future migration
 * tooling) can validate the real stored medium against the real spec without
 * duplicating the schema block. Not part of the plugin contract.
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
 * The point of this table is that "任务失败" must never be the whole answer:
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
		// NOTHING at all for the whole window (measured: 9-minute ROUND-2 silence on
		// `-r`, and the quota wall). `timeout` is reserved for a watchdog trip that
		// at least saw partial progress, where the only honest guess is slowness.
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
	// 0.2.10 (the missed 0.2.8 item): `engineCommand` has no machine default, so
	// an unconfigured bundle is a CONFIGURATION failure, not an engine crash.
	// Naming it separately is what keeps "引擎进程异常退出" honest as the spawn
	// failure it is, and tells the user exactly which field to fill in.
	config: {
		summary: 'engineCommand 未配置（插件没有内置默认路径）',
		hint: '在配置面板或 profile 的 cordis.patch.yml 里设置 engineCommand 为 opencode 的绝对 .exe 路径（Windows 必须是 .exe，不能用 .cmd），然后重试。',
	},
};

/**
 * Read one plugin `Config` value that may be a cosmokit volatile reference.
 *
 * `.volatile()` fields parse into `{ get() }` refs so live edits land without a
 * remount; ordinary fields stay plain values. Accepting both shapes keeps the
 * read sites correct under either, and makes the offline probes able to feed
 * plain strings.
 *
 * @param value - parsed config value (ref object or plain string).
 * @returns the current string value ('' when unset).
 */
function readConfigString(value) {
	if (typeof value === 'string') return value;
	if (value !== null && typeof value === 'object' && typeof value.get === 'function') return String(value.get() ?? '');
	return '';
}

/**
 * Resolve one engine string setting for a run.
 *
 * Precedence matches the pre-0.2.10 behaviour, where the durable storage-domain
 * `defaults` record was `Object.assign`ed OVER the mount-time config snapshot:
 * durable record wins, then the volatile config value, then unset (''). Keeping
 * that order means a machine that does use the durable table loses nothing when
 * `engineCommand` / `model` / `agent` go volatile.
 *
 * @param state - the durable-defaults mirror from apply().
 * @param key - the field name.
 * @param config - the plugin config (volatile fields read through {@link readConfigString}).
 * @returns the effective string; '' means not configured.
 */
function resolveEngineSetting(state, key, config) {
	const durable = state?.[key];
	if (typeof durable === 'string' && durable !== '') return durable;
	return readConfigString(config[key]);
}

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
 *   - `silent`  — ZERO events after activation (measured on a 9-minute `-r`
 *                 ROUND-2 silence, and on the quota wall).
 *   - `timeout` — the turn moved (chunks, tool ticks) and then stopped.
 *
 * @param error - the rejection raised while prompting.
 * @param evidence - captured stderr, whether the child exited, and the event
 *   count observed this turn.
 * @returns one of the ENGINE_ERRORS keys.
 */
function classifyFailure(error, evidence = {}) {
	// 0.2.10: an unset `engineCommand` never reaches the engine, so it must not
	// be classified as a crash/protocol failure of one.
	if (error?.engineFailure === 'config') return 'config';
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
 * Build the run outcome for an unset `engineCommand`.
 *
 * `engineCommand` has no machine default (0.2.10), so an unconfigured bundle is
 * a CONFIGURATION failure, not an engine crash: returning the classified receipt
 * (instead of throwing) keeps the run a settled child outcome on both consumption
 * paths — the delegation tool renders it, and `/opencode` prints it once. The
 * alternative was a silent fallback to a machine-specific path baked into the
 * tarball, which is exactly what 0.2.7 shipped by accident.
 *
 * @param config - the plugin config (volatile fields read through {@link readConfigString}).
 * @param logger - host logger, warned for the operator log too.
 * @returns a failed run outcome in the provider's own result shape.
 */
function engineCommandUnsetOutcome(config, logger) {
	logger?.warn?.('opencode-engine: engineCommand is unset; refusing to spawn (set it in the config panel or cordis.patch.yml)');
	const error = new Error('engineCommand 未配置');
	error.engineFailure = 'config';
	const kind = classifyFailure(error);
	return {
		output: [],
		diagnostic: describeEngineError(kind, `engineCommand=${JSON.stringify(readConfigString(config.engineCommand))}`),
		stopReason: 'error',
	};
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
 * then stops answering. The patterns are the literal strings measured from
 * `opencode acp` plus their provider-side spellings.
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
 * single-action grant, and M2 deliberately never remembers a choice). A
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
 * @param options.permission - 'allow', 'reject', or 'ask' (the M2 human bridge).
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
			// This handler IS the permission bridge : it is the processor
			// of ACP's own request, not a listener inside someone else's waterfall.
			const params = context.params ?? {};
			const offered = Array.isArray(params.options) ? params.options : [];
			progress();

			if (options.permission !== 'ask') {
				// M1 policies: a closed pair, no human in the path.
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
 * @param options - `preamble: false` omits the "no closing message" lead line
 *   (0.2.9: the facts block now also rides BELOW real prose, where claiming the
 *   run had no closing message would contradict the text printed above it).
 * @returns a plain-text summary for the parent session.
 */
function summariseEngineRun(conversation, stopReason, { preamble = true } = {}) {
	const completed = conversation.tools.filter((tool) => tool.status === 'completed');
	const listed = (completed.length > 0 ? completed : conversation.tools).map((tool) => `${tool.title} (${tool.kind})`);
	const lines = [
		...(preamble ? ['opencode engine finished without a closing message.'] : []),
		...(listed.length === 0 ? ['No tool activity was reported.'] : ['Tool activity:', ...listed.map((line) => `  - ${line}`)]),
		`stop reason: ${stopReason}`,
		`engine session: ${conversation.sessionId}`,
	];
	return lines.join('\n');
}

/**
 * Compose the one text block every run receipts with: engine prose FIRST, then
 * the run facts, then where the full transcript went.
 *
 * 0.2.9 root fix for "看不到 opencode 输出": the prose and the facts used to be
 * mutually exclusive (`text.trim() === '' ? facts : text`), so a run that did
 * produce prose lost its `engine session:` / stop reason / tool activity and the
 * parent could not tell a finished run from a truncated one. Both always ride
 * now, and the array is never empty.
 *
 * The caveats diagnostic stays a SEPARATE result field — the command path
 * renders it exactly once (into `note:` when there is prose, into the body when
 * there is none), so folding it in here would print it twice.
 *
 * @param engineText - the engine's committed assistant text, possibly empty.
 * @param facts - `summariseEngineRun` output for this run.
 * @param extra - optional trailing line (the transcript path / write failure).
 * @returns the receipt text.
 */
function composeReceiptText(engineText, facts, extra) {
	const prose = String(engineText ?? '').trim();
	const parts = [prose === '' ? facts : `${prose}\n\n---\n${facts}`];
	if (typeof extra === 'string' && extra !== '') parts.push(extra);
	return parts.join('\n');
}

/**
 * Resolve the transcript directory for one run.
 *
 * Relative values follow the engine cwd, so the transcripts sit with the work
 * they describe; absolute values are honoured as written.
 *
 * @param cwd - the engine working directory for the run.
 * @param transcriptDir - the `transcriptDir` config value.
 * @returns the absolute directory, or undefined when the fallback is disabled.
 */
function transcriptBaseDir(cwd, transcriptDir) {
	const dir = String(transcriptDir ?? '').trim();
	if (dir === '') return undefined;
	return resolve(isAbsolute(dir) ? dir : resolve(cwd, dir));
}

/** Sequence counter for transcript file names (one distinct file per run). */
let transcriptSequence = 0;

/**
 * Header block for one transcript file: what ran, where, and how it ended.
 *
 * @param fields - label/cwd/engine session/task/stop reason of the finished run.
 * @returns markdown header text, ending with the `## engine output` marker.
 */
function transcriptHeader({ label, cwd, engineSessionId, task, stopReason }) {
	const lines = [
		'# opencode engine run',
		`when: ${new Date().toISOString()}`,
		`label: ${String(label ?? '').trim()}`,
		`cwd: ${cwd}`,
		`engine session: ${engineSessionId}`,
		`stop reason: ${stopReason}`,
	];
	if (typeof task === 'string' && task.trim() !== '') lines.push('', '## task', task.trim());
	lines.push('', '## engine output');
	return lines.join('\n');
}

/**
 * File name for one run's transcript: timestamp plus a monotonic counter so
 * concurrent runs never overwrite each other, even within the same second.
 *
 * @param now - epoch millis to name the file from (Date.now() by default).
 * @returns a filesystem-safe `.md` file name.
 */
function transcriptFileName(now = Date.now()) {
	const stamp = new Date(now).toISOString().replace(/[:.]/gu, '-');
	transcriptSequence = (transcriptSequence + 1) % 1000;
	return `${stamp}-${String(transcriptSequence).padStart(3, '0')}.md`;
}

/**
 * Write one run's complete engine output where the user can actually open it.
 *
 * This is the 0.2.9 visibility floor: the subagent seam's tool row renders only
 * `started subagent <id>` (measured against installed dsh-tool-subagent
 * 0.2.1-rc.2), the settlement notice is dropped if the parent agent instance
 * changed, and `/opencode` truncates long output — so without this file there
 * are real runs whose full engine output exists nowhere a human can read. Two
 * copies are written: the per-run file the receipt names (concurrent runs must
 * not clobber each other) and a stable `last-run.md` for "show me the last
 * one". A write failure is never fatal: it is reported in the receipt and
 * logged.
 *
 * @param options - cwd plus the transcript directory setting and run contents.
 * @returns `{ path }` on success, `{ error }` on failure, `{}` when disabled.
 */
function writeEngineTranscript({ cwd, transcriptDir, header, body, facts, now }) {
	const dir = String(transcriptDir ?? '').trim();
	if (dir === '') return {};
	const text = `${String(header ?? '').trim()}\n\n---\n\n${String(body ?? '')}\n\n---\n${String(facts ?? '')}\n`;
	try {
		const base = resolve(isAbsolute(dir) ? dir : resolve(cwd, dir));
		mkdirSync(base, { recursive: true });
		const file = join(base, transcriptFileName(now ?? Date.now()));
		writeFileSync(file, text, 'utf8');
		// The stable pointer is best-effort on top of a written per-run file.
		try {
			writeFileSync(join(base, 'last-run.md'), text, 'utf8');
		} catch {
			// The receipt already names the per-run file, which is what matters.
		}
		return { path: file };
	} catch (error) {
		return { error: String(error?.message ?? error) };
	}
}

/**
 * The receipt line naming where a run's full transcript went.
 *
 * @param transcript - the result of `writeEngineTranscript`.
 * @param logger - optional plugin logger; failures are warned, never thrown.
 * @returns one line to append to the receipt, or undefined when nothing to say.
 */
function transcriptLine(transcript, logger) {
	if (transcript?.path !== undefined) return `full transcript: ${transcript.path}`;
	if (transcript?.error !== undefined) {
		logger?.warn(`opencode-engine: transcript write failed: ${transcript.error}`);
		return `note: 引擎完整输出落盘失败（${transcript.error}）；本回执已是能保留的全部正文。`;
	}
	return undefined;
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
		// 0.2.10: engine settings are read at USE time (volatile config, with the
		// durable storage record winning as it did before), so a config-panel edit
		// applies to the next run without a restart. `engineCommand` is checked
		// first, before anything exists to cancel or dispose: an unset command is a
		// configuration failure, not an engine failure.
		const engineCommand = resolveEngineSetting(providerState, 'engineCommand', config);
		if (engineCommand === '') return { id: brandString(randomUUID()), result: Promise.resolve(engineCommandUnsetOutcome(config, ctx.logger)), dispose: async () => {} };
		const model = resolveEngineSetting(providerState, 'model', config);
		const agent = resolveEngineSetting(providerState, 'agent', config);
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
				engineCommand,
				engineArgs: config.engineArgs,
				cwd,
				permission: config.permission,
				graceMs: config.disposeGraceMs,
				signal: request.signal,
				resumeSessionId,
				// An explicit per-run model/agent wins over the bundle defaults.
				model: request.model ?? model,
				agent: request.agent ?? agent,
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
				// Record the engine session so `-r` can resume it next time. Store the
				// resolved value (plain string), not the volatile ref object.
				await providerState.rememberEngineSession?.(request, live.sessionId, cwd, model);
				const changes = await providerState.describeChanges?.(request, config.changeList);
				const refused = approvals.filter((entry) => entry.outcome !== 'allowed-once');
				const caveats = buildDiagnostic(refusals, refused, changes);
				const engineText = text.trim();
				const facts = summariseEngineRun(live, answered.stopReason, { preamble: engineText === '' });
				// 0.2.9 改动 3: the complete output goes to a file the user can
				// open, on BOTH paths — the delegation tool's receipt renders only
				// `started subagent <id>` on this host, and `--detach` never waits,
				// so without this the full engine text exists nowhere.
				const transcript = transcriptLine(
					writeEngineTranscript({
						cwd,
						transcriptDir: config.transcriptDir,
						header: transcriptHeader({ label: request.label, cwd, engineSessionId: live.sessionId, task, stopReason: answered.stopReason }),
						body: text,
						facts: [facts, caveats.diagnostic].filter((part) => typeof part === 'string' && part !== '').join('\n'),
					}),
					ctx.logger,
				);
				return {
					// 0.2.9 改动 1: prose AND facts, never one or the other. An engine
					// turn often ends with tool activity and no closing prose; the facts
					// block then stands in as the whole text. The array is never empty,
					// so whatever channel the host surfaces (settlement notice, command
					// receipt) always has something.
					output: [{ type: 'text', text: composeReceiptText(text, facts, transcript) }],
					// A refused model/agent is a warning, never a failed run: the task still
					// executed on the engine's default, and the parent must be told. Denied
					// engine permissions belong in the same channel for the same reason:
					// the task may be incomplete, but the run itself succeeded.
					// The caveats stay a SEPARATE field — the command path prints them
					// exactly once (as `note:` when prose exists, as the body when not).
					...caveats,
					stopReason: cancelled ? 'aborted' : stopReasonOf(answered.stopReason),
				};
			} catch (error) {
				const partial = chunks.join('');
				if (cancelled) {
					// 0.2.9: an aborted run's partial output gets the same file
					// treatment, so "it stopped early" is checkable, not just visible.
					const transcript = partial.trim() === '' ? undefined : transcriptLine(
						writeEngineTranscript({
							cwd,
							transcriptDir: config.transcriptDir,
							header: transcriptHeader({ label: request.label, cwd, engineSessionId: live.sessionId, task: '', stopReason: 'cancelled' }),
							body: partial,
							facts: `stop reason: cancelled\nengine session: ${live.sessionId}`,
						}),
						ctx.logger,
					);
					return {
						output: partial.trim() === '' ? [] : [{ type: 'text', text: [partial.trim(), transcript].filter(Boolean).join('\n') }],
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
				// 0.2.9: a failed run's PARTIAL output is kept in the receipt (the
				// diagnostic alone tells what broke but not how far the engine got),
				// and the same partial goes to the transcript file.
				const failureFacts = `stop reason: error (${kind})\nengine session: ${live.sessionId}`;
				const transcript = partial.trim() === '' ? undefined : transcriptLine(
					writeEngineTranscript({
						cwd,
						transcriptDir: config.transcriptDir,
						header: transcriptHeader({ label: request.label, cwd, engineSessionId: live.sessionId, task: '', stopReason: `error (${kind})` }),
						body: partial,
						facts: failureFacts,
					}),
					ctx.logger,
				);
				return {
					output: partial.trim() === '' ? [] : [{ type: 'text', text: [partial.trim(), transcript].filter(Boolean).join('\n') }],
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
 * Only the documented flags are consumed; every other token is task text, so
 * task prose containing dashes survives.
 *
 * @param raw - command input after `/opencode`.
 * @returns a discriminated parse result.
 */
function parseOpencodeInput(raw) {
	const trimmed = raw.trim();
	const options = { resume: false, detach: false, withSummary: undefined, model: undefined, agent: undefined, cwd: undefined };
	if (trimmed === '') return { kind: 'usage', options };
	const tokens = trimmed.split(/\s+/u);
	const task = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === '-r' || token === '--resume') { options.resume = true; continue; }
		if (token === '--detach' || token === '--background') { options.detach = true; continue; }
		if (token === '--with-summary') { options.withSummary = true; continue; }
		if (token === '--no-context') { options.withSummary = false; continue; }
		if (token === '--model' || token === '--agent' || token === '--cwd') {
			const value = tokens[index + 1];
			if (value === undefined) return { kind: 'error', text: `/opencode: ${token} needs a value\n\n${USAGE}` };
			if (token === '--model') options.model = value;
			else if (token === '--agent') options.agent = value;
			else options.cwd = value;
			index += 1;
			continue;
		}
		task.push(token);
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

	/**
	 * Resolved durable defaults plus the helpers the provider and command use.
	 *
	 * 0.2.10: this mirror holds ONLY the durable storage-domain `defaults` record
	 * (an optional, per-machine convenience layer) and helper closures. The Config
	 * fields `engineCommand` / `model` / `agent` are volatile and are read from
	 * `config` at use time — snapshotting them here would freeze the mount-time
	 * value and defeat live config-panel edits (that is what this release fixes).
	 */
	const state = {
		// The M1 spelling `auto` covered both `allow` and (nominally) an unbuilt
		// ask mode; M2 makes the three-way distinction explicit.
		permissionMode: config.permission === 'allow' ? 'auto' : config.permission === 'ask' ? 'ask-only' : 'reject',
		cwdAlign: config.cwdAlign,
		withSummary: config.withSummary,
	};

	// Storage is an enhancement, never a precondition: a missing or failed domain
	// only costs `-r` its memory and durable defaults. The open is wrapped so a
	// THROWN failure (not just a rejected promise) cannot abort this plugin's
	// apply() — which would take the provider and the command down with it.
	// 0.2.4: the storage open is LAZY and RETRYABLE. A one-shot promise pinned a
	// transient lock conflict (old and new Host briefly alive across a restart)
	// for the whole mount lifetime — writes from a healthy mount landed while a
	// later mount read 'unavailable' (measured on Windows). Each use retries
	// until an open succeeds; a success is memoized.
	let domainPromise;
	const ensureDomain = () => {
		if (domainPromise === undefined) {
			domainPromise = (async () => {
				// 0.2.6: retries absorb the close-race window of a hot re-mount (install_bundle
				// re-applies the plugin; the previous instance's domain close can still be in
				// flight). Measured: every failure followed a re-mount within seconds.
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
	 * The engine works in the current session's directory. The
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
	 * Ask a human whether the engine may perform one action .
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
	 * Read the files this run changed, for the completion receipt .
	 *
	 * MEASURED on Windows: `ctx.workspaceChanges.summary()` does NOT see the
	 * engine's writes. It records git snapshots per top-level turn plus
	 * whole-file captures around HARNESS file tools, and the engine is an
	 * external process writing straight to disk — so its summary is empty for an
	 * engine run. The fallback applies: take a `git status`-style
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
			// rather than through plugin-global state. '' (unset) becomes undefined so
			// the provider falls back to its own resolution instead of an empty send.
			engineSessionId: resumeSessionId,
			model: parsed.options.model ?? (resolveEngineSetting(state, 'model', config) || undefined),
			agent: parsed.options.agent ?? (resolveEngineSetting(state, 'agent', config) || undefined),
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
		// 0.2.9: the old wording sent users to "侧栏子代理面板的该会话", but this
		// external provider publishes no catalog child (no `prepareContinuable`;
		// P2 territory) — that session is not clickable, so the promise was false.
		// The provider still writes the run's transcript when it settles; name that
		// real location instead, and keep the approval-card note where it stays true.
		const base = transcriptBaseDir(cwd, config.transcriptDir);
		const transcriptHint = base === undefined
			? '输出暂不可见（transcriptDir 已禁用）：请不用 --detach 重跑，以便在本回执直接取得输出。'
			: `结束后完整输出写入 ${join(base, 'last-run.md')}。`;
		lines.push(
			config.permission === 'ask'
				? `（--detach）后台运行中：越权操作仍会弹审批卡。${transcriptHint}`
				: `（--detach）后台运行中。${transcriptHint}`,
		);
		return { kind: 'success', text: lines.join('\n') };
	}
	// Default path (0.2.3): WAIT for the engine and paste its answer here. Before
	// this, `/opencode` users had to discover the subagent session to see output
	// (UX fix; `delivery: 'caller'` already suppresses the parent
	// settlement notice, so waiting here is the only way to hear the result).
	const base = transcriptBaseDir(cwd, config.transcriptDir);
	let outcome;
	try {
		outcome = await awaitActivation(
			activation,
			invocation.signal,
			base === undefined
				? undefined
				: `已产生的输出在引擎结束（或退出）后写入 ${join(base, 'last-run.md')}。`,
		);
	} catch (error) {
		outcome = { stopReason: 'error', output: [], diagnostic: `等待引擎结果失败: ${String(error)}` };
	}
	// Receipt assembly is a pure function of (head lines, outcome) — extracted so
	// an offline probe can exercise the diagnostic-exactly-once and truncation
	// rules without a live engine.
	const diagnostic = typeof outcome?.diagnostic === 'string' && outcome.diagnostic !== '' ? outcome.diagnostic : undefined;
	return { kind: 'success', text: buildCommandReceipt(lines, outcome, diagnostic) };
}


/**
 * Render one `/opencode` command receipt from the activation outcome.
 *
 * The diagnostic must appear EXACTLY once: it becomes the body when the engine
 * produced no prose, and a `note:` line when it did. Both branches, and neither
 * of them twice, is the contract probe 5 checks.
 *
 * @param lines - the header lines already composed (subagent id, cwd, notes).
 * @param outcome - the settled activation outcome.
 * @param diagnostic - the caveats/failure text, when there is any.
 * @returns the receipt markdown.
 */
function buildCommandReceipt(lines, outcome, diagnostic) {
	const blocks = Array.isArray(outcome?.output) ? outcome.output : [];
	const text = blocks
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n\n')
		.trim();
	const status = outcome?.stopReason === 'completed' || outcome?.stopReason === 'end_turn'
		? '完成'
		: outcome?.stopReason === 'aborted'
			? '已中止'
			: outcome?.stopReason === 'error'
				? '失败'
				: String(outcome?.stopReason ?? '结束');
	const caveats = typeof diagnostic === 'string' && diagnostic !== '' ? diagnostic : undefined;
	const body = text !== '' ? text : (caveats ?? '（引擎无正文输出）');
	// 0.2.9 改动 2: the old note sent users to a "子会话" that does not exist —
	// the seam publishes no catalog child for this external provider (no
	// `prepareContinuable`, measured against installed dsh-subagent 0.2.1-rc.2),
	// so it was a pointer to nothing. With the transcript fallback in place the
	// full text has a REAL location, named at the tail of the body itself
	// (`full transcript:`, which the 1500-char tail window keeps visible). When
	// transcript writing is disabled or failed, say plainly that nothing was
	// preserved, instead of inventing a place to look.
	const cutNote = /\nfull transcript: /u.test(body)
		? '…（输出过长已截断，仅显示首尾；完整输出见本回执末尾 full transcript 指向的文件）…'
		: '…（输出过长已截断，仅显示首尾；完整输出未保留）…';
	const capped = body.length > 8000 ? `${body.slice(0, 6000)}\n${cutNote}\n${body.slice(-1500)}` : body;
	const head = [`[opencode] ${status}`, ...lines];
	if (caveats !== undefined && text !== '') head.push(`note: ${caveats}`);
	head.push('--- 引擎输出 ---', capped);
	return head.join('\n');
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
 * @param abortNote - extra line telling the user where a cancelled run's
 *   partial output actually went (the provider still writes its transcript;
 *   naming the "子会话" was a pointer to a session this host never shows).
 * @returns the terminal outcome, or a synthetic aborted outcome.
 */
async function awaitActivation(activation, signal, abortNote) {
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
		return {
			stopReason: 'aborted',
			output: [],
			diagnostic: `命令已取消；引擎中止已请求。${abortNote ?? '已产生的输出保留在本次运行的回执与落盘文件中。'}`,
		};
	}
	return raced;
}
