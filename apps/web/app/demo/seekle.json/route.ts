import { readSeekle } from "@/components/demo/seekle";

// Read once at build: the product demo fetches it when it mounts.
export const dynamic = "force-static";

export function GET() {
  return Response.json(readSeekle());
}
