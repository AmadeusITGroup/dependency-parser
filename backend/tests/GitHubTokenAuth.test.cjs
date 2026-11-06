const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { buildGitHubToken } = require("../dist/config/app.config");
const gitAdapter = require("../dist/infrastructure/git/GitCliClient");
const { GitCliClient } = gitAdapter;
const { createServer } = require("../dist/interfaces/http/server");
const { logger } = require("../dist/utils/logger");

const token = "fixture-token-not-a-real-credential";
const encodedCredentials = Buffer.from(`x-access-token:${token}`).toString("base64");
const authorization = `AUTHORIZATION: basic ${encodedCredentials}`;
const headerKey = "http.https://github.com/.extraHeader";

async function createGitFixture(context, githubToken, extraEnvironment = {}, gitBinary = "git") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dependency-parser-github-auth-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const globalConfig = path.join(directory, "global.config");
  await writeFile(globalConfig, "");
  const environment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_COUNT: "0",
    ...extraEnvironment,
  };
  for (const key of [
    "GITHUB_TOKEN", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR",
  ]) {
    delete environment[key];
  }
  const client = new GitCliClient(gitBinary, 4, githubToken);
  const buildEnvironment = client.buildGitEnvironment.bind(client);
  context.mock.method(client, "buildGitEnvironment", () => buildEnvironment(environment));
  return { client, directory, globalConfig };
}

test("GitHub token configuration is optional, trimmed, and rejects embedded whitespace and controls", () => {
  for (const value of [undefined, "", " \t\n "]) {
    assert.equal(buildGitHubToken({ GITHUB_TOKEN: value }), undefined);
  }
  assert.equal(buildGitHubToken({ GITHUB_TOKEN: ` ${token} ` }), token);
  for (const value of ["token value", "token\nvalue", "token\u0000value", "token\u007fvalue"]) {
    assert.throws(() => buildGitHubToken({ GITHUB_TOKEN: value }), error => {
      assert.match(error.message, /GITHUB_TOKEN/);
      assert.ok(!error.message.includes(value));
      return true;
    });
  }
});

for (const [name, configuredToken] of [
  ["configured", ` ${token} `],
  ["unset", undefined],
  ["blank", " \t "],
]) {
  test(`server reports GitHub authentication mode without logging credentials (${name} token)`, async context => {
    const expectedToken = name === "configured" ? token : undefined;
    const environment = {
      DATASTORE: "memory",
      DEPENDENCY_SCAN_ENABLED: "false",
      DEPENDENCY_RESOLUTION_RETRIES: "0",
      GIT_MAX_CONCURRENCY: "2",
      GITHUB_TOKEN: configuredToken,
    };
    const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
    const constructor = context.mock.method(gitAdapter, "GitCliClient", function (...args) {
      return new GitCliClient(...args);
    });
    const info = context.mock.method(logger, "info", () => {});
    try {
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const app = await createServer();
      try {
        assert.deepEqual(constructor.mock.calls[0].arguments, ["git", 2, expectedToken]);
        assert.equal(info.mock.calls[0].arguments[0].githubTokenConfigured, Boolean(expectedToken));
        assert.deepEqual(info.mock.calls[1].arguments, [expectedToken
          ? "GitHub HTTPS authentication: using GITHUB_TOKEN."
          : "GitHub HTTPS authentication: using default Git authentication (GITHUB_TOKEN is not configured)."]);
        const logged = JSON.stringify(info.mock.calls.map(call => call.arguments));
        assert.ok(!logged.includes(token));
        assert.ok(!logged.includes(encodedCredentials));
      } finally {
        await app.locals.closeDataStore();
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}

test("GitHub authentication appends scoped process configuration without mutating inherited settings", () => {
  const environment = {
    PATH: "fixture-path",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://example.com/.extraHeader",
    GIT_CONFIG_VALUE_0: "X-Fixture: preserved",
  };
  const original = { ...environment };
  const client = new GitCliClient("git", 4, token);
  assert.deepEqual(client.buildGitEnvironment(environment), {
    ...original,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_1: headerKey,
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: headerKey,
    GIT_CONFIG_VALUE_2: authorization,
  });
  assert.deepEqual(environment, original);
  assert.equal(new GitCliClient().buildGitEnvironment(environment), environment);
});

test("GitHub authentication rejects an invalid inherited Git configuration count", () => {
  const client = new GitCliClient("git", 4, token);
  for (const value of ["", " ", "-1", "1.5", "0x1", "1e2", "invalid", "Infinity", String(Number.MAX_SAFE_INTEGER)]) {
    assert.throws(() => client.buildGitEnvironment({ GIT_CONFIG_COUNT: value }), /GIT_CONFIG_COUNT/);
  }
});

test("real Git scopes token headers to HTTPS github.com and preserves other hosts", async context => {
  const { client, directory } = await createGitFixture(context, token, {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: headerKey,
    GIT_CONFIG_VALUE_0: "Authorization: Basic obsolete-fixture-credential",
    GIT_CONFIG_KEY_1: "http.https://example.com/.extraHeader",
    GIT_CONFIG_VALUE_1: "X-Fixture: preserved",
  });
  for (const url of [
    "https://github.com/example/private.git",
    "https://GITHUB.COM/example/another.git",
    "https://github.com:443/example/private.git",
  ]) {
    assert.equal(
      await client.runGit(["config", "--get-urlmatch", "http.extraHeader", url], directory),
      authorization
    );
  }
  assert.equal(
    await client.runGit([
      "config", "--get-urlmatch", "http.extraHeader", "https://example.com/other.git",
    ], directory),
    "X-Fixture: preserved"
  );
  for (const url of [
    "http://github.com/example/private.git",
    "ssh://git@github.com/example/private.git",
    "https://github.com:8443/example/private.git",
    "https://github.com.example.com/example/private.git",
    "https://github.com@example.invalid/example/private.git",
    "https://gitlab.com/example/private.git",
  ]) {
    await assert.rejects(
      client.runGit(["config", "--get-urlmatch", "http.extraHeader", url], directory),
      error => error.code === 1
    );
  }
});

test("omitting the token preserves existing GitHub authentication configuration", async context => {
  const { client, directory } = await createGitFixture(context, undefined, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: headerKey,
    GIT_CONFIG_VALUE_0: "X-Fixture: existing-github-auth",
  });
  assert.equal(
    await client.runGit([
      "config", "--get-urlmatch", "http.extraHeader", "https://github.com/example/private.git",
    ], directory),
    "X-Fixture: existing-github-auth"
  );
});

test("token credentials are not added to Git command arguments", async context => {
  const { client, directory } = await createGitFixture(context, token, {}, process.execPath);
  const args = ["clone", "https://github.com/example/private.git"];
  const output = await client.runGit([
    "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...args,
  ], directory);
  assert.deepEqual(JSON.parse(output), args);
});

test("token credentials are not persisted in repository or global Git configuration", async context => {
  const { client, directory, globalConfig } = await createGitFixture(context, token);
  const repository = path.join(directory, "repository");
  await client.runGit(["init", "--initial-branch=main", repository], directory);
  await client.runGit(["remote", "add", "origin", "https://github.com/example/private.git"], repository);
  const config = await readFile(path.join(repository, ".git", "config"), "utf8");
  assert.match(config, /url = https:\/\/github\.com\/example\/private\.git/);
  assert.ok(!config.includes(token));
  assert.ok(!config.includes(encodedCredentials));
  assert.ok(!config.toLowerCase().includes("extraheader"));
  assert.equal(await readFile(globalConfig, "utf8"), "");
});

test("Git failures redact repeated raw and encoded token credentials from stdout and stderr", async context => {
  const { client, directory } = await createGitFixture(context, token, {}, process.execPath);
  for (const stream of ["stdout", "stderr"]) {
    const script = `
      const header = process.env["GIT_CONFIG_VALUE_" + (Number(process.env.GIT_CONFIG_COUNT) - 1)];
      const encoded = header.split(" ").pop();
      const token = Buffer.from(encoded, "base64").toString("utf8").slice("x-access-token:".length);
      process.${stream}.write("Authentication failed: " + token + " " + encoded + " " + token + " " + encoded);
      process.exitCode = 23;
    `;
    await assert.rejects(client.runGit(["-e", script], directory), error => {
      assert.equal(error.code, 23);
      assert.match(error.message, /Authentication failed:/);
      assert.match(error.message, /\[REDACTED\]/);
      assert.ok(!error.message.includes(token));
      assert.ok(!error.message.includes(encodedCredentials));
      assert.ok(!error.stack.includes(token));
      assert.ok(!error.stack.includes(encodedCredentials));
      return true;
    });
  }
});
