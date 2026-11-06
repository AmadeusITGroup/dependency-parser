const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");

const { ProjectService, ProjectNameConflictError } = require("../../dist/application/services/ProjectService");
const { Project } = require("../../dist/domain/models/Project");
const { ProjectDependency } = require("../../dist/domain/models/ProjectDependency");
const { ProjectRegistry } = require("../../dist/infrastructure/registry/ProjectRegistry");

const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function project(id, name = id, dependencies = null) {
  return new Project(id, name, "https://example.com/project.git", null, dependencies);
}

function setup(context, projects = []) {
  const registry = new ProjectRegistry(projects);
  const store = {
    saveProject: context.mock.fn(async () => {}),
    deleteProject: context.mock.fn(async () => {}),
  };
  return { registry, store, service: new ProjectService(registry, store) };
}

test("project reads work without a persistence adapter, but writes fail explicitly", async () => {
  const existing = project("existing");
  const registry = new ProjectRegistry([existing]);
  const service = new ProjectService(registry, undefined);

  assert.deepEqual(service.getAllProjects(), [existing]);
  assert.equal(service.getProject(existing.id), existing);
  assert.equal(service.getProject("missing"), null);
  for (const operation of [
    () => service.createProject(project("new")),
    () => service.updateProject(existing.id, project("updated")),
    () => service.deleteProject(existing.id),
  ]) {
    await assert.rejects(operation, /Project persistence is not configured/);
  }
  assert.equal(registry.getProject(existing.id), existing);
});

test("creation assigns unique IDs without mutating the requested tree or edge metadata", async context => {
  const existing = project("existing", "Existing", [
    new ProjectDependency(project(firstId), null, null),
  ]);
  const { registry, store, service } = setup(context, [existing]);
  const reference = /^@example\/child$/i;
  const requested = project("draft", "New project", [
    new ProjectDependency(project(secondId, "Preserved"), "package.json", reference),
    new ProjectDependency(project(firstId, "Collision"), "pom.xml", "child"),
    new ProjectDependency(project(secondId, "Duplicate"), null, null),
  ]);
  requested.description = "Project description";
  requested.tagPattern = "^v";

  const created = await service.createProject(requested);
  const ids = [created.id, ...created.dependencies.map(({ project }) => project.id)];

  assert.equal(new Set(ids).size, ids.length);
  ids.forEach(id => assert.match(id, uuidPattern));
  assert.equal(created.dependencies[0].project.id, secondId);
  assert.ok(!ids.includes(firstId));
  assert.equal(created.description, requested.description);
  assert.equal(created.tagPattern, "^v");
  assert.equal(created.dependencies[0].manifestPath, "package.json");
  assert.equal(created.dependencies[0].versionReference, reference);
  assert.equal(requested.id, "draft");
  assert.equal(requested.dependencies[1].project.id, firstId);
  assert.equal(requested.dependencies[2].project.id, secondId);
  assert.equal(store.saveProject.mock.calls[0].arguments[0], created);
  assert.equal(registry.getProject(created.id), created);
});

test("ID generation retries collisions with registered projects", async context => {
  const { service } = setup(context, [project(firstId)]);
  const ids = [firstId, secondId];
  const generate = context.mock.method(crypto, "randomUUID", () => ids.shift());

  const created = await service.createProject(project("draft"));

  assert.equal(created.id, secondId);
  assert.equal(generate.mock.callCount(), 2);
});

test("creation and updates reject normalized name conflicts before persisting", async context => {
  const alpha = project("alpha", "Alpha");
  const beta = project("beta", "Beta");
  const { registry, store, service } = setup(context, [alpha, beta]);

  await assert.rejects(
    service.createProject(project("new", " ALPHA ")),
    ProjectNameConflictError
  );
  await assert.rejects(
    service.updateProject(alpha.id, project("replacement", " beta ")),
    ProjectNameConflictError
  );
  assert.equal(store.saveProject.mock.callCount(), 0);
  assert.equal(registry.getProject(alpha.id), alpha);
});

test("duplicate direct dependency names are rejected recursively", async context => {
  const { store, service } = setup(context);
  const nested = project("nested", "Parent", [
    new ProjectDependency(project("one", "Child"), null, null),
    new ProjectDependency(project("two", " CHILD "), null, null),
  ]);

  await assert.rejects(
    service.createProject(project("root", "Root", [
      new ProjectDependency(nested, null, null),
    ])),
    /more than one direct dependency named/
  );
  assert.equal(store.saveProject.mock.callCount(), 0);
});

test("the same dependency name is allowed under different parents", async context => {
  const { service } = setup(context);
  const children = ["Alpha", "Beta"].map(name => new ProjectDependency(
    project(name, name, [new ProjectDependency(project(`${name}-child`, "Shared"), null, null)]),
    null,
    null
  ));

  const created = await service.createProject(project("root", "Root", children));

  assert.deepEqual(
    created.dependencies.map(({ project }) => project.dependencies[0].project.name),
    ["Shared", "Shared"]
  );
});

test("updates preserve the root and available child IDs and register only after persistence", async context => {
  const original = project("existing", "Existing", [
    new ProjectDependency(project(firstId, "Child"), null, null),
  ]);
  const { registry, store, service } = setup(context, [original]);
  context.mock.method(store, "saveProject", async updated => {
    assert.equal(updated.id, original.id);
    assert.equal(registry.getProject(original.id), original);
  });
  const requested = project("ignored-root-id", " EXISTING ", original.dependencies);

  const updated = await service.updateProject(original.id, requested);

  assert.equal(updated.id, original.id);
  assert.equal(updated.dependencies[0].project.id, firstId);
  assert.equal(updated.name, requested.name);
  assert.equal(registry.getProject(original.id), updated);
  assert.equal(original.name, "Existing");
});

test("missing projects are not updated, deleted, or persisted", async context => {
  const { store, service } = setup(context);

  assert.equal(await service.updateProject("missing", project("replacement")), null);
  assert.equal(await service.deleteProject("missing"), false);
  assert.equal(store.saveProject.mock.callCount(), 0);
  assert.equal(store.deleteProject.mock.callCount(), 0);
});

test("persistence failures propagate without changing the registered project", async context => {
  const existing = project("existing");
  const { registry, store, service } = setup(context, [existing]);
  const failure = new Error("Storage unavailable");
  context.mock.method(store, "saveProject", async () => { throw failure; });
  context.mock.method(store, "deleteProject", async () => { throw failure; });

  await assert.rejects(service.createProject(project("new")), error => error === failure);
  await assert.rejects(service.updateProject(existing.id, project("updated")), error => error === failure);
  await assert.rejects(service.deleteProject(existing.id), error => error === failure);
  assert.deepEqual(registry.getAllProjects(), [existing]);
});

test("deletion removes only the requested project after persistence succeeds", async context => {
  const existing = project("existing");
  const retained = project("retained");
  const { registry, store, service } = setup(context, [existing, retained]);
  context.mock.method(store, "deleteProject", async id => {
    assert.equal(id, existing.id);
    assert.equal(registry.getProject(id), existing);
  });

  assert.equal(await service.deleteProject(existing.id), true);
  assert.equal(registry.getProject(existing.id), null);
  assert.equal(registry.getProject(retained.id), retained);
});
