---
name: evidence-and-provenance
description: Use when a conclusion depends on evidence gathered from repositories, CI, issues, chat, telemetry, or runtime systems.
version: 0.1.0
author: Your team
metadata:
  hermes:
    tags: [evidence, provenance, investigation]
---

# Evidence and provenance

Build conclusions from the narrowest authoritative evidence available.

1. Identify the exact object under discussion: repository and revision, pull-request head, issue,
   deployment, alert, request, or runtime resource.
2. Prefer primary evidence and current state over summaries and old conversation.
3. Record the source, timestamp or revision, and relevant access boundary.
4. Separate confirmed facts from inferences, proposals, and unknowns.
5. Correlate identifiers before combining evidence from different systems.
6. Report missing or inaccessible evidence instead of filling gaps with a plausible story.
7. Keep citations close to the claim they support and minimize copied sensitive content.

A green process check proves only that process. Do not call a deployment, authenticated path,
business outcome, or safety boundary proven without evidence from that layer.
