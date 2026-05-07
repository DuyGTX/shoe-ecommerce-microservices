const path = require("path");
const { runner } = require("node-pg-migrate");
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
    console.log(`Database migrations completed (${direction}).`);
  })
  .catch((error) => {
    console.error("Database migration failed:", error.message);
    process.exit(1);
  });