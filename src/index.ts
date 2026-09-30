/**
 * watchdog-diff — session change-boundary tool for pi.
 *
 * Registers one read-only tool, `watchdog_diff`:
 * - On session_start, captures git HEAD as this session's change boundary.
 * - watchdog_diff reports the diff from that boundary to the current working
 *   tree (staged, unstaged, and commits made during the session) plus
 *   untracked paths, so a reviewer (or the main agent) can see exactly what
 *   this session changed and attribute problems to it.
 *
 * Parameters mirror the original pi-subagents tool: `path` to narrow the diff,
 * `stat` for a diffstat-only summary. Changes that were committed before the
 * session started are out of scope by design.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { captureBase, sessionDiff } from "./git-boundary.js";

const WatchdogDiffParams = Type.Object({
	path: Type.Optional(
		Type.String({ description: "Limit the report to this file or directory path (relative to the repo root)." }),
	),
	stat: Type.Optional(
		Type.Boolean({ description: "Return only a diffstat summary instead of the full diff." }),
	),
});

export default function (pi: ExtensionAPI) {
	let base: string | undefined;
	let baseNote: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		base = undefined;
		baseNote = undefined;
		const resolved = await captureBase(ctx.cwd);
		if (resolved.ok && resolved.base) {
			base = resolved.base;
		} else {
			baseNote = resolved.reason ?? "git baseline unavailable";
		}
	});

	pi.registerTool({
		name: "watchdog_diff",
		label: "Session Diff",
		description:
			"Show this session's change boundary in git: the diff from the commit captured at session start " +
			"to the current working tree (includes commits made during the session) plus untracked paths. " +
			"Use it to review what changed in this session or attribute a problem to it. " +
			"Changes committed before the session started are out of scope. Optional `path` narrows the report, " +
			"`stat: true` returns only a diffstat summary.",
		parameters: WatchdogDiffParams,
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!base) {
				// session_start missed (e.g. extension loaded mid-session): fall back to
				// current HEAD so the tool stays usable, and say so.
				const resolved = await captureBase(ctx.cwd);
				if (!resolved.ok || !resolved.base) {
					const text = `watchdog_diff unavailable: ${resolved.reason ?? "no git baseline"}`;
					return { content: [{ type: "text", text }], details: undefined };
				}
				base = resolved.base;
				baseNote = "baseline lazily captured at first call (session start was missed)";
			}

			const result = await sessionDiff(ctx.cwd, base, { path: params.path, stat: params.stat });
			const text = (baseNote ? `${baseNote}\n\n` : "") + result.text;
			return {
				content: [{ type: "text", text }],
				details: {
					base: result.base,
					untrackedCount: result.untrackedCount,
					commitsSince: result.commitsSince,
					truncated: result.truncated,
				},
			};
		},
	});
}
