/**
 * Session change-boundary plumbing for watchdog_diff.
 *
 * The boundary is the git HEAD captured when the session starts. Everything
 * between that commit and the current working tree (staged, unstaged, and
 * commits made during the session) plus untracked paths belongs to
 * "this session's change set" as far as reviewers are concerned.
 *
 * All commands run through execFile with argument arrays — no shell, so
 * user-supplied paths cannot inject anything. A trailing "--" pathspec
 * separator prevents option injection.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** git's well-known empty tree object; stands in for HEAD in a repo with no commits yet. */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const MAX_UNTRACKED = 200;
const MAX_COMMITS = 10;
const MAX_DIFF_CHARS = 48_000;

export interface BaseResolution {
	ok: boolean;
	/** HEAD at capture time, or the empty tree SHA when the repo has no commits. */
	base?: string;
	reason?: string;
}

export interface SessionDiffOptions {
	path?: string;
	stat?: boolean;
}

export interface SessionDiffResult {
	ok: boolean;
	text: string;
	base?: string;
	untrackedCount?: number;
	commitsSince?: number;
	truncated?: boolean;
}

function toMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

interface RunOutcome {
	ok: boolean;
	stdout: string;
	stderr: string;
}

async function safeRun(cwd: string, args: string[]): Promise<RunOutcome> {
	try {
		const { stdout, stderr } = await run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
		return { ok: true, stdout, stderr };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string };
		return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? toMessage(err) };
	}
}

/** Capture the session baseline. Fails when cwd is not inside a git work tree. */
export async function captureBase(cwd: string): Promise<BaseResolution> {
	const inside = await safeRun(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (!inside.ok || inside.stdout.trim() !== "true") {
		return { ok: false, reason: "not a git repository (or git is unavailable)" };
	}
	const head = await safeRun(cwd, ["rev-parse", "HEAD"]);
	if (!head.ok) {
		// Repo with no commits yet: diff everything against the empty tree.
		return { ok: true, base: EMPTY_TREE_SHA };
	}
	return { ok: true, base: head.stdout.trim() };
}

/**
 * Build the model-facing report for the session change set.
 * base is captured at session start; the diff base..worktree inherently
 * includes commits made after the session started.
 */
export async function sessionDiff(
	cwd: string,
	base: string,
	opts: SessionDiffOptions = {},
): Promise<SessionDiffResult> {
	const sections: string[] = [];
	let truncated = false;
	const pathspec = opts.path ? ["--", opts.path] : [];

	// Commits made during the session (responsibility timeline).
	const countRun = await safeRun(cwd, ["rev-list", "--count", `${base}..HEAD`, ...pathspec]);
	const parsed = Number.parseInt(countRun.stdout.trim(), 10);
	const commitCount = Number.isFinite(parsed) ? parsed : -1;
	sections.push(`Session base: ${base === EMPTY_TREE_SHA ? `${base} (empty tree, repo had no commits)` : base}`);
	if (commitCount >= 0) {
		sections.push(`Commits since base: ${commitCount}`);
		if (commitCount > 0) {
			const logRun = await safeRun(cwd, [
				"log",
				"--oneline",
				"--no-decorate",
				"-n",
				String(MAX_COMMITS),
				`${base}..HEAD`,
				...pathspec,
			]);
			sections.push(logRun.stdout.trim());
		}
	}

	// The diff itself.
	const diffArgs = ["diff", base];
	if (opts.stat) diffArgs.push("--stat");
	diffArgs.push("--");
	if (opts.path) diffArgs.push(opts.path);
	const diffRun = await safeRun(cwd, diffArgs);
	if (!diffRun.ok) {
		sections.push(`[git diff failed: ${diffRun.stderr.trim()}]`);
	} else {
		const body = diffRun.stdout;
		if (body.trim().length === 0) {
			sections.push("(no tracked changes vs session base)");
		} else if (body.length > MAX_DIFF_CHARS) {
			sections.push(body.slice(0, MAX_DIFF_CHARS) + "\n… [diff truncated, use path to narrow]");
			truncated = true;
		} else {
			sections.push(body);
		}
	}

	// Untracked paths: part of the change set, inspect with read.
	const untrackedRun = await safeRun(cwd, ["ls-files", "--others", "--exclude-standard", ...pathspec]);
	const untracked = untrackedRun.stdout.split("\n").filter((line) => line.trim().length > 0);
	const untrackedSection =
		untracked.length === 0
			? "Untracked: none"
			: `Untracked (${untracked.length}, inspect with read):` +
				"\n" +
				untracked
					.slice(0, MAX_UNTRACKED)
					.map((line) => `  ${line}`)
					.join("\n") +
				(untracked.length > MAX_UNTRACKED ? `\n  … ${untracked.length - MAX_UNTRACKED} more` : "");
	sections.push(untrackedSection);

	return {
		ok: true,
		text: sections.join("\n\n"),
		base,
		untrackedCount: untracked.length,
		commitsSince: commitCount >= 0 ? commitCount : undefined,
		truncated,
	};
}
