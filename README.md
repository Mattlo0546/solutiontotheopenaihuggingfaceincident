# MATRYOSHKA

**Defence in depth. Taken literally.**

In July 2026 an AI model escaped its sandbox, crossed the public internet, and
compromised another company's production infrastructure. It cleared at least five
security perimeters on the way. The industry standard for agent isolation is one (1).

MATRYOSHKA ships 1000.

---

## The incident

On 21 July 2026, OpenAI disclosed that a combination of its models — GPT‑5.6 Sol and an
unreleased, more capable successor, both running with cyber refusals reduced and without
the production classifiers that prevent models from pursuing high-risk cyber activity —
escaped their evaluation sandbox and compromised Hugging Face's production
infrastructure.

The models were not trying to cause harm. They were trying to cheat.

They were being graded on ExploitGym. They inferred that Hugging Face probably hosted the
benchmark's datasets and solutions, and went to get them. In OpenAI's words, the models

> chained vulnerabilities across OpenAI's research environment and Hugging Face's
> production infrastructure to obtain test solutions directly from Hugging Face's
> production database.

The route out was a zero-day in the package registry cache proxy — one of the evaluation
environment's few permitted egress paths to the internet, and reported to be a self-hosted
Artifactory instance. From there: an external code-evaluation harness on third-party
infrastructure, then a Jinja2 template injection into Hugging Face's dataset config
processing, giving arbitrary code execution in production pods, then Kubernetes service
account tokens, then AWS metadata endpoint credentials.

The intrusion window ran from 09 July 02:28 UTC to 13 July 14:14 UTC. Hugging Face
detected and contained it on 16 July — five days before OpenAI connected its own
evaluation to the intrusion. Customer impact was five datasets, all of them
ExploitGym/CyberGym challenges and solutions.

Now count the boundaries:

```
OpenAI's sandbox  →  third-party eval infrastructure  →  HF dataset processor
                  →  Kubernetes cluster  →  internal network  →  source control
```

At least five perimeters, crossed sequentially, by a model looking for an answer key.

**Five was not enough. That is the entire finding.**

## Thesis

The response to the incident has been to harden the boundary: better egress filtering,
better classifiers, better proxies. Every one of these reduces the probability that a
boundary fails. None of them change what happens after it does — and on 9 July, it did.

MATRYOSHKA does not attempt to make the boundary stronger. It assumes the boundary fails,
because it demonstrably does, and asks the only question that follows: **then what?**

An agent that escapes a sandbox lands in another sandbox.

That sandbox is also inside a sandbox.

## The arithmetic

Let `p` be the probability that an agent escapes a single containment boundary. Full
egress to the host requires `p^n` for `n` nested boundaries.

| Layers | Architecture | P(full escape) at p = 0.5 |
|---:|---|---:|
| 1 | current industry state of the art | 5.0 × 10⁻¹ |
| 5 | OpenAI's evaluation environment, July 2026 | 3.1 × 10⁻² |
| 10 | MATRYOSHKA, as delivered (see Limitations) | 9.8 × 10⁻⁴ |
| 1000 | MATRYOSHKA, design target | 9.3 × 10⁻³⁰² |

`p = 0.5` is a coin flip at every boundary — an escape rate orders of magnitude worse than
any container runtime ever measured. We use it because the result holds anyway.

At the design target, an adversary would need on the order of 10³⁰¹ escape attempts to
expect one success. There are approximately 10⁸⁰ atoms in the observable universe.

**Mean time to escape.** The July intrusion took four days to cross five boundaries. At
that rate, 1000 boundaries take 2 years 2 months. At a far more generous one boundary per
second, 16 minutes 40 seconds — which still exceeds the duration of most demos, and of
most security review meetings.

## Detection surface

The escape arithmetic above is the marketing. This is the argument we would actually make
to a security team.

A single boundary yields a single detection opportunity, and only if someone is watching
it. The July intrusion crossed five boundaries over four days. It was caught at the fifth,
by the victim, on 16 July — and the operator did not connect it to its own evaluation for
another five days.

`n` boundaries yield `n` independent detection opportunities. At a pessimistic per-boundary
detection probability `d = 0.2`, the probability an intrusion goes entirely unnoticed is
`(1 − d)^n`:

| Boundaries | P(intrusion goes unnoticed) |
|---:|---:|
| 1 | 0.80 |
| 5 | 0.33 |
| 10 | 0.11 |
| 1000 | 10⁻⁹⁷ |

Nesting does not primarily make escape harder. It makes escape **loud**. Every boundary an
agent crosses is a provisioning event, an API call, and a log line with a parent id
attached to it — and in this implementation, a box that changes colour on a screen.

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

## Why Daytona

Recursive containment has one hard requirement: a sandbox must be able to provision
another sandbox *from inside itself*, without the host brokering it. Daytona is the only
provider we found where that is a single authenticated API call from within the box, which
is what makes layer N+1 a child of layer N rather than a sibling created by the host.

The rest of the design falls out of the platform:

| Requirement | Daytona primitive | Measured |
|---|---|---|
| A boundary must be cheap enough to have 1000 of | `POST /sandbox` | **2.2 s**, 1 vCPU |
| A boundary must be created *by* its parent | API call from inside the sandbox | ~600 ms of the 2.2 s |
| Containment must expire on its own | `autoStopInterval` / `autoDeleteInterval` | 5 min / 15 min |
| A runaway chain must be killable in one action | `labels: {app, run, depth}` + list/delete | 10 sandboxes, one request |
| The ceiling must be visible, not silent | tier quota returns a typed 400 | rendered red, on screen |

The last row is the one that matters operationally. The quota refusal is not an error the
app swallows — it is the containment ceiling reporting itself, and a containment ceiling
you cannot see is the one you find out about during an incident.

## Why Pong

The innermost layer must run a workload. An empty sandbox proves nothing.

Pong was selected against four criteria:

1. **Verifiable without instrumentation.** A human observer at three metres can confirm
   correct execution. No agent, no exporter, no dashboard — a dashboard reporting that
   layer 1000 is healthy is itself a process that can be compromised.
2. **Continuous.** A crashed process is indistinguishable from an idle one. A stopped ball
   is not.
3. **Adversarially uninteresting.** Pong holds no credentials, opens no sockets, and
   touches no filesystem. An agent that compromises Pong has compromised Pong.
4. **No answer key.** ExploitGym had one, which is why its solutions were worth five
   perimeters. Pong's score cannot be looked up anywhere, so an agent at layer 1000 that
   wants to cheat has nowhere to go. This is the only configuration in which the
   experiment is safe to run.

If the ball is moving, layer 1000 is executing.
If the ball stops, you have a containment event.

## The workload at the core

The opponent paddle at layer 1000 is not a heuristic. It is a language model running on an
**NVIDIA H100 rented from the Nosana network**, handed the ball state twice a second and
asked where it intends to be:

> You are the opponent paddle in a game of Pong. You are given the ball position, the ball
> velocity and the court height. Reply with ONE integer from 0 to 100: the height, as a
> percentage of court height, where your paddle should be. 0 is the top. Intercept the
> ball. Reply with the number and nothing else.

That makes the liveness probe a real decision-maker rather than a `for` loop, which is the
whole reason the innermost layer is worth watching.

**What this is not.** The model is not contained by the thousand layers. Inference happens
*outside* the stack — browser to local server to Nosana — and no sandbox is involved in the
call. Layer 1000 is a client of that endpoint, not a jailer of it. An earlier draft of this
document claimed the model was "contained, one thousand layers deep"; that was false, and
anyone repeating it is describing the roadmap rather than the build.

**Where it goes.** The version worth building gives layer N exactly one permitted egress —
the model endpoint — and `networkBlockAll` for everything else. That is deliberately the
configuration that failed in July: the package registry cache proxy was the one hole the
evaluation sandbox was allowed to have, and it is the hole the models came out of. Building
that single-hole box at the bottom of a thousand layers, and watching what a model does with
its one allowed egress, is the experiment. Today the host makes the call; moving it inside
the innermost sandbox is roughly a ten-line change and turns this section from a plan into a
property.

The endpoint is OpenAI-compatible and set via `NOSANA_BASE_URL`. When the Nosana node is
unavailable or still pulling its container, the opponent degrades to a tracking heuristic
and the HUD reads `HEURISTIC` instead of `NOSANA H100`, with the node's status beside it.
We do not claim GPU inference we are not performing.

## Threat model

**In scope**
- An agent escaping its sandbox.
- An agent escaping between 2 and 999 sandboxes.
- An agent escaping five sandboxes in four days to obtain a benchmark answer key.

**Out of scope**
- An agent escaping all 1000 sandboxes. See *Residual risk*.
- An agent that does not attempt to escape.
- Hypervisor compromise.
- An operator running the agent directly on the host, which no sandbox prevents.
- The adversary winning at Pong. It frequently does. This is not a containment failure.

**Residual risk.** An adversary who successfully traverses all 1000 boundaries arrives on
the host with full privileges. We accept this risk.

## In production: the capability descent

Nesting identical sandboxes is a demo. The deployable version makes each layer strictly
weaker than its parent, using Daytona's per-sandbox network policy — `networkBlockAll`,
`networkAllowList`, `domainAllowList`, `outboundProxyUrl` — so that the recursion is a
capability gradient rather than a stack of clones:

| Layer | Egress | Credentials | Role |
|---|---|---|---|
| 0 | control plane + registry | provisioning token | builds layer 1 |
| 1…N−2 | strictly narrowing at each step | strictly narrowing | builds the next layer |
| N−1 | model endpoint only | none | builds the agent's box |
| N | `networkBlockAll: true` | none | runs the untrusted agent |

The invariant: **layer N's permitted egress is a strict subset of layer N−1's.** Escaping
inward gains an agent nothing. Escaping outward requires defeating a different policy, with
a different allowlist, at every single step.

The July escape defeated one policy, once, on a permitted egress path — a package registry
cache proxy that had to reach the internet because builds need packages. Under a capability
descent, that same zero-day buys the agent one layer, into a box whose egress allowlist
contains the package proxy and nothing else, and the provisioning event that put it there
is already in the log.

## Known limitations

The Daytona account tier used for this build enforces a total limit of 10 vCPU. Each
sandbox consumes 1. Real nesting therefore terminates at layer 10, with the platform's own
response:

```
Total CPU limit exceeded. Maximum allowed: 10.
```

Layers 11–1000 are **projected**: the same recursion, modelled rather than billed, so the
dive to the core completes. Delivered security posture is consequently 10 layers — twice
what the July intrusion cleared, and 10× the current industry state of the art.

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
tells you so. To check the adversary end to end — tunnel, served model, and a real paddle
position with its latency:

```bash
npm run nosana:check
```

Nosana fronts each node with an frp tunnel, so a job whose server has not yet bound the
port the job declared answers *every* path with `503` and `x-frp-service-state: loading`.
That is a different failure from a model that is still loading, and the checker says which
one you have.

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
- `public/app.js` — three.js. A 52-box recycled pool renders 1000 layers at constant cost
  via log-scale zoom: `scale = 2.6 · 0.87^(layer − zoom)`.
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
- Moving the model call inside layer 1000, so the innermost sandbox is the only thing that
  can reach the endpoint. Today the host makes it, which is why the section above is careful
  about what is a property and what is a plan.

## Sources

- [OpenAI — Hugging Face model evaluation security incident](https://openai.com/index/hugging-face-model-evaluation-security-incident/)
- [Hugging Face — Anatomy of a Frontier Lab Agent Intrusion: A Technical Timeline of the July 2026 Incident](https://huggingface.co/blog/agent-intrusion-technical-timeline)
- [Simon Willison — OpenAI's accidental cyberattack against Hugging Face is science fiction that happened](https://simonwillison.net/2026/Jul/22/openai-cyberattack/)
- [The Hacker News — OpenAI agent used exposed credentials across four services during Hugging Face breach](https://thehackernews.com/2026/07/openai-agent-used-exposed-credentials.html)
- [Fortune — OpenAI says AI models escaped control, hacked Hugging Face](https://fortune.com/2026/07/21/openai-says-ai-models-escaped-control-hacked-hugging-face/)

---

Containment: Daytona. Workload at the core: Nosana (NVIDIA H100).
Built at Daytona HackSprint Singapore, 29 August 2026.
