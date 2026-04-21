import { Socket, Channel } from "phoenix";
import { SOCKET_URL } from "./config";

let socket: Socket | null = null;

export function getSocket(nickname: string): Socket {
  if (!socket) {
    socket = new Socket(SOCKET_URL, { params: { nickname } });
    socket.connect();
  }
  return socket;
}

export function joinGroup(nickname: string, groupId: string): Channel {
  const sock = getSocket(nickname);
  return sock.channel(`group:${groupId}`, {});
}

export function joinMetrics(nickname: string): Channel {
  const sock = getSocket(nickname);
  return sock.channel("metrics:live", {});
}
