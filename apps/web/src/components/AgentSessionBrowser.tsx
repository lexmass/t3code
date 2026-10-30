import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import type { AgentSessionBrowseResult } from "@t3tools/contracts";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { agentSessionBrowse, agentSessionImport } from "../state/agentSessions";
import { useAtomCommand } from "../state/use-atom-command";
import { formatEnvironmentQueryError } from "../state/query";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "./ui/dialog";

type Session = AgentSessionBrowseResult["sessions"][number];

export function AgentSessionBrowser({
  project,
  onClose,
}: {
  project: SidebarProjectSnapshot;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [selected, setSelected] = useState<Session | null>(null);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const result = useAtomValue(
    agentSessionBrowse({
      environmentId: project.environmentId,
      input: {
        workspaceRoot: project.workspaceRoot,
        ...(selected
          ? {
              preview: {
                providerInstanceId: selected.providerInstanceId,
                providerSessionId: selected.providerSessionId,
              },
            }
          : {}),
      },
    }),
  );
  const permission = useAtomValue(agentSessionImport.permissionAtom(project.environmentId));
  const importSession = useAtomCommand(agentSessionImport);
  const data = AsyncResult.getOrElse(result, () => null);
  const sessions = (data?.sessions ?? []).filter(
    (session) =>
      (provider === "all" || session.provider === provider) &&
      `${session.title} ${session.workspaceRoot} ${session.providerSessionId}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const preview = data?.sessions.find(
    (session) =>
      session.providerInstanceId === selected?.providerInstanceId &&
      session.providerSessionId === selected.providerSessionId,
  );
  const sessionKey = (session: Session) =>
    `${session.providerInstanceId}:${session.providerSessionId}`;
  const add = async (session: Session) => {
    setBusy(true);
    const outcome = await importSession({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        expectedWorkspaceRoot: project.workspaceRoot,
        sessions: [
          {
            providerInstanceId: session.providerInstanceId,
            providerSessionId: session.providerSessionId,
          },
        ],
      },
    });
    setBusy(false);
    if (outcome._tag === "Success") {
      if (outcome.value.importedCount > 0) {
        setAdded((current) => new Set([...current, sessionKey(session)]));
        setNotice("Session added. Open it in the sidebar to continue.");
      } else
        setNotice(
          "Session was already added, changed, or is no longer accessible. Refresh and try again.",
        );
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Local agent sessions</DialogTitle>
          <DialogDescription>
            {project.workspaceRoot} · Sessions on this environment
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <Input
              aria-label="Search sessions"
              placeholder="Search title or session ID…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <label className="flex items-center gap-2 text-sm">
              Provider
              <select
                aria-label="Filter provider"
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
              >
                <option value="all">All providers</option>
                <option value="codex">Codex</option>
                <option value="claudeAgent">Claude Code</option>
              </select>
            </label>
            <p className="text-xs text-muted-foreground">
              Text history includes the first request and up to 200 recent messages. Tools and
              attachments are not included. Continuing uses the original provider context.
            </p>
            {result._tag === "Failure" ? (
              <p role="alert">{formatEnvironmentQueryError(result.cause)}</p>
            ) : null}
            {result.waiting || result._tag === "Initial" ? (
              <p role="status">Reading local sessions…</p>
            ) : null}
            {data?.limited ? (
              <p role="status">Some sessions could not be read or exceeded the scan limits.</p>
            ) : null}
            <div className="max-h-64 space-y-2 overflow-auto">
              {sessions.map((session) => (
                <div key={sessionKey(session)} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <Button
                      variant="ghost"
                      className="max-w-full"
                      onClick={() => setSelected(session)}
                    >
                      <span className="block truncate">{session.title}</span>
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      {session.provider === "codex" ? "Codex" : "Claude Code"} ·{" "}
                      {new Date(session.updatedAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="shrink-0">
                    <Button
                      variant="outline"
                      disabled={
                        busy ||
                        !permission ||
                        added.has(sessionKey(session)) ||
                        (!!preview?.historyLimitation &&
                          sessionKey(session) === sessionKey(preview))
                      }
                      onClick={() => void add(session)}
                    >
                      {added.has(sessionKey(session))
                        ? "Added"
                        : session.resumeLimitation
                          ? "Add for viewing"
                          : "Add session"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            {data && !result.waiting && sessions.length === 0 ? (
              <p>No matching sessions found.</p>
            ) : null}
            {selected ? (
              <section
                aria-label="Conversation preview"
                className="max-h-80 space-y-3 overflow-auto border-t pt-3"
              >
                <h3 className="font-medium">{selected.title}</h3>
                <p className="text-xs">
                  {selected.resumeLimitation ??
                    "Native resume available. The provider checks availability when you send your next message."}
                </p>
                {preview?.historyLimitation ? (
                  <p role="alert">{preview.historyLimitation}</p>
                ) : null}
                {(preview?.messages ?? []).map((message) => (
                  <div key={message.id}>
                    <p className="text-xs font-medium">{message.role}</p>
                    <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>
                  </div>
                ))}
              </section>
            ) : null}
            {notice ? <p role="status">{notice}</p> : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
