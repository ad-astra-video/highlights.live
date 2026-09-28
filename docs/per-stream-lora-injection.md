# Fine-tune UI v2 — per-stream LoRA injection into perceive (ADAAAA-5324, Increment C)

Sits on top of the LoRA artifact delivery (Increment B, ADAAAA-5323). A user
attaches a trained LoRA to a stream/project; at stream start the perceive
runner loads/merges that adapter **for that stream only**; every other stream
keeps the base model.

This increment changes the perceive **runtime serving path** and per-stream
GPU memory/scheduling, so it carries a Livepeer GPU cost/capacity decision. It
was routed through the CEO cost gate ([ADAAAA-5324](/ADAAAA/issues/ADAAAA-5324),
confirmation card 95fa41d2) **before** being built. **No GPU provisioning is
performed by this leg** — the code path and cost model are delivered; the
box/runtime leg (putting the merged model dir on the perceive GPU box) is owned
by Infra Monitor.

## Data flow

```
User attaches a LoRA to a stream/project
        │
        ▼
server AnalyzerConfig.loraRef = <merged Florence-2 model dir>
        │  (when the stream/job is configured with an adapter)
        ▼
adapter.analyze(..., { gameHint, preferLabels, loraRef })   // every /analyze
        │
        ▼
perceive /analyze body: AnalyzeRequest.loraRef ──► SessionState.lora_ref
        │
        ▼
process_frame: detector = get_detector(state.lora_ref or None)
        │
        ├── lora_ref empty  ──► shared **base** detector (unchanged behaviour)
        └── lora_ref set     ──► per-stream detector that loads that stream's
                                 pre-merged model dir (base + LoRA merged)
```

## Per-stream adapter selection (services/perceive/app/florence.py)

`get_detector()` is extended to `get_detector(lora_ref=None)`:

- `lora_ref` is **None** → the existing shared base singleton
  (`FlorenceDetector(model_name=FLORENCE_MODEL)`). Base-stream detection is
  byte-for-byte the pre-increment path — no regression.
- `lora_ref` is set → a **dedicated** `FlorenceDetector` per adapter ref,
  cached in a `{lora_ref: detector}` registry. That detector loads its model
  from `model_path=lora_ref` instead of the base model id.

The adapter is loaded as a **pre-merged drop-in Florence-2 model directory** —
exactly what `services/train/fine_tune_od.py::save_checkpoints()` emits via
`model.merge_and_unload()` (the same dir the train eval harness already loads
with `--model-finetuned`). Because the merge happens at train time, the perceive
serve path needs **no PEFT/gradient-merge at runtime** — it is a plain
`AutoModelForCausalLM.from_pretrained(<dir>)` per stream, one variant in memory
per attached adapter. This keeps the serving path simple and avoids a second
training-class dependency in the perceive image.

Transport: `loraRef` rides the same per-`/analyze` channel as
`gameHint`/`preferLabels` (ADAAAA-4109 pattern), so a fresh or re-reserved
session is configured before its first frame runs. It is also accepted by the
WS/control `configure` message (`loraRef`).

### Constraints

- OpenVINO device path does **not** serve a per-stream LoRA dir (the OpenVINO
  converter resolves an HF model id against the hub cache, not an arbitrary
  filesystem dir). A LoRA-attached stream on `PERCEIVE_DEVICE=openvino` logs a
  warning and serves base. The CUDA/accelerator (torch) path — which is what the
  GPU box uses — serves the variant fully.

## No regression on base-stream detection

- Sessions without `loraRef` keep the shared base singleton `get_detector(None)`,
  identical to the legacy `get_detector()` call.
- `preload.py` still warms the base detector; the fps boot gate is unchanged.
- Perceive suite: `tests/` (185 tests) passes, including the pre-existing
  tracker/ball/zone suites, plus new coverage for per-ref selection and
  session carry (`test_florence.py`, `test_app.py`).

## Per-stream GPU cost (documented for the cost gate)

Each **distinct concurrently-attached** adapter ref holds one additional
Florence-2 model in GPU memory on the perceive box. Cost model per adapter:

| Resource            | Delta per attached adapter variant        |
| ------------------- | ----------------------------------------- |
| GPU memory          | ~1 Florence-2 model load (~0.9–1.5 GiB fp32 / ~0.45–0.75 GiB bf16), held resident for the lifecycle of the session + the cached detector |
| GPU serving time    | unchanged per frame (same inference cost as base; the adapter is already merged) |
| Startup (one-time)  | model load + (first boot) OpenVINO/torch warm-up; the base detector is not reloaded |
| Idle cost           | an attached adapter keeps its model resident while cached (`reset_detectors()` on runner restart releases it) |

Rules of thumb for scheduling/capacity:

- A stream **with** an adapter is billed at the same livepeer perceive rate as a
  base stream (no extra per-frame fee) but consumes **extra VRAM** for the
  additional resident model.
- Capacity is bounded by the box's VRAM / number of concurrently attached
  adapters. `PERCEIVE_CAPACITY` already bounds per-session concurrency; the
  detector cache adds `1 + |attached adapter refs|` resident models.
- The `_gate_frame` 1-fps boot gate and `capability()` are unchanged — a box
  only registers when its device sustains the rate on the base model.

Concrete livepeer billing (from the CEO cost-gate card, grounded on
go-livepeer visibility): the perceive runner is ~$0.01/hr persistent (RTX 3090
Ti-tier), decide ~$0.01 fixed, train ~$0.01 fixed. **Per-stream adapter variants
do not add a new per-frame fee**; they add resident-GPU occupancy, so the
marginal cost is the additional VRAM headroom, not a new unit. That occupancy is
what the box/runtime leg must budget (Infra Monitor owns it). Any paid-scale
arm that provisions additional adapter variants should re-confirm Livepeer
capacity with billing visibility before enablement.

## Deployment / box leg (Infra Monitor)

- The server passes `loraRef` as a **filesystem ref available to the perceive
  container**. Getting the pre-merged model dir onto the GPU box (network
  mount / staging from the train artifact store) is the Infra Monitor box/runtime
  leg, mirroring the Increment B artifact staging pattern (`docs/fine-tune-artifact-delivery.md`).

## What this build leg delivered vs. remains

Delivered (verifiable):

- Perceive runtime per-stream selection (`florence.py` `get_detector(lora_ref)`),
  session carry (`session.py`, `__init__.py` analyze + control), with tests.
- Server + adapter plumbing so a job's `AnalyzerConfig.loraRef` flows to
  perceive on every `/analyze` through both adapters (Orchestrator + Direct).
- GPU cost model documented above.

Remains (separate consumer surfaces, not runtime-serving work):

- UI + DB/API surface for a user to **attach a LoRA to a stream/project** and
  populate `AnalyzerConfig.loraRef` (the field is plumbed; the selector that
  sets it is a small additive surface).
- Infra Monitor box/runtime leg: staging merged model dirs onto the GPU box and
  re-confirming Livepeer capacity/billing before any paid-scale arm.
