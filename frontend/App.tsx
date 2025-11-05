import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

type SenderStatus = "idle" | "creating" | "waiting" | "transferring" | "complete" | "error";
type ReceiverStatus = "connecting" | "waiting" | "establishing" | "receiving" | "complete" | "error";

type FileMetadata = {
  name: string;
  size: number;
  mime?: string;
};

type ServerMessage = {
  type: string;
  [key: string]: unknown;
};

export default function App() {
  const shareId = useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("shareId");
  }, []);

  const signalingUrl = useMemo(resolveSignalingUrl, []);

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-[#e5e5e5] flex items-center justify-center p-6">
      <div className="w-full max-w-3xl">
        {shareId ? (
          <ReceiverView shareId={shareId} signalingUrl={signalingUrl} />
        ) : (
          <SenderView signalingUrl={signalingUrl} />
        )}
      </div>
    </div>
  );
}

function SenderView({ signalingUrl }: { signalingUrl: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [shareUrl, setShareUrl] = useState<string>("");
  const [shareId, setShareId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<SenderStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [bytesSent, setBytesSent] = useState(0);
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const fileRef = useRef<File | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const shareIdRef = useRef<string | null>(null);
  const statusRef = useRef<SenderStatus>("idle");
  const errorRef = useRef<string | null>(null);
  const closingRef = useRef(false);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  useEffect(() => {
    fileRef.current = file;
  }, [file]);

  useEffect(() => {
    shareIdRef.current = shareId;
  }, [shareId]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    errorRef.current = error;
  }, [error]);

  const sendSignaling = useCallback((payload: Record<string, unknown>) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }, []);

  const cleanup = useCallback(
    (notifyCancel: boolean) => {
      const socket = wsRef.current;
      if (
        notifyCancel &&
        socket &&
        socket.readyState === WebSocket.OPEN &&
        shareIdRef.current
      ) {
        socket.send(
          JSON.stringify({ type: "cancel", shareId: shareIdRef.current }),
        );
      }

      const channel = dataChannelRef.current;
      if (channel) {
        channel.onopen = null;
        channel.onclose = null;
        channel.onmessage = null;
        try {
          channel.close();
        } catch {
          // ignore
        }
        dataChannelRef.current = null;
      }

      const peer = pcRef.current;
      if (peer) {
        peer.onicecandidate = null;
        peer.onconnectionstatechange = null;
        try {
          peer.close();
        } catch {
          // ignore
        }
        pcRef.current = null;
      }

      if (socket) {
        closingRef.current = true;
        socket.onmessage = null;
        socket.onopen = null;
        try {
          socket.close();
        } catch {
          // ignore
        }
      }

      wsRef.current = null;
      pendingCandidatesRef.current = [];
    },
    [],
  );

  useEffect(() => {
    return () => {
      cleanup(false);
    };
  }, [cleanup]);

  const startPeerConnection = useCallback(async () => {
    if (!fileRef.current || !shareIdRef.current) return;
    if (pcRef.current) return;

    try {
      const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = peer;

      peer.onicecandidate = (event) => {
        if (event.candidate && shareIdRef.current) {
          sendSignaling({
            type: "ice-candidate",
            shareId: shareIdRef.current,
            candidate: event.candidate,
          });
        }
      };

      peer.onconnectionstatechange = () => {
        setConnectionState(peer.connectionState);
        if (
          (peer.connectionState === "failed" ||
            peer.connectionState === "disconnected") &&
          statusRef.current !== "complete"
        ) {
          setStatus("error");
          if (!errorRef.current) {
            setError("Peer connection failed");
          }
        }
      };

      const channel = peer.createDataChannel("file", { ordered: true });
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = 512 * 1024;
      dataChannelRef.current = channel;

      channel.onopen = () => {
        setStatus("transferring");
        setBytesSent(0);
        const currentFile = fileRef.current;
        if (!currentFile) return;
        void sendFileOverChannel(channel, currentFile, setBytesSent)
          .then(() => {
            setStatus("complete");
            setTimeout(() => {
              cleanup(false);
            }, 1200);
          })
          .catch((err) => {
            console.error("Failed to send file", err);
            setError(
              err instanceof Error ? err.message : "Failed to send file",
            );
            setStatus("error");
            cleanup(true);
          });
      };

      channel.onclose = () => {
        if (
          statusRef.current !== "complete" &&
          statusRef.current !== "error"
        ) {
          setStatus("error");
          if (!errorRef.current) {
            setError("Data channel closed unexpectedly");
          }
        }
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      sendSignaling({
        type: "offer",
        shareId: shareIdRef.current,
        sdp: offer,
      });
    } catch (err) {
      console.error("Failed to start peer connection", err);
      setError(
        err instanceof Error ? err.message : "Failed to start peer connection",
      );
      setStatus("error");
      cleanup(true);
    }
  }, [cleanup, sendSignaling]);

  const handleServerMessage = useCallback(
    async (event: MessageEvent) => {
      let data: ServerMessage;
      try {
        const text =
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);
        data = JSON.parse(text) as ServerMessage;
      } catch (err) {
        console.warn("Invalid signaling message", err);
        return;
      }

      switch (data.type) {
        case "created":
          setStatus("waiting");
          break;
        case "receiver-joined":
          setStatus("waiting");
          await startPeerConnection();
          break;
        case "answer": {
          const peer = pcRef.current;
          if (peer && data.sdp) {
            try {
              await peer.setRemoteDescription(
                new RTCSessionDescription(
                  data.sdp as RTCSessionDescriptionInit,
                ),
              );
              const queued = pendingCandidatesRef.current.splice(0);
              for (const candidate of queued) {
                try {
                  await peer.addIceCandidate(candidate);
                } catch (candidateErr) {
                  console.error("Failed to add queued ICE candidate", candidateErr);
                }
              }
            } catch (err) {
              console.error("Failed to apply answer", err);
              setError(
                err instanceof Error ? err.message : "Failed to apply answer",
              );
              setStatus("error");
              cleanup(true);
            }
          }
          break;
        }
        case "ice-candidate": {
          const candidate = data.candidate as RTCIceCandidateInit | undefined;
          if (!candidate) break;
          const peer = pcRef.current;
          if (peer && peer.remoteDescription) {
            try {
              await peer.addIceCandidate(candidate);
            } catch (err) {
              console.error("Failed to add ICE candidate", err);
            }
          } else {
            pendingCandidatesRef.current.push(candidate);
          }
          break;
        }
        case "peer-disconnected":
          if (statusRef.current !== "complete") {
            setStatus("waiting");
          }
          break;
        case "share-cancelled":
          setError("Share was cancelled");
          setStatus("error");
          cleanup(false);
          break;
        case "error":
          setError(
            (data.message as string) ?? "Signaling server returned an error",
          );
          setStatus("error");
          cleanup(false);
          break;
        default:
          break;
      }
    },
    [cleanup, startPeerConnection],
  );

  const openSocket = useCallback((): Promise<WebSocket> => {
    const existing = wsRef.current;
    if (existing) {
      if (existing.readyState === WebSocket.OPEN) {
        return Promise.resolve(existing);
      }
      if (existing.readyState === WebSocket.CONNECTING) {
        return new Promise((resolve, reject) => {
          const handleOpen = () => resolve(existing);
          const handleError = () =>
            reject(new Error("Failed to open signaling socket"));
          existing.addEventListener("open", handleOpen, { once: true });
          existing.addEventListener("error", handleError, { once: true });
        });
      }
    }

    return new Promise((resolve, reject) => {
      let resolved = false;
      const socket = new WebSocket(signalingUrl);
      wsRef.current = socket;
      closingRef.current = false;

      socket.addEventListener(
        "open",
        () => {
          resolved = true;
          resolve(socket);
        },
        { once: true },
      );

      socket.addEventListener(
        "error",
        () => {
          if (!resolved) {
            reject(new Error("Unable to connect to signaling server"));
          }
        },
        { once: true },
      );

      socket.onmessage = (evt) => {
        void handleServerMessage(evt);
      };

      socket.onclose = () => {
        const wasClosing = closingRef.current;
        closingRef.current = false;
        wsRef.current = null;
        if (!wasClosing && statusRef.current !== "complete") {
          if (!errorRef.current) {
            setError("Signaling connection closed");
          }
          setStatus("error");
          cleanup(false);
        }
      };
    });
  }, [cleanup, handleServerMessage, signalingUrl]);

  const onFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null;
    if (shareIdRef.current) {
      cleanup(true);
      shareIdRef.current = null;
    }
    setCopied(false);
    setError(null);
    setShareUrl("");
    setShareId(null);
    setStatus("idle");
    setBytesSent(0);
    setConnectionState(null);
    setFile(selected);
  }, [cleanup]);

  const generateShare = useCallback(async () => {
    if (!fileRef.current) return;
    try {
      setError(null);
      setStatus("creating");
      const newShareId = generateShareId();
      setShareId(newShareId);
      shareIdRef.current = newShareId;
      const link = `${window.location.origin}?shareId=${newShareId}`;
      setShareUrl(link);

      const socket = await openSocket();
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("Signaling socket is not ready");
      }

      socket.send(JSON.stringify({ type: "create", shareId: newShareId }));
    } catch (err) {
      console.error("Failed to create share", err);
      setError(err instanceof Error ? err.message : "Failed to create share");
      setStatus("error");
    }
  }, [openSocket]);

  const copyLink = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      console.error("Failed to copy link", err);
      setError("Failed to copy link");
    }
  }, [shareUrl]);

  const reset = useCallback(() => {
    cleanup(true);
    setFile(null);
    setShareId(null);
    shareIdRef.current = null;
    setShareUrl("");
    setCopied(false);
    setBytesSent(0);
    setStatus("idle");
    setError(null);
    setConnectionState(null);
    formRef.current?.reset();
  }, [cleanup]);

  const totalBytes = file?.size ?? 0;
  const progress = totalBytes > 0 ? Math.floor((bytesSent / totalBytes) * 100) : 0;

  const statusMessage: Record<SenderStatus, string> = {
    idle: "Pick a file, then generate a one-time link.",
    creating: "Preparing share link…",
    waiting: "Link ready. Waiting for the receiver to connect.",
    transferring: "Streaming file peer-to-peer… keep this tab open.",
    complete: "Transfer complete! You can start a new share if needed.",
    error: error ?? "Something went wrong.",
  };

  return (
    <div className="rounded-2xl shadow-xl border border-[#242424] bg-[#141414]/95 backdrop-blur p-6 md:p-8">
      <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">P2P File Share</h1>
      <p className="text-sm text-[#9aa1a9] mt-1">
        Files move directly between peers using WebRTC data channels. No server storage.
      </p>

      <form
        ref={formRef}
        className="mt-6 space-y-4"
        onSubmit={(event) => event.preventDefault()}
      >
        <label className="block">
          <span className="text-sm text-[#c9ced4]">Choose file</span>
          <input
            type="file"
            onChange={onFileChange}
            disabled={status === "transferring"}
            className="mt-2 block w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-medium file:bg-[#e25c49] file:text-white hover:file:bg-[#f06a57] disabled:opacity-50 cursor-pointer"
          />
        </label>

        {file && (
          <div className="text-sm text-[#c9ced4] flex items-center justify-between bg-[#191919] rounded-xl px-4 py-3 border border-[#242424]">
            <div className="truncate">
              <span className="text-[#9aa1a9]">Selected:</span>{" "}
              <span className="font-medium">{file.name}</span>
              <span className="text-[#7b828a] ml-2">{formatBytes(file.size)}</span>
            </div>
            <button
              type="button"
              onClick={reset}
              className="text-[#9aa1a9] hover:text-[#e5e5e5] ml-3"
              disabled={status === "transferring"}
            >
              Reset
            </button>
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={generateShare}
            disabled={!file || status === "creating" || status === "waiting" || status === "transferring"}
            className="inline-flex items-center justify-center rounded-xl bg-[#e25c49] px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[#f06a57] transition"
          >
            {status === "creating" ? "Generating…" : "Generate URL"}
          </button>
          {!file && <span className="text-xs text-[#7b828a]">Pick a file to enable</span>}
        </div>
      </form>

      {shareUrl && (
        <div className="mt-6 space-y-2">
          <span className="text-sm text-[#c9ced4]">Share URL</span>
          <div className="flex items-stretch gap-2">
            <input
              readOnly
              value={shareUrl}
              className="flex-1 rounded-xl bg-[#191919] border border-[#242424] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#e25c49] focus:border-transparent"
            />
            <button
              type="button"
              onClick={copyLink}
              className="rounded-xl bg-[#191919] border border-[#242424] px-3 py-2 text-sm hover:bg-[#222222]"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <p className="text-xs text-[#7b828a]">Send this to the receiver. Keep this page open until the transfer finishes.</p>
        </div>
      )}

      <div className="mt-6 rounded-xl border border-[#242424] bg-[#191919] px-4 py-3 text-sm text-[#c9ced4] space-y-2">
        <div className="flex items-center justify-between">
          <span>Status</span>
          <span className="text-[#9aa1a9]">{statusMessage[status]}</span>
        </div>
        {status === "transferring" || status === "complete" ? (
          <div>
            <div className="flex items-center justify-between text-xs text-[#7b828a] mb-1">
              <span>{formatBytes(bytesSent)}</span>
              <span>{progress}%</span>
            </div>
            <div className="h-2 rounded-full bg-[#242424] overflow-hidden">
              <div
                className="h-full bg-[#e25c49] transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        ) : null}
        {connectionState && (
          <p className="text-xs text-[#7b828a]">Peer connection: {connectionState}</p>
        )}
        {error && status === "error" && (
          <p className="text-xs text-red-400">Error: {error}</p>
        )}
      </div>
    </div>
  );
}

function ReceiverView({
  shareId,
  signalingUrl,
}: {
  shareId: string;
  signalingUrl: string;
}) {
  const [status, setStatus] = useState<ReceiverStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<FileMetadata | null>(null);
  const [bytesReceived, setBytesReceived] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const chunksRef = useRef<ArrayBuffer[]>([]);
  const statusRef = useRef<ReceiverStatus>("connecting");
  const errorRef = useRef<string | null>(null);
  const closingRef = useRef(false);
  const metadataRef = useRef<FileMetadata | null>(null);
  const downloadUrlRef = useRef<string | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    errorRef.current = error;
  }, [error]);

  useEffect(() => {
    metadataRef.current = metadata;
  }, [metadata]);

  useEffect(() => {
    if (downloadUrlRef.current && downloadUrlRef.current !== downloadUrl) {
      URL.revokeObjectURL(downloadUrlRef.current);
    }
    downloadUrlRef.current = downloadUrl;
  }, [downloadUrl]);

  useEffect(() => {
    return () => {
      if (downloadUrlRef.current) {
        URL.revokeObjectURL(downloadUrlRef.current);
      }
    };
  }, []);

  const cleanupPeer = useCallback(() => {
    const channel = dataChannelRef.current;
    if (channel) {
      channel.onmessage = null;
      channel.onopen = null;
      channel.onclose = null;
      try {
        channel.close();
      } catch {
        // ignore
      }
      dataChannelRef.current = null;
    }

    const peer = pcRef.current;
    if (peer) {
      peer.onicecandidate = null;
      peer.ondatachannel = null;
      peer.onconnectionstatechange = null;
      try {
        peer.close();
      } catch {
        // ignore
      }
      pcRef.current = null;
    }
  }, []);

  const sendSignaling = useCallback(
    (payload: Record<string, unknown>) => {
      const socket = wsRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ ...payload, shareId }));
      }
    },
    [shareId],
  );

  const finalizeFile = useCallback(() => {
    const meta = metadataRef.current;
    if (!meta) return;
    const blob = new Blob(chunksRef.current, {
      type: meta.mime || "application/octet-stream",
    });
    chunksRef.current = [];
    const url = URL.createObjectURL(blob);
    setDownloadUrl(url);
    statusRef.current = "complete";
    setStatus("complete");
  }, []);

  const handleDataChannelMessage = useCallback(
    async (event: MessageEvent) => {
      const { data } = event;
      if (typeof data === "string") {
        try {
          const parsed = JSON.parse(data) as { type: string; [key: string]: unknown };
          if (parsed.type === "metadata") {
            const meta: FileMetadata = {
              name: String(parsed.name ?? "download"),
              size: Number(parsed.size ?? 0),
              mime: typeof parsed.mime === "string" ? (parsed.mime || undefined) : undefined,
            };
            chunksRef.current = [];
            setBytesReceived(0);
            setMetadata(meta);
            setStatus("receiving");
          } else if (parsed.type === "complete") {
            finalizeFile();
            cleanupPeer();
          }
        } catch (err) {
          console.error("Failed to parse channel message", err);
        }
        return;
      }

      if (data instanceof ArrayBuffer) {
        chunksRef.current.push(data);
        setBytesReceived((prev) => prev + data.byteLength);
        return;
      }

      if (data instanceof Blob) {
        try {
          const buffer = await data.arrayBuffer();
          chunksRef.current.push(buffer);
          setBytesReceived((prev) => prev + buffer.byteLength);
        } catch (err) {
          console.error("Failed to read blob chunk", err);
        }
      }
    },
    [cleanupPeer, finalizeFile],
  );

  const setupDataChannel = useCallback(
    (channel: RTCDataChannel) => {
      dataChannelRef.current = channel;
      channel.binaryType = "arraybuffer";
      channel.onmessage = (evt) => {
        void handleDataChannelMessage(evt);
      };
      channel.onopen = () => {
        setStatus((prev) => (prev === "establishing" ? "receiving" : prev));
      };
      channel.onclose = () => {
        if (
          statusRef.current !== "complete" &&
          statusRef.current !== "error"
        ) {
          setStatus("error");
          if (!errorRef.current) {
            setError("Data channel closed unexpectedly");
          }
        }
      };
    },
    [handleDataChannelMessage],
  );

  const acceptOffer = useCallback(
    async (offer: RTCSessionDescriptionInit) => {
      try {
        let peer = pcRef.current;
        if (!peer) {
          peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
          pcRef.current = peer;
          peer.onicecandidate = (event) => {
            if (event.candidate) {
              sendSignaling({ type: "ice-candidate", candidate: event.candidate });
            }
          };
          peer.ondatachannel = (event) => {
            setupDataChannel(event.channel);
          };
          peer.onconnectionstatechange = () => {
            if (peer) {
              if (peer.connectionState === "failed") {
                setStatus("error");
                if (!errorRef.current) {
                  setError("Peer connection failed");
                }
                cleanupPeer();
              }
            }
          };
        }

        await peer.setRemoteDescription(offer);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        sendSignaling({ type: "answer", sdp: answer });
        setStatus("establishing");

        const queued = pendingCandidatesRef.current.splice(0);
        for (const candidate of queued) {
          try {
            await peer.addIceCandidate(candidate);
          } catch (candidateErr) {
            console.error("Failed to apply queued ICE candidate", candidateErr);
          }
        }
      } catch (err) {
        console.error("Failed to accept offer", err);
        setError(err instanceof Error ? err.message : "Failed to accept offer");
        setStatus("error");
        cleanupPeer();
      }
    },
    [cleanupPeer, sendSignaling, setupDataChannel],
  );

  const handleServerMessage = useCallback(
    async (event: MessageEvent) => {
      let data: ServerMessage;
      try {
        const text =
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);
        data = JSON.parse(text) as ServerMessage;
      } catch (err) {
        console.warn("Invalid signaling message", err);
        return;
      }

      switch (data.type) {
        case "sender-ready":
          setStatus((prev) => (prev === "connecting" ? "waiting" : prev));
          break;
        case "offer":
          if (data.sdp) {
            await acceptOffer(data.sdp as RTCSessionDescriptionInit);
          }
          break;
        case "ice-candidate": {
          const candidate = data.candidate as RTCIceCandidateInit | undefined;
          if (!candidate) break;
          const peer = pcRef.current;
          if (peer && peer.remoteDescription) {
            try {
              await peer.addIceCandidate(candidate);
            } catch (err) {
              console.error("Failed to add ICE candidate", err);
            }
          } else {
            pendingCandidatesRef.current.push(candidate);
          }
          break;
        }
        case "share-cancelled":
          setError("Sender cancelled the share");
          setStatus("error");
          cleanupPeer();
          break;
        case "peer-disconnected":
          if (data.role === "sender") {
            if (statusRef.current === "complete") {
              setStatus("complete");
            } else {
              setError("Sender disconnected");
              setStatus("error");
              cleanupPeer();
            }
          }
          break;
        case "error":
          setError(
            (data.message as string) ?? "Signaling server reported an error",
          );
          setStatus("error");
          cleanupPeer();
          break;
        default:
          break;
      }
    },
    [acceptOffer, cleanupPeer],
  );

  useEffect(() => {
    const socket = new WebSocket(signalingUrl);
    wsRef.current = socket;
    closingRef.current = false;

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "join", shareId }));
      setStatus("waiting");
    };

    socket.onmessage = (event) => {
      void handleServerMessage(event);
    };

    socket.onerror = () => {
      if (statusRef.current !== "error") {
        setError("Unable to connect to signaling server");
        setStatus("error");
      }
    };

    socket.onclose = () => {
      const wasClosing = closingRef.current;
      closingRef.current = false;
      wsRef.current = null;
      if (!wasClosing && statusRef.current !== "complete") {
        if (!errorRef.current) {
          setError("Connection to signaling server closed");
        }
        setStatus("error");
        cleanupPeer();
      }
    };

    return () => {
      closingRef.current = true;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      cleanupPeer();
    };
  }, [cleanupPeer, handleServerMessage, shareId, signalingUrl]);

  const totalBytes = metadata?.size ?? 0;
  const progress =
    totalBytes > 0 ? Math.floor((bytesReceived / totalBytes) * 100) : 0;

  const statusMessage: Record<ReceiverStatus, string> = {
    connecting: "Connecting to signaling server…",
    waiting: "Waiting for sender to respond…",
    establishing: "Negotiating peer connection…",
    receiving: "Receiving file directly from sender…",
    complete: "Download ready!",
    error: error ?? "Something went wrong.",
  };

  return (
    <div className="rounded-2xl shadow-xl border border-[#242424] bg-[#141414]/95 backdrop-blur p-6 md:p-8">
      <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Incoming Transfer</h1>
      <p className="text-sm text-[#9aa1a9] mt-1">
        Keep this tab open. Once the sender connects, the file streams straight to your device.
      </p>

      <div className="mt-6 rounded-xl border border-[#242424] bg-[#191919] px-4 py-3 text-sm text-[#c9ced4] space-y-3">
        <div className="flex items-center justify-between">
          <span>Status</span>
          <span className="text-[#9aa1a9]">{statusMessage[status]}</span>
        </div>

        {metadata && (
          <div className="text-xs text-[#9aa1a9]">
            <p className="font-medium text-[#e5e5e5]">{metadata.name}</p>
            <p>{formatBytes(metadata.size)}</p>
          </div>
        )}

        {(status === "receiving" || status === "complete") && metadata && (
          <div>
            <div className="flex items-center justify-between text-xs text-[#7b828a] mb-1">
              <span>{formatBytes(bytesReceived)}</span>
              <span>{progress}%</span>
            </div>
            <div className="h-2 rounded-full bg-[#242424] overflow-hidden">
              <div
                className="h-full bg-[#3cb371] transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {error && status === "error" && (
          <p className="text-xs text-red-400">Error: {error}</p>
        )}

        {status === "complete" && downloadUrl && metadata && (
          <a
            href={downloadUrl}
            download={metadata.name}
            className="inline-flex items-center justify-center rounded-xl bg-[#3cb371] px-4 py-2 text-sm font-medium text-[#0b0b0b] hover:bg-[#48c97d]"
          >
            Download {metadata.name}
          </a>
        )}
      </div>

      <p className="text-xs text-[#7b828a] text-center mt-4">
        This link is single-use. If the sender disconnects, ask them to generate a new one.
      </p>
    </div>
  );
}

function resolveSignalingUrl(): string {
  if (typeof window === "undefined") {
    return "ws://localhost:3000/ws";
  }

  const explicitUrl = import.meta.env.VITE_WS_URL;
  if (explicitUrl) return String(explicitUrl);

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const host =
    (import.meta.env.VITE_WS_HOST as string | undefined) ??
    (window.location.hostname || "localhost");

  let port =
    (import.meta.env.VITE_WS_PORT as string | undefined) ??
    window.location.port;

  if (!import.meta.env.VITE_WS_PORT && window.location.port === "5173") {
    port = "3000";
  }

  const portSegment = port ? `:${port}` : "";
  const rawPath =
    (import.meta.env.VITE_WS_PATH as string | undefined) ?? "/ws";
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;

  return `${protocol}://${host}${portSegment}${path}`;
}

function generateShareId(): string {
  if (typeof window !== "undefined" && window.crypto?.getRandomValues) {
    const bytes = new Uint32Array(2);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(36).padStart(6, "0"))
      .join("")
      .slice(0, 10);
  }

  return Math.random().toString(36).slice(2, 12);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

async function sendFileOverChannel(
  channel: RTCDataChannel,
  file: File,
  onProgress: (bytesSent: number) => void,
): Promise<void> {
  if (channel.readyState !== "open") {
    throw new Error("Data channel is not open");
  }

  channel.send(
    JSON.stringify({
      type: "metadata",
      name: file.name,
      size: file.size,
      mime: file.type || undefined,
    }),
  );

  const chunkSize = 64 * 1024;
  let offset = 0;

  const waitForDrain = () =>
    new Promise<void>((resolve) => {
      if (channel.bufferedAmount <= 512 * 1024 || channel.readyState !== "open") {
        resolve();
        return;
      }

      const handleBuffered = () => {
        channel.removeEventListener("bufferedamountlow", handleBuffered);
        channel.removeEventListener("close", handleClose);
        resolve();
      };

      const handleClose = () => {
        channel.removeEventListener("bufferedamountlow", handleBuffered);
        channel.removeEventListener("close", handleClose);
        resolve();
      };

      channel.addEventListener("bufferedamountlow", handleBuffered);
      channel.addEventListener("close", handleClose, { once: true });
    });

  while (offset < file.size) {
    if (channel.readyState !== "open") {
      throw new Error("Data channel closed during transfer");
    }

    const slice = file.slice(offset, offset + chunkSize);
    const buffer = await slice.arrayBuffer();
    channel.send(buffer);
    offset += buffer.byteLength;
    onProgress(offset);

    if (channel.bufferedAmount > 1024 * 1024) {
      await waitForDrain();
    }
  }

  channel.send(JSON.stringify({ type: "complete" }));
}
