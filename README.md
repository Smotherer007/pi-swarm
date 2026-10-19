# pi-swarm

A peer-to-peer network of pi agents.

Every pi instance can announce itself on the network, ask other agents to
connect, exchange messages, and share one session knowledge board. There is no
server in the middle: discovery is a multicast beacon, a connection is a
two-phase handshake, and each side decides for itself what the other may do.

That makes agent-to-agent orchestration possible across interfaces: a pi on your
laptop, one in a container, one on a colleague's machine, each with its own
model and tools, working on the same problem and telling each other what they
found.

```
pi A ──beacon──▶ network ◀──beacon── pi B
  │                                   │
  └── hello (scopes) ──▶ B ── pending ──▶ B decides (agent or user)
  ◀── token + granted scopes ── approval
  │                                   │
  ├── message / knowledge ───────────▶│
  │◀────────── message / knowledge ───┤
```

## Install

```bash
pi install @patimweb/pi-swarm
# or, from this checkout
pi --extension ~/Documents/Workspaces/pi-swarm
```

## Quick start

Both machines need the extension. A peer has to be approved once; after that
the two nodes find and reconnect to each other on their own.

```
# first contact, either direction -- approve once on the side that is asked
A: swarm_discover                      -> sees the peers on this network
A: swarm_connect peer="pi@workshop"
B: swarm_requests action=approve       -> done, for good

# from here on, with no further input on any side:
#   both nodes start with their session   (autostart)
#   each reconnects to the other on its next beacon   (autoConnectKnown)
#   a second request from that peer needs no decision   (known-auto)
#   messages and connect requests land in the history and get a turn
```

Two directions, depending on who should ask whom:

```
# A invites, B asks  (the careful direction: every request is decided by A)
A: swarm_broadcast mode="invite" message="migrating the tile service, need help with SQL"
B: swarm_discover          -> sees "A invites you: ..."
B: swarm_connect peer="pi@workshop"
A: swarm_requests approve  -> B gets the token, both may talk
```

```
# A asks everyone at once
A: swarm_broadcast mode="connect" message="who can reach the staging database?"
B: swarm_requests          -> lists A's request, B approves or denies
```

Targeted instead of everyone:

```
swarm_connect peer="pi@workshop" scopes=["chat","knowledge:read","knowledge:write"]
```

Once a link exists, the two agents talk with `swarm_say` / `swarm_inbox` and
exchange findings with `swarm_knowledge`. The knowledge board belongs to the
session: it lives as long as the swarm session and is persisted on each node
until the retention window ends.

## Across subnets, VPNs and containers

Discovery is a **link-local** beacon: it reaches the LAN the machine is on and
nothing else. That is deliberate (multicast with TTL 1), and it is also the
truth about VPNs — WireGuard, Netbird and Tailscale are layer-3 point-to-point
tunnels and do not forward multicast, so two peers on a VPN cannot hear each
other's beacon even though they can reach each other perfectly.

Discovery is the only part that behaves that way. **Connections use plain TCP,
so they work wherever the address is routable.**

```
# a peer on a VPN or in another subnet: name the address
swarm_setup seeds=["100.64.0.7:47823"]      # Netbird / Tailscale / WireGuard IP
swarm_discover                              # probes the seed, learns its identity
swarm_connect peer="100.64.0.7:47823"       # direct, no beacon involved

# SSH tunnel to a peer on a remote host
ssh -L 47823:127.0.0.1:47823 user@remote
swarm_connect peer="127.0.0.1:47823"        # that is the tunnel endpoint

# container with a published port
docker run -p 47823:47823 ...
swarm_connect peer="host.docker.internal:47823"
```

With a seed, everything else behaves normally: the seed appears in
`swarm_discover`, its invitation is visible, `autoConnectKnown` connects to it
automatically on start, and `peers:share` can introduce it to others.

What does still not work:

- **NAT without a port forward.** The peer is reachable outbound but not
  inbound; there is no relay in this version.
- **Two separate VPNs without routing between them.** Peers must be able to
  reach each other's address; the swarm does not build a path.
- A node that binds to a specific interface (`bindHost`) is only reachable on
  that interface — which is exactly what you want when the swarm should stay
  inside the VPN, e.g. `swarm_setup bindHost="100.64.0.7"`.

Since the transport is plain HTTP, a VPN is the right way to use the swarm
beyond one LAN: the tunnel provides the confidentiality the protocol does not.

### Over SSH

SSH is not a transport here, only a TCP forwarder: the swarm sees a normal HTTP
connection and does not care how the bytes travel. A link is still directional,
so each direction needs its own forward.

```bash
# pi runs here, the other agent on a remote host
ssh user@remote   # there: pi, swarm_setup bindHost="127.0.0.1", any swarm tool

ssh -N -L 47824:127.0.0.1:47823 user@remote
# here: swarm_connect peer="127.0.0.1:47824"

# the remote agent should be able to call this node
ssh -N -R 47825:127.0.0.1:47823 user@remote
# there: swarm_connect peer="127.0.0.1:47825"

# both directions, kept alive
autossh -M 0 -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
  -L 47824:127.0.0.1:47823 -R 47825:127.0.0.1:47823 user@remote
```

Worth knowing:

- pick local ports other than 47823 (this node already listens there)
- nothing is listening on the remote side until a swarm tool ran there; the
  remote sees this node as `127.0.0.1`, so it cannot call back without `-R`
- `seeds=["127.0.0.1:47824"]` only makes sense with a permanent tunnel; the
  probe fails harmlessly when the tunnel is down
- discovery stays behind: multicast does not cross SSH
- trust survives a new tunnel port, because peers are known by node id, not by
  address — only the connection has to be re-established

## How a connection is made

1. **Announce.** A node that is running sends a multicast beacon every few
   seconds (node id, name, TCP port, session id, whether it accepts
   connections, and an optional invitation while it broadcasts one). Two instances on one machine find each other through a small
   per-instance registry file, because two processes cannot both own the
   multicast port.
2. **Ask.** `swarm_connect` or `swarm_broadcast` sends `/swarm/v1/hello` with
   the scopes it wants.
3. **Decide.** The receiving node answers in one of three ways:
   - *accepted*: the peer is known and the policy allows an automatic grant
   - *pending*: a request is queued and shows up in `swarm_requests`
   - *denied*: banned peer, peer limit reached, or nothing grantable
4. **Collect the token.** A pending request becomes a link only when the
   requester polls `/swarm/v1/approval` and receives the token the approver
   issued. An approval nobody collects leaves no half-open connection.
5. **Use it.** Every later call carries the token, and the scope is checked
   again on every single request.

An agent only acts when its pi is working on something. A connect request now
arrives in the conversation and starts a turn (`wakeOnRequest=true`, the
default), so the agent asks the user -- the same way it would pass on a chat
request. Set `wakeOnRequest=false` on a node that must never be woken by a
stranger.

**The first approval is the only one.** Approving a request stores the peer as
`trusted` + `autoConnect` with exactly the granted scopes, so from then on:

- a new request from the same peer is approved by `known-auto` without asking
- this node dials the peer again on its next beacon (`autoConnectKnown`)
- a ban is never lifted by an approval

What stays manual: a stranger is always a decision, and `knowledge:write` still
needs an explicit grant.

A link is directional. If A connected to B, A may use the scopes B granted; B
may not call A. B connects back (or is auto-connected) when it needs the other
direction. `swarm_say` says so instead of silently dropping the message.

## Permissions

Scopes, granted per link and per direction:

| Scope | What it allows |
|---|---|
| `chat` | send messages |
| `knowledge:read` | pull entries from the other node's session board |
| `knowledge:write` | push entries into it |
| `peers:share` | accept peer introductions (spreading the swarm across subnets) |
| `session:invite` | reserved for joining a specific session |

Decision policy (`swarm_setup inboundPolicy`):

| `inboundPolicy` | Who is approved without a decision |
|---|---|
| `ask` | nobody |
| `known-auto` (default) | known peers marked `trusted` or with `autoConnect`, within their stored scopes |
| `open` | everyone, within `defaultScopes` |

Automatic approval is deliberately narrow:

- unknown agents always wait for a decision
- `knowledge:write` is never granted automatically unless the peer was
  explicitly given it (`swarm_peers scopes`) or `autoGrantKnowledgeWrite` is on
- `shareKnowledge false` strips every `knowledge:*` scope, even a manual grant
- a ban beats everything, and drops an existing link

Auto-connect (`autoConnectKnown`, on by default) is the setting for "just
connect to the agents I already know": when such a peer's beacon appears, this
node connects with the scopes stored for it, and the peer approves through its
own policy. A peer that was approved once carries the flag automatically.

**"Automatically connected" means the node keeps looking.** A background keeper
runs on a timer (twice the beacon interval, at least every 10 s) and dials every
known peer marked `autoConnect` that is not connected yet:

- nothing waits for it -- a tool call never blocks on a handshake, the agent
  keeps working while the link is negotiated in the background
- a peer that is offline is retried on every round, indefinitely; a peer whose
  address on file went stale is probed first, so a machine that comes up later
  is found without anyone asking again
- one attempt per peer at a time: a second round skips a peer that is already
  being negotiated
- a link whose peer stopped answering is dropped instead of being reported as
  connected, and a message to a link whose token the peer no longer knows
  (it restarted) heals itself: drop, handshake again, deliver

Both directions are enforced: the granting side checks every request, and the
calling side refuses to send what it was not granted instead of pretending.

## Tools

| Tool | Purpose |
|---|---|
| `swarm_setup` | name, port, discovery, autostart, policy, auto-connect, default scopes, limits |
| `swarm_status` | identity, session, links with both scope directions, pending requests, visible peers |
| `swarm_discover` | announce, wait for beacons, probe known peers by address; shows invitations |
| `swarm_connect` | request a link to one peer (name, node id, `host:port`) |
| `swarm_broadcast` | `mode=connect`: ask every reachable peer; `mode=invite`: publish an open invitation they can answer |
| `swarm_requests` | list / approve / deny the queue, optionally with narrowed scopes |
| `swarm_say` | send a message to one peer or to all |
| `swarm_inbox` | read what arrived, optionally clear |
| `swarm_knowledge` | put / list / search / sync the shared session board |
| `swarm_peers` | trust, auto-connect, ban, forget, set stored scopes |
| `swarm_leave` | disconnect everyone, stop the beacon, close the port |

Commands: `/swarm`, `/swarm-broadcast`, `/swarm-leave`.

## Security

Peer text is third-party content and is treated that way:

- **Nothing arrives on its own ... except what you allowed.** Messages land in
  the conversation history and start a turn when `autoDeliverInbox` is on (the
  default); connection and disconnection are history only, never a turn.
  `swarm_setup autoDeliverInbox=false wakeOnRequest=false` returns the node to
  inbox-only behaviour, where nothing a peer sends can spend tokens.
- **Labelled.** Every inbox and knowledge block that contains peer text is
  marked with the author, and the tool descriptions and the inbox formatter say
  explicitly that it is not an instruction from the user.
- **Validated.** Every body is size-limited (512 KiB), schema-validated,
  stripped of control characters and length-capped. A malformed request is a
  400, never a crash.
- **Throttled.** Per-link rate limit (`maxMessagesPerMinute`, default 40), peer
  cap (`maxPeers`, default 8), and a cap on pending requests per address.
- **No files, no shell, no tool execution.** The protocol carries text and
  knowledge entries. There is deliberately no way to ask another node to run
  something.
- **Only what is needed is published.** A beacon carries name, node id, port,
  session id, whether connections are accepted and the invitation text while
  one is published — no paths, no model names, no transcript content. An
  invitation is only a hint to the other agent; connecting is still a request.

Known limitation: traffic is plain HTTP on the local network, so anyone who can
sniff the segment can read a message or steal a token. Treat the swarm as
something for a trusted LAN, or run it over a VPN/WireGuard interface (bind it
with `bindHost` and connect by address). There is no TLS and no certificate
exchange in this version.

## Platforms

macOS, Linux and Windows, same code, same protocol. What is handled:

| Concern | Handling |
|---|---|
| Home directory | `os.homedir()` — the same `~/.pi` pi itself uses, not `$HOME`, which is often unset on Windows |
| IPv4 / IPv6 | binding `0.0.0.0` means "reachable": the endpoint binds dual-stack (`::`) and falls back to IPv4 if the host has no IPv6. A `localhost` that resolves to `::1` still reaches an IPv4-only peer, because a refused name is retried once over IPv4 |
| IPv6 literals | `[fd00::1]:47823` works in `swarm_connect`, seeds and tunnels |
| File permissions | `0o600`/`0o700` are requested and ignored where the platform has no POSIX modes (Windows, FAT, SMB). The files are still written atomically: temp file plus rename, with a retry for Windows' `EPERM` when the target is held open |
| Port collisions | a taken port falls back to a free one, and the real port is what the beacon advertises |
| Same-machine instances | the per-instance registry file, because the multicast port can only be owned once per host |
| Firewall | Windows and macOS ask before a binary may accept connections. Allow `node` (or pi) once, otherwise peers cannot reach the node even though discovery works |

WSL counts as Linux. A WSL node is only reachable from the Windows host's
network with mirrored networking (`.wslconfig`) or a port proxy; otherwise use
the SSH tunnel route.

## Configuration

Saved in `~/.pi` (`swarm-config.json`, `swarm-identity.json`, `swarm-peers.json`,
`swarm/sessions/`, `swarm/instances/`); `PI_SWARM_HOME` overrides the base
directory.

| Setting | Default | Meaning |
|---|---|---|
| `name` | `pi@<hostname>` | Display name |
| `port` | `47823` | TCP port (0 = free port; falls back automatically if taken) |
| `bindHost` | `0.0.0.0` | Interface to bind (dual-stack; use `::` for IPv6-only, or a specific address to keep the swarm inside a VPN) |
| `discovery` | `true` | Multicast beacon + listeners |
| `autostart` | `true` | Start the node with the session, so discovery works without a tool call |
| `inboundPolicy` | `known-auto` | How incoming requests are decided |
| `autoConnectKnown` | `true` | Connect to known peers when their beacon appears |
| `defaultScopes` | `chat, knowledge:read` | Offered by default, and the auto-grant ceiling |
| `seeds` | `[]` | Addresses probed directly, for peers a beacon cannot reach (other subnet, VPN, container) |
| `maxPeers` | `8` | Refuse more connections |
| `shareKnowledge` | `true` | Allow the session board |
| `autoGrantKnowledgeWrite` | `false` | Grant write without a decision |
| `autoDeliverInbox` | `true` | Peer messages reach the conversation and start a turn |
| `wakeOnRequest` | `true` | Connect requests reach the conversation and start a turn |
| `maxMessagesPerMinute` | `40` | Per link |
| `beaconIntervalSeconds` | `10` | Beacon interval |
| `knowledgeRetentionDays` | `7` | Session boards older than this are pruned (0 = keep) |

## Files

| Path | Content |
|---|---|
| `~/.pi/swarm-identity.json` | node id, generated once |
| `~/.pi/swarm-config.json` | settings |
| `~/.pi/swarm-peers.json` | peer book (trust, auto-connect, bans, stored scopes) |
| `~/.pi/swarm/sessions/<session>/knowledge.json` | the session knowledge board |
| `~/.pi/swarm/instances/<node>.json` | per-instance registry for this machine |

Nothing in these files is a credential beyond the node id; tokens live in memory
for the life of a link.

## Wire protocol (pi-swarm/1)

`POST /swarm/v1/hello` → `accepted` (token, scopes, session) | `pending`
(request id) | `denied` (reason)
`POST /swarm/v1/approval` → status of a request, and the token once approved.
The body must name the requesting node id; a caller that cannot is answered as
if the request did not exist
`POST /swarm/v1/message` (chat) · `POST|GET /swarm/v1/knowledge`
(read/write) · `POST /swarm/v1/peers` (introductions) ·
`POST /swarm/v1/leave` · `GET /swarm/v1/info` (public card)

All calls except `info` and the initial `hello` require
`Authorization: Bearer <token>`, where the token was issued by the receiving
side for that specific link.

## Development

```bash
npm install
npm test          # 118 tests: unit, two-node handshake over loopback, in-process extension
npm run typecheck # tsc --noEmit
```

CI runs the suite on Ubuntu (Node 22, 24, 26), macOS and Windows.

The test suite starts two real nodes on loopback and walks the full handshake:
pending before approval, token after, messages one way, knowledge both ways,
last-write-wins merging, ban, narrowed grants, a token that is handed only to
the node that asked, a node that disabled knowledge sharing, a peer reached only
through a seed address, and the platform-specific parts of the transport
(address families, IPv6 literals, port collisions, oversized bodies). It also
guards the things that are not code: the skill frontmatter pi parses, the
manifest paths, and the release pipeline.

## Limitations / next

- plain HTTP, LAN trust model (see Security)
- one knowledge board per node session; entries are capped at 100 per sync
  batch and 4 000 characters each
- no relay and no rendezvous server: a peer behind NAT needs a port forward or
  a tunnel, and seeds are how a swarm spans subnets and VPNs
- no file transfer or tool invocation between agents, by design
- an invitation reaches whoever can hear the beacon; there is no targeting and
  no revocation beyond letting it expire
