const path = require("path");
const { runner } = require("node-pg-migrate");
const logger = require("../utils/logger");
require("dotenv").config();

const direction = process.argv[2] || "up";
const databaseUrl = process.env.DATABASE_URL
  || `postgres://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(process.env.DB_PASSWORD)}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;

runner({
  databaseUrl,
  dir: path.join(__dirname, "..", "migrations"),
  direction,
  migrationsTable: "pgmigrations",
  count: direction === "down" ? 1 : undefined,
})
  .then(() => {
    logger.info("database_migrations_completed", { direction });
  })
  .catch((error) => {
    logger.error("database_migration_failed", { direction, error });
    process.exit(1);
  });