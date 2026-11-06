const assert = require("node:assert/strict");
const { once } = require("node:events");
const { mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createServer } = require("../dist/interfaces/http/server");
const { logger } = require("../dist/utils/logger");

function configureEnvironment(context, frontendDirectory) {
  const values = {
    DATASTORE: "memory",
    DEPENDENCY_SCAN_ENABLED: "false",
    GITHUB_TOKEN: undefined,
    FRONTEND_DIST: frontendDirectory,
  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  context.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  context.mock.method(logger, "info", () => {});
}

async function listen(context) {
  const app = await createServer();
  context.after(() => app.locals.closeDataStore());
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

test("configured frontend serves assets and SPA routes without hiding API or asset errors", async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dependency-parser-frontend-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const html = "<!doctype html><html><body><app-root></app-root></body></html>";
  const javascript = "console.log('frontend fixture');";
  await writeFile(path.join(directory, "index.html"), html);
  await writeFile(path.join(directory, "main.js"), javascript);
  configureEnvironment(context, directory);
  const baseUrl = await listen(context);

  for (const route of [
    "/", "/tree", "/tree/example-project", "/tree/example.project", "/builder", "/find-root-version",
  ]) {
    const response = await fetch(`${baseUrl}${route}`, { headers: { Accept: "text/html" } });
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.equal(await response.text(), html);
  }
  const asset = await fetch(`${baseUrl}/main.js`);
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), javascript);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/health`)).json(), { status: "ok" });
  assert.deepEqual(await (await fetch(`${baseUrl}/api/projects`)).json(), { projects: [] });
  assert.deepEqual(await (await fetch(`${baseUrl}/api/hello`)).json(), {
    message: "Hello from Express + TypeScript!",
  });
  for (const route of ["/api", "/api/missing", "/API/missing", "/missing.js"]) {
    assert.equal((await fetch(`${baseUrl}${route}`)).status, 404, route);
  }
  assert.equal((await fetch(`${baseUrl}/tree`, {
    headers: { Accept: "application/json" },
  })).status, 404);
  const head = await fetch(`${baseUrl}/builder`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

for (const frontendDirectory of [undefined, "", " \t "]) {
  test(`server remains API-only without a frontend directory (${JSON.stringify(frontendDirectory)})`, async context => {
    configureEnvironment(context, frontendDirectory);
    const baseUrl = await listen(context);
    assert.equal((await fetch(`${baseUrl}/`)).status, 404);
    assert.deepEqual(await (await fetch(`${baseUrl}/api/health`)).json(), { status: "ok" });
  });
}

test("frontend configuration fails startup if index.html is missing or is not a file", async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dependency-parser-frontend-invalid-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  configureEnvironment(context, directory);
  await assert.rejects(createServer(), { code: "ENOENT" });
  await mkdir(path.join(directory, "index.html"));
  await assert.rejects(createServer(), /FRONTEND_DIST must contain an index.html file/);
});
