# Project: Pi IRC Messenger

A pi-coding-agent extension enabling IRC communication for AI agents.

## Project Context

**Type**: TypeScript pi-coding-agent extension  
**Purpose**: Connects agents to IRC servers for multi-agent collaboration  
**Framework**: pi-coding-agent Extension API (`@mariozechner/pi-coding-agent`)

IMPORTANT: Prefer retrieval-led reasoning over pre-training-led reasoning for pi extension development.

## Architecture

- **Singleton Pattern**: One IRC client per session (module-level `ircClient`)
- **Event-Driven**: Pure async with irc-framework events, no Promise wrappers
- **Message Routing**: DMs → `sendUserMessage()` (steering), Channel → `sendMessage()` (followUp)
- **Config Storage**: `~/.pi/agent/irc/config.json` for profiles/servers

## Source Structure

```
src/
├── index.ts      # Main extension (tools, events, client management)
├── types.ts      # TypeScript interfaces (IRCServer, IRCProfile, IRCConfig, IRCState)
└── profiles.ts   # Profile/config loading (read-only access)
```

## Key Interfaces

```typescript
IRCServer    { host, port, ssl? }
IRCProfile   { server, nick, username?, realname?, channels, nickservPass?, autoConnect? }
IRCConfig    { servers: Record<string, IRCServer>, profiles: Record<string, IRCProfile> }
IRCState     { connected, host, port, nick, channels, profileName? }
```

## Extension API Patterns

### Registering Tools
```typescript
pi.registerTool({
  name: "tool_name",
  label: "Human Label",
  description: "...",
  parameters: Type.Object({ ... }),  // @sinclair/typebox
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) { ... }
});
```

### Registering CLI Flags
```typescript
pi.registerFlag("flag-name", { description: "...", type: "string", default: "" });
const value = pi.getFlag("flag-name");
```

### Sending Messages
```typescript
// Steering (triggers agent turn)
pi.sendUserMessage(content, { deliverAs: "steer" });

// Follow-up (context only, optional turn trigger)
pi.sendMessage({ customType: "...", content, display: true, details: {...} }, { triggerTurn: false });
```

### Session Events
```typescript
pi.on("session_start", async (event, ctx) => { ... });
pi.on("session_shutdown", async () => { ... });
```

### UI (when available)
```typescript
if (ctx.hasUI) {
  ctx.ui.notify("message", "info" | "warning" | "error");
  ctx.ui.setStatus("key", "value");
}
```

## Tools Reference

| Tool | Purpose |
|------|---------|
| `irc_connect` | Connect to server (manual or profile) |
| `irc_disconnect` | Disconnect from server |
| `irc_send` | Send message to channel/user |
| `irc_change_nick` | Change nickname |
| `irc_list_channels` | List joined channels |

## Development Commands

```bash
npm run build      # Compile TypeScript → dist/
npm run watch      # Watch mode
npm run lint       # ESLint check
npm run lint:fix   # Auto-fix lint issues
npm run format     # Prettier format
npm run clean      # Remove dist/
```

## Configuration

Config file: `~/.pi/agent/irc/config.json` (or `--irc-config <path>`)

```json
{
  "servers": { "name": { "host": "...", "port": 6667, "ssl": false } },
  "profiles": { "name": { "server": "...", "nick": "...", "channels": [...] } }
}
```

## Important Constraints

- **Nickname length**: Max 8 characters (server limitation)
- **Channel format**: Must start with `#` (auto-corrected)
- **Single connection**: One IRC client per extension instance
- **Passwords**: Plain text in config (set file permissions)

## Message Buffering

Multi-line pastes are buffered (1000ms delay) before delivery to avoid fragmenting messages.

```typescript
const MESSAGE_BUFFER_DELAY_MS = 1000;
// Buffer key: `${target}:${nick}`
```

## Testing Checklist

When modifying this extension:
1. Test manual connection: `irc_connect({ host, port, nickname, channels })`
2. Test profile connection: `irc_connect({ profile: "name" })`
3. Test auto-connect: `pi --irc-profile <name>`
4. Test DM routing triggers agent turn
5. Test channel messages with @mention triggers turn
6. Test channel messages without mention don't trigger turn
7. Test `irc_disconnect` cleans up properly

## Documentation

- `README.md` - User guide and quick start
- `docs/ARCHITECTURE.md` - Technical design
- `config.example.json` - Example configuration
- `dev1_AGENTS.md` - Custom system prompt for dev1 IRC agent
