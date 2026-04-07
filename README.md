# Antigravity

Antigravity is a local AI workspace for Gemini that combines a large library of reusable skills with memory, workflow, and context tracking. It helps handle complex tasks like coding, design, research, automation, and security by organizing workflows, tracking conversations, and reusing expert-style instructions.

## What This Project Does

This project gives Gemini access to a broad skill system and supporting workspace structure so it can work through multi-step tasks more effectively. The `skills/` directory contains the main reusable capabilities, while the surrounding workspace stores local execution state, planning artifacts, and runtime context.

## Included in This Repo

- `skills/` for the installed skill library
- `mcp_config.json` for MCP server configuration
- `README.md` for project overview

## Not Included

Local runtime and private workspace data such as conversations, browser recordings, annotations, scratch files, and context-tracking folders are ignored for publishing.
