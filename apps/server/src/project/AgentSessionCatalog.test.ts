import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  codexHistoryMessages,
  listClaudeSessionIds,
  listCodexSessions,
} from "./AgentSessionCatalog.ts";

it.live(
  "discovers Claude sessions in an isolated configured home without changing transcripts or the host environment",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-catalog-" });
      const project = path.join(home, "projects", "-project");
      yield* fs.makeDirectory(project, { recursive: true });
      const id = "020e7f00-dce6-406b-8ec6-ed90498945d6";
      const file = path.join(project, `${id}.jsonl`);
      const contents =
        JSON.stringify({
          type: "user",
          uuid: id,
          sessionId: id,
          cwd: "/project",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "Find my conversation" },
        }) + "\n";
      yield* fs.writeFileString(file, contents);
      const environment = yield* HostProcess.Environment;
      const configuredHome = environment.CLAUDE_CONFIG_DIR;
      const ids = yield* listClaudeSessionIds(home);
      expect(ids.has(id)).toBe(true);
      expect(yield* fs.readFileString(file)).toBe(contents);
      expect(environment.CLAUDE_CONFIG_DIR).toBe(configuredHome);
      const failed = yield* listCodexSessions({
        home,
        binary: path.join(home, "missing-codex"),
        launchArgs: "",
        environment,
      }).pipe(Effect.result);
      expect(failed._tag).toBe("Failure");
      expect(yield* fs.readFileString(file)).toBe(contents);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("renders native paginated user and assistant history while retaining the first request and recent text", () => {
  const messages = codexHistoryMessages({
    createdAt: 1767225600,
    turns: [
      {
        id: "turn",
        status: "completed",
        startedAt: 1767225600,
        items: [
          {
            type: "userMessage",
            id: "first",
            content: [{ type: "text", text: "First request", text_elements: [] }],
          },
          { type: "plan", id: "tool", text: "Do not render as an assistant message" },
          ...Array.from({ length: 210 }, (_, index) => ({
            type: "agentMessage" as const,
            id: `a${index}`,
            text: `Answer ${index}`,
          })),
        ],
      },
    ],
  });
  expect(messages).toHaveLength(200);
  expect(messages[0]).toEqual({
    role: "user",
    text: "First request",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  expect(messages[1]?.text).toBe("Answer 11");
  expect(messages.at(-1)?.text).toBe("Answer 209");
});

it("bounds the first native request as well as the recent history", () => {
  const messages = codexHistoryMessages({
    createdAt: 1767225600,
    turns: [
      {
        id: "large",
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "first",
            content: [{ type: "text", text: "x".repeat(17 * 1024 * 1024), text_elements: [] }],
          },
          { type: "agentMessage", id: "answer", text: "Latest answer" },
        ],
      },
    ],
  });
  expect(messages[0]?.text.length).toBe(64 * 1024);
  expect(messages.at(-1)?.text).toBe("Latest answer");
});
