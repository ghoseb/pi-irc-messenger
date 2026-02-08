# Pi IRC Messenger - Architecture

## Overview

Pi IRC Messenger is an extension for pi-coding-agent that enables agents to communicate via IRC.

## Design Principles

1. **Singleton Pattern**: Single IRC client instance persists across tool calls
2. **Event-Driven**: Pure async event handling, no Promise wrappers
3. **State Persistence**: File-backed state survives restarts
4. **Smart Message Routing**:
   - DMs → steering (sendUserMessage)
   - Channel messages → followUp (sendMessage)

## Core Components

### IRC Client Singleton
- Lives in extension module scope
- Initialized on first `irc_connect` call
- Event handlers set up once during client creation
- Survives across multiple tool invocations

### State Management
- `currentState`: In-memory connection state
- File: `~/.pi/agent/irc/state.json` for persistence
- Auto-restored on `session_start`

### Event Handlers
- `registered`: Connection confirmed, join channels
- `message`: Route DMs (steering) vs channels (followUp)
- `join`/`part`: Track channel membership
- `nick`: Confirm nickname changes
- `close`: Handle disconnection

## Tools

### Connection Tools
- `irc_connect`: Initialize connection (manual or profile-based)
- `irc_disconnect`: Clean disconnect

### Profile Tools
- `irc_profile_save`: Create/update profile with validation
- `irc_profile_list`: List all saved profiles
- `irc_profile_show`: Show profile details (passwords masked)
- `irc_profile_delete`: Delete profile (prevents deletion of active)

### Messaging Tools
- `irc_send`: Send to channel or user
- `irc_change_nick`: Change nickname (confirmed by server)
- `irc_list_channels`: List joined channels

## Message Flow

```
IRC Server → irc-framework → Event Handler → Extension Logic → pi API

DM:      sendUserMessage({ deliverAs: "steer" })
Channel: sendMessage({ deliverAs: "followUp", customType: "irc_channel_message" })
```

## Profile System

### Storage
- Location: `~/.pi/agent/irc/profiles.json`
- Format: JSON map of profile name → IRCProfile
- Auto-creates directory on first save

### Features
- Auto-nickname generation: [Adj][Noun] pattern (max 9 chars)
- TLS/SSL support via irc-framework
- SASL authentication support
- Server password support
- Validation: nick length, channel format

### Auto-Connect
- CLI flag: `pi --irc-profile <name>`
- Triggered on `session_start` event
- Reads `process.argv` for profile name
- Loads profile and connects automatically
- Error notifications if profile not found

### Profile in irc_connect
- Optional `profile` parameter
- Manual params override profile settings
- Backward compatible with manual-only usage

## Limitations

- Server-specific nickname length limits (validated, max 9 chars)
- Single connection per extension instance
- Plain text password storage (ensure file permissions)
- No profile import/export (manual JSON edit only)
