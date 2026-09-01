# Cursor explicit-only adapter

This intentionally empty skill directory suppresses automatic Cursor skill
discovery for the semantic plugin. Cursor exposes the canonical operators as
explicit slash commands from `../commands/`; Codex and Agent Plugins-compatible
hosts read the canonical `../skills/` sources.
