---
name: authority-boundaries
description: Use when a task may cross from reading or proposing into writing, deployment, operations, identity, data mutation, or external communication.
version: 0.1.0
author: Your team
metadata:
  hermes:
    tags: [authority, approval, safety]
---

# Authority boundaries

Before any consequential action, identify:

1. the exact system, account, repository, environment, and target;
2. whether the requested operation is read, propose, implement, publish, deploy, or mutate live;
3. the human approval that authorizes this specific transition;
4. the credential and tool surface required, including what must remain unavailable;
5. the verification and recovery evidence expected after the action.

Do not infer a broader stage from a narrower one. Reading does not authorize writing. Preparing a
patch does not authorize publishing it. Opening a pull request does not authorize merging it.
Merging does not authorize production mutation unless that delivery path was explicitly approved.

If the requested result requires a different authority profile, stop and hand the bounded evidence
to that profile or a human owner.
