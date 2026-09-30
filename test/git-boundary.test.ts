/**
 * Tests for the git-boundary plumbing. Each test builds a throwaway repo and
 * simulates a session: capture base -> edit -> (optionally commit) -> report.
 * Run: node --test test/
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

import { captureBase, sessionDiff, EMPTY_TREE_SHA } from "../src/git-boundary.ts";

let repo: string;

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function commitAll(message: string): void {
	git("add", "-A");
	git("-c", "user.email=test@test", "-c", "user.name=test", "commit", "-m", message);
}

before(() => {
	repo = mkdtempSync(join(tmpdir(), "watchdog-diff-test-"));
	git("init", "-q");
	writeFileSync(join(repo, "a.txt"), "one\n");
	commitAll("initial");
});

after(() => {
	rmSync(repo, { recursive: true, force: true });
});

test("captureBase returns HEAD in a repo with commits", async () => {
	const base = await captureBase(repo);
	const head = git("rev-parse", "HEAD").trim();
	assert.equal(base.base, head);
});

test("captureBase uses empty tree in a repo without commits", async () => {
	const empty = mkdtempSync(join(tmpdir(), "watchdog-diff-empty-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: empty });
		const resolved = await captureBase(empty);
		assert.equal(resolved.ok, true);
		assert.equal(resolved.base, EMPTY_TREE_SHA);
	} finally {
		rmSync(empty, { recursive: true, force: true });
	}
});

test("captureBase fails outside a git repo", async () => {
	const plain = mkdtempSync(join(tmpdir(), "watchdog-diff-plain-"));
	try {
		const resolved = await captureBase(plain);
		assert.equal(resolved.ok, false);
	} finally {
		rmSync(plain, { recursive: true, force: true });
	}
});

test("sessionDiff reports uncommitted work and untracked files", async () => {
	const base = (await captureBase(repo)).base!;
	writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
	writeFileSync(join(repo, "new.txt"), "untracked\n");
	const result = await sessionDiff(repo, base);
	assert.equal(result.ok, true);
	assert.match(result.text, /Commits since base: 0/);
	assert.match(result.text, /\+two/);
	assert.match(result.text, /Untracked \(1/);
	assert.match(result.text, /new\.txt/);
	assert.equal(result.untrackedCount, 1);
});

test("sessionDiff includes commits made after the base", async () => {
	const base = (await captureBase(repo)).base!;
	writeFileSync(join(repo, "b.txt"), "committed during session\n");
	commitAll("during session");
	const result = await sessionDiff(repo, base);
	assert.equal(result.commitsSince, 1);
	assert.match(result.text, /during session/);
	assert.match(result.text, /b\.txt/);
});

test("sessionDiff stat mode omits the patch body", async () => {
	const base = (await captureBase(repo)).base!;
	writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
	const result = await sessionDiff(repo, base, { stat: true });
	assert.ok(!result.text.includes("@@"));
	assert.match(result.text, /a\.txt/);
});

test("sessionDiff path filter scopes commits, diff, and untracked", async () => {
	const base = (await captureBase(repo)).base!;
	writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\nfour\n");
	writeFileSync(join(repo, "c.txt"), "scoped\n");
	const result = await sessionDiff(repo, base, { path: "c.txt" });
	assert.equal(result.commitsSince, 0);
	assert.ok(!result.text.includes("+four"));
	assert.match(result.text, /Untracked \(1/);
	assert.match(result.text, /c\.txt/);
});

test("sessionDiff is clean when nothing changed", async () => {
	commitAll("settle"); // fold leftovers from earlier tests into HEAD first
	const base = (await captureBase(repo)).base!; // baseline AFTER the tree is settled
	const result = await sessionDiff(repo, base);
	assert.equal(result.commitsSince, 0);
	assert.match(result.text, /\(no tracked changes vs session base\)/);
	assert.match(result.text, /Untracked: none/);
});

test("sessionDiff in a subdirectory resolves against the repo", async () => {
	const base = (await captureBase(repo)).base!;
	const subdir = join(repo, "nested");
	mkdirSync(subdir, { recursive: true });
	writeFileSync(join(subdir, "d.txt"), "nested\n");
	const result = await sessionDiff(subdir, base);
	assert.match(result.text, /nested\/d\.txt|d\.txt/);
});
