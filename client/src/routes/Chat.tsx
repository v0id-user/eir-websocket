import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api, type Message } from "../lib/api";
import { joinGroup } from "../lib/socket";
import { getNickname, setNickname } from "../lib/nickname";
import { Presence, type Channel } from "phoenix";

type PresenceUser = { nickname: string; node: string; online_at: number };

const MENTION_RE = /(@[a-zA-Z0-9_-]+)/g;

function containsMention(body: string, nick: string): boolean {
  if (!nick) return false;
  const needle = "@" + nick.toLowerCase();
  return body.toLowerCase().includes(needle);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function BodyText({ body }: { body: string }) {
  const parts = body.split(MENTION_RE);
  return (
    <span>
      {parts.map((p, i) =>
        p.startsWith("@") ? (
          <span key={i} style={{ color: "#c9a76a" }}>{p}</span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}

export function Chat() {
  const { groupId } = useParams({ from: "/g/$groupId" });
  const nav = useNavigate();
  const [nick, setNick] = useState(getNickname());
  const [messages, setMessages] = useState<Message[]>([]);
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [joinedSource, setJoinedSource] = useState<string>("");
  const channelRef = useRef<Channel | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const messagesById = useMemo(() => {
    const m = new Map<string, Message>();
    for (const msg of messages) m.set(msg.id, msg);
    return m;
  }, [messages]);

  const { data: presets } = useQuery({
    queryKey: ["presets"],
    queryFn: api.presets,
  });

  useEffect(() => {
    setMessages([]);
    setPresence([]);
    const ch = joinGroup(nick, groupId);
    channelRef.current = ch;

    let presences: Record<string, { metas: PresenceUser[] }> = {};
    const sync = () => {
      const list: PresenceUser[] = [];
      Presence.list(presences, (nickname, { metas: [first] }) =>
        list.push({ ...first, nickname }),
      );
      list.sort((a, b) => a.online_at - b.online_at);
      setPresence(list);
    };

    ch.on("message", (m: Message) => {
      setMessages((prev) => {
        if (prev.some((x) => x.id === m.id)) return prev;
        return [...prev, m];
      });
    });

    ch.on("presence_state", (state) => {
      presences = Presence.syncState(presences, state);
      sync();
    });

    ch.on("presence_diff", (diff) => {
      presences = Presence.syncDiff(presences, diff);
      sync();
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
    channelRef.current.push("send", {
      body: draft,
      nickname: nick,
      reply_to_id: replyTo?.id ?? null,
    });
    setDraft("");
    setReplyTo(null);
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
          {messages.map((m) => {
            const parent = m.reply_to_id ? messagesById.get(m.reply_to_id) : null;
            const mentionsMe = containsMention(m.body, nick);
            return (
              <div
                key={m.id}
                onClick={() => setReplyTo(m)}
                style={{
                  marginBottom: 2,
                  fontSize: 12,
                  cursor: "pointer",
                  padding: "1px 4px",
                  borderLeft: mentionsMe
                    ? "2px solid #c9a76a"
                    : "2px solid transparent",
                  background: mentionsMe ? "#1a1613" : "transparent",
                }}
                title="click to reply"
              >
                {parent && (
                  <div
                    style={{
                      fontSize: 10,
                      color: "#666",
                      marginLeft: 12,
                      borderLeft: "2px solid #333",
                      paddingLeft: 6,
                      marginBottom: 1,
                    }}
                  >
                    ↳ <span style={{ color: "#888" }}>{parent.author}</span>:{" "}
                    {truncate(parent.body, 80)}
                  </div>
                )}
                {!parent && m.reply_to_id && (
                  <div
                    style={{
                      fontSize: 10,
                      color: "#555",
                      marginLeft: 12,
                      borderLeft: "2px solid #333",
                      paddingLeft: 6,
                      marginBottom: 1,
                    }}
                  >
                    ↳ <span style={{ color: "#555" }}>{m.reply_to_id.slice(0, 8)}</span>{" "}
                    (scroll to load)
                  </div>
                )}
                <span style={{ color: "#555", fontSize: 10 }}>
                  {m.id.slice(0, 8)}
                </span>{" "}
                <span style={{ color: "#a0a0a0" }}>{m.author}</span>{" "}
                <span style={{ color: "#555" }}>:</span>{" "}
                <BodyText body={m.body} />
              </div>
            );
          })}
        </div>
        {replyTo && (
          <div
            style={{
              borderTop: "1px solid #333",
              padding: "4px 10px",
              fontSize: 11,
              background: "#141414",
              color: "#888",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span>↳ replying to</span>
            <span style={{ color: "#c9a76a" }}>{replyTo.author}</span>
            <span style={{ color: "#666", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {truncate(replyTo.body, 100)}
            </span>
            <button onClick={() => setReplyTo(null)} style={{ fontSize: 10, padding: "1px 6px" }}>
              [ cancel ]
            </button>
          </div>
        )}
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
            maxLength={64}
            onChange={(e) => {
              const next = e.target.value.slice(0, 64);
              setNick(next);
              setNickname(next);
              // Debounced notify: tell the server our new name so presence
              // updates. We push on every keystroke but the server handles
              // untrack+track cheaply.
              const trimmed = next.trim();
              if (trimmed && channelRef.current) {
                channelRef.current.push("set_nick", { nickname: trimmed });
              }
            }}
            style={{ width: 90 }}
          />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
              if (e.key === "Escape") setReplyTo(null);
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
          online [{presence.length}]
        </div>
        <div style={{ padding: 8 }}>
          {presence.map((u) => (
            <div
              key={u.nickname}
              onClick={() =>
                setDraft((d) => (d ? d + " @" + u.nickname + " " : "@" + u.nickname + " "))
              }
              style={{ fontSize: 11, padding: "1px 0", cursor: "pointer" }}
              title={`click to @mention · on ${u.node}`}
            >
              <span style={{ color: "#4a8", marginRight: 4 }}>*</span>
              <span style={{ color: "#a0a0a0" }}>{u.nickname}</span>
            </div>
          ))}
        </div>
        <div
          style={{
            fontSize: 10,
            color: "#888",
            textTransform: "uppercase",
            padding: "4px 10px",
            borderBottom: "1px solid #333",
            borderTop: "1px solid #333",
            background: "#141414",
            letterSpacing: 0.5,
          }}
        >
          authors in view
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
              <span style={{ color: "#888" }}>{a}</span>
              <span style={{ color: "#555" }}>x{n}</span>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
