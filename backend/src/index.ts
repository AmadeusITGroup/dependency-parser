import { startServer } from "./interfaces/http/server";
import { logger } from "./utils/logger";

startServer().catch((error: unknown) => {
	logger.error({ err: error }, "Failed to start server.");
	process.exitCode = 1;
});