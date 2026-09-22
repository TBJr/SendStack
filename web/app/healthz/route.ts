import { config } from "@/lib/config";
import { json } from "@/lib/http";

export async function GET() {
  return json(200, { status: "ok", mode: config.deliveryMode, runtime: "vercel" });
}
