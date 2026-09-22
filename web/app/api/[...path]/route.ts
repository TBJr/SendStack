import { handleApi } from "@/lib/api-router";

type Params = { params: Promise<{ path: string[] }> };

async function dispatch(request: Request, context: Params) {
  const { path } = await context.params;
  return handleApi(request, path ?? []);
}

export const GET = dispatch;
export const POST = dispatch;
export const PATCH = dispatch;
export const PUT = dispatch;
export const DELETE = dispatch;
