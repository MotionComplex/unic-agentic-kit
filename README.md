# unic-agentic-kit

Claude Code skills, plugins and agents for Unic delivery work. The repo is a plugin
marketplace: add it once and every plugin is available on every Claude surface.

## Layout

```
unic-agentic-kit/
├── .claude-plugin/         # marketplace.json — this repo is a plugin marketplace
├── plugins/
│   ├── unic/
│   │   ├── skills/         # autopilot, pr-review, pr-respond
│   │   ├── agents/         # autopilot-builder / -reviewer / -fixer
│   │   └── conventions/    # Code-review and Azure DevOps conventions the PR skills cite
│   ├── dor-dod/            # Definition of Ready/Done: spec, check, promote
│   └── flowlever/          # Local review cockpit for specs and PR review/respond
└── templates/
    └── docs-conventions/   # Starting points for a team repo's docs/conventions/
```

## Plugins

| Plugin | What it ships | Invoked as |
|---|---|---|
| `unic` | `plugins/unic`: skills, agents, conventions | `/unic:autopilot`, `/unic:pr-review`, `/unic:pr-respond` |
| `dor-dod` | DoR/DoD spec, check, promote | `/dor-dod:spec`, `/dor-dod:check`, `/dor-dod:promote` |
| `flowlever` | Review cockpit app + skills | `/flowlever:start`, `/flowlever:audit`, `/flowlever:pr-review`, … |

## Install

**On a claude.ai account (every surface):** Customize → Plugins → Add marketplace →
`MotionComplex/unic-agentic-kit`, install the plugins, enable "Sync automatically". Claude Code
picks them up as `<plugin>@synced` after `/login`.

**In Claude Code only:**

```text
/plugin marketplace add MotionComplex/unic-agentic-kit
/plugin install unic@unic-agentic-kit
/plugin install dor-dod@unic-agentic-kit
/plugin install flowlever@unic-agentic-kit
```

**For a team repo:** commit the marketplace to the project's `.claude/settings.json` so
collaborators are prompted to install it:

```json
{
  "extraKnownMarketplaces": {
    "unic-agentic-kit": { "source": { "source": "github", "repo": "MotionComplex/unic-agentic-kit" } }
  },
  "enabledPlugins": {
    "unic@unic-agentic-kit": true,
    "dor-dod@unic-agentic-kit": true,
    "flowlever@unic-agentic-kit": true
  }
}
```

## Adding a skill

Drop `plugins/unic/skills/<name>/SKILL.md` in (it joins the `unic` plugin), or add a new plugin
under `plugins/` and list it in `.claude-plugin/marketplace.json`. Never make the repo root a
plugin: claude.ai skips a plugin that contains other plugins. Keep each skill `description` under
1024 characters — claude.ai truncates anything longer. Check with
`claude plugin validate .claude-plugin/marketplace.json`.
