"""Feature specification: which direction means trouble, which scale, and whether the evidence is the service's OWN or an
inheritable SYMPTOM. This table drives scoring (core/algo.py) and attribution.

Verbatim from the research notebook (colab/rca_research_src.py, section 2). If the method changes, change it in both.
"""
# feature: (direction that means trouble, scale, evidence group)
# "own" = evidence about the service ITSELF (its CPU, memory, its own processing time, whether it is running)
# "sym" = symptoms that can be INHERITED from a broken dependency (errors, end-to-end latency, traffic, log errors)
SPEC = {   # feature: (direction that means trouble, scale, evidence group)
    "cpu_percent": (+1, "log", "own"), "memory_usage_mb": (+1, "log", "own"), "pids": (+1, "log", "sym"),  # threads pile up in a service WAITING on a slow callee: inheritable
    "block_read_bytes": (+1, "log", "own"), "block_write_bytes": (+1, "log", "own"),
    "network_rx_bytes": (+1, "log", "sym"), "network_tx_bytes": (+1, "log", "sym"),
    "log_count": (+1, "log", "sym"), "error_count": (+1, "log", "sym"), "warning_count": (+1, "log", "sym"),
    "latency_p95": (+1, "log", "sym"), "trace_errors": (+1, "lin", "sym"), "span_rate": (-1, "log", "sym"),
    "self_latency": (+1, "log", "own"), "container_up": (-1, "lin", "own"),
    "silence": (+1, "lin", "own"),
    "activity": (-1, "log", "aux"),  # network in+out rate (SSH data): only an input to "alive?" in silence (its kB-quantised
                                     # counters make it too noisy to score on its own)   # computed in score(): a normally chatty service that went quiet
}
# "own"  = evidence about the service ITSELF (its CPU, memory, its own processing time, whether it is running)
# "sym"  = symptoms that can be INHERITED from a broken dependency (errors, end-to-end latency, traffic, log errors)
CUMULATIVE = {"network_rx_bytes", "network_tx_bytes", "block_read_bytes", "block_write_bytes"}
FLOOR = {"log": 0.15, "lin": 0.05}
# the smallest change worth noticing, per feature: log(x + UNIT) instead of log(1 + x), so a series that is usually 0 cannot
# score z = 46 for one quantised kB tick (docker stats prints network bytes in kB steps)
UNIT = {"network_rx_bytes": 2000.0, "network_tx_bytes": 2000.0, "activity": 2000.0, "block_read_bytes": 4096.0,
        "block_write_bytes": 4096.0, "cpu_percent": 0.5, "memory_usage_mb": 1.0}    # smallest allowed spread: a 15% change (log scale) or 0.05 absolute (0..1 quantities)
