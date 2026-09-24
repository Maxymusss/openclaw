---
summary: "GitHub links use the real Browser panel; the bundled preview/reader is retired"
title: "GitHub"
doc-schema-version: 1
read_when:
  - You want GitHub links to open beside your conversation
  - You are upgrading an installation configured with the former GitHub reader plugin
---

# GitHub

GitHub links now use the existing [Browser panel](/web/control-ui/panels#browser-panel),
which displays the actual GitHub website rather than a read-only API rendering.
The bundled `github` preview/reader plugin has been removed.

In the macOS app, unmodified external links open native Mac tabs. In a regular
browser, enable **Open links in Control UI browser** under **Settings →
Infrastructure → Browser** to open links in Agent browser tabs. Without that
preference or an available Browser panel, links use normal browser navigation.
Browser sessions own GitHub sign-in and website interaction.

<a id="read-an-item-beside-chat" />
<a id="enable-or-disable-the-plugin" />
<a id="limits-and-unavailable-content" />
<a id="plugin-author-integration" />

## Upgrading with an existing plugin allowlist

The former `plugins.entries.github` entry and `github` entries in `plugins.allow`
or `plugins.deny` are retired. Existing entries produce a warning rather than
blocking startup. Run `openclaw doctor --fix` to remove stale references through
the normal configuration repair flow; keep other plugin entries unchanged.
There is no replacement reader setting or plugin to enable.

GitHub publishing, managed GitHub identities, repository access, and session
pull-request status are unchanged. Keep their credentials and configuration.
The [GitHub Copilot model provider](/providers/github-copilot) is separate and
is not affected.
