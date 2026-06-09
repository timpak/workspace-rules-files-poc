# Workspace Rules Files — POC

A Liferay Workspace used to validate a proposed rethink of the AI rules files that ship with `blade init`. The DevCon 2026 conference site (`client-extensions/devcon-2026-*`) was built entirely using these rules to prove they work end-to-end.

**Target product:** Liferay DXP 2026.Q1.6-LTS

---

## What This Changes

The workspace template on master ships three flat, high-level files:

- `liferay-rules.md` — general context priming and version-aware guidance
- `guided-client-extension.md` — beginner walkthrough for creating a first Client Extension
- `initial-setup-guide.md` — workspace setup steps for new users

This POC replaces that structure with two organized subdirectories:

**`.workspace-rules/rules/`** — seven reference cards with exact, verified information agents need to make correct API calls without hallucinating:
- `client-extension-types.md` — every CET type, required `client-extension.yaml` fields, OAuth requirements
- `headless-apis.md` — base URIs, endpoints, OAuth scopes, and error codes for every Headless module
- `oauth-scopes.md` — scope strings by CET type for `oAuthApplicationHeadlessServer` scaffolding
- `feature-flags-catalog.md` — flag keys, defaults, and what each unlocks
- `object-actions-catalog.md` — triggers, conditions, and all action executor types with payload shapes
- `page-types.md` — page and template types, the three distinct `type` vocabularies, and feature flag requirements
- `site-initializer-format.md` — full directory tree, batch engine format, `page.json` and `page-definition.json` schemas

**`.workspace-rules/skills/`** — nineteen on-demand skill files, one per workflow:

| Skill | What it does |
|---|---|
| `workspace-init` | Bootstrap a workspace and download the bundle |
| `feature-flags` | Detect, report, and enable required flags |
| `deploy-and-verify` | Deploy and confirm OSGi `STARTED` |
| `mcp-server` | MCP server setup, transport details, quirks |
| `production-standards` | Production-readiness guardrails |
| `manage-objects` | Object definitions, fields, relationships, picklists, validations |
| `manage-object-logic` | Object actions, workflows, notifications |
| `setup-oauth` | Companion OAuth applications for client extensions |
| `integrate-external-data` | Back objects with external services |
| `scaffold-fragment` | Page fragments with editable regions |
| `manage-pages` | Site pages, navigation, SEO, page templates |
| `theme-and-design` | Themes, master pages, style books |
| `react-custom-elements` | React-based Custom Element CETs |
| `scaffold-client-extension` | Any client extension type |
| `guided-client-extension` | Beginner walkthrough for a first CET |
| `manage-roles-permissions` | Roles, ACL, object and page permissions |
| `manage-environments` | `configs/{env}/`, data migration, siteInitializer capture |
| `commerce-catalogs` | Commerce catalogs, products, SKUs, B2B onboarding |
| `build-site` | Orchestrate a full site from a single prompt |

Each AI tool's config directory points to `.workspace-rules/` as the single source of truth. The rules load automatically when you open the workspace:

| Tool | Entry point |
|---|---|
| Claude Code | `.claude/CLAUDE.md` |
| Cursor | `.cursor/rules/liferay.mdc` |
| Gemini | `.gemini/GEMINI.md` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| Windsurf | `.windsurf/rules/liferay.md` |

---

## Prerequisites

- **Java 21**
- **Blade CLI** — `brew install liferay/blade/blade` or [download from releases](https://github.com/liferay/liferay-blade-cli/releases)

---

## Setup

### 1. Initialize the bundle

```bash
blade server init
```

Downloads the DXP 2026.Q1.6-LTS Tomcat bundle into `bundles/`.

### 2. Start the server

```bash
blade server start -t
```

Wait for `Server startup in [X] ms` in the log.

### 3. Deploy the demo site

Deploy the theme first, then the site initializer. The site initializer auto-provisions the DevCon 2026 site on deploy.

```bash
blade gw :client-extensions:devcon-2026-theme:deploy
blade gw :client-extensions:devcon-2026-site-init:deploy
```

### 4. Seed the object data

The site initializer provisions pages and fragments but not the Speakers, Sessions, and SessionRegistrations objects or their data. Use your AI tool to create them:

> "Create the Speaker, Session, and SessionRegistration objects and add sample conference data"

The `manage-objects` skill will handle the object definitions and the `manage-object-logic` skill will wire any actions. Once the objects exist and have data, the Speakers and Sessions pages will render live content.

### 5. Visit the site

```
http://localhost:8080/web/devcon-2026
```

---

## Using the AI Rules

Open this workspace root in your AI coding tool. The rules and skills load automatically. From there you can ask the agent to perform any Liferay task and it will load the appropriate skill:

- "Scaffold a React custom element that lists blog posts"
- "Create an object definition for event registrations with a name, email, and session relationship"
- "Add a globalCSS client extension that overrides the nav background"
- "Enable the feature flags needed for the headless page API"
- "Deploy and verify the theme client extension"

---

## Reference

- [Liferay Workspace](https://learn.liferay.com/w/dxp/development/tooling/liferay-workspace)
- [Client Extensions](https://learn.liferay.com/w/dxp/development/client-extensions)
- [Headless APIs](https://learn.liferay.com/w/dxp/integration/headless-apis)
- Workspace template in liferay-portal: `modules/sdk/project-templates/project-templates-workspace`
