import { createClient } from "npm:@insforge/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  const client = createClient({
    baseUrl: Deno.env.get("INSFORGE_BASE_URL")!,
    anonKey: Deno.env.get("ANON_KEY")!,
  });
  const completion = await client.ai.chat.completions.create({
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: "Say hello in one word" }],
  });
  const word = completion.choices[0]?.message?.content ?? "hi";
  return new Response(
    JSON.stringify({ word }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
