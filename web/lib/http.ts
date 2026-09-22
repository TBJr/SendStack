import { NextResponse } from "next/server";

export function json<T>(status: number, payload: T, headers?: HeadersInit): NextResponse<T> {
  return NextResponse.json(payload, { status, headers });
}
