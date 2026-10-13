import { load as parseYaml } from "js-yaml";

/**
 * Parses a docker-compose file's `depends_on` relationships into
 * service-name pairs. This is the ONLY source Phase 2 treats as
 * `declared: true` — shared network membership alone is not a
 * declaration, just a candidate (spec section 9, 61).
 *
 * Returns an empty array (never throws) if the file can't be parsed —
 * a missing/unreadable compose file must not stop discovery of
 * everything else (spec section 48).
 */
export interface ComposeDependency {
  sourceServiceName: string;
  targetServiceName: string;
}

export function parseComposeDependsOn(composeFileContent: string): ComposeDependency[] {
  try {
    const doc = parseYaml(composeFileContent) as { services?: Record<string, unknown> };
    const services = doc?.services;
    if (!services || typeof services !== "object") return [];

    const result: ComposeDependency[] = [];
    for (const [serviceName, def] of Object.entries(services)) {
      const dependsOn = (def as Record<string, unknown> | undefined)?.depends_on;
      if (!dependsOn) continue;

      let targets: string[] = [];
      if (Array.isArray(dependsOn)) {
        targets = dependsOn as string[];
      } else if (typeof dependsOn === "object") {
        // long-form: depends_on: { orders-db: { condition: service_healthy } }
        targets = Object.keys(dependsOn as Record<string, unknown>);
      }

      for (const target of targets) {
        result.push({ sourceServiceName: serviceName, targetServiceName: target });
      }
    }
    return result;
  } catch {
    return [];
  }
}
