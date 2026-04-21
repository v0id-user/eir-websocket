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
      .receive("ok", (resp: { messages: Message[]; source: string; node: string }) => {
        setJoinedSource(`${resp.source} · ${resp.node}`);
        setMessages(resp.messages);
      })
      .receive("error", (err) => {
        console.error("join error", err);
      });

    return () => {
      ch.leave();
      channelRef.current = null;
    };
  }, [groupId, nick]);

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
    channelRef.current.push("send", { body: draft });
    setDraft("");
  }

  const byAuthor = useMemo(() => {
    const m = new Map<string, number>();
    for (const msg of messages) m.set(msg.author, (m.get(msg.author) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [messages]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "200px 1fr 200px", height: "calc(100vh - 48px)" }}>
      <aside style={{ borderRight: "1px solid #222", padding: 12, overflow: "auto" }}>
        <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", marginBottom: 8 }}>
          groups
        </div>
        {presets?.groups?.map((g) => (
          <div
            key={g}
            onClick={() => nav({ to: "/g/$groupId", params: { groupId: g } })}
            style={{
              padding: "6px 8px",
              cursor: "pointer",
              borderRadius: 4,
              background: g === groupId ? "#1a2e1a" : "transparent",
              color: g === groupId ? "#4ade80" : "#aaa",
              fontSize: 13,
            }}
          >
            # {g}
          </div>
        ))}
      </aside>

      <section style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div
          style={{
            padding: "8px 16px",
            borderBottom: "1px solid #222",
            fontSize: 13,
            color: "#888",
          }}
        >
          <strong style={{ color: "#4ade80" }}># {groupId}</strong>
          <span style={{ marginLeft: 12 }}>
            {messages.length} loaded · {joinedSource}
          </span>
          <button
            onClick={loadMore}
            style={{
              marginLeft: 12,
              background: "transparent",
              border: "1px solid #333",
              color: "#aaa",
              padding: "2px 8px",
              fontSize: 11,
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            ↑ load older
          </button>
        </div>
        <div ref={scrollerRef} style={{ flex: 1, overflow: "auto", padding: 16 }}>
          {messages.map((m) => (
            <div key={m.id} style={{ marginBottom: 4, fontSize: 13 }}>
              <span style={{ color: "#60a5fa" }}>{m.author}</span>{" "}
              <span style={{ color: "#555", fontSize: 10 }}>
                {m.id.slice(0, 8)}
              </span>{" "}
              <span>{m.body}</span>
            </div>
          ))}
        </div>
        <div
          style={{
            borderTop: "1px solid #222",
            padding: 10,
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          <input
            value={nick}
            onChange={(e) => {
              setNick(e.target.value);
              setNickname(e.target.value);
            }}
            style={{
              width: 100,
              background: "#0a0a0a",
              color: "#eee",
              border: "1px solid #333",
              padding: "4px 8px",
              fontFamily: "inherit",
              fontSize: 13,
              borderRadius: 4,
            }}
          />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
            }}
            placeholder={`message #${groupId}`}
            style={{
              flex: 1,
              background: "#0a0a0a",
              color: "#eee",
              border: "1px solid #333",
              padding: "6px 10px",
              fontFamily: "inherit",
              fontSize: 13,
              borderRadius: 4,
            }}
          />
          <button
            onClick={send}
            style={{
              background: "#1a2e1a",
              color: "#4ade80",
              border: "1px solid #2a4a2a",
              padding: "6px 14px",
              borderRadius: 4,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 13,
            }}
          >
            send
          </button>
        </div>
      </section>

      <aside style={{ borderLeft: "1px solid #222", padding: 12, overflow: "auto" }}>
        <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", marginBottom: 8 }}>
          in view
        </div>
        {byAuthor.map(([a, n]) => (
          <div key={a} style={{ fontSize: 12, color: "#aaa", padding: "2px 0" }}>
            <span style={{ color: "#60a5fa" }}>{a}</span>{" "}
            <span style={{ color: "#555" }}>×{n}</span>
          </div>
        ))}
      </aside>
    </div>
  );
}
