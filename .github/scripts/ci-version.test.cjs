const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const { readFileSync } = require("node:fs");
const { access, mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { basename, join } = require("node:path");
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

test("local mainline allocation uses supplied tags without GitHub API access", async () => {
  for (const [tags, expected] of [
    [[], "main.1"],
    [[tag("main.9"), tag("main.10")], "main.11"],
    [[tag("main.2", revision), tag("main.10")], "main.2"],
  ]) {
    const result = await determineVersion({ context, tags });
    assert.deepEqual(result, { version: expected, revision });
  }
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
  local = false,
} = {}) {
  const created = [];
  const notices = [];
  const apiCalls = [];
  const summary = {
    addHeading: () => summary, addRaw: () => summary, write: async () => {},
  };
  const github = {
    rest: {
      pulls: { get: async () => {
        apiCalls.push("pulls.get");
        return { data: pullRequest };
      } },
      git: {
        listMatchingRefs: async () => {
          apiCalls.push("git.listMatchingRefs");
          return { data: existing ? [{ ref: `refs/tags/${version}`, object: existing }] : [] };
        },
        getTag: async () => {
          apiCalls.push("git.getTag");
          return { data: { object } };
        },
        createRef: async options => {
          apiCalls.push("git.createRef");
          created.push(options);
        },
        updateRef: async () => { assert.fail("Published build tags must never be moved."); },
      },
    },
  };
  const execute = new AsyncFunction("github", "context", "core", "process",
    scriptFor("Create immutable Git tag"));
  await execute(github, ctx, {
    info: () => {}, notice: message => notices.push(message), summary,
  }, { env: { IMAGE_VERSION: version, IMAGE_REVISION: imageRevision, ACT: local ? "true" : "" } });
  return { created, notices, apiCalls };
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

test("the local image step reads and peels local tags without a GitHub token", async () => {
  for (const names of ["", "main.2\nmain.9\nmain.12-pr42.1\n"]) {
    const outputs = {};
    const notices = [];
    const commands = [];
    const execute = new AsyncFunction("require", "github", "context", "core", "process",
      scriptFor("Determine image and Git tag"));
    await execute(
      request => {
        if (request === "./.github/scripts/ci-version.cjs") return { determineVersion };
        assert.equal(request, "node:child_process");
        return {
          execFileSync: (command, args, options) => {
            assert.equal(command, "git");
            assert.deepEqual(options, { encoding: "utf8" });
            commands.push(args);
            if (args[0] === "tag") return names;
            assert.deepEqual(args.slice(0, 2), ["rev-parse", "--verify"]);
            return `${args[2] === "refs/tags/main.2^{}" ? revision : otherRevision}\n`;
          },
        };
      },
      {}, context,
      {
        setOutput: (key, value) => { outputs[key] = value; },
        info: () => {}, notice: message => notices.push(message),
      },
      { env: { ACT: "true", GITHUB_RUN_ATTEMPT: "1" } },
    );
    assert.deepEqual(outputs, { version: names ? "main.2" : "main.1", revision });
    assert.deepEqual(commands[0], ["tag", "--list", "main.*"]);
    assert.equal(commands.length, names ? 4 : 1);
    assert.equal(notices.length, 1);
  }
});

test("local tag dry runs validate mainline and PR versions without any GitHub API calls", async () => {
  for (const [version, ctx] of [
    ["main.12", context], ["main.0-pr42.1", prContext],
  ]) {
    const result = await writeTag({ version, ctx, local: true });
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.apiCalls, []);
    assert.equal(result.notices.length, 1);
    assert.match(result.notices[0], /dry run: validated Git tag/);
  }
  for (const options of [
    { version: "invalid" },
    { imageRevision: otherRevision },
    { ctx: { ...context, ref: "refs/heads/feature" } },
    { version: "main.12-pr43.1", ctx: prContext },
  ]) {
    await assert.rejects(writeTag({ ...options, local: true }), /does not match|only be created/);
  }
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

test("local workflow uploads are explicitly skipped while image export and isolation remain enabled", () => {
  for (const step of ["Upload coverage reports", "Upload image artifact"]) {
    const start = workflow.indexOf(`      - name: ${step}`);
    assert.ok(start >= 0);
    const end = workflow.indexOf("\n      - name:", start + 1);
    const upload = workflow.slice(start, end === -1 ? undefined : end);
    assert.match(upload, /if:.*env\.ACT != 'true'/);
    assert.match(upload, /uses: actions\/upload-artifact@/);
  }
  assert.match(workflow, /name: Explain local image artifact upload skip/);
  assert.match(workflow, /docker save "\$IMAGE_NAME:\$IMAGE_VERSION" "\$IMAGE_NAME:sha-\$IMAGE_REVISION"/);
  assert.match(workflow, /network_options=\(--network "container:\$\(hostname\)"\)/);
  assert.match(workflow, /"\$\{network_options\[@\]\}" \\/);
  assert.match(workflow, /CONTAINER_NAME:.*github\.event\.local_ci_run_id \|\| github\.run_id/);
  assert.match(workflow, /VOLUME_NAME:.*github\.event\.local_ci_run_id \|\| github\.run_id/);
  assert.equal((workflow.match(/github-token:.*local-act-no-github-access/g) ?? []).length, 2);
});

async function runLocalCi(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dependency-parser-local-ci "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "bin"));
  await mkdir(join(directory, ".github", "workflows"), { recursive: true });
  await writeFile(join(directory, ".github", "workflows", "ci.yml"), "");
  await writeFile(join(directory, "run-local-ci.sh"),
    readFileSync(join(__dirname, "..", "..", "run-local-ci.sh"), "utf8").replace(/\r\n/g, "\n"));
  const fixtures = {
    uname: 'printf "%s\\n" "$LOCAL_CI_TEST_OS"',
    cygpath: 'printf "%s\\n" "$2"',
    git: `
if [[ "$LOCAL_CI_TEST_BRANCH" == detached ]]; then exit 1; fi
printf '%s\\n' "$LOCAL_CI_TEST_BRANCH"
`,
    docker: `
printf 'docker %s\\n' "$*" >> "$LOCAL_CI_TEST_DIRECTORY/commands"
case "$1" in
    context) printf '%s\\n' "$LOCAL_CI_DOCKER_ENDPOINT" ;;
    info) printf '%s\\n' linux ;;
    network)
        case "$2" in
            create) exit "$LOCAL_CI_NETWORK_CREATE_STATUS" ;;
            rm) exit "$LOCAL_CI_NETWORK_REMOVE_STATUS" ;;
            *) exit 97 ;;
        esac
        ;;
    *) exit 97 ;;
esac
`,
    podman: `
printf 'podman %s\\n' "$*" >> "$LOCAL_CI_TEST_DIRECTORY/commands"
case "$1 $2" in
    "machine inspect") printf '%s\\n' stopped ;;
    "machine start"|"image exists"|"--remote --url") exit 0 ;;
    "info --format") printf '%s\\n' "$LOCAL_CI_PODMAN_SOCKET" ;;
    *) exit 97 ;;
esac
`,
    act: `
printf 'act\\n' >> "$LOCAL_CI_TEST_DIRECTORY/commands"
printf '%s\\0' "$@" > "$LOCAL_CI_TEST_DIRECTORY/act-args"
printf '%s' "$DOCKER_HOST" > "$LOCAL_CI_TEST_DIRECTORY/daemon-host"
while (( $# )); do
    if [[ "$1" == --eventpath ]]; then
        cp -- "$2" "$LOCAL_CI_TEST_DIRECTORY/event.json"
        printf '%s' "$2" > "$LOCAL_CI_TEST_DIRECTORY/event-path"
    fi
    if [[ "$1" == --network && "$2" == bridge ]]; then
        printf '%s\\n' 'Network-scoped aliases are only supported for user-defined networks.' >&2
        exit 97
    fi
    shift
done
exit "$LOCAL_CI_ACT_STATUS"
`,
  };
  await Promise.all(Object.entries(fixtures).map(([name, script]) =>
    writeFile(join(directory, "bin", name), `#!/usr/bin/env bash\nset -eu\n${script}\n`,
      { mode: 0o755 })));
  const bash = process.platform === "win32"
    ? join(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(),
      "..", "..", "..", "bin", "bash.exe")
    : "bash";
  const child = spawn(bash, ["-c", `
set -eu
if command -v cygpath >/dev/null 2>&1; then
    LOCAL_CI_TEST_DIRECTORY="$(cygpath -u "$LOCAL_CI_TEST_DIRECTORY")"
fi
export LOCAL_CI_TEST_DIRECTORY
export PATH="$LOCAL_CI_TEST_DIRECTORY/bin:$PATH"
export TMPDIR="$LOCAL_CI_TEST_DIRECTORY"
exec bash ./run-local-ci.sh
`], {
    cwd: directory,
    env: {
      ...process.env,
      DOCKER_HOST: "unix:///inherited-podman.sock",
      LOCAL_CI_TEST_DIRECTORY: directory,
      LOCAL_CI_TEST_OS: options.os ?? "Linux",
      LOCAL_CI_TEST_BRANCH: options.branch ?? 'feature/"local-ci',
      LOCAL_CI_DOCKER_ENDPOINT: options.endpoint ?? "unix:///custom/docker.sock",
      LOCAL_CI_PODMAN_SOCKET: options.socket ?? "unix:///run/user/1000/podman/podman.sock",
      LOCAL_CI_ACT_STATUS: String(options.status ?? 0),
      LOCAL_CI_NETWORK_CREATE_STATUS: String(options.networkCreateStatus ?? 0),
      LOCAL_CI_NETWORK_REMOVE_STATUS: String(options.networkRemoveStatus ?? 0),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.stdin.end(`${options.engine ?? "docker"}\n`);
  const [code, signal] = await once(child, "close");
  assert.equal(signal, null, output);
  return { directory, code, output };
}

test("the launcher runs the full pipeline with engine sockets on Linux and Windows", {
  timeout: 30_000,
}, async t => {
  for (const os of ["Linux", "MINGW64_NT-10.0"]) {
    for (const engine of ["docker", "podman"]) {
      await t.test(`${os} ${engine}`, async t => {
        const endpoint = os === "Linux" ? "unix:///custom/docker.sock" : "npipe:////./pipe/docker_engine";
        const { directory, code, output } = await runLocalCi(t, { os, engine, endpoint });
        assert.equal(code, 0, output);
        const args = (await readFile(join(directory, "act-args"), "utf8")).split("\0").slice(0, -1);
        const argument = name => args[args.indexOf(name) + 1];
        assert.equal(args[0], "workflow_dispatch");
        assert.equal(args.includes("--job"), false);
        assert.equal(argument("--workflows"), ".github/workflows/ci.yml");
        assert.equal(argument("--defaultbranch"), 'feature/"local-ci');
        assert.ok(args.includes("--network"));
        const network = argument("--network");
        if (engine === "docker") {
          assert.match(network, /^dependency-parser-ci-local-\d+-\d+$/);
        } else {
          assert.equal(network, "podman");
        }
        assert.equal(argument("--container-daemon-socket"), engine === "podman"
          ? "/run/user/1000/podman/podman.sock"
          : os === "Linux" ? "/custom/docker.sock" : "/var/run/docker.sock");
        assert.ok(args.includes("DOCKER_HOST=unix:///var/run/docker.sock"));
        assert.ok(args.includes("ACT=true"));
        assert.equal(args.includes("DOCKER_BUILDKIT=0"), engine === "podman");
        assert.ok(args.includes(`--pull=${engine === "docker"}`));
        const event = JSON.parse(await readFile(join(directory, "event.json"), "utf8"));
        assert.equal(event.ref, 'refs/heads/feature/"local-ci');
        assert.equal(event.repository.default_branch, 'feature/"local-ci');
        assert.match(event.local_ci_run_id, /^local-\d+-\d+$/);
        const eventPath = await readFile(join(directory, "event-path"), "utf8");
        await assert.rejects(access(join(directory, basename(eventPath))), { code: "ENOENT" });
        const daemon = await readFile(join(directory, "daemon-host"), "utf8");
        assert.equal(daemon, engine === "docker" ? endpoint : os === "Linux"
          ? "unix:///run/user/1000/podman/podman.sock" : "npipe:////./pipe/podman-machine-default");
        const commands = await readFile(join(directory, "commands"), "utf8");
        if (engine === "docker") {
          assert.equal(network, `dependency-parser-ci-${event.local_ci_run_id}`);
          assert.ok(commands.endsWith(
            `docker network create --driver bridge ${network}\nact\ndocker network rm ${network}\n`,
          ), commands);
        } else {
          assert.doesNotMatch(commands, /network create|network rm/);
        }
        if (os !== "Linux" && engine === "podman") {
          assert.match(commands, /podman machine start podman-machine-default/);
        }
      });
    }
  }
});

test("the launcher propagates act failures, cleans its event file, and rejects invalid setup", {
  timeout: 30_000,
}, async t => {
  const failed = await runLocalCi(t, { status: 17 });
  assert.equal(failed.code, 17, failed.output);
  const eventPath = await readFile(join(failed.directory, "event-path"), "utf8");
  await assert.rejects(access(join(failed.directory, basename(eventPath))), { code: "ENOENT" });
  assert.match(await readFile(join(failed.directory, "commands"), "utf8"),
    /act\ndocker network rm dependency-parser-ci-local-\d+-\d+\n$/);
  for (const options of [
    { engine: "podman", socket: "not-an-absolute-socket" },
    { branch: "detached" },
  ]) {
    const result = await runLocalCi(t, options);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Cannot resolve the Podman API socket|detached HEAD is not supported/);
    await assert.rejects(access(join(result.directory, "act-args")), { code: "ENOENT" });
  }
});

test("the launcher reports Docker network failures without hiding an act failure", {
  timeout: 30_000,
}, async t => {
  const creation = await runLocalCi(t, { networkCreateStatus: 41 });
  assert.equal(creation.code, 1, creation.output);
  assert.match(creation.output, /Cannot create local CI Docker network/);
  await assert.rejects(access(join(creation.directory, "act-args")), { code: "ENOENT" });
  assert.doesNotMatch(await readFile(join(creation.directory, "commands"), "utf8"), /network rm/);

  for (const status of [0, 17]) {
    const removal = await runLocalCi(t, { status, networkRemoveStatus: 42 });
    assert.equal(removal.code, status || 1, removal.output);
    assert.match(removal.output, /Could not remove local CI Docker network/);
    const eventPath = await readFile(join(removal.directory, "event-path"), "utf8");
    await assert.rejects(access(join(removal.directory, basename(eventPath))), { code: "ENOENT" });
  }
});

test("the startup probe bounds retries and validates only the completed health response", () => {
  assert.match(workflow, /--max-time 5/);
  assert.match(workflow, /--retry 30 --retry-all-errors --retry-delay 2 --retry-max-time 60/);
  assert.match(workflow, /--output "\$RUNNER_TEMP\/health\.json"/);
  assert.match(workflow, /jq --exit-status '\. == \{"status":"ok"\}' "\$RUNNER_TEMP\/health\.json"/);
  assert.doesNotMatch(workflow, /"\$base_url\/api\/health" \|/);
});

test("the startup probe recovers from transport failures but still fails when unavailable", {
  timeout: 15_000,
}, async t => {
  const match = / {12}curl ([\s\S]*?)(?:--output|"\$base_url\/api\/health")/.exec(workflow);
  assert.ok(match, "Missing container health probe.");
  const probeOptions = match[1].replace(/\\\r?\n\s*/g, " ").trim().split(/\s+/);
  const fastRetrySettings = [
    "--max-time", "2", "--retry", "1", "--retry-delay", "1", "--retry-max-time", "3",
  ];

  for (const scenario of [
    { name: "connection reset followed by readiness", partial: false, unavailable: false },
    { name: "partial response followed by readiness", partial: true, unavailable: false },
    { name: "persistent connection resets", partial: false, unavailable: true },
  ]) {
    await t.test(scenario.name, async t => {
      const directory = await mkdtemp(join(tmpdir(), "dependency-parser-health-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const responseFile = join(directory, "health.json");
      let requests = 0;
      const server = createServer((request, response) => {
        requests += 1;
        if (requests === 1 || scenario.unavailable) {
          if (scenario.partial) {
            response.writeHead(200, { "content-length": "100" });
            response.write('{"status":"starting', () => request.socket.end());
          } else {
            request.socket.resetAndDestroy();
          }
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ok"}');
      });
      t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const url = `http://127.0.0.1:${server.address().port}/api/health`;
      const child = spawn("curl", [
        ...probeOptions, ...fastRetrySettings, "--noproxy", "*",
        "--output", responseFile, url,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => { stderr += chunk; });
      const [code, signal] = await once(child, "close");
      assert.equal(signal, null, stderr);
      assert.equal(requests, 2, stderr);
      if (scenario.unavailable) {
        assert.notEqual(code, 0, "An unavailable container must fail the probe.");
      } else {
        assert.equal(code, 0, stderr);
        assert.deepEqual(JSON.parse(await readFile(responseFile, "utf8")), { status: "ok" });
      }
    });
  }
});
