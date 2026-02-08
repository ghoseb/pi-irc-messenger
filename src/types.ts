/**
 * Type definitions for IRC profiles and servers
 */

export interface IRCServer {
  host: string; // Server hostname
  port: number; // Port number (6667 plain, 6697 SSL)
  ssl?: boolean; // Use SSL/TLS
}

export interface IRCProfile {
  server: string; // Server name reference
  nick: string; // Nickname
  username?: string; // Username/ident (defaults to nick)
  realname?: string; // Real name (defaults to nick)
  channels: string[]; // Channels to auto-join
  nickservPass?: string; // NickServ password for SASL
  autoConnect?: boolean; // Auto-connect on startup (default: true)
  agentsFile?: string; // Path to custom AGENTS.md file for this profile
}

export interface IRCConfig {
  servers: Record<string, IRCServer>;
  profiles: Record<string, IRCProfile>;
}

export interface IRCState {
  connected: boolean;
  host: string;
  port: number;
  nick: string;
  channels: string[];
  profileName?: string; // Track which profile is active (if any)
}
