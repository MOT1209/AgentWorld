/* eslint-disable no-console */
/**
 * Online backup of the SQLite database in DATABASE_URL.
 *
 *   npm run db:backup                    -> backups/agentworld-<timestamp>.db
 *   npm run db:backup -- /safe/place.db  -> an explicit file
 *
 * Restore: stop the API, replace the database file with the backup, start the API.
 */
import "dotenv/config";
import { prisma } from "../packages/database/src/client.js";
import { backupDatabase, defaultBackupPath } from "../packages/database/src/backup.js";

try {
  const file = await backupDatabase(prisma, process.argv[2] ?? defaultBackupPath());
  console.log(`backup written: ${file}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
