import { useState } from "react";
import { ArrowUpRight, Network, Square } from "lucide-react";
import type { EnvironmentId, PortForwardInput } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import { previewEnvironment } from "~/state/preview";
import { readPreparedConnection } from "~/state/session";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { readLocalApi } from "~/localApi";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "~/components/ui/dialog";
import { useDiscoveredLocalServers } from "./useDiscoveredLocalServers";

export function PortForwardingControl({ environmentId }: { environmentId: EnvironmentId }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" aria-label="Forward ports" />}>
        <Network className="size-4" />
        <span className="hidden sm:inline">Ports</span>
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Forward ports</DialogTitle>
          <DialogDescription>Open dev servers through an authenticated preview.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {open && <PortForwardingPanel key={environmentId} environmentId={environmentId} />}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function PortForwardingPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const connection = readPreparedConnection(environmentId);
  const local = connection && isLocalLoopbackHost(new URL(connection.httpBaseUrl).hostname);
  const snapshot = useEnvironmentQuery(
    previewEnvironment.forwardedPorts({ environmentId, input: {} }),
  );
  const execute = useAtomCommand(previewEnvironment.forwardPort);
  const discovered = useDiscoveredLocalServers({ environmentId });
  const [portText, setPortText] = useState("");
  const [protocol, setProtocol] = useState<"http" | "https">("http");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const forwards = snapshot.data?.forwards ?? [];
  const available = discovered.filter(
    (server) =>
      !snapshot.data?.reservedPorts.includes(server.port) &&
      !forwards.some(
        (forward) =>
          forward.port === server.port || Number(new URL(forward.previewUrl).port) === server.port,
      ),
  );
  const port = Number(portText);
  const valid = /^\d+$/.test(portText) && Number.isInteger(port) && port > 0 && port < 65536;

  const run = async (input: PortForwardInput) => {
    setBusy(true);
    setError(null);
    setOpenUrl(null);
    try {
      const result = await execute({ environmentId, input });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not update port forwarding.");
        return;
      }
      if (input._tag === "start") setPortText("");
      if (result.value.openUrl) {
        const url = result.value.openUrl;
        setOpenUrl(url);
        await readLocalApi()?.shell.openExternal(url);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not open the preview. Use the preview link below.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        Local preview: these URLs work on this machine. Remote previews aren’t available yet.
        Forwards stop when T3 restarts.
      </p>
      {!local && (
        <p role="alert" className="text-sm text-muted-foreground">
          Connect to a local environment to try port forwarding.
        </p>
      )}
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && local && !busy) void run({ _tag: "start", port, protocol });
        }}
      >
        <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs font-medium">
          Dev-server port
          <Input
            aria-label="Dev-server port"
            inputMode="numeric"
            placeholder="5173"
            value={portText}
            onChange={(event) => setPortText(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium">
          Protocol
          <select
            aria-label="Forwarding protocol"
            className="h-8.5 rounded-md border border-input bg-background px-2 sm:h-7.5"
            value={protocol}
            onChange={(event) => setProtocol(event.target.value === "https" ? "https" : "http")}
          >
            <option value="http">HTTP</option>
            <option value="https">HTTPS</option>
          </select>
        </label>
        <Button type="submit" size="sm" disabled={!local || !valid || busy || !snapshot.data}>
          Forward
        </Button>
      </form>
      {(error || snapshot.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? snapshot.error}
        </p>
      )}
      {snapshot.isPending && !snapshot.data && (
        <p className="text-sm text-muted-foreground">Loading forwarded ports…</p>
      )}
      {forwards.length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {forwards.map((forward) => (
            <li key={forward.port} className="flex items-center gap-2 px-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Port {forward.port}</p>
                <p className="text-xs text-muted-foreground">
                  {forward.protocol.toUpperCase()} · Forwarding locally
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !local}
                onClick={() => void run({ _tag: "open", port: forward.port })}
                aria-label={`Open forwarded port ${forward.port}`}
              >
                <ArrowUpRight className="size-4" />
                Open
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void run({ _tag: "stop", port: forward.port })}
                aria-label={`Stop forwarding port ${forward.port}`}
              >
                <Square className="size-3" />
                Stop
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        snapshot.data && <p className="text-sm text-muted-foreground">No ports forwarded yet.</p>
      )}
      {openUrl && (
        <a href={openUrl} target="_blank" rel="noreferrer" className="text-sm underline">
          Open preview if it did not open automatically
        </a>
      )}
      {available.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">Detected dev servers</h3>
          <div className="flex flex-wrap gap-2">
            {available.map((server) => (
              <Button
                key={server.port}
                variant="outline"
                size="sm"
                disabled={!local || busy || !snapshot.data}
                onClick={() =>
                  void run({
                    _tag: "start",
                    port: server.port,
                    protocol: server.requestedUrl.startsWith("https:") ? "https" : "http",
                  })
                }
              >
                Forward {server.port}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
