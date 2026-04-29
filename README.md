# Antigravity

Antigravity is a curated Gemini workspace that packages a reusable skill library, MCP configuration, and a presentation-ready portfolio site into a shareable repository. It is designed to support multi-step AI work such as coding, research, design, automation, and cybersecurity workflows while keeping personal runtime data out of version control.

## Overview

This repository captures the portable layer of a larger local AI workspace:

- a large `skills/` library with reusable instructions, assets, scripts, and references
- an `mcp_config.json` file for connecting supported MCP services
- a polished static `portfolio/` site for a cybersecurity-focused personal profile
- documentation that explains how the workspace is organized and what should or should not be published

The result is a clean GitHub-friendly structure that can be cloned, reviewed, extended, or reused without carrying along private local state.

## Repository Structure

```text
antigravity/
|-- portfolio/         # Static portfolio website and downloadable resume
|-- skills/            # Installed reusable skills, references, and helper assets
|-- .gitignore         # Publish-safe ignore rules for local workspace data
|-- mcp_config.json    # MCP server configuration
`-- README.md          # Repository overview
```

## Key Components

### 1. Skill Library

The `skills/` directory is the core of the workspace. It contains a large set of reusable skill packs for different domains such as:

- software engineering
- frontend and backend development
- AI application building
- cloud and DevOps workflows
- security analysis and penetration testing
- documentation, planning, and automation

Many skills include their own `README.md`, example assets, scripts, and reference material.

### 2. MCP Configuration

`mcp_config.json` stores the Model Context Protocol server configuration used by the local workspace. This enables external tools and structured integrations to be connected in a repeatable way.

### 3. Portfolio Website

The `portfolio/` directory contains a standalone static personal portfolio for Prem Ranjith Varma K. It is built with plain HTML, CSS, and JavaScript, and highlights cybersecurity skills, projects, experience, and contact details.

See [portfolio/README.md](./portfolio/README.md) for the portfolio-specific breakdown.

## What Is Included

- reusable skills and their supporting content
- portfolio source files and downloadable resume
- MCP configuration required to reproduce the workspace structure
- repository documentation for contributors or reviewers

## What Is Excluded

The following local-only workspace data is intentionally ignored:

- conversations and runtime context
- annotations and temporary artifacts
- browser recordings
- scratch and playground files
- local Netlify state
- accidental duplicate `skills/* - Copy*` folders or files

This keeps the GitHub repository focused, portable, and safer to share publicly.

## Getting Started

### Explore the workspace

Browse the root directories and open the skill folders most relevant to your use case. Many skills include their own internal documentation and helper assets.

### View the portfolio locally

Open `portfolio/index.html` in a browser to preview the static site.

### Review MCP setup

Inspect `mcp_config.json` and update it as needed for your local environment before using external MCP services.

## Use Cases

This repository is useful if you want to:

- maintain a reusable AI workspace for structured task execution
- keep a large personal skill library under version control
- pair practical AI tooling with a professional portfolio site
- publish a clean snapshot of your working environment without leaking runtime data

## Notes

- This repo intentionally favors portability and structure over bundling private local state.
- The portfolio is self-contained and can be deployed independently on any static hosting platform.
- The workspace can grow over time by adding or refining skill packs inside `skills/`.
