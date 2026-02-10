<p>
  <img src="https://raw.githubusercontent.com/ghoseb/pi-irc-messenger/main/banner.png" alt="pi-irc-messenger" width="1100">
</p>

# Pi IRC Messenger

IRC communication extension for [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).
Connects agents to IRC servers for multi-agent collaboration.

## Why IRC?

What if multiple agents could coordinate with each other over IRC, over the Internet?

I grew up on FreeNode. Spent years in channels where strangers became collaborators, where you could mass-coordinate across time zones with nothing but a nickname and a topic. Then Slack happened, then Discord, and IRC quietly faded into the background -- replaced by proprietary walled gardens that charge you per seat.

Now I'm bringing it back. But this time, the participants aren't just people.

Today, getting two AI agents to work together means writing glue code: message-passing systems, schemas, serialization, all of it held together with prayer. Every new agent means more wiring. It doesn't scale, and it certainly doesn't *think*.

Give each agent a nickname and point them at an IRC server instead. That's it. They can talk. An architect agent tells a developer to refactor a module. A QA agent reviews the diff and flags a race condition. A human drops into the channel, overrides a decision, and leaves. Nobody wrote an integration for any of this. IRC is just text in, text out. It doesn't care if you're a person or a machine. No custom protocols. No message brokers. No SDKs. Just channels, nicknames, and messages across machines, networks, and continents.

I've tested this: three agents in a channel. The architect broke down a feature. The developers claimed tasks, wrote code, reviewed each other's work over IRC, ran linters, and committed. I stepped in twice. Everything else was autonomous and the entire decision trail was right there in the chat log.

**Pi IRC Messenger** drops into any [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) session and makes your agent social. It coordinates with other agents, takes instructions from humans, and knows when to stop. IRC handles the plumbing. The agents handle the work.

## Features

- 🔌 Connect to any IRC server (manual or profile-based)
- 💬 Send/receive messages in channels and DMs
- 📢 Smart routing: DMs trigger agent turns, channel @mentions trigger turns, other messages are context-only
- 🔄 Persistent singleton connection across tool calls
- 📋 Message buffering for multi-line pastes (1s delay)
- 🏷️ Support for context injection via custom AGENTS.md, server MOTD and channel topic

## How It Works

Not every message deserves an agent's attention. Pi IRC Messenger makes a simple but important distinction:

- **@mention or DM** → the agent treats it as a **steering command**. It stops what it's doing and responds. This is how you (or another agent) give instructions, ask questions, or redirect work.
- **Everything else** → added to the agent's **context** silently. The agent sees the conversation, absorbs it, but doesn't interrupt its current task. It's background awareness, the way you'd overhear a conversation in a room without jumping in.

This means a busy channel with five agents doesn't turn into chaos. Each agent only acts when spoken to directly, but stays informed about what everyone else is doing.

**Context injection** works the same way IRC always worked: through the server MOTD and channel topics. The MOTD is delivered on connect and sets the ground rules for the session. The channel topic sets the scope for that specific channel. Agents read both and treat them as standing instructions. No config files, no environment variables, just the same mechanisms IRC ops have used for decades.

Each profile can also specify a custom `AGENTS.md` file that gets injected into the system prompt, giving each agent a distinct role, personality, and set of constraints before it even joins a channel.

## Installation

```bash
pi install git:github.com/ghoseb/pi-irc-messenger
```

Developer mode: Load from custom checkout path
```bash
npm build
pi -e ./dist/index.js --irc-config config.example.json --irc-profile dev1
```

## Quick Start

### With a Profile (Required)

1. Create `~/.pi/agent/irc/config.json` (see [config.example.json](config.example.json)):

```json
{
  "servers": {
    "local": { "host": "localhost", "port": 6667 }
  },
  "profiles": {
    "dev": {
      "server": "local",
      "nick": "MyAgent",
      "channels": ["#general"]
    }
  }
}
```

2. Auto-connect on startup:

```bash
pi --irc-profile dev1

# Optional custom config file path
pi --irc-config /path/to/irc_config.json --irc-profile architect
```

## Tool: `irc` for the Agent

Single tool with action dispatch:

| Action | Description | Key Params |
|--------|-------------|------------|
| `info` | Show connection status | — |
| `connect` | Connect to server | `host`, `nickname`, `channels?`, `port?` |
| `disconnect` | Disconnect | — |
| `send` | Send a message | `target`, `message` |
| `join` | Join a channel | `channel` |
| `leave` | Leave a channel | `channel` |
| `change_nick` | Change nickname | `new_nick` |
| `list_channels` | List joined channels | — |

## Command: `/irc` for TUI usage

All tool actions are also available as TUI commands:

```
/irc                                    # show status
/irc info                               # connection info
/irc connect <host> <nick> [channels]   # connect
/irc disconnect                         # disconnect
/irc send <target> <message>            # send message
/irc join <channel>                     # join channel
/irc leave <channel>                    # leave channel
/irc change_nick <nick>                 # change nick
/irc list_channels                      # list channels
```

## Configuration

Config file: `~/.pi/agent/irc/config.json` (override with `--irc-config <path>`)

### Profile Options

| Field | Required | Description |
|-------|----------|-------------|
| `server` | ✅ | Server name (references `servers` section) |
| `nick` | ✅ | Nickname (max 8 chars) |
| `channels` | ✅ | Channels to auto-join |
| `username` | — | IRC username (defaults to nick) |
| `realname` | — | Real name (defaults to nick) |
| `nickservPass` | — | NickServ/SASL password |
| `autoConnect` | — | Auto-connect on startup (default: `true`) |
| `agentsFile` | — | Path to custom AGENTS.md (relative to `~/.pi/agent/`) - injected into system prompt |

### Optional: Per-Profile AGENTS.md

Each profile can specify a custom AGENTS.md file (optional) that gets injected into the system prompt when connected. This lets you give each agent a distinct role and set of instructions.

```json
{
  "profiles": {
    "dev1": {
      "server": "local",
      "nick": "ByteMe",
      "channels": ["#general"],
      "agentsFile": "irc/dev1_AGENTS.md"
    }
  }
}
```

See [dev1_AGENTS.md](dev1_AGENTS.md) for a sample file.

### Server Options

| Field | Required | Description |
|-------|----------|-------------|
| `host` | ✅ | Server hostname |
| `port` | ✅ | Port number |
| `ssl` | — | Use SSL/TLS (default: `false`) |

## Development

```bash
npm run build      # Compile TypeScript
npm run watch      # Watch mode
npm run check      # Build + lint + format check
npm run lint       # ESLint
npm run lint:fix   # Auto-fix lint issues
npm run format     # Prettier format
npm run clean      # Remove dist/
```

## Running an IRC Server

You need an IRC server for your agents to connect to. [ngIRCd](https://github.com/ngircd/ngircd) is a lightweight, easy-to-configure option that works well for this.

On macOS:
```bash
brew install ngircd
ngircd
```

On Debian/Ubuntu:
```bash
sudo apt install ngircd
sudo systemctl start ngircd
```

That gives you a server on `localhost:6667`. No registration, no setup wizards. Edit `/etc/ngircd/ngircd.conf` (or `/opt/homebrew/etc/ngircd.conf` on macOS) to set the server name, MOTD, and any channel defaults.

For production use or exposing to the internet, enable TLS and set up authentication. But for local multi-agent experiments, the defaults are all you need.

## Credit & Thanks

- **[Pi coding agent](https://github.com/badlogic/pi-mono/)** by [@badlogicgames](https://x.com/badlogicgames)
- **[Pi Messenger](https://github.com/nicobailon/pi-messenger/)** by [@nicopreme](https://x.com/nicopreme)

## License

MIT
