import "dotenv/config";
import cors from "cors";
import express, { Express } from "express";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import path from "node:path";

import { DependencyResolverService } from "../../application/services/DependencyResolverService";
import { DependencyTreeMetadataService } from "../../application/services/DependencyTreeMetadataService";
import { DiffService } from "../../application/services/DiffService";
import { ProjectService } from "../../application/services/ProjectService";
import { VersionLocatorService } from "../../application/services/VersionLocatorService";
import { ComparePackageVersions } from "../../application/use-cases/ComparePackageVersions";
import { CompareVersionCommits } from "../../application/use-cases/CompareVersionCommits";
import { FindRootVersion } from "../../application/use-cases/FindRootVersion";
import { GetDependencyVersion } from "../../application/use-cases/GetDependencyVersion";
import { ResolveProjectDependencies } from "../../application/use-cases/ResolveProjectDependencies";
import { ScanProjectDependencies } from "../../application/use-cases/ScanProjectDependencies";
import {
  buildDependencyResolutionRetries, buildDependencyScanConfig, buildGitConcurrency, buildGitHubToken,
  buildNpmRangeResolutionTtl,
} from "../../config/app.config";
import { Project } from "../../domain/models/Project";
import { GitCliClient } from "../../infrastructure/git/GitCliClient";
import { MavenPackageParser } from "../../infrastructure/parsers/maven/MavenPackageParser";
import { NpmPackageParser } from "../../infrastructure/parsers/npm/NpmPackageParser";
import { AutoDetectSourceControlProvider } from "../../infrastructure/providers/AutoDetectSourceControlProvider";
import { ProjectRegistry } from "../../infrastructure/registry/ProjectRegistry";
import { JsonFileDataStore } from "../../infrastructure/storage/JsonFileDataStore";
import { MongoDataStore } from "../../infrastructure/storage/MongoDataStore";
import { ScanScheduler } from "../../scheduler/ScanScheduler";
import { logger } from "../../utils/logger";
import { DependencyController } from "./controllers/DependencyController";
import { CommitDiffController } from "./controllers/CommitDiffController";
import { DiffController } from "./controllers/DiffController";
import { ProjectController } from "./controllers/ProjectController";
import { VersionController } from "./controllers/VersionController";
import { VersionSearchController } from "./controllers/VersionSearchController";
import { createRoutes } from "./routes/routes";
import { IDataStore } from "../../domain/interfaces/IDataStore";

export async function createServer(): Promise<Express> {
  const scanConfig = buildDependencyScanConfig();
  const gitConcurrency = buildGitConcurrency();
  const githubToken = buildGitHubToken();
  const dependencyResolutionRetries = buildDependencyResolutionRetries();
  const rangeResolutionTtlMs = buildNpmRangeResolutionTtl();
  const frontendDirectory = process.env.FRONTEND_DIST?.trim();
  const frontendIndex = frontendDirectory ? path.resolve(frontendDirectory, "index.html") : undefined;
  if (frontendIndex && !(await stat(frontendIndex)).isFile()) {
    throw new Error("FRONTEND_DIST must contain an index.html file.");
  }
  const app = express();

  app.use(cors());
  app.use(express.json());

  
  const gitClient = new GitCliClient("git", gitConcurrency, githubToken);
  const npmPackageParser = new NpmPackageParser();
  const mavenPackageParser = new MavenPackageParser();

  const dataStore = await buildDataStore();
  let projects: Project[];
  try {
    projects = await buildProjectsFromEnvironment(dataStore);
  } catch (error) {
    await dataStore?.close?.();
    throw error;
  }
  const projectRegistry = new ProjectRegistry(projects);
  logger.info({
    projectCount: projects.length,
    dataStore: process.env.DATASTORE?.trim().toLowerCase() || "memory",
    dependencyScanEnabled: scanConfig.enabled && Boolean(dataStore),
    gitMaxConcurrency: gitConcurrency,
    githubTokenConfigured: Boolean(githubToken),
    dependencyResolutionRetries,
    npmRangeResolutionTtlMinutes: rangeResolutionTtlMs / 60_000,
  }, "Project registry loaded.");
  logger.info(githubToken
    ? "GitHub HTTPS authentication: using GITHUB_TOKEN."
    : "GitHub HTTPS authentication: using default Git authentication (GITHUB_TOKEN is not configured).");
  const sourceControlProvider = new AutoDetectSourceControlProvider();

  const cloneRoot =
    process.env.CLONE_ROOT ?? path.resolve(process.cwd(), "data", "repositories", "git");

  const dependencyResolverService = new DependencyResolverService(
    projectRegistry,
    gitClient,
    [npmPackageParser, mavenPackageParser],
    cloneRoot,
    dataStore,
    dependencyResolutionRetries
  );
  const versionLocatorService = new VersionLocatorService(
    projectRegistry,
    gitClient,
    dataStore,
    cloneRoot
  );
  const diffService = new DiffService(
    gitClient,
    npmPackageParser,
    sourceControlProvider,
    "package.json"
  );
  app.locals.startBackgroundJobs = () => {};
  app.locals.stopBackgroundJobs = () => Promise.resolve();

  if (scanConfig.enabled) {
    if (dataStore) {
      const scanScheduler = new ScanScheduler(
        new ScanProjectDependencies(
          projectRegistry,
          versionLocatorService,
          dependencyResolverService,
          gitConcurrency,
          rangeResolutionTtlMs
        ),
        scanConfig.intervalMs
      );

      app.locals.startBackgroundJobs = () => {
        logger.info({
          intervalMinutes: scanConfig.intervalMs / 60_000,
        }, "Dependency scans scheduled.");
        scanScheduler.start();
      };
      app.locals.stopBackgroundJobs = () => scanScheduler.stop();
    } else {
      app.locals.startBackgroundJobs = () => {
        logger.warn("Dependency scans disabled: configure DATASTORE=json or mongodb.");
      };
    }
  }

  app.locals.closeDataStore = async () => {
    await app.locals.stopBackgroundJobs();
    await Promise.all([gitClient.clearCommitComparisonCache(), dataStore?.close?.()]);
  };

  const treeMetadata = new DependencyTreeMetadataService(
    projectRegistry, gitClient, cloneRoot, dataStore
  );
  const dependencyController = new DependencyController(
    new ResolveProjectDependencies(dependencyResolverService), treeMetadata
  );
  const getDependencyVersion = new GetDependencyVersion(versionLocatorService, scanConfig.enabled);
  const versionController = new VersionController(getDependencyVersion);
  const diffController = new DiffController(
    new ComparePackageVersions(projectRegistry, diffService)
  );
  const commitDiffController = new CommitDiffController(
    new CompareVersionCommits(projectRegistry, gitClient, sourceControlProvider, dataStore)
  );
  const projectController = new ProjectController(
    new ProjectService(projectRegistry, dataStore)
  );
  const versionSearchController = new VersionSearchController(
    new FindRootVersion(projectRegistry, getDependencyVersion, dependencyResolverService),
    treeMetadata
  );

  app.use(
    "/api",
    createRoutes(
      dependencyController, versionController, diffController, projectController,
      versionSearchController, commitDiffController
    )
  );
  app.get("/api/hello", (_req, res) => {
    res.json({ message: "Hello from Express + TypeScript!" });
  });

  if (frontendIndex) {
    app.use(express.static(path.dirname(frontendIndex)));
    app.get("/{*path}", (req, res, next) => {
      // HTML navigation can contain dots in imported project IDs.
      const htmlNavigation = req.get("accept")?.toLowerCase().includes("text/html");
      if (/^\/api(?:\/|$)/i.test(req.path) || !req.accepts("html") ||
        (path.extname(req.path) && !htmlNavigation)) {
        next();
        return;
      }
      res.sendFile(frontendIndex);
    });
  }

  return app;
}

export async function startServer(
  port = Number(process.env.PORT ?? 3000)
): Promise<void> {
  const app = await createServer();
  let server: ReturnType<Express["listen"]>;
  try {
    server = app.listen(port);
    await once(server, "listening");
  } catch (error) {
    await app.locals.closeDataStore();
    throw error;
  }
  logger.info({ port }, "Server listening.");

  const shutdown = () => {
    logger.info("Server shutdown requested.");
    app.locals.stopBackgroundJobs().catch((error: unknown) => {
      logger.error({ err: error }, "Failed to stop background jobs.");
      process.exitCode = 1;
    });
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.once("close", () => {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    app.locals.closeDataStore().then(
      () => logger.info("Server shutdown completed."),
      (error: unknown) => {
        logger.error({ err: error }, "Failed to close server resources.");
        process.exitCode = 1;
      }
    );
  });
  app.locals.startBackgroundJobs();
}

export async function buildDataStore(
  environment: NodeJS.ProcessEnv = process.env
): Promise<IDataStore | undefined> {
  const rangeResolutionTtlMs = buildNpmRangeResolutionTtl(environment);
  switch (environment.DATASTORE?.trim().toLowerCase()) {
    case undefined:
    case "":
    case "memory":
      return undefined;
    case "json":
      return new JsonFileDataStore(
        path.resolve(process.cwd(), "data", "dependency-trees.json"),
        path.resolve(process.cwd(), "data", "projects.json"),
        undefined,
        rangeResolutionTtlMs
      );
    case "mongodb": {
      const uri = environment.MONGODB_URI?.trim();
      if (!uri) {
        throw new Error("MONGODB_URI is required when DATASTORE=mongodb.");
      }
      const databaseName = environment.MONGODB_DATABASE?.trim() || "dependency_parser";
      return MongoDataStore.connect(uri, databaseName, rangeResolutionTtlMs);
    }
    default:
      throw new Error("Unsupported DATASTORE. Use json, mongodb or memory.");
  }
}

async function buildProjectsFromEnvironment(
  dataStore: IDataStore | undefined
): Promise<Project[]> {
  return dataStore ? dataStore.getAllProjects() : [];
}