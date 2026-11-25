import type { Server } from "socket.io";

export type RealtimeEvent = "comment:created" | "comment:updated" | "comment:deleted";

let io: Server | null = null;

export function setRealtimeServer(server: Server): void {
  io = server;
}

/** The running Socket.IO server, or null where there is none (a test that imports only the app). */
export function realtimeServer(): Server | null {
  return io;
}

export function emitToVersion(versionId: string, event: RealtimeEvent, payload: unknown): void {
  io?.to(`version:${versionId}`).emit(event, payload);
}

export function emitToDocument(documentId: string, payload: unknown): void {
  io?.to(`document:${documentId}`).emit("version:created", payload);
}

export function emitToUser(userId: string, event: "mention", payload: unknown): void {
  io?.to(`user:${userId}`).emit(event, payload);
}
