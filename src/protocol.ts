import type { Socket } from "node:net";

export interface MainIdentity {
  id: string;
  piSessionId: string;
  pid: number;
  role: "primary";
  parentPiSessionId?: string;
  name?: string;
  projectRoot?: string;
  branch?: string;
}

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export function readFrames(
  socket: Socket,
  onFrame: (frame: Record<string, unknown>) => void,
  onError: (error: unknown) => void = () => {},
) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      let boundary;
      while ((boundary = buffer.indexOf(10)) !== -1) {
        if (boundary > MAX_FRAME_BYTES)
          throw new Error("IPC frame is too large");
        const line = buffer.subarray(0, boundary).toString("utf8");
        buffer = buffer.subarray(boundary + 1);
        const value = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Invalid IPC frame");
        onFrame(value);
      }
      if (buffer.length > MAX_FRAME_BYTES)
        throw new Error("IPC frame is too large");
    } catch (error) {
      onError(error);
      socket.destroy();
    }
  });
}

export function writeFrame(socket: Socket, value: unknown) {
  const frame = `${JSON.stringify(value)}\n`;
  if (
    Buffer.byteLength(frame) > MAX_FRAME_BYTES ||
    socket.writableLength > MAX_FRAME_BYTES ||
    socket.destroyed
  ) {
    socket.destroy();
    throw new Error("IPC connection unavailable or overloaded");
  }
  socket.write(frame);
}

export function isMain(value: unknown): value is MainIdentity {
  const identity = value as MainIdentity | null;
  return (
    identity &&
    typeof identity.id === "string" &&
    identity.id.length > 0 &&
    typeof identity.piSessionId === "string" &&
    identity.piSessionId.length > 0 &&
    Number.isSafeInteger(identity.pid) &&
    identity.pid > 0 &&
    identity.role === "primary" &&
    !identity.parentPiSessionId
  );
}
