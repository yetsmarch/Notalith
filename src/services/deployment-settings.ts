import type { DeploymentSettings } from "../types";

function deploymentId(name: string): string {
  const slug = name
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "deployment";
}

export function normalizeDeployments(
  deployments: unknown,
  legacyNames: unknown,
  currentDeployment: string,
): DeploymentSettings[] {
  const result: DeploymentSettings[] = [];
  const usedIds = new Set<string>();
  const usedNames = new Set<string>();

  if (Array.isArray(deployments)) {
    for (const value of deployments) {
      if (!value || typeof value !== "object") continue;
      const candidate = value as Partial<DeploymentSettings>;
      const name =
        typeof candidate.deploymentName === "string"
          ? candidate.deploymentName.trim()
          : "";
      if (!name || usedNames.has(name)) continue;
      const baseId =
        typeof candidate.id === "string" && candidate.id.trim()
          ? candidate.id.trim()
          : deploymentId(name);
      let id = baseId;
      let suffix = 2;
      while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
      result.push({
        id,
        displayName:
          typeof candidate.displayName === "string" &&
          candidate.displayName.trim()
            ? candidate.displayName.trim()
            : name,
        deploymentName: name,
      });
      usedIds.add(id);
      usedNames.add(name);
    }
  }

  const names = Array.isArray(legacyNames) ? legacyNames : [];
  const normalizedNames = names
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim())
    .filter(Boolean);
  const current = currentDeployment.trim();
  if (current) normalizedNames.unshift(current);

  for (const name of normalizedNames) {
    if (usedNames.has(name)) continue;
    const baseId = deploymentId(name);
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
    result.push({ id, displayName: name, deploymentName: name });
    usedIds.add(id);
    usedNames.add(name);
  }
  return result;
}
