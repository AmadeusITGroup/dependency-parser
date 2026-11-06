import { Request, Response, Router } from "express";

import { DependencyController } from "../controllers/DependencyController";
import { CommitDiffController } from "../controllers/CommitDiffController";
import { DiffController } from "../controllers/DiffController";
import { ProjectController } from "../controllers/ProjectController";
import { VersionController } from "../controllers/VersionController";
import { VersionSearchController } from "../controllers/VersionSearchController";

export const createRoutes = (
  dependencyController: DependencyController,
  versionController: VersionController,
  diffController: DiffController,
  projectController: ProjectController,
  versionSearchController?: VersionSearchController,
  commitDiffController?: CommitDiffController
): Router => {
  const router = Router();

  router.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  router.get("/projects", projectController.getAllProjects);
  router.post("/projects", projectController.createProject);
  router.get("/projects/:projectId", projectController.getProject);
  router.put("/projects/:projectId", projectController.updateProject);
  router.delete("/projects/:projectId", projectController.deleteProject);

  if (versionSearchController) {
    router.get("/projects/:projectId/find-root-version", versionSearchController.findVersion);
  }
  if (commitDiffController) {
    router.get("/projects/:projectId/commit-diffs", commitDiffController.compareCommits);
  }
  router.get(
    "/projects/:projectId/versions/:version/dependencies",
    dependencyController.resolveDependencies
  );
  router.get("/dependencies", dependencyController.resolveDependencies);
  router.get("/projects/:projectId/versions", versionController.getAvailableVersions);
  router.get("/versions", versionController.getAvailableVersions);
  router.get("/projects/:projectId/versions/:requestedVersion", versionController.getVersion);
  router.get("/versions/resolve", versionController.getVersion);
  router.get("/projects/:projectId/diffs", diffController.compareVersions);
  router.get(
    "/projects/:projectId/diffs/:fromVersion/:toVersion",
    diffController.compareVersions
  );
  router.get("/diffs", diffController.compareVersions);

  return router;
};
