import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import glob from 'tiny-glob/sync.js';
import { beforeAll, describe, test } from 'vitest';
import { create, type LanguageType, type TemplateType } from '../index.ts';

// Resolve the given path relative to the current file
const resolve_path = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// use a directory outside of packages to ensure it isn't added to the pnpm workspace
const test_workspace_dir = resolve_path('../../../.test-tmp/create-svelte/');

const existing_workspace_overrides = JSON.parse(
	fs.readFileSync(resolve_path('../../../package.json'), 'utf-8')
).pnpm?.overrides;

const overrides = { ...existing_workspace_overrides };

for (const pkg_path of glob(resolve_path('../../../packages/*/package.json'))) {
	const name = JSON.parse(fs.readFileSync(pkg_path, 'utf-8')).name;
	// use `file:` protocol for opting into stricter resolve logic which catches more bugs
	overrides[name] = `file:${path.dirname(path.resolve(pkg_path))}`;
}

// prepare test pnpm workspace
fs.rmSync(test_workspace_dir, { recursive: true, force: true });
fs.mkdirSync(test_workspace_dir, { recursive: true });
const workspace = {
	name: 'svelte-check-test-fake-pnpm-workspace',
	private: true,
	version: '0.0.0',
	pnpm: { overrides },
	// convert override query "@foo/bar@>x <y" to package name @foo/bar
	devDependencies: Object.fromEntries(
		Object.entries(overrides).map(([query, range]) => [query.replace(/(@?[^@]+)@.*$/, '$1'), range])
	)
};

fs.writeFileSync(
	path.join(test_workspace_dir, 'package.json'),
	JSON.stringify(workspace, null, '\t')
);

fs.writeFileSync(path.join(test_workspace_dir, 'pnpm-workspace.yaml'), 'packages:\n  - ./*\n');

const exec_async = promisify(exec);

beforeAll(async () => {
	await exec_async('pnpm install --no-frozen-lockfile', {
		cwd: test_workspace_dir
	});
}, 60000);

function patch_package_json(pkg: any) {
	Object.entries(overrides).forEach(([key, value]) => {
		if (pkg.devDependencies?.[key]) {
			pkg.devDependencies[key] = value;
		}

		if (pkg.dependencies?.[key]) {
			pkg.dependencies[key] = value;
		}

		if (!pkg.pnpm) {
			pkg.pnpm = {};
		}

		if (!pkg.pnpm.overrides) {
			pkg.pnpm.overrides = {};
		}

		pkg.pnpm.overrides = { ...pkg.pnpm.overrides, ...overrides };
	});
	pkg.private = true;
}

/**
 * Tests in different templates can be run concurrently for a nice speedup locally, but tests within a template must be run sequentially.
 * It'd be better to group tests by template, but vitest doesn't support that yet.
 * @type {Map<string, [string, () => import('node:child_process').PromiseWithChild<any>][]>}
 */
const script_test_map = new Map();

const templates = fs.readdirSync('templates') as TemplateType[];

for (const template of templates) {
	if (template[0] === '.') continue;

	for (const types of ['checkjs', 'typescript'] as LanguageType[]) {
		const cwd = path.join(test_workspace_dir, `${template}-${types}`);
		fs.rmSync(cwd, { recursive: true, force: true });

		create(cwd, {
			name: `create-svelte-test-${template}-${types}`,
			template,
			types
		});

		const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
		patch_package_json(pkg);

		fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(pkg, null, '\t') + '\n');

		// run provided scripts that are non-blocking. All of them should exit with 0
		// package script requires lib dir
		// TODO: lint should run before format
		const scripts_to_test = ['format', 'lint', 'check', 'build', 'package'].filter(
			(s) => s in pkg.scripts
		);

		for (const script of scripts_to_test) {
			const tests = script_test_map.get(script) ?? [];
			tests.push([`${template}-${types}`, () => exec_async(`pnpm ${script}`, { cwd })]);
			script_test_map.set(script, tests);
		}
	}
}

for (const [script, tests] of script_test_map) {
	describe.concurrent(
		script,
		() => {
			for (const [name, task] of tests) {
				test(name, task);
			}
		},
		{ timeout: 60000 }
	);
}
