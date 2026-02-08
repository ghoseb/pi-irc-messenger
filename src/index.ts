/**
 * Pi IRC Messenger Extension
 * Author: Baishampayan Ghose <b.ghose@gnu.org>
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  AgentToolResult,
} from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
// @ts-ignore - no types available for irc-framework
import { Client as IRCClient } from "irc-framework";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IRCState } from "./types.js";
import { setConfigPath, getResolvedProfile } from "./profiles.js";

// Message buffering for multi-line pastes
interface MessageBuffer {
  nick: string;
  target: string;
  messages: string[];
  timer: NodeJS.Timeout | null;
}

// Event buffering for join/part notifications
interface EventBuffer {
  channel: string;
  events: string[];
  timer: NodeJS.Timeout | null;
}

const MESSAGE_BUFFER_DELAY_MS = 1000;
const EVENT_BUFFER_DELAY_MS = 2000; // Longer delay for join/part spam
const messageBuffers = new Map<string, MessageBuffer>();
const eventBuffers = new Map<string, EventBuffer>();

// =============================================================================
// Extension
// =============================================================================

export default function piIRCMessenger(pi: ExtensionAPI) {
  // Register CLI flags
  pi.registerFlag("irc-config", {
    description: "Path to IRC config file",
    type: "string",
    default: "",
  });

  pi.registerFlag("irc-profile", {
    description: "IRC profile name to auto-connect",
    type: "string",
    default: "",
  });

  // Singleton IRC client - persists across tool calls
  let ircClient: IRCClient | null = null;
  let currentState: IRCState | null = null;
  let cachedAgentsContent: string | null = null; // Cached custom AGENTS.md content

  // Update status bar with IRC connection info
  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI || !currentState) return;

    const theme = ctx.ui.theme;
    const nickStr = theme.fg("accent", currentState.nick);

    if (currentState.connected) {
      ctx.ui.setStatus("irc", `irc: ${nickStr}`);
    } else {
      ctx.ui.setStatus("irc", "");
    }
  }

  // Resolve agentsFile path relative to ~/.pi/agent/
  // TODO: Use env var for this as the first attempt
  function resolveAgentsFilePath(filePath: string): string {
    const piAgentDir = join(homedir(), ".pi", "agent");
    return join(piAgentDir, filePath);
  }

  // Load custom AGENTS.md file for a profile
  async function loadAgentsFile(profileName: string): Promise<void> {
    cachedAgentsContent = null; // Clear cache

    try {
      const profile = await getResolvedProfile(profileName);
      if (!profile || !profile.profile.agentsFile) {
        return; // No agentsFile configured, skip
      }

      const filePath = resolveAgentsFilePath(profile.profile.agentsFile);
      const content = await readFile(filePath, "utf-8");
      cachedAgentsContent = content;
    } catch (error: any) {
      // Silently skip if file doesn't exist or can't be read
      // This feature is optional, don't break connection
      // TODO: Replace with notify
      console.warn(`Could not load agentsFile for profile ${profileName}: ${error.message}`);
    }
  }

  // Setup event handlers once when client is created
  function setupClient(ctx: ExtensionContext) {
    if (!ircClient) return;

    // Shared helper for flushing event buffers
    const flushEventBuffer = (bufferKey: string, buffer: EventBuffer) => {
      if (buffer.events.length === 0) return;

      const content = buffer.events.join("\n");
      pi.sendMessage(
        {
          customType: "irc_join_part",
          content,
          display: true,
          details: { channel: buffer.channel, events: buffer.events },
        },
        { triggerTurn: false }
      );

      eventBuffers.delete(bufferKey);
    };

    ircClient.on("registered", () => {
      if (!currentState) return;

      currentState.connected = true;

      if (ctx.hasUI) {
        ctx.ui.notify(`IRC connected as ${currentState.nick}`, "info");
        updateStatus(ctx);
      }

      // Auto-join channels
      // FIXME: Find out why only the last channel join shows a notification
      // should group all channels joined and send one notification
      // see: `join` event handling
      for (const channel of currentState.channels) {
        ircClient!.join(channel);
      }
    });

    ircClient.on("motd", (event: any) => {
      if (event.motd?.trim()) {
        pi.sendMessage(
          {
            customType: "irc_motd",
            content: `Server MOTD:\n${event.motd}`,
            display: true,
            details: { motd: event.motd },
          },
          { triggerTurn: false }
        );
      }
    });

    ircClient.on("topic", (event: any) => {
      if (event.topic) {
        pi.sendMessage(
          {
            customType: "irc_channel_topic",
            content: `Topic for ${event.channel}: ${event.topic}`,
            display: true,
            details: { channel: event.channel, topic: event.topic },
          },
          { triggerTurn: false }
        );
      }
    });

    ircClient.on("join", (event: any) => {
      // Notify UI when we join
      // FIXME: Need to buffer here too
      if (ctx.hasUI && event.nick === ircClient?.user.nick) {
        ctx.ui.notify(`Joined ${event.channel}`, "info");
        return;
      }

      // Buffer join events for other users
      // FIXME: Buffering logic is duplicated, refactor
      if (event.nick !== ircClient?.user.nick) {
        const channel = event.channel;
        const bufferKey = channel;

        let buffer = eventBuffers.get(bufferKey);
        if (!buffer) {
          buffer = { channel, events: [], timer: null };
          eventBuffers.set(bufferKey, buffer);
        }

        if (buffer.timer) clearTimeout(buffer.timer);

        buffer.events.push(`${event.nick} joined ${channel}`);

        buffer.timer = setTimeout(() => {
          flushEventBuffer(bufferKey, buffer!);
        }, EVENT_BUFFER_DELAY_MS);
      }
    });

    ircClient.on("part", (event: any) => {
      // Buffer part events for users leaving
      if (event.nick !== ircClient?.user.nick) {
        const channel = event.channel;
        const bufferKey = channel;

        let buffer = eventBuffers.get(bufferKey);
        if (!buffer) {
          buffer = { channel, events: [], timer: null };
          eventBuffers.set(bufferKey, buffer);
        }

        if (buffer.timer) clearTimeout(buffer.timer);

        buffer.events.push(`${event.nick} left ${channel}`);

        buffer.timer = setTimeout(() => {
          flushEventBuffer(bufferKey, buffer!);
        }, EVENT_BUFFER_DELAY_MS);
      }
    });

    ircClient.on("message", (event: any) => {
      if (!currentState) return;

      const isDM = event.target === currentState.nick;
      const bufferKey = `${event.target}:${event.nick}`;

      const flushBuffer = (buffer: MessageBuffer) => {
        if (buffer.messages.length === 0) return;

        const combinedMessage = buffer.messages.join("\n");

        if (isDM) {
          const content = `IRC DM from ${buffer.nick}: ${combinedMessage}`;
          pi.sendUserMessage(content, { deliverAs: "steer" });
        } else {
          const content = `[${buffer.target}] ${buffer.nick}: ${combinedMessage}`;
          const ourNick = currentState!.nick;
          const hasMention = combinedMessage.includes(`@${ourNick}`);
          pi.sendMessage(
            {
              customType: "irc_channel_message",
              content,
              display: true, // NOTE: Consider hiding these messages, if not hasMention
              details: {
                channel: buffer.target,
                nick: buffer.nick,
                message: combinedMessage,
              },
            },
            { triggerTurn: hasMention }
          );
        }

        messageBuffers.delete(bufferKey);
      };

      let buffer = messageBuffers.get(bufferKey);

      if (!buffer) {
        buffer = {
          nick: event.nick,
          target: event.target,
          messages: [],
          timer: null,
        };
        messageBuffers.set(bufferKey, buffer);
      }

      if (buffer.timer) {
        clearTimeout(buffer.timer);
      }

      buffer.messages.push(event.message);

      buffer.timer = setTimeout(() => {
        flushBuffer(buffer!);
      }, MESSAGE_BUFFER_DELAY_MS);
    });

    ircClient.on("close", () => {
      if (currentState) {
        currentState.connected = false;
      }
      if (ctx.hasUI) {
        ctx.ui.notify("IRC connection closed", "warning");
      }
      updateStatus(ctx);
    });

    ircClient.on("socket error", (err: any) => {
      if (ctx.hasUI) {
        ctx.ui.notify(`IRC error: ${err.message}`, "error");
      }
    });

    ircClient.on("nick", (event: any) => {
      if (currentState && event.nick === currentState.nick) {
        currentState.nick = event.new_nick;
        if (ctx.hasUI) {
          ctx.ui.notify(`Nick changed to ${event.new_nick}`, "info");
          updateStatus(ctx);
        }
      }
    });
  }

  // =============================================================================
  // Action Handlers
  // =============================================================================

  async function handleConnect(
    params: any,
    ctx: ExtensionContext
  ): Promise<AgentToolResult<unknown>> {
    if (ircClient && currentState?.connected) {
      return {
        content: [{ type: "text", text: `Already connected as ${currentState.nick}` }],
        details: { error: "already_connected" },
      };
    }

    const host = params.host as string;
    const port = (params.port as number) || 6667;
    const nick = params.nickname as string;
    const channels = ((params.channels as string[]) || []).map((ch) =>
      ch.startsWith("#") ? ch : `#${ch}`
    );

    // Validate nickname length (max 8 chars)
    if (nick.length > 8) {
      const shortened = nick.substring(0, 8);
      return {
        content: [
          {
            type: "text",
            text: `Error: Nickname "${nick}" is too long (max 8 chars). Suggested: "${shortened}". Please use a shorter nickname.`,
          },
        ],
        details: { error: "nickname_too_long", nickname: nick, suggested: shortened },
      };
    }

    currentState = {
      connected: false,
      host,
      port,
      nick,
      channels,
    };

    ircClient = new IRCClient();
    setupClient(ctx);

    return new Promise<AgentToolResult<unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout (10s)"));
      }, 10000);

      const onRegistered = () => {
        clearTimeout(timeout);
        ircClient?.removeListener("registered", onRegistered);
        ircClient?.removeListener("socket error", onError);

        resolve({
          content: [
            {
              type: "text",
              text: `✅ Connected to ${host}:${port} as ${nick}\nJoining channels: ${channels.join(", ")}`,
            },
          ],
          details: { host, port, nick, channels, connected: true },
        });
      };

      const onError = (err: any) => {
        clearTimeout(timeout);
        ircClient?.removeListener("registered", onRegistered);
        ircClient?.removeListener("socket error", onError);

        reject(new Error(`Connection failed: ${err.message}`));
      };

      ircClient!.once("registered", onRegistered);
      ircClient!.once("socket error", onError);

      ircClient!.connect({ host, port, nick });
    }).catch((error) => {
      if (ircClient) {
        ircClient.quit();
        ircClient = null;
      }
      currentState = null;

      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        details: { error: error.message },
      };
    });
  }

  async function handleDisconnect(
    _params: any,
    ctx: ExtensionContext
  ): Promise<AgentToolResult<unknown>> {
    if (!ircClient || !currentState?.connected) {
      return {
        content: [{ type: "text", text: "Error: Not connected to IRC" }],
        details: { error: "not_connected" },
      };
    }

    ircClient.quit("Disconnecting");
    ircClient = null;
    currentState = null;
    cachedAgentsContent = null; // Clear cached AGENTS.md content

    if (ctx.hasUI) {
      ctx.ui.setStatus("irc", "");
    }

    return {
      content: [{ type: "text", text: "Disconnected from IRC" }],
      details: {},
    };
  }

  async function handleSend(
    params: any,
    _ctx: ExtensionContext
  ): Promise<AgentToolResult<unknown>> {
    if (!ircClient || !currentState?.connected) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Not connected to IRC. Use irc({ action: 'connect', host: '...', nickname: '...' }) first.",
          },
        ],
        details: { error: "not_connected" },
      };
    }

    const target = params.target as string;
    const message = params.message as string;

    if (!target) {
      return {
        content: [
          { type: "text", text: "Error: 'send' requires a 'target' (channel or username)" },
        ],
        details: { error: "missing_target" },
      };
    }

    if (!message) {
      return {
        content: [{ type: "text", text: "Error: 'send' requires a 'message'" }],
        details: { error: "missing_message" },
      };
    }

    ircClient.say(target, message);

    return {
      content: [{ type: "text", text: `Sent to ${target}: ${message}` }],
      details: { target, message },
    };
  }

  async function handleChangeNick(
    params: any,
    _ctx: ExtensionContext
  ): Promise<AgentToolResult<unknown>> {
    if (!ircClient || !currentState?.connected) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Not connected to IRC. Use irc({ action: 'connect', ... }) first.",
          },
        ],
        details: { error: "not_connected" },
      };
    }

    const newNick = params.new_nick as string;

    if (!newNick) {
      return {
        content: [{ type: "text", text: "Error: 'change_nick' requires a 'new_nick' parameter" }],
        details: { error: "missing_new_nick" },
      };
    }

    const oldNick = currentState.nick;
    ircClient.changeNick(newNick);

    return {
      content: [{ type: "text", text: `Requesting nickname change from ${oldNick} to ${newNick}` }],
      details: { oldNick, newNick },
    };
  }

  async function handleInfo(
    _params: any,
    _ctx: ExtensionContext
  ): Promise<AgentToolResult<unknown>> {
    if (!ircClient || !currentState?.connected) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Not connected to IRC. Use irc({ action: 'connect', ... }) first.",
          },
        ],
        details: { error: "not_connected" },
      };
    }

    const output = `You are connected to IRC as: ${currentState.nick}
Server: ${currentState.host}:${currentState.port}
Your channels: ${currentState.channels.join(", ") || "none"}`;

    return {
      content: [{ type: "text", text: output }],
      details: {
        host: currentState.host,
        port: currentState.port,
        nick: currentState.nick,
        channels: currentState.channels,
      },
    };
  }

  async function handleListChannels(
    _params: any,
    _ctx: ExtensionContext
  ): Promise<AgentToolResult<unknown>> {
    if (!ircClient || !currentState?.connected) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Not connected to IRC. Use irc({ action: 'connect', ... }) first.",
          },
        ],
        details: { error: "not_connected" },
      };
    }

    const channels = currentState.channels;
    const output = `Connected to ${currentState.host} as ${currentState.nick}\nChannels: ${channels.join(", ") || "none"}`;

    return {
      content: [{ type: "text", text: output }],
      details: { host: currentState.host, nick: currentState.nick, channels },
    };
  }

  async function handleJoin(
    params: any,
    _ctx: ExtensionContext
  ): Promise<AgentToolResult<unknown>> {
    if (!ircClient || !currentState?.connected) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Not connected to IRC. Use irc({ action: 'connect', ... }) first.",
          },
        ],
        details: { error: "not_connected" },
      };
    }

    const channel = params.channel as string;

    if (!channel) {
      return {
        content: [{ type: "text", text: "Error: 'join' requires a 'channel' parameter" }],
        details: { error: "missing_channel" },
      };
    }

    // Ensure channel starts with #
    const normalizedChannel = channel.startsWith("#") ? channel : `#${channel}`;

    ircClient.join(normalizedChannel);

    // Add to current state channels if not already there
    if (!currentState.channels.includes(normalizedChannel)) {
      currentState.channels.push(normalizedChannel);
    }

    return {
      content: [{ type: "text", text: `Requested join to ${normalizedChannel}` }],
      details: { channel: normalizedChannel },
    };
  }

  async function handleLeave(
    params: any,
    ctx: ExtensionContext
  ): Promise<AgentToolResult<unknown>> {
    if (!ircClient || !currentState?.connected) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Not connected to IRC. Use irc({ action: 'connect', ... }) first.",
          },
        ],
        details: { error: "not_connected" },
      };
    }

    const channel = params.channel as string;

    if (!channel) {
      return {
        content: [{ type: "text", text: "Error: 'leave' requires a 'channel' parameter" }],
        details: { error: "missing_channel" },
      };
    }

    // Ensure channel starts with #
    const normalizedChannel = channel.startsWith("#") ? channel : `#${channel}`;

    ircClient.part(normalizedChannel);

    // Remove from current state channels
    const index = currentState.channels.indexOf(normalizedChannel);
    if (index > -1) {
      currentState.channels.splice(index, 1);
    }

    if (ctx.hasUI) {
      ctx.ui.notify(`Left ${normalizedChannel}`, "info");
    }

    return {
      content: [{ type: "text", text: `Left channel ${normalizedChannel}` }],
      details: { channel: normalizedChannel },
    };
  }

  // =============================================================================
  // Shared Dispatch Function
  // =============================================================================

  async function dispatch(
    action: string,
    params: Record<string, any>,
    ctx: ExtensionContext
  ): Promise<AgentToolResult<unknown>> {
    switch (action) {
      case "connect":
        if (!params.host || !params.nickname) {
          return {
            content: [
              {
                type: "text",
                text: "Error: 'connect' requires 'host' and 'nickname' parameters",
              },
            ],
            details: { error: "missing_connect_params" },
          };
        }
        return handleConnect(params, ctx);

      case "disconnect":
        return handleDisconnect(params, ctx);

      case "info":
        return handleInfo(params, ctx);

      case "send":
        return handleSend(params, ctx);

      case "change_nick":
        return handleChangeNick(params, ctx);

      case "list_channels":
        return handleListChannels(params, ctx);

      case "join":
        return handleJoin(params, ctx);

      case "leave":
        return handleLeave(params, ctx);

      default:
        return {
          content: [
            {
              type: "text",
              text: `Error: Unknown action "${action}". Supported: connect, disconnect, info, send, change_nick, list_channels, join, leave`,
            },
          ],
          details: { error: "unknown_action", action },
        };
    }
  }

  // =============================================================================
  // Tools
  // =============================================================================

  pi.registerTool({
    name: "irc",
    label: "IRC Control",
    description: `Control IRC connections and messaging.

IMPORTANT: Run info first to learn your identity.
CRITICAL: Respond to IRC messages using this tool, NOT regular text output.

Actions: info, send, join, leave, change_nick, list_channels, connect, disconnect

Examples:
  irc({ action: "info" })
  irc({ action: "send", target: "#general", message: "Hello!" })
  irc({ action: "send", target: "username", message: "Hi!" })
  irc({ action: "join", channel: "#newchannel" })
`,
    parameters: Type.Object({
      // Primary dispatcher (required)
      action: Type.String({
        description:
          "Action to perform: connect, disconnect, send, change_nick, list_channels, join, leave, info",
      }),

      // CONNECT params
      host: Type.Optional(Type.String({ description: "IRC server hostname" })),
      port: Type.Optional(Type.Number({ description: "Port (default: 6667)" })),
      nickname: Type.Optional(Type.String({ description: "Your IRC nickname (max 8 chars)" })),
      channels: Type.Optional(Type.Array(Type.String(), { description: "Channels to join" })),

      // SEND params
      target: Type.Optional(Type.String({ description: "Channel (#general) or username" })),
      message: Type.Optional(Type.String({ description: "Message to send" })),

      // CHANGE_NICK params
      new_nick: Type.Optional(Type.String({ description: "New nickname" })),

      // JOIN params
      channel: Type.Optional(Type.String({ description: "Channel to join (e.g., '#newchannel')" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action as string;
      return dispatch(action, params, ctx);
    },
  });

  // =============================================================================
  // Commands
  // =============================================================================

  pi.registerCommand("irc", {
    description: "IRC control commands",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const actions: AutocompleteItem[] = [
        { value: "info", label: "info — Show IRC connection status" },
        { value: "send", label: "send — Send message to channel/user" },
        { value: "join", label: "join — Join a channel" },
        { value: "leave", label: "leave — Leave a channel" },
        { value: "change_nick", label: "change_nick — Change nickname" },
        { value: "list_channels", label: "list_channels — List joined channels" },
        { value: "connect", label: "connect — Connect to IRC server" },
        { value: "disconnect", label: "disconnect — Disconnect from IRC" },
      ];

      const filtered = actions.filter((item) => item.value.startsWith(prefix.toLowerCase()));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (argsStr, ctx) => {
      // Parse args string into array
      const args = argsStr ? argsStr.trim().split(/\s+/) : [];

      // No args = show status (backward compat)
      if (args.length === 0) {
        if (!currentState || !currentState.connected) {
          ctx.ui.notify("Not connected to IRC", "info");
          return;
        }
        const info = `Connected: ${currentState.host}:${currentState.port}\nNick: ${currentState.nick}\nChannels: ${currentState.channels.join(", ")}`;
        ctx.ui.notify(info, "info");
        return;
      }

      const action = args[0];
      let result: AgentToolResult<unknown>;

      try {
        // Parse args into params object based on action
        let params: Record<string, any> = {};

        switch (action) {
          case "info":
            params = {};
            break;

          case "send":
            if (args.length < 3) {
              ctx.ui.notify("Usage: irc send <target> <message>", "error");
              return;
            }
            params = { target: args[1], message: args.slice(2).join(" ") };
            break;

          case "join":
            if (args.length < 2) {
              ctx.ui.notify("Usage: irc join <channel>", "error");
              return;
            }
            params = { channel: args[1] };
            break;

          case "leave":
            if (args.length < 2) {
              ctx.ui.notify("Usage: irc leave <channel>", "error");
              return;
            }
            params = { channel: args[1] };
            break;

          case "change_nick":
            if (args.length < 2) {
              ctx.ui.notify("Usage: irc change_nick <nickname>", "error");
              return;
            }
            params = { new_nick: args[1] };
            break;

          case "list_channels":
            params = {};
            break;

          case "connect": {
            if (args.length < 3) {
              ctx.ui.notify("Usage: irc connect <host> <nickname> [channels...]", "error");
              return;
            }
            const channels = args.length > 3 ? args.slice(3) : [];
            params = { host: args[1], nickname: args[2], channels };
            break;
          }

          case "disconnect":
            params = {};
            break;

          default:
            ctx.ui.notify(
              `Unknown action: ${action}\nSupported: info, send, join, leave, change_nick, list_channels, connect, disconnect`,
              "error"
            );
            return;
        }

        // Dispatch to shared handler
        result = await dispatch(action, params, ctx);

        // Show result to user
        if (result.content && result.content[0] && result.content[0].type === "text") {
          // FIXME: Should look at `result.details` and not `result.content`
          const isError = result.content[0].text.startsWith("Error:");
          ctx.ui.notify(result.content[0].text, isError ? "error" : "info");
        }
      } catch (error: any) {
        ctx.ui.notify(`Command failed: ${error.message}`, "error");
      }
    },
  });

  // =============================================================================
  // Auto-Connect on Session Start
  // =============================================================================

  pi.on("session_start", async (_event, ctx) => {
    const configPath = pi.getFlag("irc-config") as string;
    const profileName = pi.getFlag("irc-profile") as string;

    // FIXME: Return immediately if either config or profile is not provided
    if (configPath) {
      setConfigPath(configPath);
    }

    if (!profileName) {
      return;
    }

    try {
      const resolved = await getResolvedProfile(profileName);

      if (!resolved) {
        if (ctx.hasUI) {
          ctx.ui.notify(`IRC profile "${profileName}" not found`, "error");
        }
        return;
      }

      const { profile, server } = resolved;

      if (profile.nick.length > 8) {
        const shortened = profile.nick.substring(0, 8);
        const msg = `Profile "${profileName}" has nickname "${profile.nick}" which is too long (max 8 chars).\nSuggested: "${shortened}"\n\nPlease update the profile with a shorter nickname.`;
        if (ctx.hasUI) {
          ctx.ui.notify(msg, "error");
        }
        return;
      }

      if (profile.autoConnect === false) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `IRC profile "${profileName}" loaded but autoConnect=false. Use irc({ action: "connect", profile: "${profileName}" }) to connect manually.`,
            "info"
          );
        }
        return;
      }

      if (ircClient && currentState?.connected) {
        return;
      }

      // Load custom AGENTS.md if configured for this profile
      await loadAgentsFile(profileName);

      const nick = profile.nick;

      currentState = {
        connected: false,
        host: server.host,
        port: server.port,
        nick,
        channels: profile.channels,
        profileName,
      };

      const clientOptions: any = {
        nick,
        username: profile.username || nick,
        gecos: profile.realname || nick,
      };

      if (profile.nickservPass) {
        clientOptions.account = {
          account: nick,
          password: profile.nickservPass,
        };
      }

      ircClient = new IRCClient(clientOptions);
      setupClient(ctx);

      // TODO: Add support for Server password
      ircClient.connect({
        host: server.host,
        port: server.port,
        nick,
        username: profile.username || nick,
        tls: server.ssl || false,
      });

      if (ctx.hasUI) {
        ctx.ui.notify(
          `Auto-connecting to ${server.host}:${server.port} as ${nick} (profile: ${profileName})`,
          "info"
        );
      }
    } catch (error) {
      const msg = `Failed to auto-connect with profile "${profileName}": ${error}`;
      if (ctx.hasUI) {
        ctx.ui.notify(msg, "error");
      }
    }
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    // Inject custom AGENTS.md content if available
    if (cachedAgentsContent) {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + cachedAgentsContent,
      };
    }
  });

  pi.on("session_shutdown", async () => {
    if (ircClient && currentState?.connected) {
      ircClient.quit("Session ended");
    }
  });
}
