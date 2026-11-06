const assert = require("node:assert/strict");
const { test } = require("node:test");

const { Project, findProject } = require("../../dist/domain/models/Project");
const { ProjectDependency } = require("../../dist/domain/models/ProjectDependency");

test("project lookup finds root and nested projects and returns null for missing IDs", () => {
  const child = new Project("child", "Child", "https://example.com/child.git");
  const root = new Project("root", "Root", "https://example.com/root.git", null, [
    new ProjectDependency(child, "package.json", "child"),
  ]);

  assert.equal(findProject(root.id, [root]), root);
  assert.equal(findProject(child.id, [root]), child);
  assert.equal(findProject("missing", [root]), null);
  assert.equal(findProject("missing", []), null);
});

test("project lookup terminates for cyclic and shared project graphs", () => {
  const root = new Project("root", "Root", "https://example.com/root.git", null, []);
  const child = new Project("child", "Child", "https://example.com/child.git", null, [
    new ProjectDependency(root, null, null),
  ]);
  root.dependencies.push(
    new ProjectDependency(child, null, null),
    new ProjectDependency(child, null, null)
  );

  assert.equal(findProject(child.id, [root]), child);
  assert.equal(findProject("missing", [root, root]), null);
});
