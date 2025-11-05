import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

type PeerRole = 'sender' | 'receiver';

interface PeerSocket extends WebSocket {
  role?: PeerRole;
  shareId?: string;
}

interface Room {
  sender?: PeerSocket;
  receiver?: PeerSocket;
}

type SignalMessage =
  | { type: 'create'; shareId: string }
  | { type: 'join'; shareId: string }
  | { type: 'offer'; shareId: string; sdp: unknown }
  | { type: 'answer'; shareId: string; sdp: unknown }
  | { type: 'ice-candidate'; shareId: string; candidate: unknown }
  | { type: 'cancel'; shareId: string };

const rooms = new Map<string, Room>();
const WS_PATH = process.env.WS_PATH ?? '/ws';

export function attachWebSocketServer(server: Server) {
  const normalizedPath = WS_PATH.startsWith('/') ? WS_PATH : `/${WS_PATH}`;
  const wss = new WebSocketServer({ server, path: normalizedPath });

  wss.on('connection', (socket) => onConnect(socket as PeerSocket));
  console.log(`WebSocket signaling server is running on path ${normalizedPath}`);
}

function onConnect(ws: PeerSocket) {
  console.log('New client connected');

  ws.on('message', (raw) => {
    const payload = typeof raw === 'string' ? raw : raw.toString();
    let message: SignalMessage;

    try {
      message = JSON.parse(payload) as SignalMessage;
    } catch {
      safeSend(ws, { type: 'error', message: 'Invalid JSON payload' });
      return;
    }

    handleSignal(ws, message);
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    cleanupPeer(ws);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error', err);
    cleanupPeer(ws);
  });
}

function handleSignal(ws: PeerSocket, message: SignalMessage) {
  switch (message.type) {
    case 'create':
      return createShare(ws, message.shareId);
    case 'join':
      return joinShare(ws, message.shareId);
    case 'offer':
      return forwardToPeer(ws, message.shareId, 'receiver', {
        type: 'offer',
        shareId: message.shareId,
        sdp: message.sdp,
      });
    case 'answer':
      return forwardToPeer(ws, message.shareId, 'sender', {
        type: 'answer',
        shareId: message.shareId,
        sdp: message.sdp,
      });
    case 'ice-candidate':
      return forwardToPeer(
        ws,
        message.shareId,
        ws.role === 'sender' ? 'receiver' : 'sender',
        {
          type: 'ice-candidate',
          shareId: message.shareId,
          candidate: message.candidate,
        },
      );
    case 'cancel':
      return cancelShare(ws, message.shareId);
    default:
      return safeSend(ws, {
        type: 'error',
        message: `Unsupported message type ${(message as { type?: string })?.type ?? 'unknown'}`,
      });
  }
}

function createShare(ws: PeerSocket, shareId: string) {
  if (!shareId) {
    safeSend(ws, { type: 'error', message: 'shareId is required for create' });
    return;
  }

  const room = rooms.get(shareId);

  if (room?.sender) {
    safeSend(ws, { type: 'error', message: 'Share already exists. Pick a new link.' });
    return;
  }

  const nextRoom: Room = room ?? {};
  nextRoom.sender = ws;
  rooms.set(shareId, nextRoom);

  ws.role = 'sender';
  ws.shareId = shareId;
  safeSend(ws, { type: 'created', shareId });

  if (nextRoom.receiver) {
    safeSend(ws, { type: 'receiver-joined', shareId });
  }
}

function joinShare(ws: PeerSocket, shareId: string) {
  if (!shareId) {
    safeSend(ws, { type: 'error', message: 'shareId is required for join' });
    return;
  }

  const room = rooms.get(shareId);

  if (!room?.sender) {
    safeSend(ws, { type: 'error', message: 'Share not found or sender not connected' });
    return;
  }

  if (room.receiver) {
    safeSend(ws, { type: 'error', message: 'This share already has a receiver' });
    return;
  }

  room.receiver = ws;
  ws.role = 'receiver';
  ws.shareId = shareId;

  safeSend(ws, { type: 'joined', shareId });
  safeSend(room.sender, { type: 'receiver-joined', shareId });
  safeSend(ws, { type: 'sender-ready', shareId });
}

function forwardToPeer(
  ws: PeerSocket,
  shareId: string,
  targetRole: PeerRole,
  payload: Record<string, unknown>,
) {
  if (!shareId) {
    safeSend(ws, { type: 'error', message: 'shareId is required for signaling messages' });
    return;
  }

  const room = rooms.get(shareId);
  const target =
    targetRole === 'sender' ? room?.sender : targetRole === 'receiver' ? room?.receiver : undefined;

  if (!room || !target) {
    safeSend(ws, { type: 'error', message: `Target peer (${targetRole}) is not connected` });
    return;
  }

  safeSend(target, payload);
}

function cancelShare(ws: PeerSocket, shareId: string) {
  const room = rooms.get(shareId);
  if (!room) return;

  if (room.sender && room.sender !== ws) {
    safeSend(room.sender, { type: 'share-cancelled', shareId });
  }

  if (room.receiver && room.receiver !== ws) {
    safeSend(room.receiver, { type: 'share-cancelled', shareId });
  }

  rooms.delete(shareId);
}

function cleanupPeer(ws: PeerSocket) {
  const { shareId, role } = ws;
  if (!shareId || !role) return;

  const room = rooms.get(shareId);
  if (!room) return;

  if (role === 'sender' && room.sender === ws) {
    room.sender = undefined;
    if (room.receiver) {
      safeSend(room.receiver, { type: 'peer-disconnected', role: 'sender', shareId });
      room.receiver.close();
    }
  }

  if (role === 'receiver' && room.receiver === ws) {
    room.receiver = undefined;
    if (room.sender) {
      safeSend(room.sender, { type: 'peer-disconnected', role: 'receiver', shareId });
    }
  }

  const empty = !room.sender && !room.receiver;
  if (empty) {
    rooms.delete(shareId);
  }
}

function safeSend(ws: WebSocket | undefined, data: Record<string, unknown>) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(data));
}
