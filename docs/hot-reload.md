# Hot code reload on Railway

Elixir / Erlang lets you swap a module's implementation at runtime while every
WebSocket, every GenServer, every ETS table keeps running. The OTP release
includes the full compiler and `:code` module, so you can connect to any
replica on Railway and re-define a function live. This is the piece of BEAM
that no other mainstream stack really has.

## Connect a remote IEx shell to a running replica

```
railway ssh -s eir-server
# inside the container:
bin/eir remote
```

`bin/eir remote` attaches an IEx shell to the live node. All state is as-is:
process table, ETS, open connections, everything.

Verify you're in:

```elixir
iex> node()
:"eir@fd12:86cf:49cd:1:4000:ca:cf67:79a6"

iex> [node() | Node.list()] |> length()
4
```

## Swap a function at runtime

Open the dashboard in another tab so you can see the effect. Then in the IEx
shell, redefine `Eir.Bot.canned/1`:

```elixir
iex> defmodule Eir.Bot do
...>   @bot_nick "bot"
...>
...>   defp canned(_), do: "hot-reloaded at runtime. the process running this bot was never restarted."
...> end
```

The compiler says it's redefining a module. The BEAM flips the module code
pointer atomically. All processes using `Eir.Bot` now call the new code the
next time they dispatch. Critically: the `Eir.Bot` GenServer itself keeps
running with its existing state — its `init/1` wasn't re-invoked, its
subscriptions weren't dropped, its mailbox isn't cleared.

In the chat, say `@bot hi`. You'll get the new string back instantly.

## What's actually happening

OTP keeps two code versions for every module ("current" and "old"). When you
load a new version:

- Current becomes old.
- New loaded code becomes current.
- Any running process is still executing old code until its next return,
  when it jumps to current.

This is why it's atomic and never drops requests: no process is mid-function
across the swap — they're mid-function within whichever version they're in.

## Caveats

- Changing GenServer state fields requires either `code_change/3` or
  restarting the GenServer. Swapping handler implementations is safe.
- Structs are compiled in; changing a struct's fields is a full reload, not a
  hot swap.
- Only applies to THE NODE YOU RAN THIS ON. Doing it cluster-wide is
  `:c.nc/1` broadcast, or you just redeploy through Railway for the real
  thing.

## Why this matters for this project

The `eir-server` cluster is accepting thousands of WebSocket connections and
constantly pushing messages through Broadway. Changing bot behavior, or a log
format, or an ingest validation rule without restarting any of that is the
whole point of BEAM in production. Stopping and restarting a Node/Go/Python
server to deploy a tiny change drops every active connection. Here it
doesn't.
