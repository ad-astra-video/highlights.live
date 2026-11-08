"""ADAAAA-8373: admission control for the INLINE-on-miss ASR lane.

The ADAAAA-8363 grade of the ADAAAA-8351 leg measured the lane that inline-on-miss
decide calls share: leg-window peak concurrency **4**, 24 h peak **5**, 133 moments
>= 2 on n 888 calls, and inline p50/p95/max **717 / 6 272 / 6 579 ms**. The p95
sits *on* the 6 000 ms wait budget, so queue time is what turns a call into a
wait-miss — and the miss then spends the whole budget before deciding.

`ASR_MAX_CONCURRENT` and `ASR_QUEUE_MS` bound that lane:

* ``ASR_MAX_CONCURRENT`` (integer, default ``0`` = UNBOUNDED, shipped
  behaviour) caps how many inline ASR calls may run at once. ``0`` constructs
  NO bound at all, so the shipped path is byte-for-byte unchanged.
* ``ASR_QUEUE_MS`` (integer, default ``0`` = wait as today) caps how long an
  inline call may wait for a slot. A call that cannot get one in time misses
  FAST instead of stalling: it decides on text-only evidence, and the window
  says WHY (``asrSource: "queue_miss"`` / ``noAudioReason: "asr_queue_miss"``),
  so a queue bound can never be read back as ASR absence.

**A cap with NO deadline is a new stall mode** (ADAAAA-8384, C3): ``ASR_MAX_CONCURRENT=2``
with ``ASR_QUEUE_MS`` unset used to acquire with no timeout, which serialises the
inline lane behind one stuck ASR call (bounded only by ASR's own 20 s HTTP
timeout). Shipped behaviour has no cap and therefore never queues, so that state
is new. When a cap is set and the queue knob is unset/0 the gate applies
``DEFAULT_BOUNDED_QUEUE_MS`` (the 6 000 ms wait budget the ADAAAA-8363 grade
measured against) as the deadline and logs a WARNING at construction. Set the two
knobs together.

**Scope: the decide process's inline call sites only** (ADAAAA-8384, C2). The
bound is per PROCESS, and covers the calls that go through ``transcribe_inline``
(the live window's inline-on-miss path plus the VOD/group decide paths in
``gemma.py``). Two other callers hit the same ASR endpoint UNGATED:

* ``app/confirm.py`` — the Stage-2 ``/confirm`` dive, same process (and the live
  rail runs confirm dives by default);
* ``services/server/src/asr-prefetch.ts`` — the server-side prefetch lane, a
  different process.

So ``ASR_MAX_CONCURRENT=2`` means "at most 2 inline ASR calls inside the decide
process", NOT "ASR endpoint concurrency <= 2". Routing ``confirm.py`` through
``transcribe_inline`` is a separate, measured decision (it would also bound VOD's
confirmation ASR and change VOD confirm timing), so this knob does not claim it.

The persisted metric is live-only (counted server-side from the decide
response), so a deploy decision must read it on a window with no concurrent VOD
pass.

Deliberately thread-safe and dependency-free: ``transcribe_audio`` is called from
worker threads (``asyncio.to_thread`` on the decide path), so the gate cannot be
an asyncio primitive.
"""

from __future__ import annotations

import logging
import os
import threading

log = logging.getLogger("highlights.decide.asr_admission")

# Shipped behaviour: no bound, wait as today.
DEFAULT_MAX_CONCURRENT = 0
DEFAULT_QUEUE_MS = 0
# ADAAAA-8384 (C3): the deadline a BOUND gets when ASR_QUEUE_MS is unset. This is
# the 6 000 ms wait budget the ADAAAA-8363 grade measured the inline p95 against,
# so a capped lane can never queue past the budget the lane exists to protect.
DEFAULT_BOUNDED_QUEUE_MS = 6000

ENV_MAX_CONCURRENT = "ASR_MAX_CONCURRENT"
ENV_QUEUE_MS = "ASR_QUEUE_MS"


def _env_int(name: str, default: int) -> int:
    """Non-negative integer env knob.

    Unset / empty / unparseable => ``default`` (never a crash and never an
    accidental bound: a typo must fall back to the shipped posture, exactly like
    ``asr_task()``). Negative values clamp to 0 (= unbounded / wait-forever).
    """
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        return default
    return max(0, value)


class AsrAdmission:
    """A bounded-concurrency gate with a queue deadline.

    ``acquire()`` returns True when a slot was obtained (and the caller MUST
    ``release()`` it in a ``finally``) and False when the queue deadline expired.
    ``max_concurrent <= 0`` means UNBOUNDED: no semaphore is constructed, every
    acquire succeeds immediately and release is a no-op.

    A bounded gate always has a deadline: `max_concurrent > 0` with
    `queue_ms <= 0` resolves to ``DEFAULT_BOUNDED_QUEUE_MS`` and warns
    (ADAAAA-8384, C3 — a cap with no deadline serialises the lane behind one
    stuck call, a stall mode the shipped posture does not have).
    """

    def __init__(self, max_concurrent: int = DEFAULT_MAX_CONCURRENT, queue_ms: int = DEFAULT_QUEUE_MS):
        self.max_concurrent = max(0, int(max_concurrent))
        configured_queue_ms = max(0, int(queue_ms))
        # ADAAAA-8384 (C3): a CAP with no deadline is a stall mode that does not
        # exist in the shipped posture (no cap => never queues). Apply the 6 000 ms
        # wait budget instead of an unbounded acquire, so a stuck ASR call can
        # never serialise the whole inline lane behind it.
        self.queue_defaulted = self.max_concurrent > 0 and configured_queue_ms == 0
        self.queue_ms = DEFAULT_BOUNDED_QUEUE_MS if self.queue_defaulted else configured_queue_ms
        self._sem = threading.BoundedSemaphore(self.max_concurrent) if self.max_concurrent > 0 else None
        # Reported by `describe()` in the boot posture line.
        self.admitted = 0
        self.queue_misses = 0
        if self.queue_defaulted:
            log.warning(
                "ASR_MAX_CONCURRENT=%d is set but ASR_QUEUE_MS is not: applying the %d ms wait"
                " budget as the queue deadline, because a cap with NO deadline serialises the"
                " inline lane behind one stuck ASR call. Set both knobs together.",
                self.max_concurrent,
                self.queue_ms,
            )

    @property
    def bounded(self) -> bool:
        """True when this gate actually enforces a concurrency cap."""
        return self._sem is not None

    @property
    def queue_wait_s(self) -> float:
        """The EFFECTIVE queue deadline in seconds (0 = wait indefinitely).

        A bounded gate always has one: `ASR_MAX_CONCURRENT` set with
        `ASR_QUEUE_MS` unset resolves to ``DEFAULT_BOUNDED_QUEUE_MS``
        (ADAAAA-8384, C3), so `0` here means unbounded only.
        """
        return self.queue_ms / 1000.0

    def acquire(self) -> bool:
        """Take a slot, or give up after ``queue_ms``.

        Never raises: a gate error must degrade to "no slot" (a named queue
        miss), never to a failed decide.
        """
        if self._sem is None:
            self.admitted += 1
            return True
        try:
            if self.queue_ms > 0:
                got = self._sem.acquire(timeout=self.queue_wait_s)
            else:
                self._sem.acquire()  # today's queueing: wait for the slot
                got = True
        except Exception:  # pragma: no cover - defensive
            got = False
        if got:
            self.admitted += 1
        else:
            self.queue_misses += 1
        return got

    def release(self) -> None:
        if self._sem is not None:
            self._sem.release()

    def describe(self) -> dict:
        """The EFFECTIVE posture, for the boot posture line (ADAAAA-8384, C4)."""
        return {
            "maxConcurrent": self.max_concurrent,
            "queueMs": self.queue_ms,
            "queueDefaulted": self.queue_defaulted,
            "bounded": self.bounded,
            "admitted": self.admitted,
            "queueMisses": self.queue_misses,
        }


# One gate per effective (maxConcurrent, queueMs) pair. A module-level singleton
# would be simpler, but the knobs are read from the environment and the tests
# flip them per case; keying on the pair keeps the gate a real lane (shared by
# every call) while letting a changed env rebuild it. Production never changes
# the pair at runtime, so the rebuild path only exists for tests/reloads.
_gate_lock = threading.Lock()
_gate_key: tuple[int, int] | None = None
_gate: AsrAdmission | None = None


def gate_for(max_concurrent: int, queue_ms: int) -> AsrAdmission:
    """The shared gate for an explicit posture (testable, env-free)."""
    global _gate_key, _gate
    key = (max(0, int(max_concurrent)), max(0, int(queue_ms)))
    with _gate_lock:
        if _gate_key != key or _gate is None:
            _gate = AsrAdmission(*key)
            _gate_key = key
            # ADAAAA-8384 (C4): the posture line an operator reads off the decide
            # container log to confirm the bound is LIVE — the per-miss INFO at
            # `gemma.py:transcribe_inline` only fires once a call has already
            # missed. One line per construction, built from `describe()` so the
            # log cannot drift from the gate's state. ADAAAA-8393 (nit): this is
            # NOT a boot line — `inline_asr_gate()` has no startup caller, so the
            # first inline call under `LIVE_DECIDE_ASR_PREFETCH=1` (itself the
            # default) is what constructs the gate and prints it.
            log.info("asr inline admission gate built: %s", _gate.describe())
        return _gate


def inline_asr_gate() -> AsrAdmission:
    """The process-wide INLINE ASR gate, resolved from the environment."""
    return gate_for(
        _env_int(ENV_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT),
        _env_int(ENV_QUEUE_MS, DEFAULT_QUEUE_MS),
    )
