"""In-memory telemetry container shared by every stage."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

FEATURES = ["cpu", "memory", "net_rx", "net_tx", "log_errors", "latency_p95", "trace_errors", "span_rate", "self_latency", "container_up"]


@dataclass
class Telemetry:
    times: np.ndarray                 # (T,) unix seconds, one per window
    services: list[str]               # (S,)
    X: np.ndarray                     # (T, S, F) float, NaN where a signal is unavailable
    features: list[str] = field(default_factory=lambda: list(FEATURES))
    # Caller -> callee pairs observed in traces.
    edges: list[tuple[str, str]] = field(default_factory=list)

    def __post_init__(self):
        assert self.X.shape == (len(self.times), len(self.services), len(self.features))

    def slice(self, start: int, stop: int) -> "Telemetry":
        return Telemetry(self.times[start:stop], self.services, self.X[start:stop],
                         self.features, self.edges)

    def index(self, service: str) -> int:
        return self.services.index(service)
