const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { determineVersion } = require("./ci-version.cjs");

const workflow = readFileSync(join(__dirname, "..", "workflows", "ci.yml"), "utf8");
const revision = "a".repeat(40);
const otherRevision = "b".repeat(40);
const repo = { owner: "example", repo: "dependency-parser" };
const context = {
  repo, sha: revision, ref: "refs/heads/main", eventName: "push", runId: 102,
  payload: { repository: { default_branch: "main" } },
};
const prContext = {
  ...context, eventName: "pull_request", ref: "refs/pull/42/merge",
  payload: { ...context.payload, pull_request: { number: 42 } },
};

function run(id, overrides = {}) {
  const timestamp = `2026-11-04T09:${String(id - 100).padStart(2, "0")}:00Z`;
  return {
    id, workflow_id: 7, event: "pull_request", display_title: "CI PR 42",
    run_attempt: 1, created_at: timestamp, run_started_at: timestamp, pull_requests: [],
    ...overrides,
  };
}

function mockGitHub({ tags = [], current = run(102), runs = [current], attempts = {} } = {}) {
  const calls = [];
  const listTags = () => {};
  const listWorkflowRuns = () => {};
  return {
    calls,
    rest: {
      repos: { listTags },
      actions: {
        listWorkflowRuns,
        getWorkflowRun: async options => {
          assert.deepEqual(options, { ...repo, run_id: context.runId });
          return { data: current };
        },
        getWorkflowRunAttempt: async options => {
          calls.push(options);
          const data = attempts[`${options.run_id}.${options.attempt_number}`];
          assert.ok(data, `Unexpected attempt request: ${JSON.stringify(options)}`);
          return { data };
        },
      },
    },
    paginate: async (method, options) => {
      if (method === listTags) {
        assert.deepEqual(options, { ...repo, per_page: 100 });
        return tags;
      }
      assert.equal(method, listWorkflowRuns);
      assert.deepEqual(options, { ...repo, workflow_id: 7, per_page: 100 });
      return runs;
    },
  };
}

function versionFor(options = {}, overrides = {}) {
  return determineVersion({
    github: mockGitHub(options), context, runAttempt: 1, ...overrides,
  });
}

function tag(name, sha = otherRevision) {
  return { name, commit: { sha } };
}

test("mainline starts at main.1 and ignores semantic release and invalid tags", async () => {
  const result = await versionFor({ tags: [tag("9.8.7"), tag("v10.0.0"), tag("main.0")] });
  assert.deepEqual(result, { version: "main.1", revision });
});

test("mainline allocates numerically and does not count PR tags", async () => {
  const result = await versionFor({
    tags: [tag("main.9"), tag("main.10"), tag("main.999-pr42.1"), tag("main.011")],
  });
  assert.equal(result.version, "main.11");
});

test("mainline reruns reuse the highest build tag already attached to the commit", async () => {
  const result = await versionFor({
    tags: [tag("main.2", revision), tag("main.9"), tag("main.3", revision)],
  });
  assert.equal(result.version, "main.3");
});

test("mainline counters retain arbitrary integer precision", async () => {
  const result = await versionFor({ tags: [tag("main.9007199254740993")] });
  assert.equal(result.version, "main.9007199254740994");
});

test("the main prefix is independent of the default branch name", async () => {
  const result = await versionFor({}, {
    context: {
      ...context, eventName: "workflow_dispatch", ref: "refs/heads/trunk",
      payload: { repository: { default_branch: "trunk" } },
    },
  });
  assert.equal(result.version, "main.1");
});

test("other branches cannot allocate mainline tags", async () => {
  await assert.rejects(versionFor({}, {
    context: { ...context, ref: "refs/heads/feature" },
  }), /only be allocated on the default branch/);
});

test("a first PR build uses main.0 before any mainline build tag exists", async () => {
  const result = await versionFor({}, { context: prContext });
  assert.equal(result.version, "main.0-pr42.1");
});

test("PR builds use the latest main tag and a per-PR attempt sequence, including forks", async () => {
  const result = await versionFor({
    tags: [tag("main.12"), tag("9.8.7")],
    runs: [
      run(101, { run_attempt: 2 }),
      run(102),
      run(100, { display_title: "CI PR 43", run_attempt: 10 }),
      run(100, { event: "push", display_title: "CI PR 42" }),
    ],
  }, { context: prContext });
  assert.equal(result.version, "main.12-pr42.3");
});

test("queued newer runs do not consume an earlier run's PR sequence", async () => {
  const result = await versionFor({ runs: [run(103), run(102)] }, { context: prContext });
  assert.equal(result.version, "main.0-pr42.1");
});

test("rerunning an older workflow after a newer PR commit gets a new sequence", async () => {
  const current = run(102, { run_attempt: 2, run_started_at: "2026-11-04T09:05:00Z" });
  const result = await versionFor({
    current, runs: [run(103), current],
  }, { context: prContext, runAttempt: 2 });
  assert.equal(result.version, "main.0-pr42.3");
});

test("historical reruns after the current attempt are excluded without losing earlier attempts", async () => {
  const github = mockGitHub({
    runs: [
      run(102),
      run(101, { run_attempt: 3, run_started_at: "2026-11-04T09:05:00Z" }),
    ],
    attempts: {
      "101.2": run(101, { run_attempt: 2, run_started_at: "2026-11-04T09:01:30Z" }),
    },
  });
  const result = await determineVersion({ github, context: prContext, runAttempt: 1 });
  assert.equal(result.version, "main.0-pr42.3");
  assert.deepEqual(github.calls, [{ ...repo, run_id: 101, attempt_number: 2 }]);
});

test("attempts sharing a timestamp are ordered consistently by run ID", async () => {
  const result = await versionFor({
    runs: [
      run(103, { created_at: run(102).created_at }),
      run(101, { created_at: run(102).created_at }),
      run(102),
    ],
  }, { context: prContext });
  assert.equal(result.version, "main.0-pr42.2");
});

test("PR counters continue across mainline changes and missing historical runs", async () => {
  const result = await versionFor({
    tags: [tag("main.12"), tag("main.10-pr42.9007199254740993"), tag("main.12-pr43.99")],
  }, { context: prContext });
  assert.equal(result.version, "main.12-pr42.9007199254740994");
});

test("missing or inconsistent Actions metadata fails explicitly", async () => {
  for (const current of [
    run(102, { display_title: "Unrelated workflow" }),
    run(102, { run_attempt: 2 }),
    run(102, { event: "push" }),
    run(103),
  ]) {
    await assert.rejects(versionFor({ current }, { context: prContext }), /metadata does not match/);
  }
  await assert.rejects(versionFor({ runs: [] }, { context: prContext }), /missing from Actions history/);
  await assert.rejects(versionFor({}, { context: prContext, runAttempt: 0 }), /positive safe integers/);
  await assert.rejects(versionFor({
    current: run(102, { created_at: "invalid" }),
  }, { context: prContext }), /timestamps are missing or invalid/);
});

test("generated image tags respect Docker's 128-character limit", async () => {
  const version = `main.${"1".repeat(123)}`;
  const result = await versionFor({ tags: [tag(version, revision)] });
  assert.equal(result.version.length, 128);
  await assert.rejects(versionFor({ tags: [tag(`${version}1`, revision)] }), /128-character/);
});

function scriptFor(stepName) {
  const start = workflow.indexOf(`      - name: ${stepName}`);
  assert.ok(start >= 0, `Missing workflow step: ${stepName}`);
  const match = /^ {10}script: \|\r?\n((?: {12}[^\r\n]*(?:\r?\n|$)|\r?\n)*)/m.exec(
    workflow.slice(start),
  );
  assert.ok(match, `Missing inline script: ${stepName}`);
  return match[1].replace(/^ {12}/gm, "");
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function writeTag({
  version = "main.12", ctx = context, imageRevision = revision,
  existing, object = { type: "commit", sha: revision },
  pullRequest = { state: "open", merge_commit_sha: revision },
} = {}) {
  const created = [];
  const notices = [];
  const summary = {
    addHeading: () => summary, addRaw: () => summary, write: async () => {},
  };
  const github = {
    rest: {
      pulls: { get: async () => ({ data: pullRequest }) },
      git: {
        listMatchingRefs: async () => ({
          data: existing ? [{ ref: `refs/tags/${version}`, object: existing }] : [],
        }),
        getTag: async () => ({ data: { object } }),
        createRef: async options => { created.push(options); },
        updateRef: async () => { assert.fail("Published build tags must never be moved."); },
      },
    },
  };
  const execute = new AsyncFunction("github", "context", "core", "process",
    scriptFor("Create immutable Git tag"));
  await execute(github, ctx, {
    info: () => {}, notice: message => notices.push(message), summary,
  }, { env: { IMAGE_VERSION: version, IMAGE_REVISION: imageRevision } });
  return { created, notices };
}

test("the image step wires the tested allocator to version and revision outputs", async () => {
  const outputs = {};
  const execute = new AsyncFunction("require", "github", "context", "core", "process",
    scriptFor("Determine image and Git tag"));
  await execute(
    request => {
      assert.equal(request, "./.github/scripts/ci-version.cjs");
      return { determineVersion };
    },
    mockGitHub(), prContext,
    { setOutput: (key, value) => { outputs[key] = value; }, info: () => {} },
    { env: { GITHUB_RUN_ATTEMPT: "1" } },
  );
  assert.deepEqual(outputs, { version: "main.0-pr42.1", revision });
});

test("the tag job creates mainline and PR build tags, not semantic releases", async () => {
  for (const [version, ctx] of [
    ["main.12", context],
    ["main.12-pr42.3", prContext],
    ["main.0-pr42.1", prContext],
    [`main.${"1".repeat(123)}`, context],
  ]) {
    const result = await writeTag({ version, ctx });
    assert.deepEqual(result.created, [{ ...repo, ref: `refs/tags/${version}`, sha: revision }]);
  }
});

test("the tag job rejects invalid names, wrong PRs, branch/revision mismatches and release tags", async () => {
  for (const options of [
    { version: "1.4.0" },
    { version: "v1.4.0" },
    { version: "main.0" },
    { version: "main.01" },
    { version: "main.12-pr42.0", ctx: prContext },
    { version: "main.12-pr43.1", ctx: prContext },
    { version: "main.12", ctx: prContext },
    { version: "main.12-pr42.1" },
    { ctx: { ...context, ref: "refs/heads/feature" } },
    { imageRevision: otherRevision },
    { version: `main.${"9".repeat(124)}` },
  ]) {
    await assert.rejects(writeTag(options), /does not match|only be created/);
  }
});

test("tag-only reruns are idempotent, including existing annotated tags", async () => {
  for (const existing of [
    { type: "commit", sha: revision },
    { type: "tag", sha: otherRevision },
  ]) {
    const result = await writeTag({ existing });
    assert.deepEqual(result.created, []);
  }
});

test("neither mainline nor PR build tags can be moved to another commit", async () => {
  for (const [version, ctx] of [
    ["main.12", context], ["main.12-pr42.1", prContext],
  ]) {
    await assert.rejects(writeTag({
      version, ctx, existing: { type: "commit", sha: otherRevision },
    }), /Refusing to move immutable build tag/);
  }
});

test("closed or superseded PRs do not get tags from an older run", async () => {
  for (const pullRequest of [
    { state: "closed", merge_commit_sha: revision },
    { state: "open", merge_commit_sha: otherRevision },
  ]) {
    const result = await writeTag({ version: "main.12-pr42.1", ctx: prContext, pullRequest });
    assert.deepEqual(result.created, []);
    assert.equal(result.notices.length, 1);
  }
});

test("workflow permissions keep fork builds read-only and the write job isolated", () => {
  assert.match(workflow, /run-name:.*format\('CI PR \{0\}', github\.event\.pull_request\.number\)/);
  assert.match(workflow, /\npermissions:\r?\n {2}contents: read\r?\n/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  const imageJob = workflow.slice(workflow.indexOf("\n  image:"), workflow.indexOf("\n  tag:"));
  assert.match(imageJob, /permissions:\r?\n {6}contents: read\r?\n {6}actions: read/);
  const tagJob = workflow.slice(workflow.indexOf("\n  tag:"));
  assert.match(tagJob, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.equal((workflow.match(/contents: write/g) ?? []).length, 1);
  assert.doesNotMatch(tagJob, /actions\/checkout|require\(|updateRef|force: true/);
  assert.match(workflow, /run: npm run test:ci-workflow/);
});
