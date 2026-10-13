/**
 * Derives a stable, human-meaningful service name from container naming
 * conventions, so `serviceId` never depends on random process state
 * (spec section 7).
 *
 * Preference order:
 *   1. docker-compose "com.docker.compose.service" label (most reliable)
 *   2. strip a compose-style prefix/replica suffix from the container name
 *      e.g. "sockshop_orders_1" -> "orders", "sockshop-orders-1" -> "orders"
 *   3. fall back to the raw container name
 */
export function deriveServiceName(
  containerName: string,
  labels: Record<string, string>,
): string {
  const composeService = labels["com.docker.compose.service"];
  if (composeService) return composeService;

  const withoutReplicaSuffix = containerName.replace(/[-_]\d+$/, "");
  const composeProject = labels["com.docker.compose.project"];
  if (composeProject && withoutReplicaSuffix.startsWith(`${composeProject}_`)) {
    return withoutReplicaSuffix.slice(composeProject.length + 1);
  }
  if (composeProject && withoutReplicaSuffix.startsWith(`${composeProject}-`)) {
    return withoutReplicaSuffix.slice(composeProject.length + 1);
  }

  return withoutReplicaSuffix || containerName;
}

export function buildServiceId(targetId: string, serviceName: string): string {
  const normalized = serviceName.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `${targetId}:${normalized}`;
}
