# Antigravity

Antigravity is a publish-safe snapshot of a Gemini workspace built around reusable AI skills, MCP integrations, and a static cybersecurity portfolio. The repository is structured so it can be cloned, reviewed, and extended without carrying along private runtime state from the local machine where it was created.

## Highlights

- `2076` skill packs collected under `skills/`
- `4263` tracked files covering prompts, references, scripts, and assets
- a standalone `portfolio/` site with a downloadable resume
- root-level MCP configuration for reproducible local tool setup
- ignore rules that keep conversations, temp artifacts, and local workspace data out of Git

## Repository Map

```text
antigravity/
|-- portfolio/        # Static portfolio site and resume asset
|-- skills/           # Reusable skill library; each pack centers on SKILL.md
|-- mcp_config.json   # MCP server configuration; update local paths after cloning
|-- CONTRIBUTING.md   # Contribution guidelines and publishing hygiene
|-- SECURITY.md       # Vulnerability reporting and safe-use notes
|-- LICENSING.md      # Licensing and attribution guidance for mixed-source content
|-- .gitignore        # Local-only workspace exclusions
`-- README.md         # Repository overview
```

## What This Repository Contains

### `skills/`

The `skills/` directory is the core of the repository. It packages a large reusable instruction library for AI-assisted work across areas such as:

- software engineering
- frontend and backend development
- automation and workflow design
- cloud and platform operations
- cybersecurity, pentesting, and defensive analysis
- documentation, planning, and research

Most skill packs are organized around a `SKILL.md` file and may also include helper scripts, examples, references, or assets.

### `portfolio/`

The `portfolio/` directory contains a self-contained static website for Prem Ranjith Varma K. It is built with plain HTML, CSS, and JavaScript and showcases cybersecurity experience, selected projects, skills, and contact details.

See [portfolio/README.md](./portfolio/README.md) for the portfolio-specific file map.

### `mcp_config.json`

The root MCP configuration captures the local Model Context Protocol setup used by the workspace. If you clone this repository, review and update any machine-specific command paths before using it on another system.

## What Is Intentionally Excluded

The repository is meant to stay clean and public-shareable, so local runtime data is ignored by default. That includes:

- conversations and context memory
- annotations and generated workspace artifacts
- scratch, playground, and temporary folders
- browser recordings
- local Netlify runtime state
- duplicate `skills/* - Copy*` directories

This keeps the published repository focused on reusable assets rather than machine-specific history.

## Quick Start

1. Clone the repository.
2. Browse `skills/` and open the packs relevant to your workflow.
3. Open `portfolio/index.html` in a browser to preview the static site locally.
4. Review `mcp_config.json` and replace any local absolute paths with paths that match your environment.

## Good Fit For

This repository is useful if you want to:

- maintain a large reusable skill library for AI-assisted execution
- keep a structured prompt and reference workspace under version control
- pair AI tooling infrastructure with a professional cybersecurity portfolio
- publish a curated workspace snapshot without leaking private runtime data

## Repository Notes

- There is no root build step or package manager requirement for browsing this repository.
- The portfolio can be deployed independently on any static host such as GitHub Pages or Netlify.
- Some bundled skill directories may include their own licenses or attribution notes. See [LICENSING.md](./LICENSING.md) before reusing content wholesale.
- If you plan to contribute, start with [CONTRIBUTING.md](./CONTRIBUTING.md).
- If you need to report a security issue or potentially sensitive publish concern, see [SECURITY.md](./SECURITY.md).
