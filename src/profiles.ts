/**
 * Profile and server configuration management (read-only)
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { IRCConfig, IRCServer, IRCProfile } from "./types.js";

const DEFAULT_CONFIG_FILE = join(homedir(), ".pi/agent/irc/config.json");

// Custom config file path (set via --irc-config CLI arg)
let customConfigPath: string | null = null;

export function setConfigPath(path: string) {
  customConfigPath = resolve(path);
}

function getConfigPath(): string {
  return customConfigPath || DEFAULT_CONFIG_FILE;
}

/**
 * Load config (servers + profiles) from disk
 */
async function loadConfig(): Promise<IRCConfig> {
  const configFile = getConfigPath();
  if (!existsSync(configFile)) {
    return { servers: {}, profiles: {} };
  }
  const content = await readFile(configFile, "utf-8");
  return JSON.parse(content);
}

/**
 * Get profile with resolved server config
 */
export async function getResolvedProfile(
  profileName: string
): Promise<{ profile: IRCProfile; server: IRCServer } | null> {
  const config = await loadConfig();
  const profile = config.profiles[profileName];

  if (!profile) {
    return null;
  }

  const server = config.servers[profile.server];

  if (!server) {
    throw new Error(`Profile "${profileName}" references unknown server "${profile.server}"`);
  }

  return { profile, server };
}
