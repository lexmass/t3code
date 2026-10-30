import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { render } from "../../test/render";
import { AgentSessionBrowser } from "./AgentSessionBrowser";

const state = vi.hoisted(() => ({ importSession: vi.fn() }));
vi.mock(import("../state/use-atom-command"), () => ({
  useAtomCommand: (() => state.importSession) as never,
}));
vi.mock(import("../state/agentSessions"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const atoms = Atom.family((previewId: string) =>
    Atom.make(
      AsyncResult.success({
        limited: false,
        sessions: [
          {
            provider: "codex",
            providerInstanceId: "codex",
            providerSessionId: "native-id",
            workspaceRoot: "/project",
            title: "Resume compiler",
            updatedAt: "2026-01-01T00:00:00Z",
            resumeLimitation: null,
            messages:
              previewId === "native-id"
                ? [
                    {
                      id: "m1",
                      role: "assistant",
                      text: "The previous compiler diagnosis",
                      createdAt: "2026-01-01T00:00:00Z",
                    },
                  ]
                : [],
          },
          {
            provider: "claudeAgent",
            providerInstanceId: "claudeAgent",
            providerSessionId: "claude-id",
            workspaceRoot: "/project",
            title: "Claude planning",
            updatedAt: "2026-01-01T00:00:00Z",
            resumeLimitation: "Invalid native ID; view only",
            messages: [],
          },
        ],
      }),
    ),
  );
  const allowed = Atom.make(true);
  return {
    agentSessionBrowse: (({ input }: { input: { preview?: { providerSessionId: string } } }) =>
      atoms(input.preview?.providerSessionId ?? "")) as never,
    agentSessionImport: { permissionAtom: () => allowed } as never,
    agentSessionScan: (() => allowed) as never,
  };
});

it("previews existing history, searches sessions, and imports only the selected native identity", async () => {
  state.importSession
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { importedCount: 1, skippedCount: 0 } });
  await using screen = await render(
    <AgentSessionBrowser
      project={
        {
          id: ProjectId.make("project"),
          environmentId: EnvironmentId.make("primary"),
          workspaceRoot: "/project",
        } as never
      }
      onClose={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Resume compiler", exact: true }).click();
  await expect.element(screen.getByText("The previous compiler diagnosis")).toBeVisible();
  await screen.getByRole("textbox", { name: "Search sessions" }).fill("compiler");
  await expect
    .element(screen.getByRole("button", { name: "Claude planning", exact: true }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Add session", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "Added", exact: true })).toBeVisible();
  expect(state.importSession).toHaveBeenCalledWith({
    environmentId: "primary",
    input: {
      projectId: "project",
      expectedWorkspaceRoot: "/project",
      sessions: [{ providerInstanceId: "codex", providerSessionId: "native-id" }],
    },
  });
});
