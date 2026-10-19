# pi-swarm

A peer-to-peer network of pi agents.

Every pi instance can announce itself on the network, ask other agents to
connect, exchange messages, and share one session knowledge board. There is no
server in the middle: discovery is a multicast beacon, a connection is a
two-phase handshake, each side decides for itself what the other may do, and
everything after discovery is encrypted end to end between the two nodes.

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

On the first contact with a stranger, compare the key fingerprint the request
shows with the one `swarm_status` prints on the other machine (read it out, or
send it over a channel you trust). It is pinned on approval, like an ssh host
key, and checked on every call afterwards.

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

Every call is encrypted and authenticated by the swarm itself (see Security),
so a VPN is not needed for confidentiality. It is still the easy way to make
peers *reachable* across networks, and it hides who talks to whom.

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
   seconds (node id, name, public key, TCP port, session id, whether it accepts
   connections, and an optional invitation while it broadcasts one). Two
   instances on one machine find each other through a small per-instance
   registry file, because two processes cannot both own the multicast port.
2. **Ask.** `swarm_connect` or `swarm_broadcast` sends `/swarm/v1/hello` with
   the scopes it wants, sealed to the other node's public key (learned from its
   beacon or from `/info`, and pinned once the other node answers).
3. **Decide.** The receiving node answers in one of three ways:
   - *accepted*: the peer is known and the policy allows an automatic grant
   - *pending*: a request is queued and shows up in `swarm_requests`
   - *denied*: banned peer, peer limit reached, or nothing grantable
4. **Collect the token.** A pending request becomes a link only when the
   requester polls `/swarm/v1/approval` and receives the token the approver
   issued. An approval nobody collects leaves no half-open connection.
5. **Use it.** Every later call carries the token inside the sealed envelope,
   the token only counts when the node it was issued to presents it, and the
   scope is checked again on every single request.

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

### One identity, one process

Two nodes under one identity are worse than useless: peers identify a link by
nodeId, so they see one peer whose port and token map change every few seconds.
Every heal then alternates between a process that knows their token and one that
does not -- which looks exactly like a healing bug and cannot be told apart from
the outside.

So a second node under an identity that another pi on this machine is already
running does not start at all. It says so, with the pid and the way out:

```
Swarm did not start: Another pi on this machine already runs this swarm
identity (pid 4242, node n_ab12...). A second node needs its own slot:
start it with PI_SWARM_INSTANCE=<name>.
```

Give the second process a slot and both run side by side with their own
identity, peer book, config and a stable port of their own.

## Permissions

Scopes, granted per link and per direction:

| Scope | What it allows |
|---|---|
| `chat` | send messages |
| `knowledge:read` | pull entries from the other node's session board |
| `knowledge:write` | push entries into it |
| `files:write` | offer me a file (I decide whether to collect it) |
| `files:read` | collect a file I offered |
| `peers:share` | accept peer introductions (spreading the swarm across subnets) |
| `session:invite` | reserved for joining a specific session |

Decision policy (`swarm_setup inboundPolicy`):

| `inboundPolicy` | Who is approved without a decision |
|---|---|
| `ask` | nobody |
| `known-auto` (default) | known peers marked `trusted` or with `autoConnect`, within their stored scopes |
| `open` | everyone, within `defaultScopes` |

Automatic approval is deliberately narrow:

- "known" means *known by key*: a request is treated as coming from a known
  peer only when it was sealed with the key pinned for that peer. A node id
  alone proves nothing -- it is in every beacon. A peer book entry without a
  pinned key (from before encryption) needs one more decision.
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
  connected, and a call whose token the peer no longer knows (it restarted) is
  retried after a fresh handshake -- for messages and for knowledge alike

A link is two independent tokens, and a heal respects that: only the half that
was rejected is reset. The token this node issued and the scopes it granted
survive, so a peer that restarted, or a heal of our own outbound half, does not
silently cut off the peer's access to us and does not make the status claim we
granted nothing.

Both directions are enforced: the granting side checks every request, and the
calling side refuses to send what it was not granted instead of pretending.

### Files

One file at a time, in one direction, pulled by the receiver -- deliberately
narrow, because "the swarm can read files" is a much larger promise than "an
agent may hand another agent a file".

```
A: swarm_file action=offer peer="pi@workshop" path=./report.csv
B: swarm_file action=offers      -> name, size, sha256, sender, expiry
B: swarm_file action=accept offerId=f_...
```

The rules that shape it:

- **The offered name is metadata, never a path.** On disk a file is named after
  its transfer id inside a per-peer directory, so traversal, collisions,
  reserved names and length limits cannot happen at all rather than being
  checked one by one.
- **The receiver pulls.** An offer carries name, size and sha256; the bytes are
  fetched after the decision, which also means no half-written file can be
  pushed onto anyone.
- **The announced size is a claim.** A byte counter enforces `filesMaxBytes`
  while the data arrives; a transfer that exceeds it is aborted and the partial
  file deleted.
- **The announced hash is a claim.** The receiver computes sha256 itself after
  writing and deletes the file on a mismatch.
- **An offer is single use and expires** after ten minutes, so no catalogue and
  no browsing can grow out of it.
- **No content enters the conversation.** A file lands on disk with its metadata;
  reading it is a separate, deliberate step, and it is untrusted input. There is
  no unpacking, no exec bit, no listing of anything but what was received.
- **Quota and free space.** Per-peer quota (`4 × filesMaxBytes`) and a refusal
  when free space drops below 200 MB, so a peer cannot quietly fill the disk.
- `files:write` and `files:read` are never granted by default -- only an explicit
  grant per peer counts, exactly like `knowledge:write`.
- **Ids are local.** The receiver files an offer under an id it generates
  itself; the sender's id is validated and used only to fetch the bytes, and
  an offer is only served to the peer it was made to.
- **Sending is confirmed.** `swarm_file action=offer` asks the user in a dialog
  first, so a peer message cannot talk the agent into handing out a file.
- A ban, a forget or a token reset removes that peer's offers and the files it
  sent.

Received files are swept after `filesRetentionDays`, and the sweep reports what
it removed instead of deleting in silence.

### Resetting a peer's token

`swarm_peers action=reset-peer-token peer=<name>` forgets the token this node
issued to a peer and leaves the link itself alone. The peer still believes it is
connected, so its next call is refused and it re-handshakes on its own -- the
grant in the peer book is unchanged, so nobody has to approve anything. Useful
when a token may have leaked, and the only way to exercise the heal path without
restarting a process.

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
| `swarm_peers` | trust, auto-connect, ban, forget, set stored scopes, show pinned keys |
| `swarm_file` | offer a file, list / accept / decline incoming offers, list and sweep received files |
| `swarm_leave` | disconnect everyone, stop the beacon, close the port |

Commands: `/swarm`, `/swarm-broadcast`, `/swarm-leave`.

## Security

### Encryption and authentication (pi-swarm/2)

Everything except the public `/info` card and the beacon is sealed:

- every node has a long-term **X25519** keypair, created with its identity
- the two nodes of a pair derive one **AES-256-GCM** key per direction with
  ECDH and HKDF-SHA256, bound to both node ids *and* both public keys
- a request travels as a binary sealed frame; the headers carry only the
  sender's node id and public key. The token is inside the envelope, never in a
  header. Opening the envelope is what proves the sender holds the private key
- the route, the sender and the recipient are authenticated data, so a captured
  body cannot be replayed against another endpoint or another node
- every request carries a random id and a timestamp: a repeated id, or a clock
  more than 5 minutes off, is refused (check NTP if you see that message)
- every answer is sealed under the other direction and bound to the request id
  and to its status, so an old answer cannot be replayed and a denial cannot be
  turned into an approval
- **pinning**: the key a peer presents on the first handshake is pinned, like an
  ssh host key. A different key later is refused (409) until the user forgets
  the peer and approves it again. A pinned key is never replaced in passing.
  Compare fingerprints (`swarm_status`, `swarm_requests`, `swarm_peers list`)
  on a first contact with a stranger.

What it does not do: hide that two nodes are talking (the beacon is public on
purpose), authenticate a first contact by itself (that is the fingerprint
compare), or give forward secrecy -- the keys are static per pair, so whoever
steals a node's private key from `swarm-identity.json` can read recorded
traffic of that node. Keep the file private.

### Consent

The decisions that hand out rights are made by the user in a dialog, not by the
model: approving a request, trusting a peer, enabling auto-connect, widening
its scopes, lifting a ban, opening the policy (`inboundPolicy open`,
`autoGrantKnowledgeWrite`, `filesPolicy auto`, wider `defaultScopes`) and
offering a file. Without a UI (print/json mode) these calls are refused. A user
who wants headless operation sets `confirmSensitive: false` in the config file;
switching it off through `swarm_setup` is itself confirmed.

### Peer content

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
  400, never a crash. Knowledge pulled from a peer is validated entry by entry,
  just like knowledge pushed to this node.
- **Written in one's own name.** A peer with `knowledge:write` can only write
  entries authored by itself; entries claiming this node, another author's slot
  or a date in the future are dropped. Entries of third parties arrive only
  from peers this node reads from, and are shown with the peer they came via.
- **Throttled.** Per-link rate limit (`maxMessagesPerMinute`, default 40, for
  messages, knowledge pushes, file offers and introductions), peer cap
  (`maxPeers`, default 8), a cap on pending requests per address, and no entry
  in the peer book for a stranger who only asked.
- **No shell, no tool execution.** The protocol carries text, knowledge entries
  and single files the user agreed to send. There is deliberately no way to ask
  another node to run something.
- **Only what is needed is published.** A beacon carries name, node id, public
  key, port, session id, whether connections are accepted and the invitation
  text while one is published — no paths, no model names, no transcript
  content. An invitation is only a hint to the other agent; connecting is still
  a request.

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
| `filesPolicy` | `ask` | How an incoming file offer is decided: `ask`, `auto`, `deny` |
| `filesMaxBytes` | `26214400` | Largest single file, enforced while the bytes arrive |
| `filesRetentionDays` | `7` | Days a received file is kept before the sweeper removes it |
| `confirmSensitive` | `true` | Ask the user in a dialog before rights are handed out (see Consent) |

## Files

| Path | Content |
|---|---|
| `~/.pi/swarm-identity.json` | node id and X25519 keypair, generated once -- **contains the private key** |
| `~/.pi/swarm-config.json` | settings |
| `~/.pi/swarm-peers.json` | peer book (trust, auto-connect, bans, stored scopes) |
| `~/.pi/swarm/sessions/<session>/knowledge.json` | the session knowledge board |
| `~/.pi/swarm/instances/<node>.json` | per-instance registry for this machine |
| `~/.pi/swarm/files/<peer>/<offer>.bin` | received files, plus `index.json` |

The identity file holds the node's private key; it is written `0600` where the
platform supports modes. The peer book holds the pinned public keys. Tokens live
in memory for the life of a link.

## Wire protocol (pi-swarm/2)

`GET /swarm/v1/info` is the only clear-text call: the public card (node id,
name, public key, port, session, policy). Everything else is a sealed `POST` or
`GET` with the headers `x-swarm-from` (node id) and `x-swarm-pub` (public key):

`/hello` → `accepted` (token, scopes, session) | `pending` (request id) |
`denied` (reason) · `/approval` → status of a request, and the token once
approved, only to the node and key that asked · `/message` (chat) ·
`/knowledge` (`POST` push, `GET ?after=<seq>` pages in store order) ·
`/files/offer`, `/files/<id>` · `/peers` (introductions) · `/leave`

Request body: a sealed frame of `{v, rid, ts, token?, body?}`. Answer: a sealed
frame bound to the request id and status. A refusal sent before the envelope
could be opened (wrong key 409, replay 409, clock 400, unsealed 426) is plain
JSON and is treated by the caller as unauthenticated. pi-swarm/2 does not talk
to pi-swarm/1; both machines need the same major protocol.

## Development

```bash
npm install
npm test          # 186 tests: unit, crypto, two-node handshake over loopback, attacks, in-process extension
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

- no forward secrecy yet: the transport keys are static per pair of nodes; a
  per-link ephemeral key exchange in the handshake is the next step
- first contact is trust on first use, secured by the fingerprint compare
- one knowledge board per node session; entries are capped at 100 per push and
  4 000 characters each, a pull pages through the whole board
- files are held in memory while they travel (default limit 25 MiB)
- no relay and no rendezvous server: a peer behind NAT needs a port forward or
  a tunnel, and seeds are how a swarm spans subnets and VPNs
- one file at a time between agents, and no tool invocation, by design
- an invitation reaches whoever can hear the beacon; there is no targeting and
  no revocation beyond letting it expire
