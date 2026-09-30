import { homeDir } from "../../../../platform/tauri/fs";
import {
  killChild,
  resolveClaudeBinary,
  spawnChild,
  unwatchChild,
  watchChild,
  writeChild,
} from "../../core/child";
import type { NativeCommand } from "../../core/nativeCommands";
import {
  buildClaudeSpawnArgs,
  buildControlRequest,
  nativeCommandsFromControlResponse,
  parseJsonLine,
} from "./claudeProtocol";

const PROBE_ID = "monocode-claude-commands-probe";
const INIT_REQUEST_ID = "monocode_commands_init";
const DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Cold-start command discovery: no live session exists yet (e.g. the
 * composer's `/` picker opened before the first turn), so a disposable
 * `claude` process is asked the same `initialize` handshake a live session
 * sends, and exits once it answers. No turn runs, so this costs nothing.
 */
export async function discoverClaudeCommands(cwd: string): Promise<NativeCommand[]> {
  const { path } = await resolveClaudeBinary();
  const probeCwd = cwd.trim() || (await homeDir());

  let resolveCommands: ((commands: NativeCommand[]) => void) | null = null;
  let rejectCommands: ((error: Error) => void) | null = null;
  const pending = new Promise<NativeCommand[]>((resolve, reject) => {
    resolveCommands = resolve;
    rejectCommands = reject;
  });

  const stop = async () => {
    unwatchChild(PROBE_ID);
    await killChild(PROBE_ID).catch(() => undefined);
  };

  watchChild(
    PROBE_ID,
    (line) => {
      const rec = parseJsonLine(line);
      if (!rec) return;
      const commands = nativeCommandsFromControlResponse(rec, INIT_REQUEST_ID);
      if (commands) resolveCommands?.(commands);
    },
    () => rejectCommands?.(new Error("Claude Code command probe exited")),
  );

  try {
    await spawnChild(
      PROBE_ID,
      path,
      buildClaudeSpawnArgs({ isolated: true, sessionId: crypto.randomUUID() }),
      probeCwd,
      undefined,
      "claude",
    );
    await writeChild(
      PROBE_ID,
      JSON.stringify(buildControlRequest(INIT_REQUEST_ID, { subtype: "initialize" })),
    );
    return await withTimeout(DISCOVERY_TIMEOUT_MS, pending, () => void stop());
  } finally {
    await stop();
  }
}

function withTimeout<T>(
  ms: number,
  promise: Promise<T>,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error("Claude Code command probe timed out"));
    }, ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
