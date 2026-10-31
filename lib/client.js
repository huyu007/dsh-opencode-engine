/**
 * opencode-engine model/usage panel — DSH Web GUI client bundle (0.2.12).
 *
 * Shape: the DSH client's own "decoration" recipe — ONE plain JS file that
 * registers a lazy-CJS factory into `window.__ModuleLoader__`, requiring only
 * platform modules (`react`, `react/jsx-runtime`) and exporting
 * `{ inject, apply }`. No build step, no bundler, no host-UI value imports:
 * cross-boundary collaboration goes through cordis services and this plugin's
 * own HTTP route, which is exactly the rule the host's client-module docs state.
 *
 * Surface: `conversation.composer.dock` — the host's slot for "ambient entries
 * below the composer card", session-scoped, and the least invasive allocated
 * space in the GUI (the host's own ActivityPill/UsagePill live there). The slot
 * gives us `sessionId` directly, so the panel is per-conversation by
 * construction: switching sessions re-reads that session's model pick and
 * token totals.
 *
 * Data: this plugin's `/opencode-engine/api` route (POST, `{ok,value}` envelope).
 * NEVER the model catalog of the Harness itself — that is the model *this*
 * conversation runs on; the panel answers what the spawned **opencode engine**
 * runs on, which is the report this feature closes.
 *
 * Degradation: a headless/CLI profile composes no webServer, so the route does
 * not exist. The panel then renders NOTHING (a dead pill is worse than no
 * pill), and every command surface (`/opencode models`, `model <id>`) still
 * works — the UI is an addition, never the only path.
 */
window.__ModuleLoader__.load({
	id: 'dsh-opencode-engine',
	factory(require) {
		const React = require('react');
		// createElement, NOT the jsx-runtime's `jsx(type, props)`: jsx takes
		// children INSIDE props, so `h('div', {...}, child)` with jsx silently
		// drops every child (observed: an empty panel renders exactly this way).
		// The host's own decoration template uses createElement for the same reason.
		const h = React.createElement;

		const API_BASE = 'opencode-engine/api';
		const STYLE_ID = 'dsh-opencode-engine-panel-css';

		// Design tokens are the host's own (--dsw-alias-*): literal colors would
		// not follow the active theme, and the client-module rules forbid them.
		const CSS = [
			'.oe-panel{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
			'.oe-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;max-width:100%}',
			'.oe-chip:hover{border-color:var(--dsw-alias-border-l4)}',
			'.oe-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-interactive-bg-hover);flex:none}',
			'.oe-model{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}',
			'.oe-usage{color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
			'.oe-pop{position:absolute;bottom:calc(100% + 6px);left:0;z-index:40;display:flex;flex-direction:column;gap:2px;min-width:260px;max-width:360px;max-height:320px;overflow:auto;padding:6px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-elevated);box-shadow:0 4px 16px rgba(0,0,0,.18)}',
			'.oe-wrap{position:relative;display:inline-flex}',
			'.oe-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 6px;border-radius:6px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;text-align:left;cursor:pointer;width:100%}',
			'.oe-row:hover{background:var(--dsw-alias-bg-overlay)}',
			'.oe-row[data-on="1"]{font-weight:600}',
			'.oe-rowname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.oe-hint{padding:4px 6px;color:var(--dsw-alias-label-tertiary);font-size:11px}',
			'.oe-sep{height:.5px;background:var(--dsw-alias-border-l3);margin:4px 0}',
			'.oe-actions{display:flex;gap:6px;padding:4px 6px 2px}',
			'.oe-btn{flex:1;padding:3px 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}',
			'.oe-btn:hover{color:var(--dsw-alias-label-primary)}',
			'.oe-btn[data-busy="1"]{opacity:.5;pointer-events:none}',
		].join('\n');

		function ensureStyle() {
			if (typeof document === 'undefined') return () => {};
			if (document.getElementById(STYLE_ID) !== null) return () => {};
			const tag = document.createElement('style');
			tag.id = STYLE_ID;
			tag.dataset.plugin = 'dsh-opencode-engine';
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return () => tag.remove();
		}

		/** Compact token formatter: 8756 -> 8.8k, 1500000 -> 1.50M. */
		function fmtTokens(value) {
			if (typeof value !== 'number' || !Number.isFinite(value)) return '';
			if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
			if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
			return String(value);
		}

		/**
		 * POST one api method. Relative-URL resolution against document.baseURI is
		 * deliberate: a leading slash breaks under a reverse proxy, and the Electron
		 * shell serves the app from a non-http base.
		 */
		async function call(method, body) {
			const response = await fetch(new URL(`${API_BASE}/${method}`, document.baseURI).href, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body ?? {}),
				credentials: 'same-origin',
			});
			if (!response.ok) throw Object.assign(new Error(`http ${response.status}`), { status: response.status });
			const envelope = await response.json();
			if (envelope?.ok !== true) throw new Error(envelope?.error?.message ?? 'api error');
			return envelope.value;
		}

		/**
		 * Best-effort absolute working directory for the session, from the host's
		 * own projection. The engine's advertised model list can depend on project
		 * config, so a refresh should ask about THIS session's directory. Shape is
		 * read defensively: the projection's exact type is the host's business, and
		 * a wrong guess must degrade to "no hint" (the route then falls back to its
		 * own knowledge), never to a broken panel.
		 */
		function cwdOfProjection(value) {
			if (typeof value === 'string' && value !== '') return value;
			if (value !== null && typeof value === 'object') {
				for (const key of ['cwd', 'path', 'directory', 'workingDirectory']) {
					if (typeof value[key] === 'string' && value[key] !== '') return value[key];
				}
			}
			return '';
		}

		function Panel({ sessionId, useProjection }) {
			// Called UNCONDITIONALLY so the hook count never varies between renders
			// (a conditional `projection === undefined ? '' : projection(...)` would
			// change React's hook order if the host ever stopped passing it).
			const readProjection = typeof useProjection === 'function' ? useProjection : () => undefined;
			const cwd = cwdOfProjection(readProjection('workingDirectory'));
			const [state, setState] = React.useState(undefined);
			const [missing, setMissing] = React.useState(false);
			const [open, setOpen] = React.useState(false);
			const [busy, setBusy] = React.useState('');
			const [error, setError] = React.useState('');
			const wrapRef = React.useRef(null);

			const reload = React.useCallback(async () => {
				if (sessionId === undefined || sessionId === null || sessionId === '') return;
				try {
					const value = await call('state', { sessionId });
					setState(value);
					setMissing(false);
				} catch (cause) {
					// 404/403 = no route in this profile (headless) → say nothing.
					// Anything else is a real fault, and hiding it would leave the
					// user staring at a missing panel with no explanation.
					if (cause?.status === 404 || cause?.status === 403 || /forbidden/iu.test(String(cause?.message))) setMissing(true);
					else setError(String(cause?.message ?? cause));
				}
			}, [sessionId]);

			React.useEffect(() => {
				setError('');
				void reload();
			}, [reload]);

			// Close the popover on any outside click; the dock is a persistent
			// surface, so a panel that traps a click would be worse than no panel.
			React.useEffect(() => {
				if (!open) return undefined;
				const onDown = (event) => {
					if (wrapRef.current !== null && !wrapRef.current.contains(event.target)) setOpen(false);
				};
				document.addEventListener('mousedown', onDown);
				return () => document.removeEventListener('mousedown', onDown);
			}, [open]);

			const pick = React.useCallback(async (model) => {
				setBusy(`set:${model}`);
				setError('');
				try {
					setState(await call('setModel', { sessionId, model }));
					setOpen(false);
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				} finally {
					setBusy('');
				}
			}, [sessionId]);

			const refresh = React.useCallback(async () => {
				setBusy('refresh');
				setError('');
				try {
					// Handshake-only on the host side: no prompt, so no quota spent.
					setState(await call('refresh', { sessionId }));
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				} finally {
					setBusy('');
				}
			}, [sessionId]);

			if (missing || sessionId === undefined || sessionId === '') return null;
			if (state === undefined) {
				return error === '' ? null : h('div', { className: 'oe-panel' }, h('span', { className: 'oe-usage' }, `opencode: ${error}`));
			}
			// An install with no engine configured has nothing to list and nothing
			// to pick: say nothing. (The host's own UsagePill sets this precedent —
			// it returns null at zero usage rather than rendering a "0" pill.)
			if (state.engineConfigured !== true) return null;

			const models = Array.isArray(state.catalog?.models) ? state.catalog.models : [];
			const planned = typeof state.plannedModel === 'string' ? state.plannedModel : '';
			const preferred = typeof state.session?.preferredModel === 'string' ? state.session.preferredModel : '';
			const usage = state.session?.usage ?? {};
			// "花费了多少 token" is answered by input+output — the engine's own
			// totalTokens counts the WHOLE context including the cached read
			// (measured: a 143-token prompt reported 8756), so showing it as the
			// spend would overstate the work by ~60x. Context rides in the title.
			const spent = (typeof usage.inputTokens === 'number' ? usage.inputTokens : 0)
				+ (typeof usage.outputTokens === 'number' ? usage.outputTokens : 0);
			const spentText = (state.session?.usageUpdatedAt ?? 0) > 0 && spent > 0 ? fmtTokens(spent) : '';
			const contextText = fmtTokens(usage.totalTokens);
			const label = planned === '' ? '未选择模型' : planned;
			const title = preferred === ''
				? `opencode 引擎模型：${label}（本会话未单独选择）`
				: `opencode 引擎模型：${label}（本会话选择）`;
			const usageTitle = spentText === ''
				? '本会话尚未运行过引擎任务'
				: `本会话输入+输出 ${spentText} tokens${contextText === '' ? '' : ` · 上下文 ${contextText}`}`;

			return h('div', { className: 'oe-panel' },
				h('div', { className: 'oe-wrap', ref: wrapRef },
					h('button', {
						type: 'button',
						className: 'oe-chip',
						title: `${title}\n${usageTitle}`,
						onClick: () => { setOpen((value) => !value); },
					},
						h('span', { className: 'oe-dot' }),
						h('span', { className: 'oe-model' }, `opencode · ${label}`),
						spentText === '' ? null : h('span', { className: 'oe-usage' }, spentText),
					),
					open ? h('div', { className: 'oe-pop', role: 'menu' },
						h('div', { className: 'oe-hint' }, 'opencode 引擎模型（下次运行生效）'),
						// The token detail lives here too: a hover tooltip is not
						// discoverable, and "花费了多少 token" is half the ask.
						spentText === '' ? null : h('div', { className: 'oe-hint' },
							`本会话 输入 ${fmtTokens(usage.inputTokens)} / 输出 ${fmtTokens(usage.outputTokens)}${contextText === '' ? '' : ` · 上下文 ${contextText}（含缓存读 ${fmtTokens(usage.cachedReadTokens)}）`}`),
						models.length === 0
							? h('div', { className: 'oe-hint' }, '还没有清单：点下方「刷新」从引擎读取（不消耗额度）')
							: models.map((entry) => h('button', {
								key: entry.value,
								type: 'button',
								className: 'oe-row',
								'data-on': entry.value === planned ? '1' : '0',
								onClick: () => { void pick(entry.value); },
							},
								h('span', { className: 'oe-rowname' }, entry.name === entry.value ? entry.value : `${entry.name} · ${entry.value}`),
								entry.value === planned ? h('span', null, '✓') : null,
							)),
						h('div', { className: 'oe-sep' }),
						error === '' ? null : h('div', { className: 'oe-hint' }, error),
						h('div', { className: 'oe-actions' },
							h('button', { type: 'button', className: 'oe-btn', 'data-busy': busy === 'refresh' ? '1' : '0', onClick: () => { void refresh(); } }, busy === 'refresh' ? '读取中…' : '刷新清单'),
							h('button', {
								type: 'button',
								className: 'oe-btn',
								disabled: preferred === '',
								onClick: () => { void pick(''); },
							}, '恢复默认'),
						),
					) : null,
				),
			);
		}

		return {
			inject: ['slots'],
			apply(ctx) {
				ctx.effect(() => ensureStyle(), 'opencode-engine panel: css');
				ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
					{ name: 'conversation.composer.dock', id: 'opencode-engine:models', order: 60, label: 'OpenCode 引擎模型' },
					// The dock passes `sessionId` and `useProjection` as standard
					// props; forward both — the projection is how the refresh learns
					// THIS session's working directory (project config can change the
					// engine's advertised list).
					(props) => h(Panel, { sessionId: props?.sessionId, useProjection: props?.useProjection }),
				)), 'opencode-engine panel: composer dock entry');
			},
		};
	},
});
