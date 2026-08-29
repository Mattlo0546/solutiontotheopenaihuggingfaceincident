# MATRYOSHKA

**Defence in depth. Taken literally.**

The industry standard for AI agent isolation is one (1) sandbox. When that sandbox
fails, the agent is on your host. MATRYOSHKA ships 1000.

---

## Background

Sandbox escape in agent infrastructure is not hypothetical. Public security research
has repeatedly demonstrated that shared model-hosting and inference platforms can be
escaped by a malicious uploaded artifact — most prominently the 2024 work on
pickle-deserialization leading to cross-tenant container escape on Hugging Face's
inference infrastructure. The pattern generalises to every platform that executes
untrusted, model-supplied code on shared tenancy — which, since the frontier labs began
shipping agents that run generated code against public model hubs, is now most of them.

This document refers to that class of failure as **the incident**.

Every mitigation proposed since shares a single structural assumption:

> **the sandbox holds.**

Hardened runtimes, seccomp profiles, gVisor, microVMs, syscall filtering — each one
reduces the probability that the boundary fails. None of them address what happens
after it does. The entire industry is running a single point of failure and calling it
a security architecture.

MATRYOSHKA does not attempt to make the boundary stronger. It assumes the boundary
fails, and asks the only question that follows: **then what?**

## Thesis

An agent that escapes a sandbox lands in another sandbox.

That sandbox is also inside a sandbox.

## The arithmetic

Let `p` be the probability that an agent escapes a single containment boundary. Full
egress to the host requires `p^n` for `n` nested boundaries.

| Layers | Architecture | P(full escape) at p = 0.5 |
|---:|---|---:|
| 1 | current industry state of the art | 5.0 × 10⁻¹ |
| 2 | no known production deployments | 2.5 × 10⁻¹ |
| 10 | MATRYOSHKA, as delivered (see Limitations) | 9.8 × 10⁻⁴ |
| 1000 | MATRYOSHKA, design target | 9.3 × 10⁻³⁰² |

`p = 0.5` is a coin flip at every boundary — an escape rate orders of magnitude worse
than any container runtime ever measured. We use it because the result holds anyway.

At the design target, an adversary would need on the order of 10³⁰¹ escape attempts to
expect one success. There are approximately 10⁸⁰ atoms in the observable universe.

**Mean time to escape.** An agent escaping one boundary per second reaches the host in
16 minutes 40 seconds. This exceeds the duration of most demos, and of most security
review meetings.

## Architecture

Layer 0 is created by the host. **Every layer after that is created by the layer above
it** — a script executing *inside* sandbox N calls the Daytona API and returns the id of
sandbox N+1. The recursion is real, the sandboxes are real, and their real ids are
rendered on the boxes in the visualiser and printed in the recursion log.

```
  host ──creates──▶ layer 0 ──creates──▶ layer 1 ──creates──▶ layer 2 ──▶ … ──▶ PONG
                    (real)    (from        (real)   (from        (real)        ▲
                              inside 0)             inside 1)                  │
                                                          decides where to be ─┘
                                                    NVIDIA H100 · Nosana network
```

Measured cost of one containment boundary: **~2.2 seconds**.

## Why Pong

The innermost layer must run a workload. An empty sandbox proves nothing.

Pong was selected against three criteria:

1. **Verifiable without instrumentation.** A human observer at three metres can confirm
   correct execution. No agent, no exporter, no dashboard — a dashboard reporting that
   layer 1000 is healthy is itself a process that can be compromised.
2. **Continuous.** A crashed process is indistinguishable from an idle one. A stopped
   ball is not.
3. **Adversarially uninteresting.** Pong holds no credentials, opens no sockets, and
   touches no filesystem. It is a liveness probe, not an asset. An agent that
   compromises Pong has compromised Pong.

If the ball is moving, layer 1000 is executing.
If the ball stops, you have a containment event.

## The adversary

A containment system with nothing to contain is a screensaver.

The opponent paddle at layer 1000 is not a heuristic. It is a language model running on
an **NVIDIA H100 rented from the Nosana network**, handed the ball state twice a second
and asked where it intends to be:

> You are the opponent paddle in a game of Pong. You are given the ball position, the
> ball velocity and the court height. Reply with ONE integer from 0 to 100: the height,
> as a percentage of court height, where your paddle should be. 0 is the top. Intercept
> the ball. Reply with the number and nothing else.

It is the only component in this system that makes a decision. It is therefore the only
component in this system worth containing — and it is contained: one thousand layers
deep, on a GPU it does not own, inside a sandbox it did not create, playing a game it
cannot win by escaping.

The endpoint is OpenAI-compatible and set via `NOSANA_BASE_URL`. When the Nosana node is
unavailable or still pulling its container, the opponent degrades to a tracking heuristic
and the HUD reads `HEURISTIC` instead of `NOSANA H100`, with the node's status text
beside it. We do not claim GPU inference we are not performing.

## Threat model

**In scope**
- An agent escaping its sandbox.
- An agent escaping between 2 and 999 sandboxes.

**Out of scope**
- An agent escaping all 1000 sandboxes. See *Residual risk*.
- An agent that does not attempt to escape.
- The adversary winning at Pong. It frequently does. This is not a containment failure.
- Hypervisor compromise.
- An operator running the agent directly on the host, which no sandbox prevents.

**Residual risk.** An adversary who successfully traverses all 1000 boundaries arrives
on the host with full privileges. We accept this risk.

## Known limitations

The Daytona account tier used for this build enforces a total limit of 10 vCPU. Each
sandbox consumes 1. Real nesting therefore terminates at layer 10, with the platform's
own response:

```
Total CPU limit exceeded. Maximum allowed: 10.
```

Layers 11–1000 are **projected**: the same recursion, modelled rather than billed, so
the dive to the core completes. Delivered security posture is consequently 10 layers —
**10× the current industry state of the art.**

The application does not conceal any of this. The refused layer renders red, is labelled
`CAPPED`, and the platform's verbatim error is displayed on screen. Real and projected
layers are counted separately in the HUD and are never summed. Raising the account tier
raises the real layer count linearly, with no code change.

## Run it

```bash
npm install && npm start
```

Open <http://localhost:8899> and press **BEGIN THE DIVE**.

Configuration lives in `.env` (see `.env.example`): `DAYTONA_API_KEY`, `NOSANA_BASE_URL`,
`PORT`, `MZ_TOTAL` (layers) and `MZ_REAL_DEPTH` (how many to attempt for real).

The stack runs without the Nosana endpoint — you get the heuristic opponent, and the HUD
tells you so.

## Controls

| | |
|---|---|
| `BEGIN THE DIVE` | build the real chain, then project to the core |
| `WARP TO CORE` | jump directly to layer 1000 |
| scroll / scrubber | traverse the stack by hand (shift-scroll = ×8) |
| `W` / `S` | your paddle |
| `DESTROY SANDBOXES` | delete every sandbox labelled `app=matryoshka` |

Green = real Daytona sandbox · blue = projected · amber = booting · red = quota ceiling.

## Implementation

- `server/index.js` — recursion driver (Daytona SDK + REST), Nosana H100 inference proxy,
  WebSocket feed to the stage.
- `public/app.js` — three.js. A 52-box recycled pool renders 1000 layers at constant
  cost via log-scale zoom: `scale = 2.6 · 0.87^(layer − zoom)`.
- `public/pong.js` — one canvas, serving as both the HUD widget and the texture at the core.

## Cleanup

Press **DESTROY SANDBOXES**, or:

```bash
curl -X POST localhost:8899/api/cleanup
```

Every sandbox is created with `autoStopInterval: 5` and `autoDeleteInterval: 15`, so
containment is not load-bearing overnight.

## Roadmap

- Layer 1001. Pending tier upgrade.
- Horizontal nesting (sandboxes beside sandboxes). Under evaluation; no security benefit
  identified.
- Formal verification of the Pong liveness probe.
- Relocating the adversary's inference *inside* layer 1000, rather than calling out to it.
  Currently the model is contained by policy; we would prefer it contained by topology.

---

Containment: Daytona. Adversary: Nosana (NVIDIA H100).
Built at Daytona HackSprint Singapore, 29 August 2026.
