import { describe, expect, test } from "bun:test";
import { type Repo, validate } from "../src/fleet-rules";
import { freshRepo } from "./helpers";

// biome-ignore lint/suspicious/noExplicitAny: fixtures edit arbitrary YAML documents.
type Any = any;

function profile(repo: Repo, name: string): Any {
  const all = [repo.fleet.default_profile, ...(repo.fleet.profiles as Any[])] as Any[];
  return all.find((entry) => entry.name === name);
}

// Applies the same edit to the fleet entry and to config.yaml, so only the rule under test fails.
function both(repo: Repo, name: string, edit: (entry: Any) => void) {
  edit(profile(repo, name));
  edit(repo.configs[name]);
}

function problemsAfter(change: (repo: Repo) => void): string[] {
  const repo = freshRepo();
  change(repo);
  return validate(repo);
}

function expectRefused(change: (repo: Repo) => void, fragment: string) {
  const problems = problemsAfter(change);
  expect(problems.some((problem) => problem.includes(fragment))).toBe(true);
}

describe("the template fleet", () => {
  test("satisfies the contract as shipped", () => {
    expect(validate(freshRepo())).toEqual([]);
  });
});

describe("prompts are not boundaries: Slack surfaces", () => {
  test("refuses web next to private data on the team profile", () => {
    expectRefused(
      (repo) => both(repo, "myagent-slack", (entry) => entry.platform_toolsets.slack.push("web")),
      "would open a way out",
    );
  });

  test("refuses a shell on a profile teammates can message", () => {
    expectRefused(
      (repo) =>
        both(repo, "myagent-slack", (entry) => entry.platform_toolsets.cli.push("terminal")),
      "only where nobody but the owner can message",
    );
  });

  test("refuses memory on a shared Slack surface", () => {
    expectRefused(
      (repo) =>
        both(repo, "myagent-slack", (entry) => entry.platform_toolsets.slack.push("memory")),
      "share one person's history",
    );
  });

  test("refuses a second user on the owner console", () => {
    expectRefused((repo) => {
      (repo.configs["myagent-admin"] as Any).slack.allow_from.push("U000TEAM01");
    }, "exactly [owner_slack_id]");
  });

  test("refuses link unfurling on a Slack profile", () => {
    expectRefused((repo) => {
      (repo.configs["myagent-slack"] as Any).slack.unfurl_links = true;
    }, "unfurling must be off");
  });

  test("refuses bot posts on the team profile", () => {
    expectRefused((repo) => {
      (repo.configs["myagent-slack"] as Any).slack.allow_bots = "all";
    }, "allow_bots must be none");
  });

  test("refuses memory on the team profile", () => {
    expectRefused((repo) => {
      (repo.configs["myagent-slack"] as Any).memory.memory_enabled = true;
    }, "keeps no memory");
  });

  test("refuses a shell on an outbound profile", () => {
    expectRefused(
      (repo) =>
        both(repo, "myagent-scheduled", (entry) => entry.platform_toolsets.cron.push("terminal")),
      "runs no shell next to its bot token",
    );
  });
});

describe("writes are bounded by reviewed lists", () => {
  test("refuses a delete tool", () => {
    expectRefused(
      (repo) =>
        both(repo, "myagent-slack", (entry) =>
          entry.mcp_servers.linear.tools.include.push("delete_issue"),
        ),
      "is a delete tool",
    );
  });

  test("refuses a write tool missing from reviewed_writes", () => {
    expectRefused(
      (repo) =>
        both(repo, "myagent-slack", (entry) =>
          entry.mcp_servers.linear.tools.include.push("create_project"),
        ),
      "list it in reviewed_writes",
    );
  });

  test("refuses a wildcard tool list", () => {
    expectRefused(
      (repo) =>
        both(repo, "myagent-slack", (entry) => {
          entry.mcp_servers.sentry.tools.include = ["*"];
        }),
      "invalid tool *",
    );
  });

  test("refuses a literal credential in a header", () => {
    expectRefused(
      (repo) =>
        both(repo, "myagent-slack", (entry) => {
          entry.mcp_servers.sentry.headers.Authorization = "Bearer abc123";
        }),
      "never a literal value",
    );
  });

  test("refuses a header naming an undeclared credential", () => {
    expectRefused(
      (repo) =>
        both(repo, "myagent-slack", (entry) => {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${NAME} reference is the value under test.
          entry.mcp_servers.sentry.headers.Authorization = "Bearer ${OTHER_TOKEN}";
        }),
      "which runtime_env does not declare",
    );
  });

  test("refuses a Slack token declared as a runtime credential", () => {
    expectRefused((repo) => {
      profile(repo, "myagent-slack").runtime_env.push("SLACK_USER_TOKEN");
    }, "prefix Hermes reserves");
  });
});

describe("hand-offs and workers", () => {
  test("refuses the raw kanban toolset", () => {
    expectRefused(
      (repo) =>
        both(repo, "myagent-slack", (entry) => entry.platform_toolsets.slack.push("kanban")),
      "raw kanban toolset",
    );
  });

  test("refuses a worker without the guard", () => {
    expectRefused((repo) => {
      both(repo, "myagent-writer", (entry) => {
        if (entry.plugins.enabled) entry.plugins.enabled = [];
        else entry.plugins = {};
      });
    }, "ships myagent-worker-guard");
  });

  test("refuses a workers.json entry that drifts from the fleet", () => {
    expectRefused((repo) => {
      (repo.handoffWorkers.handoff_document as Any).max_runtime_seconds = 3600;
    }, "workers.json handoff_document must match");
  });

  test("refuses a dispatcher that runs a profile which is not a worker", () => {
    expectRefused((repo) => {
      (repo.configs.default as Any).kanban.dispatch_profiles.push("myagent-slack");
    }, "list exactly the worker profiles");
  });

  test("refuses a worker reachable from Slack", () => {
    expectRefused(
      (repo) =>
        both(
          repo,
          "myagent-writer",
          (entry) => (entry.platform_toolsets.slack = ["skills", "no_mcp"]),
        ),
      "this one must be [no_mcp]",
    );
  });
});

describe("config.yaml mirrors the fleet", () => {
  test("refuses a config whose toolsets drift from the fleet entry", () => {
    expectRefused((repo) => {
      (repo.configs["myagent-slack"] as Any).platform_toolsets.cli.push("todo");
    }, "platform_toolsets must equal the fleet entry");
  });

  test("refuses a selected toolset that is still disabled", () => {
    expectRefused((repo) => {
      (repo.configs["myagent-slack"] as Any).agent.disabled_toolsets.push("skills");
    }, "must not list skills");
  });

  test("refuses an unselected toolset that is not disabled", () => {
    expectRefused((repo) => {
      const agent = (repo.configs["myagent-slack"] as Any).agent;
      agent.disabled_toolsets = agent.disabled_toolsets.filter((name: string) => name !== "web");
    }, "must list web");
  });

  test("refuses more than 25 turns on the shared Slack profile", () => {
    expectRefused((repo) => {
      (repo.configs["myagent-slack"] as Any).agent.max_turns = 40;
    }, "max_turns must be 1 to 25");
  });
});

describe("schedules", () => {
  test("refuses a job delivering to an undeclared target", () => {
    expectRefused((repo) => {
      (repo.cronJobs["myagent-scheduled"] as Any[])[0].failure_deliver = "slack:C000ELSEWHERE";
    }, "not local or a declared delivery target");
  });

  test("refuses cron jobs on a profile people can message", () => {
    expectRefused((repo) => {
      profile(repo, "myagent-slack").cron = ["standup-reminder"];
    }, "only a scheduled profile");
  });
});

describe("skills", () => {
  test("refuses the repository-write skill on the team profile", () => {
    expectRefused((repo) => {
      profile(repo, "myagent-slack").skills.push("change-workflow");
    }, "change-workflow only where no teammate can message");
  });

  test("refuses a skill that does not exist", () => {
    expectRefused((repo) => {
      profile(repo, "myagent-slack").skills.push("missing-skill");
    }, "must exist in shared/skills");
  });
});
