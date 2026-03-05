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
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const client = createClient({
    baseUrl: Deno.env.get("INSFORGE_BASE_URL")!,
    anonKey: Deno.env.get("ANON_KEY")!,
  });

  let body: { prompt?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const prompt = body.prompt || "Suggest 3 productive tasks for today";
  const systemPrompt = "You are a helpful todo assistant. Return a JSON array of 3-5 suggested todo titles. Example: [\"Task 1\", \"Task 2\"]";

  const completion = await client.ai.chat.completions.create({
    model: "openai/gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    temperature: 0.7,
  });

  const content = completion.choices[0]?.message?.content?.trim() ?? "[]";
  let suggestions: string[] = [];
  try {
    const parsed = JSON.parse(content);
    suggestions = Array.isArray(parsed)
      ? parsed.filter((s: unknown) => typeof s === "string").slice(0, 5)
      : [];
  } catch {
    suggestions = content.split("\n").filter((s: string) => s.trim().length > 0).slice(0, 5);
  }

  return new Response(
    JSON.stringify({ suggestions }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
