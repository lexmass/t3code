import { codexAppServerArgs, resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as CodexClient from "effect-codex-app-server/client";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";

export class AgentSessionCatalogError extends Schema.TaggedError<AgentSessionCatalogError>()(
  "AgentSessionCatalogError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const ClaudeSessionIds = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ sessionId: Schema.String })),
);

const decodeClaudeSessionIds = Schema.decodeEffect(ClaudeSessionIds);

export const listClaudeSessionIds = Effect.fn("AgentSessionCatalog.listClaudeSessionIds")(
  function* (home: string) {
    const path = yield* Path.Path;
    const executable = yield* HostProcess.ExecutablePath;
    const environment = yield* HostProcess.Environment;
    const source = import.meta.url.endsWith(".ts");
    const args = (yield* HostProcess.IsExecutable)
      ? ["__claude-history"]
      : [
          ...(source ? ["--experimental-strip-types"] : []),
          yield* path.fromFileUrl(
            new URL(
              source ? "../claude-history-worker.ts" : "./claude-history-worker.mjs",
              import.meta.url,
            ),
          ),
        ];
    const result = yield* spawnAndCollect(
      executable,
      ChildProcess.make(executable, [...args, "listSessions", "unused", "{}"], {
        env: { ...environment, CLAUDE_CONFIG_DIR: home, ELECTRON_RUN_AS_NODE: "1" },
      }),
    );
    if (result.code !== 0)
      return yield* new AgentSessionCatalogError({ detail: "Claude session listing failed." });
    return new Set(
      (yield* decodeClaudeSessionIds(result.stdout)).map((session) => session.sessionId),
    );
  },
);

export interface CodexCatalogConfiguration {
  readonly home: string;
  readonly binary: string;
  readonly launchArgs: string;
  readonly environment: NodeJS.ProcessEnv;
}

const openCodexCatalog = Effect.fn("AgentSessionCatalog.openCodexCatalog")(function* (
  input: CodexCatalogConfiguration,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make(
      input.binary || "codex",
      codexAppServerArgs(resolveCodexLaunchArgs(input.launchArgs, input.environment)),
      {
        env: { ...input.environment, CODEX_HOME: input.home },
      },
    ),
  );
  const context = yield* Layer.build(CodexClient.layerChildProcess(handle));
  const client = Context.get(context, CodexClient.CodexAppServerClient);
  yield* client.request("initialize", { clientInfo: { name: "t3-session-browser", version: "1" } });
  yield* client.notify("initialized", undefined);
  return client;
});

export const listCodexSessions = Effect.fn("AgentSessionCatalog.listCodexSessions")(function* (
  input: CodexCatalogConfiguration,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const client = yield* openCodexCatalog(input);
      const sessions: CodexCatalogSession[] = [];
      for (const archived of [false, true]) {
        let cursor: string | undefined;
        do {
          const page = yield* client.request("thread/list", {
            limit: 100,
            archived,
            useStateDbOnly: true,
            modelProviders: [],
            sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
            ...(cursor ? { cursor } : {}),
          });
          sessions.push(
            ...page.data.map((thread) => ({
              id: thread.id,
              title:
                thread.name?.trim() ||
                thread.preview.trim().split("\n")[0]?.slice(0, 100) ||
                "Untitled Codex session",
              cwd: thread.cwd,
              path: thread.path ?? null,
              createdAt: DateTime.formatIso(DateTime.makeUnsafe(thread.createdAt * 1000)),
              updatedAt: DateTime.formatIso(DateTime.makeUnsafe(thread.updatedAt * 1000)),
            })),
          );
          cursor = page.nextCursor ?? undefined;
        } while (cursor && sessions.length < 5000);
        if (sessions.length >= 5000) break;
      }
      return sessions;
    }),
  );
});

export interface CodexCatalogSession {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly path: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface CodexHistoryMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export function codexHistoryMessages(
  thread: Pick<CodexSchema.V2ThreadReadResponse["thread"], "turns" | "createdAt">,
): ReadonlyArray<CodexHistoryMessage> {
  const messages: CodexHistoryMessage[] = [];
  let firstUser: CodexHistoryMessage | undefined;
  let bytes = 0;
  for (const turn of thread.turns) {
    const startedAt = turn.startedAt ?? thread.createdAt;
    const createdAt = DateTime.formatIso(
      DateTime.makeUnsafe(startedAt > 1e12 ? startedAt : startedAt * 1000),
    );
    for (const item of turn.items) {
      const text =
        item.type === "userMessage"
          ? item.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
          : item.type === "agentMessage"
            ? item.text
            : "";
      if (!text.trim()) continue;
      const message: CodexHistoryMessage = {
        role: item.type === "userMessage" ? "user" : "assistant",
        text,
        createdAt,
      };
      if (!firstUser && message.role === "user") firstUser = message;
      messages.push(message);
      bytes += text.length * 2;
      while (messages.length > 200 || bytes > 32 * 1024 * 1024)
        bytes -= messages.shift()!.text.length * 2;
    }
  }
  if (firstUser && !messages.includes(firstUser)) return [firstUser, ...messages.slice(-199)];
  return messages;
}

const readCodexSession = Effect.fn("AgentSessionCatalog.readCodexSession")(function* (
  input: CodexCatalogConfiguration,
  sessionId: string,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const client = yield* openCodexCatalog(input);
      const { thread } = yield* client.request("thread/read", {
        threadId: sessionId,
        includeTurns: true,
      });
      return codexHistoryMessages(thread);
    }),
  );
});

export class CodexSessionCatalog extends Context.Service<
  CodexSessionCatalog,
  {
    readonly list: (
      configuration: CodexCatalogConfiguration,
    ) => Effect.Effect<ReadonlyArray<CodexCatalogSession>, AgentSessionCatalogError>;
    readonly read: (
      configuration: CodexCatalogConfiguration,
      sessionId: string,
    ) => Effect.Effect<ReadonlyArray<CodexHistoryMessage>, AgentSessionCatalogError>;
  }
>()("t3/project/AgentSessionCatalog/CodexSessionCatalog") {}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return CodexSessionCatalog.of({
    list: Effect.fn("CodexSessionCatalog.list")((configuration) =>
      listCodexSessions(configuration).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(
          (cause) =>
            new AgentSessionCatalogError({ detail: "Could not list Codex sessions", cause }),
        ),
      ),
    ),
    read: Effect.fn("CodexSessionCatalog.read")((configuration, sessionId) =>
      readCodexSession(configuration, sessionId).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(
          (cause) =>
            new AgentSessionCatalogError({ detail: "Could not read Codex history", cause }),
        ),
      ),
    ),
  });
});

export const layer = Layer.effect(CodexSessionCatalog, make);
