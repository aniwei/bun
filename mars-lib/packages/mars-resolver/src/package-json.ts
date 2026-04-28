interface PackageJsonTargetObject {
  [key: string]: PackageJsonTarget | undefined
}
type PackageJsonTarget = string | null | PackageJsonTarget[] | PackageJsonTargetObject

export interface PackageJsonShape {
  name?: string
  type?: "module" | "commonjs"
  main?: string
  module?: string
  browser?: string | Record<string, string | false>
  exports?: PackageJsonTarget
  imports?: Record<string, PackageJsonTarget>
}

export function parsePackageJson(content: string | null): PackageJsonShape | null {
  if (!content) return null

  try {
    const jsonValue = JSON.parse(content) as PackageJsonShape
    return jsonValue
  } catch {
    return null
  }
}

export function hasPackageJsonExports(packageJson: PackageJsonShape | null): boolean {
  return packageJson?.exports !== undefined
}

export function pickPackageEntry(
  packageJson: PackageJsonShape | null,
  conditions: string[] = [],
): string | null {
  if (!packageJson) return null
  if (conditions.includes("browser") && typeof packageJson.browser === "string") {
    return packageJson.browser
  }

  if (typeof packageJson.module === "string") return packageJson.module
  if (typeof packageJson.main === "string") return packageJson.main

  return null
}

export function pickBrowserMapTarget(
  packageJson: PackageJsonShape | null,
  subpath: string,
): string | false | null {
  if (!packageJson || typeof packageJson.browser !== "object") return null

  for (const candidate of browserMapCandidates(subpath)) {
    if (Object.prototype.hasOwnProperty.call(packageJson.browser, candidate)) {
      return packageJson.browser[candidate] ?? null
    }
  }

  return null
}

function browserMapCandidates(subpath: string): string[] {
  const normalizedSubpath = subpath === "."
    ? "./index"
    : subpath.startsWith("./")
      ? subpath
      : `./${subpath}`
  const candidates = [normalizedSubpath]

  for (const extension of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"]) {
    if (normalizedSubpath.endsWith(extension)) continue
    candidates.push(`${normalizedSubpath}${extension}`)
  }

  return [...new Set(candidates)]
}
