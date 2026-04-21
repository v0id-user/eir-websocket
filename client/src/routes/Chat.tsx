import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api, type Message } from "../lib/api";
import { joinGroup } from "../lib/socket";
import { getNickname, setNickname } from "../lib/nickname";
import type { Channel } from "phoenix";

export function Chat() {
  const { groupId } = useParams({ from: "/g/$groupId" });
  const nav = useNavigate();
  const [nick, setNick] = useState(getNickname());
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [joinedSource, setJoinedSource] = useState<string>("");
  const channelRef = useRef<Channel | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const { data: presets } = useQuery({
    queryKey: ["presets"],
    queryFn: api.presets,
  });

  useEffect(() => {
    setMessages([]);
    const ch = joinGroup(nick, groupId);
    channelRef.current = ch;

    ch.on("message", (m: Message) => {
      setMessages((prev) => {
        if (prev.some((x) => x.id === m.id)) return prev;
        return [...prev, m];
      });
    });

    ch.join()
      .receive(
        "ok",
        (resp: { messages: Message[]; source: string; node: string }) => {
          setJoinedSource(`${resp.source} . ${resp.node}`);
          setMessages(resp.messages);
        },
      )
      .receive("error", (err) => {
        console.error("join error", err);
      });

    return () => {
      ch.leave();
      channelRef.current = null;
    };
    // intentionally NOT depending on `nick` — nickname is sent per-message,
    // so changing it shouldn't tear down the channel + reload history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight });
  }, [messages.length]);

  async function loadMore() {
    if (messages.length === 0) return;
    const oldest = messages[0];
    const { messages: older } = await api.history(groupId, oldest.id, 50);
    setMessages((prev) => [...older, ...prev]);
  }

  function send() {
    if (!draft.trim() || !channelRef.current) return;
    channelRef.current.push("send", { body: draft, nickname: nick });
    setDraft("");
  }

  const byAuthor = useMemo(() => {
    const m = new Map<string, number>();
    for (const msg of messages) m.set(msg.author, (m.get(msg.author) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [messages]);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "180px 1fr 180px",
        height: "calc(100vh - 32px)",
      }}
    >
      <aside
        style={{
          borderRight: "1px solid #333",
          background: "#0a0a0a",
          overflow: "auto",
        }}
      >
        <div
          style={{
            fontSize: 10,
            color: "#888",
            textTransform: "uppercase",
            padding: "4px 10px",
            borderBottom: "1px solid #333",
            background: "#141414",
            letterSpacing: 0.5,
          }}
        >
          groups
        </div>
        <div style={{ padding: 6 }}>
          {presets?.groups?.map((g) => (
            <div
              key={g}
              onClick={() => nav({ to: "/g/$groupId", params: { groupId: g } })}
              style={{
                padding: "3px 8px",
                cursor: "pointer",
                background: g === groupId ? "#1a1a1a" : "transparent",
                color: g === groupId ? "#fff" : "#888",
                fontSize: 12,
                borderLeft:
                  g === groupId ? "2px solid #666" : "2px solid transparent",
              }}
            >
              #{g}
            </div>
          ))}
        </div>
      </aside>

      <section
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          background: "#0a0a0a",
        }}
      >
        <div
          style={{
            padding: "4px 12px",
            borderBottom: "1px solid #333",
            fontSize: 11,
            color: "#888",
            background: "#141414",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <strong style={{ color: "#c0c0c0", fontWeight: "normal" }}>
            #{groupId}
          </strong>
          <span>{messages.length} loaded</span>
          <span>. {joinedSource}</span>
          <button
            onClick={loadMore}
            style={{ marginLeft: "auto", fontSize: 10, padding: "2px 6px" }}
          >
            [ load older ]
          </button>
        </div>
        <div
          ref={scrollerRef}
          style={{ flex: 1, overflow: "auto", padding: "8px 12px" }}
        >
          {messages.map((m) => (
            <div key={m.id} style={{ marginBottom: 2, fontSize: 12 }}>
              <span style={{ color: "#555", fontSize: 10 }}>
                {m.id.slice(0, 8)}
              </span>{" "}
              <span style={{ color: "#a0a0a0" }}>{m.author}</span>{" "}
              <span style={{ color: "#555" }}>:</span>{" "}
              <span>{m.body}</span>
            </div>
          ))}
        </div>
        <div
          style={{
            borderTop: "1px solid #333",
            padding: 6,
            display: "flex",
            gap: 6,
            alignItems: "center",
            background: "#141414",
          }}
        >
          <input
            value={nick}
            onChange={(e) => {
              setNick(e.target.value);
              setNickname(e.target.value);
            }}
            style={{ width: 90 }}
          />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
            }}
            placeholder={`> #${groupId}`}
            style={{ flex: 1 }}
          />
          <button onClick={send}>[ send ]</button>
        </div>
      </section>

      <aside
        style={{
          borderLeft: "1px solid #333",
          background: "#0a0a0a",
          overflow: "auto",
        }}
      >
        <div
          style={{
            fontSize: 10,
            color: "#888",
            textTransform: "uppercase",
            padding: "4px 10px",
            borderBottom: "1px solid #333",
            background: "#141414",
            letterSpacing: 0.5,
          }}
        >
          in view
        </div>
        <div style={{ padding: 8 }}>
          {byAuthor.map(([a, n]) => (
            <div
              key={a}
              style={{
                fontSize: 11,
                padding: "1px 0",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span style={{ color: "#a0a0a0" }}>{a}</span>
              <span style={{ color: "#555" }}>x{n}</span>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
