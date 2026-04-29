# Contributing to Antigravity

Thanks for helping improve the repository. This project mixes original workspace material, a large skill library, and a public-facing portfolio, so contributions should prioritize clarity, publish safety, and provenance.

## Contribution Principles

- Keep the repository GitHub-friendly and safe to share publicly.
- Prefer reusable, documented additions over one-off local experiments.
- Preserve attribution, license files, and upstream notices when adapting third-party material.
- Avoid committing anything that exposes private runtime history or machine-specific secrets.

## Adding or Updating a Skill Pack

When contributing to `skills/`:

1. Create or update a dedicated top-level skill directory.
2. Keep the primary instructions in `SKILL.md`.
3. Place supporting material in clearly named folders such as `references/`, `scripts/`, `assets/`, or `examples/`.
4. Include usage notes or a `README.md` when the skill is large or non-obvious.
5. Preserve any upstream attribution and license files if the pack is adapted from external work.

## Portfolio Changes

When changing `portfolio/`:

- keep the site fully static unless there is a strong reason not to
- verify the site still works by opening `portfolio/index.html` locally
- keep resume links, contact details, and project descriptions consistent across the site

## Publish Safety Checklist

Before committing:

- confirm you are not adding local runtime folders such as `conversations/`, `brain/`, `scratch/`, or `.netlify/`
- check that no secrets, tokens, passwords, or private keys are being introduced
- verify any machine-specific paths in configuration files are intentional and documented
- update the root documentation if you add a major top-level component

## Pull Request Guidance

- Use clear commit messages that describe the outcome of the change.
- Keep changes scoped; avoid mixing content cleanup, feature work, and unrelated formatting in one commit.
- Summarize what changed, why it changed, and how you verified it.

## Questions

For repository-level questions, open an issue or reach out through the contact details published in the portfolio.
