const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const loadIfExists = (envPath) => {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
    return true;
  }
  return false;
};

const loadEnv = () => {
  // Prefer runtime/container-provided variables; only fill missing keys from files.
  const serviceEnvPath = path.resolve(__dirname, "..", ".env");
  const rootEnvPath = path.resolve(__dirname, "..", "..", ".env");

  const loadedServiceEnv = loadIfExists(serviceEnvPath);
  const loadedRootEnv = loadIfExists(rootEnvPath);

  return {
    loadedServiceEnv,
    loadedRootEnv,
    serviceEnvPath,
    rootEnvPath,
  };
};

module.exports = { loadEnv };