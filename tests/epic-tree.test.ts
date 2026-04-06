import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const epicTreeSource = readFileSync(
	resolve(import.meta.dir, "../src/client/components/epic-tree.ts"),
	"utf-8",
);

const cssSource = readFileSync(resolve(import.meta.dir, "../public/style.css"), "utf-8");

describe("epic tree node info row", () => {
	test("NODE_HEIGHT is 78px", () => {
		expect(epicTreeSource).toContain("NODE_HEIGHT = 78");
	});

	test("ROW_HEIGHT is 88px", () => {
		expect(epicTreeSource).toContain("ROW_HEIGHT = 88");
	});

	test("renderTreeNode creates tree-node-info element", () => {
		expect(epicTreeSource).toContain("tree-node-info");
	});

	test("renderTreeNode imports formatTimer from workflow-cards", () => {
		expect(epicTreeSource).toContain("formatTimer");
		expect(epicTreeSource).toMatch(/import.*formatTimer.*from.*workflow-cards/);
	});

	test("renderTreeNode adds data-active-work-ms attribute for timer updates", () => {
		expect(epicTreeSource).toContain("activeWorkMs");
		expect(epicTreeSource).toContain("activeWorkStartedAt");
	});

	test("CSS includes .tree-node-info styles", () => {
		expect(cssSource).toContain(".tree-node-info");
	});
});
