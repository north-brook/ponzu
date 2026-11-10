// The connection string of a Neon branch, asked of the Neon API by the branch's name.
//
//   bun scripts/neon.ts dev            the pooled URL, which is what DATABASE_URL takes
//   bun scripts/neon.ts dev --direct   the direct URL, which is what `db:migrate` takes
//
// Needs NEON_API_KEY and NEON_PROJECT_ID. It prints a credential: pipe it, don't paste it.

const API = "https://console.neon.tech/api/v2";

interface Branch {
  id: string;
  name: string;
  default: boolean;
}

/**
 * It refuses the project's default branch whatever that is called: until cutover that branch
 * is nobody's to develop against, and after it, it is production.
 */
export async function branchDatabaseUrl(
  name: string,
  { apiKey, projectId, direct = false }: { apiKey: string; projectId: string; direct?: boolean },
): Promise<string> {
  const get = async (path: string) => {
    const response = await fetch(`${API}/projects/${projectId}${path}`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Neon answered ${response.status} for ${path.split("?")[0]}`);
    return (await response.json()) as any;
  };

  const { branches } = (await get("/branches")) as { branches: Branch[] };
  const branch = branches.find((candidate) => candidate.name === name);
  if (!branch) throw new Error(`The Neon project has no branch named "${name}".`);
  if (branch.default) throw new Error(`"${name}" is the project's default branch. Not that one.`);

  const { databases } = await get(`/branches/${branch.id}/databases`);
  const database = databases[0];
  if (!database) throw new Error(`The Neon branch "${name}" has no database.`);
  const query = new URLSearchParams({
    branch_id: branch.id,
    database_name: database.name,
    role_name: database.owner_name,
    pooled: "true",
  });
  const { uri } = (await get(`/connection_uri?${query}`)) as { uri: string };
  // Neon hands back the pooler's host either way; the direct host is the same without the suffix.
  return direct ? uri.replace("-pooler.", ".") : uri;
}

if (import.meta.main) {
  const [name, flag] = process.argv.slice(2);
  const { NEON_API_KEY: apiKey, NEON_PROJECT_ID: projectId } = process.env;
  if (!name || !apiKey || !projectId) {
    console.error(
      "usage: NEON_API_KEY=… NEON_PROJECT_ID=… bun scripts/neon.ts <branch> [--direct]",
    );
    process.exit(2);
  }
  console.log(await branchDatabaseUrl(name, { apiKey, projectId, direct: flag === "--direct" }));
}
